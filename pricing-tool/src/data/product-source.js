/**
 * 商品数据源 —— 第一层（数据获取）接口。
 *
 * 接口约定（未来接入商品系统 API 时只需新增一个 Adapter 实现同样方法）：
 *   list()                     -> Promise<Array>   查询商品列表
 *   search({keyword, limit})   -> Promise<Array>   按 SPU 编码 / 商品名称搜索
 *   getBySpu(spu)              -> Promise<Object>  根据 SPU 查询商品详情
 *
 * 业务计算层只认这里的返回结构，不认数据来源。
 */
(function (root, factory) {
  var api = factory(root.Core || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Core = root.Core || {};
  root.Core.Data = root.Core.Data || {};
  root.Core.Data.createProductSource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  function createProductSource(adapter) {
    if (!adapter || typeof adapter.list !== 'function') {
      throw new Error('product source 需要实现 list() / search() / getBySpu()');
    }

    /** 是否带电：兼容 1/0、是/否、true/false、"带电" 等写法 */
    function toBool(v) {
      if (v === true || v === 1) return true;
      if (v === false || v === null || v === undefined || v === 0) return false;
      var s = String(v).trim().toLowerCase();
      return s === '1' || s === 'true' || s === 'yes' || s === '是' || s === '带电';
    }

    function normalize(row) {
      return {
        id: row.id,
        spu: row.spu,
        name: row.name,
        purchasePrice: row.purchasePrice,
        weightG: row.weightG,
        // 是否带电：决定默认物流渠道（带电 → 特惠带电；不带电 → 特惠普货）
        elec: toBool(row.elec),
        createTime: row.createTime || null
      };
    }

    return {
      kind: 'product',
      adapterName: adapter.name || 'anonymous',

      list: function () {
        return Promise.resolve(adapter.list()).then(function (rows) {
          return (rows || []).map(normalize);
        });
      },

      search: function (opts) {
        var keyword = String((opts && opts.keyword) || '').trim().toLowerCase();
        var limit = (opts && opts.limit) || 50;
        return Promise.resolve(adapter.list()).then(function (rows) {
          var list = (rows || []).map(normalize);
          if (!keyword) return list.slice(0, limit);
          var hit = list.filter(function (p) {
            return String(p.spu || '').toLowerCase().indexOf(keyword) >= 0
              || String(p.name || '').toLowerCase().indexOf(keyword) >= 0;
          });
          return hit.slice(0, limit);
        });
      },

      getBySpu: function (spu) {
        var key = String(spu || '').trim();
        if (!key) return Promise.resolve(null);
        return Promise.resolve(adapter.getBySpu ? adapter.getBySpu(key) : null).then(function (row) {
          return row ? normalize(row) : null;
        });
      }
    };
  }

  return createProductSource;
});
