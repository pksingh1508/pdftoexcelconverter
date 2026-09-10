/** Spatial reconciliation of PDF text and two OCR passes. No spelling guesses. */
import { CONFIG } from './config.js';
import { groupIntoRows } from './table-detector.js';
const ordered = items => groupIntoRows(items).flatMap(row => row.items);
const reading = items => ordered(items).map(i => i.text).join(' ');
const comparable = text => text.normalize('NFC').replace(/\s+/g, '');

function overlaps(a, b) {
  if (a.page !== b.page) return false;
  if (Math.abs(a.y + a.height / 2 - b.y - b.height / 2) > Math.min(a.height, b.height) * CONFIG.VERIFY_CENTER_TOLERANCE) return false;
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return x > 0 && y > 0 &&
    x * y / Math.max(1, Math.min(a.width * a.height, b.width * b.height)) >= CONFIG.VERIFY_OVERLAP;
}

/** Connected regions allow a PDF phrase to match several OCR words without duplicates. */
export function reconcileReadings(pdfItems, firstPass, secondPass) {
  const entries = [pdfItems, firstPass, secondPass].flatMap((items, pass) => items.map(item => ({ item, pass })));
  const parent = entries.map((_, i) => i);
  const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const indexes = entries.map((_, i) => i).sort((a, b) => entries[a].item.y - entries[b].item.y);
  for (let ai = 0; ai < indexes.length; ai++) {
    const a = indexes[ai], A = entries[a];
    for (let bi = ai + 1; bi < indexes.length; bi++) {
      const b = indexes[bi], B = entries[b];
      if (B.item.y >= A.item.y + A.item.height) break;
      if (A.pass !== B.pass && overlaps(A.item, B.item)) parent[root(b)] = root(a);
    }
  }
  const groups = new Map();
  entries.forEach((entry, i) => {
    const key = root(i);
    if (!groups.has(key)) groups.set(key, [[], [], []]);
    groups.get(key)[entry.pass].push(entry.item);
  });
  const items = [], regions = [];
  for (const passes of groups.values()) {
    const texts = passes.map(reading);
    const exact = texts.map(comparable);
    const confidence = passes.map(p => p.length ? Math.min(...p.map(i => i.confidence ?? 0)) : 0);
    const consensus = !!exact[1] && exact[1] === exact[2] &&
      Math.min(confidence[1], confidence[2]) >= CONFIG.VERIFY_MIN_CONFIDENCE;
    const agreesWithPdf = !!exact[0] && (exact[0] === exact[1] || exact[0] === exact[2]);
    let selected = 0, status;
    if (consensus && (!exact[0] || exact[0] !== exact[1])) {
      selected = confidence[1] >= confidence[2] ? 1 : 2;
      status = exact[0] ? 'corrected' : 'recovered';
    } else if (exact[0]) {
      status = agreesWithPdf ? 'agreement' : 'unresolved';
    } else {
      selected = passes[1].length ? 1 : 2;
      status = consensus ? 'agreement' : 'unresolved';
      if (!consensus && pdfItems.length) selected = null;
    }
    const all = passes.flat();
    const region = { id: `p${all[0].page}-r${regions.length + 1}`, page: all[0].page,
      x: Math.min(...all.map(i => i.x)), y: Math.min(...all.map(i => i.y)),
      status, texts, confidence, selected, itemCounts: passes.map(p => p.length) };
    regions.push(region);
    for (const item of (passes[selected] || [])) items.push({ ...item, verification: status, regionId: region.id });
  }
  return { items: ordered(items), regions,
    counts: Object.fromEntries(['agreement', 'recovered', 'corrected', 'unresolved'].map(s => [s, regions.filter(r => r.status === s).length])),
    inputCounts: [pdfItems.length, firstPass.length, secondPass.length],
  };
}
