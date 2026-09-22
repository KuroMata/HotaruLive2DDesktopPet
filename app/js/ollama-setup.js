// ollama-setup.js —— 本地模型安装向导
//
// 职责：把"用一个本地大模型"这件事从 5 条命令变成一个按钮。四步：
//   ① 检测（装没装 / 跑没跑 / 模型在不在 / 放哪 / 磁盘够不够）
//   ② 安装 Ollama（主进程负责探源 + 下载 1.5 GB + 静默安装，这里只显示进度）
//   ③ 启动服务（必须先于 ④，否则 pull 会自己起服务然后超时卡死）
//   ④ 下载模型（走 /api/ollama 同源代理，自己读 NDJSON 流算百分比）
//
// 几条纪律：
//   · 进度事件是按窗口广播的，页面刷新/重开后要能接着显示正在跑的任务，
//     所以 boot() 里检测到 busy 就进入"监听中"状态，而不是假设任务一定是本页发起的。
//   · 「拉模型」这一步必须在服务就绪后才允许点，按钮状态由 st.running 决定。
//   · 关窗不等于取消（取消要显式点），但关窗时主进程会取消任务——见 main.js 注释。
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = window.desktopPet || {};

  let st = null;            // 最近一次检测结果
  let installing = false;
  let pulling = false;
  let pullCtrl = null;      // 取消拉模型用
  let logAt = 0;

  // ---------------------------------------------------------------- 格式化
  function fmtSize(n) {
    if (n == null || n < 0) return '未知';
    if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
    if (n >= 1048576) return (n / 1048576).toFixed(0) + ' MB';
    return (n / 1024).toFixed(0) + ' KB';
  }
  function fmtEta(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    if (sec < 60) return Math.ceil(sec) + ' 秒';
    return Math.floor(sec / 60) + ' 分 ' + Math.round(sec % 60) + ' 秒';
  }
  function setBar(wrapId, barId, percent, indet) {
    const wrap = $(wrapId), bar = $(barId);
    if (!wrap || !bar) return;
    wrap.classList.toggle('indet', !!indet);
    bar.style.width = indet ? '' : Math.max(0, Math.min(100, percent || 0)) + '%';
  }
  function pushLog(msg) {
    const now = Date.now();
    if (now - logAt < 40) return;                  // 节流：日志刷太快会拖慢渲染
    logAt = now;
    const el = $('installLog');
    el.classList.remove('hidden');
    el.textContent += (el.textContent ? '\n' : '') + msg;
    el.scrollTop = el.scrollHeight;
  }

  // ---------------------------------------------------------------- 渲染
  function vRow(k, cls, text) {
    return '<div class="r"><span class="k">' + k + '</span><span class="v ' + cls + '">' + text + '</span></div>';
  }

  function render() {
    const s = st || {};
    const installed = !!s.installed;
    const running = !!s.running;
    const ready = running && !!s.modelReady;

    // ---- ① 检测行 ----
    let html = '';
    html += vRow('Ollama 程序', installed ? 'ok' : 'bad',
      installed ? '✓ 已安装　' + (s.exe || '') : '✗ 还没安装（第 2 步会替你装好）');
    html += vRow('后台服务', running ? 'ok' : 'bad',
      running ? '✓ 正在运行（端口 ' + s.port + '）' : (installed ? '✗ 没在跑（第 3 步启动）' : '✗ 没在跑'));
    html += vRow('聊天模型', ready ? 'ok' : 'bad',
      ready ? '✓ 已就绪　' + s.model : (running ? '✗ 还没下载　' + (s.model || '') : '✗ 等服务起来后再下'));
    if (s.models && s.models.length) {
      html += vRow('已有模型', 'run', s.models.map((m) => m.name + '（' + fmtSize(m.size) + '）').join('　'));
    }
    const dfree = s.diskModels && s.diskModels.freeBytes;
    html += vRow('磁盘空间', dfree > 0 && !s.diskModelsOk ? 'bad' : 'run',
      (dfree > 0 ? (s.modelsDir || '') + ' 所在盘可用 ' + fmtSize(dfree) : '磁盘信息不可读') +
      (dfree > 0 && !s.diskModelsOk ? '　⚠ 空间不足，需要约 4.7 GB' : ''));
    $('rows').innerHTML = html;

    if (document.activeElement !== $('modelsDir')) $('modelsDir').value = s.modelsDir || '';
    const dh = $('dirHint');
    // 三种来源要分开说，否则会把"自动探测到的已有目录"说成"Ollama 默认目录"（文案误导）
    const isDefaultDir = /[\\/]\.ollama[\\/]models$/i.test(String(s.modelsDir || ''));
    dh.textContent = '模型会下载到这个目录（7B 约 4.7 GB）。' +
      (s.modelsDirConfigured ? '当前是你自己指定的目录。'
        : (isDefaultDir ? '当前是 Ollama 的默认目录，想换到别的盘就在这里改。'
          : '当前是自动探测到的已有模型目录。')) +
      '改完会在下载模型时生效。';
    dh.className = 'hint' + (!s.diskModelsOk ? ' warn' : '');

    // ---- 步骤徽标 ----
    $('sec1').className = 'sec done';
    $('sec2').className = 'sec' + (installed ? ' done' : ' active');
    $('sec3').className = 'sec' + (running ? ' done' : (installed ? ' active' : ' dim'));
    $('sec4').className = 'sec' + (ready ? ' done' : (running ? ' active' : ' dim'));
    $('sec5').className = 'sec' + (ready ? ' active' : ' dim');

    // ---- 按钮态 ----
    $('btnInstall').disabled = installing || installed;
    $('btnInstall').textContent = installed ? '已经装好了' : (installing ? '正在安装…' : '一键安装 Ollama');
    $('btnServe').disabled = running || !installed || installing;
    $('btnServe').textContent = running ? '服务已在运行' : '启动服务';
    $('btnPull').disabled = pulling || !running;
    $('btnUse').disabled = !ready;

    $('serveState').textContent = running
      ? ('✓ 就绪（' + (s.port || 11434) + '）' + (s.ownedNote || ''))
      : (installed ? '还没启动' : '先装好 Ollama');
    $('modelSizeTag').textContent = ready ? '已就绪' : '约 4.7 GB';
    $('pullHint').textContent = !installed ? '先完成第 2、3 步'
      : (!running ? '要先启动服务才能下载模型'
        : (ready ? '模型已就绪。要换别的模型，改上面的选择再点下载即可。' : ''));
  }

  // ---------------------------------------------------------------- ① 检测
  async function detect() {
    $('btnDetect').disabled = true;
    $('btnDetect').textContent = '检测中…';
    try {
      const r = await api.ollamaDetect();
      if (r && r.ok) st = r.status; else st = { note: (r && r.message) || '检测失败' };
      render();
      if (r && r.ok && r.status.busy) {
        // 已有任务在跑（可能是上次没关完的窗口发起的）：切到监听态，别让用户重复点
        installing = true;
        $('installProg').classList.remove('hidden');
        $('btnCancelInstall').classList.remove('hidden');
        $('installText').textContent = '检测到有一个安装任务正在进行…';
        render();
      }
    } catch (e) {
      $('rows').innerHTML = vRow('检测', 'bad', '失败：' + ((e && e.message) || e));
    } finally {
      $('btnDetect').disabled = false;
      $('btnDetect').textContent = '重新检测';
    }
  }

  // ---------------------------------------------------------------- ② 安装
  async function doInstall() {
    if (installing) { $('btnCancelInstall').classList.toggle('hidden', false); return; }
    installing = true;
    $('installLog').textContent = '';
    $('installProg').classList.remove('hidden');
    $('installLog').classList.remove('hidden');
    $('btnCancelInstall').classList.remove('hidden');
    setBar('installBarWrap', 'installBar', 0, true);
    $('installText').textContent = '正在启动…';
    render();
    const t0 = Date.now();
    let r;
    try {
      r = await api.ollamaInstall();
    } catch (e) {
      r = { ok: false, message: (e && e.message) || String(e) };
    }
    installing = false;
    $('btnCancelInstall').classList.add('hidden');
    if (r && r.ok) {
      setBar('installBarWrap', 'installBar', 100, false);
      $('installText').innerHTML = '<b>✓ Ollama 安装完成</b>（用时 ' + Math.round((r.elapsedMs || (Date.now() - t0)) / 1000) + ' 秒）';
    } else if (r && r.cancelled) {
      setBar('installBarWrap', 'installBar', 0, false);
      $('installText').innerHTML = '已取消。已下载的部分会保留，下次点安装可以接着下。';
    } else {
      setBar('installBarWrap', 'installBar', 0, false);
      $('installText').innerHTML = '<span style="color:#e8794a">✗ 安装失败：</span>' +
        ((r && r.message) || '未知原因') +
        '<br>可以点「浏览器手动下载」自己装：浏览器带系统代理，往往比程序内下载更容易成功；装完回来点「重新检测」。';
    }
    await detect();
  }

  // 主进程推进来的安装进度
  function bindProgress() {
    if (!api.onOllamaSetupProgress) return;
    api.onOllamaSetupProgress((d) => {
      const phase = d.phase;
      if (phase === 'log') { pushLog(d.message || ''); return; }
      // 不是本页发起的任务（窗口被关掉又打开、或从别处触发）也要能显示进度
      $('installProg').classList.remove('hidden');
      $('installLog').classList.remove('hidden');
      if (phase === 'probe') {
        setBar('installBarWrap', 'installBar', 0, true);
        $('installText').textContent = d.message || '正在探测下载源…';
      } else if (phase === 'download') {
        setBar('installBarWrap', 'installBar', d.percent || 0, false);
        $('installText').innerHTML = '<b>' + (d.percent || 0).toFixed(1) + '%</b>　' +
          (d.source ? '来自 ' + d.source + '　' : '') +
          fmtSize(d.bytes) + (d.total ? ' / ' + fmtSize(d.total) : '');
      } else if (phase === 'verify') {
        setBar('installBarWrap', 'installBar', 100, true);
        $('installText').textContent = d.message || '正在校验完整性…';
      } else if (phase === 'install') {
        setBar('installBarWrap', 'installBar', 100, true);
        $('installText').textContent = d.message || '正在静默安装…';
      } else if (phase === 'done') {
        setBar('installBarWrap', 'installBar', 100, false);
        $('installText').innerHTML = '<b>✓ ' + (d.message || 'Ollama 安装完成') + '</b>';
      } else if (phase === 'error' || phase === 'cancelled') {
        setBar('installBarWrap', 'installBar', 0, false);
      }
    });
  }

  // ---------------------------------------------------------------- ③ 启服务
  async function startService() {
    const b = $('btnServe');
    b.disabled = true;
    let n = 0;
    const timer = setInterval(() => { n += 1; $('serveState').textContent = '正在启动…' + n + ' 秒'; }, 1000);
    try {
      const r = await api.ollamaStart(60000);
      if (r && r.ok) {
        $('serveState').textContent = r.already ? '✓ 服务本来就在跑（借用，不占用额外资源）' : ('✓ 已启动（用时 ' + Math.round((r.elapsedMs || 0) / 1000) + ' 秒）');
      } else {
        $('serveState').textContent = '✗ ' + ((r && r.message) || '启动失败');
      }
    } catch (e) {
      $('serveState').textContent = '✗ ' + ((e && e.message) || e);
    }
    clearInterval(timer);
    await detect();
  }

  // ---------------------------------------------------------------- ④ 拉模型
  function currentModel() {
    const v = $('modelPreset').value;
    if (v === '__custom__') return $('modelCustom').value.trim();
    return v;
  }

  async function doPull() {
    const model = currentModel();
    if (!model) { $('pullText').textContent = '请先填模型名'; $('pullProg').classList.remove('hidden'); return; }
    if (!st || !st.running) { $('pullText').textContent = '服务没在跑，先完成第 3 步'; $('pullProg').classList.remove('hidden'); return; }

    // 目录与模型名先落盘：接下来起的服务会带上正确的 OLLAMA_MODELS，
    // 否则会出现"下完了却报找不到模型"（服务在默认目录里找）。
    const dir = $('modelsDir').value.trim();
    try { await api.ollamaSaveLocalCfg({ model: model, modelsDir: dir }); } catch (e) {}
    if (!st.running) { await startService(); if (!st || !st.running) return; }

    pulling = true;
    $('btnCancelPull').classList.remove('hidden');
    $('pullProg').classList.remove('hidden');
    setBar('pullBarWrap', 'pullBar', 0, true);
    $('pullText').textContent = '正在连接…';
    render();

    pullCtrl = new AbortController();
    const t0 = Date.now();
    let got = 0, total = 0, lastT = t0, lastGot = 0, speed = 0, err = '';
    try {
      const res = await fetch('/api/ollama/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model, stream: true }),
        signal: pullCtrl.signal
      });
      if (!res.ok) {
        let t = '';
        try { t = await res.text(); } catch (e) {}
        throw new Error('HTTP ' + res.status + '　' + String(t || '').slice(0, 200));
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let j;
          try { j = JSON.parse(line); } catch (e) { continue; }
          if (j.error) { err = j.error; break; }
          if (j.total) { total = j.total; got = j.completed || 0; }
          const now = Date.now();
          if (now - lastT > 400) {
            const dt = (now - lastT) / 1000;
            if (got > lastGot && dt > 0) {
              // 第一次采样没有"上一次的字节数"可减，用平均速度顶上——
              // 否则速度与剩余时间会在头 400ms 显示成空白，看着像卡住
              speed = lastGot > 0 ? (got - lastGot) / dt : got / Math.max(0.001, (now - t0) / 1000);
            }
            lastT = now; lastGot = got;
            const pct = total ? (got / total) * 100 : 0;
            setBar('pullBarWrap', 'pullBar', pct, !total);
            const eta = speed > 0 && total ? (total - got) / speed : 0;
            $('pullText').innerHTML = '<b>' + pct.toFixed(1) + '%</b>　' +
              fmtSize(got) + (total ? ' / ' + fmtSize(total) : '') +
              (speed ? '　' + fmtSize(speed) + '/s' : '') +
              (eta ? '　剩 ' + fmtEta(eta) : '');
          }
          if (j.status) {
            // 非下载阶段（拉清单 / 校验 / 写清单）没有字节数，显示状态原文
            if (['pulling manifest', 'verifying sha256 digest', 'writing manifest', 'success'].indexOf(j.status) >= 0) {
              const cn = {
                'pulling manifest': '正在拉取模型清单…',
                'verifying sha256 digest': '正在校验模型完整性…',
                'writing manifest': '正在写入模型清单…',
                'success': '✓ 下载完成'
              }[j.status];
              $('pullText').innerHTML = '<b>' + cn + '</b>';
              if (j.status !== 'success') setBar('pullBarWrap', 'pullBar', 100, true);
            }
          }
          if (err) break;
        }
        if (err) break;
      }
      if (err) throw new Error(err);
      setBar('pullBarWrap', 'pullBar', 100, false);
      $('pullText').innerHTML = '<b>✓ 模型 ' + model + ' 已就绪</b>';
    } catch (e) {
      const cancelled = e && e.name === 'AbortError';
      setBar('pullBarWrap', 'pullBar', 0, false);
      $('pullText').innerHTML = cancelled
        ? '已取消。已下载的部分 Ollama 会自己保留，再点下载会续传。'
        : '<span style="color:#e8794a">✗ 下载失败：</span>' + ((e && e.message) || e);
    }
    pulling = false;
    pullCtrl = null;
    $('btnCancelPull').classList.add('hidden');
    await detect();
  }

  // ---------------------------------------------------------------- ⑤ 收尾
  async function useLocal() {
    const model = currentModel();
    const dir = $('modelsDir').value.trim();
    $('btnUse').disabled = true;
    try {
      await api.ollamaSaveLocalCfg({ model: model, modelsDir: dir });
      api.ollamaUseLocal({ model: model });
      $('useState').textContent = '✓ 已切换为本地模型，回桌宠发一句话试试（第一次要等 30~60 秒）';
    } catch (e) {
      $('useState').textContent = '✗ ' + ((e && e.message) || e);
      $('btnUse').disabled = false;
    }
  }

  // ---------------------------------------------------------------- 启动
  async function boot() {
    bindProgress();

    $('btnDetect').addEventListener('click', detect);
    $('btnInstall').addEventListener('click', doInstall);
    $('btnManual').addEventListener('click', async () => {
      const r = await api.ollamaOpenDownloadPage();
      $('installLog').classList.remove('hidden');
      pushLog(r && r.ok ? '已用浏览器打开下载页：装完后回到这里点「重新检测」。' : '打开浏览器失败，请手动访问 https://ollama.com/download/windows');
    });
    $('btnCancelInstall').addEventListener('click', async () => {
      $('installText').textContent = '正在取消…';
      await api.ollamaInstallCancel();
    });
    $('btnServe').addEventListener('click', startService);
    $('btnPull').addEventListener('click', doPull);
    $('btnCancelPull').addEventListener('click', () => { try { if (pullCtrl) pullCtrl.abort(); } catch (e) {} });
    $('btnUse').addEventListener('click', useLocal);
    $('btnClose').addEventListener('click', () => window.close());

    $('modelPreset').addEventListener('change', () => {
      const custom = $('modelPreset').value === '__custom__';
      $('customRow').classList.toggle('hidden', !custom);
    });
    $('btnPickDir').addEventListener('click', async () => {
      try {
        const d = await api.chooseDirectory({ title: '选择模型存放目录', defaultPath: $('modelsDir').value || '' });
        if (d) { $('modelsDir').value = d; }
      } catch (e) {}
    });
    // 模型名改动即落盘，免得用户改完就点下载、结果还是旧名字
    $('modelPreset').addEventListener('change', async () => {
      const m = currentModel();
      if (m) { try { await api.ollamaSaveLocalCfg({ model: m }); } catch (e) {} }
    });

    // 向导完成后主进程会广播：选择大脑窗那边要立刻刷新
    if (api.on) api.on('pet:ollamaReady', () => { detect(); });

    // 选到当前配置的模型档（用户上次可能选了 3B，别默认回到 7B 又下一遍）
    try {
      const d = await api.ollamaDetect();
      const cur = d && d.ok && d.status && d.status.model;
      if (cur) {
        const hit = Array.prototype.slice.call($('modelPreset').options).some((o) => o.value === cur);
        if (hit) {
          $('modelPreset').value = cur;
        } else {
          $('modelPreset').value = '__custom__';
          $('customRow').classList.remove('hidden');
          $('modelCustom').value = cur;
        }
      }
    } catch (e) {}
    await detect();
    try { api.log('[ollama-setup] ready'); } catch (e) {}
  }

  boot().catch((e) => {
    try { api.log('[ollama-setup] boot failed: ' + ((e && e.message) || e)); } catch (e2) {}
    document.body.insertAdjacentHTML('afterbegin',
      '<p style="color:#f0b849">加载失败：' + ((e && e.message) || e) + '</p>');
  });
})();
