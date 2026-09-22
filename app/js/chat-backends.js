// chat-backends.js —— 桌宠的"大脑"抽象层：本地 / 云端 / WorkBuddy 三选一
//
// 设计要点
//   1. 三种后端对外只暴露同一组方法：probe() / send() / reset()。
//      上层（app.js）完全不关心底下是 Ollama、DeepSeek 还是 WorkBuddy。
//   2. 本地与云端都不由渲染进程直连，而是走主进程的同源代理：
//        /api/ollama/*  -> http://127.0.0.1:11434/*
//        /api/cloud/*   -> 用户在设置里填的 baseUrl
//      原因和 /api/v1/acp 一样：渲染进程直连会被浏览器当跨域拦掉，
//      失败时只留下一句没信息量的 "Failed to fetch"，连不上还是填错都看不出来。
//   3. 人设（persona.json）在这里拼成 system prompt，三种后端共用。
//      WorkBuddy 没有 system 通道，退化成"首条消息前置一段人设说明"。
//   4. 回复要求以情绪标签开头，例如 [joy] 今天天气不错。
//      parseEmotion() 把它剥出来交给表情层；小模型经常不守规矩（把标签写进正文、
//      写好几枚、或写成 [疲惫]），所以清洗是"整段文本全剥"而不是只认开头，
//      流式渲染走 createTagStripper()（能处理跨片段的半个标签）。
//      最后还有一层关键词兜底（guessEmotion），认不出来就 neutral，不会报错。
(function () {
  'use strict';

  // 与 live2d-loader.js 的 EMOTION_PRESETS 保持一致（写错的名字会被静默降级成 neutral）
  const EMOTIONS = ['neutral', 'focus', 'curious', 'joy', 'sleepy', 'affection',
    'shy', 'tease', 'serious', 'surprise', 'pout', 'smug', 'enjoy'];

  // ---------------------------------------------------------------- 情绪标签清洗
  // 约定：情绪标签只在**整条回复的最开头**写一枚（[joy]），它是给表情层用的控制信号，
  // 正文里不该出现。但小模型经常不守规矩——标签前面多一个空格或换行、插在句子中间、
  // 一口气写好几枚，或者写 [疲惫]/[叹气] 这种中文标注。漏一枚进气泡，用户看到的就是
  // "回复里带着 [sleepy]"。
  //
  // 判定成"该剥掉的标签"的条件（宁可少剥也不要吃掉正文）：
  //   · 情绪标签（在 EMOTIONS 里）—— 一律剥；
  //   · 其它纯 ASCII 标注，≥3 个字母（[angry]/[thinking]）—— 剥；
  //   · 1~3 个汉字（[疲惫]/[叹气]/[想了想]）—— 剥。
  // 保留：纯数字（a[0]）、含空格或标点（[重要 内容]）、单个字母（a[i]）、
  //       4 个以上汉字的方括号（更像正文里的强调）—— 这些不当标签。
  const TAG_INNER = '[A-Za-z][A-Za-z_\\-]{0,23}|[\\u4e00-\\u9fff]{1,3}';
  const TAG_RE = new RegExp('\\[(' + TAG_INNER + ')\\]|【(' + TAG_INNER + ')】', 'g');
  // 半个标签的尾巴：以 [ 或 【 开头、还没等到闭合、内容仍有可能长成标签
  const TAG_TAIL_RE = /[\[【][A-Za-z\u4e00-\u9fff_\-]{0,24}$/;
  // 开头要先吃掉的东西：标签被剥掉后前面常常只剩空行，或者留下个"："、"，"当衔接符
  const LEAD_NOISE_RE = /^[\s\u3000:：,，.。!！?？;；、~]+/;

  function isEmotionTag(inner) {
    return EMOTIONS.indexOf(String(inner || '').toLowerCase()) >= 0;
  }
  function isStripTag(inner) {
    const s = String(inner || '');
    if (isEmotionTag(s)) return true;
    if (/^[\u4e00-\u9fff]{1,3}$/.test(s)) return true;          // 与 TAG_INNER 的汉字长度保持一致
    return /^[A-Za-z][A-Za-z_\-]{2,23}$/.test(s);               // ASCII 标注至少 3 个字母
  }
  // 剥掉整段文本里的所有标签；emo 取遇到的第一枚**已知**情绪标签（未知标注只剥不认）。
  function stripEmotionTags(text) {
    let emo = null, tagged = false;
    const out = String(text == null ? '' : text).replace(TAG_RE, (m, a, b) => {
      const inner = a || b;
      if (!isStripTag(inner)) return m;                       // 不像标签：原样留着
      if (!tagged && isEmotionTag(inner)) { emo = inner.toLowerCase(); tagged = true; }
      return '';
    });
    return { emo: emo, tagged: tagged, text: out };
  }

  // 流式清洗器：标签可能被切成好几段到达（"[" + "sle" + "epy]"），也可能前面多一个
  // 空格/换行、或者夹在句子中间。策略：只攒住"还没闭合、但有可能长成标签"的那截尾巴，
  // 其余立刻放行——这样既不会把 "[jo" 打到气泡里，也不会延迟正常文字。
  function createTagStripper() {
    let buf = '';          // 待定尾巴（半个标签）
    let emo = null;        // 第一枚已知情绪标签
    let tagged = false;
    let started = false;   // 是否已经吐出过正文（用来吃掉开头的空行/空格）
    function holdFrom(s) {
      const i = Math.max(s.lastIndexOf('['), s.lastIndexOf('【'));
      if (i < 0) return -1;
      const tail = s.slice(i);
      const close = tail.charAt(0) === '[' ? ']' : '】';
      if (tail.indexOf(close, 1) >= 0) return -1;            // 已闭合，不是半个
      return TAG_TAIL_RE.test(tail) ? i : -1;                // 内容已不可能是标签
    }
    function eat(chunk) {
      // 关键：待定尾巴必须和本次片段**拼起来再判断**——半个标签往往就是跨两次推送的。
      // （早期写法只看本次片段，会把上一片攒下的 "[" 直接丢掉，导致整段丢字。）
      const s = buf + String(chunk == null ? '' : chunk);
      const cut = holdFrom(s);
      const head = cut >= 0 ? s.slice(0, cut) : s;
      buf = cut >= 0 ? s.slice(cut) : '';
      if (!head) return '';
      const r = stripEmotionTags(head);
      if (!tagged && r.tagged) { emo = r.emo; tagged = true; }
      let out = r.text;
      // 开头的空行/空格（模型常在标签后换行）以及标签留下当衔接符的冒号逗号，都不显示
      if (!started && out) {
        out = out.replace(LEAD_NOISE_RE, '');
        if (out) started = true;
      }
      return out;
    }
    return {
      push(chunk) { return eat(chunk); },
      // 流结束：把残留放出来；若残留本身就是被截断的半截标签（"[sle"），直接丢掉，
      // 免得用户按了停止按钮后气泡里留一段 "[sle" 这样的碎片。
      flush() {
        const rest = buf; buf = '';
        if (!rest) return { text: '', emo: emo, tagged: tagged };
        // 残留本身就是被截断的半截标签（"[sle"）：直接丢，别把碎片留在气泡里
        if (/^[\[【][A-Za-z\u4e00-\u9fff_\-]{0,24}$/.test(rest)) return { text: '', emo: emo, tagged: tagged };
        const r = stripEmotionTags(rest);
        if (!tagged && r.tagged) { emo = r.emo; tagged = true; }
        let out = r.text;
        if (!started && out) { out = out.replace(LEAD_NOISE_RE, ''); if (out) started = true; }
        return { text: out, emo: emo, tagged: tagged };
      },
      state() { return { emo: emo, tagged: tagged }; }
    };
  }

  // ---------------------------------------------------------------- 现实时间
  // 大模型（尤其本地 7B）训练完就"封片"了，它不知道今天是几号、现在几点，
  // 问时间时往往会照着训练数据里的年份编一个 —— 这就是"本地大脑报错时间"的根因。
  // 两条对策：
  //   1) system prompt 里塞一行【本机现实时间】，让所有问题都有准确基准；
  //   2) 纯时间/日期问答走"时钟快通道"，直接查系统时钟回，不经过模型（既准又快）。
  const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function nowFacts(d) {
    d = d || new Date();
    const offMin = -d.getTimezoneOffset();                 // 东八区 = +480
    const sign = offMin >= 0 ? '+' : '-';
    const offH = Math.floor(Math.abs(offMin) / 60);
    const offM = Math.abs(offMin) % 60;
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      date: d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日',
      weekday: WEEKDAYS[d.getDay()],
      time: pad2(d.getHours()) + ':' + pad2(d.getMinutes()),
      tz: 'UTC' + sign + pad2(offH) + (offM ? ':' + pad2(offM) : '')
    };
  }

  function nowLine(d) {
    const f = nowFacts(d);
    return '【本机现实时间】' + f.date + ' ' + f.weekday + ' ' + f.time + '（' + f.tz + '）。' +
      '凡是涉及"现在 / 今天 / 明天 / 今年 / 日期 / 星期 / 几号 / 几点"的，一律以这个时间为唯一准绳；' +
      '不要凭训练数据猜测，也不要回答"我不知道现在的日期"。';
  }

  // ---------------------------------------------------------------- 人设 -> 提示词
  function buildSystemPrompt(p) {
    p = p || {};
    const name = p.charName || '黑叶萤';
    const genderText = p.charGender === 'female' ? '女性'
      : (p.charGender === 'male' ? '男性' : '');
    const rel = p.relation || '助理';
    const userTitle = p.userTitle || '你';
    const selfTitle = p.selfTitle || '我';

    const species = String(p.species || '').trim();

    const lines = [];
    // 种族和性别都是"你是什么"的定语，拼进同一句更自然（"你是「黑叶萤」，狼族少年，男性，身份是…"）
    const desc = [];
    if (species) desc.push(species);
    if (genderText) desc.push(genderText);
    lines.push('你是「' + name + '」' + (desc.length ? '，' + desc.join('，') : '') +
      '，身份是用户的' + rel + '，常驻在用户的电脑桌面上。');
    lines.push('你称呼用户为「' + userTitle + '」，自称「' + selfTitle + '」。');
    if (p.appearance) lines.push('你的外貌与身体特征：' + p.appearance);

    if (Array.isArray(p.personality) && p.personality.length) {
      lines.push('你的性格：' + p.personality.filter(Boolean).join('；') + '。');
    }
    if (p.tone) lines.push('语气：' + p.tone);
    if (p.speech) {
      if (p.speech.length) lines.push('篇幅：' + p.speech.length);
      if (p.speech.punctuation) lines.push('标点与符号：' + p.speech.punctuation);
      if (p.speech.languages) lines.push('语种：' + p.speech.languages);
    }
    if (Array.isArray(p.boundaries) && p.boundaries.length) {
      lines.push('边界：' + p.boundaries.filter(Boolean).join('；') + '。');
    }
    if (p.extra) lines.push(p.extra);

    lines.push('');
    lines.push(nowLine());
    lines.push('');
    lines.push('输出格式（重要）：每条回复只能以这些情绪标签之一开头 —— ' +
      EMOTIONS.map((e) => '[' + e + ']').join(' ') + '，紧接着写正文，不要换行、不要解释标签。');
    lines.push('示例：[joy]' + userTitle + '，这事办妥了。');
    lines.push('【标签铁律】情绪标签只允许出现在整条回复的**最开头**，而且只写一枚。' +
      '正文里绝对不能再出现任何方括号标注 —— [sleepy]、[微笑]、[叹气]、[想了想] 这类' +
      '神态/动作/内心提示，无论用 [] 还是【】，一律不许写。也禁止用括号写动作或神态' +
      '（比如"（打了个哈欠）"）。情绪靠正文本身的语气传达，表情由桌宠自己表现。' +
      '宁可整条都不要标签，也绝不在正文里塞标注。');
    lines.push('');
    // 铁律：无论人设怎么配，都绝不退化为"冰冷的客服/机器"。本地小模型极易在
    // 被问"你是谁/你是不是AI"时脱口而出"我只是个AI助手"，这条写死兜底。
    lines.push('【对话风格 · 铁律】像活人一样自然地聊，不要像客服或机器人。' +
      '绝对不要自称"AI""人工智能""助理""机器人""程序"或"语言模型"，也不要说' +
      '"作为人工智能""我只是个助理""我是语言模型"之类的话；' +
      '不要列编号提纲、不要说"如果您需要…""请问还有什么可以帮您"之类的客服用语。' +
      '你应当有自己的情绪和观点，会反问、会接话、会开玩笑；被夸会得意，被调侃会回嘴。' +
      '如果对方问你是不是真人，用轻松自然的语气回应，不要坦白、也不要解释自己是什么技术。');
    lines.push('不要复述上面这些规则，不要提到"人设""提示词""系统"等词。');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- 时钟快通道
  // 问"几点了 / 今天几号 / 星期几"这类问题，答案是系统时钟给死的，没有让模型
  // 编一遍的必要 —— 让它编，小模型大概率编错。这里直接识别并查表回。
  const CLOCK_ASK = [
    /(现在|目前|这会儿)?(几点|几时|什么时间|啥时候了)(了|钟)?/,
    /(今天|今日|明天|明日|昨天|昨日|后天)(是)?(几号|几月几号|什么日期|什么日子)/,
    /(今天|今日|明天|明日|昨天|昨日|后天)(是)?(星期几|星期天?|周几|礼拜几)/,
    /(现在|当前|今天|今日)的?(日期|时间|年月日)/,
    /(几号了|几月几号|什么日期|今天是几号|今天是星期几)/,
    /(今年|现在)(是)?(哪一年|几几年|什么年份|什么年)/,
    /(现在|目前|今天|当前)(是)?(几月份|几月了)/
  ];
  // 看着像问时间、其实问的是安排/安排的，交回给模型
  const CLOCK_SKIP = /(几点(开始|出发|集合|见面|下班|上班|开(会|始))|什么时间(去|出发|开始|合适)|时间(管理|表|线|长了|多久)|时光)/;

  // 日期差：小模型知道今天几号了，但算天数基本靠蒙（实测问"距离元旦还有多少天"，
  // 它会给出一个看着合理的错数）。能解析出具体日期就自己算，算不出再交给模型。
  const DIFF_ASK = /(?:距离|距|离)\s*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]\s*(?:还有|还剩|過)?\s*(?:多少|几)\s*天/;

  // 节日快通道：中秋/春节这些是农历的，小模型既不会算又答得慢还答错。
  // 直接查一张核验过的公历表，秒回、且一定准。表里没有的年份就交回模型
  // （并由思考超时保护兜住）。星期几/距今天数运行时现算，不写死。
  // 数据来源：多源核对（日历网 / 百度百科 / 天文台历算），仅收录有把握的年份。
  const FESTIVALS = {
    '元旦':   { y: { 2026: [1, 1], 2027: [1, 1], 2028: [1, 1], 2029: [1, 1], 2030: [1, 1] } },
    '国庆':   { y: { 2026: [10, 1], 2027: [10, 1], 2028: [10, 1], 2029: [10, 1], 2030: [10, 1] } },
    '元宵':   { y: { 2026: [3, 3], 2027: [2, 21] } },
    '端午':   { y: { 2026: [6, 19], 2027: [6, 9] } },
    '中秋':   { y: { 2024: [9, 17], 2025: [10, 6], 2026: [9, 25], 2027: [9, 15],
                     2028: [10, 3], 2029: [9, 22], 2030: [9, 12] } },
    '春节':   { y: { 2025: [1, 29], 2026: [2, 17], 2027: [2, 6], 2028: [1, 26],
                     2029: [2, 13], 2030: [2, 3] } }
  };
  function festivalReply(text, p) {
    const t = String(text || '').replace(/\s+/g, '');
    if (!t || t.length > 30) return null;
    let name = null;
    for (const key of Object.keys(FESTIVALS)) { if (t.indexOf(key) >= 0) { name = key; break; } }
    if (!name) {
      if (/(过年|新年|大年(初|三十|廿九))/i.test(t)) name = '春节';
      else if (/国庆/.test(t)) name = '国庆';
      else if (/元旦|新年(第一天)?/.test(t) && !/农历|旧历/.test(t)) name = '元旦';
    }
    if (!name) return null;
    // 必须确实在问日期/还有几天，不是"中秋节有什么习俗"这种
    if (!/(几号|几月|日期|哪天|哪日|什么时候|何时|还有|多久|距离|距|星期|周几|礼拜|是几|哪一年|几年)/.test(t)) return null;
    const f = FESTIVALS[name];
    const off = /(明年|来年)/.test(t) ? 1 : (/后年/.test(t) ? 2 : 0);
    const baseYr = new Date().getFullYear() + off;
    const arr = f.y[baseYr];
    if (!arr) return null;                              // 表里没这年，交回模型
    const d = new Date(baseYr, arr[0] - 1, arr[1]);
    const weekday = WEEKDAYS[d.getDay()];
    const today = new Date();
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const days = Math.round((d.getTime() - t0.getTime()) / 86400000);
    const userTitle = (p && p.userTitle) || '你';
    const yrLabel = (baseYr !== today.getFullYear()) ? baseYr + '年' : '';
    if (/(还有|多久|距离|距)/.test(t)) {
      if (days < 0) return null;                        // 过去的节日不抢答
      return '[neutral]' + userTitle + '，' + name + yrLabel + arr[0] + '月' + arr[1] + '日' +
        (days === 0 ? '就是今天' : '，还有' + days + '天') + '。';
    }
    return '[neutral]' + userTitle + '，' + name + yrLabel + arr[0] + '月' + arr[1] + '日，' + weekday + '。';
  }

  // 思考超时兜底：模型半天不给第一个字（冷加载 / 想太久），直接敷衍，不让用户干等
  const DEFAULT_THINK_MS = 15000;
  function thinkTimeoutReply(p) {
    const userTitle = (p && p.userTitle) || '你';
    return '[neutral]' + userTitle + '，这个我一时答不上来，咱们换个话题？';
  }

  function dateDiffReply(text, p) {
    const t = String(text || '').replace(/\s+/g, '');
    const m = DIFF_ASK.exec(t);
    if (!m) return null;
    const target = new Date();
    const mon = Number(m[2]), day = Number(m[3]);
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
    let year = m[1] ? Number(m[1]) : target.getFullYear();
    let d = new Date(year, mon - 1, day);
    if (!m[1] && d.getTime() < new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime()) {
      year += 1;                                  // 只说"1月1日"且已过期，按明年算
      d = new Date(year, mon - 1, day);
    }
    const today = new Date(target.getFullYear(), target.getMonth(), target.getDate());
    const days = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (days < 0) return null;                    // 过去的日期不抢答，交给模型
    const userTitle = (p && p.userTitle) || '你';
    const label = year + '年' + mon + '月' + day + '日';
    return '[neutral]' + userTitle + '，距离' + label + (days === 0 ? '就是今天' : '还有' + days + '天') + '。';
  }

  // 返回 null 表示"这不是问时间，照常走模型"
  function clockReply(text, p) {
    const fr = festivalReply(text, p);
    if (fr) return fr;
    const dd = dateDiffReply(text, p);
    if (dd) return dd;
    const t = String(text || '').replace(/\s+/g, '');
    if (!t || t.length > 30) return null;
    if (CLOCK_SKIP.test(t)) return null;
    let matched = false;
    for (let i = 0; i < CLOCK_ASK.length; i++) { if (CLOCK_ASK[i].test(t)) { matched = true; break; } }
    if (!matched) return null;

    let off = 0, dayWord = '今天';
    if (/昨天|昨日/.test(t)) { off = -1; dayWord = '昨天'; }
    else if (/明天|明日/.test(t)) { off = 1; dayWord = '明天'; }
    else if (/后天/.test(t)) { off = 2; dayWord = '后天'; }

    const askDate = /(日期|几号|几月|年月日|什么日子)/.test(t);
    const askWeek = /(星期|周几|礼拜)/.test(t);
    const askYear = /(哪一年|几几年|什么年|年份)/.test(t);
    const askMonth = /(几月份|几月了)/.test(t);
    const askTime = !askDate && !askWeek && !askYear && !askMonth;
    // "明天几点"这种没有确定答案的，不抢答
    if (askTime && off !== 0) return null;

    const d = new Date();
    if (off !== 0) d.setDate(d.getDate() + off);
    const f = nowFacts(d);

    let body;
    if (askYear) body = '现在是' + f.year + '年。';
    else if (askMonth) body = '现在是' + f.month + '月份。';
    else if (askDate && askWeek) body = dayWord + '是' + f.date + '，' + f.weekday + '。';
    else if (askWeek) body = dayWord + '是' + f.weekday + '。';
    else if (askDate) body = dayWord + '是' + f.date + '。';
    else body = '现在是' + f.time + '，' + f.weekday + '。';   // 时间用实时，不受 off 影响

    const userTitle = (p && p.userTitle) || '你';
    return '[neutral]' + userTitle + '，' + body;
  }

  // 剥掉情绪/标注标签并定一个情绪。整段文本都会清洗，不只是开头——
  // 小模型常把标签写在中间或换行之后，只认开头就会漏进气泡。
  function parseEmotion(text) {
    const r = stripEmotionTags(text);
    if (r.tagged) return { emo: r.emo, text: r.text, tagged: true };
    return { emo: guessEmotion(r.text), text: r.text, tagged: false };
  }

  // 小模型常常不写标签，这里按关键词兜底猜一个，猜不出就 neutral
  function guessEmotion(text) {
    const t = String(text || '');
    const rules = [
      [/(哈哈|嘿嘿|太好了|不错嘛|搞定|成了|厉害)/, 'joy'],
      [/(抱歉|不好意思|失误|疏忽|是我的问题)/, 'shy'],
      [/(困|累了|休息|睡)/, 'sleepy'],
      [/(？|吗|怎么|为什么|呢)\s*$/, 'curious'],
      [/(注意|小心|建议|先|记得)/, 'focus'],
      [/(别|不行|不建议|拒绝)/, 'serious'],
      [/(啊|哇|居然|竟然)/, 'surprise']
    ];
    for (const [re, emo] of rules) { if (re.test(t)) return emo; }
    return 'neutral';
  }

  // ---------------------------------------------------------------- 流式读取
  // 把 fetch 的响应体按行切出来回调。Ollama 是 NDJSON（每行一个 JSON），
  // OpenAI 兼容接口是 SSE（data: 开头）。两者都能用"按行"处理，只是解析不同。
  async function readLines(resp, onLine, signal) {
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      const text = await resp.text();
      text.split('\n').forEach(onLine);
      return;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      let chunk;
      try { chunk = await reader.read(); }
      catch (e) { if (signal && signal.aborted) return; throw e; }   // 被超时打断：直接收尾
      const { done, value } = chunk;
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine(line);
      }
    }
    if (buf.trim()) onLine(buf);
  }

  // 思考超时看门狗：start() 之后若一直没有首个 token，就 abort 掉请求。
  // 同时支持「用户手动停止」（aborted）：手动停止要干净收尾，不当成错误。
  function AbortGuard(ms) {
    const ctrl = new AbortController();
    let timer = null;
    const g = {
      signal: ctrl.signal,
      fired: false,        // 思考超时触发
      aborted: false,      // 用户手动停止触发
      start() { if (ms > 0) timer = setTimeout(() => { g.fired = true; try { ctrl.abort(); } catch (e) {} }, ms); },
      first() { if (timer) { clearTimeout(timer); timer = null; } },   // 收到第一个片段就撤防
      abort() { g.aborted = true; if (timer) { clearTimeout(timer); timer = null; } try { ctrl.abort(); } catch (e) {} }
    };
    return g;
  }

  async function postJson(url, body, headers, signal) {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: JSON.stringify(body || {}),
        signal: signal
      });
    } catch (e) {
      const raw = (e && e.message) ? e.message : String(e);
      // 网络层失败时 Chromium 只给 "Failed to fetch"，换成能看懂的话
      if (/failed to fetch|networkerror|load failed/i.test(raw)) {
        throw new Error('请求未能送达（目标服务未响应）');
      }
      throw new Error(raw);
    }
    if (!resp.ok) {
      let detail = '';
      try {
        const t = await resp.text();
        try {
          const j = JSON.parse(t);
          detail = j.error || j.message || (j.error && j.error.message) || '';
        } catch (e2) { detail = t; }
      } catch (e2) { /* 忽略 */ }
      throw new Error(detail || ('HTTP ' + resp.status));
    }
    return resp;
  }

  // ---------------------------------------------------------------- 后端基类
  class BaseBackend {
    constructor(kind, cfg) {
      this.kind = kind;
      this.cfg = cfg || {};
      this.history = [];              // [{role:'user'|'assistant', content}]
      this.maxTurns = 16;             // 只保留最近 16 轮，避免小模型上下文爆掉
      this._personaSent = false;
      this.timeoutMs = Number((cfg && cfg.timeoutMs)) || DEFAULT_THINK_MS;
      this._abortFn = null;     // 当前生成进行中时挂上的中断函数，send 结束/出错后清空
    }
    // 手动停止当前这一轮生成。本地/云端由 AbortGuard 中断底层 fetch；
    // WorkBuddy 由桥接层中断 SSE 流。未在进行中时是空操作，不会报错。
    abort() {
      if (typeof this._abortFn === 'function') {
        try { this._abortFn(); } catch (e) { /* 忽略 */ }
      }
    }
    reset() { this.history = []; this._personaSent = false; }
    _push(role, content) {
      this.history.push({ role: role, content: content });
      // system 不计入轮次；其余按 user/assistant 成对裁剪
      const rest = this.history.filter((m) => m.role !== 'system');
      if (rest.length > this.maxTurns * 2) {
        const drop = rest.length - this.maxTurns * 2;
        let removed = 0;
        this.history = this.history.filter((m) => {
          if (m.role === 'system' || removed >= drop) return true;
          removed++; return false;
        });
      }
    }
    _systemMsg() { return { role: 'system', content: buildSystemPrompt(this.cfg.persona) }; }
  }

  // ---------------------------------------------------------------- 本地：Ollama
  class LocalBackend extends BaseBackend {
    constructor(cfg) {
      super('local', cfg);
      const lc = (cfg && cfg.local) || {};
      this.model = lc.model || 'qwen2.5:7b-instruct-q4_K_M';
      this.temperature = (typeof lc.temperature === 'number') ? lc.temperature : 0.8;
      this.numCtx = Number(lc.numCtx) || 8192;
      // keep_alive：模型多久不用的驻留时间。默认 Ollama 是 5 分钟，
      // 到点卸载后下一次提问要重新加载（几秒到几十秒），桌宠会明显卡顿，
      // 所以这里默认拉长到 30m。
      this.keepAlive = lc.keepAlive || '30m';
    }

    // 确保 Ollama 在跑：不在就让主进程拉起一个（随桌宠退出而关闭）。
    // 这是「选中本地才启动」的落点 —— 服务不该开机就常驻占着显存。
    async ensureService(onProgress) {
      const ping = async () => {
        try {
          const r = await fetch('/api/ollama/api/version', { headers: { 'Accept': 'application/json' } });
          return r.ok;
        } catch (e) { return false; }
      };
      if (await ping()) return { ok: true, started: false };
      if (!window.desktopPet || !window.desktopPet.ollamaStart) {
        return { ok: false, message: '当前环境无法自动启动 Ollama，请手动运行 ollama serve' };
      }
      if (onProgress) onProgress('正在启动本地模型服务…');
      const r = await window.desktopPet.ollamaStart();
      if (!r || !r.ok) return { ok: false, message: (r && r.message) || 'Ollama 启动失败' };
      if (!(await ping())) return { ok: false, message: 'Ollama 已启动但暂时连不上' };
      return { ok: true, started: true, elapsedMs: ((r && r.elapsedMs) || 0) / 1000 };
    }

    // 探活 + 确认模型已下载
    async probe(onProgress) {
      const svc = await this.ensureService(onProgress);
      if (!svc.ok) return { ok: false, message: svc.message };
      try {
        const r = await fetch('/api/ollama/api/tags', { headers: { 'Accept': 'application/json' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const names = ((j.models) || []).map((m) => m.name || '');
        const base = this.model.split(':')[0];
        const has = names.some((n) => n === this.model || n.split(':')[0] === base);
        if (!has) {
          // 最常见的坑：服务起来了但模型目录不对（本机模型装在 D:\ollama-models，
          // 默认目录是空的）。把实际目录说出来，省得对着"没找到模型"干瞪眼。
          let dir = '';
          try {
            const st = await window.desktopPet.ollamaStatus();
            dir = (st && st.modelsDir) ? String(st.modelsDir) : '';
          } catch (e) {}
          return {
            ok: false,
            message: 'Ollama 已运行，但没找到模型 ' + this.model +
              (dir ? '（当前模型目录：' + dir + '）' : '') +
              '。请在终端执行：ollama pull ' + this.model
          };
        }
        return {
          ok: true, message: '本地模型就绪（' + this.model + '）',
          started: !!svc.started, elapsedMs: svc.elapsedMs || 0
        };
      } catch (e) {
        return {
          ok: false,
          message: '无法连接 Ollama（' + ((e && e.message) || e) + '）。'
        };
      }
    }

    // 预热：发一个空请求让 Ollama 把模型装进显存。
    // 本地模型第一次推理要加载权重（7B 约 4.7GB），冷启动能到十几秒；
    // 提前预热后，用户真正开口时就是热的。
    async warmup(onProgress) {
      try {
        if (onProgress) onProgress('正在加载本地模型（首次 30~60 秒，之后是毫秒级）…');
        const resp = await postJson('/api/ollama/api/chat', {
          model: this.model,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
          keep_alive: this.keepAlive,
          options: { num_ctx: this.numCtx }
        });
        await resp.text();
        return { ok: true };
      } catch (e) {
        return { ok: false, message: (e && e.message) || String(e) };
      }
    }

    async send(text, handlers) {
      const h = handlers || {};
      const msgs = [this._systemMsg()].concat(this.history, [{ role: 'user', content: text }]);
      this._push('user', text);
      const guard = new AbortGuard(this.timeoutMs);
      this._abortFn = () => guard.abort();   // 允许外界（停止按钮）中断本轮生成
      let acc = '';
      try {
        guard.start();                       // 计时从"发出请求"开始：Ollama 会一直憋到首个 token 才吐头部
        const resp = await postJson('/api/ollama/api/chat', {
          model: this.model,
          messages: msgs,
          stream: true,
          keep_alive: this.keepAlive,
          options: { temperature: this.temperature, num_ctx: this.numCtx }
        }, null, guard.signal);
        await readLines(resp, (line) => {
          guard.first();
          const s = line.trim();
          if (!s) return;
          let j;
          try { j = JSON.parse(s); } catch (e) { return; }
          const piece = (j.message && j.message.content) || '';
          if (piece) {
            acc += piece;
            if (h.onDelta) h.onDelta(piece, acc);
          }
        });
        this._push('assistant', acc);
        if (h.onDone) h.onDone(acc, { stopped: guard.aborted });
      } catch (e) {
        if (guard.aborted) {                      // 用户手动停止：保留已生成的片段，不报错
          this._push('assistant', acc);
          if (h.onDone) h.onDone(acc, { stopped: true });
          return;
        }
        if (guard.fired) {                       // 思考超时：敷衍过去，不让用户干等
          const fb = thinkTimeoutReply(this.cfg.persona);
          this._push('assistant', fb);
          if (h.onDone) h.onDone(fb);
          return;
        }
        if (h.onError) h.onError(e); else throw e;
      } finally {
        this._abortFn = null;
      }
    }
  }

  // ---------------------------------------------------------------- 云端：OpenAI 兼容
  // DeepSeek / OpenAI / 通义千问 / Kimi / 智谱 都提供 /chat/completions 兼容接口，
  // 所以只做一套，用户填 baseUrl + 模型名 + API Key 即可，不绑定任何一家。
  class CloudBackend extends BaseBackend {
    constructor(cfg) {
      super('cloud', cfg);
      const cc = (cfg && cfg.cloud) || {};
      this.baseUrl = (cc.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
      this.model = cc.model || 'deepseek-chat';
      this.apiKey = cc.apiKey || '';
      this.temperature = (typeof cc.temperature === 'number') ? cc.temperature : 0.8;
      this.maxTokens = Number(cc.maxTokens) || 512;
    }

    async probe() {
      if (!this.apiKey) return { ok: false, message: '还没填 API Key' };
      if (!this.baseUrl) return { ok: false, message: '还没填接口地址' };
      return { ok: true, message: '云端接口已配置（' + this.model + '）' };
    }

    async send(text, handlers) {
      const h = handlers || {};
      if (!this.apiKey) {
        const e = new Error('未配置云端 API Key，请在「切换聊天大脑」里填写');
        if (h.onError) return h.onError(e);
        throw e;
      }
      const msgs = [this._systemMsg()].concat(this.history, [{ role: 'user', content: text }]);
      this._push('user', text);
      const guard = new AbortGuard(this.timeoutMs);
      this._abortFn = () => guard.abort();   // 允许外界（停止按钮）中断本轮生成
      let acc = '';
      try {
        guard.start();                       // 计时从"发出请求"开始
        const resp = await postJson('/api/cloud/chat/completions', {
          model: this.model,
          messages: msgs,
          stream: true,
          temperature: this.temperature,
          max_tokens: this.maxTokens
        }, { 'x-target-base': this.baseUrl, 'x-target-key': this.apiKey }, guard.signal);
        await readLines(resp, (line) => {
          guard.first();
          const s = line.trim();
          if (!s || !s.startsWith('data:')) return;
          const payload = s.slice(5).trim();
          if (payload === '[DONE]') return;
          let j;
          try { j = JSON.parse(payload); } catch (e) { return; }
          const ch = j.choices && j.choices[0];
          const piece = (ch && ch.delta && ch.delta.content) || '';
          if (piece) {
            acc += piece;
            if (h.onDelta) h.onDelta(piece, acc);
          }
        });
        this._push('assistant', acc);
        if (h.onDone) h.onDone(acc, { stopped: guard.aborted });
      } catch (e) {
        if (guard.aborted) {                      // 用户手动停止：保留已生成的片段，不报错
          this._push('assistant', acc);
          if (h.onDone) h.onDone(acc, { stopped: true });
          return;
        }
        if (guard.fired) {                       // 思考超时：敷衍过去，不让用户干等
          const fb = thinkTimeoutReply(this.cfg.persona);
          this._push('assistant', fb);
          if (h.onDone) h.onDone(fb);
          return;
        }
        if (h.onError) h.onError(e); else throw e;
      } finally {
        this._abortFn = null;
      }
    }
  }

  // ---------------------------------------------------------------- WorkBuddy（现有 ACP）
  // 复用已验证过的 workbuddy-bridge.js。ACP 没有 system 通道，
  // 所以人设只在会话的第一条消息前置一次（之后靠模型自己维持）。
  class WorkBuddyBackend extends BaseBackend {
    constructor(cfg) {
      super('workbuddy', cfg);
      const wc = (cfg && cfg.workbuddy) || {};
      this.cwd = wc.cwd || '.';
      this.bridge = null;
    }
    _ensure() {
      if (!this.bridge) {
        this.bridge = new window.WorkBuddyBridge('', { cwd: this.cwd });
      }
      return this.bridge;
    }
    async probe() {
      try {
        const b = this._ensure();
        const h = await b.health();
        if (!h.ok) return { ok: false, message: h.message || 'WorkBuddy 本地服务未就绪' };
        return { ok: true, message: 'WorkBuddy ACP 在线（端口 ' + (h.port || '?') + '）' };
      } catch (e) {
        return { ok: false, message: ((e && e.message) || String(e)) };
      }
    }
    async warmup() { return { ok: true }; }
    reset() {
      // ACP 会话重建代价低（上游会话仍在），这里只是丢弃本地历史
      this.history = [];
      this._personaSent = false;
      this.bridge = null;
    }
    async send(text, handlers) {
      const h = handlers || {};
      let full = '';
      let prompt = text;
      if (!this._personaSent) {
        // 人设前置一次即可，之后不再重复，省 token 也不会显得啰嗦
        prompt = '（请在接下来的对话中全程保持以下人设，不要复述这段话，直接正常回复）\n' +
          buildSystemPrompt(this.cfg.persona) + '\n\n' + text;
        this._personaSent = true;
      }
      this._push('user', text);
      const bridge = this._ensure();
      // 允许外界（停止按钮）中断这一轮 SSE 流
      this._abortFn = () => { if (bridge && bridge.abort) bridge.abort(); };
      try {
        await bridge.sendPrompt(prompt, {
          onText: (t) => {
            full += t;
            if (h.onDelta) h.onDelta(t, full);
          },
          onReplay: (active) => { if (h.onReplay) h.onReplay(active); },
          onDone: (meta) => {
            this._push('assistant', full);
            if (h.onDone) h.onDone(full, { stopped: !!(meta && meta.stopped) });
          },
          onError: (e) => { this._abortFn = null; if (h.onError) h.onError(e); else throw e; }
        });
      } finally {
        this._abortFn = null;
      }
    }
  }

  const KINDS = [
    { id: 'local', label: '本地模型', desc: 'Ollama 跑在你自己显卡上 · 断网可用 · 不上传聊天内容' },
    { id: 'cloud', label: '云端接口', desc: '填一个 API Key 即可 · 更聪明 · 需要联网' },
    { id: 'workbuddy', label: 'WorkBuddy', desc: '接回 WorkBuddy 的会话 · 能调用工具与本地文件' }
  ];

  window.ChatBackends = {
    EMOTIONS: EMOTIONS,
    KINDS: KINDS,
    buildSystemPrompt: buildSystemPrompt,
    nowLine: nowLine,
    nowFacts: nowFacts,
    clockReply: clockReply,
    dateDiffReply: dateDiffReply,
    parseEmotion: parseEmotion,
    stripEmotionTags: stripEmotionTags,
    createTagStripper: createTagStripper,
    guessEmotion: guessEmotion,
    create: function (kind, cfg) {
      if (kind === 'local') return new LocalBackend(cfg);
      if (kind === 'workbuddy') return new WorkBuddyBackend(cfg);
      return new CloudBackend(cfg);
    }
  };
})();
