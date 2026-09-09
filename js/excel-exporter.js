/**
 * Excel workbook generation via SheetJS (global XLSX).
 * Accuracy-first type handling: only obviously-safe values become numbers;
 * IDs with leading zeros, codes, and ambiguous strings stay text.
 *
 * @module excel-exporter
 */

function getXLSX() {
  const x = globalThis.XLSX;
  if (!x) throw new Error('Excel library failed to load. Check your connection and reload.');
  return x;
}

/**
 * Excel sheet names: max 31 chars, none of  [ ] : * ? / \
 * @param {string} name
 */
export function sanitizeSheetName(name) {
  let s = String(name || 'Sheet').replace(/[\[\]:*?\/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) s = 'Sheet';
  if (s.length > 31) s = s.slice(0, 31).trim();
  return s || 'Sheet';
}

/**
 * Convert a raw string cell to a safe Excel value.
 * Numbers with leading zeros (001245), alphanumerics, and mixed codes stay text.
 * @param {string} raw
 * @returns {string|number}
 */
export function toCellValue(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return '';
  // Leading-zero IDs / codes must stay text.
  if (/^0\d+/.test(s)) return s;
  // Hex-ish / mixed codes stay text.
  if (/[A-Za-z]/.test(s) && !/^[A-Za-z]{1,3}\s?\d/.test(s)) {
    // Pure month names etc. still text — fall through to text unless numeric below.
    if (!/^[\d,.\s%$₹€£¥₹\-+()]+$/.test(s)) return s;
  }
  // Percentages: 45% -> 0.45 is risky for ambiguous data; keep display text
  // but SheetJS community has no reliable % styling — preserve as text to avoid
  // silently changing values. Only plain numbers convert.
  const plain = s.replace(/,/g, '');
  if (/^-?\(?[\d]+\.?\d*\)?$/.test(plain) || /^-?\d*\.\d+$/.test(plain)) {
    // Reject things like "(12)" accounting negatives? Keep simple: plain only.
    if (/^[().]/.test(plain)) return s;
    const n = Number(plain);
    if (Number.isFinite(n) && plain.length <= 15 && !/^0\d/.test(plain)) return n;
  }
  // Currency like $1,250 / ₹25,000 -> numeric ONLY if unambiguous single number.
  const cur = s.replace(/^[$₹€£¥\s]+/, '').replace(/,/g, '').trim();
  if (/^-?\d+(\.\d{1,4})?$/.test(cur) && /^[$₹€£¥]/.test(s) && s.length < 20 && !/^0\d/.test(cur)) {
    const n = Number(cur);
    if (Number.isFinite(n)) return n;
  }
  // ISO-ish dates: leave as text (locale-safe, no silent shifts).
  return s;
}

/**
 * Build a SheetJS workbook from detected tables.
 * @param {Array<{id:string, pageNumbers:number[], rows:string[][], title?:string}>} tables
 * @param {string} [baseName]
 * @returns {object} workbook
 */
export function buildWorkbook(tables, baseName = 'tables') {
  const XLSX = getXLSX();
  const wb = XLSX.utils.book_new();
  const usedNames = new Set();

  tables.forEach((table, idx) => {
    const pageLabel = table.pageNumbers && table.pageNumbers.length
      ? `Page ${table.pageNumbers.join(',')}`
      : `Sheet ${idx + 1}`;
    let title = table.title || `Table ${idx + 1} - ${pageLabel}`;
    let name = sanitizeSheetName(title || `Table ${idx + 1}`);
    let suffix = 2;
    while (usedNames.has(name)) {
      const extra = ` (${suffix})`;
      name = sanitizeSheetName(`${title}`.slice(0, 31 - extra.length) + extra);
      suffix++;
    }
    usedNames.add(name);

    const aoa = (table.rows || []).map((row) => row.map(toCellValue));
    const ws = XLSX.utils.aoa_to_sheet(aoa.length ? aoa : [['(empty)']]);

    // Reasonable column widths from content length.
    const width = aoa[0] ? aoa[0].length : 1;
    ws['!cols'] = Array.from({ length: width }, (_, c) => {
      let longest = 10;
      for (const row of aoa) {
        const v = row[c];
        const len = String(v ?? '').length;
        if (len > longest) longest = len;
      }
      return { wch: Math.min(Math.max(longest + 2, 10), 50) };
    });

    // Freeze header row (supported by SheetJS writers as '!freeze' / pane).
    try {
      ws['!freeze'] = 'A2';
    } catch {
      /* styling is best-effort */
    }

    XLSX.utils.book_append_sheet(wb, ws, name);
  });

  return wb;
}

/**
 * Trigger an .xlsx download in the browser.
 * @param {object} workbook
 * @param {string} filename - should end with .xlsx
 */
export function downloadWorkbook(workbook, filename) {
  const XLSX = getXLSX();
  const safe = String(filename || 'tables.xlsx').trim() || 'tables.xlsx';
  const finalName = /\.xlsx$/i.test(safe) ? safe : `${safe}.xlsx`;
  XLSX.writeFile(workbook, finalName);
}

/**
 * Derive output filename from input PDF name.
 * bank-statement.pdf -> bank-statement.xlsx
 */
export function outputFilename(inputName) {
  const base = String(inputName || 'converted').replace(/\.[^.]+$/, '').trim() || 'converted';
  return `${base}.xlsx`;
}
