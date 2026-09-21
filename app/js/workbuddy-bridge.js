// workbuddy-bridge.js
// 通过本机 WorkBuddy 暴露的 ACP(Agent Client Protocol) 本地服务实现"桥接 WorkBuddy 自身"。
// 已对 http://127.0.0.1:9418 实测验证：
//   POST /api/v1/acp/connect            -> {connectionId, sessionToken}（无需鉴权）
//   POST /api/v1/acp  (JSON-RPC)        -> 响应体本身是 SSE 流（event: message / data: {...}）
//   方法：initialize -> session/new -> session/prompt
//   助手回复以 session/update 通知形式在流中返回。
//
// 连接方式有两条，默认走"同源代理"：
//   A) 同源代理（默认，base = ''）：请求打到页面自身的源（http://127.0.0.1:18765/api/v1/acp*），
//      由 Electron 主进程转发到 9418。跨域问题不存在，真实失败原因也能拿到中文说明。
//   B) 直连（base = 'http://127.0.0.1:9418'）：仅在上游已配置 CORS 时才可用，
//      否则 Chromium 只会抛一个含糊的 "TypeError: Failed to fetch"。
(function () {
  'use strict';

  class WorkBuddyBridge {
    constructor(baseUrl, options) {
      // '' / undefined / null 都表示"同源代理"
      this.base = (baseUrl === undefined || baseUrl === null) ? '' : String(baseUrl).replace(/\/+$/, '');
      this.connectionId = null;
      this.sessionToken = null;
      this.sessionId = null;
      this._id = 0;
      // session/new 的工作目录（agent 以此为工作路径）
      this.cwd = (options && options.cwd) || '.';
    }

    // 是否走主进程代理（代理模式下才有 /api/v1/acp/health 这个探活端点）
    get proxied() { return this.base === ''; }

    _headers() {
      const h = {
        'x-codebuddy-request': '1',
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      };
      if (this.connectionId) h['acp-connection-id'] = this.connectionId;
      if (this.sessionToken) h['acp-session-token'] = this.sessionToken;
      return h;
    }

    // 统一的 fetch 包装：把"网络层不可达"和"HTTP 错误"都翻成一句能看懂的话。
    // 原实现直接 await fetch(...) 后判断 resp.ok，网络层失败时异常里只有一个
    // "Failed to fetch"，界面上完全看不出是端口没开还是被拒。
    async _fetch(url, init) {
      let resp = null;
      try {
        resp = await fetch(url, init);
      } catch (e) {
        // 网络层失败时 Chromium 只给一句 "Failed to fetch"，对用户毫无信息量，
        // 这里换成人话（真正的原因由主进程代理的 502 JSON 给出）。
        const raw = (e && e.message) ? e.message : String(e);
        const friendly = /failed to fetch|networkerror|load failed/i.test(raw)
          ? '请求未能送达（服务未响应）'
          : raw;
        throw new Error('无法连接 WorkBuddy 本地服务：' + friendly);
      }
      if (!resp.ok) {
        let detail = '';
        try {
          const text = await resp.text();
          try {
            const j = JSON.parse(text);
            detail = j.error || j.message || '';
          } catch (e2) { detail = text; }
        } catch (e2) { /* 忽略 */ }
        throw new Error(detail || ('HTTP ' + resp.status));
      }
      return resp;
    }

    // 探活：确认 ACP 端口是否真的在监听（仅代理模式可用）
    async health() {
      if (!this.proxied) return { ok: true, message: '' };
      const r = await this._fetch(this.base + '/api/v1/acp/health', {
        headers: { 'x-codebuddy-request': '1' }
      });
      try { return await r.json(); } catch (e) { return { ok: false, message: '探活响应无法解析' }; }
    }

    // 建立连接 + 初始化（全过程只需一次）
    async connect() {
      if (this.connectionId && this.sessionToken) return { connectionId: this.connectionId };
      const c = await this._fetch(this.base + '/api/v1/acp/connect', {
        method: 'POST',
        headers: { 'x-codebuddy-request': '1', 'Content-Type': 'application/json' },
        body: '{}'
      });
      const grant = await c.json();
      this.connectionId = grant.connectionId;
      this.sessionToken = grant.sessionToken;
      // initialize（结果可忽略，但按协议必须发）
      await this._postAcp('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'live2d-companion', version: '0.1.0' },
        clientCapabilities: { _meta: {} }
      });
      return grant;
    }

    // 新建一个对话 session，返回 sessionId
    //
    // 参数形状是实测出来的，两个都不能少：
    //   mcpServers 必须是**数组**。漏了它上游直接回 -32602 Invalid params
    //   （data._errors.mcpServers: "Invalid input: expected array, received undefined"），
    //   表现为"session/new 未返回 sessionId"。之前只发 {cwd} 就是栽在这里。
    async newSession() {
      let sid = null;
      await this._postAcp('session/new', { cwd: this.cwd, mcpServers: [] }, (ev) => {
        const j = ev.json;
        if (!j) return;
        // sessionId 有两个来源：result（权威）与 session/update 通知（早于 result 到达）
        const r = j.result;
        if (r && r.sessionId && !sid) sid = r.sessionId;
        const p = j.params;
        if (p && p.sessionId && !sid) sid = p.sessionId;
        // 上游也可能用 error 回包（参数不合规等），把它显式抛出来，别只说"未返回"
        if (j.error && !sid) {
          throw new Error('session/new 被拒绝：' +
            (j.error.message || JSON.stringify(j.error)) +
            (j.error.data ? ' ' + JSON.stringify(j.error.data).slice(0, 200) : ''));
        }
      });
      if (!sid) throw new Error('session/new 未返回 sessionId');
      this.sessionId = sid;
      return sid;
    }

    // 发送一条用户消息，流式回调助手回复
    // handlers: { onText(text), onUpdate(update), onReplay(active), onDone(), onError(err) }
    //
    // 关于"历史回放"（实测踩坑）：
    //   WorkBuddy 的 session/new 会附着到**当前会话**，所以 session/prompt 的流里
    //   会先把整段会话历史推一遍——一次实测是 29 万字符、1400+ 个事件，首尾各有
    //   一个 session_info_update 标记：
    //     update._meta['codebuddy.ai/historyReplay'] === 'start' / 'end'
    //   不识别它，聊天气泡会被整段历史灌爆（而且看起来像模型疯了）。
    //   这里按标记把回放段整段丢掉，只渲染本轮新产生的内容。
    async sendPrompt(text, handlers) {
      const h = handlers || {};
      if (!this.sessionId) await this.newSession();
      // prompt 必须是**内容块数组**，不是字符串（实测：空数组会被接受，
      // 说明类型校验要的是数组；传字符串会直接 -32602）。
      const blocks = [{ type: 'text', text: String(text) }];
      let replaying = false;
      try {
        await this._postAcp('session/prompt', { sessionId: this.sessionId, prompt: blocks }, (ev) => {
          const j = ev.json;
          if (!j || j.method !== 'session/update') return;
          const params = j.params;
          const upd = params && params.update;
          if (!upd) return;

          const mark = upd._meta && upd._meta['codebuddy.ai/historyReplay'];
          if (mark === 'start') {
            replaying = true;
            if (h.onReplay) h.onReplay(true);
            return;
          }
          if (mark === 'end') {
            replaying = false;
            if (h.onReplay) h.onReplay(false);
            return;
          }

          if (h.onUpdate) h.onUpdate(upd);
          if (replaying) return;   // 回放段一律不渲染（没有标记的会话天然是 false，照常渲染）
          const t = this._extractText(upd);
          if (t && h.onText) h.onText(t);
        });
        if (h.onDone) h.onDone();
      } catch (e) {
        if (h.onError) h.onError(e);
        else throw e;
      }
    }

    async disconnect() {
      if (!this.connectionId) return;
      try {
        await fetch(this.base + '/api/v1/acp', { method: 'DELETE', headers: this._headers() });
      } catch (e) { /* ignore */ }
      this.connectionId = null;
      this.sessionToken = null;
      this.sessionId = null;
    }

    // ---- 内部 ----

    // POST /api/v1/acp，响应为 SSE 流，逐事件回调
    async _postAcp(method, params, onEvent) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: ++this._id, method, params });
      const resp = await this._fetch(this.base + '/api/v1/acp', {
        method: 'POST',
        headers: this._headers(),
        body
      });
      if (!resp.body || typeof resp.body.getReader !== 'function') {
        // 某些环境下拿不到流（例如响应被完整缓冲）。退化为一次性解析，至少不会静默卡死。
        const text = await resp.text();
        const ev = this._parseSseBlock(text);
        if (ev && onEvent) onEvent(ev);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = this._parseSseBlock(block);
          if (ev && onEvent) onEvent(ev);
        }
      }
      if (buf.trim()) {
        const ev = this._parseSseBlock(buf);
        if (ev && onEvent) onEvent(ev);
      }
    }

    _parseSseBlock(block) {
      let event = 'message';
      const dataLines = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) return null;
      try {
        return { event, json: JSON.parse(dataLines.join('\n')) };
      } catch (e) {
        return null;
      }
    }

    // 从 session/update 里取出"助手说的话"。
    //
    // 旧实现是无差别递归捞所有 text 字段，结果工具调用的参数、思考片段、
    // 甚至用户自己那句话的回显都会被当成助手回复打进聊天气泡里。
    // ACP 的 update 带 sessionUpdate 字段标明种类，按它分派即可：
    //   agent_message_chunk  助手正文（要）
    //   agent_thought_chunk  思考过程（不当作回复正文）
    //   user_message_chunk   用户自己的回显（丢）
    //   tool_call / tool_call_update / plan ...  工具与计划（丢）
    // 没有 sessionUpdate 字段时按老办法兜底，避免旧版本上游拿不到内容。
    _extractText(upd) {
      if (!upd || typeof upd !== 'object') return '';
      const kind = upd.sessionUpdate || upd.type || '';
      if (kind) {
        if (kind === 'agent_message_chunk' || kind === 'agent_message') {
          return this._collectContentText(upd.content !== undefined ? upd.content : upd);
        }
        return '';
      }
      return this._collectContentText(upd);
    }

    // 收集内容块里的纯文本（content 可能是块对象、块数组或纯字符串）
    _collectContentText(c) {
      if (c === null || c === undefined) return '';
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((x) => this._collectContentText(x)).join('');
      if (typeof c === 'object') {
        if (typeof c.text === 'string') return c.text;
        // 有些结构把内容放在 content / contents / parts 下
        for (const k of ['content', 'contents', 'parts', 'items']) {
          if (c[k] !== undefined) return this._collectContentText(c[k]);
        }
      }
      return '';
    }
  }

  window.WorkBuddyBridge = WorkBuddyBridge;
})();
