# AGENT.md — Permanent Engineering Rules

## Mission

Accurately convert tables from PDFs into editable Excel workbooks, entirely in the browser.

## Core principles

1. **Accuracy > visual features.** Never sacrifice extraction correctness for cosmetics.
2. **Preserve user data.** Never silently discard uncertain values — surface low-confidence tables for review. NEVER move a value into a different column, NEVER glue it into a neighbor, NEVER drop it to "clean" the grid. An unnamed-but-correct column always beats a shifted sheet.
3. **Row order is sacred.** Emission order must always be input (page, then top-to-bottom) order. Lock with tests.
3. **PDF text extraction before OCR.** Read text first, then run default two-pass visual verification to recover incomplete text layers (user-authorized accuracy workflow).
4. **OCR only as fallback.** Visual verification may OCR pages with usable text. Fast extraction may skip verification when explicitly selected by the user.
5. **Table detection is coordinate-based.** Group by Y (rows), cluster by X (columns). Never rely on spaces inside strings.
6. **Keep all processing client-side for V1.** No uploads, no backend, no storage.
7. **No backend without a strong reason.** The app must deploy as static files (Vercel / Netlify / Pages).
8. **No React/frameworks.** Vanilla HTML + CSS + ES modules only.
9. **Keep modules small and maintainable.** `pdf-parser ≠ ocr ≠ table-detector ≠ excel-exporter ≠ ui`. Both extractors must emit the same `{text,x,y,width,height,page,source}` shape so the detector never cares about origin.
10. **Edited preview data is what gets exported.** The preview edits `state.combined.rows` directly — the exact grid `buildCombinedWorkbook` exports. Single source of truth, no divergence.
11. **Test extraction changes against multiple PDF layouts** (simple, financial, bank statement, invoice, multi-page, multi-table, scanned, no-table, prose+table, blank pages, corrupted, password-protected, missing cells, currency/percent, multi-line).

## Module boundaries

- `config.js` — the ONLY place for magic numbers/tolerances.
- `pdf-parser.js` — PDF.js I/O, top-left coordinate normalization, canvas render/release.
- `ocr.js` — Tesseract worker lifecycle (shared, terminated after runs), word→item mapping, confidence filter.
- `table-detector.js` — pure functions: `groupIntoRows` (Y grouping + fragment-touch join), `splitRowIntoCells` (gap-based word joining), `buildBlockColumns` + `mergeOverlappingColumns` (overlap alignment, duplicate fusion), `scoreTable` (fill/consistency/header-likeness), `detectTablesOnPage`, `filterMinorTables` (dominance + header tie-break), `mergeContinuedTables` (adjacent, LABEL-ALIGNED merge + positional remainder pairing), `mergeSameHeaderTables` (exact heading match across ANY pages — one heading, all data below), `mapColumnsToUnion` (labels-only mapping), `dropSparseColumns` (phantom-only: unnamed + 100% empty, nothing else), `combineTables` (longest-first union, gated positional pairing, majority-vote headers, page-order emission). No DOM, no PDF.js.
- `table-cleaner.js` — whitespace normalization that preserves numbers/IDs/currencies.
- `excel-exporter.js` — xlsx-js-style writer (NOT plain SheetJS: community drops styles on write). `buildCombinedWorkbook` = ONE sheet from the combined grid. Heading rows (row 0 + repeats) MUST stay bold on yellow; EVERY cell MUST keep thin black borders on all sides. Safe type coercion (leading-zero IDs stay text).
- `ui.js` — DOM only, `textContent`/`value` rendering (never `innerHTML` for extracted data).
- `app.js` — orchestration, state, progress, cancel, errors. No detection math.

## Safety rules

- Treat all extracted text as untrusted (XSS-safe rendering).
- Password-protected PDFs: friendly message, no bypass attempts.
- Release canvases/workers after each page/run; process pages sequentially.
- `async/await` with progress yields between pages; never freeze UI without feedback.
- No `// TODO: implement …` for core workflow — implement it.
