# PDF to Excel — Client-Side PDF Table Converter

Extract tables from PDF documents and download them as clean, editable `.xlsx` spreadsheets. **100% client-side:** your document is processed locally in your browser and is never uploaded to any server.

## Features

- 📄 Drag & drop or click-to-browse PDF upload (max 50 MB, validated)
- 🔍 Coordinate-based table detection (rows from Y positions, columns from X clustering)
- 📷 Scanned-PDF fallback: page rendered to canvas → Tesseract.js OCR → same table pipeline
- 👀 Single combined preview with confidence badge — all pages merged into one grid
- ✏️ Editable preview — click any cell, add/delete rows & columns
- 📊 One download button → one `.xlsx` file → one worksheet with ALL data
- 🔒 Privacy-first: no backend, no database, no auth, no uploads
- 📱 Responsive + accessible (keyboard navigation, ARIA, focus styles)
- ⏹️ Cancellable long runs with live progress (page X of Y, OCR %)

## Technology

| Concern | Library | How |
|---|---|---|
| PDF reading + text positions + page rendering | [PDF.js 3.11.174](https://mozilla.github.io/pdf.js/) (cdnjs) | `getTextContent()` → `{text,x,y,width,height,page}` normalized to top-left origin |
| OCR fallback | [Tesseract.js v5](https://tesseract.projectnaptha.com/) (jsDelivr) | Word boxes → same `{text,x,y,…}` shape; shared worker, terminated after run |
| Export (styled) | [xlsx-js-style 1.2.0](https://github.com/gitbrent/xlsx-js-style) (jsDelivr, SheetJS API-compatible) | Bold + yellow headings, thin borders on all cells (`buildCombinedWorkbook`) |
| App code | Vanilla HTML5 + CSS3 + ES modules | No React / Vue / backend |

## How PDF extraction works

1. `pdf-parser.js` loads the PDF with PDF.js and, per page, reads `page.getTextContent()`.
2. Each fragment's `transform[4]/transform[5]` gives X/Y; Y is flipped to a top-left origin (`pageHeight − y`) so PDF text and OCR boxes share one coordinate system. Rows group by Y proximity, with an extra rule that joins tiny fragments (dashes, split-off words like "VLV") sitting 1–3 units off their text line — otherwise they become phantom rows.
3. `table-detector.js` splits each row into **cells by gaps**: words separated by small gaps join one cell (`1000 - SKID PIPING, PIPING VLV`); only large gutters (adaptive per-row threshold) start new columns. This is what keeps multi-word cells intact.
4. Column centers are inferred **per block** by interval overlap, then duplicate/contained intervals (header remnants, text splinters) are fused back into their logical column. A column that only appears in data rows (e.g. UM values with no text header) still gets its own column.
5. Wrapped lines (single-fragment rows overlapping the cell above) fold into the row above; consecutive multi-cell rows form table blocks, split by large vertical gaps, sustained column-structure changes, or header-row boundaries. Each block is scored (fill rate, row-shape consistency, multi-column density, header-likeness, size) → confidence label.
6. Letterhead/address fragments are excluded by a dominance filter (weak + small next to a strong main table) and a header tie-break — verified: a 32-page packing note yields zero letterhead rows.
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

- One workbook, **one worksheet** (`combineTables` merges every page/table into a single grid).
- Tables that continue across pages (same shape + repeated header) merge seamlessly — one 32-page packing note becomes one ~800-row sheet with a single header.
- Tables with the **exact same heading repeating anywhere** in the document (`mergeSameHeaderTables`, even non-consecutive pages) also merge: one heading at the top, all data below.
- Sheet styling: heading row(s) are **bold on a yellow background**, and **every cell gets thin black borders on all four sides**. (Plain SheetJS community cannot write styles — they are silently dropped — so the app uses the API-compatible `xlsx-js-style` fork as its writer.)
- Sections with genuinely different widths are stacked below with a blank separator, **columns aligned by header label** (QTY stays under QTY even when a middle column like UM is absent on some pages); missing header labels are adopted from later pages.
- Sheet name = input file name (`SIEMENS ENERGY 993 A2.pdf` → sheet `SIEMENS ENERGY 993 A2`, sanitized to Excel's 31-char / no-`[]:*?/\` rules).
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
