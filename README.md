# PDF to Excel

A static, browser-only PDF converter built with vanilla JavaScript, PDF.js 3.11.174, Tesseract.js 5.0.5, and xlsx-js-style 1.2.0. Documents stay on the user's device.

## Run

Serve the project over HTTP (ES modules cannot run from `file://`):

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open http://127.0.0.1:8080. Vendor libraries and OCR models require internet access; there is no guaranteed offline cache.

## Conversion and preservation

- PDF text and OCR boxes use the same top-left coordinates in PDF points, including viewport rotation and crop offsets.
- Rows are grouped by vertical position; words form cells using physical gaps. Repeated body spans establish columns before centred or spanning headings.
- Headings stay exactly as extracted. Plausible heading rows receive yellow fill and bold text. Blank/unknown headings are retained, not guessed.
- Every page and section stays in source order, including repeated headings, sparse rows, small tables, prose and footers. Uncertain non-table text is retained visibly rather than silently discarded.
- Matching physical templates can contribute an empty column missing on another page. Values remain in left-to-right order; there is no header-label union, majority-vote renaming, or regrouping of distant tables.
- Sparse and wrapped physical lines remain separate rows for review. The editor can correct them explicitly.
- OCR runs automatically only when a page has no usable text. Low-confidence recognized words are retained and flagged. **Re-extract with OCR** explicitly retries all pages and replaces the current extraction and edits.

## Verification and limits

The pipeline compares token multiplicities from all extracted fragments against the reconstructed grid. Missing or duplicated tokens stop conversion instead of producing a silently incomplete workbook. The result lists uncertain rows, OCR use, and pages with no recovered text. These checks describe the initial extraction; deliberate edits are exported as entered.

**This is a preservation check, not proof of PDF accuracy.** PDF files do not reliably encode table structure. An existing text layer may omit visible text or contain incorrect OCR; recognition may also misread scans. Values spanning columns, missing labels, merged cells, mixed layouts and wrapped rows need source review. Blank pages and unreadable pages cannot always be distinguished automatically. No general PDF converter can guarantee zero errors.

The included Siemens PDFs demonstrate this distinction: they contain embedded text layers even though they look scanned, and some visible UM labels/values are absent from those layers. Use the OCR retry and compare the result with the PDF; missing text is never invented automatically.

## Spreadsheet editor

Click **Edit spreadsheet** to open a full-width modal:

- Column letters, row numbers, sticky headers, wrapping/resizable cells and a larger cell-value field.
- Edit any cell; Tab/Enter navigation; Shift+Enter for a line break; paste tab-separated rectangular data.
- Insert/delete the selected row or column, mark/unmark heading rows, undo/redo (30 changes).
- Pages of 100 spreadsheet rows, direct row navigation, and Next issue.
- Compare with PDF: directly rendered source pages, automatic source-page selection, manual PDF page navigation, and an original-file link.
- Edits immediately update the exact grid used by download. Done or Escape closes the modal and keeps edits. Undo reverses edits; there is no separate draft.

## Excel output

One workbook and one worksheet, in document order. All cell values export as literal strings so currencies, locale-specific decimals, trailing zeros, long identifiers, dates, and formula-like text stay unchanged. Numbers can be explicitly converted in Excel later. All cells have thin borders and chosen heading rows are bold/yellow. Edited line breaks are retained. The workbook filename follows the source filename.

## Validation

```sh
npm test
```

The dependency-free Node tests cover heading and missing-cell alignment, duplicate labels, financial values, right-aligned numbers, multiline headings, small tables, multi-page order, prose fallback, blank pages, retained low-confidence OCR, crop coordinates, corrupt/password-protected errors, and missing/duplicate token detection.

Additional development checks ran the pinned PDF.js build against both included documents (60 pages, 22,678 source fragments), with zero token loss or duplication. Browser checks cover conversion, editing, undo/redo, row/column insertion, pagination, PDF comparison, modal close/reopen, mobile layout and a downloaded XLSX round trip. This does not certify every source value or constitute an OCR accuracy benchmark.

## Modules

- `pdf-parser.js`: loading, normalized coordinates, rendering and cleanup.
- `ocr.js`: worker lifecycle and retained word boxes.
- `table-detector.js`: physical rows, columns, sections and source-order combination.
- `validation.js`: extracted-token preservation checks.
- `table-cleaner.js`: whitespace normalization.
- `editor.js`: spreadsheet modal and PDF comparison.
- `ui.js`: read-only result preview and status.
- `excel-exporter.js`: exact text values and workbook styling.
- `app.js`: orchestration, file intake, progress, cancellation and export.

All extracted text is rendered through `textContent` or form values. No backend, upload, persistent storage or framework is used.
