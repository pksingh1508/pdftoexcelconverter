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
  if (!items || !items.length) return [];

  const rows = groupIntoRows(items);
  if (!rows.length) return [];
  const medGap = medianGap(rows);

  // ---- Step 1: words -> cells, then split rows into blocks ----
  const rowCells = rows.map((r) => ({ y: r.y, cells: splitRowIntoCells(r.items) }));

  /** @type {Array<Array<{y:number, cells:Cell[]}>>} */
  const blocks = [];
  let current = [];
  const flushBlock = () => {
    if (current.length) blocks.push(current);
    current = [];
  };

  /** Median dense-row cell count of the open block (its column structure). */
  const blockWidthMedian = () => {
    const ns = current.filter((r) => r.cells.length >= 2).map((r) => r.cells.length);
    if (!ns.length) return 0;
    return median(ns);
  };

  /** Longest cell text among the block's last few dense rows. */
  const recentMaxCellLen = () => {
    const ds = current.filter((r) => r.cells.length >= 2).slice(-3);
    let m = 0;
    for (const r of ds) for (const c of r.cells) m = Math.max(m, c.text.length);
    return m;
  };

  for (let i = 0; i < rowCells.length; i++) {
    const row = rowCells[i];
    const gap = rowGap(rowCells, i);
    const dense = row.cells.length >= 2;

    if (i > 0 && gap > medGap * CONFIG.TABLE_GAP_MULTIPLIER && current.length) {
      flushBlock();
    }

    if (dense) {
      if (isProseRow(row)) {
        if (current.length) flushBlock();
        continue;
      }
      // A header row starting the data table ends the letterhead zone:
      // short labels ("LINE", "QTY") after long address phrases, with at
      // least as many columns. Data rows always carry a long cell, so they
      // never trigger this.
      const maxLen = Math.max(...row.cells.map((c) => c.text.length));
      const med = blockWidthMedian();
      if (
        current.length >= 2 &&
        row.cells.length >= 4 &&
        maxLen <= 14 &&
        recentMaxCellLen() >= 25 &&
        row.cells.length >= med
      ) {
        flushBlock();
      }
      // Sustained column-structure change ends the block: e.g. a 3-column
      // letterhead zone followed by a 7-column packing list. A single odd
      // row (missing cells, subtotal) must NOT split — so require the new
      // pattern to persist into the next dense row (lookahead).
      else if (current.length >= 2 && med > 0 && Math.abs(row.cells.length - med) >= 3) {
        const nextDense = findNextDense(rowCells, i);
        if (nextDense && Math.abs(nextDense.cells.length - med) >= 3) {
          flushBlock();
        }
      }
      current.push(row);
    } else if (current.length > 0) {
      // Sparse row inside an open block: possible title / missing values /
      // wrapped line. Long prose ends the block.
      const words = row.cells.map((c) => c.text).join(' ').trim().split(/\s+/).filter(Boolean);
      if (words.length > 16) flushBlock();
      else current.push(row);
    }
  }
  flushBlock();

  // ---- Step 2: per-block columns + grid + score ----
  const source = items[0] && items[0].source ? items[0].source : 'pdf-text';
  let tables = [];
  let tableIdx = 0;

  for (const block of blocks) {
    const denseCount = block.filter((r) => r.cells.length >= 2).length;
    if (block.length < CONFIG.MIN_TABLE_ROWS || denseCount < CONFIG.MIN_TABLE_ROWS) continue;

    let columns = buildBlockColumns(block);
    // Fuse duplicate/contained intervals (builder races, header remnants,
    // text splinters) back into their logical column.
    columns = mergeOverlappingColumns(columns);
    if (columns.length < CONFIG.MIN_TABLE_COLUMNS) continue;

    const grid = mapBlockToGrid(block, columns);
    const blockGap = medianGap(block);

    // Merge wrapped/continuation lines: a single-FRAGMENT row sitting close
    // below a table row folds into the overlapping cell above instead of
    // becoming its own row. The overlap requirement is critical: without
    // it, standalone lines (e.g. "SIEMENS" under a right-aligned title)
    // glue onto unrelated cells and inflate junk-block scores.
    /** @type {string[][]} */
    const mergedGrid = [];
    for (let i = 0; i < grid.length; i++) {
      const g = grid[i];
      const filled = nonEmptyCount(g);
      const gap = i > 0 ? Math.abs(block[i].y - block[i - 1].y) : 0;
      const srcCells = block[i].cells;
      if (
        i > 0 &&
        filled === 1 &&
        srcCells.length === 1 &&
        gap > 0 &&
        gap < blockGap * 1.4 &&
        mergedGrid.length
      ) {
        const prev = mergedGrid[mergedGrid.length - 1];
        const idx = g.findIndex((c) => String(c).trim() !== '');
        const frag = srcCells[0];
        const col = columns[idx];
        const overlaps =
          col && Math.min(frag.x1, col.x1) - Math.max(frag.x0, col.x0) > 0;
        if (overlaps && String(prev[idx] || '').trim()) {
          prev[idx] = `${prev[idx]} ${g[idx]}`.trim();
          continue;
        }
      }
      mergedGrid.push([...g]);
    }

    if (mergedGrid.length < CONFIG.MIN_TABLE_ROWS) continue;
    // Drop near-empty artifact columns (header unnamed + rarely filled):
    // stray text splinters that split off their real column rejoin the
    // nearest kept neighbor instead of shifting the whole table.
    const deduped = dropSparseColumns(trimEmptyEdges(normalizeGrid(mergedGrid)));
    const normalized = deduped.filter((r) => r.some((c) => String(c).trim() !== ''));
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

  // ---- Step 3: drop letterhead fragments next to a strong main table ----
  tables = filterMinorTables(tables);

  return tables.map((t, i) => ({ ...t, id: `p${pageNumber}-t${i + 1}` }));
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
      // Adopt header labels the earlier pages were missing (e.g. a UM
      // header absent from page 1's text layer but present later).
      prev.rows[0] = prev.rows[0].map((h, i) =>
        String(h || '').trim() ? h : cur.rows[0][i] || h
      );
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
 * Continuations are already merged; remaining distinct tables (different
 * sections, e.g. a page whose UM column is genuinely absent) are stacked
 * vertically with one blank separator row — but their columns are ALIGNED
 * by header label to the main table, so QTY stays under QTY instead of
 * shifting left when a middle column is missing. Tables whose headers
 * share almost nothing with the main one are appended as their own
 * section with their header kept.
 * @param {Array<{id:string, pageNumbers:number[], confidence:number, rows:string[][]}>} tables
 * @returns {{rows:string[][], header:string[], sources:Array, pageCount:number}}
 */
export function combineTables(tables) {
  if (!tables.length) return { rows: [], header: [], sources: [], pageCount: 0 };
  // Main table = most rows (the document's data table).
  const main = [...tables].sort((a, b) => b.rows.length - a.rows.length)[0];
  const union = main.rows[0].slice();
  const norm = (s) => String(s || '').trim().toLowerCase();

  /** Map a table's column indexes onto union positions, or null for own section. */
  const alignTable = (t) => {
    const head = t.rows[0];
    const used = new Set();
    const map = head.map((h) => {
      const n = norm(h);
      if (!n) return -2; // empty label: positional fallback below
      for (let u = 0; u < union.length; u++) {
        if (!used.has(u) && norm(union[u]) === n) {
          used.add(u);
          return u;
        }
      }
      return -1;
    });
    // Positional fallback for empty labels: nearest free union slot that
    // keeps left-to-right order (matches e.g. an unnamed UM column sitting
    // between DESCRIPTION and QTY on both tables).
    let cursor = 0;
    map.forEach((m, c) => {
      if (m !== -2) {
        cursor = m + 1;
        return;
      }
      while (cursor < union.length && used.has(cursor)) cursor++;
      if (cursor < union.length) {
        used.add(cursor);
        map[c] = cursor;
        cursor++;
      } else {
        map[c] = union.length; // append new trailing column
      }
    });
    if (map.includes(-1)) return null; // labels don't fit: own section
    // Require at least half the non-empty labels to really match.
    const nonEmpty = head.filter((h) => norm(h));
    if (nonEmpty.length > 0) {
      let hits = 0;
      head.forEach((h, c) => {
        if (norm(h) && map[c] < union.length && norm(union[map[c]]) === norm(h)) hits++;
      });
      if (hits / nonEmpty.length < 0.5) return null;
    }
    return map;
  };

  /** @type {string[][]} */
  const rows = [];
  const sources = [];
  const pages = new Set();
  // Adopt missing header labels from later tables (e.g. UM absent on p1).
  const adopted = union.slice();

  tables.forEach((t, ti) => {
    for (const p of t.pageNumbers || []) pages.add(p);
    const map = alignTable(t);
    if (ti > 0) rows.push(new Array(union.length).fill(''));
    const startRow = rows.length;
    t.rows.forEach((r, ri) => {
      if (map) {
        const nr = new Array(union.length).fill('');
        r.forEach((val, c) => {
          const u = map[c] < union.length ? map[c] : union.length - 1;
          if (ri === 0 && !String(adopted[u] || '').trim() && String(val || '').trim()) {
            adopted[u] = val; // adopt label (e.g. UM) for the combined header
          }
          nr[u] = nr[u] ? `${nr[u]} ${val}`.trim() : val;
        });
        rows.push(nr);
      } else {
        // Own section: keep its header, pad to union width.
        const nr = r.slice();
        while (nr.length < union.length) nr.push('');
        rows.push(nr);
      }
    });
    sources.push({
      id: t.id,
      pages: [...(t.pageNumbers || [])],
      startRow,
      rowCount: t.rows.length,
      confidence: t.confidence,
      aligned: !!map,
    });
  });

  if (rows.length) rows[0] = adopted.slice();
  return { rows, header: adopted.slice(), sources, pageCount: pages.size };
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
