/** Checks reconstruction against the extracted source, not OCR correctness. */
export function auditExtraction(items, combined, pageCount) {
  const counts = values => {
    const map = new Map();
    for (const text of values) for (const token of String(text).split(/\s+/).filter(Boolean)) {
      map.set(token, (map.get(token) || 0) + 1);
    }
    return map;
  };
  const expected = counts(items.map(i => i.text));
  const actual = counts(combined.rows.flat());
  const missing = [], extra = [];
  for (const [token, n] of expected) if (n > (actual.get(token) || 0)) missing.push({ token, count: n - (actual.get(token) || 0) });
  for (const [token, n] of actual) if (n > (expected.get(token) || 0)) extra.push({ token, count: n - (expected.get(token) || 0) });
  const emptyPages = [];
  const pages = new Set(items.map(i => i.page));
  for (let p = 1; p <= pageCount; p++) if (!pages.has(p)) emptyPages.push(p);
  return { passed: !missing.length && !extra.length, missing, extra, emptyPages,
    itemCount: items.length, pageCount, ocr: items.some(i => i.source === 'ocr') };
}
