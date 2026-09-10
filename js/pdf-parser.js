/**
 * PDF loading + text-position extraction via PDF.js.
 * Produces normalized text items shared by the whole pipeline:
 *   { text, x, y, width, height, page, source }
 * Coordinates are normalized to a TOP-LEFT origin (y grows downward)
 * so PDF.js output and Tesseract OCR output share one system.
 *
 * @module pdf-parser
 */
import { CONFIG } from './config.js';

function getPdfJs() {
  const lib = globalThis.pdfjsLib;
  if (!lib) throw new Error('PDF.js library failed to load. Check your connection and reload.');
  return lib;
}

/**
 * Configure the PDF.js worker. Must be called once before loading.
 */
export function configurePdfWorker() {
  try {
    const lib = getPdfJs();
    if (!lib.GlobalWorkerOptions.workerSrc) {
      lib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  } catch {
    // getPdfJs throws a friendly error later; ignore here.
  }
}

/**
 * Load a PDF from a File object.
 * @param {File} file
 * @returns {Promise<{pdf: object, pageCount: number}>}
 */
export async function loadPdf(file) {
  const lib = getPdfJs();
  const buffer = await file.arrayBuffer();
  let pdf;
  try {
    const task = lib.getDocument({ data: buffer });
    pdf = await task.promise;
  } catch (err) {
    throw friendlyPdfError(err);
  }
  return { pdf, pageCount: pdf.numPages };
}

function friendlyPdfError(err) {
  const msg = String((err && err.message) || err || '');
  if (/password/i.test(msg) || (err && err.name === 'PasswordException')) {
    const e = new Error('This PDF is password-protected. Please upload an unlocked PDF.');
    e.code = 'PASSWORD_PROTECTED';
    return e;
  }
  if (/invalid|corrupt|damaged|trailer|xref/i.test(msg)) {
    const e = new Error("We couldn't read this PDF. It may be corrupted or not a valid PDF.");
    e.code = 'INVALID_PDF';
    return e;
  }
  const e = new Error("We couldn't read this PDF. It may be corrupted or password-protected.");
  e.code = 'PDF_READ_ERROR';
  e.cause = err;
  return e;
}

/**
 * Extract positioned text items from one page.
 * @param {object} pdf - PDF.js document
 * @param {number} pageNumber - 1-based
 * @returns {Promise<Array<{text:string,x:number,y:number,width:number,height:number,page:number,source:string}>>}
 */
export async function extractPageTextItems(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale: 1 });
    const pageHeight = viewport.height;
    const textContent = await page.getTextContent();

    /** @type {Array} */
    const items = [];
    for (const raw of textContent.items) {
      const str = (raw.str || '').trim();
      if (!str) continue;
      // transform = [scaleX, skewY, skewX, scaleY, x, y] in PDF (bottom-left origin) units.
      const t = raw.transform || [1, 0, 0, 1, 0, 0];
      const transformed = getPdfJs().Util.transform(viewport.transform, t);
      const x = transformed[4];
      // Normalize to top-left origin so OCR + PDF share one coordinate system.
      const yBottom = t[5];
      const y = transformed[5] - Math.abs(raw.height || t[0] || 10);
      const height = Math.abs(raw.height || t[0] || 10) || 10;
      const width = Math.abs(raw.width || str.length * (height * 0.55)) || 10;
      items.push({
        text: str,
        x,
        y,
        width,
        height,
        page: pageNumber,
        source: 'pdf-text',
      });
    }

    if (CONFIG.DEBUG) {
      console.debug(`[pdf-parser] page ${pageNumber}: ${items.length} text items`, items.slice(0, 10));
    }
    return items;
  } finally {
    // Release page resources promptly for large PDFs.
    if (page.cleanup) page.cleanup();
  }
}

/**
 * Render a page to a canvas for OCR fallback.
 * Caller owns the canvas and must release it (width=0 / remove) when done.
 * @param {object} pdf
 * @param {number} pageNumber
 * @param {HTMLCanvasElement} canvas
 * @param {number} [scale]
 * @returns {Promise<{width:number,height:number}>}
 */
export async function renderPageToCanvas(pdf, pageNumber, canvas, scale = CONFIG.OCR_SCALE) {
  const page = await pdf.getPage(pageNumber);
  try {
    const viewport = page.getViewport({ scale });
    const ctx = canvas.getContext('2d', { alpha: false });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return { width: canvas.width, height: canvas.height };
  } finally {
    if (page.cleanup) page.cleanup();
  }
}

/**
 * Heuristic: does this page need OCR?
 * @param {Array} textItems
 */
export function pageNeedsOcr(textItems) {
  if (!textItems || textItems.length < CONFIG.MIN_TEXT_ITEMS_BEFORE_OCR) return true;
  const chars = textItems.reduce((n, it) => n + (it.text ? it.text.length : 0), 0);
  return chars < CONFIG.MIN_TEXT_CHARS_BEFORE_OCR;
}

/**
 * Release a canvas buffer to avoid memory build-up on large PDFs.
 * @param {HTMLCanvasElement} canvas
 */
export function releaseCanvas(canvas) {
  if (!canvas) return;
  try {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    /* ignore */
  }
}
