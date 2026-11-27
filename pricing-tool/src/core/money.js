/**
 * 金额与币种 —— 统一舍入规则 + 汇率换算。
 *
 * 约定：
 *  - 内部计算一律用「人民币(CNY)」作为成本口径（SPU 采购成本与物流价目表均为 ¥）。
 *  - 售价币种可切换（默认 USD），展示时按配置汇率折算。
 *  - 计算过程保留完整精度，只在「展示」时四舍五入，避免多次舍入累积误差。
 */
(function (root, factory) {
  var api = factory(root.Core || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Core = root.Core || {};
  root.Core.Money = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  var Errors = Core.Errors;

  var CURRENCY = {
    CNY: { code: 'CNY', symbol: '¥', name: '人民币' },
    USD: { code: 'USD', symbol: '$', name: '美元' }
  };

  /**
   * 四舍五入到指定小数位（半值远离 0），带极小容差修正浮点误差。
   */
  function round(value, dp) {
    var p = Math.pow(10, dp == null ? 2 : dp);
    var x = Number(value);
    if (!isFinite(x)) return x;
    var y = x * p;
    var e = Math.abs(y) * 1e-12 + 1e-9;
    return (y >= 0 ? Math.round(y + e) : -Math.round(-y + e)) / p;
  }

  /** 展示用：千分位 + 固定小数位 */
  function format(value, dp) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    return round(value, dp == null ? 2 : dp).toLocaleString('zh-CN', {
      minimumFractionDigits: dp == null ? 2 : dp,
      maximumFractionDigits: dp == null ? 2 : dp
    });
  }

  /** 展示用：带货币符号 */
  function formatWithSymbol(value, currencyCode, dp) {
    if (value === null || value === undefined || !isFinite(value)) return '未计算';
    var c = CURRENCY[currencyCode] || { symbol: '' };
    return c.symbol + format(value, dp);
  }

  /**
   * 汇率表：1 单位 X 可兑换多少 CNY。
   * 默认 1 USD = 6.80 CNY（与 2026-11-07 定价模型调研所用口径一致，可配置）。
   */
  function defaultRates() {
    return { CNY: 1, USD: 6.8 };
  }

  function rateTable(rates) {
    var t = defaultRates();
    if (rates) {
      for (var k in rates) {
        if (Object.prototype.hasOwnProperty.call(rates, k) && isFinite(rates[k]) && rates[k] > 0) {
          t[k] = rates[k];
        }
      }
    }
    return t;
  }

  /** 金额从某币种折算成人民币 */
  function toCNY(amount, currencyCode, rates) {
    var t = rateTable(rates);
    var r = t[currencyCode];
    if (!r) {
      return {
        ok: false,
        error: Errors.invalidInput('不支持的币种：' + currencyCode + '，当前仅支持 ¥(CNY) 与 $(USD)', {
          field: 'currency', hint: '请在币种设置中改用 ¥ 或 $'
        })
      };
    }
    return { ok: true, value: Number(amount) * r };
  }

  /** 金额从人民币折算成目标币种 */
  function fromCNY(amountCNY, currencyCode, rates) {
    var t = rateTable(rates);
    var r = t[currencyCode];
    if (!r) {
      return {
        ok: false,
        error: Errors.invalidInput('不支持的目标币种：' + currencyCode + '，当前仅支持 ¥(CNY) 与 $(USD)', {
          field: 'currency'
        })
      };
    }
    return { ok: true, value: Number(amountCNY) / r };
  }

  /** 判断某个币种是否在汇率表中 */
  function isSupported(currencyCode, rates) {
    return !!rateTable(rates)[currencyCode];
  }

  var Money = {
    CURRENCY: CURRENCY,
    round: round,
    format: format,
    formatWithSymbol: formatWithSymbol,
    defaultRates: defaultRates,
    rateTable: rateTable,
    toCNY: toCNY,
    fromCNY: fromCNY,
    isSupported: isSupported
  };

  return Money;
});
