# AGENT.md — Permanent Engineering Rules

## Mission

Accurately convert tables from PDFs into editable Excel workbooks, entirely in the browser.

## Core principles

1. **Accuracy > visual features.** Never sacrifice extraction correctness for cosmetics.
2. **Preserve user data.** Never silently discard uncertain values — surface low-confidence tables for review.
3. **PDF text extraction before OCR.** OCR is strictly a fallback for pages with too little usable text.
4. **OCR only as fallback.** Never OCR a page that already yielded usable PDF.js text (unless user forces it).
5. **Table detection is coordinate-based.** Group by Y (rows), cluster by X (columns). Never rely on spaces inside strings.
6. **Keep all processing client-side for V1.** No uploads, no backend, no storage.
7. **No backend without a strong reason.** The app must deploy as static files (Vercel / Netlify / Pages).
8. **No React/frameworks.** Vanilla HTML + CSS + ES modules only.
9. **Keep modules small and maintainable.** `pdf-parser ≠ ocr ≠ table-detector ≠ excel-exporter ≠ ui`. Both extractors must emit the same `{text,x,y,width,height,page,source}` shape so the detector never cares about origin.
10. **Edited preview data is what gets exported.** Every edit path must mutate `table.rows` before `buildWorkbook`.
11. **Test extraction changes against multiple PDF layouts** (simple, financial, bank statement, invoice, multi-page, multi-table, scanned, no-table, prose+table, blank pages, corrupted, password-protected, missing cells, currency/percent, multi-line).

## Module boundaries

- `config.js` — the ONLY place for magic numbers/tolerances.
- `pdf-parser.js` — PDF.js I/O, top-left coordinate normalization, canvas render/release.
- `ocr.js` — Tesseract worker lifecycle (shared, terminated after runs), word→item mapping, confidence filter.
- `table-detector.js` — pure functions: `groupIntoRows`, `clusterXPositions`, `mapRowsToColumns`, `scoreTable`, `detectTablesOnPage`, `mergeContinuedTables`, `buildFallbackTable`. No DOM, no PDF.js.
- `table-cleaner.js` — whitespace normalization that preserves numbers/IDs/currencies.
- `excel-exporter.js` — SheetJS only. Safe type coercion (leading-zero IDs stay text).
- `ui.js` — DOM only, `textContent`/`value` rendering (never `innerHTML` for extracted data).
- `app.js` — orchestration, state, progress, cancel, errors. No detection math.

## Safety rules

- Treat all extracted text as untrusted (XSS-safe rendering).
- Password-protected PDFs: friendly message, no bypass attempts.
- Release canvases/workers after each page/run; process pages sequentially.
- `async/await` with progress yields between pages; never freeze UI without feedback.
- No `// TODO: implement …` for core workflow — implement it.
