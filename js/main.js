'use strict';

// ─── State ───────────────────────────────────────────────────────────────────
let masterData = null;  // { skuToGroup: Map, groupInfo: Map }
let allSales   = [];    // [{ sku, monthKey, monthLabel, total, units }]
let months     = [];    // sorted unique monthKeys
let chartInst  = null;
let activeMonths = new Set(); // empty = 全期間

// ─── CSV Parser (RFC 4180) ────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false, i = 0;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { field += '"'; i += 2; }
      else if (c === '"')         { inQ = false; i++; }
      else                        { field += c; i++; }
    } else {
      if      (c === '"')               { inQ = true; i++; }
      else if (c === ',')               { row.push(field); field = ''; i++; }
      else if (c === '\r' && n === '\n'){ row.push(field); rows.push(row); row = []; field = ''; i += 2; }
      else if (c === '\n' || c === '\r'){ row.push(field); rows.push(row); row = []; field = ''; i++; }
      else                              { field += c; i++; }
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  // Drop empty trailing rows
  while (rows.length && rows[rows.length - 1].every(c => !c.trim())) rows.pop();
  return rows;
}

// ─── Encoding-aware file reader ───────────────────────────────────────────────
async function readFileText(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // UTF-8 BOM
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(buf.slice(3));
  }
  // Try UTF-8: count replacement chars
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const bad = (utf8.match(/�/g) || []).length;
  if (bad === 0 || bad / utf8.length < 0.005) return utf8;
  // Fallback: Shift-JIS (日本語エクセル保存ファイル対応)
  return new TextDecoder('shift_jis').decode(buf);
}

// ─── Product Master (商品コードCSV) ───────────────────────────────────────────
// col[0]=商品コード, col[1]=商品名, col[22]=代表商品コード
function buildMaster(rows) {
  const skuToGroup = new Map();
  const groupInfo  = new Map(); // groupCode → { names[], displayName }

  for (let i = 1; i < rows.length; i++) {
    const c = rows[i];
    const sku  = c[0]?.trim();
    const name = c[1]?.trim();
    const grp  = c[22]?.trim() || sku;
    if (!sku) continue;
    skuToGroup.set(sku, grp);
    if (!groupInfo.has(grp)) groupInfo.set(grp, { names: [] });
    if (name) groupInfo.get(grp).names.push(name);
  }

  for (const [code, info] of groupInfo) {
    info.displayName = computeDisplayName(info.names, code);
  }
  return { skuToGroup, groupInfo };
}

// サイズ/カラーのサフィックスを除いた商品ベース名を求める
function computeDisplayName(names, fallback) {
  if (!names.length) return fallback;

  // パターン1: アンダースコア区切り "商品名_カラー_サイズ"
  if (names.length > 1 && names.every(n => n.includes('_'))) {
    const base = names[0].split('_')[0].trim();
    if (base.length >= 3) return base;
  }

  // パターン2: 最長共通前方一致
  let prefix = names[0];
  for (const n of names.slice(1)) {
    let k = 0;
    while (k < prefix.length && k < n.length && prefix[k] === n[k]) k++;
    prefix = prefix.slice(0, k);
    if (!prefix) break;
  }
  prefix = prefix.replace(/[\s_\-ー・]+$/, '').trim();
  if (prefix.length >= 5) return prefix;

  // パターン3: 末尾のサイズコードを除去
  return names[0]
    .replace(/[\s_][A-Z]?\d{2,3}$/, '')
    .replace(/[\s_][SMLX]{1,3}$/, '')
    .trim() || fallback;
}

// ─── Amazon 売上CSV パーサー ──────────────────────────────────────────────────
// col[6]=MSKU(自社品番), col[13]=純利益合計(売上合計), col[14]=1個あたり売上
function parseSales(rows, filename) {
  const m = filename.match(/(\d{4})(\d{2})/);
  const monthKey   = m ? `${m[1]}-${m[2]}` : '不明';
  const monthLabel = m ? `${parseInt(m[2])}月` : '不明';

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const c = rows[i];
    const sku     = c[6]?.trim();
    const total   = parseFloat(c[13]);
    const perUnit = parseFloat(c[14]);
    if (!sku || !isFinite(total) || total <= 0) continue;
    const units = (isFinite(perUnit) && perUnit > 0) ? Math.round(total / perUnit) : 0;
    out.push({ sku, monthKey, monthLabel, total, units });
  }
  return out;
}

// ─── 集計 ─────────────────────────────────────────────────────────────────────
function aggregate(salesRows, master) {
  const { skuToGroup, groupInfo } = master;
  // groupCode → Map(monthKey → { total, units, label })
  const agg = new Map();

  for (const r of salesRows) {
    const gc = skuToGroup.get(r.sku) || r.sku;
    if (!agg.has(gc)) agg.set(gc, new Map());
    const mm = agg.get(gc);
    if (!mm.has(r.monthKey)) mm.set(r.monthKey, { total: 0, units: 0, label: r.monthLabel });
    const e = mm.get(r.monthKey);
    e.total  += r.total;
    e.units  += r.units;
  }

  return agg;
}

// 選択月で絞った結果行を生成（売上降順）
function buildRows(agg, groupInfo, selectedMonths) {
  const allSelected = selectedMonths.size === 0;
  const rows = [];

  for (const [gc, mm] of agg) {
    let total = 0, units = 0;
    for (const [mk, d] of mm) {
      if (allSelected || selectedMonths.has(mk)) {
        total  += d.total;
        units  += d.units;
      }
    }
    if (total <= 0) continue;
    const info = groupInfo.get(gc);
    rows.push({ groupCode: gc, name: info?.displayName || gc, total, units, monthMap: mm });
  }

  rows.sort((a, b) => b.total - a.total);
  return rows;
}

// ─── Rendering: サマリーカード ────────────────────────────────────────────────
function renderSummary(rows) {
  const totalSales = rows.reduce((s, r) => s + r.total, 0);
  const totalUnits = rows.reduce((s, r) => s + r.units, 0);
  const products   = rows.length;

  document.getElementById('summary-cards').innerHTML = `
    <div class="summary-card">
      <div class="sc-label">合計売上</div>
      <div class="sc-value">${totalSales.toLocaleString()}<span class="sc-unit">円</span></div>
    </div>
    <div class="summary-card">
      <div class="sc-label">合計販売個数</div>
      <div class="sc-value">${totalUnits.toLocaleString()}<span class="sc-unit">個</span></div>
    </div>
    <div class="summary-card">
      <div class="sc-label">商品種数</div>
      <div class="sc-value">${products}<span class="sc-unit">商品</span></div>
    </div>
  `;
}

// ─── Rendering: テーブル ──────────────────────────────────────────────────────
function renderTable(rows) {
  const maxSales = rows[0]?.total || 1;
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';

  rows.forEach((r, i) => {
    const rank = i + 1;
    const badgeClass = rank <= 3 ? ` r${rank}` : '';
    const pct = Math.round((r.total / maxSales) * 100);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-rank"><span class="rank-badge${badgeClass}">${rank}</span></td>
      <td class="product-name" title="${esc(r.name)}">${esc(r.name)}</td>
      <td class="sales-amount">${r.total.toLocaleString()}</td>
      <td class="units-count">${r.units.toLocaleString()}</td>
      <td class="bar-cell"><div class="bar-bg"><div class="bar-fill" style="width:${pct}%"></div></div></td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Rendering: グラフ ────────────────────────────────────────────────────────
function renderChart(rows) {
  const top    = rows.slice(0, 15);
  const labels = top.map(r => r.name.length > 28 ? r.name.slice(0, 28) + '…' : r.name);
  const data   = top.map(r => r.total);
  const colors = top.map((_, i) => {
    const alpha = 1 - (i / top.length) * 0.45;
    return `rgba(37, 99, 235, ${alpha})`;
  });

  const ctx = document.getElementById('chart').getContext('2d');
  if (chartInst) chartInst.destroy();

  chartInst = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '売上（円）',
        data,
        backgroundColor: colors,
        borderRadius: 4,
        borderSkipped: false,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `  ${ctx.parsed.x.toLocaleString()} 円`
          }
        }
      },
      scales: {
        x: {
          grid: { color: '#f0f4f8' },
          ticks: {
            callback: v => v >= 1_000_000 ? (v / 1_000_000).toFixed(1) + 'M'
                        : v >= 1_000     ? (v / 1_000).toFixed(0) + 'K'
                        : v
          }
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 11 }, color: '#374151' }
        }
      }
    }
  });
}

// ─── Rendering: 月チップ ──────────────────────────────────────────────────────
function renderMonthChips() {
  const container = document.getElementById('month-chips');
  container.innerHTML = '';

  const allChip = makeChip('すべて', true);
  allChip.addEventListener('click', () => {
    activeMonths.clear();
    container.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    allChip.classList.add('active');
    refresh();
  });
  container.appendChild(allChip);

  months.forEach(mk => {
    const label = allSales.find(r => r.monthKey === mk)?.monthLabel || mk;
    const chip = makeChip(label, false);
    chip.dataset.month = mk;
    chip.addEventListener('click', () => {
      const allC = container.querySelector('.chip');
      if (activeMonths.has(mk)) {
        activeMonths.delete(mk);
        chip.classList.remove('active');
        if (activeMonths.size === 0) allC.classList.add('active');
      } else {
        activeMonths.add(mk);
        chip.classList.add('active');
        allC.classList.remove('active');
      }
      refresh();
    });
    container.appendChild(chip);
  });
}

function makeChip(label, active) {
  const el = document.createElement('button');
  el.className = 'chip' + (active ? ' active' : '');
  el.type = 'button';
  el.textContent = label;
  return el;
}

// ─── Refresh ──────────────────────────────────────────────────────────────────
function refresh() {
  if (!masterData || !allSales.length) return;
  const agg  = aggregate(allSales, masterData);
  const rows = buildRows(agg, masterData.groupInfo, activeMonths);
  renderSummary(rows);
  renderTable(rows);
  renderChart(rows);
}

// ─── Excel Export (SheetJS) ───────────────────────────────────────────────────
function exportExcel() {
  if (!masterData || !allSales.length) return;

  const wb  = XLSX.utils.book_new();
  const agg = aggregate(allSales, masterData);

  // 合計シート
  const allRows = buildRows(agg, masterData.groupInfo, new Set());
  const summaryData = [['順位', '商品名', '合計売上（円）', '販売個数']];
  allRows.forEach((r, i) => summaryData.push([i + 1, r.name, r.total, r.units]));

  const ws0 = XLSX.utils.aoa_to_sheet(summaryData);
  // 列幅設定
  ws0['!cols'] = [{ wch: 6 }, { wch: 50 }, { wch: 18 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws0, '合計');

  // 月別シート
  months.forEach(mk => {
    const label = allSales.find(r => r.monthKey === mk)?.monthLabel || mk;
    const monthData = [['順位', '商品名', '売上（円）', '販売個数']];
    let rank = 1;
    // 当月売上で降順ソート
    const monthRows = allRows
      .map(r => ({ ...r, mTotal: r.monthMap.get(mk)?.total || 0, mUnits: r.monthMap.get(mk)?.units || 0 }))
      .filter(r => r.mTotal > 0)
      .sort((a, b) => b.mTotal - a.mTotal);
    monthRows.forEach(r => monthData.push([rank++, r.name, r.mTotal, r.mUnits]));

    if (monthData.length > 1) {
      const ws = XLSX.utils.aoa_to_sheet(monthData);
      ws['!cols'] = [{ wch: 6 }, { wch: 50 }, { wch: 15 }, { wch: 10 }];
      XLSX.utils.book_append_sheet(wb, ws, label);
    }
  });

  XLSX.writeFile(wb, 'amazon_売上分析.xlsx');
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── DOM Wiring ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const masterInput = document.getElementById('master-file');
  const salesInput  = document.getElementById('sales-file');
  const analyzeBtn  = document.getElementById('analyze-btn');
  const exportBtn   = document.getElementById('export-btn');

  // ── 商品コードCSV ──────────────────────────────────────────────────────────
  masterInput.addEventListener('change', async () => {
    const file = masterInput.files[0];
    if (!file) return;
    try {
      const text = await readFileText(file);
      const rows = parseCSV(text);
      masterData = buildMaster(rows);
      const box = document.getElementById('master-box');
      box.classList.add('loaded');
      const badge = document.getElementById('master-badge');
      badge.textContent = `✓ ${file.name}（${masterData.groupInfo.size}商品グループ）`;
      badge.classList.remove('hidden');
    } catch (e) {
      alert('商品コードCSVの読み込みに失敗しました: ' + e.message);
      masterData = null;
    }
    checkReady();
  });

  // ── Amazon売上CSV（複数可） ────────────────────────────────────────────────
  salesInput.addEventListener('change', async () => {
    const files = Array.from(salesInput.files);
    if (!files.length) return;

    allSales = [];
    const listEl = document.getElementById('sales-list');
    listEl.innerHTML = '';

    for (const file of files) {
      try {
        const text = await readFileText(file);
        const rows = parseCSV(text);
        const sales = parseSales(rows, file.name);
        allSales = allSales.concat(sales);
        const p = document.createElement('p');
        p.textContent = `✓ ${file.name}（${sales.length} 件）`;
        listEl.appendChild(p);
      } catch (e) {
        const p = document.createElement('p');
        p.style.color = '#dc2626';
        p.textContent = `✗ ${file.name}: ${e.message}`;
        listEl.appendChild(p);
      }
    }

    if (files.length > 0) {
      document.getElementById('sales-box').classList.add('loaded');
      listEl.classList.remove('hidden');
    }

    months = [...new Set(allSales.map(r => r.monthKey))].sort();
    checkReady();
  });

  // ── 分析ボタン ──────────────────────────────────────────────────────────────
  analyzeBtn.addEventListener('click', () => {
    // 商品コードCSVがない場合は MSKU をそのまま代表コードとして処理
    if (!masterData) {
      const skuToGroup = new Map();
      const groupInfo  = new Map();
      for (const r of allSales) {
        skuToGroup.set(r.sku, r.sku);
        if (!groupInfo.has(r.sku)) groupInfo.set(r.sku, { names: [r.sku], displayName: r.sku });
      }
      masterData = { skuToGroup, groupInfo };
    }

    activeMonths.clear();
    renderMonthChips();
    refresh();

    const sec = document.getElementById('results-section');
    sec.classList.remove('hidden');
    sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ── Excelダウンロード ────────────────────────────────────────────────────────
  exportBtn.addEventListener('click', exportExcel);

  // ── ドラッグ＆ドロップ ───────────────────────────────────────────────────────
  ['master-box', 'sales-box'].forEach(id => {
    const box = document.getElementById(id);
    box.addEventListener('dragover',  e => { e.preventDefault(); box.classList.add('drag-over'); });
    box.addEventListener('dragleave', ()  => box.classList.remove('drag-over'));
    box.addEventListener('drop', e => {
      e.preventDefault();
      box.classList.remove('drag-over');
      const input = box.querySelector('input[type="file"]');
      const dt = new DataTransfer();
      Array.from(e.dataTransfer.files).forEach(f => dt.items.add(f));
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    });
  });

  function checkReady() {
    const ok = allSales.length > 0;
    analyzeBtn.disabled = !ok;
    const hint = document.getElementById('upload-hint');
    if (ok && masterData) {
      hint.textContent = '準備完了！「分析する」をクリックしてください';
    } else if (ok) {
      hint.textContent = '売上CSVを読み込みました（商品コードCSVなしで分析可）';
    } else {
      hint.textContent = 'Amazon売上CSVを読み込んでください';
    }
  }
});
