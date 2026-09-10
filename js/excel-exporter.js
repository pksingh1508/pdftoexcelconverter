/**
 * Excel workbook generation via xlsx-js-style (global XLSX).
 * xlsx-js-style is API-compatible with SheetJS community edition but also
 * WRITES cell styles — plain SheetJS silently drops font/fill/border on
 * write, so styles require this fork.
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

/** ARGB colors. */
const HEADER_FILL_RGB = 'FFFFFF00'; // yellow
const BORDER_RGB = 'FF000000'; // black

function thinBorder(rgb = BORDER_RGB) {
  const side = { style: 'thin', color: { rgb } };
  return { top: side, bottom: side, left: side, right: side };
}

/**
 * Apply header + border styles to a worksheet.
 * Header rows get bold text on a yellow background; EVERY cell in the used
 * range gets thin borders on all four sides.
 * @param {object} ws - worksheet
 * @param {number[]} headerRowIndexes - 0-based row numbers styled as headers
 */
export function styleWorksheet(ws, headerRowIndexes = [0]) {
  const XLSX = getXLSX();
  const ref = ws['!ref'];
  if (!ref || !XLSX.utils.decode_range || !XLSX.utils.encode_cell) return;
  let range;
  try {
    range = XLSX.utils.decode_range(ref);
  } catch {
    return;
  }
  const headerSet = new Set(headerRowIndexes);
  for (let r = range.s.r; r <= range.e.r; r++) {
    const isHeader = headerSet.has(r);
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      let cell = ws[addr];
      if (!cell || typeof cell !== 'object') {
        // Create the cell so borders render continuously across blanks.
        cell = ws[addr] = { t: 's', v: '' };
      }
      if (isHeader) {
        cell.s = {
          ...(cell.s || {}),
          font: { ...((cell.s && cell.s.font) || {}), bold: true },
          fill: { patternType: 'solid', fgColor: { rgb: HEADER_FILL_RGB } },
          border: thinBorder(),
        };
      } else {
        cell.s = { ...(cell.s || {}), border: thinBorder() };
      }
    }
  }
}

/**
 * Find header row indexes in a string grid: row 0 plus any row identical
 * to it (repeated headings of stacked sections).
 * @param {string[][]} rows
 * @returns {number[]}
 */
export function findHeaderRows(rows) {
  if (!rows || !rows.length) return [0];
  const head = rows[0].map((v) => String(v ?? ''));
  const idx = [0];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i].map((v) => String(v ?? ''));
    if (row.length !== head.length) continue;
    let same = true;
    for (let c = 0; c < head.length; c++) {
      if (row[c] !== head[c]) {
        same = false;
        break;
      }
    }
    if (same) idx.push(i);
  }
  return idx;
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
  // Exact display text is the default. Locale, precision, currency and
  // leading zeros cannot be inferred safely from PDF strings.
  return String(raw ?? '');
}

/**
 * Build a single-sheet workbook from the COMBINED dataset (all pages and
 * tables merged into one grid). This is the only export path: one download
 * button, one .xlsx file, one worksheet with everything.
 * @param {string[][]} rows - combined grid, first row is the header
 * @param {string} sheetName - sanitized automatically
 * @returns {object} workbook
 */
export function buildCombinedWorkbook(rows, sheetName = 'All Data', headerRows = findHeaderRows(rows)) {
  const XLSX = getXLSX();
  const wb = XLSX.utils.book_new();
  const name = sanitizeSheetName(sheetName);
  const aoa = (rows && rows.length ? rows : [['(empty)']]).map((row) =>
    row.map(toCellValue)
  );
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  const width = aoa.reduce((w, row) => Math.max(w, row.length), 1);
  ws['!cols'] = Array.from({ length: width }, (_, c) => {
    let longest = 10;
    for (const row of aoa) {
      const v = row[c];
      const len = String(v ?? '').length;
      if (len > longest) longest = len;
    }
    return { wch: Math.min(Math.max(longest + 2, 10), 50) };
  });

  try {
    ws['!freeze'] = 'A2';
  } catch {
    /* styling is best-effort */
  }

  // Bold + yellow headings, thin borders on every cell.
  styleWorksheet(ws, headerRows);

  XLSX.utils.book_append_sheet(wb, ws, name);
  return wb;
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
    const width = aoa.reduce((w, row) => Math.max(w, row.length), 1);
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

    styleWorksheet(ws, findHeaderRows(table.rows || []));

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
