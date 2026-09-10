import { renderPageToCanvas, releaseCanvas } from './pdf-parser.js';
import { CONFIG } from './config.js';

export function columnLabel(index) {
  let label = '';
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
  return label;
}

/** A paged spreadsheet view. All edits update the same grid used by export. */
export function createEditor({ getData, getPdf, onEdit, onDownload }) {
  const $ = id => document.getElementById(id);
  const dialog = $('editorDialog');
  let selected = [0, 0], offset = 0, history = [], redo = [], sourceUrl = null;
  let editingSnapshot = null;
  let sourceRequest = 0, renderedPage = 0;
  async function showPage(page) {
    const pdf = getPdf();
    if (!pdf || $('sourcePane').classList.contains('hidden')) return;
    page = Math.max(1, Math.min(pdf.numPages, page || 1));
    if (renderedPage === page) return;
    renderedPage = page;
    const request = ++sourceRequest;
    $('sourcePage').value = page;
    $('sourcePage').max = pdf.numPages;
    $('sourceStatus').textContent = `Rendering page ${page}…`;
    const canvas = document.createElement('canvas');
    try {
      await renderPageToCanvas(pdf, page, canvas, CONFIG.SOURCE_PREVIEW_SCALE);
      if (request !== sourceRequest) { releaseCanvas(canvas); return; }
      for (const old of $('sourcePdf').querySelectorAll('canvas')) releaseCanvas(old);
      $('sourcePdf').replaceChildren(canvas);
      $('sourceStatus').textContent = `Page ${page} of ${pdf.numPages}`;
    } catch {
      releaseCanvas(canvas); renderedPage = 0;
      if (request === sourceRequest) $('sourceStatus').textContent = 'Preview could not load. Use Open original PDF above.';
    }
  }
  $('sourcePage').onchange = e => showPage(Number(e.target.value));
  const snapshot = () => structuredClone(getData());
  function remember(before = snapshot()) {
    history.push(before);
    if (history.length > CONFIG.EDITOR_UNDO_LIMIT) history.shift();
    redo = [];
    updateButtons();
  }
  function updateButtons() {
    $('undoEdit').disabled = !history.length;
    $('redoEdit').disabled = !redo.length;
  }
  function change(action) {
    remember(); action(getData()); onEdit(); render();
  }
  function restore(from, to) {
    if (!from.length) return;
    to.push(snapshot());
    Object.assign(getData(), from.pop());
    onEdit(); render();
  }
  function focusCell(r, c) {
    const data = getData();
    selected = [Math.max(0, Math.min(data.rows.length - 1, r)), Math.max(0, Math.min(data.rows[0].length - 1, c))];
    offset = Math.floor(selected[0] / CONFIG.EDITOR_PAGE_SIZE) * CONFIG.EDITOR_PAGE_SIZE;
    render();
    $('editorGrid').querySelector(`[data-r="${selected[0]}"][data-c="${selected[1]}"]`)?.focus();
  }
  function select(r, c) {
    selected = [r, c];
    $('toggleHeading').textContent = getData().headerRows.includes(r) ? 'Unmark heading' : 'Mark as heading';
    $('cellAddress').textContent = `${columnLabel(c)}${r + 1}`;
    $('cellValue').value = getData().rows[r][c] ?? '';
    const page = getData().rowOrigins?.[r]?.page;
    $('cellSource').textContent = page ? `PDF page ${page}` : 'Added row';
    if (page) showPage(page);
    for (const cell of $('editorGrid').querySelectorAll('.selected')) cell.classList.remove('selected');
    $('editorGrid').querySelector(`[data-r="${r}"][data-c="${c}"]`)?.classList.add('selected');
  }
  function render() {
    const data = getData(), width = data.rows[0]?.length || 1;
    offset = Math.max(0, Math.min(offset, Math.floor((data.rows.length - 1) / CONFIG.EDITOR_PAGE_SIZE) * CONFIG.EDITOR_PAGE_SIZE));
    selected[0] = Math.max(0, Math.min(selected[0], data.rows.length - 1));
    selected[1] = Math.max(0, Math.min(selected[1], width - 1));
    const grid = $('editorGrid'); grid.replaceChildren();
    const head = grid.createTHead().insertRow();
    for (const label of ['#', ...Array.from({ length: width }, (_, c) => columnLabel(c))]) {
      const th = document.createElement('th'); th.textContent = label; head.append(th);
    }
    const body = grid.createTBody();
    const end = Math.min(data.rows.length, offset + CONFIG.EDITOR_PAGE_SIZE);
    const issues = new Map();
    for (const issue of data.issues || []) {
      if (!issues.has(issue.row)) issues.set(issue.row, new Set());
      issues.get(issue.row).add(issue.message);
    }
    for (let r = offset; r < end; r++) {
      const tr = body.insertRow();
      if (data.headerRows?.includes(r)) tr.classList.add('heading-row');
      const num = document.createElement('th'); num.textContent = r + 1;
      num.title = `PDF page ${data.rowOrigins?.[r]?.page || '—'}`;
      tr.append(num);
      for (let c = 0; c < width; c++) {
        const td = tr.insertCell();
        const input = document.createElement('textarea');
        input.rows = 2; input.value = data.rows[r][c] ?? '';
        input.dataset.r = r; input.dataset.c = c;
        input.setAttribute('aria-label', `${columnLabel(c)}${r + 1}`);
        input.spellcheck = false;
        if (issues.has(r)) { td.classList.add('needs-review'); td.title = [...issues.get(r)].join('\n'); }
        input.addEventListener('focus', () => { editingSnapshot = snapshot(); select(r, c); });
        input.addEventListener('input', () => {
          if (editingSnapshot) { remember(editingSnapshot); editingSnapshot = null; }
          data.rows[r][c] = input.value; $('cellValue').value = input.value; onEdit();
        });
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); focusCell(r + 1, c); }
          if (e.key === 'Tab') {
            const next = r * width + c + (e.shiftKey ? -1 : 1);
            if (next >= 0 && next < data.rows.length * width) { e.preventDefault(); focusCell(Math.floor(next / width), next % width); }
          }
        });
        input.addEventListener('paste', e => {
          const text = e.clipboardData.getData('text/plain');
          if (!text.includes('\t')) return;
          e.preventDefault();
          const values = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(line => line.split('\t'));
          change(d => {
            const newWidth = Math.max(width, c + Math.max(...values.map(v => v.length)));
            while (d.rows.length < r + values.length) { d.rows.push(Array(newWidth).fill('')); d.rowOrigins.push(null); }
            for (const row of d.rows) while (row.length < newWidth) row.push('');
            values.forEach((row, dr) => row.forEach((v, dc) => { d.rows[r + dr][c + dc] = v; }));
          });
        });
        td.append(input);
      }
    }
    $('editorRange').textContent = `Rows ${offset + 1}–${end} of ${data.rows.length} · ${width} columns`;
    $('previousRows').disabled = offset === 0;
    $('nextRows').disabled = end === data.rows.length;
    $('toggleHeading').textContent = data.headerRows.includes(selected[0]) ? 'Unmark heading' : 'Mark as heading';
    updateButtons(); select(...selected);
  }
  $('cellValue').addEventListener('focus', () => { editingSnapshot = snapshot(); });
  $('cellValue').addEventListener('input', () => {
    if (editingSnapshot) { remember(editingSnapshot); editingSnapshot = null; }
    const [r, c] = selected; getData().rows[r][c] = $('cellValue').value;
    const cell = $('editorGrid').querySelector(`[data-r="${r}"][data-c="${c}"]`);
    if (cell) cell.value = $('cellValue').value;
    onEdit();
  });
  $('undoEdit').onclick = () => restore(history, redo);
  $('redoEdit').onclick = () => restore(redo, history);
  $('insertRow').onclick = () => change(d => {
    const at = selected[0] + 1;
    d.rows.splice(at, 0, Array(d.rows[0].length).fill('')); d.rowOrigins.splice(at, 0, null);
    d.headerRows = d.headerRows.map(r => r >= at ? r + 1 : r);
    d.issues = d.issues.map(i => ({ ...i, row: i.row >= at ? i.row + 1 : i.row }));
  });
  $('deleteRow').onclick = () => {
    if (getData().rows.length <= 1) return;
    change(d => {
      const at = selected[0]; d.rows.splice(at, 1); d.rowOrigins.splice(at, 1);
      d.headerRows = d.headerRows.filter(r => r !== at).map(r => r > at ? r - 1 : r);
      d.issues = d.issues.filter(i => i.row !== at).map(i => ({ ...i, row: i.row > at ? i.row - 1 : i.row }));
    });
  };
  $('insertColumn').onclick = () => change(d => { for (const row of d.rows) row.splice(selected[1] + 1, 0, ''); });
  $('deleteColumn').onclick = () => {
    if (getData().rows[0].length <= 1) return;
    change(d => { for (const row of d.rows) row.splice(selected[1], 1); });
  };
  $('toggleHeading').onclick = () => change(d => {
    d.headerRows = d.headerRows.includes(selected[0]) ? d.headerRows.filter(r => r !== selected[0]) : [...d.headerRows, selected[0]];
  });
  $('previousRows').onclick = () => { offset -= CONFIG.EDITOR_PAGE_SIZE; selected[0] = offset; render(); };
  $('nextRows').onclick = () => { offset += CONFIG.EDITOR_PAGE_SIZE; selected[0] = offset; render(); };
  $('goToRow').onchange = e => focusCell((Number(e.target.value) || 1) - 1, selected[1]);
  $('nextIssue').onclick = () => {
    const rows = [...new Set(getData().issues.map(i => i.row))].sort((a, b) => a - b);
    if (rows.length) focusCell(rows.find(r => r > selected[0]) ?? rows[0], 0);
  };
  $('showSource').onclick = () => {
    $('sourcePane').classList.toggle('hidden');
    const visible = !$('sourcePane').classList.contains('hidden');
    $('showSource').setAttribute('aria-expanded', String(visible));
    if (visible) showPage(getData().rowOrigins?.[selected[0]]?.page || 1);
  };
  $('editorDownload').onclick = onDownload;
  $('closeEditor').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { document.body.classList.remove('editing'); onEdit(); });
  return {
    open(file) {
      if (!getData()?.rows.length) return;
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      sourceUrl = URL.createObjectURL(file);
      renderedPage = 0;
      $('sourceLink').href = sourceUrl;
      $('editorFilename').textContent = file.name;
      render(); dialog.showModal(); document.body.classList.add('editing');
    },
    reset() {
      history = []; redo = []; offset = 0; selected = [0, 0];
      if (dialog.open) dialog.close();
      sourceRequest++; renderedPage = 0;
      for (const canvas of $('sourcePdf').querySelectorAll('canvas')) releaseCanvas(canvas);
      $('sourcePdf').replaceChildren();
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      sourceUrl = null;
    },
  };
}
