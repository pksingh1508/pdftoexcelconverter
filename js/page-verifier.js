import { removeTableLines } from './ocr-preprocess.js';
import { CONFIG } from './config.js';
import { renderPageToCanvas, releaseCanvas } from './pdf-parser.js';
import { ocrCanvas } from './ocr.js';
import { reconcileReadings } from './reconciliation.js';

export function throwIfCancelled(isCancelled) {
  if (isCancelled()) throw Object.assign(new Error('Conversion cancelled.'), { code: 'CANCELLED' });
}

/** Two sequential visual readings; only one page canvas is held at a time. */
export function cancellable(promise, isCancelled) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (isCancelled()) { clearInterval(timer); reject(Object.assign(new Error('Conversion cancelled.'), { code: 'CANCELLED' })); }
    }, CONFIG.OCR_CANCEL_POLL_MS);
    promise.then(value => { clearInterval(timer); resolve(value); }, error => { clearInterval(timer); reject(error); });
  });
}

export async function verifyPage(pdf, page, pdfItems, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const readings = [], failures = [];
  for (const [index, options] of CONFIG.VERIFY_PASSES.entries()) {
    throwIfCancelled(isCancelled);
    const canvas = document.createElement('canvas');
    try {
      onProgress(`Visual check ${index + 1} of ${CONFIG.VERIFY_PASSES.length}`);
      await renderPageToCanvas(pdf, page, canvas, options.scale);
      throwIfCancelled(isCancelled);
      if (options.removeLines) removeTableLines(canvas, options.scale);
      readings.push(await cancellable(ocrCanvas(canvas, page, m => {
        if (m.status === 'recognizing text') onProgress(`Visual check ${index + 1}: ${Math.round(m.progress * 100)}%`);
      }, options), isCancelled));
    } catch (error) {
      throwIfCancelled(isCancelled);
      failures.push({ pass: index + 1, message: error.message });
      readings.push([]);
    } finally { releaseCanvas(canvas); }
  }
  throwIfCancelled(isCancelled);
  if (!pdfItems.length && readings.every(r => !r.length) && failures.length) {
    throw new Error(`Page ${page} could not be read: ${failures.map(f => f.message).join('; ')}`);
  }
  const result = reconcileReadings(pdfItems, ...readings);
  return { ...result, page, failures, completed: CONFIG.VERIFY_PASSES.length - failures.length,
    empty: !pdfItems.length && readings.every(r => !r.length) };
}

/** Link reconciliation evidence back to physical spreadsheet rows. */
export function attachVerificationIssues(tables, verification) {
  const physicalRows = tables.flatMap(table => table.rowOrigins.map((origin, row) => ({ table, row, y: origin.y })));
  for (const region of verification.regions.filter(r => r.status !== 'agreement')) {
    const target = physicalRows.reduce((best, r) => !best || Math.abs(r.y - region.y) < Math.abs(best.y - region.y) ? r : best, null);
    if (!target) continue;
    const message = region.status === 'unresolved'
      ? 'Readings disagree or lack corroboration. Original reading retained.'
      : region.status === 'recovered' ? 'Missing text recovered by agreement between two OCR passes.'
        : 'Embedded text corrected by agreement between two high-confidence OCR passes.';
    target.table.issues.push({ row: target.row, message, regionId: region.id, verificationStatus: region.status,
      evidence: region.texts.map((t, i) => `${['PDF', 'OCR 1', 'OCR 2'][i]}: ${t || '(not found)'}`).join(' | ') });
  }
}
