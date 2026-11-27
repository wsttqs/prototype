/**
 * 订单结构汇总 —— 套餐购买占比校验与加权指标。
 *
 * 规则：
 *  - 占比可以完全不填；完全不填时不展示任何加权汇总。
 *  - 只要填了任意一个，所有套餐都必须填写，且合计必须等于 100%。
 *  - 加权指标基于「最终套餐售价 / 各成本项」计算。
 */
(function (root, factory) {
  var api = factory(root.Core || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Core = root.Core || {};
  root.Core.Mix = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  var Errors = Core.Errors;
  var TOLERANCE = 1e-6;

  /**
   * 校验占比填写情况。
   * @param {Array} tiers [{qty, mixPercent}]
   * @returns {object} {ok, mode:'none'|'valid'|'invalid', totalPercent, filled, error}
   */
  function validateMix(tiers) {
    var list = tiers || [];
    var filled = [];
    list.forEach(function (t) {
      var v = t.mixPercent;
      if (v !== null && v !== undefined && v !== '') {
        var n = Number(v);
        if (!isFinite(n) || n < 0 || n > 100) {
          filled.push({ qty: t.qty, value: v, invalid: true });
        } else {
          filled.push({ qty: t.qty, value: n, invalid: false });
        }
      }
    });

    if (!filled.length) {
      return { ok: true, mode: 'none', totalPercent: null, filled: 0, error: null };
    }

    // 已填写的合计（用于页面实时显示「当前合计」，即使校验未通过也有意义）
    var filledTotal = filled.reduce(function (acc, f) {
      return acc + (f.invalid ? 0 : f.value);
    }, 0);

    var invalid = filled.filter(function (f) { return f.invalid; });
    if (invalid.length) {
      return {
        ok: false, mode: 'invalid', totalPercent: filledTotal, filled: filled.length,
        error: Errors.invalidInput('购买占比必须是 0 ~ 100 的数字（' + invalid[0].qty + ' 件档：' + invalid[0].value + '）', { field: 'mixPercent', totalPercent: filledTotal })
      };
    }

    if (filled.length !== list.length) {
      var missing = list.filter(function (t) {
        return t.mixPercent === null || t.mixPercent === undefined || t.mixPercent === '';
      });
      return {
        ok: false, mode: 'invalid', totalPercent: filledTotal, filled: filled.length,
        error: Errors.invalidInput('已填写部分购买占比，请补齐其余套餐（缺少 ' + missing.map(function (m) { return m.qty + ' 件档'; }).join('、') + '）', { field: 'mixPercent', totalPercent: filledTotal })
      };
    }

    var total = filled.reduce(function (acc, f) { return acc + f.value; }, 0);
    if (Math.abs(total - 100) > TOLERANCE) {
      return {
        ok: false, mode: 'invalid', totalPercent: total, filled: filled.length,
        error: Errors.invalidInput('购买占比合计为 ' + round2(total) + '%，必须等于 100%', { field: 'mixPercent', totalPercent: total })
      };
    }
    return { ok: true, mode: 'valid', totalPercent: total, filled: filled.length, error: null };
  }

  function round2(v) {
    return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
  }

  /**
   * 计算加权汇总指标。
   * @param {Array} results 每个套餐的计算结果（含 salePrice / purchaseCNY / freightCNY / adCNY / totalCNY）
   * @param {Array} tiers 每个套餐的占比（百分数）
   */
  function summarize(results, tiers) {
    var validation = validateMix(tiers);
    if (!validation.ok || validation.mode !== 'valid') {
      return { ok: false, mode: validation.mode, error: validation.error, metrics: null };
    }

    var aov = 0, avgPurchase = 0, avgFreight = 0, avgTotal = 0, avgQty = 0, ad = 0;
    var blocked = null;

    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var w = Number(tiers[i].mixPercent) / 100;
      if (r.finalSalePrice === null || r.finalSalePrice === undefined) {
        blocked = blocked || '套餐「' + r.qty + ' 件」的最终售价尚未确定，无法汇总';
        continue;
      }
      if (r.purchaseCNY === null || r.purchaseCNY === undefined || r.freightCNY === null || r.freightCNY === undefined
        || r.totalCNY === null || r.totalCNY === undefined) {
        blocked = blocked || '套餐「' + r.qty + ' 件」存在未计算的成本项，无法汇总';
        continue;
      }
      aov += r.finalSalePrice * w;
      avgPurchase += r.purchaseCNY * w;
      avgFreight += r.freightCNY * w;
      avgTotal += r.totalCNY * w;
      avgQty += r.qty * w;
      ad += (r.adCNY || 0) * w;
    }

    if (blocked) {
      return { ok: false, mode: 'blocked', error: Errors.calcFailed(blocked), metrics: null };
    }

    return {
      ok: true,
      mode: 'valid',
      error: null,
      metrics: {
        averageOrderValue: aov,
        avgPurchaseCost: avgPurchase,
        avgFreightCost: avgFreight,
        avgAdCost: ad,
        avgTotalCost: avgTotal,
        avgQty: avgQty
      }
    };
  }

  var Mix = {
    validateMix: validateMix,
    summarize: summarize
  };
  return Mix;
});
