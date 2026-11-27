/**
 * 页面渲染 —— 只负责把「状态 + 计算结果」画到 DOM 上。
 * 不做任何业务计算：所有金额/重量/运费都来自 Core.Calculator 的输出。
 */
(function (root) {
  'use strict';
  var Core = root.Core = root.Core || {};
  Core.UI = Core.UI || {};
  var D = Core.UI.Dom;
  var Money = Core.Money;
  var $ = D.$, esc = D.esc, na = D.na;

  /** CNY → 售价币种展示值 */
  function toDisp(cny, ccy, rates) {
    if (cny === null || cny === undefined) return null;
    var r = Money.fromCNY(cny, ccy, rates);
    return r.ok ? r.value : null;
  }

  function curSymbol(ccy) {
    return (Money.CURRENCY[ccy] || { symbol: '' }).symbol;
  }

  /* ============================================================
     顶部信息 & 币种口径
     ============================================================ */
  /** 数据模式：real = 内部真实数据；sample = 公开脱敏样例数据 */
  var DATA_MODE = (root.APP_CONFIG && root.APP_CONFIG.dataMode) || 'real';

  function renderDataNotice() {
    var bar = $('#demoBar');
    if (bar) bar.hidden = (DATA_MODE !== 'sample');
  }

  function renderMeta(ctx) {
    var st = ctx.state;
    var el = $('#dataMeta');
    var lines = [];
    if (st.spuTotal) lines.push(st.spuTotal + ' 个 SPU 可检索');
    if (ctx.rateCard) {
      lines.push(ctx.rateCard.rowCount + ' 条重量段规则');
      lines.push(ctx.rateCard.channels.length + ' 个渠道');
    }
    var prefix = DATA_MODE === 'sample' ? '样例数据' : '真实数据';
    el.textContent = lines.length ? (prefix + '：' + lines.join(' · ')) : '数据加载中…';
  }

  function renderFxBar(ctx) {
    var st = ctx.state;
    var sym = curSymbol(st.saleCurrency);
    $('#fxSaleCur').textContent = sym + ' ' + (st.saleCurrency === 'USD' ? '美元' : '人民币');
    $('#fxRateText').textContent = st.saleCurrency === 'CNY'
      ? '1 ¥ = 1 ¥（本位币）'
      : '1 $ = ' + Money.format(st.fx.USD, 4) + ' ¥';
    $('#fxLabel').textContent = st.saleCurrency === 'CNY' ? '1 CNY =' : '1 USD =';
    $('#fxRate').disabled = st.saleCurrency === 'CNY';
    $('#unitPricePre').textContent = sym;
    $('#adPre').textContent = sym;
  }

  /* ============================================================
     异常提示
     ============================================================ */
  function groupByCategory(list) {
    var g = {};
    (list || []).forEach(function (e) {
      var c = e.category || '计算失败';
      if (!g[c]) g[c] = [];
      if (g[c].indexOf(e.message) < 0) g[c].push(e.message);
    });
    return g;
  }

  function renderAlerts(ctx) {
    var host = $('#alerts');
    var scenario = ctx.scenario;
    var html = '';

    var errs = (scenario && scenario.errors) || [];
    var warns = (scenario && scenario.warnings) || [];

    function box(cls, groups, emptyText) {
      var keys = Object.keys(groups);
      if (!keys.length) return '';
      var out = '<div class="alert ' + cls + '">';
      keys.forEach(function (k) {
        out += '<span class="alert-cat">' + esc(k) + '</span><div class="alert-lists">';
        groups[k].forEach(function (m) {
          out += '<div class="alert-list-item"><span class="alert-msg">' + esc(m) + '</span></div>';
        });
        out += '</div>';
      });
      out += '</div>';
      return out;
    }

    // 还没开始测算：只给一条引导，不把后续必然出现的报错提前堆成一屏
    if (!ctx.state.product) {
      html = box('alert-info', {
        '待开始': ['尚未选择或录入商品信息。请在「商品信息」中检索并选择 SPU，或切换为「手动录入」填写商品信息，并填写单件售价后即可开始测算。']
      }, '');
      // aria-live 区域被整体替换会重新播报；实时重算时逐字重播会造成读屏噪音，
      // 因此只有内容真正变化时才写入 DOM。
      if (host.getAttribute('data-sig') !== html) {
        host.setAttribute('data-sig', html);
        host.innerHTML = html;
      }
      return;
    }

    // 各套餐行内的异常（采购/物流/售价等）也汇总上来，避免被忽略
    // 同一条原因若在多个套餐重复出现，只提醒一次并说明影响范围
    var rowErrs = [];
    if (scenario && scenario.tiers) {
      var bucket = {};
      var order = [];
      scenario.tiers.forEach(function (r) {
        (r.errors || []).forEach(function (e) {
          var key = e.category + '||' + e.message;
          if (!bucket[key]) {
            bucket[key] = { category: e.category, message: e.message, qtys: [] };
            order.push(key);
          }
          bucket[key].qtys.push(r.qty);
        });
      });
      order.forEach(function (key) {
        var it = bucket[key];
        var msg = it.message;
        if (it.qtys.length > 1) {
          msg += '（影响全部 ' + it.qtys.length + ' 个套餐）';
        } else {
          msg = '【' + it.qtys[0] + ' 件套餐】' + msg;
        }
        rowErrs.push({ category: it.category, message: msg });
      });
    }

    // 渠道不支持原目的地 → 目的地被自动改写，必须明确告知，避免用户误以为仍按原目的地测算
    var notice = ctx.state.logiNotice;
    if (notice) {
      html += box('alert-warn', {
        '规则不支持': ['渠道「' + notice.channel + '」不支持目的国家/地区「' + notice.from
          + '」，已自动切换为「' + notice.to + '」。请确认目的地是否正确。']
      }, '');
    }

    // 当前渠道与商品属性不一致 → 明确提醒，避免按不符渠道计价
    var mm = ctx.state.channelMismatch;
    if (mm) {
      html += box('alert-warn', {
        '渠道与商品属性不一致': ['当前商品为「' + mm.reason + '」，默认渠道应为「'
          + mm.expected + '」，但当前选择的是「' + mm.actual + '」。请确认是否有意如此。']
      }, '');
    }

    html += box('alert-err', groupByCategory(errs), '');
    html += box('alert-err', groupByCategory(rowErrs), '');
    html += box('alert-warn', groupByCategory(warns), '');

    if (host.getAttribute('data-sig') !== html) {
      host.setAttribute('data-sig', html);
      host.innerHTML = html;
    }
  }

  /* ============================================================
     错误汇总（可聚焦 + 可跳转到出错输入框）
     依据 ui-ux-pro-max skill 指南「Focusable Error Summary」：
     错误汇总需可被键盘与读屏用户找到，且每条要能链接到对应字段，
     同时保留字段旁的就地提示。
     ============================================================ */
  var GLOBAL_FOCUS = {
    saleCurrency: '#saleCurrency',
    unitSalePrice: '#unitSalePrice',
    adCost: '#adCost',
    purchasePrice: '#pf-purchasePrice',
    purchaseCurrency: '#pf-purchaseCurrency',
    weightG: '#pf-weightG',
    product: '#spuSearch'
  };

  /** 字段 → 可聚焦元素选择器（套餐级） */
  function tierFocusTarget(field, tier) {
    if (!tier) return '';
    if (field === 'qty') return 'input[data-fkey="tier-qty-' + tier.id + '"]';
    if (field === 'discountRate') return 'input[data-fkey="tier-rate-' + tier.id + '"]';
    if (field === 'price') return 'input[data-fkey="tier-price-' + tier.id + '"]';
    if (field === 'unitSalePrice') return '#unitSalePrice';
    if (field === 'purchasePrice') return '#pf-purchasePrice';
    if (field === 'purchaseCurrency') return '#pf-purchaseCurrency';
    if (field === 'weight' || field === 'weightG') return '#pf-weightG';
    // 物流类问题（渠道 / 目的地 / 重量段 / 价目表）定位到该套餐的结果行
    return 'tr[data-fkey="res-row-' + tier.id + '"]';
  }

  function renderErrorSummary(ctx) {
    var host = $('#errSummary');
    var list = $('#errSummaryList');
    var countEl = $('#errSummaryCount');
    if (!host || !list) return;

    var st = ctx.state;
    var sc = ctx.scenario;
    var items = [];

    // 级联抑制：同一套餐里，下游错误（采购 / 重量 / 运费 / 总成本）几乎都是
    // 上游输入错误的连锁后果。汇总只保留主因，否则清单会被刷屏、反而找不到问题。
    function pickTierErrors(list) {
      var has = {};
      list.forEach(function (e) { has[e.field] = true; });
      var kept = list.filter(function (e) {
        // 数量非法 → 采购 / 重量 / 运费 / 总成本全部无法计算
        if (has.qty && (e.field === 'purchasePrice' || e.field === 'weight' || e.field === 'logistics')) return false;
        // 采购或重量缺失 → 套餐总成本不可用
        if ((has.purchasePrice || has.weight) && e.field === 'logistics') return false;
        return true;
      });
      // 同一字段只保留第一条：后续条目是同一字段更下游的描述
      var seen = {};
      return kept.filter(function (e) {
        var k = e.field || '_';
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      });
    }

    var noProduct = false;
    ((sc && sc.errors) || []).forEach(function (e) {
      if (e.field === 'product') {
        // 还没选商品：这是唯一的根因，套餐级报错全是它的连锁后果
        noProduct = true;
        items.push({ msg: e.message, cat: e.category, focus: '#spuSearch' });
        return;
      }
      items.push({ msg: e.message, cat: e.category, focus: GLOBAL_FOCUS[e.field] || '' });
    });

    if (sc && sc.tiers && !noProduct) {
      sc.tiers.forEach(function (r, i) {
        var tier = st.tiers[i];
        pickTierErrors(r.errors || []).forEach(function (e) {
          items.push({ msg: e.message, cat: e.category, focus: tierFocusTarget(e.field, tier) });
        });
      });
    }

    // 同一条原因在多个套餐重复出现时合并为一条，避免刷屏
    var merged = [];
    var byKey = {};
    items.forEach(function (it) {
      var key = it.cat + '||' + it.msg;
      if (byKey[key]) { byKey[key].n += 1; return; }
      it.n = 1;
      byKey[key] = it;
      merged.push(it);
    });
    merged.forEach(function (it) {
      if (it.n > 1) it.msg += '（影响全部 ' + it.n + ' 个套餐）';
    });

    // 签名不变就不动 DOM：role="alert" 容器内容被替换会重新播报
    var sig = merged.map(function (i) { return i.focus + '|' + i.msg; }).join('~');
    if (host.getAttribute('data-sig') === sig) return;
    host.setAttribute('data-sig', sig);

    if (!merged.length) {
      host.hidden = true;
      list.innerHTML = '';
      if (countEl) countEl.textContent = '';
      return;
    }

    host.hidden = false;
    if (countEl) countEl.textContent = '共 ' + merged.length + ' 项，点条目可跳到对应输入框';
    list.innerHTML = merged.map(function (it) {
      var inner = '<span class="err-cat">' + esc(it.cat) + '</span>' + esc(it.msg);
      if (it.focus) {
        return '<li><button type="button" class="err-link" data-errfocus="' + esc(it.focus) + '">' + inner + '</button></li>';
      }
      return '<li><span class="err-note">' + inner + '</span></li>';
    }).join('');
  }

  /* ============================================================
     SPU 列表
     ============================================================ */
  function renderSpuList(ctx) {
    var st = ctx.state;
    var body = $('#spuBody');
    var countEl = $('#spuCount');
    var rows = st.spuResults || [];

    countEl.textContent = st.spuKeyword
      ? ('匹配 ' + rows.length + ' 条 / 共 ' + st.spuTotal + ' 条')
      : ('共 ' + st.spuTotal + ' 条 SPU，输入关键词可检索');

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="6"><div class="spu-empty">'
        + (st.spuKeyword
          ? ('未找到与「' + esc(st.spuKeyword) + '」匹配的 SPU，请检查编码或商品名称是否正确')
          : '暂无可查询的 SPU 数据')
        + '</div></td></tr>';
      return;
    }

    var picked = st.product && st.product.source === 'spu' ? st.product.spu : null;
    var html = rows.map(function (r) {
      var cls = (picked && picked === r.spu) ? ' class="is-picked"' : '';
      return '<tr' + cls + ' data-spu="' + esc(r.spu) + '">'
        + '<td class="c-spu"><b>' + esc(r.spu) + '</b></td>'
        + '<td>' + esc(r.name) + (r.elec ? '<span class="tag-elec">带电</span>' : '') + '</td>'
        + '<td class="num">' + (r.purchasePrice === null ? '未提供' : '¥' + Money.format(r.purchasePrice)) + '</td>'
        + '<td class="num">' + (r.weightG === null ? '未提供' : Money.format(r.weightG, 0) + ' g') + '</td>'
        + '<td class="sub">' + esc(r.createTime || '—') + '</td>'
        + '<td class="c-act"><button type="button" class="btn-mini" data-pick="' + esc(r.spu) + '">选中</button></td>'
        + '</tr>';
    }).join('');
    body.innerHTML = html;
  }

  /* ============================================================
     商品信息卡
     ============================================================ */
  /* ============================================================
     商品信息卡
     ============================================================ */

  /** 只读展示（SPU 模式）时字段的显示文本 */
  function fieldText(f, value) {
    if (value === null || value === undefined || value === '') return '—';
    if (f.key === 'purchasePrice') return '¥' + Money.format(value);
    if (f.key === 'purchaseCurrency') {
      var opt = (f.options || []).filter(function (o) { return o.value === value; })[0];
      return opt ? opt.label : String(value);
    }
    if (f.key === 'weightG') return Money.format(value, 0) + ' g';
    if (f.key === 'elec') return value ? '带电' : '不带电';
    if (f.key === 'sensitive') return value ? '是' : '否';
    if (f.key === 'oversize') return value ? '是' : '否';
    return String(value);
  }

  /**
   * 构建商品表单。
   * 「按 SPU 选择」为只读展示（静态文本），「手动录入」为可编辑控件；
   * 两种模式 DOM 结构不同，因此按模式签名重建。
   */
  function buildProductFields(ctx, editable) {
    var S = Core.UI.State;
    var grid = $('#pcFields');
    var sig = editable ? 'edit' : 'ro';
    if (grid.getAttribute('data-sig') === sig) return;
    grid.setAttribute('data-sig', sig);

    grid.innerHTML = S.PRODUCT_FIELDS.map(function (f) {
      // 手动录入：全部可编辑；SPU 模式：台账字段只读，仅 userEditable 字段（是否敏感 / 是否尺寸超限）可补充
      var canEdit = editable || !!f.userEditable;
      var ctl;
      if (!canEdit) {
        ctl = '<div class="pc-ctl"><div class="pc-val" data-pv="' + f.key + '">—</div></div>';
      } else if (f.type === 'select') {
        ctl = '<div class="pc-ctl"><select id="pf-' + f.key + '" data-pf="' + f.key + '" data-fkey="pf-' + f.key + '">'
          + f.options.map(function (o) {
              return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>';
            }).join('')
          + '</select></div>';
      } else {
        ctl = '<div class="pc-ctl"><input id="pf-' + f.key + '" type="' + f.type + '"'
          + (f.step ? ' step="' + f.step + '"' : '')
          + ' data-pf="' + f.key + '" data-fkey="pf-' + f.key + '" />'
          + (f.suffix ? '<span class="suf">' + esc(f.suffix) + '</span>' : '')
          + '</div>';
      }
      // 可编辑字段用 <label for> 绑定控件：读屏可播报标签，点击标签聚焦输入框；
      // 只读字段保持普通文本，按 DOM 顺序朗读即可，不加 aria-label 以免重复播报。
      var keyHtml = canEdit
        ? '<label class="pc-key" for="pf-' + f.key + '">' + esc(f.label)
        : '<span class="pc-key">' + esc(f.label);
      keyHtml += (f.userEditable ? '<span class="sub user-sup">用户补充 · 选填</span>' : (f.optional ? '<span class="sub">可选</span>' : ''));
      keyHtml += canEdit ? '</label>' : '</span>';
      return '<div class="pc-field' + (f.userEditable ? ' is-user' : '') + '" data-field="' + f.key + '">'
        + keyHtml
        + ctl
        + '</div>';
    }).join('');
  }

  function renderProduct(ctx) {
    var S = Core.UI.State;
    var st = ctx.state;
    var p = st.product;

    var titleEl = $('#pcTitle');
    var badgesEl = $('#pcBadges');
    var grid = $('#pcFields');
    var noteEl = $('#pcNote');

    // 只有「手动录入」可编辑；「按 SPU 选择」为只读展示
    var editable = !!p && p.source === 'manual';

    if (!p) {
      buildProductFields(ctx, false);
      titleEl.textContent = '尚未选择商品';
      badgesEl.innerHTML = '';
      grid.style.display = 'none';
      noteEl.className = 'pc-note';
      noteEl.textContent = st.sourceMode === 'manual'
        ? '请填写商品名称、单件采购成本与单件重量。'
        : '在上方检索并选择 SPU，选中后自动带入商品信息。';
      return;
    }

    grid.style.display = '';
    buildProductFields(ctx, editable);
    titleEl.textContent = p.name || p.spu || '未命名商品';

    badgesEl.innerHTML = (p.source === 'spu'
      ? '<span class="badge badge-chip">来源：SPU 台账（只读）</span>'
      : '<span class="badge badge-chip">来源：手动录入</span>')
      + (p.source === 'spu' && (p.sensitive || p.oversize)
        ? '<span class="badge badge-user">含用户补充</span>' : '')
      + (p.elec ? '<span class="badge badge-elec">带电</span>' : '')
      + (p.sensitive ? '<span class="badge badge-flag">敏感</span>' : '')
      + (p.oversize ? '<span class="badge badge-flag">尺寸超限</span>' : '');

    // 同步字段值
    S.PRODUCT_FIELDS.forEach(function (f) {
      var v = p[f.key];
      var canEdit = editable || !!f.userEditable;
      if (canEdit) {
        var input = grid.querySelector('[data-pf="' + f.key + '"]');
        if (!input) return;
        if (f.bool) { input.value = v ? 'true' : 'false'; return; }
        if (input.tagName === 'SELECT') { input.value = (v === null || v === undefined) ? '' : String(v); return; }
        D.setValue(input, (v === null || v === undefined) ? '' : v);
      } else {
        var box = grid.querySelector('[data-pv="' + f.key + '"]');
        if (box) box.textContent = fieldText(f, v);
      }
    });

    // 说明与提醒
    var notes = [];
    if (p.source === 'spu') {
      notes.push('灰底为 SPU 台账的系统数据（只读）；「是否敏感」「是否尺寸超限」台账没有，可在此直接补充（选填）。');
    } else {
      notes.push('手动录入仅用于本次测算，不会写入 SPU 台账；商品尺寸当前不参与物流计价（现价目表只按重量计费），故未列入表单。');
    }
    var missing = [];
    if (p.purchasePrice === null || p.purchasePrice === '') missing.push('采购成本');
    if (p.weightG === null || p.weightG === '') missing.push('重量');
    if (missing.length) {
      notes.push('缺少「' + missing.join('」「') + '」，相关成本将显示「未计算」并给出原因。');
      noteEl.className = 'pc-note err';
    } else {
      noteEl.className = 'pc-note';
    }
    noteEl.textContent = notes.join(' ');
  }

  /* ============================================================
     套餐配置表
     ============================================================ */
  function renderTierConfig(ctx) {
    var st = ctx.state;
    var body = $('#tierBody');

    if (!st.tiers.length) {
      body.innerHTML = '<tr><td colspan="7"><div class="tbl-empty">'
        + '当前没有任何套餐，点击右上角「+ 添加套餐」创建（例如 5 件、6 件等，数量不限于 1~4）</div></td></tr>';
      return;
    }

    body.innerHTML = st.tiers.map(function (t, i) {
      // 行序号做进 aria-label：套餐数量会被用户改掉，用序号可保证标签长期准确
      var row = '第 ' + (i + 1) + ' 个套餐';
      return '<tr data-tier="' + t.id + '">'
        + '<td class="c-qty"><input class="qty" type="number" min="1" step="1" value="' + esc(t.qty) + '"'
        + ' aria-label="' + esc(row) + '的购买数量" aria-describedby="err-qty-' + t.id + '"'
        + ' data-fkey="tier-qty-' + t.id + '" /><span class="err-tip" id="err-qty-' + t.id + '" data-cell="qtyerr"></span></td>'
        + '<td class="c-rate"><input class="rate" type="number" min="0.01" max="1" step="0.01"'
        + ' value="' + (t.discountRate === '' ? '' : esc(t.discountRate)) + '"'
        + ' aria-label="' + esc(row) + '的折扣率" aria-describedby="err-rate-' + t.id + '"'
        + ' data-fkey="tier-rate-' + t.id + '" /><span class="err-tip" id="err-rate-' + t.id + '" data-cell="rateerr"></span></td>'
        + '<td class="num" data-cell="original">—</td>'
        + '<td class="num" data-cell="default">—</td>'
        + '<td class="c-final"><input class="price" type="number" min="0" step="0.01"'
        + ' value="' + (t.manualSalePrice === null || t.manualSalePrice === undefined ? '' : esc(t.manualSalePrice)) + '"'
        + ' aria-label="' + esc(row) + '的最终售价" aria-describedby="err-price-' + t.id + '"'
        + ' data-fkey="tier-price-' + t.id + '" /><span class="err-tip" id="err-price-' + t.id + '" data-cell="priceerr"></span></td>'
        + '<td class="c-mode"><span class="badge" data-cell="mode"></span></td>'
        + '<td class="c-act">'
        + '<button type="button" class="btn-mini" data-act="reset">恢复自动</button>'
        + '<button type="button" class="btn-mini danger" data-act="del">删除</button>'
        + '</td>'
        + '</tr>';
    }).join('');
  }

  /**
   * 定价组右上角的「默认折扣率」提示 —— 只展示业务默认值，不参与任何计算。
   * 让用户一眼看到：数量填成 1/2/3/4 时系统会自动带出哪档折扣。
   */
  function renderPricingRuleBox() {
    var box = $('#ruleBox');
    if (!box) return;
    var map = Core.Pricing.DEFAULT_DISCOUNT_BY_QTY || {};
    var keys = Object.keys(map).sort(function (a, b) { return Number(a) - Number(b); });
    if (!keys.length) { box.innerHTML = ''; return; }
    box.innerHTML = '默认折扣率：' + keys.map(function (k) {
      return esc(k) + '件 ' + D.pct(map[k]);
    }).join(' · ');
  }

  /** 只更新套餐表里的「算出来的列」，不重建 DOM（避免输入焦点丢失） */
  function updateTierComputed(ctx) {
    var st = ctx.state;
    var sc = ctx.scenario;
    var ccy = st.saleCurrency;
    var rows = D.$$('#tierBody tr[data-tier]');

    rows.forEach(function (tr, i) {
      var tier = st.tiers[i];
      var r = sc && sc.tiers ? sc.tiers[i] : null;
      if (!tier) return;

      var cell = function (name) { return tr.querySelector('[data-cell="' + name + '"]'); };
      var setHTML = function (name, html) { var e = cell(name); if (e) e.innerHTML = html; };
      var setText = function (name, txt) { var e = cell(name); if (e) e.textContent = txt; };

      // 数量 / 折扣率 / 售价 的错误
      //   uErr：单件售价缺失 —— 属于「前置条件还没填」，不是用户填错
      //   pErr：手动填写的最终售价非法 —— 属于用户填错
      var qErr = null, rErr = null, pErr = null, uErr = null;
      if (r) {
        (r.errors || []).forEach(function (e) {
          if (e.field === 'qty') qErr = e;
          else if (e.field === 'discountRate') rErr = e;
          else if (e.field === 'unitSalePrice') uErr = e;
          else if (e.field === 'price') pErr = e;
        });
      }
      var priceErr = pErr || uErr;
      // 「还没填」与「填错了」必须区分开：
      //   只有「单件售价还没填」这一类前置条件缺失 → 中性灰（.row-soft / .err-tip.soft），
      //     首屏不至于整片红、像坏了；
      //   只要包含用户自己填错的内容（数量 / 折扣率 / 最终售价）→ 警示粉（.row-warn）。
      var hasErr = !!(qErr || rErr || pErr || uErr);
      var onlyPending = hasErr && !qErr && !rErr && !pErr && !!uErr;
      var setErr = function (name, e) {
        var el = cell(name);
        if (!el) return;
        el.textContent = e ? e.message : '';
        el.classList.toggle('soft', onlyPending);
      };
      setErr('qtyerr', qErr);
      setErr('rateerr', rErr);
      setErr('priceerr', priceErr);
      tr.classList.toggle('row-warn', hasErr && !onlyPending);
      tr.classList.toggle('row-soft', onlyPending);
      // 无障碍 + 视觉：把「用户填错了」标到对应输入框上。
      // 前置条件缺失（单件售价为空）不算输入非法，否则首屏每个输入框都是红的。
      var markInvalid = function (cls, e) {
        var input = tr.querySelector('input.' + cls);
        if (!input) return;
        if (e) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
      };
      markInvalid('qty', qErr);
      markInvalid('rate', rErr);
      markInvalid('price', pErr);

      setHTML('original', r && r.originalPrice !== null && r.originalPrice !== undefined
        ? D.money(r.originalPrice, ccy) : na(rErr));
      setHTML('default', r && r.defaultSalePrice !== null && r.defaultSalePrice !== undefined
        ? D.money(r.defaultSalePrice, ccy) : na(rErr));

      var modeEl = cell('mode');
      if (modeEl) {
        if (tier.priceMode === 'manual') {
          modeEl.className = 'badge badge-fix';
          modeEl.textContent = '手动调整';
        } else {
          modeEl.className = 'badge badge-auto';
          modeEl.textContent = '自动计算';
        }
      }

      var priceInput = tr.querySelector('input.price');
      if (priceInput) {
        priceInput.classList.toggle('is-manual', tier.priceMode === 'manual');
        var shown = tier.priceMode === 'manual'
          ? tier.manualSalePrice
          : (r ? r.defaultSalePrice : null);
        D.setValue(priceInput, (shown === null || shown === undefined) ? '' : shown);
      }
    });

    // 表下说明
    var note = $('#tierNote');
    var hasManual = st.tiers.some(function (t) { return t.priceMode === 'manual'; });
    note.className = 'tbl-note';
    note.textContent = '公式：单件原价 = 单件售价 ÷ 单件折扣率；套餐原价 = 单件原价 × 数量；套餐售价 = 套餐原价 × 折扣率。'
      + (hasManual ? ' 手动改价的套餐不再被自动覆盖，点「恢复自动」即可回到自动计算值。' : '');
  }

  /* ============================================================
     物流渠道 / 国家 / 重量段规则
     ============================================================ */
  function renderLogistics(ctx) {
    var st = ctx.state;
    var chSel = $('#channelSel');
    var coSel = $('#countrySel');
    var card = ctx.rateCard;

    if (!card) return;

    // 渠道
    if (chSel.options.length !== card.channels.length) {
      chSel.innerHTML = card.channels.map(function (c) {
        return '<option value="' + esc(c.name) + '">' + esc(c.name) + '（' + c.countryCount + ' 个国家/地区）</option>';
      }).join('');
    }
    chSel.value = st.channel;

    // 国家（随渠道变化）
    var countries = Core.Logistics.listCountries(card, st.channel);
    var sig = countries.map(function (c) { return c.name; }).join('|');
    if (coSel.getAttribute('data-sig') !== sig) {
      coSel.setAttribute('data-sig', sig);
      coSel.innerHTML = countries.map(function (c) {
        return '<option value="' + esc(c.name) + '">' + esc(c.name) + '（上限 ' + Money.format(c.maxWeightKg) + ' kg）</option>';
      }).join('');
    }
    if (countries.length) {
      var exists = countries.some(function (c) { return c.name === st.country; });
      if (!exists) st.country = countries[0].name;
      coSel.value = st.country;
    } else {
      coSel.innerHTML = '<option value="">该渠道暂无可用国家/地区</option>';
    }

    // 渠道规则信息
    var meta = card.countries[st.channel + '||' + st.country];
    $('#logiInfo').innerHTML = meta
      ? ('承运上限 <b>' + Money.format(meta.maxWeightKg) + ' kg</b> · ' + meta.bandCount + ' 个重量段')
      : '当前渠道与目的地组合无规则';

    // 重量段明细
    $('#rulesTitle').textContent = st.channel + ' · ' + st.country;
    var bands = Core.Logistics.getBands(card, st.channel, st.country);
    var body = $('#rulesBody');
    if (!bands.length) {
      body.innerHTML = '<tr><td colspan="5"><div class="tbl-empty">无规则</div></td></tr>';
      return;
    }

    // 每个重量段命中了哪些套餐（用当前套餐重量判断）
    var hits = bands.map(function () { return []; });
    (ctx.scenario && ctx.scenario.tiers ? ctx.scenario.tiers : []).forEach(function (r) {
      if (r.weightKg === null || r.weightKg === undefined) return;
      var found = Core.Logistics.findBand(bands, r.weightKg);
      if (found.ok) hits[found.index].push(r.qty + ' 件');
    });

    body.innerHTML = bands.map(function (b, i) {
      var hit = hits[i];
      var cls = hit.length ? ' class="band-hit"' : '';
      return '<tr' + cls + '>'
        + '<td class="num">(' + Money.format(b.minWeight) + ', ' + Money.format(b.maxWeight) + ']</td>'
        + '<td class="num">¥' + Money.format(b.heavyPrice) + '</td>'
        + '<td class="num">¥' + Money.format(b.piecePrice) + '</td>'
        + '<td>' + esc(b.effectiveDate || '—') + '</td>'
        + '<td>' + (hit.length ? esc(hit.join('、') + ' 套餐') : '<span class="na">—</span>') + '</td>'
        + '</tr>';
    }).join('');
  }

  /* ============================================================
     套餐成本测算结果
     ============================================================ */

  /**
   * 派生展示指标 —— 只在展示层计算，不进入计算内核。
   *  - 客单系数 = 套餐客单价 ÷ 单件售价
   *  - 物流+采购费用 = 采购成本 + 物流成本（同展示币种相加）
   *  - 物流+采购费用占比 =（采购成本 + 物流成本）÷ 套餐客单价（不含广告成本）
   * 任何一项算不出来都给出具体原因，绝不用 0 代替。
   */
  function derivedMetrics(st, r, ccy, rates) {
    var out = { coef: null, coefWhy: null, sumCost: null, sumCostWhy: null, ratio: null, ratioWhy: null };

    // 客单系数
    var unitRaw = st.unitSalePrice;
    var unit = (unitRaw === '' || unitRaw === null || unitRaw === undefined) ? null : Number(unitRaw);
    if (r.finalSalePrice === null || r.finalSalePrice === undefined) {
      out.coefWhy = '套餐最终售价未确定，无法计算客单系数';
    } else if (unit === null || !isFinite(unit) || unit <= 0) {
      out.coefWhy = '单件售价未填写或无效，无法计算客单系数';
    } else {
      out.coef = r.finalSalePrice / unit;
    }

    // 物流 + 采购（同展示币种）
    var purchase = (r.purchaseDisplay === null || r.purchaseDisplay === undefined) ? null : Number(r.purchaseDisplay);
    var freight = (r.freight && r.freight.ok) ? toDisp(r.freightCNY, ccy, rates) : null;
    if (purchase === null) {
      out.sumCostWhy = '采购成本未计算，物流+采购费用不可计算';
    } else if (freight === null) {
      out.sumCostWhy = '物流成本未计算，物流+采购费用不可计算';
    } else {
      out.sumCost = purchase + freight;
    }

    // 费用占比
    if (out.sumCost === null) {
      out.ratioWhy = out.sumCostWhy || '物流+采购费用未计算，无法计算占比';
    } else if (r.finalSalePrice === null || r.finalSalePrice === undefined || !isFinite(r.finalSalePrice) || r.finalSalePrice <= 0) {
      out.ratioWhy = '套餐客单价未确定或为 0，无法计算占比';
    } else {
      out.ratio = out.sumCost / r.finalSalePrice;
    }
    return out;
  }

  function renderResults(ctx) {
    var st = ctx.state;
    var sc = ctx.scenario;
    var ccy = st.saleCurrency;
    var rates = sc ? sc.currency.rates : st.fx;
    var body = $('#resBody');

    if (!sc || !sc.tiers.length) {
      var why = (sc && sc.errors && sc.errors.length)
        ? sc.errors.map(function (e) { return '[' + e.category + '] ' + e.message; }).join('；')
        : '尚无套餐，请先在上方「套餐定价」中添加套餐';
      body.innerHTML = '<tr><td colspan="11"><div class="tbl-empty">' + D.esc(why) + '</div></td></tr>';
      $('#resultMeta').textContent = '';
      $('#resultChips').innerHTML = '';
      return;
    }

    $('#resultMeta').textContent = '共 ' + sc.tiers.length + ' 个套餐，成本口径为人民币 ¥，按汇率折算展示';

    var chips = [];
    chips.push('<span class="badge badge-chip">' + esc(st.channel || '未选择渠道') + '</span>');
    chips.push('<span class="badge badge-chip">' + esc(st.country || '未选择目的地') + '</span>');
    if (st.product && st.product.source === 'spu') {
      chips.push('<span class="badge badge-chip">SPU ' + esc(st.product.spu) + '</span>');
    }
    $('#resultChips').innerHTML = chips.join('');

    var html = '';
    sc.tiers.forEach(function (r, i) {
      var tier = st.tiers[i];
      var open = st.expandedTierId && tier && st.expandedTierId === tier.id;
      var freightDisp = r.freight && r.freight.ok ? toDisp(r.freightCNY, ccy, rates) : null;
      var freightErr = r.freight && r.freight.ok ? null : (r.freight && r.freight.error);
      var purchaseErr = null, priceErr = null, weightErr = null;
      (r.errors || []).forEach(function (e) {
        if (e.field === 'purchasePrice') purchaseErr = e;
        if (e.field === 'unitSalePrice' || e.field === 'price') priceErr = e;
        if (e.field === 'weight') weightErr = e;
      });

      var dm = derivedMetrics(st, r, ccy, rates);

      html += '<tr class="row-main' + (open ? ' is-open' : '') + '" data-tier="' + (tier ? tier.id : '') + '"'
        + ' data-fkey="res-row-' + (tier ? tier.id : '') + '"'
        + ' tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '"'
        + ' title="点击或按 Enter 展开运费计算明细">'
        + '<td class="c-qty"><span class="caret" aria-hidden="true">▸</span><b>' + esc(r.qty) + ' 件</b>'
        + (r.priceMode === 'manual' ? ' <span class="badge badge-fix">手动</span>' : '')
        + '</td>'
        + '<td class="num">' + (r.originalPrice !== null && r.originalPrice !== undefined
            ? D.money(r.originalPrice, ccy) : na(priceErr)) + '</td>'
        + '<td class="num sub">' + (r.discountRate ? D.pct(r.discountRate) : '<span class="na">未设置</span>') + '</td>'
        + '<td class="num money kpi">' + (r.finalSalePrice !== null && r.finalSalePrice !== undefined
            ? D.money(r.finalSalePrice, ccy) : na(priceErr)) + '</td>'
        + '<td class="num kpi">' + (dm.coef !== null
            ? Money.format(dm.coef, 2) + '<small>×</small>'
            : na(null, dm.coefWhy)) + '</td>'
        + '<td class="num money">' + (r.purchaseCNY !== null && r.purchaseCNY !== undefined
            ? D.money(r.purchaseDisplay, ccy) : na(purchaseErr)) + '</td>'
        + '<td class="num money">' + (freightDisp !== null
            ? D.money(freightDisp, ccy)
            : na(freightErr, '物流成本无法计算')) + '</td>'
        + '<td class="num money">' + (dm.sumCost !== null
            ? D.money(dm.sumCost, ccy)
            : na(null, dm.sumCostWhy)) + '</td>'
        + '<td class="num kpi">' + (dm.ratio !== null
            ? D.pct(dm.ratio, 1)
            : na(null, dm.ratioWhy)) + '</td>'
        + '<td class="num">' + (r.adProvided
            ? D.money(r.adDisplay, ccy)
            : '<span class="na" title="未填写每笔订单获客成本，未计入总成本">未计入</span>') + '</td>'
        + '<td class="num money kpi">' + (r.totalDisplay !== null && r.totalDisplay !== undefined
            ? D.money(r.totalDisplay, ccy) : na(purchaseErr || freightErr, '存在未计算的成本项')) + '</td>'
        + '</tr>';

      if (open) html += traceRow(ctx, r, ccy, rates);
    });
    body.innerHTML = html;
  }

  function traceRow(ctx, r, ccy, rates) {
    var st = ctx.state;
    var out = '<tr class="trace-row"><td colspan="11"><div class="trace-box">';

    if (r.freight && r.freight.ok) {
      var b = r.freight.breakdown;
      var disp = toDisp(b.amountCNY, ccy, rates);
      out += '<div class="trace-title">运费计算明细'
        + '<span class="badge badge-chip">' + esc(r.freight.breakdown.channel || st.channel) + '</span>'
        + '<span class="badge badge-chip">' + esc(st.country) + '</span>'
        + '<span class="badge badge-chip">命中重量段 (' + Money.format(b.band.minWeight) + ', '
        + Money.format(b.band.maxWeight) + '] kg</span></div>';
      out += '<div class="trace-grid">'
        + traceItem('件价（¥/件）', '¥' + Money.format(b.piecePriceCNY))
        + traceItem('订单件数', b.pieceCount + ' 件')
        + traceItem('件价小计', '¥' + Money.format(b.pieceSubtotalCNY))
        + traceItem('计重单价（¥/kg）', '¥' + Money.format(b.heavyPricePerKgCNY))
        + traceItem('订单总重', Money.format(b.weightKg, 3) + ' kg')
        + traceItem('计重小计', '¥' + Money.format(b.weightSubtotalCNY))
        + traceItem('运费合计（价目表原币）', '¥' + Money.format(b.amountCNY))
        + traceItem('运费合计（折算 ' + ccy + '）', D.money(disp, ccy))
        + traceItem('规则生效日期', esc(b.band.effectiveDate || '—'))
        + '</div>';
      out += '<div class="trace-formula">'
        + '运费 = 件价 × 件数 + 计重单价 × 总重 = '
        + '¥' + Money.format(b.piecePriceCNY) + ' × ' + b.pieceCount + ' + '
        + '¥' + Money.format(b.heavyPricePerKgCNY) + ' × ' + Money.format(b.weightKg, 3) + ' kg = '
        + '<b>¥' + Money.format(b.amountCNY) + '</b>'
        + '</div>';
    } else {
      var err = r.freight && r.freight.error;
      out += '<div class="trace-title">运费计算明细</div>'
        + '<div class="trace-err">[' + esc(err ? err.category : '计算失败') + '] '
        + esc(err ? err.message : '运费无法计算') + '</div>';
    }

    var others = (r.errors || []).filter(function (e) {
      return !(r.freight && !r.freight.ok && e === r.freight.error);
    });
    if (others.length) {
      out += '<div class="trace-formula" style="border-left-color:#be123c">本行其他提示：'
        + others.map(function (e) { return '[' + esc(e.category) + '] ' + esc(e.message); }).join('；')
        + '</div>';
    }
    out += '</div></td></tr>';
    return out;
  }

  function traceItem(k, v) {
    return '<div class="trace-item"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>';
  }

  /* ============================================================
     订单结构汇总
     ============================================================ */
  /** 占比表每行的「最终售价」单元格内容 */
  function mixPriceHtml(sc, i, ccy) {
    var r = sc && sc.tiers ? sc.tiers[i] : null;
    if (!r || r.finalSalePrice === null || r.finalSalePrice === undefined) return '<span class="na">未计算</span>';
    return D.money(r.finalSalePrice, ccy);
  }

  /**
   * 订单结构（购买占比）—— 位于「测算输入」区。
   */
  function renderMixInput(ctx) {
    var st = ctx.state;
    var sc = ctx.scenario;
    var ccy = st.saleCurrency;
    var validation = sc ? sc.mix.validation : null;

    // 占比配置表
    //
    // 关键约束：输入过程中绝不重建这张表。重建会销毁用户正在输入的 <input>，
    // 而 type=number 不支持 selectionStart/selectionEnd，光标位置无法还原，
    // Chrome 会把光标放到最前面，于是新输入的数字被插到最左边（表现为数字「从右往左」）。
    // 因此：只有套餐结构变化时才重建表格，结构不变时一律原地更新数值。
    var mixBody = $('#mixBody');
    var mixSig = st.tiers.map(function (t) { return t.id + ':' + t.qty; }).join('|');
    if (!st.tiers.length) {
      mixBody.setAttribute('data-sig', '');
      mixBody.innerHTML = '<tr><td colspan="3"><div class="tbl-empty">尚无套餐</div></td></tr>';
    } else if (mixBody.getAttribute('data-sig') !== mixSig) {
      mixBody.setAttribute('data-sig', mixSig);
      mixBody.innerHTML = st.tiers.map(function (t, i) {
        return '<tr data-mixrow="' + esc(t.id) + '"><td class="c-qty"><b>' + esc(t.qty) + ' 件</b></td>'
          + '<td class="c-pct"><input class="pct" type="number" min="0" max="100" step="0.1"'
          + ' inputmode="decimal" autocomplete="off" spellcheck="false"'
          + ' aria-label="' + esc(t.qty) + ' 件套餐的购买占比（%）" aria-describedby="mixNote"'
          + ' value="' + (t.mixPercent === '' || t.mixPercent === null ? '' : esc(t.mixPercent)) + '"'
          + ' data-fkey="mix-' + t.id + '" data-mix="' + t.id + '" /></td>'
          + '<td class="c-final sub">' + mixPriceHtml(sc, i, ccy) + '</td></tr>';
      }).join('');
    } else {
      st.tiers.forEach(function (t, i) {
        var input = mixBody.querySelector('[data-mix="' + t.id + '"]');
        if (input) D.setValue(input, (t.mixPercent === '' || t.mixPercent === null) ? '' : t.mixPercent);
        var cell = mixBody.querySelector('tr[data-mixrow="' + t.id + '"] .c-final');
        if (cell) cell.innerHTML = mixPriceHtml(sc, i, ccy);
      });
    }

    // 合计状态
    var totalEl = $('#mixTotal');
    var noteEl = $('#mixNote');
    if (!validation || validation.mode === 'none') {
      totalEl.className = 'mix-total';
      totalEl.textContent = '未设置购买占比（可选）';
      noteEl.className = 'tbl-note';
      noteEl.textContent = '占比可以不填写；一旦填写任意一档，所有套餐都需填写且合计必须等于 100%。';
    } else if (validation.mode === 'valid') {
      totalEl.className = 'mix-total ok';
      totalEl.textContent = '合计 100% ✓';
      noteEl.className = 'tbl-note ok';
      noteEl.textContent = '占比合计正确，已按占比加权计算汇总指标。';
    } else {
      totalEl.className = 'mix-total err';
      totalEl.textContent = '合计 ' + Money.format(validation.totalPercent === null ? 0 : validation.totalPercent, 2) + '% ✗';
      noteEl.className = 'tbl-note err';
      noteEl.textContent = validation.error ? validation.error.message : '占比填写有误';
    }

    renderMixBar(ctx);
  }

  /**
   * 购买占比分布条 —— 把各套餐占比画成一条堆叠条。
   * 纯展示，不参与任何计算；图示含义通过 aria-label 提供。
   */
  function renderMixBar(ctx) {
    var st = ctx.state;
    var bar = $('#mixBar');
    if (!bar) return;
    var items = [];
    st.tiers.forEach(function (t) {
      var v = (t.mixPercent === '' || t.mixPercent === null || t.mixPercent === undefined)
        ? null : Number(t.mixPercent);
      if (v !== null && isFinite(v) && v > 0) items.push({ qty: t.qty, pct: v });
    });
    if (!items.length) {
      bar.innerHTML = '';
      bar.setAttribute('aria-label', '尚未填写购买占比');
      return;
    }
    var total = items.reduce(function (a, b) { return a + b.pct; }, 0);
    bar.innerHTML = items.map(function (it) {
      return '<i style="width:' + (it.pct / total * 100).toFixed(4) + '%"'
        + ' title="' + esc(it.qty) + ' 件套餐 ' + D.pct(it.pct / 100, 1) + '"></i>';
    }).join('');
    bar.setAttribute('aria-label', '购买占比分布：'
      + items.map(function (it) { return esc(it.qty) + ' 件 ' + D.pct(it.pct / 100, 1); }).join('，')
      + '，合计 ' + D.pct(total / 100, 1));
  }

  /**
   * 订单结构加权汇总指标 —— 位于「测算结果」区。
   */
  function renderSummary(ctx) {
    var st = ctx.state;
    var sc = ctx.scenario;
    var ccy = st.saleCurrency;
    var rates = sc ? sc.currency.rates : st.fx;
    var validation = sc ? sc.mix.validation : null;
    var summary = sc ? sc.mix.summary : null;

    // 指标卡
    var cards = $('#metricCards');
    if (!validation || validation.mode === 'none') {
      cards.innerHTML = '<div class="empty-state" style="grid-column:1/-1">'
        + '未填写套餐购买占比，按规则不展示加权汇总指标。<br>在上方「订单结构（购买占比）」填写各套餐购买占比后，'
        + '这里会自动显示预计客单价与平均每单成本。'
        + '<br><button type="button" class="btn-mini" data-goto="mix">去填写购买占比</button></div>';
      return;
    }
    if (!summary || !summary.ok) {
      cards.innerHTML = '<div class="empty-state" style="grid-column:1/-1">'
        + '汇总指标暂不可计算：' + esc(summary && summary.error ? summary.error.message : '存在未计算的成本项')
        + '<br>请先修正上方提示的问题。</div>';
      return;
    }

    var m = summary.metrics;
    var adProvided = st.adCost !== '' && st.adCost !== null && st.adCost !== undefined;
    var aov = m.averageOrderValue;
    var avgPurchase = toDisp(m.avgPurchaseCost, ccy, rates);
    var avgFreight = toDisp(m.avgFreightCost, ccy, rates);
    var avgAd = toDisp(m.avgAdCost, ccy, rates);
    var avgTotal = toDisp(m.avgTotalCost, ccy, rates);
    var avgQty = m.avgQty;

    cards.innerHTML = [
      card('预计客单价', D.money(aov, ccy), 'accent'),
      card('平均每单采购成本', D.money(avgPurchase, ccy)),
      card('平均每单物流成本', D.money(avgFreight, ccy)),
      card('平均每单广告成本', adProvided ? D.money(avgAd, ccy) : '<span class="na">未提供</span>'),
      card('平均每单总成本', D.money(avgTotal, ccy), 'accent'),
      card('平均每单购买数量', Money.format(avgQty, 2) + '<small>件</small>')
    ].join('');
  }

  function card(k, v, cls) {
    return '<div class="mcard ' + (cls || '') + '"><div class="mk">' + esc(k) + '</div><div class="mv">' + v + '</div></div>';
  }

  Core.UI.Render = {
    renderMeta: renderMeta,
    renderFxBar: renderFxBar,
    renderAlerts: renderAlerts,
    renderErrorSummary: renderErrorSummary,
    renderSpuList: renderSpuList,
    renderProduct: renderProduct,
    renderTierConfig: renderTierConfig,
    updateTierComputed: updateTierComputed,
    renderPricingRuleBox: renderPricingRuleBox,
    renderLogistics: renderLogistics,
    renderResults: renderResults,
    renderMixInput: renderMixInput,
    renderMixBar: renderMixBar,
    renderSummary: renderSummary,
    renderAll: function (ctx) {
      renderDataNotice();
      renderMeta(ctx);
      renderFxBar(ctx);
      renderAlerts(ctx);
      renderErrorSummary(ctx);
      renderSpuList(ctx);
      renderProduct(ctx);
      renderPricingRuleBox(ctx);
      updateTierComputed(ctx);
      renderLogistics(ctx);
      renderResults(ctx);
      renderMixInput(ctx);
      renderSummary(ctx);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
