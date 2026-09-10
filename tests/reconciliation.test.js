import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileReadings } from '../js/reconciliation.js';
import { detectTablesOnPage, combineTables } from '../js/table-detector.js';
import { auditExtraction } from '../js/validation.js';
import { wordsToItems } from '../js/ocr.js';
import { attachVerificationIssues } from '../js/page-verifier.js';
const word=(text,x=0,y=0,source='ocr',confidence=95,width=20)=>({text,x,y,width,height:10,page:1,source,confidence});
const pdf=(text,x=0,y=0,width=20)=>word(text,x,y,'pdf-text',undefined,width);

test('recover a missing heading and every repeated missing value at their source positions',()=>{
 const text=[pdf('Item'),pdf('Qty',200),pdf('Bolt',0,20),pdf('2',200,20),pdf('Nut',0,40),pdf('3',200,40)];
 const a=[word('Item'),word('UM',100),word('Qty',200),word('Bolt',0,20),word('PC',100,20),word('2',200,20),word('Nut',0,40),word('PC',100,40),word('3',200,40)];
 const result=reconcileReadings(text,a,structuredClone(a));
 assert.equal(result.counts.recovered,3);
 const combined=combineTables(detectTablesOnPage(result.items,1));
 assert.deepEqual(combined.rows,[['Item','UM','Qty'],['Bolt','PC','2'],['Nut','PC','3']]);
 assert.ok(auditExtraction(result.items,combined,1).passed);
});
test('two high-confidence readings correct embedded OCR and preserve original evidence',()=>{
 const r=reconcileReadings([pdf('1O.00')],[word('10.00')],[word('10.00')]);
 assert.equal(r.items[0].text,'10.00');assert.equal(r.counts.corrected,1);
 assert.deepEqual(r.regions[0].texts,['1O.00','10.00','10.00']);
});
test('an OCR disagreement never overwrites an existing PDF value',()=>{
 const r=reconcileReadings([pdf('100.00')],[word('10.00')],[word('100.00')]);
 assert.equal(r.items[0].text,'100.00');assert.equal(r.counts.agreement,1);
 const uncertain=reconcileReadings([pdf('100.00')],[word('10.00')],[word('1000.00')]);
 assert.equal(uncertain.items[0].text,'100.00');assert.equal(uncertain.counts.unresolved,1);
});
test('low-confidence consensus is not sufficient to replace a value',()=>{
 const r=reconcileReadings([pdf('100')],[word('10',0,0,'ocr',20)],[word('10',0,0,'ocr',20)]);
 assert.equal(r.items[0].text,'100');assert.equal(r.counts.corrected,0);
});
test('phrase-to-word matching does not duplicate embedded text',()=>{
 const r=reconcileReadings([pdf('PART NUMBER',0,0,100)],[word('PART'),word('NUMBER',40)],[word('PART'),word('NUMBER',40)]);
 assert.equal(r.items.length,1);assert.equal(r.items[0].text,'PART NUMBER');assert.equal(r.counts.agreement,1);
});
test('same numbers in adjacent columns or different rows never cross-match',()=>{
 const a=[word('1',0),word('1',100),word('1',0,30)];
 const r=reconcileReadings([],a,structuredClone(a));
 assert.equal(r.items.length,3);assert.equal(r.regions.length,3);
});
test('one-pass-only words survive but are never claimed as verified',()=>{
 const r=reconcileReadings([],[],[word('Missing')]);
 assert.equal(r.items[0].text,'Missing');assert.equal(r.counts.unresolved,1);
});
test('conflicting OCR-only reading retains both alternatives without duplicating the cell',()=>{
 const r=reconcileReadings([],[word('0012')],[word('O012')]);
 assert.equal(r.items.length,1);assert.equal(r.items[0].text,'0012');assert.equal(r.counts.unresolved,1);
 assert.deepEqual(r.regions[0].texts,['','0012','O012']);
});
test('all input fragments have evidence, including alternatives not selected',()=>{
 const sources=[[pdf('A'),pdf('B',100)],[word('A'),word('C',100),word('D',200)],[word('A'),word('C',100),word('D',200)]];
 const r=reconcileReadings(...sources);
 for(let i=0;i<3;i++) assert.equal(r.regions.reduce((n,g)=>n+g.itemCounts[i],0),sources[i].length);
});
test('high resolution OCR normalizes into the same PDF coordinates',()=>{
 const r=wordsToItems({words:[{text:'ID',confidence:95,bbox:{x0:300,y0:600,x1:360,y1:630}}]},1,3);
 assert.deepEqual([r[0].x,r[0].y,r[0].width,r[0].height],[100,200,20,10]);
});
test('region evidence attaches to only the closest source row, not each preceding section',()=>{
 const tables=[{rows:[['A']],rowOrigins:[{y:0}],issues:[]},{rows:[['B']],rowOrigins:[{y:100}],issues:[]}];
 attachVerificationIssues(tables,{regions:[{id:'x',y:100,status:'recovered',texts:['','B','B']}]});
 assert.equal(tables[0].issues.length,0);assert.equal(tables[1].issues.length,1);
});

test('unconfirmed OCR-only additions remain in evidence rather than polluting a text page',()=>{
 const r=reconcileReadings([pdf('Item')],[word('Item'),word('|',100,0,'ocr',10)],[]);
 assert.deepEqual(r.items.map(i=>i.text),['Item']);
 assert.ok(r.regions.some(g=>g.texts[1]==='|' && g.selected===null));
});
test('a tall OCR artifact cannot bridge separate physical rows',()=>{
 const r=reconcileReadings([pdf('A',0,0),pdf('B',0,30)],[word('artifact',0,0,'ocr',0,30)].map(i=>({...i,height:100})),[]);
 assert.ok(!r.regions.some(g=>g.texts[0]==='A B'));
});
test('cancellation interrupts an unresponsive OCR promise',async()=>{
 const {cancellable}=await import('../js/page-verifier.js');
 await assert.rejects(cancellable(new Promise(()=>{}),()=>true),{code:'CANCELLED'});
});
test('line preprocessing removes long borders while retaining isolated glyph strokes',async()=>{
 const {removeTableLines}=await import('../js/ocr-preprocess.js');
 const width=100,height=30,data=new Uint8ClampedArray(width*height*4).fill(255);
 const black=(x,y)=>{for(let k=0;k<3;k++)data[(y*width+x)*4+k]=0;};
 for(let x=0;x<100;x++)black(x,5);
 for(let y=15;y<22;y++)black(10,y);
 const ctx={getImageData:()=>({width,height,data}),putImageData(){}};
 removeTableLines({width,height,getContext:()=>ctx},1);
 assert.equal(data[(5*width+50)*4],255);assert.equal(data[(18*width+10)*4],0);
});

test('partial OCR consensus cannot truncate an existing unit or identifier',()=>{
 const r=reconcileReadings([pdf('2 IN')],[word('2')],[word('2')]);
 assert.equal(r.items[0].text,'2 IN');assert.equal(r.counts.corrected,0);
});
test('slightly displaced identical punctuation is not duplicated',()=>{
 const a={...pdf('-',100,20),width:4,height:2};
 const b={...word('-',100,23),width:4,height:2};
 const r=reconcileReadings([a],[b],[b]);assert.equal(r.items.length,1);assert.equal(r.counts.recovered,0);
});
test('agreed ruling boundaries preserve narrow neighbouring and fully empty columns',()=>{
 const columns=[{x0:0,x1:25},{x0:25,x1:50},{x0:50,x1:75}];
 const items=[word('UM',5),word('QTY',28),word('PC',5,20),word('2',28,20)].map(i=>({...i,width:18,tableColumn:i.x<25?0:1,tableColumns:columns}));
 assert.deepEqual(combineTables(detectTablesOnPage(items,1)).rows,[['UM','QTY',''],['PC','2','']]);
});
test('visual verification failures retain PDF text and mark both passes incomplete',async()=>{
 const {verifyPage}=await import('../js/page-verifier.js');
 const {terminateOcrEngine}=await import('../js/ocr.js');
 const previousDocument=globalThis.document, previousTesseract=globalThis.Tesseract;
 globalThis.document={createElement:()=>{
  const canvas={width:0,height:0};
  canvas.getContext=()=>({fillRect(){},drawImage(){},clearRect(){},putImageData(){},getImageData:()=>({width:canvas.width,height:canvas.height,data:new Uint8ClampedArray(canvas.width*canvas.height*4).fill(255)})});
  return canvas;
 }};
 globalThis.Tesseract={createWorker:async()=>{throw new Error('model unavailable');}};
 const document={getPage:async()=>({getViewport:()=>({width:20,height:20}),render:()=>({promise:Promise.resolve()}),cleanup(){}})};
 try{
  const result=await verifyPage(document,1,[pdf('Retain me')]);
  assert.equal(result.items[0].text,'Retain me');assert.equal(result.failures.length,2);assert.equal(result.completed,0);
  await assert.rejects(verifyPage(document,1,[]),/could not be read/);
 }finally{await terminateOcrEngine();globalThis.document=previousDocument;globalThis.Tesseract=previousTesseract;}
});
