/**
 * 物流数据源 —— 第一层（数据获取）接口。
 *
 * 接口约定（未来接入物流系统 API 时只需新增一个 Adapter 实现同样方法）：
 *   listChannels()                      -> Promise<Array>  查询可用物流渠道
 *   listCountries(channel)              -> Promise<Array>  查询某渠道支持的目的国家/地区
 *   getRules(channel, country)          -> Promise<Array>  查询指定渠道+目的地的计价规则（重量段）
 *
 * 计价引擎只吃 getRules 返回的重量段结构，与数据来源无关。
 */
(function (root, factory) {
  var api = factory(root.Core || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Core = root.Core || {};
  root.Core.Data = root.Core.Data || {};
  root.Core.Data.createLogisticsSource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  function createLogisticsSource(adapter) {
    if (!adapter || typeof adapter.listChannels !== 'function') {
      throw new Error('logistics source 需要实现 listChannels() / listCountries() / getRules()');
    }

    return {
      kind: 'logistics',
      adapterName: adapter.name || 'anonymous',

      listChannels: function () {
        return Promise.resolve(adapter.listChannels()).then(function (rows) {
          return (rows || []).map(function (c) {
            return { name: c.name, business: c.business || '', countryCount: c.countryCount || 0 };
          });
        });
      },

      listCountries: function (channel) {
        return Promise.resolve(adapter.listCountries(channel)).then(function (rows) {
          return (rows || []).map(function (c) {
            return {
              name: c.name,
              maxWeightKg: c.maxWeightKg,
              bandCount: c.bandCount,
              channel: channel
            };
          });
        });
      },

      getRules: function (channel, country) {
        return Promise.resolve(adapter.getRules(channel, country)).then(function (rows) {
          return (rows || []).map(function (r) {
            return {
              business: r.business,
              channel: r.channel,
              country: r.country,
              minWeight: Number(r.minWeight),
              maxWeight: Number(r.maxWeight),
              heavyPrice: Number(r.heavyPrice),
              piecePrice: Number(r.piecePrice),
              effectiveDate: r.effectiveDate || null
            };
          });
        });
      }
    };
  }

  return createLogisticsSource;
});
