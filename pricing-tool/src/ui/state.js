/**
 * 页面状态 —— 保存用户当前的输入与选择。
 * 这里只存「输入了什么」，不含任何计算结果（计算结果由 Core.Calculator 产出）。
 */
(function (root) {
  'use strict';
  var Core = root.Core = root.Core || {};
  Core.UI = Core.UI || {};
  var Pricing = Core.Pricing;
  var CONFIG = root.APP_CONFIG;

  var seq = 0;
  function nextId() { seq += 1; return 't' + seq; }

  /**
   * 商品字段定义 —— 字段清单与展示方式集中在这里，页面不散落硬编码。
   *
   * 说明：
   *  - 长 / 宽 / 高 本期不参与计算，按需求已移除，后续需要时再加回。
   *  - 「录入时间」只在 SPU 匹配列表展示，不作为表单项。
   *  - 「是否带电」参与默认物流渠道匹配：带电 → 特惠带电，不带电 → 特惠普货。
   *  - 「是否敏感」「是否尺寸超限」台账（SPU）里没有，由用户按需手填，均为选填项。
   *    这两项也参与默认物流渠道匹配（顺序：尺寸超限 > 带电 > 敏感 > 其他）。
   */
  var PRODUCT_FIELDS = [
    { key: 'name', label: '商品名称', type: 'text' },
    { key: 'spu', label: 'SPU 编码', type: 'text', optional: true },
    { key: 'purchasePrice', label: '单件采购成本', type: 'number', step: '0.01', suffix: '¥' },
    { key: 'purchaseCurrency', label: '成本币种', type: 'select',
      options: [{ value: 'CNY', label: '¥ 人民币' }, { value: 'USD', label: '$ 美元' }] },
    { key: 'weightG', label: '单件重量', type: 'number', step: '1', suffix: 'g' },
    { key: 'elec', label: '是否带电', type: 'select', bool: true,
      options: [{ value: 'false', label: '不带电' }, { value: 'true', label: '带电' }] },
    { key: 'sensitive', label: '是否敏感', type: 'select', bool: true, optional: true, userEditable: true,
      options: [{ value: 'false', label: '否' }, { value: 'true', label: '是' }] },
    { key: 'oversize', label: '是否尺寸超限', type: 'select', bool: true, optional: true, userEditable: true,
      options: [{ value: 'false', label: '否' }, { value: 'true', label: '是' }] }
  ];

  var state = {
    sourceMode: 'spu',            // 'spu' | 'manual' —— 当前录入方式
    product: null,                // 当前生效的商品信息
    spuProduct: null,             // 最近一次从台账选中的 SPU（切回「按 SPU 选择」时恢复）
    unitSalePrice: '',
    baseDiscountRate: CONFIG.pricing.baseDiscountRate,
    tiers: [],
    channel: CONFIG.logistics.defaultChannel,
    country: CONFIG.logistics.defaultCountry,
    adCost: '',
    saleCurrency: CONFIG.currency.sale,
    fx: { CNY: 1, USD: CONFIG.fx.USD },
    expandedTierId: null,         // 结果表中展开运费的套餐
    spuResults: [],
    spuTotal: 0,
    spuKeyword: '',
    logiNotice: null,             // 渠道不支持原目的地时自动改写目的地，并留下明确提示
    channelMismatch: null         // 当前渠道与商品「是否带电」不一致时的提示信息
  };

  /* ---------------- 套餐 ---------------- */

  function makeTier(qty) {
    var d = Pricing.defaultDiscountRate(qty);
    return {
      id: nextId(),
      qty: qty,
      discountRate: d === null ? '' : d,
      priceMode: Pricing.PRICE_MODE.AUTO,
      manualSalePrice: null,
      mixPercent: ''
    };
  }

  function initTiers() {
    state.tiers = CONFIG.pricing.defaultQtys.map(makeTier);
  }

  /** 新增套餐：数量取当前最大数量 +1（不写死 1~4） */
  function addTier() {
    var max = 0;
    state.tiers.forEach(function (t) { max = Math.max(max, Number(t.qty) || 0); });
    var t = makeTier(max + 1);
    state.tiers.push(t);
    return t;
  }

  function removeTier(id) {
    state.tiers = state.tiers.filter(function (t) { return t.id !== id; });
    if (state.expandedTierId === id) state.expandedTierId = null;
  }

  function getTier(id) {
    for (var i = 0; i < state.tiers.length; i++) {
      if (state.tiers[i].id === id) return state.tiers[i];
    }
    return null;
  }

  /* ---------------- 商品 ---------------- */

  function blankProduct(source) {
    return {
      source: source || 'manual',
      name: '', spu: '',
      purchasePrice: null,
      purchaseCurrency: CONFIG.currency.productCost,
      weightG: null,
      elec: false,
      sensitive: false,
      oversize: false
    };
  }

  /**
   * 从 SPU 台账选择商品：直接采用台账数据，只读展示，不再区分「系统值 / 手动调整」。
   * 同时保留一份快照，切回「按 SPU 选择」时可以恢复。
   */
  function setProductFromSpu(row) {
    state.spuProduct = {
      source: 'spu',
      name: row.name || '',
      spu: row.spu || '',
      purchasePrice: row.purchasePrice === undefined ? null : row.purchasePrice,
      purchaseCurrency: CONFIG.currency.productCost,
      weightG: row.weightG === undefined ? null : row.weightG,
      elec: !!row.elec,
      /* 台账没有这两项，默认否；用户在页面上可手动补充（选填） */
      sensitive: false,
      oversize: false
    };
    state.product = state.spuProduct;
    return state.product;
  }

  /** 切换到「手动录入」：清空表单，由用户逐项填写（用户已填的敏感/尺寸超限予以保留） */
  function startManualProduct() {
    var prev = state.product || {};
    state.product = blankProduct('manual');
    state.product.sensitive = !!prev.sensitive;
    state.product.oversize = !!prev.oversize;
    return state.product;
  }

  /** 切回「按 SPU 选择」：恢复最近一次选中的 SPU（没有则回到空状态） */
  function restoreSpuProduct() {
    state.product = state.spuProduct || null;
    return state.product;
  }

  /**
   * 修改商品字段。
   *  - 手动录入模式：所有字段都可改。
   *  - SPU 匹配模式：台账字段只读，仅 userEditable 字段（是否敏感 / 是否尺寸超限）可由用户补充。
   */
  function setProductField(key, value) {
    if (!state.product) return;
    var isManual = state.product.source === 'manual';
    if (!isManual) {
      var editable = false;
      for (var i = 0; i < PRODUCT_FIELDS.length; i++) {
        if (PRODUCT_FIELDS[i].key === key) { editable = !!PRODUCT_FIELDS[i].userEditable; break; }
      }
      if (!editable) return;
    }
    state.product[key] = value;
  }

  Core.UI.State = {
    state: state,
    PRODUCT_FIELDS: PRODUCT_FIELDS,
    initTiers: initTiers,
    makeTier: makeTier,
    addTier: addTier,
    removeTier: removeTier,
    getTier: getTier,
    blankProduct: blankProduct,
    setProductFromSpu: setProductFromSpu,
    startManualProduct: startManualProduct,
    restoreSpuProduct: restoreSpuProduct,
    setProductField: setProductField
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
