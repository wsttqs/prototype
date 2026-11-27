/**
 * 场景测算编排 —— 把商品、定价、物流、广告、占比串成一次完整测算。
 *
 * 口径约定：
 *  - 成本内部统一以人民币(CNY)计价（SPU 采购成本、物流价目表均为 ¥）。
 *  - 售价与展示默认美元($)；可用 saleCurrency 切换，汇率来自 fx 配置。
 *  - 任何一项算不出来 → 该项显示「未计算」，绝不以 0 代替，总成本随之不可计算。
 */
(function (root, factory) {
  var api = factory(root.Core || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Core = root.Core || {};
  root.Core.Calculator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  var Errors = Core.Errors;
  var Money = Core.Money;
  var Pricing = Core.Pricing;
  var Costs = Core.Costs;
  var Logistics = Core.Logistics;
  var Mix = Core.Mix;

  /**
   * 币种一致性检查。
   * @returns {{errors:Array, warnings:Array}}
   */
  function validateCurrencies(input) {
    var errors = [];
    var warnings = [];
    var rates = Money.rateTable(input.fx);

    if (!Money.isSupported(input.saleCurrency, rates)) {
      errors.push(Errors.invalidInput('售价币种「' + input.saleCurrency + '」不受支持，当前仅支持 ¥(CNY) 与 $(USD)', { field: 'saleCurrency' }));
    }
    if (!input.product) {
      warnings.push(Errors.dataMissing('尚未选择或录入商品信息', { field: 'product' }));
    } else {
      var pc = input.product.purchaseCurrency || 'CNY';
      if (!Money.isSupported(pc, rates)) {
        errors.push(Errors.invalidInput('采购成本币种「' + pc + '」不受支持，当前仅支持 ¥(CNY) 与 $(USD)', { field: 'purchaseCurrency' }));
      } else if (input.product.source === 'spu' && pc !== 'CNY') {
        warnings.push(Errors.invalidInput(
          'SPU 原始数据未标注币种（按 ¥ 解读）；当前已改为按 ' + pc + ' 解读采购成本，结果与系统台账可能不一致',
          { field: 'purchaseCurrency' }
        ));
      }
    }
    return { errors: errors, warnings: warnings };
  }

  /**
   * 执行一次完整测算。
   * @param {object} input 见文件头说明
   * @returns {object} scenario
   */
  function calculate(input) {
    var rates = Money.rateTable(input.fx);
    var saleCurrency = input.saleCurrency || 'USD';
    var product = input.product || null;

    var scenario = {
      ok: false,
      errors: [],
      warnings: [],
      product: null,
      tiers: [],
      mix: { validation: null, summary: null },
      freight: null,
      currency: {
        sale: saleCurrency,
        productCost: product ? (product.purchaseCurrency || 'CNY') : null,
        logistics: Logistics.RATE_CURRENCY,
        rates: rates,
        display: saleCurrency
      }
    };

    var ccyCheck = validateCurrencies(input);
    scenario.errors = ccyCheck.errors.slice();
    scenario.warnings = ccyCheck.warnings.slice();

    /* ---------- 商品 ---------- */
    var unitPurchasePriceCNY = null;
    var unitWeightG = null;
    if (product) {
      scenario.product = {
        name: product.name || '',
        spu: product.spu || '',
        source: product.source || 'manual',
        purchasePrice: product.purchasePrice === undefined ? null : product.purchasePrice,
        purchaseCurrency: product.purchaseCurrency || 'CNY',
        weightG: product.weightG === undefined ? null : product.weightG,
        // 是否带电（仅用于选择默认物流渠道，不直接参与成本计算）
        elec: !!product.elec,
        unitPurchasePriceCNY: null
      };

      var pc = scenario.product.purchaseCurrency;
      if (scenario.product.purchasePrice !== null && scenario.product.purchasePrice !== '' && Money.isSupported(pc, rates)) {
        var conv = Money.toCNY(scenario.product.purchasePrice, pc, rates);
        if (conv.ok) {
          scenario.product.unitPurchasePriceCNY = conv.value;
        } else {
          scenario.errors.push(conv.error);
        }
      }
      unitPurchasePriceCNY = scenario.product.unitPurchasePriceCNY;
      unitWeightG = scenario.product.weightG;
    } else {
      scenario.errors.push(Errors.dataMissing('请先选择或录入商品信息', { field: 'product' }));
    }

    /* ---------- 广告成本（每单获客成本，售价币种） ---------- */
    var adProvided = input.adCost !== null && input.adCost !== undefined && input.adCost !== '';
    var adValue = adProvided ? Number(input.adCost) : null;
    if (adProvided && (!isFinite(adValue) || adValue < 0)) {
      scenario.errors.push(Errors.invalidInput('每笔订单获客成本必须是 ≥ 0 的数字', { field: 'adCost' }));
      adProvided = false;
      adValue = null;
    }
    var adCostCNY = null;
    if (adProvided) {
      var adConv = Money.toCNY(adValue, saleCurrency, rates);
      if (adConv.ok) adCostCNY = adConv.value;
      else scenario.errors.push(adConv.error);
    }

    /* ---------- 逐个套餐测算 ---------- */
    var tiers = input.tiers || [];
    var results = [];

    for (var i = 0; i < tiers.length; i++) {
      var tier = tiers[i];
      var row = {
        qty: tier.qty,
        priceMode: tier.priceMode || Pricing.PRICE_MODE.AUTO,
        discountRate: tier.discountRate,
        mixPercent: tier.mixPercent === undefined ? null : tier.mixPercent,
        errors: [],
        unitOriginalPrice: null,
        originalPrice: null,
        discountRate: tier.discountRate,
        defaultSalePrice: null,
        finalSalePrice: null,
        finalSalePriceCNY: null,
        purchaseCNY: null,
        purchaseDisplay: null,
        weightKg: null,
        weightG: null,
        freight: null,
        freightCNY: null,
        adCNY: adProvided ? adCostCNY : null,
        adDisplay: adProvided ? adValue : null,
        adProvided: adProvided,
        totalCNY: null,
        totalDisplay: null,
        trace: null
      };

      /* 售价 */
      var price = Pricing.resolveFinalPrice(tier, input.unitSalePrice, input.baseDiscountRate);
      row.priceMode = price.mode;
      row.unitOriginalPrice = price.unitOriginalPrice;
      row.originalPrice = price.originalPrice;
      row.discountRate = price.discountRate;
      row.defaultSalePrice = price.defaultSalePrice;
      row.finalSalePrice = price.salePrice;
      if (!price.ok) row.errors.push(price.error);

      /* 采购成本 */
      var po = Costs.purchaseCost(unitPurchasePriceCNY, tier.qty);
      if (po.ok) {
        row.purchaseCNY = po.valueCNY;
        row.purchaseDisplay = display(Money.fromCNY(po.valueCNY, saleCurrency, rates));
      } else {
        row.errors.push(po.error);
      }

      /* 重量 */
      var bw = Costs.bundleWeight(unitWeightG, tier.qty);
      if (bw.ok) {
        row.weightKg = bw.valueKg;
        row.weightG = bw.valueG;
      } else {
        row.errors.push(bw.error);
      }

      /* 物流成本 */
      var freightResult = Logistics.calculate(input.rateCard, {
        channel: input.logistics && input.logistics.channel,
        country: input.logistics && input.logistics.country,
        weightKg: bw.ok ? bw.valueKg : null,
        qty: tier.qty
      });
      row.freight = freightResult.ok
        ? { ok: true, amountCNY: freightResult.amountCNY, breakdown: freightResult.breakdown, trace: freightResult.trace }
        : { ok: false, error: freightResult.error };
      if (freightResult.ok) {
        row.freightCNY = freightResult.amountCNY;
        row.trace = freightResult.trace;
      } else {
        row.errors.push(freightResult.error);
      }

      /* 总成本 */
      var tc = Costs.totalCost({
        purchaseCNY: row.purchaseCNY,
        freightCNY: row.freightCNY,
        adCostCNY: adProvided ? adCostCNY : null
      });
      if (tc.ok) {
        row.totalCNY = tc.valueCNY;
        row.totalDisplay = display(Money.fromCNY(tc.valueCNY, saleCurrency, rates));
        row.totalParts = tc.parts;
        row.adIncluded = tc.adIncluded;
      } else {
        row.errors.push(tc.error);
      }

      /* 售价折人民币，仅用于内部一致性（如需） */
      if (row.finalSalePrice !== null && row.finalSalePrice !== undefined) {
        row.finalSalePriceCNY = display(Money.toCNY(row.finalSalePrice, saleCurrency, rates));
      }

      results.push(row);
    }
    scenario.tiers = results;

    /* ---------- 购买占比与加权汇总 ---------- */
    var mixValidation = Mix.validateMix(tiers.map(function (t) {
      return { qty: t.qty, mixPercent: t.mixPercent };
    }));
    scenario.mix.validation = mixValidation;
    if (!mixValidation.ok) {
      scenario.warnings.push(mixValidation.error);
    }
    var summary = Mix.summarize(results, tiers.map(function (t) {
      return { qty: t.qty, mixPercent: t.mixPercent };
    }));
    scenario.mix.summary = summary;
    if (summary.mode === 'blocked' && summary.error) {
      scenario.warnings.push(summary.error);
    }

    // ok = 全局无错误 且 每个套餐均无未解决的异常（任一环节不可计算都不算测算成功）
    var rowFailed = results.some(function (r) { return (r.errors || []).length > 0; });
    scenario.ok = scenario.errors.length === 0 && !rowFailed;
    return scenario;
  }

  function display(conv) {
    return conv && conv.ok ? conv.value : null;
  }

  var Calculator = {
    calculate: calculate,
    validateCurrencies: validateCurrencies
  };
  return Calculator;
});
