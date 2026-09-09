/**
 * Central tuning constants for PDF table extraction.
 * Keep all magic numbers here — never scatter them through modules.
 *
 * @module config
 */

/** @type {object} Extraction + UX tuning */
export const CONFIG = {
  MAX_FILE_SIZE_MB: 50,

  // Row grouping: items whose Y centers differ by <= this are the same row.
  // PDF units (points at scale 1). Adaptive logic widens it for large fonts.
  ROW_Y_TOLERANCE: 4,

  // Column clustering: X starts within this distance belong to same column.
  COLUMN_X_TOLERANCE: 12,

  // Minimum shape for something to be called a table.
  MIN_TABLE_ROWS: 2,
  MIN_TABLE_COLUMNS: 2,

  // If a page yields fewer usable text items than this, we consider OCR.
  MIN_TEXT_ITEMS_BEFORE_OCR: 5,
  // Also trigger OCR when total extracted text is shorter than this.
  MIN_TEXT_CHARS_BEFORE_OCR: 60,

  // Canvas render scale for OCR pages (higher = better accuracy, more memory).
  OCR_SCALE: 2,

  // Tesseract word confidence below this is dropped (0-100).
  MIN_OCR_CONFIDENCE: 40,

  // Table splitting: a vertical gap larger than median * this ends a table.
  TABLE_GAP_MULTIPLIER: 2.2,

  // Cell segmentation: within one row, consecutive fragments separated by a
  // gap larger than this threshold start a NEW cell (new column); smaller
  // gaps are word spaces inside the same cell. Measured on real packing-note
  // PDFs: word spaces are ~1.5-6 units, column gutters are ~12+ units.
  // The threshold adapts per row: median(small gaps) * factor, clamped.
  WORD_GAP_FACTOR: 2.5,
  MIN_CELL_GAP: 8,
  MAX_CELL_GAP: 14,
  SMALL_GAP_CEILING: 20,

  // Column alignment: a cell joins the column with the largest
  // (overlap / min(cellWidth, colWidth)) when that ratio >= this.
  OVERLAP_THRESHOLD: 0.3,

  // Dominance filter: when a page's best table scores >= this, a sibling
  // that is BOTH weaker by SCORE_MARGIN and smaller than ROW_FRACTION of
  // the best table's rows is dropped (letterhead blocks, sold-to boxes).
  // Tables below ABS_MIN_SCORE are always dropped. Pages without a strong
  // table keep everything.
  BEST_TABLE_MIN_SCORE: 0.8,
  TABLE_SCORE_MARGIN: 0.08,
  TABLE_ROW_FRACTION: 0.5,
  ABS_MIN_TABLE_SCORE: 0.55,

  // Preview perf: render at most this many rows initially per table.
  PREVIEW_ROW_LIMIT: 150,

  // Debug: set true to log text items / rows / confidence to console.
  DEBUG: false,
};

export const PROCESSING_STAGES = [
  'Loading PDF',
  'Reading pages',
  'Detecting text',
  'Detecting tables',
  'Running OCR, if required',
  'Reconstructing rows and columns',
  'Cleaning data',
  'Preparing preview',
  'Creating workbook',
];
