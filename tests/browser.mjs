import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true});
try {
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror', e=>errors.push(e.message));
// Set TEST_VENDOR_DIR to a directory containing the pinned vendor files for offline checks.
if (process.env.TEST_VENDOR_DIR) {
 const dir = process.env.TEST_VENDOR_DIR;
 await page.route('https://cdnjs.cloudflare.com/**/pdf.min.js', r=>r.fulfill({path:dir+'/pdf-project-pdf.cjs',contentType:'application/javascript'}));
 await page.route('https://cdnjs.cloudflare.com/**/pdf.worker.min.js', r=>r.fulfill({path:dir+'/pdf.worker.min.js',contentType:'application/javascript'}));
 await page.route('https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js', r=>r.fulfill({path:dir+'/pdf-project-xlsx.cjs',contentType:'application/javascript'}));
 await page.route('https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/tesseract.min.js', r=>r.fulfill({body:'',contentType:'application/javascript'}));
}
await page.goto(process.env.TEST_BASE_URL || 'http://127.0.0.1:8080');
await page.locator('#fileInput').setInputFiles(decodeURIComponent(new URL('../SIEMENS ENERGY 993 A2.pdf', import.meta.url).pathname));
await page.locator('#fileDetails').filter({hasText:'32 pages'}).waitFor();
await page.locator('#verifyVisually').uncheck();
await page.locator('#convertBtn').click();
await page.locator('#editBtn').waitFor({state:'visible',timeout:60000});
await page.locator('#editBtn').click();
await page.locator('#editorDialog').waitFor({state:'visible'});
await page.getByRole('textbox',{name:'A1',exact:true}).fill('0012');
await page.locator('#undoEdit').click();
assert.equal(await page.getByRole('textbox',{name:'A1',exact:true}).inputValue(),'SIEMENS');
await page.locator('#redoEdit').click();
assert.equal(await page.getByRole('textbox',{name:'A1',exact:true}).inputValue(),'0012');
await page.locator('#insertRow').click(); await page.locator('#undoEdit').click();
await page.locator('#insertColumn').click(); await page.locator('#undoEdit').click();
await page.getByRole('textbox',{name:'B1',exact:true}).focus();
await page.locator('#cellValue').fill('$1,250.00');
await page.locator('#goToRow').fill('101');await page.locator('#goToRow').press('Tab');
assert.match(await page.locator('#editorRange').textContent(),/101–200/);
await page.locator('#previousRows').click();
await page.locator('#showSource').click();
assert.equal(await page.locator('#sourcePane').isVisible(),true);
await page.locator('#sourcePdf canvas').waitFor({state:'visible', timeout:30000});
await page.screenshot({path:'/tmp/pdf-project-editor.png'});
const download=page.waitForEvent('download'); await page.locator('#editorDownload').click();const d=await download;
await d.saveAs('/tmp/pdf-project-export.xlsx');
const exported = await page.evaluate(b64 => {
 const wb = XLSX.read(b64,{type:'base64',cellStyles:true});
 const ws=wb.Sheets[wb.SheetNames[0]];
 return {a:ws.A1,b:ws.B1,sheets:wb.SheetNames.length};
}, readFileSync('/tmp/pdf-project-export.xlsx').toString('base64'));
assert.equal(exported.a.v,'0012');assert.equal(exported.a.t,'s');assert.equal(exported.b.v,'$1,250.00');assert.equal(exported.sheets,1);
await page.keyboard.press('Escape');assert.equal(await page.locator('#editorDialog').isVisible(),false);
await page.locator('#editBtn').click();assert.equal(await page.getByRole('textbox',{name:'A1',exact:true}).inputValue(),'0012');
await page.setViewportSize({width:390,height:844});
await page.screenshot({path:'/tmp/pdf-project-mobile.png'});
assert.equal(errors.length,0,errors.join('\n'));
console.log('Browser passed: 32-page upload, extraction, editor, edits, undo/redo, insert, pagination, PDF comparison, Escape/reopen, mobile, XLSX round trip.');
} finally { await browser.close(); }
