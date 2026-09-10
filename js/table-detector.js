/**
 * Coordinate-based table reconstruction.
 * Works identically for PDF.js text items and Tesseract OCR items because
 * both are normalized to { text, x, y, width, height, page, source } with a
 * top-left origin.
 *
 * Pipeline (v2 — gap-based, verified on real packing-note PDFs):
 *   items -> rows (Y grouping) -> cells (gap-based word joining)
 *         -> candidate blocks (structure only)
 *         -> per-block columns (interval-overlap alignment)
 *         -> wrap merging -> scoring -> dominance filter -> tables[]
 *
 * Why gap-based: PDF text items are WORDS, not cells. The old approach
 * clustered every word-start X into columns, so "1000 - SKID PIPING,
 * PIPING VLV" shattered into 3-4 fake columns. Now words separated by a
 * small gap join one cell; only LARGE gutters start new columns. As a
 * bonus, letterhead lines (normal word spacing) collapse to single-cell
 * rows and are excluded automatically.
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

/**
 * Cluster 1-D values so near-equal coordinates share a column.
 * (Used by the low-confidence fallback path.)
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

/**
 * Map a block's cells onto its column model.
 * Cells that drift slightly (right-aligned numbers) attach to the nearest
 * column instead of vanishing.
 */
function mapBlockToGrid(blockRows, columns) {
  return blockRows.map((row) => {
    const out = new Array(columns.length).fill('');
    for (const cell of row.cells) {
      let idx = findColumn(cell, columns);
      if (idx < 0) {
        // Nearest-center fallback for slight drift; never invent columns here.
        const cc = (cell.x0 + cell.x1) / 2;
        let bestD = Infinity;
        idx = 0;
        columns.forEach((c, i) => {
          const d = Math.abs((c.x0 + c.x1) / 2 - cc);
          if (d < bestD) {
            bestD = d;
            idx = i;
          }
        });
      }
      out[idx] = out[idx] ? `${out[idx]} ${cell.text}` : cell.text;
    }
    return out;
  });
}

/**
 * Merge columns that describe the same logical column.
 * Two cases: (a) near-duplicate spans ([89,204] vs [89,205]) from
 * builder tie-break races — merged by high intersection-over-union;
 * (b) a small interval (header remnant, text splinter like a lone "VLV")
 * substantially contained in a much larger one — merged by containment,
 * with a width-ratio cap so genuinely small columns (UM, QTY) are never
 * swallowed by a wide neighbor. Distinct adjacent columns are always
 * gutter-separated and never merge.
 * @param {Array<{x0:number,x1:number}>} columns
 */
export function mergeOverlappingColumns(columns) {
  const parent = columns.map((_, i) => i);
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  for (let i = 0; i < columns.length; i++) {
    for (let j = i + 1; j < columns.length; j++) {
      const a = columns[i];
      const b = columns[j];
      const wa = a.x1 - a.x0 || 1;
      const wb = b.x1 - b.x0 || 1;
      const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      if (ov <= 0) continue;
      const containment = ov / Math.min(wa, wb);
      const iou = ov / (Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0));
      const ratio = Math.max(wa, wb) / Math.min(wa, wb);
      if (iou >= 0.85 || (containment >= 0.7 && ratio <= 12)) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map();
  columns.forEach((c, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(c);
  });
  return [...groups.values()]
    .map((g) => ({
      x0: Math.min(...g.map((c) => c.x0)),
      x1: Math.max(...g.map((c) => c.x1)),
    }))
    .sort((a, b) => (a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2);
}

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
function isProseRow(row) {
  const n = row.cells.length;
  if (n < 4) return false;
  const joined = row.cells.map((c) => c.text).join(' ');
  if (joined.length > 110) return true;
  return false;
}

/**
 * Detect tables on a single page from normalized text items.
 *
 * @param {TextItem[]} items
 * @param {number} pageNumber
 * @returns {Array<{id:string, pageNumbers:number[], confidence:number, confidenceLabel:string, rows:string[][], source:string}>}
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
    // Start with the densest physical row, not a spanning title/header.
    // Never let a wide header expand a column over its neighbours.
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
        // Monotonic assignment preserves left-to-right order and never
        // concatenates two distinct cells into one column.
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
        block[0].cells.every(c => !/^[\d\s.,+%$₹€£()-]+$/.test(c.text)) ? [0] : [],
    };
  });
}

/**
 * Look ahead for the next dense (multi-cell) row after index i.
 * @param {Array<{cells:Cell[]}>} rowCells
 */
function findNextDense(rowCells, i) {
  for (let j = i + 1; j < rowCells.length; j++) {
    if (rowCells[j].cells.length >= 2) return rowCells[j];
  }
  return null;
}

/**
 * Drop minor blocks when a dominant main table exists on the same page.
 * A strong table (packing list, statement…) keeps letterhead fragments,
 * address boxes and footnotes out of the result. A sibling is dropped only
 * when it is BOTH much weaker in score AND much smaller in rows — so a
 * small but excellent table (totals, second section) always survives.
 * Pages without a strong table keep everything; absolute junk below the
 * floor is always dropped (unless it is all there is).
 * @param {Array} tables
 */
export function filterMinorTables(tables) {
  if (!tables.length) return tables;
  let kept = tables.filter((t) => t.confidence >= CONFIG.ABS_MIN_TABLE_SCORE);
  if (!kept.length) return tables; // never wipe out everything
  if (kept.length < 2) return kept;
  const best = Math.max(...kept.map((t) => t.confidence));
  const bestRows = Math.max(...kept.map((t) => t.rows.length));
  if (best >= CONFIG.BEST_TABLE_MIN_SCORE) {
    const bestTable = kept.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    const bestHeadLen = avgRowLen(bestTable.rows[0]);
    const strong = kept.filter(
      (t) =>
        !(
          t.confidence < best - CONFIG.TABLE_SCORE_MARGIN &&
          t.rows.length < CONFIG.TABLE_ROW_FRACTION * bestRows
        ) &&
        // Address/letterhead block next to a real header-led table: its
        // first row is long phrases, not short labels. Decides equal-size
        // ties (e.g. a partial last page) that the size rule cannot.
        !(
          t !== bestTable &&
          t.confidence < best &&
          t.rows.length <= bestRows &&
          avgRowLen(t.rows[0]) > 22 &&
          bestHeadLen <= 14
        )
    );
    if (strong.length) kept = strong;
  }
  return kept;
}

/** Average trimmed cell length of a grid row. */
function avgRowLen(row) {
  const cells = (row || []).filter((c) => String(c || '').trim() !== '');
  if (!cells.length) return 99;
  return cells.reduce((n, c) => n + String(c).trim().length, 0) / cells.length;
}

/**
 * Drop phantom columns: unnamed in the header row AND completely empty.
 * Nothing else is ever removed or merged: a sparse-but-real column (e.g. a
 * UM column whose header text is missing from the PDF layer and which holds
 * values on only a few rows) MUST survive with its values exactly in place.
 * Gluing its values into a neighboring column would shift every column to
 * its right and corrupt the whole sheet — in a production system a visible
 * unnamed column is always preferable to silently moved data.
 * Named columns (even fully empty ones like TAG) are always kept — they are
 * real table structure.
 * @param {string[][]} grid - uniform-width rows, first row is the header
 * @returns {string[][]}
 */
export function dropSparseColumns(grid) {
  if (!grid.length || grid[0].length < 2) return grid;
  const header = grid[0];
  const keep = header.map((h, c) => {
    if (String(h || '').trim() !== '') return true;
    for (const r of grid) {
      if (String(r[c] || '').trim() !== '') return true;
    }
    return false;
  });
  if (keep.every(Boolean)) return grid;
  return grid.map((row) => row.filter((_, c) => keep[c]));
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
 * Map source header columns onto union header positions by label.
 * Labeled columns match by normalized label text. Unlabeled (empty) ones
 * and unmatched labels return -1 — the CALLER decides (positional pairing
 * under a match gate, or appending a new visible slot). Never force a
 * value into a wrong slot.
 * @param {string[]} srcHeader
 * @param {string[]} unionHeader
 * @returns {number[]}
 */
export function mapColumnsToUnion(srcHeader, unionHeader) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const used = new Set();
  const map = new Array(srcHeader.length).fill(-1);
  srcHeader.forEach((h, c) => {
    const n = norm(h);
    if (!n) return;
    for (let u = 0; u < unionHeader.length; u++) {
      if (!used.has(u) && norm(unionHeader[u]) === n) {
        used.add(u);
        map[c] = u;
        return;
      }
    }
  });
  return map;
}

/**
 * Merge tables across pages when a table clearly continues:
 * same column count + identical repeated header row.
 * Rows are merged by HEADER-LABEL alignment, never by raw index, so a
 * near-matching header can never shift values into wrong columns — if the
 * labels do not line up, the tables stay separate instead.
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
      const map = mapColumnsToUnion(cur.rows[0], prev.rows[0]);
      // Same width + gate passed: pair any leftovers positionally so an
      // unnamed column (e.g. UM present as values but missing header text)
      // still lands in its positional slot instead of blocking the merge.
      const freeU = prev.rows[0].map((_, u) => u).filter((u) => !map.includes(u));
      const leftover = cur.rows[0].map((_, c) => c).filter((c) => map[c] === -1);
      leftover.forEach((c, k) => {
        if (k < freeU.length) map[c] = freeU[k];
      });
      if (map.includes(-1)) {
        out.push(cur); // labels do not line up: keep separate, never shift
        continue;
      }
      const width = prev.rows[0].length;
      const mapped = cur.rows.slice(1).map((r) => {
        const nr = new Array(width).fill('');
        r.forEach((val, c) => {
          const u = map[c];
          if (u === undefined || u < 0 || u >= width) return;
          nr[u] = nr[u] ? `${nr[u]} ${val}`.trim() : val;
        });
        return nr;
      });
      prev.rows = [...prev.rows, ...mapped];
      // Adopt header labels the earlier pages were missing (e.g. a UM
      // header absent from page 1's text layer but present later).
      cur.rows[0].forEach((h, c) => {
        const u = map[c];
        if (u >= 0 && !String(prev.rows[0][u] || '').trim() && String(h || '').trim()) {
          prev.rows[0][u] = h;
        }
      });
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
 * Merge ALL tables with the exact same heading, wherever they appear.
 * mergeContinuedTables only joins adjacent continuations; a table that
 * repeats on non-consecutive pages (e.g. pages 1, 5 and 9 with other
 * content between) would otherwise export with its heading repeated.
 * After this pass the sheet holds ONE heading at the top and all data
 * rows below it. Exact normalized match only — near-matches stay separate.
 * @param {Array} tables - in page order
 * @returns {Array} merged tables with updated ids
 */
export function mergeSameHeaderTables(tables) {
  if (tables.length < 2) return tables;
  const keyOf = (t) => {
    if (!t.rows || !t.rows.length) return null;
    const cells = t.rows[0].map((c) =>
      String(c || '').trim().replace(/\s+/g, ' ').toLowerCase()
    );
    return t.rows[0].length + '|' + JSON.stringify(cells);
  };
  const claimed = new Set();
  const out = [];
  tables.forEach((t, i) => {
    if (claimed.has(i)) return;
    const key = keyOf(t);
    if (key === null) {
      out.push(t);
      return;
    }
    claimed.add(i);
    let rows = t.rows.map((r) => r.slice());
    let pages = [...(t.pageNumbers || [])];
    let confSum = t.confidence || 0;
    let confN = 1;
    tables.forEach((u, j) => {
      if (claimed.has(j) || keyOf(u) !== key) return;
      claimed.add(j);
      rows.push(...u.rows.slice(1).map((r) => r.slice()));
      for (const p of u.pageNumbers || []) if (!pages.includes(p)) pages.push(p);
      confSum += u.confidence || 0;
      confN++;
    });
    pages.sort((a, b) => a - b);
    out.push({
      ...t,
      rows,
      pageNumbers: pages,
      confidence: round2(confSum / confN),
      sameHeaderMerged: confN > 1,
    });
  });
  return out.map((t, i) => ({ ...t, id: `table-${i + 1}` }));
}

/**
 * Combine all detected tables into ONE dataset for the single-sheet export.
 * The union starts from the LONGEST header so no labeled column is ever
 * left without a slot. Every table maps by shared header labels; columns
 * with no counterpart extend the union visibly instead of shifting data.
 * Row order always follows the input (page) order.
 * @param {Array<{id:string, pageNumbers:number[], confidence:number, rows:string[][]}>} tables
 * @returns {{rows:string[][], header:string[], sources:Array, pageCount:number}}
 */
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
 * Map each row's items onto shared column centers.
 * (Used by the low-confidence fallback path.)
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
