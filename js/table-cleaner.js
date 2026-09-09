/**
 * Careful text cleaning: normalize whitespace without destroying
 * meaningful content (IDs with leading zeros, currencies, signs…).
 *
 * @module table-cleaner
 */

/**
 * Clean a single extracted cell value.
 * - trims, collapses whitespace, removes stray line breaks
 * - preserves punctuation, decimals, signs, currencies, percents
 * - NEVER strips leading zeros or reformats numbers (export layer decides)
 * @param {unknown} value
 * @returns {string}
 */
export function cleanValue(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  s = s.replace(/\r\n?/g, ' ').replace(/\n/g, ' ');
  s = s.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Remove control characters but keep printable unicode (₹, €, etc.).
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return s;
}

/**
 * Clean a full table grid in place (returns new grid).
 * @param {string[][]} rows
 * @returns {string[][]}
 */
export function cleanTable(rows) {
  if (!Array.isArray(rows)) return [];
  const cleaned = rows.map((row) =>
    (Array.isArray(row) ? row : [row]).map(cleanValue)
  );
  // Drop fully-empty rows, but keep rows with at least one value.
  return cleaned.filter((row) => row.some((c) => c !== ''));
}

/**
 * Remove tables that are effectively empty after cleaning.
 * @param {Array<{rows:string[][]}>} tables
 */
export function dropEmptyTables(tables) {
  return (tables || []).filter((t) => t.rows && t.rows.length > 0);
}
