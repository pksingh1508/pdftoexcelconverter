/**
 * Coordinate-based table reconstruction.
 * Works identically for PDF.js text items and Tesseract OCR items because
 * both are normalized to { text, x, y, width, height, page, source } with a
 * top-left origin.
 *
 * Pipeline:
 *   items -> rows (Y grouping) -> candidate blocks (structure only)
 *         -> per-block column clusters -> grid mapping
 *         -> wrap merging -> scoring -> tables[]
 *
 * Block-first design keeps a prose line's word positions from polluting a
 * real table's column model (and vice versa).
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
 * Cluster 1-D values so near-equal coordinates share a column.
 * @param {number[]} values
 * @param {number} tolerance
 * @returns {number[]} sorted cluster centers (medians)
 */
export function clusterXPositions(values, tolerance) {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const clusters = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const v = sorted[i];
    const last = current[current.length - 1];
    if (Math.abs(v - last) <= tolerance) {
      current.push(v);
    } else {
      clusters.push(median(current));
      current = [v];
    }
  }
  clusters.push(median(current));
  return clusters;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Group text items into rows by similar Y.
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
  /** @type {Array<{y:number, items:TextItem[]}>} */
  const rows = [];
  for (const item of sorted) {
    const yc = item.y + (item.height || 0) / 2;
    let placed = false;
    for (const row of rows) {
      if (Math.abs(yc - row._yc) <= tol) {
        row.items.push(item);
        // Running average of centers keeps drift low.
        row._yc = (row._yc * (row.items.length - 1) + yc) / row.items.length;
        row.y = Math.min(row.y, item.y);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push({ y: item.y, _yc: yc, items: [item] });
  }
  rows.sort((a, b) => a.y - b.y);
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    delete row._yc;
  }
  return rows;
}

/**
 * Map each row's items onto shared column centers.
 * Multiple fragments in one cell are concatenated left-to-right.
 * @param {Array<{y:number, items:TextItem[]}>} rows
 * @param {number[]} colCenters - sorted ascending
 * @returns {string[][]} grid, one array per row
 */
export function mapRowsToColumns(rows, colCenters) {
  return rows.map((row) => {
    const cells = new Array(colCenters.length).fill('');
    for (const item of row.items) {
      const cx = item.x + (item.width || 0) / 2;
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < colCenters.length; c++) {
        const d = Math.abs(cx - colCenters[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      const text = item.text;
      cells[best] = cells[best] ? `${cells[best]} ${text}` : text;
    }
    return cells;
  });
}

/**
 * Count non-empty cells in a grid row.
 */
function nonEmptyCount(row) {
  return row.filter((c) => String(c || '').trim() !== '').length;
}

function rowGap(rows, i) {
  if (i <= 0 || i >= rows.length) return 0;
  return Math.abs(rows[i].y - rows[i - 1].y);
}

function medianGap(rows) {
  if (rows.length < 2) return 14;
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push(rowGap(rows, i));
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] || 14;
}

/**
 * Score a candidate table grid 0..1.
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
  const sizeBonus = Math.min(1, grid.length / 6) * 0.15;
  const ocrPenalty = opts.source === 'ocr' ? 0.08 : 0;
  const score = 0.25 * avgFill + 0.35 * modal + 0.25 * multiColRows + sizeBonus - ocrPenalty;
  return Math.max(0, Math.min(1, score));
}

function confidenceLabel(score) {
  if (score >= 0.7) return 'High confidence';
  if (score >= 0.42) return 'Medium confidence';
  return 'Low confidence';
}

/**
 * Heuristic: is this row running prose rather than a table row?
 * Prose has many small fragments with roughly even spacing and no standout
 * large gap; table rows have at least one large inter-item gutter.
 * @param {{items:TextItem[]}} row
 */
function isProseRow(row) {
  const n = row.items.length;
  if (n < 4) return false; // short rows are ambiguous — treat as tabular
  const sorted = [...row.items].sort((a, b) => a.x - b.x);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i].x - (sorted[i - 1].x + (sorted[i - 1].width || 0)));
  }
  if (!gaps.length) return false;
  const maxGap = Math.max(...gaps);
  const widths = sorted.map((it) => it.width || 20).sort((a, b) => a - b);
  const medianW = widths[Math.floor(widths.length / 2)] || 20;
  if (maxGap < medianW * 1.2 && maxGap < 30) return true;
  const textLen = sorted.map((it) => it.text).join(' ').length;
  if (textLen > 110 && maxGap < 50) return true;
  return false;
}

/**
 * Detect tables on a single page from normalized text items.
 *
 * Block-first: rows are split into candidate blocks on structure alone
 * (multi-fragment rows, vertical gaps, prose), then columns are inferred
 * per block so prose positions never pollute a table's column model.
 *
 * @param {TextItem[]} items
 * @param {number} pageNumber
 * @returns {Array<{id:string, pageNumbers:number[], confidence:number, confidenceLabel:string, rows:string[][], source:string}>}
 */
export function detectTablesOnPage(items, pageNumber) {
  if (!items || !items.length) return [];

  const rows = groupIntoRows(items);
  if (!rows.length) return [];
  const medGap = medianGap(rows);

  // ---- Step 1: split rows into candidate blocks (structure only) ----
  /** @type {Array<Array<{y:number, items:TextItem[]}>>} */
  const blocks = [];
  let current = [];
  const flushBlock = () => {
    if (current.length) blocks.push(current);
    current = [];
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const gap = rowGap(rows, i);
    const dense = row.items.length >= 2;

    if (i > 0 && gap > medGap * CONFIG.TABLE_GAP_MULTIPLIER && current.length) {
      flushBlock();
    }

    if (dense) {
      const proseLike = isProseRow(row);
      if (proseLike && current.length === 0) {
        continue; // standalone prose line — never start a block
      }
      if (proseLike && current.length > 0) {
        flushBlock(); // prose ends the open block
        continue;
      }
      current.push(row);
    } else {
      // Sparse row (0-1 fragments): keep inside an open block as a possible
      // title / missing-cell / wrapped line; otherwise ignore.
      if (current.length > 0) {
        const words = row.items.map((it) => it.text).join(' ').trim().split(/\s+/).filter(Boolean);
        if (words.length > 16) flushBlock();
        else current.push(row);
      }
    }
  }
  flushBlock();

  // ---- Step 2: per-block column inference + grid mapping ----
  const source = items[0] && items[0].source ? items[0].source : 'pdf-text';
  const tables = [];
  let tableIdx = 0;

  for (const block of blocks) {
    const denseCount = block.filter((r) => r.items.length >= 2).length;
    if (block.length < CONFIG.MIN_TABLE_ROWS || denseCount < CONFIG.MIN_TABLE_ROWS) continue;

    const xStarts = [];
    for (const r of block) for (const it of r.items) xStarts.push(it.x);
    let colCenters = clusterXPositions(xStarts, CONFIG.COLUMN_X_TOLERANCE);
    if (colCenters.length < 2) {
      const centers = [];
      for (const r of block) for (const it of r.items) centers.push(it.x + (it.width || 0) / 2);
      const alt = clusterXPositions(centers, CONFIG.COLUMN_X_TOLERANCE * 1.5);
      if (alt.length > colCenters.length) colCenters = alt;
    }
    if (colCenters.length < CONFIG.MIN_TABLE_COLUMNS) continue;

    const grid = mapRowsToColumns(block, colCenters);
    const blockGap = medianGap(block);

    // Merge wrapped/continuation lines: single-cell rows close to the row
    // above fold into it instead of becoming their own row.
    /** @type {string[][]} */
    const mergedGrid = [];
    for (let i = 0; i < grid.length; i++) {
      const g = grid[i];
      const filled = nonEmptyCount(g);
      const gap = i > 0 ? Math.abs(block[i].y - block[i - 1].y) : 0;
      if (i > 0 && filled === 1 && gap > 0 && gap < blockGap * 1.4 && mergedGrid.length) {
        const prev = mergedGrid[mergedGrid.length - 1];
        const idx = g.findIndex((c) => String(c).trim() !== '');
        let target = idx;
        if (!String(prev[target] || '').trim()) {
          let t = idx;
          while (t >= 0 && !String(prev[t] || '').trim()) t--;
          if (t < 0) t = prev.findIndex((c) => String(c).trim() !== '');
          target = t >= 0 ? t : idx;
        }
        prev[target] = `${prev[target]} ${g[idx]}`.trim();
        continue;
      }
      mergedGrid.push([...g]);
    }

    if (mergedGrid.length < CONFIG.MIN_TABLE_ROWS) continue;
    const normalized = trimEmptyEdges(normalizeGrid(mergedGrid));
    if (!normalized.length) continue;
    const multiRows = normalized.filter((r) => nonEmptyCount(r) >= 2).length;
    if (multiRows < CONFIG.MIN_TABLE_ROWS) continue;

    const score = scoreTable(normalized, { source });
    tableIdx++;
    tables.push({
      id: `p${pageNumber}-t${tableIdx}`,
      pageNumbers: [pageNumber],
      confidence: round2(score),
      confidenceLabel: confidenceLabel(score),
      rows: normalized,
      source,
    });
  }

  return tables;
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

/**
 * Remove fully-empty leading/trailing columns and empty rows.
 */
export function trimEmptyEdges(grid) {
  if (!grid.length) return grid;
  const width = grid[0].length;
  let left = 0;
  let right = width - 1;
  const colEmpty = (c) => grid.every((r) => !String(r[c] || '').trim());
  while (left <= right && colEmpty(left)) left++;
  while (right >= left && colEmpty(right)) right--;
  if (left > right) return grid;
  return grid
    .map((r) => r.slice(left, right + 1))
    .filter((r) => r.some((c) => String(c).trim() !== ''));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Merge tables across pages when a table clearly continues:
 * same column count + identical repeated header row.
 * @param {Array} tables - in page order
 * @returns {Array} merged tables with updated ids/titles
 */
export function mergeContinuedTables(tables) {
  if (tables.length < 2) return tables;
  const out = [tables[0]];
  for (let i = 1; i < tables.length; i++) {
    const prev = out[out.length - 1];
    const cur = tables[i];
    if (
      prev.rows[0] &&
      cur.rows[0] &&
      prev.rows[0].length === cur.rows[0].length &&
      headersEqual(prev.rows[0], cur.rows[0]) &&
      Math.abs(prev.pageNumbers[prev.pageNumbers.length - 1] - cur.pageNumbers[0]) <= 1
    ) {
      prev.rows = [...prev.rows, ...cur.rows.slice(1)];
      prev.pageNumbers = [...new Set([...prev.pageNumbers, ...cur.pageNumbers])];
      prev.confidence = round2(Math.min(1, (prev.confidence + cur.confidence) / 2 + 0.03));
      prev.confidenceLabel = confidenceLabel(prev.confidence);
      prev.merged = true;
    } else {
      out.push(cur);
    }
  }
  return out.map((t, i) => ({ ...t, id: `table-${i + 1}` }));
}

function headersEqual(a, b) {
  const norm = (r) => r.map((c) => String(c).trim().toLowerCase()).join('|');
  if (norm(a) === norm(b)) return true;
  // Near-identical: >= 80% cells equal.
  if (a.length !== b.length) return false;
  let same = 0;
  for (let i = 0; i < a.length; i++) {
    if (String(a[i]).trim().toLowerCase() === String(b[i]).trim().toLowerCase()) same++;
  }
  return same / a.length >= 0.8;
}

/**
 * Fallback when no confident table exists but text does:
 * preserve data as a single low-confidence table instead of discarding.
 * @param {TextItem[]} allItems
 */
export function buildFallbackTable(allItems) {
  if (!allItems.length) return null;
  const byPage = new Map();
  for (const it of allItems) {
    if (!byPage.has(it.page)) byPage.set(it.page, []);
    byPage.get(it.page).push(it);
  }
  const firstPage = [...byPage.keys()].sort((a, b) => a - b)[0];
  const items = byPage.get(firstPage);
  const rows = groupIntoRows(items);
  const xStarts = [];
  for (const r of rows) for (const it of r.items) xStarts.push(it.x);
  let centers = clusterXPositions(xStarts, CONFIG.COLUMN_X_TOLERANCE * 1.75);
  if (centers.length < 1) centers = [median(xStarts)];
  // Cap fallback width so prose doesn't become a 12-column mess.
  if (centers.length > 6) {
    centers = clusterXPositions(xStarts, CONFIG.COLUMN_X_TOLERANCE * 3);
  }
  const grid = trimEmptyEdges(normalizeGrid(mapRowsToColumns(rows, centers)));
  if (!grid.length) return null;
  return {
    id: 'table-1',
    pageNumbers: [firstPage],
    confidence: 0.25,
    confidenceLabel: 'Low confidence',
    rows: grid,
    source: items[0].source || 'pdf-text',
    fallback: true,
  };
}
