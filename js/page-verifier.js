import { removeTableLines } from './ocr-preprocess.js';
import { CONFIG } from './config.js';
import { renderPageToCanvas, releaseCanvas } from './pdf-parser.js';
import { ocrCanvas } from './ocr.js';
import { reconcileReadings } from './reconciliation.js';

export function throwIfCancelled(isCancelled) {
  if (isCancelled()) throw Object.assign(new Error('Conversion cancelled.'), { code: 'CANCELLED' });
}

/** Interrupt an OCR job even when its worker does not reject on termination. */
export function cancellable(promise, isCancelled) {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (isCancelled()) { clearInterval(timer); reject(Object.assign(new Error('Conversion cancelled.'), { code: 'CANCELLED' })); }
    }, CONFIG.OCR_CANCEL_POLL_MS);
    promise.then(value => { clearInterval(timer); resolve(value); }, error => { clearInterval(timer); reject(error); });
  });
}

export async function verifyPage(pdf, page, pdfItems, { onProgress = () => {}, isCancelled = () => false } = {}) {
  const readings = [], failures = [], layouts = [];
  for (const [index, options] of CONFIG.VERIFY_PASSES.entries()) {
    throwIfCancelled(isCancelled);
    const canvas = document.createElement('canvas');
    const original = document.createElement('canvas');
    try {
      onProgress(`Visual check ${index + 1} of ${CONFIG.VERIFY_PASSES.length}`);
      await renderPageToCanvas(pdf, page, canvas, options.scale);
      throwIfCancelled(isCancelled);
      original.width = canvas.width; original.height = canvas.height;
      original.getContext('2d').drawImage(canvas, 0, 0);
      const rulings = options.removeLines ? removeTableLines(canvas, options.scale) : null;
      let words = await cancellable(ocrCanvas(canvas, page, m => {
        if (m.status === 'recognizing text') onProgress(`Visual check ${index + 1}: ${Math.round(m.progress * 100)}%`);
      }, options), isCancelled);
      // Ruling lines give real column boundaries even when the text layer
      // omits an entire heading or column. Read these narrow strips alone.
      if (rulings?.horizontal.length >= 2 && rulings.vertical.length >= 3) {
        layouts.push({
          top: rulings.horizontal[0] / options.scale, bottom: rulings.horizontal.at(-1) / options.scale,
          columns: rulings.vertical.slice(0, -1).map((x, c) => ({ x0: x / options.scale, x1: rulings.vertical[c + 1] / options.scale })),
        });
        const padding = Math.ceil(CONFIG.OCR_CROP_PADDING_POINTS * options.scale);
        const top = rulings.horizontal[0] + padding;
        const bottom = rulings.horizontal.at(-1) - padding;
        for (let c = 0; c < rulings.vertical.length - 1; c++) {
          throwIfCancelled(isCancelled);
          const left = rulings.vertical[c] + padding, right = rulings.vertical[c + 1] - padding;
          if (right - left < CONFIG.OCR_MIN_COLUMN_POINTS * options.scale || bottom <= top) continue;
          if ((right - left) / options.scale > CONFIG.OCR_NARROW_COLUMN_POINTS) continue;
          for (let row = 0; row < rulings.horizontal.length - 1; row++) {
            throwIfCancelled(isCancelled);
            const cellTop = rulings.horizontal[row] + padding, cellBottom = rulings.horizontal[row + 1] - padding;
            if (cellBottom <= cellTop) continue;
            const crop = document.createElement('canvas');
            try {
              const margin = Math.ceil(CONFIG.OCR_CELL_MARGIN_POINTS * options.scale);
              crop.width = right - left + margin * 2; crop.height = cellBottom - cellTop + margin * 2;
              const ctx = crop.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, crop.width, crop.height);
              // Crop the untouched rendering inside the borders. This avoids
              // line-removal damage to glyphs that touch a ruling stroke.
              ctx.drawImage(original, left, cellTop, right - left, cellBottom - cellTop, margin, margin, right - left, cellBottom - cellTop);
              onProgress(`Visual check ${index + 1}: narrow column ${c + 1}, row ${row + 1}`);
              const cellWords = await cancellable(ocrCanvas(crop, page, () => {}, { ...options, psm: '7' }), isCancelled);
              const inside = word => {
                const x = (word.x + word.width / 2) * options.scale, y = (word.y + word.height / 2) * options.scale;
                return x >= left && x <= right && y >= cellTop && y <= cellBottom;
              };
              const previous = words.filter(inside);
              const quality = candidates => candidates.length ? Math.min(...candidates.map(w => w.confidence)) : -1;
              if (cellWords.length && quality(cellWords) >= quality(previous)) words = [...words.filter(w => !inside(w)), ...cellWords.map(w => ({
                ...w, x: w.x + (left - margin) / options.scale, y: w.y + (cellTop - margin) / options.scale,
              }))];
            } finally { releaseCanvas(crop); }
          }
        }
      }
      readings.push(words);
    } catch (error) {
      throwIfCancelled(isCancelled);
      failures.push({ pass: index + 1, message: error.message });
      readings.push([]);
    } finally { releaseCanvas(canvas); releaseCanvas(original); }
  }
  throwIfCancelled(isCancelled);
  if (!pdfItems.length && readings.every(r => !r.length) && failures.length) {
    throw new Error(`Page ${page} could not be read: ${failures.map(f => f.message).join('; ')}`);
  }
  const result = reconcileReadings(pdfItems, ...readings);
  // Use agreed ruling geometry to keep narrow columns (e.g. UM and QTY)
  // separate even when the whitespace between their words is very small.
  const layout = layouts.length === CONFIG.VERIFY_PASSES.length &&
    layouts[0].columns.length === layouts[1].columns.length &&
    layouts[0].columns.every((c, i) => Math.abs(c.x0 - layouts[1].columns[i].x0) <= CONFIG.ROW_Y_TOLERANCE && Math.abs(c.x1 - layouts[1].columns[i].x1) <= CONFIG.ROW_Y_TOLERANCE)
    ? layouts[0] : null;
  if (layout) for (const item of result.items) {
    const cx = item.x + item.width / 2, cy = item.y + item.height / 2;
    const col = layout.columns.findIndex(c => cx >= c.x0 && cx < c.x1);
    if (col >= 0 && cy >= layout.top && cy <= layout.bottom) {
      item.tableColumn = col; item.tableColumns = layout.columns;
    }
  }
  return { ...result, page, failures, layout, completed: CONFIG.VERIFY_PASSES.length - failures.length,
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
