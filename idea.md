# Project: PDF Table to Excel Converter

Build a complete, production-quality web application using:

- HTML5
- CSS3
- Vanilla JavaScript
- No React
- No Next.js
- No Vue
- No backend for V1
- No database
- No authentication

The application should allow a user to upload a PDF document, automatically detect tabular data inside the PDF, extract the tables, preview the extracted data, and download the result as a Microsoft Excel `.xlsx` file.

The application should work as much as possible entirely inside the user's browser.

---

# 1. Product Goal

Build a simple web tool with this workflow:

PDF Upload
↓
Read PDF
↓
Analyze every page
↓
Detect tables
↓
Extract rows and columns
↓
Clean extracted data
↓
Show table preview
↓
Allow user to review/edit data
↓
Generate Excel file
↓
Download `.xlsx`

The UX should be extremely simple.

A non-technical user should be able to:

1. Open the website.
2. Drag and drop a PDF.
3. Click "Convert to Excel".
4. Wait while pages are processed.
5. Preview detected tables.
6. Download an Excel file.

---

# 2. Important Product Requirement

There are two types of PDFs that must be handled differently.

## Type A — Text-based PDFs

These PDFs contain actual selectable text.

For these:

- Use PDF.js.
- Extract text items.
- Read the position/coordinates of each text item.
- Reconstruct rows and columns from their X/Y positions.
- Do NOT use OCR unless necessary.

This should provide the best accuracy.

---

## Type B — Scanned/Image PDFs

Some PDFs are basically images and contain no selectable text.

For those:

1. Render the PDF page into a canvas.
2. Detect that there is little or no extractable PDF text.
3. Use Tesseract.js OCR.
4. Extract text with bounding boxes.
5. Use OCR bounding-box coordinates to reconstruct rows and columns.
6. Run the same table reconstruction logic used for normal PDFs.

Display a message such as:

"Scanned document detected. OCR processing may take longer."

Do not OCR a page if usable text has already been extracted with PDF.js.

---

# 3. Libraries

Use stable browser-compatible versions of the following libraries.

## PDF.js

Purpose:

- Load PDFs
- Read pages
- Extract text
- Render scanned pages into canvas

Use Mozilla PDF.js.

---

## Tesseract.js

Purpose:

OCR fallback for scanned/image PDFs.

Only invoke OCR when PDF.js cannot obtain enough usable text from the page.

---

## SheetJS / XLSX

Purpose:

- Convert JavaScript arrays into worksheets.
- Create Excel workbooks.
- Export `.xlsx`.

Use the browser/CDN version of SheetJS where appropriate.

---

# 4. Privacy

The application should be privacy-friendly.

For V1:

- PDFs should NOT be uploaded to any server.
- Processing should happen locally in the browser.
- Files should NOT be stored.
- No user data should leave the browser.

Clearly show:

"Your document is processed locally in your browser and is not uploaded to our servers."

---

# 5. UI Design

Create a beautiful modern SaaS-style interface.

The UI should feel similar to modern tools such as:

- Smallpdf
- iLovePDF
- Linear
- Notion
- modern AI tools

Do NOT copy these websites.

Use them only for design inspiration.

---

# 6. Main Page Layout

The page should contain:

## Navbar

Left:

Logo icon

Product name:

PDF to Excel

Right:

- How It Works
- Privacy
- GitHub (optional)

No unnecessary navigation.

---

# 7. Hero Section

Headline:

"Convert PDF Tables to Excel"

Subheading:

"Extract tables from PDF documents and convert them into clean, editable Excel spreadsheets."

Below it show a large drag-and-drop upload card.

---

# 8. Upload Component

Create a large upload area.

Show:

PDF icon

"Drop your PDF here"

"or click to browse"

Button:

"Choose PDF"

Supported:

PDF files only.

Maximum initial size:

50 MB.

Display:

"Your PDF stays on your device."

Support:

- drag & drop
- click upload
- file picker

Reject non-PDF files.

---

# 9. File Selected State

After a PDF is selected display:

- file icon
- filename
- file size
- number of pages if available
- remove/change button

Example:

financial-report.pdf
2.4 MB • 12 pages

Button:

Convert to Excel

---

# 10. Processing Screen

After conversion begins show a proper progress interface.

Example:

Analyzing PDF...

Page 4 of 12

████████░░░░ 33%

Show processing stages such as:

1. Loading PDF
2. Reading pages
3. Detecting text
4. Detecting tables
5. Running OCR, if required
6. Reconstructing rows and columns
7. Cleaning data
8. Preparing preview
9. Creating workbook

Never freeze the interface without feedback.

---

# 11. PDF Processing Architecture

Separate extraction into reusable modules/functions.

Example structure:

```text
js/
    app.js
    pdf-parser.js
    table-detector.js
    ocr.js
    table-cleaner.js
    excel-exporter.js
    ui.js
```

Keep responsibilities separated.

---

# 12. PDF Text Extraction

For every page:

Use PDF.js:

```javascript
const textContent = await page.getTextContent();
```

Each item may contain information such as:

```javascript
{
  (str, transform, width, height);
}
```

Read text and its position.

Create an internal representation:

```javascript
{
    text: "John Smith",
    x: 120,
    y: 420,
    width: 85,
    height: 12,
    page: 1
}
```

Normalize page coordinates where necessary.

---

# 13. Row Detection

This is extremely important.

PDF text normally does NOT directly contain table rows and columns.

We must reconstruct them.

Group text items into rows based on similar Y coordinates.

For example:

```text
Name          Age       Country
John Smith    28        USA
Maria Lopez   31        Spain
```

might internally appear as individual positioned pieces of text.

Use a configurable Y-coordinate tolerance.

Example:

```javascript
const ROW_TOLERANCE = 4;
```

Items whose vertical centers are sufficiently close should belong to the same row.

Sort every detected row from:

left → right

based on X coordinates.

---

# 14. Column Detection

After rows have been found, infer columns from repeating horizontal positions.

For example:

Row 1 positions:

```text
30    220    330
```

Row 2:

```text
31    218    332
```

Row 3:

```text
29    221    331
```

These should be inferred as three columns.

Use clustering/tolerance logic rather than exact coordinates.

Create configurable constants such as:

```javascript
COLUMN_TOLERANCE;
ROW_TOLERANCE;
MIN_TABLE_ROWS;
MIN_TABLE_COLUMNS;
```

Do not hard-code extraction for one specific document.

---

# 15. Table Detection

Do NOT assume that all PDF text is part of a table.

Attempt to identify table-like regions.

A table probably has:

- at least 2 columns
- at least 2-3 rows
- repeating X alignments
- similar vertical spacing
- multiple values appearing along matching column positions

Build a scoring function for candidate rows.

Example conceptual scoring:

```text
+ repeating X coordinates
+ consistent number of columns
+ multiple sequential rows
+ consistent vertical spacing
+ horizontal/vertical lines if detectable
```

Group consecutive candidate rows into tables.

---

# 16. Multi-line Cells

Handle cells where text wraps.

Example:

```text
Company      Address
OpenAI       123 Example Street,
             San Francisco
```

Try to associate wrapped text with the nearest logical cell.

Do not blindly create another data row if the Y spacing suggests continuation text.

Create reasonable heuristics.

---

# 17. Merged/Spanning Cells

PDF tables may contain headers like:

```text
             Revenue
Company      2025      2026
```

Perfect merged-cell detection is not required for V1.

However:

- preserve text
- do not lose values
- try to align headers with their nearest columns
- allow user correction in preview

Do not overcomplicate this at the expense of basic table extraction.

---

# 18. Numeric Data

Preserve numbers whenever possible.

Examples:

```text
125
1,250
19.99
-45
45%
$1,250
₹25,000
€19.99
2026-09-09
```

Do not destroy formatting during extraction.

For Excel:

Where it is safe and obvious:

- normal numbers → numeric cells
- percentages → percentage values
- dates → optionally proper Excel dates

But if conversion would risk changing the original value, retain it as text.

Accuracy is more important than automatic type conversion.

---

# 19. OCR Fallback

Determine whether a page likely requires OCR.

Example logic:

If:

```javascript
textContent.items.length < threshold;
```

or extracted text is nearly empty:

render the page at higher resolution.

Example:

```javascript
const viewport = page.getViewport({ scale: 2 });
```

Render to canvas.

Send the image to Tesseract.js.

Request OCR information that contains:

- text
- bounding box coordinates
- confidence

Convert OCR output into the same normalized text-item structure:

```javascript
{
    text,
    x,
    y,
    width,
    height,
    confidence,
    source: "ocr"
}
```

Then pass those items through the normal row/table detection system.

---

# 20. OCR Performance

OCR is computationally expensive.

Therefore:

- only run OCR when necessary
- process pages sequentially or with limited concurrency
- show OCR progress
- prevent browser memory crashes
- terminate Tesseract workers after processing
- release canvas memory
- avoid storing unnecessarily large image buffers

Consider using a reusable OCR worker rather than initializing Tesseract for every page.

---

# 21. OCR Accuracy

Ignore extremely low-confidence OCR results where appropriate.

Have a configurable confidence threshold.

Example:

```javascript
const MIN_OCR_CONFIDENCE = 40;
```

Do not remove uncertain text too aggressively.

Accuracy is more important than perfect cleanliness.

---

# 22. Multiple Tables

One PDF can contain:

- one table
- many tables
- tables on several pages
- regular paragraphs mixed with tables

The application should identify multiple tables.

Create:

```javascript
tables = [
    {
        page: 1,
        title: "Table 1",
        rows: [...]
    },
    {
        page: 3,
        title: "Table 2",
        rows: [...]
    }
]
```

If the same table clearly continues onto another page, it may be merged.

For V1, if reliable continuation detection is difficult, it is acceptable to store them as separate tables.

---

# 23. Repeated Headers

When tables continue across pages, PDFs often repeat headers.

Example:

Page 1:

```text
Name | Age | Country
...
```

Page 2:

```text
Name | Age | Country
...
```

If two sequential detected tables have identical or nearly identical first rows, consider the second first row a repeated header.

Avoid duplicating the header when merging.

---

# 24. Preview Screen

After extraction show:

"3 tables detected"

Provide a tab or card for each table.

Example:

Table 1 — Page 1
Table 2 — Page 3
Table 3 — Page 4

Show extracted data inside an HTML table.

Example:

| Name        | Age | Country |
| ----------- | --- | ------- |
| John Smith  | 28  | USA     |
| Maria Lopez | 31  | Spain   |

---

# 25. Editable Preview

Make preview cells editable.

The user should be able to click a cell and change incorrectly extracted content.

Use either:

```html
<input />
```

or:

```html
contenteditable
```

Changes must update the underlying JavaScript table data.

This is important because PDF extraction will never be 100% perfect.

---

# 26. Basic Table Editing

Provide simple controls:

- Delete row
- Delete column
- Rename column/header
- Remove entire table

Optional if easy:

- Add row
- Add column

Do not turn the project into a full spreadsheet application.

---

# 27. Excel Export

Use SheetJS.

Create one workbook.

If multiple tables exist, use separate worksheets.

Example:

```text
Table 1
Table 2
Table 3
```

Prefer more descriptive names when possible.

For example:

```text
Page 1 - Table 1
Page 3 - Table 2
```

Remember Excel sheet names have restrictions and length limits.

Sanitize sheet names.

---

# 28. Excel Formatting

Create a reasonably polished Excel workbook.

For every sheet:

- first row acts as header when appropriate
- reasonable column widths
- preserve data
- avoid unnecessarily narrow columns
- freeze header row if easily supported
- use basic number formats where reliable

Automatically calculate approximate column widths based on cell content.

Example logic:

```javascript
columnWidth = Math.min(Math.max(longestCellLength + 2, 10), 50);
```

---

# 29. Excel Filename

If input:

```text
bank-statement.pdf
```

Output:

```text
bank-statement.xlsx
```

Do not generate random names unless necessary.

---

# 30. Download UI

After conversion show a large primary button:

"Download Excel"

Also show:

"Convert Another PDF"

If the user edited preview data, Excel should contain the edited version.

---

# 31. No Table Found

Handle documents where no obvious table is detected.

Show:

"No tables were confidently detected in this PDF."

Then provide options:

- Try OCR
- Extract page text
- Upload another PDF

If the PDF contained useful text arranged approximately like columns, still show a low-confidence result and allow the user to review it instead of silently discarding it.

---

# 32. Error Handling

Handle:

- invalid PDF
- encrypted/password-protected PDF
- corrupted PDF
- file too large
- unsupported file
- PDF.js failure
- OCR failure
- memory problems
- Excel generation failure

Show understandable errors.

Bad:

"Unhandled promise rejection."

Good:

"We couldn't read this PDF. It may be corrupted or password-protected."

---

# 33. Password-Protected PDFs

If PDF.js detects password protection:

show:

"This PDF is password-protected. Please upload an unlocked PDF."

Do not attempt security bypasses.

---

# 34. Responsive Design

The app must work on:

- Desktop
- Laptop
- Tablet
- Mobile

However, optimize primarily for desktop because table preview is easier there.

On mobile:

make tables horizontally scrollable.

---

# 35. Accessibility

Implement:

- proper `<label>` elements
- keyboard navigation
- buttons rather than clickable divs
- appropriate ARIA attributes
- clear focus styles
- reasonable contrast
- semantic HTML

---

# 36. Styling

Use clean custom CSS.

Design direction:

- white/light neutral background
- modern card surfaces
- soft borders
- subtle shadows
- rounded corners
- large typography
- generous spacing
- clean animations
- polished upload area
- responsive layout

Primary visual hierarchy:

1. Upload
2. Conversion status
3. Preview
4. Download

Avoid:

- excessive gradients
- excessive animation
- clutter
- oversized navigation
- childish design

---

# 37. Dark Mode

Dark mode is optional.

Do not spend significant development effort on dark mode until extraction functionality works correctly.

---

# 38. Animations

Use lightweight CSS animations.

Examples:

- drag/drop hover
- upload success
- progress bar
- table appearance
- loading spinner
- button hover

Do not add large animation libraries.

---

# 39. Project Structure

Use a clean structure similar to:

```text
pdf-to-excel/
│
├── index.html
│
├── css/
│   └── styles.css
│
├── js/
│   ├── app.js
│   ├── config.js
│   ├── pdf-parser.js
│   ├── table-detector.js
│   ├── ocr.js
│   ├── table-cleaner.js
│   ├── excel-exporter.js
│   └── ui.js
│
├── assets/
│   └── icons/
│
├── README.md
│
└── AGENT.md
```

Do not put thousands of lines into `index.html`.

Use JavaScript modules.

Example:

```html
<script type="module" src="./js/app.js"></script>
```

---

# 40. config.js

Store adjustable extraction constants in one file.

Example:

```javascript
export const CONFIG = {
  MAX_FILE_SIZE_MB: 50,

  ROW_Y_TOLERANCE: 4,

  COLUMN_X_TOLERANCE: 12,

  MIN_TABLE_ROWS: 2,

  MIN_TABLE_COLUMNS: 2,

  MIN_TEXT_ITEMS_BEFORE_OCR: 5,

  OCR_SCALE: 2,

  MIN_OCR_CONFIDENCE: 40,
};
```

Do not scatter magic numbers throughout the code.

Adjust values after testing.

---

# 41. Internal Data Model

Use a predictable normalized representation.

Example:

```javascript
const documentData = {
  filename: "",
  pageCount: 0,

  pages: [
    {
      pageNumber: 1,

      extractionMethod: "pdf-text",

      textItems: [],

      tables: [],
    },
  ],

  tables: [],
};
```

Table example:

```javascript
{
    id: "table-1",

    pageNumbers: [1],

    confidence: 0.87,

    rows: [
        ["Name", "Age", "Country"],
        ["John Smith", "28", "USA"]
    ]
}
```

---

# 42. Confidence Score

Where practical calculate a confidence score for detected tables.

Example:

```text
High confidence
Medium confidence
Low confidence
```

Consider:

- row consistency
- column alignment consistency
- OCR confidence
- number of detected rows

Preview low-confidence tables but clearly label them.

Do NOT silently discard them.

---

# 43. Table Extraction Algorithm

Implement table detection in understandable steps.

Suggested algorithm:

### Step 1

Extract positioned text items.

### Step 2

Normalize coordinates.

### Step 3

Remove empty strings.

### Step 4

Group text items into rows based on Y coordinates.

### Step 5

Sort every row by X.

### Step 6

Analyze X positions across neighboring rows.

### Step 7

Cluster repeating X positions to infer column boundaries.

### Step 8

Map every text item to its nearest logical column.

### Step 9

Merge text pieces occupying the same cell.

### Step 10

Score consecutive rows for table consistency.

### Step 11

Split unrelated row sequences into separate tables.

### Step 12

Normalize resulting arrays so every row has the same number of columns.

Do not base detection purely on spaces in extracted strings.

Coordinates are much more reliable.

---

# 44. Column Boundary Strategy

Do not require every cell to start at exactly the same X coordinate.

Instead:

Find clusters.

Conceptually:

```javascript
function clusterXPositions(values, tolerance) {}
```

For example:

```text
100
102
98
101
```

should belong to the same column.

And:

```text
250
248
253
```

should belong to another column.

Use median/average cluster values.

---

# 45. Cell Mapping

Once expected columns are known:

For each text item in a row:

- calculate its X center or start
- assign it to the nearest reasonable column
- concatenate multiple pieces in the same cell
- preserve their left-to-right order

Example:

```text
"New" + "York"
```

should become:

```text
New York
```

not separate columns.

---

# 46. Table Boundaries

A table should end when:

- column structure changes significantly
- there is a large vertical gap
- there are several paragraph-like lines
- next lines do not match detected column structure

Do not combine every page's content into one giant table.

---

# 47. Header Detection

Attempt to determine whether the first row is a header.

Possible signals:

- text rather than numbers
- unique labels
- different font weight if available
- subsequent rows have consistent value patterns

If uncertain, still preserve the first row.

Never remove data based only on header guessing.

---

# 48. Text Cleaning

Clean values carefully.

Perform:

- trim whitespace
- collapse repeated spaces
- remove unnecessary line breaks
- preserve meaningful punctuation
- preserve decimal points
- preserve minus signs
- preserve currencies
- preserve percentages
- preserve IDs with leading zeroes

Important:

A value such as:

```text
001245
```

must not automatically become:

```text
1245
```

because it may be an ID/account number.

---

# 49. Large PDFs

Avoid loading every high-resolution rendered page simultaneously.

Process page-by-page.

After finishing a page:

- store extracted structured data
- release canvas
- release image data
- continue

Try to keep memory usage reasonable.

---

# 50. Cancellation

Add a:

"Cancel"

button during long conversion operations.

Use a processing state/abort flag.

The user should be able to stop:

- PDF parsing
- OCR processing

as cleanly as possible.

---

# 51. Security

Never run code embedded in documents.

Treat extracted text as untrusted.

When displaying text:

prefer:

```javascript
textContent;
```

instead of:

```javascript
innerHTML;
```

where possible.

Prevent extracted content from injecting HTML/JavaScript.

---

# 52. Performance

Do not block the UI unnecessarily.

Use:

```javascript
async/await
```

properly.

Allow progress updates between pages.

For OCR-heavy operations consider Web Workers where supported.

Tesseract itself may use worker-based processing.

---

# 53. Application State

Create clean state management using vanilla JavaScript.

For example:

```javascript
const state = {
  file: null,
  pdf: null,
  processing: false,
  progress: 0,
  currentPage: 0,
  pages: [],
  tables: [],
  errors: [],
};
```

Do not introduce a framework just for state management.

---

# 54. Drag and Drop

Implement proper states:

Default:

"Drop your PDF here"

Dragging over:

"Release to upload"

Invalid:

"Please upload a PDF file."

Selected:

show filename.

Use:

```javascript
dragenter;
dragover;
dragleave;
drop;
```

Prevent browser default navigation when PDF is dropped.

---

# 55. Preview Performance

For huge extracted tables:

Do not render thousands of rows unnecessarily if it freezes the browser.

Initially show:

first 100–200 rows

with an option:

"Show all rows"

Excel export must still contain every row.

---

# 56. Testing

Create test scenarios.

Test at minimum:

### Test 1

Simple PDF with:

```text
Name | Age | City
```

### Test 2

Financial table.

### Test 3

Bank statement.

### Test 4

Invoice containing line items.

### Test 5

Multi-page table.

### Test 6

Multiple unrelated tables.

### Test 7

Scanned invoice.

### Test 8

Scanned table image embedded in PDF.

### Test 9

PDF containing no tables.

### Test 10

PDF containing paragraphs + table.

### Test 11

Large PDF.

### Test 12

PDF with blank pages.

### Test 13

Corrupted PDF.

### Test 14

Password-protected PDF.

### Test 15

Table with missing cells.

### Test 16

Rows containing currency and percentages.

### Test 17

Table containing long multi-line text.

---

# 57. Accuracy Debug Mode

During development add an optional debug mode.

It should allow developers to inspect:

- extracted text items
- X coordinate
- Y coordinate
- assigned row
- assigned column
- table confidence

Optionally create a page visualization where bounding boxes are drawn over the rendered PDF.

This is extremely useful for improving table detection.

Keep debug mode disabled by default in production.

Example:

```javascript
const DEBUG = false;
```

---

# 58. Development Priorities

Build the project in this exact priority order.

## Phase 1 — UI foundation

Create:

- navbar
- hero
- upload box
- responsive styling

Make PDF file upload work.

---

## Phase 2 — PDF loading

Integrate PDF.js.

Get:

- PDF filename
- number of pages
- page text

Log positioned text items for development.

---

## Phase 3 — Row reconstruction

Implement robust grouping of text items by Y coordinate.

Test thoroughly before moving on.

---

## Phase 4 — Column reconstruction

Implement X-coordinate clustering.

Turn positioned rows into structured arrays.

Test this thoroughly.

---

## Phase 5 — Table detection

Detect sequences of rows sharing similar column structures.

Support multiple tables.

---

## Phase 6 — Preview

Display extracted data as HTML tables.

Allow table switching.

---

## Phase 7 — Excel generation

Integrate SheetJS.

Convert arrays into worksheets.

Generate `.xlsx`.

Add download button.

At this point the application should already work well for text-based PDFs.

---

## Phase 8 — OCR

Only after normal PDF extraction works:

Integrate Tesseract.js.

Add scanned-PDF detection.

Render scanned pages.

Perform OCR.

Feed OCR positions into the existing table reconstruction pipeline.

Do NOT create a completely separate table extraction algorithm for OCR.

Normalize both data sources into the same text-item format.

---

## Phase 9 — Editable preview

Allow editing:

- cell values
- rows
- columns
- table removal

Ensure export uses edited values.

---

## Phase 10 — Polish

Add:

- errors
- loading indicators
- cancel button
- accessibility
- responsive behavior
- performance optimization
- privacy messaging

---

# 59. Important Engineering Rule

Do NOT try to implement everything inside one massive JavaScript file.

Separate:

PDF extraction

from:

OCR extraction

from:

table reconstruction

from:

Excel generation

from:

UI.

The table detector should ideally not care whether items came from PDF.js or Tesseract.

Both should produce something resembling:

```javascript
{
  (text, x, y, width, height, page, source);
}
```

---

# 60. Important Accuracy Rule

Never claim:

"100% accurate PDF to Excel conversion."

PDF files do not contain a universal table structure.

The application should instead optimize for:

- high accuracy
- recoverable data
- editable preview
- graceful fallback

If table detection is uncertain, preserve the information rather than deleting it.

---

# 61. README.md

Create a useful README containing:

- project overview
- features
- technology
- how the PDF extraction works
- how OCR fallback works
- how table detection works
- how Excel generation works
- how to run locally
- browser requirements
- known limitations
- privacy model

Because the project is static, it should be runnable using something like:

```bash
npx serve .
```

or VS Code Live Server.

Do not require Node.js runtime in production unless needed only for development tooling.

---

# 62. AGENT.md

Create an `AGENT.md` containing the project's permanent engineering rules.

Include:

## Mission

Accurately convert tables from PDFs into editable Excel workbooks.

## Core principles

1. Accuracy > visual features.
2. Preserve user data.
3. Never silently discard uncertain values.
4. PDF text extraction before OCR.
5. OCR only as fallback.
6. Table detection should be coordinate-based.
7. Keep all processing client-side for V1.
8. Do not introduce a backend without a strong reason.
9. Do not introduce React/frameworks.
10. Keep modules small and maintainable.
11. Ensure edited preview data is what gets exported.
12. Test extraction changes against multiple PDF layouts.

---

# 63. Browser Support

Target current versions of:

- Chrome
- Edge
- Firefox
- Safari

If a library limitation exists on a browser, handle it gracefully.

---

# 64. Deployment

The final application should be deployable as a static website to:

- Vercel
- Netlify
- Cloudflare Pages
- GitHub Pages

No server-side API should be required for V1.

---

# 65. Final User Experience

A finished interaction should look like this:

```text
Convert PDF Tables to Excel

[ Drop PDF here ]

      ↓

financial-report.pdf
12 pages • 2.4 MB

[ Convert to Excel ]

      ↓

Analyzing document...

Page 7 / 12
Detecting tables...

████████████░░░ 58%

      ↓

3 tables detected

[Table 1] [Table 2] [Table 3]

| Product | Quantity | Revenue |
| ...     | ...      | ...     |

      ↓

[ Download Excel ]

financial-report.xlsx
```

---

# 66. Code Quality Requirements

Use:

- meaningful variable names
- small reusable functions
- JSDoc where useful
- async/await
- ES modules
- constants instead of magic numbers
- defensive error handling

Avoid:

- global variables everywhere
- duplicate extraction logic
- deeply nested callbacks
- massive functions
- unnecessary dependencies
- inline JavaScript
- inline CSS
- placeholder/mock functionality

---

# 67. Important Instruction to the Coding Agent

Do NOT stop after creating only the interface.

The core PDF → Table → Excel workflow must actually work.

A beautiful upload UI with fake extraction is NOT acceptable.

At every implementation stage, verify that the underlying functionality works before moving to the next stage.

Do not leave comments such as:

```javascript
// TODO: implement table extraction
```

for fundamental product functionality.

Implement it.

---

# 68. Build Strategy

Before writing code:

1. Inspect the existing project.
2. Create the proper file structure.
3. Define the shared data model.
4. Implement features sequentially.
5. Test each phase.
6. Fix console errors before continuing.
7. Avoid rewriting working modules unnecessarily.

If bugs occur, diagnose their root cause rather than applying random patches.

---

# 69. Definition of Done

The project is considered complete when:

- PDF drag-and-drop works.
- PDF file selection works.
- Invalid files are rejected.
- PDF.js successfully reads text-based PDFs.
- Text positions are extracted.
- Rows are reconstructed.
- Columns are reconstructed.
- Multiple tables can be detected.
- Scanned PDFs trigger OCR.
- OCR results can be converted into rows/columns.
- Extracted tables are previewed.
- Preview data is editable.
- Multiple tables can be exported.
- `.xlsx` download works.
- Excel output contains actual extracted data.
- Progress indicators work.
- Errors are user-friendly.
- App works without a backend.
- No PDF is sent to a remote server.
- UI is responsive.
- No major console errors exist.
- README is complete.
- AGENT.md is complete.

---

# 70. Start Implementation

Now build the complete project.

Do not merely explain how you would build it.

Create the files and implement the application.

Work sequentially following the phases above.

Prioritize the actual PDF table extraction algorithm over cosmetic enhancements.

After implementation, review the complete codebase for:

- extraction accuracy
- duplicated logic
- browser errors
- memory leaks
- OCR worker cleanup
- Excel export correctness
- mobile responsiveness
- security issues

Then fix any issues you find before considering the implementation complete.
