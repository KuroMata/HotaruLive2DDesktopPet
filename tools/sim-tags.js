// 情绪标签清洗自检：把 chat-backends.js 真跑起来，按"流式分片"喂进去，
// 复刻 app.js 的用法（逐片 push → 结束 flush），断言气泡里不残留任何标签。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..');
const win = {};
const ctx = { window: win, console, fetch: () => {}, setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number, RegExp, Error, Promise };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'app/js/chat-backends.js'), 'utf8'), ctx, { filename: 'chat-backends.js' });
const CB = win.ChatBackends;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  ->  ' + JSON.stringify(got) + (ok ? '' : '   期望 ' + JSON.stringify(want)));
}

// 用给定的分片跑一遍流式清洗，返回最终文本 + 情绪
function stream(chunks) {
  const st = CB.createTagStripper();
  let text = '';
  let emo = null, tagged = false;
  for (const c of chunks) {
    const out = st.push(c);
    if (out) text += out;
    const s = st.state();
    if (s.tagged) { emo = s.emo; tagged = true; }
  }
  const t = st.flush();
  if (t.text) text += t.text;
  return { text: text, emo: t.tagged ? t.emo : emo, tagged: t.tagged || tagged };
}

console.log('--- 1. 标签被切成多片（[ + sle + epy + ]）---');
let r = stream(['[', 'sle', 'epy', ']', ' 好困啊…']);
check('正文', r.text, '好困啊…');
check('情绪', r.emo, 'sleepy');

console.log('\n--- 2. 标签前多了换行/空格（旧代码会漏出的场景）---');
r = stream(['\n', '[sleepy]', ' 我有点撑不住了']);
check('正文', r.text, '我有点撑不住了');
check('情绪', r.emo, 'sleepy');

console.log('\n--- 3. 标签整片到达且前面有空白（旧代码必定漏出）---');
r = stream([' ', '[sleepy] ', '困了']);
check('正文', r.text, '困了');

console.log('\n--- 4. 标签夹在句子中间 ---');
r = stream(['好的，[', 'sleepy', ']我这就去干']);
check('正文', r.text, '好的，我这就去干');
check('情绪', r.emo, 'sleepy');
// 标签两侧本来就各有一个逗号时，剥掉标签后留下的双逗号是原文，不该被改写
r = stream(['好的', '，[', 'sleepy', ']，我这就去干']);
check('正文(原文双逗号)', r.text, '好的，，我这就去干');

console.log('\n--- 5. 一口气写好几枚标签 ---');
r = stream(['[joy]行吧[sleepy]那我先躺会儿']);
check('正文', r.text, '行吧那我先躺会儿');
check('情绪', r.emo, 'joy');

console.log('\n--- 6. 中文标注 + 全角方括号 ---');
r = stream(['【疲惫】', '再撑一会儿']);
check('正文', r.text, '再撑一会儿');
r = stream(['[叹气]', '随你吧']);
check('正文(中文标注)', r.text, '随你吧');
r = stream(['【sleepy】走吧']);
check('正文(全角情绪)', r.text, '走吧');
check('情绪(全角)', r.emo, 'sleepy');

console.log('\n--- 7. 正文里的方括号不能被吃掉 ---');
check('a[0]', stream(['数组 a[0] 和 a[i] 都行']).text, '数组 a[0] 和 a[i] 都行');
check('[1,2]', stream(['区间 [1,2] 是闭区间']).text, '区间 [1,2] 是闭区间');
check('长中文强调', stream(['这属于[非常重要的内容]级别']).text, '这属于[非常重要的内容]级别');
check('含空格', stream(['标签形如 [sleepy joy] 这种']).text, '标签形如 [sleepy joy] 这种');

console.log('\n--- 8. 无标签：正常文字原样通过；情绪由上层用关键词兜底 ---');
r = stream(['哈哈，搞定了！']);
check('正文', r.text, '哈哈，搞定了！');
check('清洗器不猜情绪(交给 guessEmotion)', r.emo, null);
check('tagged', r.tagged, false);
check('guessEmotion 兜底', CB.guessEmotion('哈哈，搞定了！'), 'joy');
check('parseEmotion 兜底', CB.parseEmotion('哈哈，搞定了！').emo, 'joy');

console.log('\n--- 8.5 标签后跟衔接符（： ，）不能留在开头 ---');
r = stream(['[sleepy]：', '好困啊']);
check('冒号', r.text, '好困啊');
r = stream(['[joy]，博士，成了']);
check('逗号', r.text, '博士，成了');
r = stream(['[neutral]\n', '  我在呢']);
check('空行+缩进', r.text, '我在呢');

console.log('\n--- 9. 被"停止"截断：半截标签丢掉，不留碎片 ---');
r = stream(['[', 'sle']);
check('正文', r.text, '');
r = stream(['我看看', '[', 'sle']);
check('正文(前面有正文)', r.text, '我看看');

console.log('\n--- 10. 跨片段的正文里未闭合的 [ 不能丢字 ---');
r = stream(['看这个 [', '重要内容] 很关键']);
check('正文', r.text, '看这个 [重要内容] 很关键');

console.log('\n--- 11. parseEmotion（非流式路径）---');
check('parseEmotion 正文', CB.parseEmotion('[joy]博士，办妥了。').text, '博士，办妥了。');
check('parseEmotion 情绪', CB.parseEmotion('[joy]博士，办妥了。').emo, 'joy');
check('parseEmotion 中文标注', CB.parseEmotion('[叹气]算了。').text, '算了。');
check('parseEmotion 中途标签', CB.parseEmotion('好的[shy]，我马上去。').text, '好的，我马上去。');
check('parseEmotion 无标签', CB.parseEmotion('随便啦').text, '随便啦');
check('stripEmotionTags', CB.stripEmotionTags('【sleepy】困').text, '困');

console.log('\n--- 12. 钟表/节日快通道的 [neutral] 前缀仍被剥掉 ---');
check('快通道', CB.parseEmotion('[neutral]博士，现在是 08:30。').text, '博士，现在是 08:30。');

console.log('\n合计：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
