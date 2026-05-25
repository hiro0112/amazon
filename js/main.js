'use strict';

// chartjs-plugin-datalabels を登録（CDN読み込み済みの場合のみ）
if (typeof ChartDataLabels !== 'undefined') {
  Chart.register(ChartDataLabels);
}

// ─── State ───────────────────────────────────────────────────────────────────
let masterData   = null;  // { skuToGroup: Map, groupInfo: Map }
let allSales     = [];    // [{ sku, monthKey, monthLabel, total, units }]
let months       = [];    // sorted unique monthKeys
let chartInst    = null;
let activeMonths = new Set(); // empty = 全期間

let currentModalGroup = null; // モーダル表示中の商品グループコード

// ─── LocalStorage ─────────────────────────────────────────────────────────────
const LS_MASTER = 'amazon_master_v1';
const LS_SALES  = 'amazon_sales_v1';

function lsSave(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); } catch (_) {}
}
function lsLoad(key) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch (_) { return null; }
}

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
  while (rows.length && rows[rows.length - 1].every(c => !c.trim())) rows.pop();
  return rows;
}

// ─── Encoding-aware file reader ───────────────────────────────────────────────
async function readFileText(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(buf.slice(3));
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const bad = (utf8.match(/�/g) || []).length;
  if (bad === 0 || bad / utf8.length < 0.005) return utf8;
  return new TextDecoder('shift_jis').decode(buf);
}

// ─── Product Master (商品コードCSV) ───────────────────────────────────────────
// col[0]=商品コード, col[1]=商品名, col[22]=代表商品コード
function buildMaster(rows) {
  const skuToGroup = new Map();
  const skuToName  = new Map();
  const groupInfo  = new Map();

  for (let i = 1; i < rows.length; i++) {
    const c = rows[i];
    const sku  = c[0]?.trim();
    const name = c[1]?.trim();
    const grp  = c[22]?.trim() || sku;
    if (!sku) continue;
    skuToGroup.set(sku, grp);
    if (name) skuToName.set(sku, name);
    if (!groupInfo.has(grp)) groupInfo.set(grp, { names: [] });
    if (name) groupInfo.get(grp).names.push(name);
  }

  for (const [code, info] of groupInfo) {
    info.displayName = (typeof PRODUCT_NAMES !== 'undefined' && PRODUCT_NAMES[code])
      ? PRODUCT_NAMES[code]
      : computeDisplayName(info.names, code);
  }
  return { skuToGroup, skuToName, groupInfo };
}

// 複数マスタCSVをマージ（ヘッダーは先頭ファイルのみ使用）
function mergeMasterRows(rowSets) {
  if (!rowSets.length) return [];
  const header = rowSets[0][0];
  const dataRows = rowSets.flatMap(rows => rows.slice(1));
  return [header, ...dataRows];
}

function computeDisplayName(names, fallback) {
  if (!names.length) return fallback;

  if (names.length > 1 && names.every(n => n.includes('_'))) {
    const base = names[0].split('_')[0].trim();
    if (base.length >= 3) return base;
  }

  let prefix = names[0];
  for (const n of names.slice(1)) {
    let k = 0;
    while (k < prefix.length && k < n.length && prefix[k] === n[k]) k++;
    prefix = prefix.slice(0, k);
    if (!prefix) break;
  }
  prefix = prefix.replace(/[\s_\-ー・]+$/, '').trim();
  if (prefix.length >= 5) return prefix;

  return names[0]
    .replace(/[\s_][A-Z]?\d{2,3}$/, '')
    .replace(/[\s_][SMLX]{1,3}$/, '')
    .trim() || fallback;
}

// ─── Amazon 売上CSV パーサー ──────────────────────────────────────────────────
// col[3]=親ASIN, col[6]=MSKU(自社品番), col[11]=実際の販売点数, col[13]=純売上
function parseSales(rows, filename) {
  const m = filename.match(/(\d{4})(\d{2})/);
  const monthKey   = m ? `${m[1]}-${m[2]}` : '不明';
  const monthLabel = m ? `${m[1]}年${parseInt(m[2])}月` : '不明';

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const c = rows[i];
    const sku   = c[6]?.trim();
    const asin  = c[3]?.trim() || '';
    const total = parseFloat(c[13]);
    const units = parseInt(c[11], 10) || 0;
    if (!sku || !isFinite(total) || total <= 0) continue;
    out.push({ sku, asin, monthKey, monthLabel, total, units });
  }
  return out;
}

// ─── 集計 ─────────────────────────────────────────────────────────────────────
function aggregate(salesRows, master) {
  const { skuToGroup } = master;
  const agg       = new Map();
  const groupAsin = new Map();

  for (const r of salesRows) {
    const gc = skuToGroup.get(r.sku) || r.sku;
    if (!agg.has(gc)) agg.set(gc, new Map());
    if (!groupAsin.has(gc) && r.asin) groupAsin.set(gc, r.asin);
    const mm = agg.get(gc);
    if (!mm.has(r.monthKey)) mm.set(r.monthKey, { total: 0, units: 0, label: r.monthLabel });
    const e = mm.get(r.monthKey);
    e.total  += r.total;
    e.units  += r.units;
  }

  return { agg, groupAsin };
}

function buildRows(agg, groupInfo, selectedMonths, groupAsin = new Map()) {
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
    rows.push({
      groupCode: gc,
      name: info?.displayName || gc,
      asin: groupAsin.get(gc) || '',
      total, units, monthMap: mm,
    });
  }

  rows.sort((a, b) => b.total - a.total);
  return rows;
}

// ─── SKU 別内訳 ───────────────────────────────────────────────────────────────
function buildSkuRows(groupCode, selectedMonths) {
  const allSelected = selectedMonths.size === 0;
  const skuMap = new Map();

  for (const r of allSales) {
    if ((masterData.skuToGroup.get(r.sku) || r.sku) !== groupCode) continue;
    if (!allSelected && !selectedMonths.has(r.monthKey)) continue;
    if (!skuMap.has(r.sku)) {
      skuMap.set(r.sku, {
        sku: r.sku,
        name: masterData.skuToName?.get(r.sku) || r.sku,
        total: 0,
        units: 0,
      });
    }
    const e = skuMap.get(r.sku);
    e.total += r.total;
    e.units += r.units;
  }

  return [...skuMap.values()]
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total);
}

// ─── カラー × サイズ マトリックス ────────────────────────────────────────────
const SIZE_ORDER = ['XS','SS','S','M','L','LL','XL','XXL','2XL','3L','3XL','4L','4XL','5L','5XL'];

function looksLikeSize(s) {
  if (SIZE_ORDER.includes(s.toUpperCase())) return true;
  if (/^[A-G]\d{2,3}$/.test(s)) return true; // B65, C75 など
  if (/^\d{2,3}[A-G]$/.test(s)) return true; // 65B, 75C など
  return false;
}

function parseSkuVariants(skuName) {
  const parts = skuName.split('_').map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const last       = parts[parts.length - 1];
  const secondLast = parts.length >= 3 ? parts[parts.length - 2] : null;
  if (looksLikeSize(last)) {
    return { size: last.toUpperCase(), color: secondLast || '—' };
  }
  if (secondLast && looksLikeSize(secondLast)) {
    return { size: secondLast.toUpperCase(), color: last };
  }
  // サイズ認識不可でも3分割できれば末尾をサイズ扱い
  if (parts.length >= 3) {
    return { size: last, color: secondLast };
  }
  return null;
}

function sizeCompare(a, b) {
  const ai = SIZE_ORDER.indexOf(a.toUpperCase());
  const bi = SIZE_ORDER.indexOf(b.toUpperCase());
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  const an = parseInt(a.replace(/\D/g, ''), 10) || 0;
  const bn = parseInt(b.replace(/\D/g, ''), 10) || 0;
  return an !== bn ? an - bn : a.localeCompare(b, 'ja');
}

function buildColorSizeMatrix(skuRows) {
  const cells      = new Map(); // `color__size` → units
  const colorTotal = new Map();
  const sizeSet    = new Set();
  let parseable = 0;

  for (const r of skuRows) {
    const v = parseSkuVariants(r.name);
    if (!v) continue;
    parseable++;
    const key = `${v.color}__${v.size}`;
    cells.set(key, (cells.get(key) || 0) + r.units);
    colorTotal.set(v.color, (colorTotal.get(v.color) || 0) + r.units);
    sizeSet.add(v.size);
  }

  if (parseable === 0) return null;

  const sortedColors = [...colorTotal.keys()].sort((a, b) => colorTotal.get(b) - colorTotal.get(a));
  const sortedSizes  = [...sizeSet].sort(sizeCompare);

  return { sortedColors, sortedSizes, cells, colorTotal };
}

function renderMatrix(groupCode) {
  const skuRows = buildSkuRows(groupCode, activeMonths);
  const matrix  = buildColorSizeMatrix(skuRows);
  const el      = document.getElementById('matrix-container');

  if (!matrix) {
    el.innerHTML = '<p class="matrix-empty">SKU名からカラー・サイズを読み取れませんでした。<br>商品コードCSVのSKU名が「商品名_カラー_サイズ」形式であれば表示されます。</p>';
    return;
  }

  const { sortedColors, sortedSizes, cells } = matrix;
  const maxUnits = Math.max(...cells.values(), 1);

  let html = '<div class="matrix-scroll"><table class="matrix-table"><thead><tr>';
  html += '<th class="mx-corner">カラー ╲ サイズ</th>';
  sortedSizes.forEach(s => { html += `<th class="mx-size">${esc(s)}</th>`; });
  html += '<th class="mx-total">合計</th></tr></thead><tbody>';

  sortedColors.forEach(color => {
    let rowTotal = 0;
    html += `<tr><td class="mx-color">${esc(color)}</td>`;
    sortedSizes.forEach(size => {
      const u = cells.get(`${color}__${size}`) || 0;
      rowTotal += u;
      const intensity = u / maxUnits;
      const bg   = u > 0 ? `rgba(37,99,235,${(0.12 + intensity * 0.75).toFixed(2)})` : '#f1f5f9';
      const fg   = intensity > 0.45 ? '#fff' : '#1e2a3a';
      html += `<td class="mx-cell" style="background:${bg};color:${fg}">${u > 0 ? u : ''}</td>`;
    });
    html += `<td class="mx-total-cell">${rowTotal}</td></tr>`;
  });

  // 合計行
  html += '<tr class="mx-totals"><td class="mx-color mx-total-label">合計</td>';
  let grand = 0;
  sortedSizes.forEach(size => {
    let col = 0;
    sortedColors.forEach(color => { col += cells.get(`${color}__${size}`) || 0; });
    grand += col;
    html += `<td class="mx-total-cell">${col}</td>`;
  });
  html += `<td class="mx-total-cell">${grand}</td></tr>`;
  html += '</tbody></table></div>';

  el.innerHTML = html;
}

function switchTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('tab-list').classList.toggle('hidden', tab !== 'list');
  document.getElementById('tab-matrix').classList.toggle('hidden', tab !== 'matrix');
  if (tab === 'matrix' && currentModalGroup) renderMatrix(currentModalGroup);
}

function openSkuModal(groupCode) {
  currentModalGroup = groupCode;
  switchTab('list');

  const info    = masterData?.groupInfo.get(groupCode);
  const title   = info?.displayName || groupCode;
  const skuRows = buildSkuRows(groupCode, activeMonths);

  document.getElementById('modal-title').textContent = title;

  const maxTotal = skuRows[0]?.total || 1;
  const tbody = document.getElementById('sku-body');
  tbody.innerHTML = '';

  skuRows.forEach((r, i) => {
    const rank  = i + 1;
    const pct   = Math.round((r.total / maxTotal) * 100);
    const badgeClass = rank <= 3 ? ` r${rank}` : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-rank"><span class="rank-badge${badgeClass}">${rank}</span></td>
      <td class="sku-name">${esc(r.name)}</td>
      <td class="sales-amount">${r.total.toLocaleString()}</td>
      <td class="units-count">${r.units.toLocaleString()}</td>
      <td class="bar-cell"><div class="bar-bg"><div class="bar-fill" style="width:${pct}%"></div></div></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('sku-modal').classList.remove('hidden');
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
      <td class="product-name product-name--link" title="${esc(r.name)}" data-group="${esc(r.groupCode)}">${esc(r.name)}</td>
      <td class="sales-amount">${r.total.toLocaleString()}</td>
      <td class="units-count">${r.units.toLocaleString()}</td>
      <td class="bar-cell"><div class="bar-bg"><div class="bar-fill" style="width:${pct}%"></div></div></td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Rendering: グラフ（datalabels付き） ─────────────────────────────────────
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

  const hasDatalabels = typeof ChartDataLabels !== 'undefined';

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
      layout: { padding: { right: hasDatalabels ? 190 : 10 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const r = top[ctx.dataIndex];
              return [
                `  売上：${ctx.parsed.x.toLocaleString()} 円`,
                `  販売個数：${r?.units?.toLocaleString() || 0} 個`,
              ];
            }
          }
        },
        // datalabels: 売上金額と販売個数をバーの外側に表示
        datalabels: hasDatalabels ? {
          anchor: 'end',
          align: 'end',
          clamp: false,
          formatter: (value, ctx) => {
            const r = top[ctx.dataIndex];
            const sales = value >= 1_000_000
              ? (value / 1_000_000).toFixed(1) + 'M'
              : value >= 1_000
                ? (value / 1_000).toFixed(0) + 'K'
                : value.toLocaleString();
            return `¥${sales}  ${r?.units?.toLocaleString() || 0}個`;
          },
          color: '#374151',
          font: { size: 11, weight: '600', family: '-apple-system, BlinkMacSystemFont, sans-serif' },
          padding: { left: 8 },
        } : false,
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

  const allChip = makeChip('総合計', true);
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
  const { agg, groupAsin } = aggregate(allSales, masterData);
  const rows = buildRows(agg, masterData.groupInfo, activeMonths, groupAsin);
  renderSummary(rows);
  renderTable(rows);
  renderChart(rows);
}

// ─── クリア ───────────────────────────────────────────────────────────────────
function clearAll() {
  masterData = null;
  allSales   = [];
  months     = [];
  activeMonths.clear();

  if (chartInst) { chartInst.destroy(); chartInst = null; }

  localStorage.removeItem(LS_MASTER);
  localStorage.removeItem(LS_SALES);

  // ファイル入力をリセット
  ['master-file', 'sales-file'].forEach(id => {
    document.getElementById(id).value = '';
  });

  // アップロードボックスのstateをリセット
  ['master-box', 'sales-box'].forEach(id => {
    document.getElementById(id).classList.remove('loaded', 'drag-over');
  });

  ['master-list', 'sales-list'].forEach(id => {
    const el = document.getElementById(id);
    el.innerHTML = '';
    el.classList.add('hidden');
  });

  document.getElementById('results-section').classList.add('hidden');
  document.getElementById('analyze-btn').disabled = true;
  document.getElementById('upload-hint').textContent = 'Amazon売上CSVを読み込んでください';
}

// ─── Excel Export (SheetJS) ───────────────────────────────────────────────────
// Excelフォーミュラインジェクション対策: =, +, -, @ で始まる文字列を無害化
function safeCell(value) {
  if (typeof value === 'string' && /^[=+\-@]/.test(value)) {
    return '\'' + value;
  }
  return value;
}

function exportExcel() {
  if (!masterData || !allSales.length) return;

  const wb  = XLSX.utils.book_new();
  const { agg, groupAsin } = aggregate(allSales, masterData);
  const allRows = buildRows(agg, masterData.groupInfo, new Set(), groupAsin);

  // 合計シート
  const summaryData = [['順位', '商品名', '親ASIN', '合計売上（円）', '販売個数']];
  allRows.forEach((r, i) => summaryData.push([i + 1, safeCell(r.name), safeCell(r.asin), r.total, r.units]));

  const ws0 = XLSX.utils.aoa_to_sheet(summaryData);
  ws0['!cols'] = [{ wch: 6 }, { wch: 50 }, { wch: 14 }, { wch: 18 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws0, '合計');

  // 月別シート（月ごとの売上降順で出力）
  months.forEach(mk => {
    const label = allSales.find(r => r.monthKey === mk)?.monthLabel || mk;
    const monthData = [['順位', '商品名', '親ASIN', '売上（円）', '販売個数']];
    let rank = 1;

    const monthRows = allRows
      .map(r => ({ ...r, mTotal: r.monthMap.get(mk)?.total || 0, mUnits: r.monthMap.get(mk)?.units || 0 }))
      .filter(r => r.mTotal > 0)
      .sort((a, b) => b.mTotal - a.mTotal);

    monthRows.forEach(r => monthData.push([rank++, safeCell(r.name), safeCell(r.asin), r.mTotal, r.mUnits]));

    if (monthData.length > 1) {
      const ws = XLSX.utils.aoa_to_sheet(monthData);
      ws['!cols'] = [{ wch: 6 }, { wch: 50 }, { wch: 14 }, { wch: 15 }, { wch: 10 }];
      // Excel シート名に使えない文字を除去 ( [ ] : * ? / \ )
      const sheetName = label.replace(/[\[\]:*?/\\]/g, '').slice(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
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

// ─── ファイルデータ適用（LocalStorage復元とイベントで共用） ───────────────────────
function applyMasterFiles(fileData) {
  const listEl = document.getElementById('master-list');
  listEl.innerHTML = '';
  const rowSets = [];
  for (const f of fileData) {
    try {
      rowSets.push(parseCSV(f.text));
      const p = document.createElement('p');
      p.textContent = `✓ ${f.name}`;
      listEl.appendChild(p);
    } catch (e) {
      const p = document.createElement('p');
      p.style.color = '#dc2626';
      p.textContent = `✗ ${f.name}: ${e.message}`;
      listEl.appendChild(p);
    }
  }
  if (rowSets.length) {
    masterData = buildMaster(mergeMasterRows(rowSets));
    const summary = document.createElement('p');
    summary.style.cssText = 'font-weight:700; margin-top:4px; color:#16a34a;';
    summary.textContent = `合計 ${masterData.groupInfo.size} 商品グループ`;
    listEl.appendChild(summary);
    document.getElementById('master-box').classList.add('loaded');
    listEl.classList.remove('hidden');
  } else {
    masterData = null;
  }
}

function applySalesFiles(fileData) {
  allSales = [];
  const listEl = document.getElementById('sales-list');
  listEl.innerHTML = '';
  for (const f of fileData) {
    try {
      const sales = parseSales(parseCSV(f.text), f.name);
      allSales = allSales.concat(sales);
      const p = document.createElement('p');
      p.textContent = `✓ ${f.name}（${sales.length} 件）`;
      listEl.appendChild(p);
    } catch (e) {
      const p = document.createElement('p');
      p.style.color = '#dc2626';
      p.textContent = `✗ ${f.name}: ${e.message}`;
      listEl.appendChild(p);
    }
  }
  if (fileData.length) {
    document.getElementById('sales-box').classList.add('loaded');
    listEl.classList.remove('hidden');
  }
  months = [...new Set(allSales.map(r => r.monthKey))].sort();
}

// ─── DOM Wiring ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const masterInput = document.getElementById('master-file');
  const salesInput  = document.getElementById('sales-file');
  const analyzeBtn  = document.getElementById('analyze-btn');
  const exportBtn   = document.getElementById('export-btn');
  const clearBtn    = document.getElementById('clear-btn');

  // ── 商品コードCSV（複数可） ────────────────────────────────────────────────
  masterInput.addEventListener('change', async () => {
    const files = Array.from(masterInput.files);
    if (!files.length) return;
    const fileData = [];
    for (const file of files) {
      const text = await readFileText(file);
      fileData.push({ name: file.name, text });
    }
    applyMasterFiles(fileData);
    lsSave(LS_MASTER, fileData);
    checkReady();
  });

  // ── Amazon売上CSV（複数可） ────────────────────────────────────────────────
  salesInput.addEventListener('change', async () => {
    const files = Array.from(salesInput.files);
    if (!files.length) return;
    const fileData = [];
    for (const file of files) {
      const text = await readFileText(file);
      fileData.push({ name: file.name, text });
    }
    applySalesFiles(fileData);
    lsSave(LS_SALES, fileData);
    checkReady();
  });

  // ── 分析ボタン ──────────────────────────────────────────────────────────────
  analyzeBtn.addEventListener('click', () => {
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

  // ── データクリア ─────────────────────────────────────────────────────────────
  clearBtn.addEventListener('click', clearAll);

  // ── SKU モーダル ─────────────────────────────────────────────────────────────
  document.getElementById('table-body').addEventListener('click', e => {
    const td = e.target.closest('td.product-name--link');
    if (td) openSkuModal(td.dataset.group);
  });
  const modal = document.getElementById('sku-modal');
  document.getElementById('modal-close').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.add('hidden'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') modal.classList.add('hidden'); });
  document.querySelectorAll('.modal-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

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

  // ── localStorage から前回データを復元 ─────────────────────────────────────
  (function restoreFromStorage() {
    const savedMaster = lsLoad(LS_MASTER);
    const savedSales  = lsLoad(LS_SALES);
    if (savedMaster) applyMasterFiles(savedMaster);
    if (savedSales)  applySalesFiles(savedSales);
    if (!allSales.length) return;

    checkReady();
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
    document.getElementById('results-section').classList.remove('hidden');
  })();
});
