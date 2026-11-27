/**
 * 页面展示工具 —— 纯 DOM / 格式化辅助函数。
 * 不含任何业务规则（定价、计价规则都在 src/core 里）。
 */
(function (root) {
  'use strict';
  var Core = root.Core = root.Core || {};
  Core.UI = Core.UI || {};
  var Money = Core.Money;

  function $(sel, scope) { return (scope || document).querySelector(sel); }
  function $$(sel, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(sel));
  }

  /** HTML 转义 */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 金额（带币种符号） */
  function money(v, ccy, dp) {
    if (v === null || v === undefined || !isFinite(v)) return '未计算';
    return Money.formatWithSymbol(v, ccy, dp);
  }

  /** 金额（不带币种符号） */
  function amount(v, dp) {
    if (v === null || v === undefined || !isFinite(v)) return '未计算';
    return Money.format(v, dp);
  }

  /** 百分比 */
  function pct(v, dp) {
    if (v === null || v === undefined || v === '' || !isFinite(Number(v))) return '未设置';
    return (Number(v) * 100).toFixed(dp === undefined ? 0 : dp) + '%';
  }

  /**
   * 「未计算」单元格 —— 带上原因，禁止用 0 冒充。
   * @param {object|null} err 错误对象（Core.Errors.make 产生）
   */
  function na(err, fallback) {
    var reason = err && err.message ? err.message : (fallback || '数据缺失');
    // 原因既写进 title（鼠标悬浮可见），也用 .sr-only 播报给读屏用户；
    // 不再额外画一个「?」小圆点，避免表格里出现无意义的重复符号。
    return '<span class="na" title="' + esc(reason) + '">未计算'
      + '<span class="sr-only">（原因：' + esc(reason) + '）</span></span>';
  }

  /** 数字输入框取值：空字符串保持为 null（表示「未填写」），否则转数字 */
  function numOrNull(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    if (s === '') return null;
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }

  /**
   * 在重建 DOM 的过程中保留输入焦点与光标位置。
   * 依赖元素上的 data-fkey 作为稳定标识。
   */
  function withFocus(fn) {
    var a = document.activeElement;
    var key = a && a.getAttribute ? a.getAttribute('data-fkey') : null;
    var start = null, end = null;
    if (key && 'selectionStart' in a) {
      try { start = a.selectionStart; end = a.selectionEnd; } catch (e) { /* number 类型不支持 */ }
    }
    fn();
    if (key) {
      var next = document.querySelector('[data-fkey="' + key + '"]');
      if (next && next !== a) {
        next.focus();
        if (start !== null) {
          try { next.setSelectionRange(start, end); } catch (e) { /* ignore */ }
        }
      }
    }
  }

  /** 只在输入框未获得焦点时同步其显示值，避免打断用户输入 */
  function setValue(input, v) {
    if (!input) return;
    if (document.activeElement === input) return;
    input.value = (v === null || v === undefined) ? '' : v;
  }

  Core.UI.Dom = {
    $: $, $$: $$, esc: esc, money: money, amount: amount, pct: pct,
    na: na, numOrNull: numOrNull, withFocus: withFocus, setValue: setValue
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
