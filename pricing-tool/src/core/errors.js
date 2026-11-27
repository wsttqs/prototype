/**
 * 错误模型 —— 把「数据缺失 / 规则不支持 / 计算失败 / 输入不合法」区分开，
 * 避免用 0 冒充算不出来的金额。
 *
 * 纯逻辑模块：不依赖 DOM，也不依赖任何数据文件。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Core = root.Core || {};
  root.Core.Errors = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CATEGORY = {
    DATA_MISSING: '数据缺失',
    UNSUPPORTED: '规则不支持',
    CALC_FAILED: '计算失败',
    INVALID_INPUT: '输入不合法'
  };

  /**
   * 构造一个带分类的错误对象。
   * @param {string} code    错误码（见 CODE）
   * @param {string} message 面向业务人员的可读原因
   * @param {object} [detail] 附加信息（字段名、建议动作等）
   */
  function make(code, message, detail) {
    var d = detail || {};
    return {
      code: code,
      category: CATEGORY[code] || '计算失败',
      message: message,
      field: d.field || null,
      hint: d.hint || null,
      detail: d
    };
  }

  var Errors = {
    CATEGORY: CATEGORY,

    CODE: {
      DATA_MISSING: 'DATA_MISSING',
      UNSUPPORTED: 'UNSUPPORTED',
      CALC_FAILED: 'CALC_FAILED',
      INVALID_INPUT: 'INVALID_INPUT'
    },

    make: make,

    /** 数据缺失：商品成本 / 重量 / 售价等必要参数没有值 */
    dataMissing: function (message, detail) {
      return make(Errors.CODE.DATA_MISSING, message, detail);
    },

    /** 规则不支持：渠道不支持目的地、重量超出承运上限、重量落在计价空档等 */
    unsupported: function (message, detail) {
      return make(Errors.CODE.UNSUPPORTED, message, detail);
    },

    /** 计算失败：规则本身存在但计算过程中出错 */
    calcFailed: function (message, detail) {
      return make(Errors.CODE.CALC_FAILED, message, detail);
    },

    /** 输入不合法：数量非法、折扣率非法、占比不等于 100% 等 */
    invalidInput: function (message, detail) {
      return make(Errors.CODE.INVALID_INPUT, message, detail);
    },

    /** 统一判定：是否是「算不出来」的错误（前端据此显示「未计算」而不是 0） */
    isBlocking: function (err) {
      return !!err && !!err.code;
    },

    /** 把错误对象转成一句可直接展示的中文说明 */
    describe: function (err) {
      if (!err) return '';
      return '[' + (err.category || '计算失败') + '] ' + err.message;
    }
  };

  return Errors;
});
