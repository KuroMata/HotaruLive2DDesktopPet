// 验证"参数快照"链路的核心算法：_resolveParamAccessor / _getAllParamIds / _emitDebugParams。
// 本机无窗口、无法实跑 Electron，这里只验证与 live2d-loader.js 中同一份实现的逻辑正确性。
//
// 依据（已核实 node_modules/pixi-live2d-display/types/index.d.ts, v0.4.0）：
//   CubismModel 有 getParameterCount() / getParameterValueByIndex(i) /
//     getParameterMinimumValue(i) / getParameterMaximumValue(i) / getParameterDefaultValue(i) /
//     getModel(): Live2DCubismCore.Model
//   CubismModel 【没有】getParameterIds()，也【没有】getParameterId(index)
//   原生 Model.parameters = { count, ids: Array<string>,
//     minimumValues / maximumValues / defaultValues / values: Float32Array }
'use strict';

// —— 以下为 live2d-loader.js 中实现的等价拷贝（改动实现时须同步）——
function makeLoader(core) {
  return {
    _core() { return core; },
    _getParam(id) {
      const c = this._core();
      try { return (c && typeof c.getParameterValueById === 'function') ? (c.getParameterValueById(id) || 0) : 0; }
      catch (e) { return 0; }
    },
    _paramIdToString(x, i) {
      if (typeof x === 'string') return x;
      if (x == null) return '#' + i;
      try { if (typeof x.getString === 'function') { const s = x.getString(); if (typeof s === 'string') return s; } } catch (e) {}
      if (typeof x.s === 'string') return x.s;
      if (typeof x.id === 'string') return x.id;
      try { const s = String(x); if (s && s !== '[object Object]') return s; } catch (e) {}
      return '#' + i;
    },
    _resolveParamAccessor() {
      const core = this._core();
      if (!core) return null;
      const num = (x, dft) => ((typeof x === 'number' && !isNaN(x)) ? x : dft);
      let raw = null;
      try { if (typeof core.getModel === 'function') raw = core.getModel(); } catch (e) {}
      if (!raw) raw = core._model || null;
      const p = raw && raw.parameters;
      if (p && p.ids && typeof p.ids.length === 'number' && p.ids.length > 0) {
        const ids = [];
        for (let i = 0; i < p.ids.length; i++) ids.push(this._paramIdToString(p.ids[i], i));
        return {
          mode: 'core.getModel().parameters',
          count: ids.length,
          ids: ids,
          read: (i) => ({
            v: num(p.values && p.values[i], 0),
            mn: num(p.minimumValues && p.minimumValues[i], 0),
            mx: num(p.maximumValues && p.maximumValues[i], 1),
            df: num(p.defaultValues && p.defaultValues[i], 0)
          })
        };
      }
      if (typeof core.getParameterCount === 'function') {
        let n = 0;
        try { n = core.getParameterCount() || 0; } catch (e) { n = 0; }
        if (n > 0) {
          const ids = [];
          for (let i = 0; i < n; i++) ids.push('#' + i);
          const call = (fn, i, dft) => {
            if (typeof core[fn] !== 'function') return dft;
            try { return num(core[fn](i), dft); } catch (e) { return dft; }
          };
          return {
            mode: 'CubismModel.getParameterCount+ByIndex',
            count: n,
            ids: ids,
            read: (i) => ({
              v: call('getParameterValueByIndex', i, 0),
              mn: call('getParameterMinimumValue', i, 0),
              mx: call('getParameterMaximumValue', i, 1),
              df: call('getParameterDefaultValue', i, 0)
            })
          };
        }
      }
      if (typeof core.getParameterIds === 'function') {
        try {
          const r = core.getParameterIds();
          if (Array.isArray(r) && r.length) {
            const ids = r.map((x, i) => this._paramIdToString(x, i));
            return { mode: 'getParameterIds', count: ids.length, ids: ids,
              read: (i) => ({ v: this._getParam(ids[i]), mn: 0, mx: 1, df: 0 }) };
          }
        } catch (e) {}
      }
      return null;
    },
    _getAllParamIds() {
      const acc = this._resolveParamAccessor();
      return (acc && acc.ids) ? acc.ids.slice() : [];
    },
    _dbgSeq: 0, _dbgWarned: false,
    _emitDebugParams() {
      this._dbgSeq = (this._dbgSeq || 0) + 1;
      const snapshot = { open: true, t: 1, seq: this._dbgSeq };
      const acc = this._resolveParamAccessor();
      if (!acc) {
        snapshot.mode = 'none';
        snapshot.rows = [];
        snapshot.err = this._core()
          ? '已取得 coreModel，但解析不到任何参数接口（无 getModel().parameters，也无 getParameterCount）'
          : 'coreModel 尚不可用（模型未加载完成 / 加载失败）';
      } else {
        const rows = [];
        for (let i = 0; i < acc.count; i++) {
          const s = acc.read(i);
          rows.push({ id: acc.ids[i], v: s.v, mn: s.mn, mx: s.mx, d: s.df });
        }
        snapshot.mode = acc.mode;
        snapshot.rows = rows;
        snapshot.err = '';
      }
      if (window.desktopPet && window.desktopPet.send) window.desktopPet.send('pet:debugParams', snapshot);
      return snapshot;
    }
  };
}

let fail = 0;
function assert(name, cond) {
  if (!cond) { fail++; console.log('  FAIL: ' + name); } else { console.log('  ok  : ' + name); }
}

const IDS = ['ParamA', 'ParamI', 'ParamU', 'ParamE', 'ParamO', 'ParamMouthOpenY', 'ParamAngleX', 'ParamBreath', 'Silence'];
const VALS = [0.9, 0.1, 0.2, 0.3, 0.4, 0.75, 12.5, 0.5, 1];
function f32(a) { return Float32Array.from(a); }

// 捕获渲染进程发出的快照
let sent = [];
globalThis.window = { desktopPet: { send(ch, payload) { sent.push({ ch: ch, payload: payload }); } } };

// 1) 真实主路径：CubismModel 带 getModel() -> 原生 Model.parameters
console.log('[case1] CubismModel.getModel().parameters（真实主路径）');
const rawModel = {
  parameters: {
    count: IDS.length,
    ids: IDS,
    values: f32(VALS),
    minimumValues: f32(IDS.map(() => 0)),
    maximumValues: f32(IDS.map((x) => (x === 'ParamAngleX' ? 30 : 1))),
    defaultValues: f32(IDS.map(() => 0))
  }
};
const core1 = {
  setParameterValueById() {}, getParameterValueById(id) { return 0; },
  getParameterCount() { return IDS.length; },
  getParameterValueByIndex() { return 0; },
  getModel() { return rawModel; }
};
const L1 = makeLoader(core1);
const acc1 = L1._resolveParamAccessor();
assert('解析到访问器', !!acc1);
assert('mode=core.getModel().parameters', acc1 && acc1.mode === 'core.getModel().parameters');
assert('数量=' + IDS.length, acc1 && acc1.count === IDS.length);
assert('参数名正确（模型顺序）', acc1 && acc1.ids.join(',') === IDS.join(','));
assert('_getAllParamIds 同源', L1._getAllParamIds().join(',') === IDS.join(','));
const s1 = acc1.read(0);
// 注意：真实值来自 Float32Array，0.9 存进去是 0.8999999761581421，断言必须带容差
assert('read(0).v ≈ 0.9（取到 values，float32 精度）', Math.abs(s1.v - 0.9) < 1e-6);
const s6 = acc1.read(6);
assert('read(6).mx = 30（按索引取到 maximumValues）', s6.mx === 30);
assert('read(6).v = 12.5', s6.v === 12.5);
sent = [];
const snap1 = L1._emitDebugParams();
assert('发出了 1 条快照', sent.length === 1 && sent[0].ch === 'pet:debugParams');
assert('快照 rows 数量=' + IDS.length, snap1.rows.length === IDS.length);
assert('快照含 Silence 且 v=1', snap1.rows.some((r) => r.id === 'Silence' && r.v === 1));
assert('每行都带 d（默认值，供 Viewer 刻度）', snap1.rows.every((r) => typeof r.d === 'number'));
assert('无 err', snap1.err === '');

// 2) parameters.ids 是 CubismId 式对象 -> 解包成字符串
console.log('[case2] ids 为 CubismId 式对象（getString 解包）');
const rawObj = { parameters: { count: 2, ids: [{ getString() { return 'ParamA'; } }, { getString() { return 'Silence'; } }],
  values: f32([0.5, 1]), minimumValues: f32([0, 0]), maximumValues: f32([1, 1]), defaultValues: f32([0, 1]) } };
const L2 = makeLoader({ getModel() { return rawObj; } });
assert('解包为字符串', L2._getAllParamIds().join(',') === 'ParamA,Silence');

// 3) 无 getModel，仅有按索引接口 -> 序号占位，但值仍可读，且入参必须是索引(数字)
console.log('[case3] 仅按索引接口（无 getModel）');
let minArgType = null, minArg = null;
const core3 = {
  getParameterCount() { return 3; },
  getParameterValueByIndex(i) { return 0.1 * (i + 1); },
  getParameterMinimumValue(i) { minArgType = typeof i; minArg = i; return 0; },
  getParameterMaximumValue() { return 1; },
  getParameterDefaultValue() { return 0; }
};
const L3 = makeLoader(core3);
const acc3 = L3._resolveParamAccessor();
assert('mode=ByIndex', acc3 && acc3.mode === 'CubismModel.getParameterCount+ByIndex');
assert('占位名 #0,#1,#2', L3._getAllParamIds().join(',') === '#0,#1,#2');
const s3 = acc3.read(2);
assert('read(2).v ≈ 0.3（0.1*3 浮点误差内）', Math.abs(s3.v - 0.3) < 1e-6);
assert('minimumValue 入参是索引(数字)', minArgType === 'number' && minArg === 2);
const snap3 = L3._emitDebugParams();
assert('仍能产出 3 行', snap3.rows.length === 3);

// 4) 全都不可用：core 存在但无任何参数接口 -> 不静默，发带 err 的空快照
console.log('[case4] core 存在但无参数接口 -> 发 err 快照（不静默）');
const L4 = makeLoader({ setParameterValueById() {}, getParameterValueById() { return 0; } });
assert('访问器为空', L4._resolveParamAccessor() === null);
assert('ids 为空', L4._getAllParamIds().length === 0);
const snap4 = L4._emitDebugParams();
assert('仍发出快照（面板可显示原因）', snap4.open === true && Array.isArray(snap4.rows) && snap4.rows.length === 0);
assert('err 说明"解析不到参数接口"', /解析不到任何参数接口/.test(snap4.err));

// 5) core 不存在（模型未加载完）-> 明确报"未加载完成"
console.log('[case5] core 不存在 -> 报模型未加载');
const snap5 = makeLoader(null)._emitDebugParams();
assert('err 说明模型未加载完成', /coreModel 尚不可用/.test(snap5.err));

// 6) getModel() 抛异常时不崩，走次选
console.log('[case6] getModel 抛异常 -> 安全降级');
const L6 = makeLoader({ getModel() { throw new Error('boom'); }, getParameterCount() { return 2; },
  getParameterValueByIndex() { return 0; }, getParameterMinimumValue() { return 0; },
  getParameterMaximumValue() { return 1; }, getParameterDefaultValue() { return 0; } });
const acc6 = L6._resolveParamAccessor();
assert('降级到 ByIndex 而非崩溃', acc6 && acc6.mode === 'CubismModel.getParameterCount+ByIndex');

// 7) _getAllParamIds 返回副本，外部修改不污染内部
console.log('[case7] 返回副本');
const a = L1._getAllParamIds(); a.push('HACK');
assert('不污染内部列表', L1._getAllParamIds().length === IDS.length);

console.log(fail === 0 ? '\nALL_OK' : '\nFAIL=' + fail);
process.exit(fail === 0 ? 0 : 1);
