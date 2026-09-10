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
    'resultCard', 'resultTitle', 'resultSubtitle', 'tablesWrap',
    'confidencePill', 'tableMeta', 'previewTable', 'showAllRowsBtn',
    'addRowBtn', 'addColBtn', 'delColBtn',
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
 * Render the combined-dataset meta line + confidence pill.
 * @param {{rows:string[][], sources:Array<{pages:number[],rowCount:number,confidence:number}>}} combined
 */
export function setCombinedMeta(combined) {
  const pill = els.confidencePill;
  const rows = combined.rows || [];
  const dataRows = Math.max(0, rows.length - 1);
  const cols = rows[0] ? rows[0].length : 0;
  const pages = new Set();
  let best = 1;
  for (const s of combined.sources || []) {
    for (const p of s.pages || []) pages.add(p);
    if (typeof s.confidence === 'number') best = Math.min(best, s.confidence);
  }
  if (pill) {
    const label = (combined.issues || []).length ? 'Review needed' : 'Structure detected';
    pill.textContent = label;
    pill.className = 'confidence-pill ' + (best >= 0.7 ? 'high' : best >= 0.42 ? 'medium' : 'low');
  }
  if (els.tableMeta) {
    const pageList = [...pages].sort((a, b) => a - b);
    const scope = pageList.length
      ? `pages ${pageList[0]}–${pageList[pageList.length - 1]} (${pageList.length})`
      : 'all pages';
    els.tableMeta.textContent =
      `${rows.length} rows × ${cols} columns • ${scope}` +
      `${(combined.sources || []).length > 1 ? ` • ${combined.sources.length} sections` : ''}`;
  }
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
      const cell = document.createElement('td');
      if (table.headerRows?.includes(rIdx)) cell.classList.add('heading-cell');
      const input = document.createElement('textarea');
      input.rows = 2;
      input.readOnly = true;
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
    tbody.appendChild(tr);
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
