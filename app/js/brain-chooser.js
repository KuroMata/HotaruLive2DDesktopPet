// brain-chooser.js —— 启动时的"选哪个大脑"窗口
//
// 职责：选大脑（本地 / 云端 / WorkBuddy）+ 填云端接口 + 定制人设 + 记住选择。
// 三个约定：
//   1. 点「确定」才落盘；直接关窗口等于"沿用上次的大脑"。
//   2. 「下次不再询问」只影响下次是否弹窗，不影响记住选了哪个大脑——
//      未勾选时下次仍会弹，但默认选中项就是这次选的。
//   3. 选本地会顺手探一下 Ollama 在不在、模型下没下好，不然后面才发现就晚了。
(function () {
  'use strict';

  const PRESETS = [
    { id: 'deepseek', label: 'DeepSeek（深度求索）', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'qwen', label: '通义千问（阿里云）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'kimi', label: 'Kimi（月之暗面）', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { id: 'glm', label: 'GLM（智谱清言）', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'custom', label: '自定义 / 其它兼容接口', base: '', model: '' }
  ];

  const KIND_TEXT = {
    local: { label: '本地模型', desc: 'Ollama 跑在你自己的显卡上 · 断网可用 · 聊天内容不出本机' },
    cloud: { label: '云端接口', desc: '填一个 API Key 就能用 · 更聪明 · 需要联网' },
    workbuddy: { label: 'WorkBuddy', desc: '接回 WorkBuddy 的会话 · 能调用工具、读写本地文件' }
  };

  let cfg = {};
  let persona = null;
  let picked = 'cloud';

  const $ = (id) => document.getElementById(id);

  function lines(arr) { return (arr || []).filter(Boolean).join('\n'); }
  function unlines(s) {
    return String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  }

  // ---------------------------------------------------------------- 卡片
  function renderCards() {
    const box = $('cards');
    box.innerHTML = '';
    ['local', 'cloud', 'workbuddy'].forEach((kind) => {
      const info = KIND_TEXT[kind];
      const el = document.createElement('label');
      el.className = 'card' + (picked === kind ? ' on' : '');
      el.innerHTML =
        '<input type="radio" name="brain" value="' + kind + '"' + (picked === kind ? ' checked' : '') + '>' +
        '<div><div class="t">' + info.label + '</div><div class="d">' + info.desc + '</div>' +
        '<div class="probe" data-probe="' + kind + '"></div></div>';
      el.querySelector('input').addEventListener('change', () => pick(kind));
      box.appendChild(el);
    });
  }

  function setProbe(kind, cls, text) {
    const el = document.querySelector('[data-probe="' + kind + '"]');
    if (!el) return;
    el.className = 'probe ' + (cls || '');
    el.textContent = text || '';
  }

  async function pick(kind) {
    picked = kind;
    document.querySelectorAll('.card').forEach((c) => {
      c.classList.toggle('on', c.querySelector('input').value === kind);
    });
    $('cloudSec').classList.toggle('hidden', kind !== 'cloud');
    if (kind === 'local') probeLocal();
  }

  // 探本地：Ollama 在不在 + 模型下好没。
  // 探测失败的两种情况都给一个「一键…」入口，把人送到向导窗口 ——
  // 只丢一句"请先安装 Ollama / 请执行 ollama pull xxx"等于把门槛全推给用户。
  function localFixButton(label) {
    if (!label) return;
    const el = document.querySelector('[data-probe="local"]');
    if (!el) return;
    const b = document.createElement('button');
    b.className = 'probe-fix';
    b.textContent = label;
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try { window.desktopPet.openOllamaSetup(); } catch (e) {}
    });
    el.appendChild(document.createElement('br'));
    el.appendChild(b);
  }

  async function probeLocal() {
    setProbe('local', 'run', '正在检测 Ollama…');
    const model = (cfg.chat && cfg.chat.local && cfg.chat.local.model) || 'qwen2.5:7b-instruct-q4_K_M';
    try {
      const r = await fetch('/api/ollama/api/tags');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const names = (j.models || []).map((m) => m.name || '');
      const base = model.split(':')[0];
      const has = names.some((n) => n === model || n.split(':')[0] === base);
      if (has) setProbe('local', 'ok', '✓ 模型已就绪（' + model + '）');
      else {
        setProbe('local', 'bad', '⚠ Ollama 在跑，但没找到模型 ' + model);
        localFixButton('🔧 一键下载模型 →');
      }
    } catch (e) {
      setProbe('local', 'bad', '⚠ 连不上 Ollama（' + (e.message || e) + '）');
      localFixButton('🔧 一键安装 Ollama →');
    }
  }

  // ---------------------------------------------------------------- 云端表单
  function fillCloud() {
    const c = (cfg.chat && cfg.chat.cloud) || {};
    $('baseUrl').value = c.baseUrl || '';
    $('model').value = c.model || '';
    $('apiKey').value = c.apiKey || '';
    $('maxTokens').value = c.maxTokens || 512;
    // 反查预设：能对上就选中，对不上算自定义
    const hit = PRESETS.find((p) => p.id !== 'custom' && p.base === (c.baseUrl || '') && p.model === (c.model || ''));
    $('preset').value = hit ? hit.id : 'custom';
  }

  function renderPresets() {
    const sel = $('preset');
    sel.innerHTML = PRESETS.map((p) => '<option value="' + p.id + '">' + p.label + '</option>').join('');
    sel.addEventListener('change', () => {
      const p = PRESETS.find((x) => x.id === sel.value);
      if (p && p.id !== 'custom') { $('baseUrl').value = p.base; $('model').value = p.model; }
    });
  }

  async function testCloud() {
    const el = $('cloudProbe');
    el.className = 'probe run';
    el.textContent = '正在测试…';
    try {
      const r = await fetch('/api/cloud/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-target-base': $('baseUrl').value.trim(),
          'x-target-key': $('apiKey').value.trim()
        },
        body: JSON.stringify({
          model: $('model').value.trim(),
          messages: [{ role: 'user', content: '只回复一个字：好' }],
          stream: false,
          max_tokens: 16
        })
      });
      if (!r.ok) {
        let d = '';
        try { const j = await r.json(); d = j.error || (j.error && j.error.message) || ''; } catch (e) {}
        throw new Error(d || ('HTTP ' + r.status));
      }
      el.className = 'probe ok';
      el.textContent = '✓ 接口可用';
    } catch (e) {
      el.className = 'probe bad';
      el.textContent = '⚠ ' + (e.message || e);
    }
  }

  // ---------------------------------------------------------------- 人设表单
  function fillPersona() {
    const p = persona || {};
    $('charName').value = p.charName || '';
    $('charGender').value = p.charGender === undefined ? 'male' : (p.charGender || '');
    $('charSpecies').value = p.species || '';
    $('charAppearance').value = p.appearance || '';
    $('userTitle').value = p.userTitle || '';
    $('selfTitle').value = p.selfTitle || '';
    $('relation').value = p.relation || '';
    $('personality').value = lines(p.personality);
    $('tone').value = p.tone || '';
    $('speechLen').value = (p.speech && p.speech.length) || '';
    $('boundaries').value = lines(p.boundaries);
    $('extra').value = p.extra || '';
  }

  function collectPersona() {
    const old = persona || {};
    // 先摊开旧值再覆盖表单字段：表单只覆盖它自己有的输入框，这样人设新增字段
    // （species/appearance 这类）不会因为没有对应输入框而在保存时被悄悄丢掉。
    return Object.assign({}, old, {
      version: 2,
      charName: $('charName').value.trim() || '黑叶萤',
      charGender: $('charGender').value,
      charAge: old.charAge || '',
      species: $('charSpecies').value.trim(),
      appearance: $('charAppearance').value.trim(),
      relation: $('relation').value.trim() || '助理',
      userTitle: $('userTitle').value.trim(),
      selfTitle: $('selfTitle').value.trim(),
      personality: unlines($('personality').value),
      tone: $('tone').value.trim(),
      speech: Object.assign({}, old.speech, {
        length: $('speechLen').value.trim()
      }),
      boundaries: unlines($('boundaries').value),
      extra: $('extra').value.trim()
    });
  }

  // ---------------------------------------------------------------- 提交
  async function submit() {
    const noAsk = $('noAsk').checked;
    const btn = $('go');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const patch = {
        chat: {
          backend: picked,
          askEveryStart: !noAsk,
          cloud: {
            baseUrl: $('baseUrl').value.trim(),
            model: $('model').value.trim(),
            apiKey: $('apiKey').value.trim(),
            temperature: (cfg.chat && cfg.chat.cloud && cfg.chat.cloud.temperature) || 0.8,
            maxTokens: Number($('maxTokens').value) || 512
          }
        }
      };
      await window.desktopPet.setConfig(patch);
      await window.desktopPet.setPersona(collectPersona());
      // 最终没选本地：若刚才为探测而拉起了 Ollama，就关掉，别白占着显存
      if (picked !== 'local' && window.desktopPet && window.desktopPet.ollamaStatus) {
        try {
          const st = await window.desktopPet.ollamaStatus();
          if (st && st.owned) await window.desktopPet.ollamaStop();
        } catch (e) {}
      }
      window.desktopPet.send('pet:brainChoice', { backend: picked, askEveryStart: !noAsk });
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '确定';
      alert('保存失败：' + (e.message || e));
    }
  }

  // ---------------------------------------------------------------- 启动
  async function boot() {
    cfg = await window.desktopPet.getConfig() || {};
    persona = await window.desktopPet.getPersona();
    picked = (cfg.chat && cfg.chat.backend) || 'cloud';
    // 「下次不再询问」的初始勾选态取自当前配置：只有 askEveryStart 已经是 false 才勾上。
    // 旧版这个复选框恒为未勾选，于是"只要打开一次选择窗并点确定"就会把 askEveryStart 写成
    // true——用户本来只是想换个后端，却被静默改成"每次启动都询问"，之后每次开机都被拦在
    // 这一步（本次"桌宠打不开"的直接诱因）。
    try { $('noAsk').checked = !!(cfg.chat && cfg.chat.askEveryStart === false); } catch (e) {}
    renderCards();
    renderPresets();
    fillCloud();
    fillPersona();
    $('personaToggle').addEventListener('click', () => {
      const box = $('personaBox');
      const open = box.classList.toggle('hidden') === false;
      $('personaToggle').textContent = open ? '收起 ▴' : '展开定制 ▾';
    });
    $('testCloud').addEventListener('click', testCloud);
    $('go').addEventListener('click', submit);
    if (picked === 'local') probeLocal();
    // 向导装好/下好后会广播：立刻重新探测，别让用户看着"未安装"的旧结论。
    // 另外窗口重新获得焦点时也探一次（用户可能刚在别的窗口里装完 Ollama）。
    if (window.desktopPet && window.desktopPet.on) {
      window.desktopPet.on('pet:ollamaReady', () => { if (picked === 'local') probeLocal(); });
    }
    window.addEventListener('focus', () => { if (picked === 'local') probeLocal(); });
    $('localWarn').classList.toggle('hidden', picked !== 'local');
    if (picked === 'cloud') $('cloudSec').classList.remove('hidden');
    try {
      window.desktopPet.log('[brain-chooser] ready: backend=' + picked +
        ' persona=' + ((persona && persona.charName) || '(none)'));
    } catch (e) { /* 日志失败不影响使用 */ }
  }

  boot().catch((e) => {
    // 起不来也要留个线索：空窗口最难排查
    try { window.desktopPet.log('[brain-chooser] boot failed: ' + (e && e.message || e)); } catch (e2) {}
    document.body.insertAdjacentHTML('afterbegin',
      '<p style="color:#f0b849">加载失败：' + ((e && e.message) || e) + '</p>');
  });
})();
