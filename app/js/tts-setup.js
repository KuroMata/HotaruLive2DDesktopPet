/* 语音引擎安装向导（前端）。结构与 ollama-setup.js 一致：
   页面只做"显示 + 驱动"，真正的下载/解压/pip 都在主进程起的那两个 Python 脚本里，
   进度经 pet:ttsSetupProgress 推进来。 */
(function () {
  'use strict';
  var api = window.desktopPet;
  var $ = function (id) { return document.getElementById(id); };

  if (!api || typeof api.ttsEngineDetect !== 'function') {
    document.body.innerHTML = '<p style="color:#e8794a">这个页面需要从桌宠里打开（缺少 IPC 桥接）。</p>';
    return;
  }

  // 装配步骤顺序（必须与 provision_engine.py 的 STEPS 一致）
  var ORDER = ['python', 'source', 'weights', 'deps', 'fixups', 'voice', 'verify'];
  var LABEL = {
    python: 'Python 环境', source: '引擎源码', weights: '通用权重（5.2 GB）',
    deps: '依赖', fixups: '兼容修补', voice: '声库', verify: '自检'
  };

  var installing = false;

  function setSecClass(id, cls) {
    var el = $(id);
    if (!el) return;
    el.classList.remove('active', 'done', 'dim');
    if (cls) el.classList.add(cls);
  }

  function fmtBytes(b) {
    if (!b || b < 0) return '';
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b >= 1048576) return (b / 1048576).toFixed(0) + ' MB';
    return (b / 1024).toFixed(0) + ' KB';
  }

  // ---------------------------------------------------------------- 检测
  function renderRows(status) {
    var rows = $('rows');
    rows.innerHTML = '';
    var checks = (status && status.checks) || [];
    if (!checks.length && status && status.noPython) {
      var d = document.createElement('div');
      d.className = 'r';
      d.innerHTML = '<span class="k">Python 运行时</span><span class="v bad">未找到</span>' +
        '<span class="fix">点「一键装配引擎」会自动装一个（免管理员）</span>';
      rows.appendChild(d);
      return;
    }
    checks.forEach(function (c) {
      var div = document.createElement('div');
      div.className = 'r';
      var v = document.createElement('span');
      v.className = 'v ' + (c.ok ? 'ok' : 'bad');
      v.textContent = c.detail || (c.ok ? '已就位' : '缺失');
      div.innerHTML = '<span class="k"></span>';
      div.firstChild.textContent = c.label;
      div.appendChild(v);
      if (!c.ok && c.fix) {
        var f = document.createElement('span');
        f.className = 'fix';
        f.textContent = '— ' + c.fix;
        div.appendChild(f);
      }
      rows.appendChild(div);
    });
  }

  function applyStatus(status) {
    renderRows(status);
    var ready = !!(status && status.ready);
    var hint = $('detectHint');
    var need = (status && status.needBytes) ? fmtBytes(status.needBytes) : '11.8 GB';
    var free = (status && status.diskFreeBytes > 0) ? fmtBytes(status.diskFreeBytes) : '';
    if (ready) {
      setSecClass('sec1', 'done');
      setSecClass('sec2', 'dim');
      setSecClass('sec3', 'active');
      hint.textContent = '引擎已就绪，可以直接用你的音色说话了。';
      $('btnInstall').disabled = true;
    } else {
      setSecClass('sec1', 'active');
      setSecClass('sec2', '');
      hint.innerHTML = '需要下载约 <b>' + need + '</b>' +
        (free ? '，当前磁盘可用 <b>' + free + '</b>' : '') + '。' +
        (status && status.sidecarRunning ? '（引擎进程已在运行）' : '');
      $('btnInstall').disabled = false;
    }
  }

  function detect() {
    $('btnDetect').disabled = true;
    api.ttsEngineDetect().then(function (r) {
      $('btnDetect').disabled = false;
      if (!r || !r.ok) {
        $('detectHint').textContent = '检测失败：' + ((r && r.message) || '未知错误');
        return;
      }
      applyStatus(r.status);
    }).catch(function (e) {
      $('btnDetect').disabled = false;
      $('detectHint').textContent = '检测失败：' + e;
    });
  }

  // ---------------------------------------------------------------- 装配
  function renderSteps(cur, doneSet) {
    var box = $('steps');
    box.innerHTML = '';
    ORDER.forEach(function (s) {
      var sp = document.createElement('span');
      sp.textContent = LABEL[s] || s;
      if (doneSet[s]) sp.className = 'ok';
      else if (s === cur) sp.className = 'on';
      box.appendChild(sp);
    });
  }

  function overallPercent(step, percent) {
    var i = ORDER.indexOf(step);
    if (i < 0) return Math.min(100, percent || 0);
    var per = 100 / ORDER.length;
    return Math.min(100, i * per + (percent || 0) / 100 * per);
  }

  function appendLog(line) {
    var el = $('log');
    el.classList.remove('hidden');
    el.textContent += (el.textContent ? '\n' : '') + line;
    var lines = el.textContent.split('\n');
    if (lines.length > 200) el.textContent = lines.slice(-200).join('\n');
    el.scrollTop = el.scrollHeight;
  }

  var doneSet = {};

  function onProgress(d) {
    if (!d) return;
    if (d.phase === 'log') { appendLog(d.message || ''); return; }
    if (d.phase === 'done') {
      installing = false;
      $('btnCancel').classList.add('hidden');
      $('btnInstall').disabled = false;
      if (d.ok) {
        $('bar').style.width = '100%';
        $('progText').innerHTML = '<b>' + (d.message || '装配完成') + '</b>';
        $('useState').textContent = '';
        setSecClass('sec2', 'done');
        setSecClass('sec3', 'active');
        detect();
      } else {
        $('barWrap').classList.remove('indet');
        $('progText').innerHTML = '<b style="color:#e8794a">' + (d.message || '装配失败') + '</b>';
        setSecClass('sec2', 'active');
      }
      return;
    }
    // 步骤进行中
    var step = d.step || d.phase;
    if (ORDER.indexOf(step) >= 0) {
      if (d.phase === 'begin') { /* noop */ }
      if (d.percent >= 100) doneSet[step] = true;
      renderSteps(step, doneSet);
    }
    var pct = overallPercent(step, d.percent);
    $('bar').style.width = pct.toFixed(1) + '%';
    var txt = (LABEL[step] || step) + '：' + (d.message || '');
    if (d.total) txt += '  ' + fmtBytes(d.bytes || 0) + ' / ' + fmtBytes(d.total);
    $('progText').textContent = txt;
    if (d.step === 'log') appendLog(d.message || '');
  }

  function install() {
    if (installing) return;
    installing = true;
    doneSet = {};
    $('btnInstall').disabled = true;
    $('btnCancel').classList.remove('hidden');
    $('prog').classList.remove('hidden');
    $('log').classList.remove('hidden');
    $('log').textContent = '';
    $('bar').style.width = '0%';
    $('barWrap').classList.remove('indet');
    $('progText').innerHTML = '<b>正在启动装配…</b>';
    renderSteps('python', {});
    setSecClass('sec2', 'active');
    api.ttsEngineInstall().then(function (r) {
      // 收尾由 onProgress 的 done 事件处理；这里只兜住"没收到事件就返回"的情况
      if (r && !r.ok && installing) {
        installing = false;
        $('btnCancel').classList.add('hidden');
        $('btnInstall').disabled = false;
        $('progText').innerHTML = '<b style="color:#e8794a">' + (r.message || '装配失败') + '</b>';
      }
    }).catch(function (e) {
      installing = false;
      $('btnCancel').classList.add('hidden');
      $('btnInstall').disabled = false;
      $('progText').innerHTML = '<b style="color:#e8794a">装配异常：' + e + '</b>';
    });
  }

  function cancel() {
    api.ttsEngineInstallCancel();
    $('progText').innerHTML = '<b>正在取消…</b>';
  }

  // ---------------------------------------------------------------- 绑定
  $('btnDetect').addEventListener('click', detect);
  $('btnInstall').addEventListener('click', install);
  $('btnCancel').addEventListener('click', cancel);
  $('btnClose').addEventListener('click', function () { window.close(); });
  $('btnPage').addEventListener('click', function () { api.ttsEngineOpenPage(); });
  $('btnUse').addEventListener('click', function () {
    // 等价于"设置里选 GPT-SoVITS + 打开语音"，主进程会落盘并重启侧车
    api.setConfig({ ttsEnabled: true, ttsEngine: 'gptsovits' });
    $('useState').textContent = '已切换到你的音色';
  });

  if (typeof api.onTtsSetupProgress === 'function') api.onTtsSetupProgress(onProgress);

  $('footHint').textContent = '声库已内置在安装包里 · 装完即用你的音色';
  detect();
})();
