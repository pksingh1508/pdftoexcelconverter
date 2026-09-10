import { auditExtraction } from './validation.js';
import { createEditor } from './editor.js';
/**
 * Application orchestrator: file intake -> PDF.js extraction -> (OCR fallback)
 * -> table detection -> editable preview -> SheetJS export.
 * All processing is client-side; nothing is uploaded anywhere.
 *
 * @module app
 */
import { CONFIG } from './config.js';
import {
  configurePdfWorker,
  loadPdf,
  extractPageTextItems,
  renderPageToCanvas,
  pageNeedsOcr,
  releaseCanvas,
} from './pdf-parser.js';
import {
  detectTablesOnPage,
  combineTables,
  buildFallbackTable,
} from './table-detector.js';
import { cleanTable, dropEmptyTables } from './table-cleaner.js';
import { ocrCanvas, terminateOcrEngine } from './ocr.js';
import { buildCombinedWorkbook, downloadWorkbook, outputFilename } from './excel-exporter.js';
import {
  cacheElements,
  getEls,
  toast,
  setProgress,
  showOcrNotice,
  formatBytes,
  showView,
  showResult,
  setFileError,
  renderPreview,
  setCombinedMeta,
} from './ui.js';

/** @type {{file:File|null, pdf:object|null, pageCount:number, processing:boolean, cancelled:boolean, forceOcr:boolean, tables:Array, combined:{rows:Array,header:Array,sources:Array,pageCount:number}|null, showAllRows:boolean, dirty:boolean}} */
const state = {
  file: null,
  pdf: null,
  pageCount: 0,
  processing: false,
  cancelled: false,
  forceOcr: false,
  tables: [],
  combined: null,
  showAllRows: false,
  dirty: false,
};

function isCancelled() {
  return state.cancelled;
}

function friendlyError(err) {
  if (err && err.code === 'PASSWORD_PROTECTED') return err.message;
  if (err && err.code === 'INVALID_PDF') return err.message;
  if (err && /password/i.test(String((err && err.message) || ''))) {
    return 'This PDF is password-protected. Please upload an unlocked PDF.';
  }
  if (err && /ocr/i.test(String((err && err.message) || ''))) {
    return `OCR failed: ${(err && err.message) || err}. Try a text-based PDF or fewer scanned pages.`;
  }
  return err?.message || "We couldn't read this PDF. Please try another file.";
}

let editor;

async function init() {
  cacheElements();
  const els = getEls();
  configurePdfWorker();
  editor = createEditor({ getData: () => state.combined,
    onEdit: () => { state.dirty = true; renderCombined(); }, onDownload: handleDownload });
  $('retryOcrBtn').addEventListener('click', () => convert(true));
  $('editBtn').addEventListener('click', () => editor.open(state.file));

  // Upload wiring
  els.chooseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    els.fileInput.click();
  });
  els.dropzone.addEventListener('click', (e) => {
    if (e.target === els.fileInput) return;
    els.fileInput.click();
  });
  els.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener('change', () => {
    const f = els.fileInput.files && els.fileInput.files[0];
    if (f) handleFile(f);
    els.fileInput.value = '';
  });

  for (const evt of ['dragenter', 'dragover']) {
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hasPdf = [...(e.dataTransfer?.types || [])].includes('Files');
      els.dropzone.classList.toggle('drag-over', !!hasPdf);
      els.dropzone.classList.remove('drag-invalid');
      if (hasPdf) {
        const t = $('dropzoneTitle');
        if (t) t.textContent = 'Release to upload';
      }
    });
  }
  for (const evt of ['dragleave', 'dragend']) {
    els.dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.dropzone.classList.remove('drag-over', 'drag-invalid');
      const t = $('dropzoneTitle');
      if (t) t.textContent = 'Drop your PDF here';
    });
  }
  els.dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropzone.classList.remove('drag-over', 'drag-invalid');
    const t = $('dropzoneTitle');
    if (t) t.textContent = 'Drop your PDF here';
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (!isPdf(f)) {
      els.dropzone.classList.add('drag-invalid');
      setFileError('Please upload a PDF file.');
      toast('Please upload a PDF file.');
      showView('upload');
      return;
    }
    handleFile(f);
  });
  // Prevent browser navigating away when a PDF is dropped outside the zone.
  for (const evt of ['dragover', 'drop']) {
    window.addEventListener(evt, (e) => e.preventDefault(), { passive: false });
  }

  els.removeFileBtn.addEventListener('click', resetFile);
  els.convertBtn.addEventListener('click', () => convert(false));
  els.cancelBtn.addEventListener('click', () => {
    state.cancelled = true;
    setProgress(0, 'Cancelling…');
  });
  els.downloadBtn.addEventListener('click', handleDownload);
  els.convertAnotherBtn.addEventListener('click', fullReset);
  els.forceOcrBtn.addEventListener('click', () => convert(true));
  els.showRawTextBtn.addEventListener('click', toggleRawText);
  els.showAllRowsBtn.addEventListener('click', () => {
    state.showAllRows = !state.showAllRows;
    renderCombined();
  });

  showView('upload');
  showResult(false);
}

function $(id) {
  return document.getElementById(id);
}

function isPdf(file) {
  return (
    file.type === 'application/pdf' ||
    /\.pdf$/i.test(file.name || '')
  );
}

async function handleFile(file) {
  const els = getEls();
  setFileError('');
  if (!isPdf(file)) {
    setFileError('Please upload a PDF file.');
    toast('Please upload a PDF file.');
    return;
  }
  const maxBytes = CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024;
  if (file.size > maxBytes) {
    setFileError(`File is too large. Maximum size is ${CONFIG.MAX_FILE_SIZE_MB} MB.`);
    toast(`File is too large (max ${CONFIG.MAX_FILE_SIZE_MB} MB).`);
    return;
  }
  editor.reset();
  state.pdf?.destroy();
  state.file = file;
  state.pdf = null;
  state.pageCount = 0;
  showResult(false);

  // Peek page count quickly for the file-selected state.
  els.fileName.textContent = file.name;
  els.fileDetails.textContent = `${formatBytes(file.size)} • reading…`;
  showView('file');
  try {
    configurePdfWorker();
    const { pdf, pageCount } = await loadPdf(file);
    state.pdf = pdf;
    state.pageCount = pageCount;
    els.fileDetails.textContent = `${formatBytes(file.size)} • ${pageCount} page${pageCount === 1 ? '' : 's'}`;
  } catch (err) {
    els.fileDetails.textContent = `${formatBytes(file.size)}`;
    setFileError(friendlyError(err));
  }
}

function resetFile() {
  editor.reset();
  state.pdf?.destroy();
  state.file = null;
  state.pdf = null;
  state.pageCount = 0;
  setFileError('');
  showView('upload');
}

function fullReset() {
  resetFile();
  state.tables = [];
  state.combined = null;
  state.forceOcr = false;
  state.showAllRows = false;
  showResult(false);
  showView('upload');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * Main conversion pipeline.
 * @param {boolean} forceOcr - re-run treating every page as scanned
 */
async function convert(forceOcr) {
  const els = getEls();
  if (!state.file) {
    toast('Choose a PDF first.');
    return;
  }
  if (state.processing) return;
  state.processing = true;
  state.cancelled = false;
  state.forceOcr = forceOcr;
  state.showAllRows = false;
  state.dirty = false;
  editor.reset();
  const exportErr = $('exportError');
  if (exportErr) exportErr.classList.add('hidden');

  showView('processing');
  showResult(false);
  showOcrNotice(false);
  setProgress(2, 'Loading PDF', '');

  try {
    if (!state.pdf) {
      const { pdf, pageCount } = await loadPdf(state.file);
      state.pdf = pdf;
      state.pageCount = pageCount;
    }
    const pdf = state.pdf;
    const pageCount = state.pageCount;
    /** @type {Array} all normalized items (for fallback + raw text) */
    const allItems = [];
    /** @type {Array} detected tables in page order */
    let tables = [];
    let ocrUsed = false;

    for (let p = 1; p <= pageCount; p++) {
      if (isCancelled()) throw cancelledError();
      const base = 4 + ((p - 1) / pageCount) * 88;
      setProgress(base, 'Reading pages', `Page ${p} of ${pageCount}`);
      els.processingTitle.textContent = 'Analyzing PDF…';

      let items = [];
      try {
        items = await extractPageTextItems(pdf, p);
      } catch (err) {
        console.warn(`Page ${p} text extraction failed:`, err);
        items = [];
      }

      const needsOcr = forceOcr || pageNeedsOcr(items);
      if (needsOcr) {
        if (isCancelled()) throw cancelledError();
        ocrUsed = true;
        showOcrNotice(true);
        els.processingTitle.textContent = 'Running OCR…';
        setProgress(base + 2, 'Running OCR, if required', `Page ${p} of ${pageCount} — OCR`);
        items = await ocrPage(pdf, p, (pctText) => {
          if (!isCancelled()) setProgress(base + 2, 'Running OCR, if required', `Page ${p} of ${pageCount} — ${pctText}`);
        });
      } else {
        els.processingTitle.textContent = 'Detecting tables…';
        setProgress(base + 4, 'Detecting tables', `Page ${p} of ${pageCount}`);
      }

      for (const it of items) allItems.push(it);
      // Yield to keep progress UI alive between heavy pages.
      await nextFrame();

      if (isCancelled()) throw cancelledError();
      setProgress(base + 5, 'Reconstructing rows and columns', `Page ${p} of ${pageCount}`);
      const pageTables = detectTablesOnPage(items, p);
      for (const t of pageTables) {
        t.rows = cleanTable(t.rows);
        t.title = `Table ${tables.length + 1} - Page ${p}`;
      }
      const kept = dropEmptyTables(pageTables);
      tables.push(...kept);
    }

    if (isCancelled()) throw cancelledError();
    setProgress(94, 'Cleaning data', '');
    await nextFrame();

    let fallback = null;
    if (!tables.length && allItems.length) {
      fallback = buildFallbackTable(allItems);
      if (fallback) {
        fallback.rows = cleanTable(fallback.rows);
        fallback.title = `Recovered text - Page ${fallback.pageNumbers.join(',')}`;
        if (fallback.rows.length) tables.push(fallback);
      }
    }

    // Store raw text for the "no tables" escape hatch.
    state.rawText = allItems
      .slice()
      .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x)
      .map((it) => it.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
;

    state.tables = tables;
    state.ocrUsed = ocrUsed;
    // Merge continuations, then combine EVERYTHING into one dataset:
    // a single preview grid and a single-sheet Excel download.
    state.combined = combineTables(tables);
    state.audit = auditExtraction(allItems, state.combined, pageCount);
    if (!state.audit.passed) throw new Error('Integrity check failed: extracted text was lost or duplicated during reconstruction.');

    setProgress(97, 'Preparing preview', '');
    await nextFrame();

    if (!state.combined.rows.length) {
      showNoTables();
    } else {
      showTables();
    }
    setProgress(100, 'Done', '');
  } catch (err) {
    if (err && err.code === 'CANCELLED') {
      toast('Conversion cancelled.');
      showView('file');
    } else {
      console.error(err);
      const msg = friendlyError(err);
      toast(msg);
      setFileError(msg);
      showView('file');
      // Clean up OCR worker on failure to avoid zombie workers.
      try {
        await terminateOcrEngine();
      } catch { /* ignore */ }
    }
  } finally {
    state.processing = false;
    // Always release OCR resources after a run.
    try {
      await terminateOcrEngine();
    } catch { /* ignore */ }
    const canvas = $('ocrCanvas');
    if (canvas) releaseCanvas(canvas);
  }
}

function cancelledError() {
  const e = new Error('Cancelled');
  e.code = 'CANCELLED';
  return e;
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/**
 * OCR one page: render at high scale, recognize, convert to items.
 */
async function ocrPage(pdf, pageNumber, onStage) {
  const els = getEls();
  const canvas = els.ocrCanvas || $('ocrCanvas');
  await renderPageToCanvas(pdf, pageNumber, canvas, CONFIG.OCR_SCALE);
  try {
    const items = await ocrCanvas(canvas, pageNumber, (m) => {
      if (m && m.status === 'recognizing text' && typeof m.progress === 'number') {
        onStage(`OCR ${Math.round(m.progress * 100)}%`);
      }
    });
    return items;
  } finally {
    releaseCanvas(canvas);
  }
}

function showTables() {
  const els = getEls();
  showView('file');
  // Hide upload card chrome, show results.
  els.uploadCard.querySelector('#dropzone').classList.add('hidden');
  els.fileState.classList.add('hidden');
  els.processingState.classList.add('hidden');
  showResult(true);
  $('noTablesState').classList.add('hidden');
  $('tablesWrap').classList.remove('hidden');

  const c = state.combined;
  $('resultTitle').textContent = 'Extraction complete — review your data';
  $('editBtn').disabled = false;
  $('downloadBtn').disabled = false;
  renderValidation();
  $('resultSubtitle').textContent =
    `${state.file ? state.file.name : ''}${state.ocrUsed ? ' • OCR was used for scanned pages' : ''} — review, edit, then download one Excel file.`;

  state.showAllRows = false;
  renderCombined();
  $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showNoTables() {
  const els = getEls();
  els.uploadCard.querySelector('#dropzone').classList.add('hidden');
  els.fileState.classList.add('hidden');
  els.processingState.classList.add('hidden');
  showResult(true);
  $('tablesWrap').classList.add('hidden');
  $('noTablesState').classList.remove('hidden');
  $('resultTitle').textContent = 'No tables found';
  $('editBtn').disabled = true;
  $('downloadBtn').disabled = true;
  renderValidation();
  $('resultSubtitle').textContent = state.file ? state.file.name : '';
  $('rawTextWrap').classList.add('hidden');
  $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleRawText() {
  const wrap = $('rawTextWrap');
  const pre = $('rawText');
  const show = wrap.classList.contains('hidden');
  if (show) {
    pre.textContent = state.rawText || '(No text could be extracted from this PDF.)';
    wrap.classList.remove('hidden');
  } else {
    wrap.classList.add('hidden');
  }
}

/**
 * Render the single combined preview grid (all pages/tables merged).
 * Edits write straight into state.combined.rows — exactly what gets
 * exported, so the preview is always what-you-see-is-what-you-download.
 */
function renderCombined() {
  const c = state.combined;
  if (!c || !c.rows.length) return;
  setCombinedMeta(c);
  renderValidation();
  renderPreview(c, {
    showAll: state.showAllRows,
    onEdit: (structureChanged = false) => {
      state.dirty = true;
      if (structureChanged) renderCombined();
      else setCombinedMeta(c);
    },
  });
}

function handleDownload() {
  const errEl = $('exportError');
  if (errEl) errEl.classList.add('hidden');
  try {
    if (!state.combined || !state.combined.rows.length) {
      toast('Nothing to export yet.');
      return;
    }
    const base = state.file ? state.file.name.replace(/\.[^.]+$/, '') : 'All Data';
    const wb = buildCombinedWorkbook(state.combined.rows, base, state.combined.headerRows);
    downloadWorkbook(wb, outputFilename(state.file ? state.file.name : 'tables'));
    toast(`Downloaded ${outputFilename(state.file ? state.file.name : 'tables')}`);
  } catch (err) {
    console.error(err);
    const msg = 'Excel generation failed. Try reloading the page.';
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
    }
    toast(msg);
  }
}

function renderValidation() {
  const audit = state.audit;
  if (!audit) return;
  const issues = state.combined?.issues || [];
  const reviewRows = new Set(issues.map(i => i.row)).size;
  $('validationSummary').textContent =
    `${audit.itemCount} extracted text fragments checked across ${audit.pageCount} pages. ` +
    (audit.passed ? 'No extracted text lost or duplicated during reconstruction. ' : 'Reconstruction check failed. ') +
    `${reviewRows} rows flagged for review. ` +
    (audit.ocr ? 'OCR was used: verify recognized text against the PDF. ' : '') +
    (audit.emptyPages.length ? `No text recovered on pages ${audit.emptyPages.join(', ')}; check whether they are blank or unreadable. ` : '') +
    (state.dirty ? 'Your edits are included in the download. Checks describe the original extraction. ' : '') +
    'These checks do not verify the meaning or visual accuracy of the source. Open Edit to compare with the PDF.';
  const list = $('validationIssues'); list.replaceChildren();
  const messages = new Set(issues.map(i => `Page ${i.page}, row ${i.row + 1}: ${i.message}`));
  for (const message of [...messages].slice(0, CONFIG.PREVIEW_ROW_LIMIT)) {
    const li = document.createElement('li'); li.textContent = message; list.append(li);
  }
  if (messages.size > CONFIG.PREVIEW_ROW_LIMIT) {
    const li = document.createElement('li'); li.textContent = 'More flagged rows are available using Next issue in the editor.'; list.append(li);
  }
}

document.addEventListener('DOMContentLoaded', init);
