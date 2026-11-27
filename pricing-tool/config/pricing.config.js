/**
 * 业务配置 —— 全部可调，默认值来自需求文档。
 * 这里的每一项都是「业务参数」而非「写死的规则」，业务人员可直接改。
 */
(function (root) {
  'use strict';
  root.APP_CONFIG = {
    /* 定价：单件售价 ÷ 单件折扣率 = 单件原价；套餐售价 = 套餐原价 × 套餐折扣率 */
    pricing: {
      baseDiscountRate: 0.5,
      discountByQty: { 1: 0.50, 2: 0.50, 3: 0.60, 4: 0.65 },
      defaultQtys: [1, 2, 3, 4]
    },

    /* 数据模式：'real' = 内部真实数据；'sample' = 公开脱敏样例数据（页面顶部显示提示条） */
    dataMode: 'sample',

    /* 汇率：1 单位 X = ? CNY。默认 1 USD = 6.80 CNY */
    fx: { CNY: 1, USD: 6.8 },

    /* 币种：售价币种默认美元；SPU 采购成本来源文件未标币种，按 ¥ 解读 */
    currency: {
      sale: 'USD',
      productCost: 'CNY'
    },

    /* 物流默认选择 */
    logistics: {
      defaultChannel: '云途全球专线挂号（特惠普货）',
      defaultCountry: '美国',
      /*
       * 默认物流渠道匹配规则（按顺序判断，先命中先用）：
       *   尺寸超限 → 云途中包专线挂号(特惠普货)
       *   带电     → 云途全球专线挂号（特惠带电）
       *   敏感     → 极通环球专线-标准定制敏感
       *   以上都没有 → fallbackChannel（云途全球专线挂号（特惠普货））
       */
      channelRules: [
        { key: 'oversize', label: '尺寸超限', channel: '云途中包专线挂号(特惠普货)' },
        { key: 'elec', label: '带电', channel: '云途全球专线挂号（特惠带电）' },
        { key: 'sensitive', label: '敏感', channel: '极通环球专线-标准定制敏感' }
      ],
      fallbackChannel: '云途全球专线挂号（特惠普货）'
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
