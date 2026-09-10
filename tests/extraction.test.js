import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTablesOnPage, combineTables, buildFallbackTable } from '../js/table-detector.js';
import { auditExtraction } from '../js/validation.js';
import { toCellValue } from '../js/excel-exporter.js';
import { wordsToItems } from '../js/ocr.js';
import { extractPageTextItems, loadPdf } from '../js/pdf-parser.js';
const item = (text, x, y, page=1, width=String(text).length*5) => ({text,x,y,page,width,height:10,source:'pdf-text'});
const layout = (rows, page=1) => rows.flatMap((row,r) => row.flatMap((text,c) => text === '' ? [] : [item(text,c*150,r*20,page)]));
function convert(items) { return combineTables([...new Set(items.map(i=>i.page))].flatMap(p=>detectTablesOnPage(items.filter(i=>i.page===p),p))); }

test('simple table keeps headings, blanks, zero IDs, currency and row order', () => {
 const rows = [['ID','Description','Amount'], ['0012','Widget','$1,250.00'], ['0013','','12,50'], ['0014','Other','-0.50']];
 assert.deepEqual(convert(layout(rows)).rows, rows);
});
test('small second table is retained beside larger invoice table', () => {
 const items=[...layout([['Item','Amount'],['A','10'],['B','20'],['C','30']]), ...layout([['Tax','Total'],['5','65']]).map(i=>({...i,y:i.y+180}))];
 const c=convert(items); assert.equal(c.rows.length,6); assert.deepEqual(c.rows.at(-1),['5','65']); assert.ok(auditExtraction(items,c,1).passed);
});
test('same headings around other sections never reorder pages or remove repeats', () => {
 const c=convert([...layout([['Code','Amount'],['A','1']],1), ...layout([['Name','Qty'],['Middle','2']],2), ...layout([['Code','Amount'],['B','3']],3)]);
 assert.deepEqual(c.rows,[['Code','Amount'],['A','1'],['Name','Qty'],['Middle','2'],['Code','Amount'],['B','3']]);
});
test('duplicate headings remain separate columns; sparse physical row is not glued', () => {
 const rows=[['Item','Value','Value'],['A','1','2'],['wrapped','',''],['B','3','4']];
 assert.deepEqual(convert(layout(rows)).rows, rows);
});
test('multiline headings and right-aligned numbers retain their positions', () => {
 const items=[item('Description',0,0),item('Total',150,0),item('amount',150,15),item('Widget',0,40),item('100.00',170,40),item('Other',0,60),item('2.00',180,60)];
 const c=convert(items); assert.deepEqual(c.rows,[['Description','Total'],['','amount'],['Widget','100.00'],['Other','2.00']]);
});
test('fallback retains prose on every page and blank page is reported', () => {
 const items=[item('First paragraph.',0,0),item('Last paragraph.',0,0,3)];
 const t=buildFallbackTable(items); assert.deepEqual(t.rows,[['First paragraph.'],['Last paragraph.']]);
 assert.deepEqual(auditExtraction(items,t,3).emptyPages,[2]);
});
test('audit detects missing and duplicated text, including repeated values', () => {
 const items=layout([['A','A'],['B','C']]);
 const c=convert(items); assert.ok(auditExtraction(items,c,1).passed);
 c.rows[0][1]='B'; const result=auditExtraction(items,c,1);
 assert.equal(result.passed,false); assert.deepEqual(result.missing,[{token:'A',count:1}]); assert.deepEqual(result.extra,[{token:'B',count:1}]);
});
test('low confidence OCR words retained at PDF point scale', () => {
 const items=wordsToItems({words:[{text:'0012',confidence:10,bbox:{x0:100,y0:80,x1:140,y1:100}}]},2);
 assert.equal(items.length,1); assert.equal(items[0].x,50); assert.equal(items[0].height,10); assert.equal(items[0].confidence,10);
 assert.ok(convert(items).issues.some(i=>i.lowConfidence));
});
test('Excel preserves ambiguous financial values, precision and formula-like text', () => {
 for(const s of ['0012','-0012','12,50','$1,250.00','₹25,000','1.2300','12345678901234567890','45%','2026-09-10','=SUM(A1:A2)','+12','  custom  ']) assert.equal(toCellValue(s),s);
});
test('PDF viewport transform handles cropped coordinates and releases pages', async () => {
 let cleaned=false;
 globalThis.pdfjsLib={Util:{transform:(v,t)=>[1,0,0,1,t[4]-50,800-t[5]]}};
 const pdf={getPage:async()=>({getViewport:()=>({transform:[1,0,0,-1,-50,800]}),getTextContent:async()=>({items:[{str:'X',transform:[10,0,0,10,100,700],width:10,height:10}]}),cleanup:()=>{cleaned=true}})};
 const items=await extractPageTextItems(pdf,1); assert.equal(items[0].x,50); assert.equal(items[0].y,90); assert.ok(cleaned);
});
test('corrupt and password-protected files fail with friendly errors', async () => {
 for(const name of ['InvalidPDFException','PasswordException']) {
 globalThis.pdfjsLib={getDocument:()=>({promise:Promise.reject(Object.assign(new Error(name==='PasswordException'?'password required':'invalid pdf'),{name}))})};
 await assert.rejects(loadPdf({arrayBuffer:async()=>new ArrayBuffer(0)}), /password-protected|corrupted/);
 }
});
test('blank pages return no invented cells',()=>assert.deepEqual(detectTablesOnPage([],1),[]));
