/**
 * OCR fallback for scanned / image PDFs using Tesseract.js.
 * Converts Tesseract word boxes into the SAME normalized text-item shape
 * used by pdf-parser so the table detector never knows the difference.
 *
 * @module ocr
 */
import { CONFIG } from './config.js';

/**
 * @typedef {import('./table-detector.js').TextItem} TextItem
 */

function getTesseract() {
  const t = globalThis.Tesseract;
  if (!t) throw new Error('OCR engine failed to load. Check your connection and reload.');
  return t;
}

/**
 * Reusable OCR engine: one worker across pages to avoid re-downloading
 * models and re-spawning workers per page.
 */
class OcrEngine {
  constructor() {
    /** @type {any} */
    this.worker = null;
    this._initializing = null;
  }

  async init(onLog = null) {
    if (this.worker) return this.worker;
    if (this._initializing) return this._initializing;
    const Tesseract = getTesseract();
    this._initializing = (async () => {
      // Tesseract v5 API: createWorker('eng', OEM, { logger })
      this.worker = await Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          if (this.onLog && m && (m.status === 'recognizing text' || m.status === 'loading')) {
            this.onLog(m);
          }
        },
      });
      // PSM 6 (uniform block of text): materially better for full-page
      // tables than the default fully-automatic segmentation.
      try {
        if (this.worker.setParameters) {
          await this.worker.setParameters({ tessedit_pageseg_mode: '6' });
        }
      } catch {
        /* older builds ignore this; default segmentation still works */
      }
      return this.worker;
    })();
    return this._initializing;
  }

  /**
   * @param {HTMLCanvasElement|HTMLImageElement} image
   * @param {number} pageNumber
   * @param {(m:any)=>void} [onLog]
   * @returns {Promise<TextItem[]>}
   */
  async recognize(image, pageNumber, onLog = null, options = {}) {
    this.onLog = onLog;
    await this.init(onLog);
    await this.worker.setParameters({ tessedit_pageseg_mode: options.psm || '6' });
    const { data } = await this.worker.recognize(image);
    return wordsToItems(data, pageNumber, options.scale || CONFIG.OCR_SCALE);
  }

  async terminate() {
    try {
      if (this.worker && this.worker.terminate) await this.worker.terminate();
    } catch {
      /* ignore */
    } finally {
      this.worker = null;
      this._initializing = null;
    }
  }
}

let sharedEngine = null;

/** @returns {OcrEngine} */
export function getOcrEngine() {
  if (!sharedEngine) sharedEngine = new OcrEngine();
  return sharedEngine;
}

export async function terminateOcrEngine() {
  if (sharedEngine) {
    await sharedEngine.terminate();
    sharedEngine = null;
  }
}

/**
 * Convert Tesseract page data into normalized text items.
 * @param {{words?: Array<{text:string, confidence:number, bbox:{x0:number,y0:number,x1:number,y1:number}}>, text?: string}} data
 * @param {number} pageNumber
 * @returns {TextItem[]}
 */
export function wordsToItems(data, pageNumber, scale = CONFIG.OCR_SCALE) {
  const words = (data && data.words) || [];
  /** @type {TextItem[]} */
  const items = [];
  for (const w of words) {
    const text = (w.text || '').trim();
    if (!text) continue;
    const conf = typeof w.confidence === 'number' ? w.confidence : 0;
    // Retain uncertain words and flag them downstream; never drop data.
    const bbox = w.bbox || {};
    const x0 = bbox.x0 || 0;
    const y0 = bbox.y0 || 0;
    const x1 = bbox.x1 || x0 + 10;
    const y1 = bbox.y1 || y0 + 10;
    items.push({
      text,
      x: x0 / scale,
      y: y0 / scale,
      width: Math.max(2, x1 - x0) / scale,
      height: Math.max(2, y1 - y0) / scale,
      page: pageNumber,
      source: 'ocr',
      confidence: Math.round(conf),
    });
  }
  if (CONFIG.DEBUG) console.debug(`[ocr] page ${pageNumber}: ${items.length} words kept`);
  return items;
}

/**
 * Run OCR on a rendered canvas for one page.
 * @param {HTMLCanvasElement} canvas - already rendered page image
 * @param {number} pageNumber
 * @param {(m:any)=>void} [onProgress]
 * @returns {Promise<TextItem[]>}
 */
export async function ocrCanvas(canvas, pageNumber, onProgress = null, options = {}) {
  const engine = getOcrEngine();
  try {
    return await engine.recognize(canvas, pageNumber, onProgress, options);
  } catch (err) {
    throw new Error(`OCR failed on page ${pageNumber}: ${(err && err.message) || err}`);
  }
}
