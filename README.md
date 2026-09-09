# PDF to Excel — Client-Side PDF Table Converter

Extract tables from PDF documents and download them as clean, editable `.xlsx` spreadsheets. **100% client-side:** your document is processed locally in your browser and is never uploaded to any server.

## Features

- 📄 Drag & drop or click-to-browse PDF upload (max 50 MB, validated)
- 🔍 Coordinate-based table detection (rows from Y positions, columns from X clustering)
- 📷 Scanned-PDF fallback: page rendered to canvas → Tesseract.js OCR → same table pipeline
- 👀 Tabbed HTML preview with confidence badges (High / Medium / Low)
- ✏️ Editable preview — click any cell, add/delete rows & columns, remove tables
- 📊 Multi-table export — one worksheet per table, sensible sheet names, auto column widths
- 🔒 Privacy-first: no backend, no database, no auth, no uploads
- 📱 Responsive + accessible (keyboard navigation, ARIA, focus styles)
- ⏹️ Cancellable long runs with live progress (page X of Y, OCR %)

## Technology

| Concern | Library | How |
|---|---|---|
| PDF reading + text positions + page rendering | [PDF.js 3.11.174](https://mozilla.github.io/pdf.js/) (cdnjs) | `getTextContent()` → `{text,x,y,width,height,page}` normalized to top-left origin |
| OCR fallback | [Tesseract.js v5](https://tesseract.projectnaptha.com/) (jsDelivr) | Word boxes → same `{text,x,y,…}` shape; shared worker, terminated after run |
| Excel generation | [SheetJS 0.18.5](https://sheetjs.com/) (cdnjs) | `aoa_to_sheet` per table, `!cols` widths, `writeFile` download |
| App code | Vanilla HTML5 + CSS3 + ES modules | No React / Vue / backend |

## How PDF extraction works

1. `pdf-parser.js` loads the PDF with PDF.js and, per page, reads `page.getTextContent()`.
2. Each fragment's `transform[4]/transform[5]` gives X/Y; Y is flipped to a top-left origin (`pageHeight − y`) so PDF text and OCR boxes share one coordinate system.
3. `table-detector.js` groups fragments into rows when vertical centers differ by ≤ `ROW_Y_TOLERANCE` (adaptive to median font height), sorts left→right by X.
4. Column centers are inferred by clustering all X starts (`clusterXPositions` with `COLUMN_X_TOLERANCE`); every fragment maps to its nearest column and same-cell fragments concatenate.
5. Wrapped lines (single-cell rows close to the previous row) merge into the row above; consecutive ≥2-cell rows form table blocks, split by large vertical gaps (`TABLE_GAP_MULTIPLIER`) or prose-like lines.
6. Each block is scored (fill rate, row-shape consistency, multi-column density, size) → confidence label. Cross-page tables with identical repeated headers merge (`mergeContinuedTables`).
7. `table-cleaner.js` trims/collapses whitespace while preserving numbers, currencies, signs, and leading-zero IDs.

## How OCR fallback works

- A page needs OCR when it yields fewer than `MIN_TEXT_ITEMS_BEFORE_OCR` fragments or less than `MIN_TEXT_CHARS_BEFORE_OCR` characters — or when the user clicks **Try OCR on all pages**.
- The page is rendered at `OCR_SCALE: 2` to a reused canvas, recognized by a shared Tesseract worker (progress streamed to the UI), then the canvas is released.
- Words below `MIN_OCR_CONFIDENCE` are dropped; the rest become the same normalized items and flow through the identical row/column/table pipeline. The banner *"Scanned document detected. OCR processing may take longer."* appears.

## How table detection works (tuning)

All knobs live in `js/config.js`:

```js
ROW_Y_TOLERANCE: 4, COLUMN_X_TOLERANCE: 12,
MIN_TABLE_ROWS: 2, MIN_TABLE_COLUMNS: 2,
TABLE_GAP_MULTIPLIER: 2.2, MIN_OCR_CONFIDENCE: 40, …
```

Set `DEBUG: true` to log text items and OCR words to the console while tuning.

## How Excel generation works

- One workbook, one worksheet per table (`Table N - Page P`, sanitized to Excel's 31-char / no-`[]:*?/\` rules, de-duplicated).
- `toCellValue()` converts only unambiguous plain numbers (and simple `$`-prefixed amounts) to numeric cells; leading-zero IDs (`001245`), codes, percents-as-text, and dates stay text so values never silently change.
- Column widths auto-size (`longest + 2`, clamped 10–50), header row frozen (`A2`, best-effort).
- Filename mirrors input: `bank-statement.pdf` → `bank-statement.xlsx`. Export always uses the **edited** preview data.

## Run locally

Static site — no build, no server code. Serve the folder (ES modules require `http(s)`, not `file://`):

```bash
npx serve .
# or
python3 -m http.server 8080
# or VS Code Live Server
```

Then open the printed URL. First load fetches CDN libraries + OCR language data (internet required); afterwards text-PDF conversion works offline from cache.

## Browser requirements

Current Chrome, Edge, Firefox, Safari. Needs ES modules, `async/await`, Canvas, and enough memory for OCR at scale 2. Very large scanned PDFs process page-by-page with canvas/worker cleanup, but dozens of OCR pages will still be slow — that is inherent to on-device OCR.

## Known limitations

- PDFs have no real table structure — detection is heuristic and never 100%. Low-confidence output is preserved (not discarded) for manual correction.
- Merged/spanning header cells are approximated, not perfectly reconstructed.
- Community SheetJS has no rich cell styling; formatting is widths + frozen header only.
- Password-protected PDFs are rejected with a friendly message (no bypass).
- `file://` direct-open fails for ES modules — use a local server.

## Privacy model

- Files are read via `File.arrayBuffer()` and never `fetch`/`POST` anywhere.
- PDFs live only in memory; closing the tab discards everything.
- Only third-party contact is CDN fetches for libraries/OCR models.

## Project structure

```
├── index.html
├── css/styles.css
├── js/
│   ├── app.js            # orchestration + state + pipeline
│   ├── config.js         # all tuning constants
│   ├── pdf-parser.js     # PDF.js loading / text positions / canvas render
│   ├── table-detector.js # rows, columns, scoring, merging, fallback
│   ├── ocr.js            # Tesseract worker + word→item conversion
│   ├── table-cleaner.js  # whitespace-safe value cleaning
│   ├── excel-exporter.js # SheetJS workbook + download
│   └── ui.js             # DOM rendering, tabs, editable preview
├── README.md
├── AGENT.md
└── idea.md
```
