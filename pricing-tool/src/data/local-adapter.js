/**
 * 本地数据适配器 —— Demo 阶段读取随包发布的真实数据文件。
 *
 * 未来接入真实系统 API 时，只需新建一个 adapter 实现同样的方法，
 * 再用 Core.Data.createProductSource(adapter) / createLogisticsSource(adapter) 包装即可，
 * 业务计算层与页面层无需改动。
 *
 *   window.SPU_DATA         —— 由 SPU信息-260901~261126.xlsx 转换而来（含 elec 带电属性）
 *   window.LOGISTICS_DATA   —— 由 物流渠道计价规则-云图普电-1126最新生效.xlsx 转换而来
 */
(function (root) {
  'use strict';
  var Core = root.Core = root.Core || {};
  Core.Data = Core.Data || {};

  function spuRows() {
    return Array.isArray(root.SPU_DATA) ? root.SPU_DATA : [];
  }

  function logisticsRows() {
    return Array.isArray(root.LOGISTICS_DATA) ? root.LOGISTICS_DATA : [];
  }

  /* ---------------- 商品 ---------------- */
  Core.Data.localProductAdapter = {
    name: 'local-file (spu.data.js)',
    list: function () {
      return spuRows();
    },
    getBySpu: function (spu) {
      var key = String(spu).trim().toLowerCase();
      var hit = null;
      spuRows().forEach(function (r) {
        if (!hit && String(r.spu || '').trim().toLowerCase() === key) hit = r;
      });
      return hit;
    }
  };

  /* ---------------- 物流 ---------------- */
  Core.Data.localLogisticsAdapter = {
    name: 'local-file (logistics.data.js)',
    listChannels: function () {
      var map = {};
      logisticsRows().forEach(function (r) {
        if (!r.channel) return;
        if (!map[r.channel]) {
          map[r.channel] = { name: r.channel, business: r.business || '', countryCount: 0 };
        }
      });
      var countries = {};
      logisticsRows().forEach(function (r) {
        if (!r.channel || !r.country) return;
        var k = r.channel + '||' + r.country;
        if (!countries[k]) {
          countries[k] = { maxWeight: 0 };
          map[r.channel].countryCount += 1;
        }
        if (Number(r.maxWeight) > countries[k].maxWeight) countries[k].maxWeight = Number(r.maxWeight);
      });
      return Object.keys(map).map(function (k) { return map[k]; });
    },
    listCountries: function (channel) {
      var map = {};
      logisticsRows().forEach(function (r) {
        if (r.channel !== channel || !r.country) return;
        if (!map[r.country]) {
          map[r.country] = { name: r.country, maxWeightKg: 0, bandCount: 0 };
        }
        map[r.country].bandCount += 1;
        if (Number(r.maxWeight) > map[r.country].maxWeightKg) {
          map[r.country].maxWeightKg = Number(r.maxWeight);
        }
      });
      return Object.keys(map).map(function (k) { return map[k]; });
    },
    getRules: function (channel, country) {
      return logisticsRows().filter(function (r) {
        return r.channel === channel && r.country === country;
      });
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
