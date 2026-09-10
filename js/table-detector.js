/**
 * Coordinate-based table reconstruction.
 * Works identically for PDF.js text items and Tesseract OCR items because
 * both are normalized to { text, x, y, width, height, page, source } with a
 * top-left origin.
 *
 * Physical rows are retained; columns use recurring body spans and heading
 * positions. No dominance filtering, row folding, or label-based reordering.
 * Uncertain layouts carry review issues and every source token is audited.
 *
 * @module table-detector
 */
import { CONFIG } from './config.js';

/**
 * @typedef {object} TextItem
 * @property {string} text
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} page
 * @property {string} [source]
 */

/**
 * @typedef {object} Cell
 * @property {string} text
 * @property {number} x0 - left edge
 * @property {number} x1 - right edge
 */

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Group text items into rows by similar Y.
 *
 * Two rules (either joins):
 *  - vertical centers within tolerance (normal same-size text), OR
 *  - vertical spans touch AND tops within 3 units — tiny fragments
 *    (dashes "-", split-off words like "VLV") sit 1-2 units off their
 *    text line because their centers differ; without this they become
 *    phantom rows that corrupt column detection.
 * Distinct lines (5+ units apart) never join under either rule.
 *
 * @param {TextItem[]} items
 * @param {number} [tolerance]
 * @returns {Array<{y:number, items:TextItem[]}>} top-to-bottom
 */
export function groupIntoRows(items, tolerance = CONFIG.ROW_Y_TOLERANCE) {
  if (!items.length) return [];
  // Adaptive tolerance: respect larger fonts.
  const heights = items.map((i) => i.height || 10).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 10;
  const tol = Math.max(tolerance, medianH * 0.45);

  const sorted = [...items].sort((a, b) => a.y - b.y);
  /** @type {Array<{y:number, bot:number, items:TextItem[]}>} */
  const rows = [];
  for (const item of sorted) {
    const yc = item.y + (item.height || 0) / 2;
    const top = item.y;
    const bot = item.y + (item.height || 0);
    let placed = false;
    for (const row of rows) {
      const overlap = Math.min(bot, row.bot) - Math.max(top, row.y);
      const fragTouch = overlap > 0 && Math.abs(top - row.y) <= 3;
      if (Math.abs(yc - row._yc) <= tol || fragTouch) {
        row.items.push(item);
        // Running average of centers keeps drift low.
        row._yc = (row._yc * (row.items.length - 1) + yc) / row.items.length;
        row.y = Math.min(row.y, top);
        row.bot = Math.max(row.bot, bot);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push({ y: top, bot, _yc: yc, items: [item] });
  }
  rows.sort((a, b) => a.y - b.y);
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    delete row._yc;
    delete row.bot;
  }
  return rows;
}

/**
 * Split one row's left-to-right fragments into cells.
 * Fragments separated by a small gap are words in the SAME cell
 * ("1000 - SKID PIPING, PIPING VLV"); a large gutter starts a new cell.
 * @param {TextItem[]} items - sorted left-to-right
 * @returns {Cell[]}
 */
export function splitRowIntoCells(items) {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.x - b.x);
  if (sorted.length === 1) {
    const it = sorted[0];
    return [{ text: it.text, x0: it.x, x1: it.x + (it.width || 0) }];
  }
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    gaps.push(sorted[i].x - (prev.x + (prev.width || 0)));
  }
  const threshold = cellSplitThreshold(gaps);

  /** @type {Cell[]} */
  const cells = [];
  let cur = {
    text: sorted[0].text,
    x0: sorted[0].x,
    x1: sorted[0].x + (sorted[0].width || 0),
  };
  for (let i = 1; i < sorted.length; i++) {
    const it = sorted[i];
    if (gaps[i - 1] > threshold) {
      cells.push(cur);
      cur = { text: it.text, x0: it.x, x1: it.x + (it.width || 0) };
    } else {
      cur.text = `${cur.text} ${it.text}`;
      cur.x0 = Math.min(cur.x0, it.x);
      cur.x1 = Math.max(cur.x1, it.x + (it.width || 0));
    }
  }
  cells.push(cur);
  return cells;
}

/**
 * Adaptive per-row split threshold from the row's own gap distribution.
 * Word spaces cluster small; column gutters stand out large.
 */
export function cellSplitThreshold(gaps) {
  if (!gaps.length) return CONFIG.MIN_CELL_GAP;
  const small = gaps.filter((g) => g < CONFIG.SMALL_GAP_CEILING);
  const basis = small.length ? median(small) : 4;
  const adaptive = basis * CONFIG.WORD_GAP_FACTOR;
  return Math.min(CONFIG.MAX_CELL_GAP, Math.max(CONFIG.MIN_CELL_GAP, adaptive));
}

/**
 * Assign a cell to one of the existing columns by interval overlap.
 * @param {Cell} cell
 * @param {Array<{x0:number,x1:number}>} columns - sorted left-to-right
 * @returns {number} column index, or -1 when nothing overlaps enough
 */
function findColumn(cell, columns) {
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    const overlap = Math.min(cell.x1, c.x1) - Math.max(cell.x0, c.x0);
    if (overlap <= 0) continue;
    const score = overlap / Math.min(cell.x1 - cell.x0 || 1, c.x1 - c.x0 || 1);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return bestScore >= CONFIG.OVERLAP_THRESHOLD ? best : -1;
}

/**
 * Build the column model for one block from ALL its cells first (so a
 * column that only appears in data rows — e.g. UM values with no text
 * header — still gets its own column), then map every row onto it.
 * @param {Array<{y:number, cells:Cell[]}>} blockRows
 * @returns {Array<{x0:number,x1:number}>} columns left-to-right
 */
function buildBlockColumns(blockRows) {
  /** @type {Array<{x0:number,x1:number}>} */
  const columns = [];
  const center = (c) => (c.x0 + c.x1) / 2;
  for (const row of blockRows) {
    for (const cell of row.cells) {
      const hit = findColumn(cell, columns);
      if (hit >= 0) {
        columns[hit].x0 = Math.min(columns[hit].x0, cell.x0);
        columns[hit].x1 = Math.max(columns[hit].x1, cell.x1);
      } else {
        // Insert in X order so column indexes stay left-to-right.
        const cc = (cell.x0 + cell.x1) / 2;
        let pos = columns.findIndex((c) => center(c) > cc);
        if (pos < 0) pos = columns.length;
        columns.splice(pos, 0, { x0: cell.x0, x1: cell.x1 });
      }
    }
  }
  return columns;
}

function nonEmptyCount(row) {
  return row.filter((c) => String(c || '').trim() !== '').length;
}

function medianGap(rows) {
  if (rows.length < 2) return 14;
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push(Math.abs(rows[i].y - rows[i - 1].y));
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || 14;
}

/**
 * Score a candidate table grid 0..1.
 * Rewards: fill rate, row-shape consistency, multi-column density, width,
 * size. Punishes: sparse (0-1 cell) rows inside the table — a hallmark of
 * letterhead/address fragments accidentally grouped together.
 */
export function scoreTable(grid, opts = {}) {
  if (!grid.length) return 0;
  const cols = Math.max(...grid.map((r) => r.length));
  if (cols < CONFIG.MIN_TABLE_COLUMNS) return 0.15;
  const counts = grid.map(nonEmptyCount);
  const avgFill = counts.reduce((a, b) => a + b, 0) / (grid.length * cols);
  // Consistency: how often do rows share the modal column-fill count?
  const freq = new Map();
  for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
  const modal = Math.max(...freq.values()) / grid.length;
  const multiColRows = counts.filter((c) => c >= 2).length / grid.length;
  const sparseRows = counts.filter((c) => c < 2).length / grid.length;
  const sizeBonus = Math.min(1, grid.length / 6) * 0.15;
  const colBonus = Math.min(0.08, Math.max(0, cols - 2) * 0.02);
  // Header-likeness: a real data table starts with short labels
  // ("LINE", "QTY"); an address block starts with long phrases.
  const firstCells = grid[0].filter((c) => String(c || '').trim() !== '');
  const avgHeadLen = firstCells.length
    ? firstCells.reduce((n, c) => n + String(c).trim().length, 0) / firstCells.length
    : 99;
  const headerBonus = avgHeadLen <= 14 ? 0.05 : avgHeadLen > 22 ? -0.1 : 0;
  const ocrPenalty = opts.source === 'ocr' ? 0.08 : 0;
  const score =
    0.25 * avgFill +
    0.35 * modal +
    0.2 * multiColRows +
    sizeBonus +
    colBonus +
    headerBonus -
    sparseRows * 0.25 -
    ocrPenalty;
  return Math.max(0, Math.min(1, score));
}

function confidenceLabel(score) {
  if (score >= 0.7) return 'High confidence';
  if (score >= 0.42) return 'Medium confidence';
  return 'Low confidence';
}

/**
 * Heuristic: is this row running prose rather than a table row?
 * (Rarely triggers now that gap-joining collapses prose to 1-2 cells,
 * but kept as a safety net for widely-spaced justified text.)
 * @param {{cells:Cell[]}} row
 */
export function detectTablesOnPage(items, pageNumber) {
  if (!items?.length) return [];
  const rows = groupIntoRows(items).map(r => ({
    ...r, cells: splitRowIntoCells(r.items),
  }));
  const gap = medianGap(rows);
  const blocks = [];
  let block = [];
  for (const row of rows) {
    const likelyHeading = row.cells.length >= CONFIG.HEADER_MIN_CELLS &&
      row.cells.every(c => c.text.length <= CONFIG.HEADER_MAX_LABEL_LENGTH && /[A-Za-z]/.test(c.text)) &&
      block.some(r => r.cells.some(c => c.text.length > CONFIG.HEADER_MAX_LABEL_LENGTH));
    if (block.length && (row.y - block.at(-1).y > gap * CONFIG.TABLE_GAP_MULTIPLIER || likelyHeading)) {
      blocks.push(block);
      block = [];
    }
    block.push(row);
  }
  if (block.length) blocks.push(block);

  return blocks.map((block, index) => {
    // Recurring body rows establish columns before spanning headings.
    const seed = block.reduce((a, b) => b.cells.length > a.cells.length ? b : a);
    // Repeated body shapes establish spans before short, centred headings.
    // This lets a description's full extent absorb its split word fragments.
    const frequency = new Map();
    for (const row of block) frequency.set(row.cells.length, (frequency.get(row.cells.length) || 0) + 1);
    const modelRows = [...block].sort((a, b) =>
      (frequency.get(b.cells.length) - frequency.get(a.cells.length)) ||
      b.cells.reduce((n, c) => n + c.x1 - c.x0, 0) - a.cells.reduce((n, c) => n + c.x1 - c.x0, 0));
    const columns = buildBlockColumns(modelRows);
    // Fuse offset heading/body spans only when no source row demonstrates
    // that they are separate cells (protects adjacent numeric columns).
    for (let a = 0; a < columns.length; a++) {
      for (let b = a + 1; b < columns.length; b++) {
        const overlap = Math.min(columns[a].x1, columns[b].x1) - Math.max(columns[a].x0, columns[b].x0);
        if (overlap <= 0) continue;
        const coexist = block.some(row => {
          const hits = row.cells.map(cell => findColumn(cell, columns));
          return hits.includes(a) && hits.includes(b);
        });
        if (coexist) continue;
        columns[a] = { x0: Math.min(columns[a].x0, columns[b].x0), x1: Math.max(columns[a].x1, columns[b].x1) };
        columns.splice(b--, 1);
      }
    }
    columns.sort((a, b) => a.x0 - b.x0);
    const issues = [];
    const grid = block.map((row, r) => {
      const out = Array(columns.length).fill('');
      let previous = -1;
      for (const cell of row.cells) {
        const candidates = columns.map((c, i) => ({ c, i,
          overlap: Math.max(0, Math.min(c.x1, cell.x1) - Math.max(c.x0, cell.x0)),
        })).filter(c => c.overlap > 0);
        // Monotonic assignment preserves left-to-right order. Fragments
        // contained in one established column can join within that cell.
        const available = candidates.filter(c => c.i >= previous);
        available.sort((a, b) =>
          Math.abs(a.c.x0 - cell.x0) - Math.abs(b.c.x0 - cell.x0));
        let hit = available[0]?.i;
        if (hit === undefined) {
          // Recover a conflicting row without losing a value. Flag it;
          // do not silently guess a neighbouring cell.
          issues.push({ row: r, message: 'Conflicting column positions; compare this row with the PDF.' });
          return row.cells.map(c => c.text);
        }
        if (candidates.length > 1) issues.push({ row: r, column: hit,
          message: 'Text spans multiple column positions; check the heading or value alignment.' });
        out[hit] = out[hit] ? `${out[hit]} ${cell.text}` : cell.text;
        previous = hit;
      }
      return out;
    });
    const fallback = seed.cells.length < CONFIG.MIN_TABLE_COLUMNS || block.length < CONFIG.MIN_TABLE_ROWS;
    if (fallback) issues.push({ row: 0, message: 'Uncertain table structure: original text retained for review.' });
    // A sparse physical line might be a wrapped cell OR a new record.
    // Keep it as its own row instead of irreversibly joining records.
    block.forEach((r, i) => {
      if (!fallback && r.cells.length < seed.cells.length) issues.push({ row: i,
        message: 'Sparse or wrapped row; check blank cells and multi-line headings.' });
    });
    for (let r = 0; r < block.length; r++) {
      if (block[r].items.some(it => it.source === 'ocr')) issues.push({ row: r,
        message: 'OCR text requires comparison with the source PDF.',
        lowConfidence: block[r].items.some(it => it.confidence < CONFIG.MIN_OCR_CONFIDENCE) });
    }
    const source = items[0].source || 'pdf-text';
    const confidence = fallback ? 0.25 : scoreTable(grid, { source });
    return { id: `p${pageNumber}-t${index + 1}`, pageNumbers: [pageNumber],
      y: block[0].y, columns, rows: normalizeGrid(grid), source, confidence,
      confidenceLabel: confidenceLabel(confidence), fallback, issues,
      rowOrigins: block.map(r => ({ page: pageNumber, y: r.y })),
      // Only style a plausible heading; never invent or replace labels.
      headerRows: !fallback && block[0].cells.length >= 2 &&
        (block[0].cells.length >= CONFIG.HEADER_MIN_CELLS || block[0].cells.length === columns.length) &&
        block[0].cells.every(c => !/^[\d\s.,+%$₹€£()-]+$/.test(c.text)) ? [0] : [],
    };
  });
}

/**
 * Pad every row to equal length and clean whitespace.
 */
export function normalizeGrid(grid) {
  const width = Math.max(...grid.map((r) => r.length));
  return grid.map((row) => {
    const out = new Array(width).fill('');
    for (let i = 0; i < width; i++) out[i] = cleanCell(row[i] || '');
    return out;
  });
}

function cleanCell(v) {
  return String(v).replace(/\s+/g, ' ').trim();
}

/** Stack sections in source order; only insert blanks for matching physical layouts. */
export function combineTables(tables) {
  const ordered = [...tables].sort((a, b) =>
    (a.pageNumbers?.[0] || 0) - (b.pageNumbers?.[0] || 0) || (a.y || 0) - (b.y || 0));
  // Repeated physical templates may have an entirely missing column on a
  // page. Insert blanks from a wider matching template, never shuffle values.
  const signature = t => t.headerRows?.length ? t.rows[t.headerRows[0]].filter(Boolean).join('\u0000') : '';
  for (let i = 0; i < ordered.length; i++) {
    const t = ordered[i];
    if (!t.columns || !signature(t)) continue;
    const model = ordered.filter(other => other.columns && signature(other) === signature(t))
      .sort((a, b) => b.columns.length - a.columns.length)[0];
    if (!model || model.columns.length <= t.columns.length) continue;
    const mapping = t.columns.map(c => findColumn(c, model.columns));
    if (mapping.some((c, j) => c < 0 || (j > 0 && c <= mapping[j - 1]))) continue;
    ordered[i] = { ...t, rows: t.rows.map(row => {
      const result = Array(model.columns.length).fill('');
      row.forEach((v, c) => { result[mapping[c]] = v; });
      return result;
    }), issues: [...t.issues, { row: 0, message: 'Blank column preserved from a matching physical table layout; check missing source text.' }] };
  }
  const width = ordered.reduce((w, t) => Math.max(w, ...t.rows.map(r => r.length)), 0);
  const rows = [], sources = [], rowOrigins = [], headerRows = [], issues = [];
  const pages = new Set();
  for (const t of ordered) {
    const startRow = rows.length;
    for (const p of t.pageNumbers || []) pages.add(p);
    for (const row of t.rows) rows.push([...row, ...Array(width - row.length).fill('')]);
    rowOrigins.push(...(t.rowOrigins || t.rows.map(() => ({ page: t.pageNumbers[0] }))));
    headerRows.push(...(t.headerRows || []).map(r => startRow + r));
    issues.push(...(t.issues || []).map(i => ({ ...i, row: startRow + i.row, page: t.pageNumbers[0] })));
    sources.push({ id: t.id, pages: t.pageNumbers, startRow, rowCount: t.rows.length, confidence: t.confidence });
  }
  return { rows, header: rows[0]?.slice() || [], sources, pageCount: pages.size,
    rowOrigins, headerRows, issues };
}

/**
 * Fallback when no confident table exists but text does:
 * preserve data as a single low-confidence table instead of discarding.
 * @param {TextItem[]} allItems
 */
export function buildFallbackTable(allItems) {
  if (!allItems.length) return null;
  const pages = [...new Set(allItems.map(it => it.page))].sort((a, b) => a - b);
  const tables = pages.flatMap(p => detectTablesOnPage(allItems.filter(it => it.page === p), p));
  const combined = combineTables(tables);
  return { ...combined, id: 'recovered-text', pageNumbers: pages, confidence: 0.25,
    confidenceLabel: 'Low confidence', source: allItems[0].source, fallback: true };
}
