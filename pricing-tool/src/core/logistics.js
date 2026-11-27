/**
 * 物流计费引擎 —— 基于计价规则表计算运费。
 *
 * 计价规则表结构（每行 = 一个「渠道 × 目的地 × 重量段」）：
 *   heavy_price  计重单价（元 / 公斤），作用于订单总重
 *   piece_price  件价（元 / 件），作用于订单件数
 *   min_weight / max_weight  重量段（公斤），左开右闭 (min, max]：min < 重量 ≤ max 才命中
 *
 * 运费公式：运费 = 件价 × 件数 + 计重单价 × 总重(kg)
 *
 * 引擎只认识「规则数据」，不认识数据来源（本地文件 / 未来物流 API）：
 * 只要传入同样结构的 bands 即可复用，方便未来替换数据源。
 */
(function (root, factory) {
  var api = factory(root.Core || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Core = root.Core || {};
  root.Core.Logistics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  var Errors = Core.Errors;

  var RATE_CURRENCY = 'CNY';

  /**
   * 把原始规则行整理成可查询的价目表。
   * @param {Array} rows [{business, channel, country, minWeight, maxWeight, heavyPrice, piecePrice, effectiveDate}]
   */
  function buildRateCard(rows) {
    var card = {
      channels: [],
      countries: {},
      byChannelCountry: {},
      rowCount: 0
    };
    if (!rows || !rows.length) {
      return { ok: false, error: Errors.dataMissing('物流计价规则为空，无法计算运费', { field: 'logistics' }) };
    }

    var channelMeta = {};
    var countryMeta = {};

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var ch = r.channel;
      var ctry = r.country;
      if (!ch || !ctry) continue;
      if (!channelMeta[ch]) {
        channelMeta[ch] = { name: ch, business: r.business || '', countryCount: 0 };
        card.channels.push(channelMeta[ch]);
      }
      if (!countryMeta[ch + '||' + ctry]) {
        countryMeta[ch + '||' + ctry] = { name: ctry, maxWeightKg: 0, bandCount: 0, channel: ch };
      }
      var key = ch + '||' + ctry;
      if (!card.byChannelCountry[key]) card.byChannelCountry[key] = [];
      card.byChannelCountry[key].push({
        minWeight: Number(r.minWeight),
        maxWeight: Number(r.maxWeight),
        heavyPrice: Number(r.heavyPrice),
        piecePrice: Number(r.piecePrice),
        effectiveDate: r.effectiveDate || null,
        rowIndex: i
      });
    }

    Object.keys(card.byChannelCountry).forEach(function (key) {
      var bands = card.byChannelCountry[key];
      bands.sort(function (a, b) { return a.minWeight - b.minWeight; });
      var meta = countryMeta[key];
      meta.bandCount = bands.length;
      meta.maxWeightKg = bands.length ? bands[bands.length - 1].maxWeight : 0;
      card.countries[key] = meta;
    });

    Object.keys(channelMeta).forEach(function (ch) {
      var count = 0;
      Object.keys(card.countries).forEach(function (key) {
        if (key.indexOf(ch + '||') === 0) count++;
      });
      channelMeta[ch].countryCount = count;
    });

    card.rowCount = rows.length;
    card.rateCurrency = RATE_CURRENCY;
    return { ok: true, value: card };
  }

  /** 可用物流渠道列表 */
  function listChannels(card) {
    if (!card) return [];
    return card.channels.map(function (c) {
      return { name: c.name, business: c.business, countryCount: c.countryCount };
    });
  }

  /** 某渠道支持的目的地国家/地区（含承运上限） */
  function listCountries(card, channel) {
    if (!card || !channel) return [];
    var out = [];
    Object.keys(card.countries).forEach(function (key) {
      if (key.indexOf(channel + '||') !== 0) return;
      var m = card.countries[key];
      out.push({ name: m.name, maxWeightKg: m.maxWeightKg, bandCount: m.bandCount, channel: channel });
    });
    out.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); });
    return out;
  }

  /** 取某渠道某目的地的重量段列表（UI 展示计价明细用） */
  function getBands(card, channel, country) {
    if (!card || !channel || !country) return [];
    var bands = card.byChannelCountry[channel + '||' + country];
    return bands ? bands.slice() : [];
  }

  /**
   * 在重量段中查找覆盖该重量的段。
   * 规则：左开右闭 (min, max] —— min < 重量 ≤ max 才命中（例：0.2 kg 命中 (0.1, 0.2]）。
   * 命中不到时区分「超上限」「低于最小计费段」「落在空档」三种原因。
   */
  function findBand(bands, weightKg) {
    if (!bands || !bands.length) {
      return { ok: false, error: Errors.dataMissing('该渠道与目的地没有计价规则', { field: 'logistics' }) };
    }
    for (var i = 0; i < bands.length; i++) {
      var b = bands[i];
      if (weightKg > b.minWeight && weightKg <= b.maxWeight) {
        return { ok: true, band: b, index: i };
      }
    }
    var last = bands[bands.length - 1];
    if (weightKg > last.maxWeight) {
      return {
        ok: false,
        error: Errors.unsupported(
          '订单总重 ' + weightKg.toFixed(3) + ' kg 超出该渠道承运上限 ' + last.maxWeight + ' kg',
          { field: 'weight', maxWeightKg: last.maxWeight, actualWeightKg: weightKg }
        )
      };
    }
    var first = bands[0];
    if (weightKg <= first.minWeight) {
      return {
        ok: false,
        error: Errors.unsupported(
          '订单总重 ' + weightKg.toFixed(3) + ' kg 低于该渠道规则的最小计费重量 ' + first.minWeight + ' kg（规则数据缺口，需人工确认）',
          { field: 'weight', minWeightKg: first.minWeight, actualWeightKg: weightKg }
        )
      };
    }
    return {
      ok: false,
      error: Errors.unsupported(
        '订单总重 ' + weightKg.toFixed(3) + ' kg 落在该渠道计价规则的重量空档（规则数据缺口，需人工确认）',
        { field: 'weight', actualWeightKg: weightKg }
      )
    };
  }

  /**
   * 按商品属性匹配默认物流渠道。
   * @param {object} product 商品（sensitive / oversize / elec 等布尔字段）
   * @param {Array} rules  规则数组 [{key, label, channel}]，按优先级排列
   * @param {string} fallback 无命中时的兜底渠道
   * @returns {object} {channel, rule, reason}
   */
  function matchDefaultChannel(product, rules, fallback) {
    var p = product || {};
    var list = rules || [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (p[r.key]) {
        return { channel: r.channel, rule: r, reason: r.label };
      }
    }
    return { channel: fallback, rule: null, reason: '其他' };
  }

  /**
   * 计算运费。
   * @param {object} card 价目表
   * @param {object} params {channel, country, weightKg, qty}
   * @returns {object} {ok, amountCNY, breakdown, band, trace} 或 {ok:false, error}
   */
  function calculate(card, params) {
    var channel = params && params.channel;
    var country = params && params.country;
    var weightKg = params && params.weightKg;
    var qty = params && params.qty;

    if (!channel) {
      return { ok: false, error: Errors.dataMissing('请选择物流渠道', { field: 'channel' }) };
    }
    if (!country) {
      return { ok: false, error: Errors.dataMissing('请选择目的国家/地区', { field: 'country' }) };
    }
    if (weightKg === null || weightKg === undefined || weightKg === '' || !isFinite(Number(weightKg))) {
      return { ok: false, error: Errors.dataMissing('商品重量缺失，无法按重量分段计算运费', { field: 'weight' }) };
    }
    if (Number(weightKg) <= 0) {
      return { ok: false, error: Errors.invalidInput('订单总重必须大于 0（当前 ' + weightKg + ' kg）', { field: 'weight' }) };
    }
    if (qty === null || qty === undefined || qty === '' || !isFinite(Number(qty))) {
      return { ok: false, error: Errors.dataMissing('套餐数量缺失，无法计算件价部分', { field: 'qty' }) };
    }
    if (!Number.isInteger(Number(qty)) || Number(qty) <= 0) {
      return { ok: false, error: Errors.invalidInput('套餐数量必须是正整数（当前 ' + qty + '）', { field: 'qty' }) };
    }

    if (!card || !card.byChannelCountry) {
      return {
        ok: false,
        error: Errors.dataMissing('物流计价规则（价目表）尚未装载，无法计算运费', { field: 'logistics' })
      };
    }

    var bands = getBands(card, channel, country);
    if (!bands.length) {
      return {
        ok: false,
        error: Errors.unsupported(
          '渠道「' + channel + '」不支持目的国家/地区「' + country + '」',
          { field: 'country', channel: channel, country: country }
        )
      };
    }

    var w = Number(weightKg);
    var found = findBand(bands, w);
    if (!found.ok) return { ok: false, error: found.error };

    var band = found.band;
    var pieces = Number(qty);
    var pieceSubtotal = band.piecePrice * pieces;
    var weightSubtotal = band.heavyPrice * w;
    var total = pieceSubtotal + weightSubtotal;

    var breakdown = {
      currency: RATE_CURRENCY,
      piecePriceCNY: band.piecePrice,
      pieceCount: pieces,
      pieceSubtotalCNY: pieceSubtotal,
      heavyPricePerKgCNY: band.heavyPrice,
      weightKg: w,
      weightSubtotalCNY: weightSubtotal,
      amountCNY: total,
      band: {
        minWeight: band.minWeight,
        maxWeight: band.maxWeight,
        effectiveDate: band.effectiveDate
      }
    };

    var trace = channel + ' · ' + country + ' · 重量段 (' + band.minWeight + ', ' + band.maxWeight + '] kg'
      + ' → 件价 ¥' + band.piecePrice + ' × ' + pieces + ' 件 + 计重 ¥' + band.heavyPrice + '/kg × ' + w.toFixed(3) + ' kg'
      + ' = ¥' + (Math.round(total * 100) / 100).toFixed(2);

    return { ok: true, amountCNY: total, breakdown: breakdown, band: band, trace: trace, channel: channel, country: country };
  }

  var Logistics = {
    RATE_CURRENCY: RATE_CURRENCY,
    buildRateCard: buildRateCard,
    listChannels: listChannels,
    listCountries: listCountries,
    getBands: getBands,
    findBand: findBand,
    matchDefaultChannel: matchDefaultChannel,
    calculate: calculate
  };

  return Logistics;
});
