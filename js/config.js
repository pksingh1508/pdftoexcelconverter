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
