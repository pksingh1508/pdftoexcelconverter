/**
 * DOM rendering + interaction helpers. No extraction logic here.
 * All text from PDFs is rendered via textContent / input values (never innerHTML).
 *
 * @module ui
 */
import { CONFIG } from './config.js';

export const $ = (id) => document.getElementById(id);

const els = {};
export function cacheElements() {
  for (const id of [
    'uploadCard', 'dropzone', 'dropzoneTitle', 'fileInput', 'chooseBtn',
    'fileState', 'fileName', 'fileDetails', 'removeFileBtn', 'convertBtn', 'fileError',
    'processingState', 'processingTitle', 'processingStage', 'processingPage',
    'progressBar', 'progressFill', 'progressPct', 'ocrNotice', 'cancelBtn',
    'resultCard', 'resultTitle', 'resultSubtitle', 'tablesWrap', 'tableTabs',
    'confidencePill', 'tableMeta', 'previewTable', 'showAllRowsBtn',
    'addRowBtn', 'addColBtn', 'removeTableBtn',
    'downloadBtn', 'convertAnotherBtn',
    'noTablesState', 'forceOcrBtn', 'showRawTextBtn', 'rawTextWrap', 'rawText',
    'exportError', 'toast', 'ocrCanvas',
  ]) {
    els[id] = $(id);
  }
  return els;
}

export function getEls() {
  return els;
}

let toastTimer = null;
/** Show a transient message. */
export function toast(message) {
  const t = els.toast || $('toast');
  if (!t) return;
  t.textContent = String(message);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4200);
}

/** @param {number} pct 0..100 */
export function setProgress(pct, stage = '', pageText = '') {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  if (els.progressFill) els.progressFill.style.width = `${p}%`;
  if (els.progressBar) els.progressBar.setAttribute('aria-valuenow', String(p));
  if (els.progressPct) els.progressPct.textContent = `${p}%`;
  if (stage && els.processingStage) els.processingStage.textContent = stage;
  if (els.processingPage) els.processingPage.textContent = pageText || '';
}

export function showOcrNotice(show) {
  if (els.ocrNotice) els.ocrNotice.classList.toggle('hidden', !show);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function showView(name) {
  // name: 'upload' | 'file' | 'processing' | 'result(+file hidden)'
  const drop = els.dropzone;
  const file = els.fileState;
  const proc = els.processingState;
  if (name === 'upload') {
    drop.classList.remove('hidden');
    file.classList.add('hidden');
    proc.classList.add('hidden');
  } else if (name === 'file') {
    drop.classList.add('hidden');
    file.classList.remove('hidden');
    proc.classList.add('hidden');
  } else if (name === 'processing') {
    drop.classList.add('hidden');
    file.classList.add('hidden');
    proc.classList.remove('hidden');
  }
}

export function showResult(show) {
  if (els.resultCard) els.resultCard.classList.toggle('hidden', !show);
}

export function setFileError(msg) {
  if (!els.fileError) return;
  if (!msg) els.fileError.classList.add('hidden');
  else {
    els.fileError.textContent = msg;
    els.fileError.classList.remove('hidden');
  }
}

/**
 * Render table tabs.
 * @param {Array} tables
 * @param {number} activeIdx
 * @param {(idx:number)=>void} onSelect
 */
export function renderTabs(tables, activeIdx, onSelect) {
  const wrap = els.tableTabs;
  wrap.replaceChildren();
  tables.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    btn.setAttribute('role', 'tab');
    const label = `Table ${i + 1}${t.pageNumbers && t.pageNumbers.length === 1 ? ` — Page ${t.pageNumbers[0]}` : ''}`;
    btn.textContent = label;
    btn.setAttribute('aria-selected', String(i === activeIdx));
    btn.addEventListener('click', () => onSelect(i));
    wrap.appendChild(btn);
  });
}

/**
 * Render an editable preview table. Edits write straight back into table.rows.
 * @param {{rows:string[][]}} table
 * @param {{showAll:boolean, onEdit:()=>void}} opts
 */
export function renderPreview(table, opts) {
  const el = els.previewTable;
  el.replaceChildren();
  if (!table || !table.rows || !table.rows.length) return;

  const showAll = !!opts.showAll;
  const rows = showAll ? table.rows : table.rows.slice(0, CONFIG.PREVIEW_ROW_LIMIT + 1);
  const colCount = Math.max(...table.rows.map((r) => r.length));

  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');

  rows.forEach((row, rIdx) => {
    const tr = document.createElement('tr');
    for (let c = 0; c < colCount; c++) {
      const cell = document.createElement(rIdx === 0 ? 'th' : 'td');
      const input = document.createElement('input');
      input.className = 'cell-input';
      input.value = row[c] ?? '';
      input.setAttribute('aria-label', `Row ${rIdx + 1}, Column ${c + 1}`);
      input.addEventListener('input', () => {
        // Grow grid if user edits beyond current width (add-column case).
        while (table.rows[rIdx].length <= c) table.rows[rIdx].push('');
        table.rows[rIdx][c] = input.value;
        opts.onEdit();
      });
      cell.appendChild(input);
      tr.appendChild(cell);
    }
    // Row actions (skip header for delete? allow all but keep min 1 row).
    const act = document.createElement(rIdx === 0 ? 'th' : 'td');
    act.className = 'row-actions-cell';
    if (rIdx !== 0) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'row-btn danger';
      del.textContent = '🗑';
      del.title = `Delete row ${rIdx + 1}`;
      del.setAttribute('aria-label', `Delete row ${rIdx + 1}`);
      del.addEventListener('click', () => {
        table.rows.splice(rIdx, 1);
        opts.onEdit(true);
      });
      act.appendChild(del);
    }
    tr.appendChild(act);
    (rIdx === 0 ? thead : tbody).appendChild(tr);
  });

  el.appendChild(thead);
  el.appendChild(tbody);

  const btn = els.showAllRowsBtn;
  if (btn) {
    if (table.rows.length > CONFIG.PREVIEW_ROW_LIMIT + 1) {
      btn.classList.remove('hidden');
      btn.textContent = showAll
        ? `Showing all ${table.rows.length} rows — collapse`
        : `Show all ${table.rows.length} rows (showing ${CONFIG.PREVIEW_ROW_LIMIT + 1})`;
    } else {
      btn.classList.add('hidden');
    }
  }
}

export function setConfidence(table) {
  const pill = els.confidencePill;
  if (!pill) return;
  const label = table.confidenceLabel || '';
  pill.textContent = `${label}${typeof table.confidence === 'number' ? ` (${Math.round(table.confidence * 100)}%)` : ''}`;
  pill.className = 'confidence-pill ' + (table.confidence >= 0.7 ? 'high' : table.confidence >= 0.42 ? 'medium' : 'low');
  if (els.tableMeta) {
    const pages = (table.pageNumbers || []).join(', ');
    els.tableMeta.textContent = `Page${table.pageNumbers && table.pageNumbers.length > 1 ? 's' : ''} ${pages} • ${table.rows.length} rows × ${table.rows[0] ? table.rows[0].length : 0} cols${table.source === 'ocr' ? ' • OCR' : ''}${table.fallback ? ' • recovered text' : ''}`;
  }
}
