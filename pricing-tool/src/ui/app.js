/**
 * 应用主控 —— 初始化、数据装配、事件绑定与实时重算。
 *
 * 分层：
 *   第一层 数据获取：Core.Data.createProductSource / createLogisticsSource（可换为系统 API）
 *   第二层 业务计算：Core.Calculator（纯函数，输入输出都是普通对象）
 *   第三层 页面展示：Core.UI.Render（只读状态与结果，不做业务计算）
 */
(function (root) {
  'use strict';
  var Core = root.Core;
  var D = Core.UI.Dom;
  var $ = D.$, $$ = D.$$;
  var State = Core.UI.State;
  var Render = Core.UI.Render;
  var CONFIG = root.APP_CONFIG;

  var state = State.state;
  var ctx = {
    state: state,
    scenario: null,
    rateCard: null,
    productSource: null,
    logisticsSource: null
  };

  var searchTimer = null;

  /** 向 aria-live 区域播报一句状态，让读屏用户知道「刚刚发生了什么」 */
  function announce(msg) {
    var el = $('#srLive');
    if (!el) return;
    el.textContent = '';
    // 先清空再写入：连续两次相同文案也能被重新播报
    setTimeout(function () { el.textContent = msg; }, 30);
  }

  /* ============================================================
     初始化
     ============================================================ */
  function init() {
    // 第一层：用本地适配器包装成「数据源」，未来换成系统 API 只需替换适配器
    ctx.productSource = Core.Data.createProductSource(Core.Data.localProductAdapter);
    ctx.logisticsSource = Core.Data.createLogisticsSource(Core.Data.localLogisticsAdapter);

    State.initTiers();

    $('#spuSearch').setAttribute('data-fkey', 'spu-search');
    $('#saleCurrency').value = state.saleCurrency;
    $('#fxRate').value = state.fx.USD;
    $('#baseDiscount').value = state.baseDiscountRate;

    bindEvents();

    Render.renderTierConfig(ctx);

    // 先装载物流价目表，再装载商品列表
    buildRateCard()
      .then(function () {
        ensureCountry();
        Render.renderLogistics(ctx);
        return ctx.productSource.list();
      })
      .then(function (rows) {
        state.spuTotal = rows.length;
        state.spuResults = rows.slice(0, 60);
        Render.renderSpuList(ctx);
        recalc();
      })
      .catch(function (err) {
        $('#alerts').innerHTML = '<div class="alert alert-err"><span class="alert-cat">数据缺失</span>'
          + '<div class="alert-lists"><div class="alert-list-item"><span class="alert-msg">'
          + D.esc('数据初始化失败：' + (err && err.message ? err.message : err)) + '</span></div></div></div>';
      });
  }

  /**
   * 依据渠道 / 目的地拉取计价规则，组装成可查询的价目表。
   * 这里只走数据源接口，不直接读取数据文件 —— 未来换成物流 API 时改动只在本函数内。
   */
  function buildRateCard() {
    return ctx.logisticsSource.listChannels().then(function (channels) {
      var acc = [];
      var chain = Promise.resolve();
      channels.forEach(function (ch) {
        chain = chain.then(function () {
          return ctx.logisticsSource.listCountries(ch.name).then(function (countries) {
            return Promise.all(countries.map(function (c) {
              return ctx.logisticsSource.getRules(ch.name, c.name);
            })).then(function (sets) {
              sets.forEach(function (rows) {
                rows.forEach(function (r) { acc.push(r); });
              });
            });
          });
        });
      });
      return chain.then(function () { return acc; });
    }).then(function (rows) {
      var built = Core.Logistics.buildRateCard(rows);
      if (!built.ok) throw new Error(built.error.message);
      ctx.rateCard = built.value;
      return ctx.rateCard;
    });
  }

  /** 渠道切换后，确保目的地在支持范围内 */
  function ensureCountry() {
    if (!ctx.rateCard) return;
    var chans = ctx.rateCard.channels.map(function (c) { return c.name; });
    if (chans.indexOf(state.channel) < 0) state.channel = chans[0];
    var list = Core.Logistics.listCountries(ctx.rateCard, state.channel);
    if (!list.length) return;
    var ok = list.some(function (c) { return c.name === state.country; });
    if (!ok) {
      // 渠道不支持原目的地 —— 改写目的地并留下记录，由提示区明确告知用户
      var from = state.country;
      state.country = list[0].name;
      state.logiNotice = { channel: state.channel, from: from, to: state.country };
    }
    // 注意：目的地已被支持时「不要」在此清空 logiNotice。
    // recalc() 每次都会调用本函数，清空会让「渠道切换后已自动改写目的地」的提示
    // 在页面上立刻消失。提示的作废由「渠道变更」与「用户确认目的地」两处显式处理。
  }

  /**
   * 按商品属性自动切换默认物流渠道（顺序：尺寸超限 > 带电 > 敏感 > 其他）。
   * 仅在商品本身或其相关属性变化时调用；用户手动改渠道后不会被覆盖，
   * 但会通过 channelMismatch 提示当前渠道与商品属性不符。
   */
  function applyDefaultChannel() {
    var p = state.product;
    if (!p) return;
    var m = Core.Logistics.matchDefaultChannel(p, CONFIG.logistics.channelRules, CONFIG.logistics.fallbackChannel);
    if (state.channel !== m.channel) {
      state.channel = m.channel;
      state.logiNotice = null;      // 渠道变了，目的地需要重新判定
    }
    checkChannelMatch();
  }

  /** 记录「当前渠道与商品属性不匹配」，由提示区展示 */
  function checkChannelMatch() {
    var p = state.product;
    state.channelMismatch = null;
    if (!p) return;
    var m = Core.Logistics.matchDefaultChannel(p, CONFIG.logistics.channelRules, CONFIG.logistics.fallbackChannel);
    if (state.channel !== m.channel) {
      state.channelMismatch = { reason: m.reason, expected: m.channel, actual: state.channel };
    }
  }

  /* ============================================================
     计算编排
     ============================================================ */
  function validateFx() {
    if (state.saleCurrency !== 'USD') return null;
    var v = state.fx.USD;
    if (v === null || v === undefined || v === '' || !isFinite(v) || v <= 0) {
      return Core.Errors.invalidInput(
        '美元兑人民币汇率无效（当前 ' + (v === '' || v === null || v === undefined ? '空' : v) + '），请填写大于 0 的汇率',
        { field: 'fx' });
    }
    return null;
  }

  function buildInput() {
    var p = state.product;
    return {
      // 物流价目表（计价规则）随输入一起交给计算内核；内核不关心它从哪来
      rateCard: ctx.rateCard,
      product: p ? {
        name: p.name,
        spu: p.spu,
        source: p.source,
        purchasePrice: p.purchasePrice === '' ? null : p.purchasePrice,
        purchaseCurrency: p.purchaseCurrency,
        weightG: p.weightG === '' ? null : p.weightG,
        // 是否带电：仅用于匹配默认物流渠道
        elec: !!p.elec
      } : null,
      unitSalePrice: state.unitSalePrice === '' ? null : state.unitSalePrice,
      baseDiscountRate: state.baseDiscountRate,
      tiers: state.tiers.map(function (t) {
        return {
          id: t.id,
          qty: t.qty,
          discountRate: t.discountRate,
          priceMode: t.priceMode,
          manualSalePrice: t.manualSalePrice,
          mixPercent: t.mixPercent
        };
      }),
      logistics: { channel: state.channel, country: state.country },
      adCost: state.adCost === '' ? null : state.adCost,
      saleCurrency: state.saleCurrency,
      fx: state.fx
    };
  }

  /** 输入变化 → 重算 → 刷新界面 */
  function recalc() {
    ensureCountry();
    var fxErr = validateFx();
    if (fxErr) {
      ctx.scenario = {
        ok: false, errors: [fxErr], warnings: [], product: null, tiers: [],
        mix: { validation: null, summary: null },
        currency: { sale: state.saleCurrency, rates: state.fx }
      };
    } else {
      ctx.scenario = Core.Calculator.calculate(buildInput());
    }
    D.withFocus(function () { Render.renderAll(ctx); });
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function bindEvents() {
    /* ---- 商品来源切换：按 SPU 选择 / 手动录入 ---- */
    $('#sourceSeg').addEventListener('click', function (e) {
      var btn = e.target.closest('.seg-btn');
      if (!btn) return;
      var mode = btn.getAttribute('data-source');
      if (mode === state.sourceMode) return;
      state.sourceMode = mode;
      D.$$('#sourceSeg .seg-btn').forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
      });
      $('#spuPane').classList.toggle('is-hidden', mode !== 'spu');
      $('#manualPane').classList.toggle('is-hidden', mode !== 'manual');
      // 切到「手动录入」开一张空表单；切回「按 SPU 选择」恢复上次选中的 SPU
      if (mode === 'manual') State.startManualProduct();
      else State.restoreSpuProduct();
      applyDefaultChannel();
      Render.renderProduct(ctx);
      Render.renderSpuList(ctx);
      recalc();
    });

    /* ---- SPU 检索 ---- */
    $('#spuSearch').addEventListener('input', function () {
      var kw = $('#spuSearch').value;
      state.spuKeyword = String(kw || '').trim();
      if (searchTimer) clearTimeout(searchTimer);
      var wrap = $('#spuWrap');
      if (wrap) wrap.classList.add('is-loading');   // 检索期间列表降透明度，避免闪烁与误点
      searchTimer = setTimeout(function () {
        ctx.productSource.search({ keyword: state.spuKeyword, limit: 60 }).then(function (rows) {
          state.spuResults = rows;
          D.withFocus(function () { Render.renderSpuList(ctx); });
          if (wrap) wrap.classList.remove('is-loading');
        });
      }, 140);
    });

    $('#spuBody').addEventListener('click', function (e) {
      var pick = e.target.closest('[data-pick]');
      var row = e.target.closest('tr[data-spu]');
      var spu = pick ? pick.getAttribute('data-pick') : (row ? row.getAttribute('data-spu') : null);
      if (!spu) return;
      ctx.productSource.getBySpu(spu).then(function (item) {
        if (!item) {
          state.spuResults = [];
          Render.renderSpuList(ctx);
          return;
        }
        State.setProductFromSpu(item);
        applyDefaultChannel();
        Render.renderProduct(ctx);
        Render.renderSpuList(ctx);
        recalc();
        announce('已选择 SPU ' + (item.spu || '') + '：' + (item.name || '')
          + '；单件采购成本 '
          + (item.purchasePrice === null || item.purchasePrice === undefined ? '未填写' : item.purchasePrice)
          + '，重量 '
          + (item.weightG === null || item.weightG === undefined ? '未填写' : item.weightG) + ' g');
      });
    });

    /* ---- 商品字段编辑
       手动录入：全部字段可编辑；
       SPU 模式：台账字段只读，仅「是否敏感」「是否尺寸超限」这两个选填项可由用户补充。 ---- */
    var onProductField = function (e) {
      var el = e.target.closest('[data-pf]');
      if (!el) return;
      if (!state.product) return;
      var key = el.getAttribute('data-pf');
      var f = null;
      for (var i = 0; i < State.PRODUCT_FIELDS.length; i++) {
        if (State.PRODUCT_FIELDS[i].key === key) { f = State.PRODUCT_FIELDS[i]; break; }
      }
      if (!f) return;
      var val;
      if (f.bool) {
        val = el.value === 'true';
      } else if (el.tagName === 'SELECT') {
        val = el.value;
      } else if (el.type === 'number') {
        val = el.value === '' ? null : Number(el.value);
      } else {
        val = el.value;
      }
      var before = state.product[key];
      State.setProductField(key, val);
      if (state.product[key] === before) return;      // 只读字段不允许修改，忽略
      if (key === 'elec' || key === 'sensitive' || key === 'oversize') {
        // 影响默认渠道的三个属性变化 → 切到对应的默认渠道
        applyDefaultChannel();
      }
      recalc();
    };
    $('#pcFields').addEventListener('input', onProductField);
    $('#pcFields').addEventListener('change', onProductField);

    /* ---- 定价 ---- */
    $('#unitSalePrice').addEventListener('input', function () {
      state.unitSalePrice = $('#unitSalePrice').value;
      recalc();
    });
    $('#baseDiscount').addEventListener('input', function () {
      var v = $('#baseDiscount').value;
      state.baseDiscountRate = v === '' ? '' : Number(v);
      $('#baseDiscountPct').textContent = v === '' ? '= 未设置' : ('= ' + D.pct(Number(v)));
      recalc();
    });

    /* ---- 套餐表 ---- */
    $('#addTierBtn').addEventListener('click', function () {
      State.addTier();
      Render.renderTierConfig(ctx);
      recalc();
    });

    $('#tierBody').addEventListener('input', function (e) {
      var el = e.target.closest('input');
      if (!el) return;
      var tr = el.closest('tr[data-tier]');
      if (!tr) return;
      var tier = State.getTier(tr.getAttribute('data-tier'));
      if (!tier) return;

      if (el.classList.contains('qty')) {
        tier.qty = el.value === '' ? '' : Number(el.value);
        // 数量变化后，若折扣率从未设置过，按业务默认折扣补上（不覆盖用户已填的值）
        if (tier.discountRate === '' || tier.discountRate === null || tier.discountRate === undefined) {
          var def = Core.Pricing.defaultDiscountRate(tier.qty);
          if (def !== null) {
            tier.discountRate = def;
            var rateInput = tr.querySelector('input.rate');
            if (rateInput) D.setValue(rateInput, def);
          }
        }
      } else if (el.classList.contains('rate')) {
        tier.discountRate = el.value === '' ? '' : Number(el.value);
      } else if (el.classList.contains('price')) {
        // 手动改价 → 该套餐切换为「手动调整」，此后不再被自动计算覆盖
        tier.priceMode = Core.Pricing.PRICE_MODE.MANUAL;
        tier.manualSalePrice = el.value === '' ? '' : Number(el.value);
      }
      recalc();
    });

    $('#tierBody').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var tr = btn.closest('tr[data-tier]');
      if (!tr) return;
      var id = tr.getAttribute('data-tier');
      var tier = State.getTier(id);
      if (!tier) return;
      var act = btn.getAttribute('data-act');
      if (act === 'reset') {
        tier.priceMode = Core.Pricing.PRICE_MODE.AUTO;
        tier.manualSalePrice = null;
        recalc();
      } else if (act === 'del') {
        State.removeTier(id);
        Render.renderTierConfig(ctx);
        recalc();
      }
    });

    /* ---- 成本配置 ---- */
    $('#channelSel').addEventListener('change', function () {
      state.channel = $('#channelSel').value;
      state.logiNotice = null;      // 让 ensureCountry 重新判定并生成新提示
      ensureCountry();
      checkChannelMatch();
      recalc();
    });
    $('#countrySel').addEventListener('change', function () {
      state.country = $('#countrySel').value;
      state.logiNotice = null;      // 用户已自行确认目的地
      recalc();
    });
    $('#adCost').addEventListener('input', function () {
      state.adCost = $('#adCost').value;
      recalc();
    });

    /* ---- 币种 ---- */
    $('#saleCurrency').addEventListener('change', function () {
      state.saleCurrency = $('#saleCurrency').value;
      recalc();
    });
    $('#fxRate').addEventListener('input', function () {
      var v = $('#fxRate').value;
      state.fx.USD = v === '' ? '' : Number(v);
      recalc();
    });

    /* ---- 购买占比 ---- */
    $('#mixBody').addEventListener('input', function (e) {
      var el = e.target.closest('[data-mix]');
      if (!el) return;
      var tier = State.getTier(el.getAttribute('data-mix'));
      if (!tier) return;
      tier.mixPercent = el.value;
      recalc();
    });

    /* ---- 结果表展开运费明细 ---- */
    $('#resBody').addEventListener('click', function (e) {
      var tr = e.target.closest('tr.row-main');
      if (!tr) return;
      var id = tr.getAttribute('data-tier');
      if (!id) return;
      state.expandedTierId = state.expandedTierId === id ? null : id;
      recalc();
    });

    // 键盘等价操作：聚焦套餐行后按 Enter / 空格，展开运费明细
    $('#resBody').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var tr = e.target.closest('tr.row-main');
      if (!tr || e.target !== tr) return;      // 行内控件自行处理，避免重复触发
      e.preventDefault();
      var id = tr.getAttribute('data-tier');
      if (!id) return;
      state.expandedTierId = state.expandedTierId === id ? null : id;
      recalc();
    });

    /* ---- 汇总区空态的「去填写购买占比」→ 跳回输入区并聚焦占比输入框 ---- */
    $('#metricCards').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-goto="mix"]');
      if (!btn) return;
      var group = $('#group-mix');
      if (!group) return;
      group.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var first = group.querySelector('input.pct');
      if (first) {
        try { first.focus({ preventScroll: true }); } catch (err) { first.focus(); }
      }
    });

    /* ---- 错误汇总：点条目跳到出错的输入框并聚焦 ---- */
    var errList = $('#errSummaryList');
    if (errList) {
      errList.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-errfocus]');
        if (!btn) return;
        var sel = btn.getAttribute('data-errfocus');
        var target = sel ? document.querySelector(sel) : null;
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        try { target.focus({ preventScroll: true }); } catch (err) { target.focus(); }
        // 程序化聚焦不会触发 :focus-visible（指针操作模态），补一个强可见焦点标记，
        // 让用户一眼看到落点；失焦或 2.4s 后自动撤除。
        target.classList.add('focus-flash');
        var clearFlash = function () {
          target.classList.remove('focus-flash');
          target.removeEventListener('blur', clearFlash);
        };
        target.addEventListener('blur', clearFlash);
        setTimeout(clearFlash, 2400);
        announce('已定位到出错项：' + btn.textContent.replace(/\s+/g, ' ').trim());
      });
    }

    /* ---- 快捷键：Ctrl/Cmd + Enter 重算（便于大批量调整后确认） ---- */
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); recalc(); }
    });
  }

  Core.UI.App = { init: init, recalc: recalc, ctx: ctx };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
