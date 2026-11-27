/**
 * 成本计算 —— 采购成本、套餐重量、广告成本、套餐总成本。
 */
(function (root, factory) {
  var api = factory(root.Core || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Core = root.Core || {};
  root.Core.Costs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  var Errors = Core.Errors;
  var GRAMS_PER_KG = 1000;

  function purchaseCost(unitPurchasePrice, qty) {
    if (unitPurchasePrice === null || unitPurchasePrice === undefined || unitPurchasePrice === '') {
      return { ok: false, error: Errors.dataMissing('商品采购成本缺失，无法计算采购成本', { field: 'purchasePrice' }) };
    }
    var p = Number(unitPurchasePrice);
    if (!isFinite(p)) {
      return { ok: false, error: Errors.invalidInput('商品采购成本不是有效数字', { field: 'purchasePrice' }) };
    }
    if (p < 0) {
      return { ok: false, error: Errors.invalidInput('商品采购成本不能为负数', { field: 'purchasePrice' }) };
    }
    var q = Number(qty);
    if (!isFinite(q) || q <= 0) {
      return { ok: false, error: Errors.invalidInput('套餐数量不合法，无法计算采购成本', { field: 'qty' }) };
    }
    if (p === 0) {
      return { ok: false, error: Errors.dataMissing('商品采购成本为 0，无法确认成本，请补充实际采购价', { field: 'purchasePrice' }) };
    }
    return { ok: true, valueCNY: p * q };
  }

  function bundleWeight(unitWeightG, qty) {
    if (unitWeightG === null || unitWeightG === undefined || unitWeightG === '') {
      return { ok: false, error: Errors.dataMissing('商品重量缺失，无法计算套餐重量与运费', { field: 'weight' }) };
    }
    var w = Number(unitWeightG);
    if (!isFinite(w)) {
      return { ok: false, error: Errors.invalidInput('商品重量不是有效数字', { field: 'weight' }) };
    }
    if (w <= 0) {
      return { ok: false, error: Errors.dataMissing('商品重量为 0，无法计算套餐重量与运费', { field: 'weight' }) };
    }
    var q = Number(qty);
    if (!isFinite(q) || q <= 0) {
      return { ok: false, error: Errors.invalidInput('套餐数量不合法，无法计算套餐重量', { field: 'qty' }) };
    }
    var grams = w * q;
    return { ok: true, valueG: grams, valueKg: grams / GRAMS_PER_KG };
  }

  function totalCost(p) {
    if (p.purchaseCNY === null || p.purchaseCNY === undefined) {
      return { ok: false, error: Errors.dataMissing('采购成本未计算，套餐总成本不可用', { field: 'purchasePrice' }) };
    }
    var parts = [{ name: '采购成本', valueCNY: Number(p.purchaseCNY) }];

    if (p.freightCNY === null || p.freightCNY === undefined) {
      return { ok: false, error: Errors.dataMissing('物流成本未计算，套餐总成本不可用', { field: 'logistics' }) };
    }
    parts.push({ name: '物流成本', valueCNY: Number(p.freightCNY) });

    var adProvided = p.adCostCNY !== null && p.adCostCNY !== undefined && p.adCostCNY !== '';
    if (adProvided) {
      var ad = Number(p.adCostCNY);
      if (!isFinite(ad) || ad < 0) {
        return { ok: false, error: Errors.invalidInput('每笔订单获客成本不合法', { field: 'adCost' }) };
      }
      parts.push({ name: '广告成本', valueCNY: ad });
    }

    var sum = parts.reduce(function (acc, x) { return acc + x.valueCNY; }, 0);
    return { ok: true, valueCNY: sum, parts: parts, adIncluded: adProvided };
  }

  var Costs = {
    GRAMS_PER_KG: GRAMS_PER_KG,
    purchaseCost: purchaseCost,
    bundleWeight: bundleWeight,
    totalCost: totalCost
  };
  return Costs;
});
