/**
 * 核心计算测试 —— 覆盖需求文档中的定价规则、成本计算、物流计价、占比汇总与异常处理。
 *
 * 运行：node tests/run-tests.js
 * 断言全部基于随包发布的数据实时推导，不写死金额，
 * 因此同一套用例对「真实数据」与「公开脱敏样例数据」都成立。
 */
'use strict';
var path = require('path');
var fs = require('fs');

/* ---------- 载入真实数据与计算内核 ---------- */
require('../data/spu.data.js');
require('../data/logistics.data.js');
require('../src/core/errors.js');
require('../src/core/money.js');
require('../src/core/pricing.js');
require('../src/core/costs.js');
require('../src/core/logistics.js');
require('../src/core/mix.js');
require('../src/core/calculator.js');
require('../src/data/product-source.js');
require('../src/data/logistics-source.js');
require('../src/data/local-adapter.js');
require('../config/pricing.config.js');
require('../src/ui/state.js');

var Core = globalThis.Core;
var Pricing = Core.Pricing;
var Logistics = Core.Logistics;
var Calculator = Core.Calculator;
var Money = Core.Money;

var CH_ELEC = '云途全球专线挂号（特惠带电）';
var CH_GENERAL = '云途全球专线挂号（特惠普货）';
var CH_MID = '云途中包专线挂号(特惠普货)';   // 尺寸超限 → 中包专线
var CH_SENS = '极通环球专线-标准定制敏感';   // 敏感 → 敏感专线

/* ---------- 迷你测试框架 ---------- */
var results = [];
var pending = [];
var currentGroup = '';
var failures = 0;

function group(name) { currentGroup = name; }
function test(name, fn) { pending.push({ group: currentGroup, name: name, fn: fn }); }
function record(r, okFlag, msg) {
  results.push({ group: r.group, name: r.name, ok: okFlag, msg: msg || '' });
  if (!okFlag) failures++;
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error((msg || '断言失败') + ' | 期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}
function near(actual, expected, tol, msg) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > (tol === undefined ? 1e-6 : tol)) {
    throw new Error((msg || '数值断言失败') + ' | 期望 ' + expected + '，实际 ' + actual);
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function hasError(err, field) {
  ok(err, '应返回错误但得到 null');
  if (field) eq(err.field, field, '错误字段不符');
  ok(!!err.message, '错误缺少可读说明');
  return err;
}

/* ---------- 真实数据装配 ---------- */
var rateRows = globalThis.LOGISTICS_DATA.map(function (r) {
  return {
    business: r.business, channel: r.channel, country: r.country,
    minWeight: r.minWeight, maxWeight: r.maxWeight,
    heavyPrice: r.heavyPrice, piecePrice: r.piecePrice, effectiveDate: r.effectiveDate
  };
});
var card = Logistics.buildRateCard(rateRows);
ok(card.ok, '价目表构建失败');
var RATE = card.value;

var productSource = Core.Data.createProductSource(Core.Data.localProductAdapter);
var logisticsSource = Core.Data.createLogisticsSource(Core.Data.localLogisticsAdapter);

function tier(qty, rate, opts) {
  var o = opts || {};
  return {
    qty: qty,
    discountRate: rate,
    priceMode: o.priceMode || Pricing.PRICE_MODE.AUTO,
    manualSalePrice: o.manualSalePrice === undefined ? null : o.manualSalePrice,
    mixPercent: o.mixPercent === undefined ? '' : o.mixPercent
  };
}

function baseInput(overrides) {
  var input = {
    product: {
      name: '葡萄酒伴侣瓶', spu: 'KD00181', source: 'spu',
      purchasePrice: 30, purchaseCurrency: 'CNY', weightG: 350, elec: false
    },
    unitSalePrice: 19.99,
    baseDiscountRate: 0.5,
    tiers: [tier(1, 0.5), tier(2, 0.5), tier(3, 0.6), tier(4, 0.65)],
    logistics: { channel: CH_ELEC, country: '美国' },
    rateCard: RATE,
    adCost: null,
    saleCurrency: 'USD',
    fx: { CNY: 1, USD: 6.8 }
  };
  Object.keys(overrides || {}).forEach(function (k) { input[k] = overrides[k]; });
  return input;
}

function r2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }

/* ============================================================
   §5.2 默认定价规则
   ============================================================ */
group('§5.2 默认定价规则');

test('需求文档示例：单件售价 19.99 时 1~4 件套餐原价与默认售价', function () {
  // raw = 按公式的原始精度（计算过程不提前四舍五入）；show = 需求文档表格中的两位小数值
  var expect = [
    { qty: 1, rate: 0.5, original: 39.98, raw: 19.99, show: 19.99 },
    { qty: 2, rate: 0.5, original: 79.96, raw: 39.98, show: 39.98 },
    { qty: 3, rate: 0.6, original: 119.94, raw: 71.964, show: 71.96 },
    { qty: 4, rate: 0.65, original: 159.92, raw: 103.948, show: 103.95 }
  ];
  var sc = Calculator.calculate(baseInput());
  ok(sc.ok, '测算应成功: ' + JSON.stringify(sc.errors));
  sc.tiers.forEach(function (r, i) {
    var e = expect[i];
    eq(r.qty, e.qty, '套餐数量');
    near(r.unitOriginalPrice, e.original / e.qty, 1e-9, '单件原价');
    near(r.originalPrice, e.original, 1e-9, e.qty + ' 件套餐原价');
    near(r.discountRate, e.rate, 1e-9, '折扣率');
    near(r.defaultSalePrice, e.raw, 1e-9, e.qty + ' 件默认售价（原始精度）');
    eq(r2(r.defaultSalePrice), e.show, e.qty + ' 件默认售价（两位小数展示）');
  });
});

test('单件折扣率可配置：改为 40% 后单件原价 = 售价 ÷ 0.4', function () {
  var sc = Calculator.calculate(baseInput({ baseDiscountRate: 0.4 }));
  near(sc.tiers[0].unitOriginalPrice, 19.99 / 0.4, 1e-9, '单件原价');
});

test('折扣率非法（0% / 120%）时报错，不静默按 0 计算', function () {
  var sc = Calculator.calculate(baseInput({ tiers: [tier(1, 0), tier(2, 1.2)] }));
  ok(!sc.ok, '应存在错误');
  ok(sc.tiers[0].errors.length > 0, '1 件档应报错');
  eq(sc.tiers[0].defaultSalePrice, null, '非法折扣率不应产出售价');
  eq(sc.tiers[0].finalSalePrice, null, '非法折扣率不应产出最终售价');
});

test('套餐数量不合法（0 / 1.5）时报错', function () {
  var sc = Calculator.calculate(baseInput({ tiers: [tier(0, 0.5), tier(1.5, 0.5)] }));
  ok(!sc.ok, '应存在错误');
  eq(sc.tiers[0].finalSalePrice, null, '0 件不应产出售价');
  eq(sc.tiers[1].finalSalePrice, null, '1.5 件不应产出售价');
});

test('套餐数量不被写死为 1~4：5 件套餐可正常计算', function () {
  var sc = Calculator.calculate(baseInput({ tiers: [tier(5, 0.7)] }));
  ok(sc.ok, '5 件套餐应可计算');
  near(sc.tiers[0].purchaseCNY, 150, 1e-9, '5 件采购成本');
  near(sc.tiers[0].weightKg, 1.75, 1e-9, '5 件重量');
});

/* ============================================================
   §5.3 套餐售价支持独立修改
   ============================================================ */
group('§5.3 手动售价覆盖');

test('手动改价后该套餐标记为手动，其余套餐保持自动', function () {
  var sc = Calculator.calculate(baseInput({
    tiers: [tier(1, 0.5), tier(2, 0.5, { priceMode: 'manual', manualSalePrice: 35 })]
  }));
  eq(sc.tiers[0].priceMode, 'auto', '1 件应为自动');
  eq(sc.tiers[1].priceMode, 'manual', '2 件应为手动');
  near(sc.tiers[1].finalSalePrice, 35, 1e-9, '2 件最终售价应为手动值');
  near(sc.tiers[1].defaultSalePrice, 39.98, 1e-9, '2 件默认售价仍应算出以供对照');
});

test('修改单件售价后：自动套餐重算，手动套餐保持不变', function () {
  var tiers = [tier(1, 0.5), tier(2, 0.5, { priceMode: 'manual', manualSalePrice: 35 })];
  var sc = Calculator.calculate(baseInput({ unitSalePrice: 24.99, tiers: tiers }));
  near(sc.tiers[0].finalSalePrice, 24.99, 1e-9, '自动套餐应随单件售价更新');
  near(sc.tiers[1].finalSalePrice, 35, 1e-9, '手动套餐不应被覆盖');
});

test('恢复自动后按当前单件售价与折扣规则重新计算', function () {
  var sc = Calculator.calculate(baseInput({
    unitSalePrice: 24.99,
    tiers: [tier(2, 0.5, { priceMode: 'auto', manualSalePrice: null })]
  }));
  near(sc.tiers[0].finalSalePrice, 49.98, 1e-9, '恢复自动后应 = 24.99 ÷ 0.5 × 2 × 0.5');
  eq(sc.tiers[0].priceMode, 'auto', '应为自动状态');
});

test('手动售价非法（≤ 0）时报错且不产出最终售价', function () {
  var sc = Calculator.calculate(baseInput({
    tiers: [tier(1, 0.5, { priceMode: 'manual', manualSalePrice: 0 })]
  }));
  ok(!sc.ok, '应存在错误');
  eq(sc.tiers[0].finalSalePrice, null, '非法手动售价不应产出结果');
});

/* ============================================================
   §6.1 / §6.4 采购成本与总成本
   ============================================================ */
group('§6 成本计算');

test('采购成本 = 单件采购成本 × 套餐数量', function () {
  var sc = Calculator.calculate(baseInput());
  near(sc.tiers[0].purchaseCNY, 30, 1e-9, '1 件采购成本');
  near(sc.tiers[1].purchaseCNY, 60, 1e-9, '2 件采购成本');
  near(sc.tiers[3].purchaseCNY, 120, 1e-9, '4 件采购成本');
});

test('套餐重量 = 单件重量 × 数量，并换算为 kg', function () {
  var sc = Calculator.calculate(baseInput());
  near(sc.tiers[0].weightG, 350, 1e-9, '1 件重量(g)');
  near(sc.tiers[0].weightKg, 0.35, 1e-9, '1 件重量(kg)');
  near(sc.tiers[3].weightG, 1400, 1e-9, '4 件重量(g)');
  near(sc.tiers[3].weightKg, 1.4, 1e-9, '4 件重量(kg)');
});

test('商品重量缺失时明确报错，绝不用 0 代替', function () {
  var sc = Calculator.calculate(baseInput({
    product: { name: 'x', spu: 'X', source: 'manual', purchasePrice: 30, purchaseCurrency: 'CNY', weightG: null }
  }));
  ok(!sc.ok, '应存在错误');
  var err = sc.tiers[0].errors.filter(function (e) { return e.field === 'weight'; })[0];
  hasError(err, 'weight');
  eq(sc.tiers[0].totalCNY, null, '缺重量时总成本不可计算');
  eq(sc.tiers[0].freightCNY, null, '缺重量时运费不可计算');
});

test('采购价为 0 时明确报错，不把 0 当作已确认成本', function () {
  var sc = Calculator.calculate(baseInput({
    product: { name: '电子食谱', spu: 'KD00180', source: 'spu', purchasePrice: 0, purchaseCurrency: 'CNY', weightG: 350 }
  }));
  ok(!sc.ok, '应存在错误');
  var err = sc.tiers[0].errors.filter(function (e) { return e.field === 'purchasePrice'; })[0];
  hasError(err, 'purchasePrice');
  eq(sc.tiers[0].totalCNY, null, '采购成本缺失时总成本不可计算');
});

test('套餐总成本 = 采购成本 + 物流成本（未填广告成本时）', function () {
  var sc = Calculator.calculate(baseInput());
  near(sc.tiers[0].totalCNY, 30 + sc.tiers[0].freightCNY, 1e-9, '1 件总成本');
  near(sc.tiers[3].totalCNY, 120 + sc.tiers[3].freightCNY, 1e-9, '4 件总成本');
  eq(sc.tiers[0].adIncluded, false, '未填广告成本时不应计入');
});

/* ============================================================
   §6.2 物流成本
   ============================================================ */
group('§6.2 物流计价');

test('运费 = 件价 × 件数 + 计重单价 × 总重（与人工计算样例核对）', function () {
  // KD00181 葡萄酒伴侣瓶 350g，带电渠道 / 美国；重量段语义为左开右闭 (min, max]
  // 期望值不写死：从价目表取出命中重量段的件价 / 计重单价，再人工重算一遍
  var cases = [
    { qty: 1, kg: 0.35 },
    { qty: 2, kg: 0.70 },
    { qty: 3, kg: 1.05 },
    { qty: 4, kg: 1.40 }
  ];
  var bands = Logistics.getBands(RATE, CH_ELEC, '美国');
  var sc = Calculator.calculate(baseInput());
  sc.tiers.forEach(function (r, i) {
    var e = cases[i];
    near(r.weightKg, e.kg, 1e-9, e.qty + ' 件重量');
    var hit = Logistics.findBand(bands, e.kg);
    ok(hit.ok, e.qty + ' 件应命中重量段');
    var manual = hit.band.piecePrice * e.qty + hit.band.heavyPrice * e.kg;
    near(r.freightCNY, manual, 1e-6, e.qty + ' 件运费人工核对');
    eq(r2(r.freightCNY), r2(manual), e.qty + ' 件运费（两位小数）');
  });
});

test('重量段边界：0.70 kg 落在 (0.45, 0.7] 段（左开右闭，含上界）', function () {
  var bands = Logistics.getBands(RATE, CH_ELEC, '美国');
  var found = Logistics.findBand(bands, 0.7);
  ok(found.ok, '应命中重量段');
  eq(found.band.minWeight, 0.45, '命中段下界');
  eq(found.band.maxWeight, 0.7, '命中段上界');
});

test('重量段语义为左开右闭 (min, max]：200 g 命中 (0.1, 0.2] 区间', function () {
  var bands = Logistics.getBands(RATE, CH_GENERAL, '美国');
  var found = Logistics.findBand(bands, 0.2);
  ok(found.ok, '200 g 应命中重量段');
  eq(found.band.minWeight, 0.1, '命中段下界应为 0.1');
  eq(found.band.maxWeight, 0.2, '命中段上界应为 0.2');
  ok(found.band.piecePrice > 0, '(0.1, 0.2] 段应有件价');
  ok(found.band.heavyPrice > 0, '(0.1, 0.2] 段应有计重单价');
  // 200 g 的运费构成应等于该段件价 + 计重单价 × 0.2
  var res200 = Logistics.calculate(RATE, { channel: CH_GENERAL, country: '美国', weightKg: 0.2, qty: 1 });
  ok(res200.ok, '200 g 应可计算运费');
  eq(res200.breakdown.pieceSubtotalCNY, found.band.piecePrice, '200 g 件价小计');
  near(res200.breakdown.weightSubtotalCNY, found.band.heavyPrice * 0.2, 1e-9, '200 g 计重小计');
  // 段内其余取值同样命中该段
  ok(Logistics.findBand(bands, 0.1001).ok, '0.1001 kg 应命中');
  ok(Logistics.findBand(bands, 0.15).ok, '0.15 kg 应命中');
  // 恰好等于下界时落到下一段（(0.2, 0.3]）
  var next = Logistics.findBand(bands, 0.2001);
  ok(next.ok && next.band.minWeight === 0.2, '0.2001 kg 应落到 (0.2, 0.3]');
});

test('重量低于最小计费段时明确提示（敏感专线 / 美国 最小 0.05 kg）', function () {
  var res = Logistics.calculate(RATE, { channel: CH_SENS, country: '美国', weightKg: 0.03, qty: 1 });
  ok(!res.ok, '应计算失败');
  hasError(res.error, 'weight');
  ok(res.error.message.indexOf('最小计费重量') >= 0, '提示应指明最小计费重量: ' + res.error.message);
});

test('不同渠道按各自规则计费：带电 vs 普货 在同一重量段价格不同', function () {
  var a = Calculator.calculate(baseInput({ logistics: { channel: CH_ELEC, country: '美国' } }));
  var b = Calculator.calculate(baseInput({ logistics: { channel: CH_GENERAL, country: '美国' } }));
  ok(a.ok && b.ok, '两个渠道都应可计算');
  ok(a.tiers[1].freightCNY !== b.tiers[1].freightCNY, '两渠道运费应不同');
  // 普货 2 件 0.7kg：按普货自身命中的重量段人工重算
  var hit = Logistics.findBand(Logistics.getBands(RATE, CH_GENERAL, '美国'), 0.7);
  ok(hit.ok, '普货 0.7kg 应命中重量段');
  near(b.tiers[1].freightCNY, hit.band.piecePrice * 2 + hit.band.heavyPrice * 0.7, 1e-6, '普货 2 件运费');
});

test('重量落在规则空档时提示「空档」并拒绝出数（阿联酋 2.005 kg）', function () {
  // 阿联酋带电分段为 (0, 2] / (2.01, 5] / (5.01, 10]，2.005 kg 落在空档
  var res = Logistics.calculate(RATE, { channel: CH_ELEC, country: '阿联酋', weightKg: 2.005, qty: 1 });
  ok(!res.ok, '应计算失败');
  hasError(res.error, 'weight');
  ok(res.error.message.indexOf('空档') >= 0, '提示应指明规则空档: ' + res.error.message);
});

test('超出承运上限时明确提示（美国上限 30 kg）', function () {
  var res = Logistics.calculate(RATE, { channel: CH_ELEC, country: '美国', weightKg: 31, qty: 1 });
  ok(!res.ok, '应计算失败');
  hasError(res.error, 'weight');
  ok(res.error.message.indexOf('承运上限') >= 0, '提示应指明承运上限: ' + res.error.message);
});

test('渠道不支持该目的地时明确提示「不支持」', function () {
  var res = Logistics.calculate(RATE, { channel: CH_ELEC, country: '不存在的国家', weightKg: 1, qty: 1 });
  ok(!res.ok, '应计算失败');
  hasError(res.error, 'country');
  ok(res.error.message.indexOf('不支持') >= 0, '提示应指明不支持: ' + res.error.message);
});

test('缺少重量时不计算运费', function () {
  var res = Logistics.calculate(RATE, { channel: CH_ELEC, country: '美国', weightKg: null, qty: 1 });
  ok(!res.ok, '应计算失败');
  hasError(res.error, 'weight');
});

test('计算结果可追溯：trace 含渠道、重量段、件价与计重单价', function () {
  var res = Logistics.calculate(RATE, { channel: CH_ELEC, country: '美国', weightKg: 1.2, qty: 2 });
  ok(res.ok, '应计算成功');
  ok(res.trace.indexOf(CH_ELEC) >= 0, 'trace 应含渠道');
  ok(res.trace.indexOf('美国') >= 0, 'trace 应含目的地');
  ok(res.trace.indexOf('(0.7, 2]') >= 0, 'trace 应含命中重量段: ' + res.trace);
  ok(res.trace.indexOf('件价') >= 0 && res.trace.indexOf('计重') >= 0, 'trace 应含计价构成');
  var hit = Logistics.findBand(Logistics.getBands(RATE, CH_ELEC, '美国'), 1.2);
  ok(hit.ok, '1.2kg 应命中重量段');
  eq(res.breakdown.pieceSubtotalCNY, hit.band.piecePrice * 2, '件价小计');
  near(res.breakdown.weightSubtotalCNY, hit.band.heavyPrice * 1.2, 1e-9, '计重小计');
});

test('物流数据源接口可返回渠道 / 国家 / 规则（未来 API 可平替）', function () {
  return logisticsSource.listChannels().then(function (chs) {
    eq(chs.length, 4, '随包物流数据应包含 4 个渠道');
    var names = chs.map(function (c) { return c.name; });
    [CH_ELEC, CH_GENERAL, CH_MID, CH_SENS].forEach(function (n) {
      ok(names.indexOf(n) >= 0, '渠道缺失: ' + n);
    });
    return logisticsSource.listCountries(CH_ELEC);
  }).then(function (cs) {
    ok(cs.length > 50, '带电渠道国家数应 > 50');
    return logisticsSource.getRules(CH_ELEC, '美国');
  }).then(function (rules) {
    ok(rules.length === 7, '美国带电应有 7 个重量段，实际 ' + rules.length);
  });
});

test('随包物流数据：4 个渠道共 446 条重量段规则', function () {
  eq(globalThis.LOGISTICS_DATA.length, 446, '重量段规则总条数');
  var byCh = {};
  globalThis.LOGISTICS_DATA.forEach(function (r) { byCh[r.channel] = (byCh[r.channel] || 0) + 1; });
  eq(byCh[CH_ELEC], 210, '特惠带电条数');
  eq(byCh[CH_GENERAL], 178, '特惠普货条数');
  eq(byCh[CH_MID], 45, '中包专线条数');
  eq(byCh[CH_SENS], 13, '敏感专线条数');
});

/* ============================================================
   §6.3 广告成本
   ============================================================ */
group('§6.3 广告成本');

test('不填写广告成本时不计入总成本', function () {
  var sc = Calculator.calculate(baseInput({ adCost: null }));
  eq(sc.tiers[0].adCNY, null, '广告成本应为空');
  eq(sc.tiers[0].adProvided, false, '不应标记为已提供');
  near(sc.tiers[0].totalCNY, 30 + sc.tiers[0].freightCNY, 1e-9, '总成本不含广告');
});

test('填写广告成本后所有套餐总成本增加同一金额（不随件数变化）', function () {
  var sc = Calculator.calculate(baseInput({ adCost: 3 }));
  var delta = sc.tiers.map(function (r) { return r.totalCNY - (r.purchaseCNY + r.freightCNY); });
  near(delta[0], 3 * 6.8, 1e-9, '1 件增加额');
  near(delta[1], 3 * 6.8, 1e-9, '2 件增加额');
  near(delta[3], 3 * 6.8, 1e-9, '4 件增加额');
  eq(sc.tiers[0].adProvided, true, '应标记为已提供');
});

test('修改广告成本后总成本实时变化', function () {
  var a = Calculator.calculate(baseInput({ adCost: 3 }));
  var b = Calculator.calculate(baseInput({ adCost: 5 }));
  near(b.tiers[0].totalCNY - a.tiers[0].totalCNY, 2 * 6.8, 1e-9, '广告成本 +2 美元应等额增加');
});

test('广告成本为负数时报错', function () {
  var sc = Calculator.calculate(baseInput({ adCost: -1 }));
  ok(!sc.ok, '应存在错误');
});

/* ============================================================
   §7.2 购买占比与加权汇总
   ============================================================ */
group('§7.2 购买占比');

test('全部不填写占比时不产出加权汇总', function () {
  var sc = Calculator.calculate(baseInput());
  eq(sc.mix.validation.mode, 'none', '校验模式');
  eq(sc.mix.summary.ok, false, '不应产出汇总');
  eq(sc.mix.summary.metrics, null, '汇总指标应为空');
});

test('合计不等于 100% 时报错并给出实际合计', function () {
  var sc = Calculator.calculate(baseInput({
    tiers: [tier(1, 0.5, { mixPercent: 40 }), tier(2, 0.5, { mixPercent: 40 })]
  }));
  eq(sc.mix.validation.mode, 'invalid', '校验模式');
  ok(sc.mix.validation.error.message.indexOf('80') >= 0, '应提示实际合计: ' + sc.mix.validation.error.message);
  eq(sc.mix.summary.ok, false, '不应产出汇总');
});

test('只填写部分套餐占比时提示补齐其余套餐', function () {
  var sc = Calculator.calculate(baseInput({
    tiers: [tier(1, 0.5, { mixPercent: 50 }), tier(2, 0.5, { mixPercent: '' })]
  }));
  eq(sc.mix.validation.mode, 'invalid', '校验模式');
  ok(sc.mix.validation.error.message.indexOf('2 件档') >= 0, '应指出缺哪一档');
});

test('合计 100% 时加权指标正确（人工核对）', function () {
  var sc = Calculator.calculate(baseInput({
    tiers: [
      tier(1, 0.5, { mixPercent: 10 }),
      tier(2, 0.5, { mixPercent: 20 }),
      tier(3, 0.6, { mixPercent: 30 }),
      tier(4, 0.65, { mixPercent: 40 })
    ]
  }));
  eq(sc.mix.validation.mode, 'valid', '校验模式');
  ok(sc.mix.summary.ok, '应产出汇总: ' + JSON.stringify(sc.mix.summary.error));

  var m = sc.mix.summary.metrics;
  // 客单价 = 19.99×10% + 39.98×20% + 71.964×30% + 103.948×40%
  near(m.averageOrderValue, 19.99 * 0.1 + 39.98 * 0.2 + 71.964 * 0.3 + 103.948 * 0.4, 1e-9, '预计客单价');
  near(m.avgPurchaseCost, 30 * 0.1 + 60 * 0.2 + 90 * 0.3 + 120 * 0.4, 1e-9, '平均每单采购成本');
  near(m.avgFreightCost,
    sc.tiers[0].freightCNY * 0.1 + sc.tiers[1].freightCNY * 0.2
    + sc.tiers[2].freightCNY * 0.3 + sc.tiers[3].freightCNY * 0.4, 1e-9, '平均每单物流成本');
  near(m.avgTotalCost,
    sc.tiers[0].totalCNY * 0.1 + sc.tiers[1].totalCNY * 0.2
    + sc.tiers[2].totalCNY * 0.3 + sc.tiers[3].totalCNY * 0.4, 1e-9, '平均每单总成本');
  near(m.avgQty, 1 * 0.1 + 2 * 0.2 + 3 * 0.3 + 4 * 0.4, 1e-9, '平均每单购买数量');
  near(m.avgAdCost, 0, 1e-9, '未填广告成本时平均广告成本为 0（页面展示为「未提供」）');
});

test('存在未计算成本项时不做加权汇总', function () {
  var sc = Calculator.calculate(baseInput({
    product: { name: 'x', spu: 'X', source: 'manual', purchasePrice: 30, purchaseCurrency: 'CNY', weightG: null },
    tiers: [tier(1, 0.5, { mixPercent: 100 })]
  }));
  eq(sc.mix.summary.mode, 'blocked', '应被阻断');
  eq(sc.mix.summary.metrics, null, '不应产出指标');
});

test('购买占比超出 0~100 时判为非法（0 与 100 为合法边界）', function () {
  var over = Calculator.calculate(baseInput({ tiers: [tier(1, 0.5, { mixPercent: 150 })] }));
  eq(over.mix.validation.mode, 'invalid', '150% 应判非法');
  ok(over.mix.validation.error.message.indexOf('0 ~ 100') >= 0, '应提示取值范围');
  var neg = Calculator.calculate(baseInput({ tiers: [tier(1, 0.5, { mixPercent: -1 })] }));
  eq(neg.mix.validation.mode, 'invalid', '-1% 应判非法');
  var edge = Calculator.calculate(baseInput({
    tiers: [tier(1, 0.5, { mixPercent: 0 }), tier(2, 0.5, { mixPercent: 100 })]
  }));
  eq(edge.mix.validation.mode, 'valid', '0 与 100 为合法边界');
});

/* ============================================================
   §9 异常处理
   ============================================================ */
group('§9 异常处理');

test('售价币种不受支持时明确报错', function () {
  var sc = Calculator.calculate(baseInput({ saleCurrency: 'EUR' }));
  ok(!sc.ok, '应存在错误');
  ok(sc.errors[0].message.indexOf('EUR') >= 0, '应指明不支持的币种');
});

test('商品成本币种与售价币种不一致时给出可追溯提示', function () {
  var sc = Calculator.calculate(baseInput({
    product: { name: 'x', spu: 'KD00181', source: 'spu', purchasePrice: 30, purchaseCurrency: 'USD', weightG: 350 }
  }));
  ok(sc.warnings.length > 0, '应给出警告');
  ok(sc.warnings[0].message.indexOf('币种') >= 0, '应指明币种问题: ' + sc.warnings[0].message);
});

test('SPU 查不到时返回 null（不编造数据）', function () {
  return productSource.getBySpu('NOT-EXIST-SPU').then(function (item) {
    eq(item, null, '应返回 null');
  });
});

test('SPU 数据源可检索商品并带回采购成本与重量', function () {
  return productSource.search({ keyword: 'KD00181', limit: 10 }).then(function (rows) {
    ok(rows.length >= 1, '应检索到 KD00181');
    eq(rows[0].name, '葡萄酒伴侣瓶', '商品名称');
    var raw = globalThis.SPU_DATA.filter(function (r) { return r.spu === 'KD00181'; })[0];
    ok(raw, '源数据中应存在 KD00181');
    eq(rows[0].purchasePrice, raw.purchasePrice, '采购成本应与源数据一致');
    eq(rows[0].weightG, 350, '重量');
  });
});

test('样例数据完整性：1369 个 SPU 全部具备非空采购价与重量（除 3 条异常记录）', function () {
  var rows = globalThis.SPU_DATA;
  eq(rows.length, 1369, 'SPU 总数');
  var bad = rows.filter(function (r) { return !r.purchasePrice || !r.weightG; });
  eq(bad.length, 3, '异常记录数');
  eq(bad.map(function (r) { return r.spu; }).join(','), 'KD00180,TG00764,TG00765', '异常记录清单');
  eq(bad.filter(function (r) { return !r.weightG; }).length, 1, '其中 1 条缺重量（KD00180）');
  eq(bad.filter(function (r) { return !r.purchasePrice; }).length, 3, '3 条均缺采购成本');
});

test('随包 SPU 数据：每条都带布尔 elec 字段，SPU 编码不重复', function () {
  var rows = globalThis.SPU_DATA;
  eq(rows.filter(function (r) { return typeof r.elec !== 'boolean'; }).length, 0,
    '每条 SPU 都应有布尔 elec 字段');
  var seen = {}, dup = [];
  rows.forEach(function (r) { if (seen[r.spu]) dup.push(r.spu); seen[r.spu] = true; });
  eq(dup.length, 0, 'SPU 编码不应重复: ' + dup.join(','));
  // 当前源文件 elec 全为 0（不带电），因此全部商品默认走「特惠普货」
  eq(rows.filter(function (r) { return r.elec; }).length, 0,
    '当前版本源数据 elec 全为 0（不带电）；若日后数据中带电商品增加，此处需同步更新');
});

test('占比未填满时仍返回已填写部分的合计，供页面显示当前合计', function () {
  var v = Core.Mix.validateMix([
    { qty: 1, mixPercent: '40' },
    { qty: 2, mixPercent: '' },
    { qty: 3, mixPercent: '' },
    { qty: 4, mixPercent: '' }
  ]);
  ok(!v.ok, '应校验不通过');
  eq(v.mode, 'invalid', '状态');
  eq(v.totalPercent, 40, '应返回已填写部分的合计 40');
  ok(v.error.message.indexOf('\u8865\u9f50\u5176\u4f59\u5957\u9910') >= 0, '应提示补齐其余套餐');
});

/* ============================================================
   §11 商品信息交互（选择已有 SPU / 手动录入 / 带电默认渠道）
   ============================================================ */
group('§11 商品信息交互');

test('elec 解析兼容 1/0、是/否、true/false、带电 等写法', function () {
  var rows = [
    { spu: 'T1', elec: 1 }, { spu: 'T2', elec: 0 },
    { spu: 'T3', elec: '是' }, { spu: 'T4', elec: '否' },
    { spu: 'T5', elec: 'true' }, { spu: 'T6', elec: 'false' },
    { spu: 'T7', elec: '带电' }, { spu: 'T8', elec: '不带电' },
    { spu: 'T9', elec: true }, { spu: 'T10', elec: false },
    { spu: 'T11' }, { spu: 'T12', elec: null }, { spu: 'T13', elec: '0' }
  ];
  var src = Core.Data.createProductSource({
    name: 'elec-test',
    list: function () { return rows; },
    getBySpu: function (k) { return rows.filter(function (r) { return r.spu === k; })[0]; }
  });
  return src.list().then(function (list) {
    var truthy = list.filter(function (r) { return r.elec; }).map(function (r) { return r.spu; });
    eq(truthy.join(','), 'T1,T3,T5,T7,T9', '仅 1 / 是 / true / 带电 / 布尔 true 判为带电');
    list.forEach(function (r) {
      eq(typeof r.elec, 'boolean', r.spu + ' 的 elec 应归一化为布尔值');
    });
  });
});

test('默认渠道匹配规则：尺寸超限 > 带电 > 敏感 > 其他', function () {
  var cfg = globalThis.APP_CONFIG.logistics;
  eq(cfg.fallbackChannel, '云途全球专线挂号（特惠普货）', '兜底渠道');
  eq(cfg.channelRules.map(function (r) { return r.key; }).join(','), 'oversize,elec,sensitive',
    '规则顺序：尺寸超限 > 带电 > 敏感');
  eq(cfg.defaultChannel, cfg.fallbackChannel, '初始默认渠道应为兜底渠道');

  var names = {};
  globalThis.LOGISTICS_DATA.forEach(function (r) { if (r.channel) names[r.channel] = true; });
  cfg.channelRules.forEach(function (r) {
    ok(names[r.channel], '规则渠道名未在物流数据中找到: ' + r.channel);
  });
  ok(names[cfg.fallbackChannel], '兜底渠道名未在物流数据中找到');

  var match = Logistics.matchDefaultChannel;
  eq(match({ oversize: true }, cfg.channelRules, cfg.fallbackChannel).channel, CH_MID,
    '尺寸超限 → 云途中包专线挂号(特惠普货)');
  eq(match({ elec: true }, cfg.channelRules, cfg.fallbackChannel).channel, CH_ELEC,
    '带电 → 云途全球专线挂号（特惠带电）');
  eq(match({ sensitive: true }, cfg.channelRules, cfg.fallbackChannel).channel, CH_SENS,
    '敏感 → 极通环球专线-标准定制敏感');
  eq(match({}, cfg.channelRules, cfg.fallbackChannel).channel, CH_GENERAL,
    '其他 → 云途全球专线挂号（特惠普货）');

  // 优先级：多个属性同时命中时，尺寸超限 > 带电 > 敏感
  eq(match({ oversize: true, elec: true, sensitive: true }, cfg.channelRules, cfg.fallbackChannel).channel, CH_MID,
    '尺寸超限优先于带电与敏感');
  eq(match({ elec: true, sensitive: true }, cfg.channelRules, cfg.fallbackChannel).channel, CH_ELEC,
    '带电优先于敏感');
  eq(match({ oversize: false, elec: false, sensitive: false }, cfg.channelRules, cfg.fallbackChannel).reason, '其他',
    '无命中时原因记为「其他」');
});

test('商品信息只有「选择已有 SPU」与「手动录入」两种来源，SPU 只读', function () {
  var State = Core.UI.State;

  // ① 选择已有 SPU
  var p = State.setProductFromSpu({ name: '带电商品', spu: 'X1', purchasePrice: 10, weightG: 100, elec: true });
  eq(p.source, 'spu', '来源应为 spu');
  eq(p.elec, true, '带电属性应被带出');
  eq(State.state.spuProduct.spu, 'X1', '应保留 SPU 快照');

  // ② SPU 模式只读：台账字段不允许改
  State.setProductField('name', '改名了');
  eq(State.state.product.name, '带电商品', 'SPU 模式下不允许改台账字段');
  State.setProductField('weightG', 999);
  eq(State.state.product.weightG, 100, 'SPU 模式下不允许改重量');

  // ②b SPU 模式下「是否敏感 / 是否尺寸超限」这两个选填项可以由用户补充
  eq(State.state.product.sensitive, false, 'SPU 商品默认不敏感');
  eq(State.state.product.oversize, false, 'SPU 商品默认不尺寸超限');
  State.setProductField('sensitive', true);
  eq(State.state.product.sensitive, true, 'SPU 模式下应可填写「是否敏感」');
  State.setProductField('oversize', true);
  eq(State.state.product.oversize, true, 'SPU 模式下应可填写「是否尺寸超限」');

  // ③ 手动录入：空表单，可逐项填写
  var m = State.startManualProduct();
  eq(m.source, 'manual', '来源应为 manual');
  eq(m.name, '', '手动录入应为空表单');
  eq(m.purchasePrice, null, '手动录入价格应为空');
  eq(m.weightG, null, '手动录入重量应为空');
  eq(m.elec, false, '手动录入默认不带电');
  eq(m.sensitive, true, '切到手动录入时用户已填的「是否敏感」应保留');
  eq(m.oversize, true, '切到手动录入时用户已填的「是否尺寸超限」应保留');
  State.setProductField('name', '手填商品');
  State.setProductField('elec', true);
  eq(State.state.product.name, '手填商品', '手动模式应可改字段');
  eq(State.state.product.elec, true, '手动模式应可改带电属性');

  // ④ 切回「按 SPU 选择」：恢复上次选中的 SPU
  var r = State.restoreSpuProduct();
  eq(r.source, 'spu', '应恢复为 SPU 来源');
  eq(r.spu, 'X1', '应恢复上次选中的 SPU');
  eq(r.elec, true, '恢复后带电属性应保留');
});

test('商品表单已移除长/宽/高；录入时间只作为 SPU 匹配列表列，不作为表单项', function () {
  var State = Core.UI.State;
  var keys = State.PRODUCT_FIELDS.map(function (f) { return f.key; });
  eq(keys.join(','), 'name,spu,purchasePrice,purchaseCurrency,weightG,elec,sensitive,oversize',
    '商品表单字段应为这 8 项（含新增的两个选填项）');
  eq(keys.indexOf('lengthCm'), -1, '不应再有长');
  eq(keys.indexOf('widthCm'), -1, '不应再有宽');
  eq(keys.indexOf('heightCm'), -1, '不应再有高');
  eq(keys.indexOf('createTime'), -1, '录入时间不应作为表单项');

  var labels = State.PRODUCT_FIELDS.map(function (f) { return f.label; }).join(' ');
  ok(labels.indexOf('长') < 0 && labels.indexOf('宽') < 0 && labels.indexOf('高') < 0,
    '字段标签中不应出现长/宽/高');

  // 新增的两个字段：SPU 台账里没有，属于用户手填的选填项
  ['sensitive', 'oversize'].forEach(function (k) {
    var f = State.PRODUCT_FIELDS.filter(function (x) { return x.key === k; })[0];
    ok(f, '缺少字段 ' + k);
    eq(f.optional, true, k + ' 应为选填项');
    eq(f.userEditable, true, k + ' 应允许用户在 SPU 模式下补充');
    eq(f.bool, true, k + ' 应为布尔字段');
  });

  // 页面：录入时间只在 SPU 匹配列表表头出现一次，且不在商品信息表单区域内
  var html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
  eq((html.match(/录入时间/g) || []).length, 1, '页面中「录入时间」只应出现 1 次（SPU 列表表头）');
  ok(html.indexOf('录入时间') < html.indexOf('id="pcFields"'),
    '「录入时间」应出现在商品信息表单之前（即 SPU 匹配列表处）');
});

test('已移除「空白商品 / 系统数据 / 手动调整」相关状态与字段', function () {
  var stateSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ui', 'state.js'), 'utf8');
  ['systemProduct', 'editProductField', 'restoreProductField', 'fieldSource',
   'editedFields', 'lengthCm', 'widthCm', 'heightCm'].forEach(function (k) {
    ok(stateSrc.indexOf(k) < 0, 'state.js 不应再出现「' + k + '」');
  });
  var html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
  ok(html.indexOf('newManualBtn') < 0, '页面不应再有「新建手动商品」按钮');
  ok(html.indexOf('系统数据') < 0, '页面不应再出现「系统数据」');
});

/* ============================================================
   页面层接线（回归防护）
   —— 计算内核依赖的每一个 input.*，都必须由 app.js 的 buildInput() 真正提供；
      少传一个字段会让内核静默按「无数据」处理（例如漏传 rateCard → 运费恒为「渠道不支持国家」）。
   ============================================================ */
group('\u9875\u9762\u5c42\u63a5\u7ebf');

test('app.js 的 buildInput() 覆盖了计算内核读取的全部输入字段', function () {
  var calcSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'core', 'calculator.js'), 'utf8');
  var appSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'ui', 'app.js'), 'utf8');

  // 内核读取的顶层输入字段
  var needed = {};
  (calcSrc.match(/\binput\.([A-Za-z_]\w*)/g) || []).forEach(function (m) {
    needed[m.slice('input.'.length)] = true;
  });
  ok(Object.keys(needed).length >= 6, '应解析出计算内核的输入字段');

  // 页面层 buildInput() 返回对象的顶层键
  var seg = appSrc.slice(appSrc.indexOf('function buildInput()'));
  seg = seg.slice(seg.indexOf('return {'), seg.indexOf('\n    };'));
  var provided = {};
  (seg.match(/^ {6}([A-Za-z_]\w*):/gm) || []).forEach(function (m) {
    provided[m.replace(/^ {6}/, '').replace(':', '')] = true;
  });

  var missing = Object.keys(needed).filter(function (k) { return !provided[k]; });
  eq(missing.length, 0, 'buildInput() 缺少计算内核所需字段: ' + missing.join(', '));
  ok(provided.rateCard, 'buildInput() 必须把物流价目表传给计算内核');
});

test('物流引擎：未装载价目表时报「数据缺失」，而非误报「渠道不支持国家」', function () {
  var r = Logistics.calculate(undefined, { channel: CH_ELEC, country: '\u7f8e\u56fd', weightKg: 0.35, qty: 1 });
  ok(!r.ok, '应返回错误');
  eq(r.error.code, 'DATA_MISSING', '应归类为数据缺失');
  ok(r.error.message.indexOf('\u4ef7\u76ee\u8868') >= 0, '错误信息应点明价目表未装载');
});

/* ============================================================
   §10 验收场景端到端
   ============================================================ */
group('§10 验收场景');

test('场景1：手动录入商品 → 1~4 件完整测算', function () {
  var sc = Calculator.calculate(baseInput({
    product: { name: '手动录入商品', spu: '', source: 'manual', purchasePrice: 30, purchaseCurrency: 'CNY', weightG: 350 }
  }));
  ok(sc.ok, '场景1 应成功: ' + JSON.stringify(sc.errors));
  eq(sc.tiers.length, 4, '应有 4 个套餐');
  sc.tiers.forEach(function (r) {
    ok(r.finalSalePrice > 0, '售价应算出');
    ok(r.purchaseCNY > 0, '采购成本应算出');
    ok(r.freightCNY > 0, '运费应算出');
    ok(r.totalCNY > 0, '总成本应算出');
  });
});

test('场景2：通过 SPU 获取商品 → 完整测算', function () {
  return productSource.getBySpu('KD00182').then(function (item) {
    var sc = Calculator.calculate(baseInput({
      product: {
        name: item.name, spu: item.spu, source: 'spu',
        purchasePrice: item.purchasePrice, purchaseCurrency: 'CNY', weightG: item.weightG
      }
    }));
    ok(sc.ok, '场景2 应成功: ' + JSON.stringify(sc.errors));
    near(sc.tiers[0].purchaseCNY, item.purchasePrice, 1e-9, 'KD00182 采购成本应与源数据一致');
    near(sc.tiers[0].weightKg, 0.6, 1e-9, 'KD00182 重量 600g');
    // 0.6kg → 带电/美国 命中 (0.45, 0.7] 段，按该段件价 / 计重单价人工重算
    var hit = Logistics.findBand(Logistics.getBands(RATE, CH_ELEC, '美国'), 0.6);
    ok(hit.ok, '0.6kg 应命中重量段');
    near(sc.tiers[0].freightCNY, hit.band.piecePrice + hit.band.heavyPrice * 0.6, 1e-6, '运费人工核对');
  });
});

test('场景8：异常数据（重量缺失）时提示而非输出错误金额', function () {
  var sc = Calculator.calculate(baseInput({
    product: { name: '电子食谱', spu: 'KD00180', source: 'spu', purchasePrice: 0, purchaseCurrency: 'CNY', weightG: 0 }
  }));
  ok(!sc.ok, '应存在错误');
  eq(sc.tiers[0].totalCNY, null, '总成本必须为空，不能是 0');
  eq(sc.tiers[0].freightCNY, null, '运费必须为空，不能是 0');
  eq(sc.tiers[0].purchaseCNY, null, '采购成本必须为空，不能是 0');
});

(async function run() {
  for (var i = 0; i < pending.length; i++) {
    var t = pending[i];
    try {
      await t.fn();
      record(t, true, '');
    } catch (e) {
      record(t, false, (e && e.message) ? e.message : String(e));
    }
  }

/* ============================================================
   输出报告
   ============================================================ */
var total = results.length;
var passed = total - failures;

console.log('');
console.log('============================================================');
console.log('  商品套餐定价与订单成本测算工具 —— 核心计算测试');
console.log('============================================================');
var lastGroup = '';
results.forEach(function (r) {
  if (r.group !== lastGroup) { console.log('\n[' + r.group + ']'); lastGroup = r.group; }
  console.log('  ' + (r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.ok ? '' : '\n          -> ' + r.msg));
});
console.log('\n------------------------------------------------------------');
console.log('  合计 ' + total + ' 项：通过 ' + passed + '，失败 ' + failures);
console.log('============================================================');
console.log('');

/* 生成 Markdown 报告 */
var md = [];
md.push('# 核心计算测试结果');
md.push('');
md.push('> 运行方式：在 `pricing-tool` 目录下执行 `node tests/run-tests.js`');
md.push('> 测试数据：`data/spu.data.js`（1369 条 SPU，含 `elec` 带电属性）与 `data/logistics.data.js`（446 条重量段规则 · 4 个渠道），均为随包发布的样例数据转换结果。');
md.push('');
md.push('**结果：' + total + ' 项测试，通过 ' + passed + ' 项，失败 ' + failures + ' 项。**');
md.push('');
var g = '';
results.forEach(function (r) {
  if (r.group !== g) { g = r.group; md.push(''); md.push('## ' + g); md.push(''); }
  md.push('- ' + (r.ok ? '✅' : '❌') + ' ' + r.name + (r.ok ? '' : ' — **失败原因**：' + r.msg));
});
md.push('');

var outDir = path.resolve(__dirname, '..', 'docs');
var skipReportFile = process.env.SKIP_REPORT_FILE === '1' || process.argv.indexOf('--no-report-file') >= 0;
if (skipReportFile) {
  // 仅输出到控制台，不落盘（CI / 受限目录场景）
  console.log('===== BEGIN_REPORT =====');
  console.log(md.join('\n'));
  console.log('===== END_REPORT =====');
}
try {
  if (skipReportFile) throw new Error('已通过 SKIP_REPORT_FILE / --no-report-file 跳过落盘');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  var outFile = path.join(outDir, '测试结果.md');
  var mdText = md.join('\n');
  try {
    fs.writeFileSync(outFile, mdText, 'utf8');
  } catch (e1) {
    // 报告文件被占用（如正在编辑器中打开）时先删除再写
    try { fs.unlinkSync(outFile); } catch (e2) { /* 忽略 */ }
    fs.writeFileSync(outFile, mdText, 'utf8');
  }
  console.log('  测试报告已写入：' + outFile);
} catch (e) {
  // 报告落盘失败不应让整次测试失败（测试结论已完整打印在控制台）
  // 这里把 Markdown 原文也打到标准输出，保证报告不丢失，可手工另存为 docs/测试结果.md
  console.log('  [提示] 测试报告写入失败：' + (e && e.message ? e.message : e));
  console.log('===== BEGIN_REPORT =====');
  console.log(md.join('\n'));
  console.log('===== END_REPORT =====');
}


})();
