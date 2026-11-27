/**
 * 套餐定价 —— 原价、默认售价、手动售价覆盖。
 *
 * 业务规则（来自需求文档 §5.2 / §5.3）：
 *   单件原价 = 单件售价 ÷ 单件折扣率(默认 50%)
 *   套餐原价 = 单件原价 × 套餐数量
 *   套餐售价 = 套餐原价 × 该套餐折扣率
 * 手动修改最终售价后，该套餐进入「手动」状态，不再被自动计算覆盖；
 * 恢复自动后按当前单件售价与折扣率重算。
 */
(function (root, factory) {
  var api = factory(root.Core || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Core = root.Core || {};
  root.Core.Pricing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  var Errors = Core.Errors;

  var PRICE_MODE = { AUTO: 'auto', MANUAL: 'manual' };

  /** 业务默认：单件折扣率（单件售价 ÷ 50% = 原价） */
  var DEFAULT_BASE_DISCOUNT = 0.5;

  /** 业务默认：各数量档折扣率 */
  var DEFAULT_DISCOUNT_BY_QTY = {
    1: 0.50,
    2: 0.50,
    3: 0.60,
    4: 0.65
  };

  /** 默认生成的套餐数量 */
  var DEFAULT_QTYS = [1, 2, 3, 4];

  /** 校验单件售价 */
  function validateUnitSalePrice(unitSalePrice) {
    if (unitSalePrice === null || unitSalePrice === undefined || unitSalePrice === '') {
      return Errors.invalidInput('单件售价为空，请填写后再计算套餐售价', { field: 'unitSalePrice' });
    }
    var v = Number(unitSalePrice);
    if (!isFinite(v)) {
      return Errors.invalidInput('单件售价不是有效数字', { field: 'unitSalePrice' });
    }
    if (v <= 0) {
      return Errors.invalidInput('单件售价必须大于 0（当前 ' + v + '）', { field: 'unitSalePrice' });
    }
    return null;
  }

  /** 校验套餐数量 */
  function validateQty(qty) {
    var v = Number(qty);
    if (!isFinite(v) || !Number.isInteger(v)) {
      return Errors.invalidInput('套餐数量必须是正整数（当前 ' + qty + '）', { field: 'qty' });
    }
    if (v <= 0) {
      return Errors.invalidInput('套餐数量必须大于 0（当前 ' + v + '）', { field: 'qty' });
    }
    return null;
  }

  /** 校验套餐折扣率 */
  function validateDiscountRate(rate) {
    if (rate === null || rate === undefined || rate === '') {
      return Errors.invalidInput('该套餐尚未设置折扣率，请填写后再计算', { field: 'discountRate' });
    }
    var v = Number(rate);
    if (!isFinite(v)) {
      return Errors.invalidInput('折扣率不是有效数字', { field: 'discountRate' });
    }
    if (v <= 0 || v > 1) {
      return Errors.invalidInput('折扣率必须在 0% ~ 100% 之间（当前 ' + (v * 100) + '%）', { field: 'discountRate' });
    }
    return null;
  }

  /** 单件原价 = 单件售价 ÷ 单件折扣率 */
  function unitOriginalPrice(unitSalePrice, baseDiscountRate) {
    var base = baseDiscountRate === undefined || baseDiscountRate === null ? DEFAULT_BASE_DISCOUNT : Number(baseDiscountRate);
    var err = validateDiscountRate(base);
    if (err) return { ok: false, error: err };
    var saleErr = validateUnitSalePrice(unitSalePrice);
    if (saleErr) return { ok: false, error: saleErr };
    return { ok: true, value: Number(unitSalePrice) / base };
  }

  /** 套餐原价 = 单件原价 × 数量 */
  function bundleOriginalPrice(unitOriginal, qty) {
    var qErr = validateQty(qty);
    if (qErr) return { ok: false, error: qErr };
    if (!isFinite(Number(unitOriginal))) {
      return { ok: false, error: Errors.calcFailed('单件原价不可用，无法计算套餐原价') };
    }
    return { ok: true, value: Number(unitOriginal) * Number(qty) };
  }

  /**
   * 计算某个套餐的「默认售价」（自动计算结果）。
   * @returns {{ok:boolean, originalPrice?:number, discountRate?:number, salePrice?:number, error?:object}}
   */
  function defaultBundlePrice(params) {
    var unitSalePrice = params.unitSalePrice;
    var qty = params.qty;
    var discountRate = params.discountRate;
    var baseDiscountRate = params.baseDiscountRate;

    var uo = unitOriginalPrice(unitSalePrice, baseDiscountRate);
    if (!uo.ok) return { ok: false, error: uo.error };

    var op = bundleOriginalPrice(uo.value, qty);
    if (!op.ok) return { ok: false, error: op.error };

    var dr = validateDiscountRate(discountRate);
    if (dr) return { ok: false, error: dr };

    return {
      ok: true,
      unitOriginalPrice: uo.value,
      originalPrice: op.value,
      discountRate: Number(discountRate),
      salePrice: op.value * Number(discountRate)
    };
  }

  /**
   * 解析套餐最终售价：自动 or 手动覆盖。
   * @param {object} tier {qty, discountRate, priceMode, manualSalePrice}
   */
  function resolveFinalPrice(tier, unitSalePrice, baseDiscountRate) {
    var def = defaultBundlePrice({
      unitSalePrice: unitSalePrice,
      qty: tier.qty,
      discountRate: tier.discountRate,
      baseDiscountRate: baseDiscountRate
    });

    var isManual = tier.priceMode === PRICE_MODE.MANUAL;
    var manualValue = tier.manualSalePrice;

    if (!isManual) {
      if (!def.ok) {
        return {
          ok: false, mode: PRICE_MODE.AUTO, error: def.error,
          unitOriginalPrice: def.unitOriginalPrice,
          originalPrice: def.originalPrice,
          discountRate: def.discountRate,
          defaultSalePrice: null,
          salePrice: null
        };
      }
      return {
        ok: true, mode: PRICE_MODE.AUTO,
        unitOriginalPrice: def.unitOriginalPrice,
        originalPrice: def.originalPrice,
        discountRate: def.discountRate,
        defaultSalePrice: def.salePrice,
        salePrice: def.salePrice
      };
    }

    // 手动状态：售价以用户填写的值为准；默认值仍计算出来用于对照展示
    var manualErr = validateUnitSalePrice(manualValue);
    if (manualErr) {
      return {
        ok: false, mode: PRICE_MODE.MANUAL, error: manualErr,
        unitOriginalPrice: def.unitOriginalPrice,
        originalPrice: def.originalPrice,
        discountRate: def.discountRate,
        defaultSalePrice: def.ok ? def.salePrice : null,
        salePrice: null
      };
    }
    return {
      ok: true, mode: PRICE_MODE.MANUAL,
      unitOriginalPrice: def.unitOriginalPrice,
      originalPrice: def.originalPrice,
      discountRate: def.discountRate,
      defaultSalePrice: def.ok ? def.salePrice : null,
      salePrice: Number(manualValue)
    };
  }

  /** 套餐数量是否合法 */
  function isValidQty(qty) {
    return !validateQty(qty);
  }

  /** 折扣率是否合法 */
  function isValidDiscountRate(rate) {
    return !validateDiscountRate(rate);
  }

  /** 取某数量档的默认折扣率；没有默认值返回 null（由用户填写，不猜测） */
  function defaultDiscountRate(qty) {
    var v = DEFAULT_DISCOUNT_BY_QTY[Number(qty)];
    return v === undefined ? null : v;
  }

  var Pricing = {
    PRICE_MODE: PRICE_MODE,
    DEFAULT_BASE_DISCOUNT: DEFAULT_BASE_DISCOUNT,
    DEFAULT_DISCOUNT_BY_QTY: DEFAULT_DISCOUNT_BY_QTY,
    DEFAULT_QTYS: DEFAULT_QTYS,
    validateUnitSalePrice: validateUnitSalePrice,
    validateQty: validateQty,
    validateDiscountRate: validateDiscountRate,
    unitOriginalPrice: unitOriginalPrice,
    bundleOriginalPrice: bundleOriginalPrice,
    defaultBundlePrice: defaultBundlePrice,
    resolveFinalPrice: resolveFinalPrice,
    defaultDiscountRate: defaultDiscountRate,
    isValidQty: isValidQty,
    isValidDiscountRate: isValidDiscountRate
  };

  return Pricing;
});
