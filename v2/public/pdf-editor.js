// pdf-editor.js — PDF Studio: full tool system + AI panel

const PDFJS_SRC    = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
const PDFLIB_SRC   = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
const PDF_SCALE    = 1.5;

// ── State ─────────────────────────────────────────────────────────────────────
let _pdfjsLib    = null,  _PDFLib = null;
let _pdfFile     = null,  _pdfJsDoc = null;
let _activeTool  = 'select';
let _annotColor  = '#facc15';
let _activeSel   = null;   // { pageEl, pageIdx, x, y, w, h, spans, text }
let _lastAiText  = '';
// Drag state
let _dragging    = false,  _dragPage = null;
let _dragStartX  = 0,      _dragStartY = 0;
let _selDiv      = null,   _currentShape = null;
// Ink state
let _inkDrawing  = false,  _inkCtx = null;

const DRAWING_TOOLS = new Set(['select','highlight','line','rect','callout','ai-rewrite','ai-annotate']);
const COLOR_TOOLS   = new Set(['highlight','ink','line','rect','callout']);

const TOOL_HINTS = {
  select:      ['↖', 'Drag over text to select it for AI tools'],
  hand:        ['✋', 'Click and drag to pan the document'],
  highlight:   ['▋', 'Drag over text to highlight it'],
  ink:         ['✏', 'Click and drag to draw freely on the page'],
  note:        ['📌', 'Click anywhere on the page to place a sticky note'],
  textbox:     ['T',  'Click anywhere to insert a text box'],
  edittext:    ['✎', 'Click on any existing text to edit it directly'],
  line:        ['╱', 'Drag to draw a straight line'],
  rect:        ['▭', 'Drag to draw a rectangle'],
  callout:     ['💬', 'Drag to draw a callout bubble'],
  rotate:      ['↻', 'Click a page to rotate it 90°'],
  deletepage:  ['⊘', 'Click a page to delete it permanently'],
  'ai-rewrite':  ['✨', 'Drag to select text — AI will instantly rewrite it'],
  'ai-annotate': ['🤖', 'Drag to select text — AI will generate an annotation'],
};

console.log('[PDFStudio] loaded');

// ── Libraries ─────────────────────────────────────────────────────────────────
function pdfLoadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Failed: ' + src));
    document.head.appendChild(s);
  });
}
async function pdfEnsureLibs() {
  if (!_pdfjsLib) {
    await pdfLoadScript(PDFJS_SRC);
    _pdfjsLib = window.pdfjsLib;
    if (!_pdfjsLib) throw new Error('pdfjsLib not found after load');
    _pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
  if (!_PDFLib) {
    await pdfLoadScript(PDFLIB_SRC);
    _PDFLib = window.PDFLib;
    if (!_PDFLib) throw new Error('PDFLib not found after load');
  }
}

function pdfGet(id)       { return document.getElementById(id); }
function pdfSetStatus(m)  { const e = pdfGet('pdf-status'); if (e) e.textContent = m; }

// ── Tool system ───────────────────────────────────────────────────────────────
function pdfSetTool(toolId) {
  _activeTool = toolId;

  // Update toolbar button states
  document.querySelectorAll('.peb-btn[data-tool]').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === toolId)
  );

  // Cursor on overlays
  const cursors = {
    select:'default', hand:'grab', highlight:'crosshair', ink:'crosshair',
    note:'cell', textbox:'text', edittext:'pointer',
    line:'crosshair', rect:'crosshair', callout:'crosshair',
    rotate:'pointer', deletepage:'pointer',
    'ai-rewrite':'crosshair', 'ai-annotate':'crosshair',
  };
  const cur = cursors[toolId] || 'default';
  document.querySelectorAll('.pe-overlay').forEach(o => {
    o.style.cursor       = cur;
    // Only drawing tools need the overlay to capture events
    o.style.pointerEvents = DRAWING_TOOLS.has(toolId) ? 'auto' : 'none';
  });

  // Ink canvas pointer events
  document.querySelectorAll('.pe-ink-canvas').forEach(c => {
    c.style.pointerEvents = toolId === 'ink' ? 'auto' : 'none';
    c.style.cursor        = toolId === 'ink' ? 'crosshair' : 'default';
  });

  // Color picker visibility
  const colPicker = pdfGet('peb-colors');
  if (colPicker) colPicker.style.display = COLOR_TOOLS.has(toolId) ? 'flex' : 'none';

  // Update right panel hint
  const [icon, text] = TOOL_HINTS[toolId] || ['?', ''];
  const hi = pdfGet('ppp-hint-icon'), ht = pdfGet('ppp-hint-text');
  if (hi) hi.textContent = icon;
  if (ht) ht.innerHTML   = text;
}

// ── PDF open / render ─────────────────────────────────────────────────────────
async function pdfOpen(file) {
  _pdfFile = file;
  pdfSetStatus('Loading…');
  pdfGet('pdf-drop-zone').style.display = 'none';
  pdfGet('pdf-pages').innerHTML         = '';
  pdfGet('pdf-save-btn').style.display  = 'none';
  pdfClearSelection();

  try { await pdfEnsureLibs(); }
  catch (e) { pdfSetStatus('⚠ ' + e.message); console.error(e); return; }

  try {
    const ab  = await file.arrayBuffer();
    _pdfJsDoc = await _pdfjsLib.getDocument({ data: new Uint8Array(ab) }).promise;
    const n   = _pdfJsDoc.numPages;
    pdfSetStatus(`${file.name}  ·  ${n} page${n > 1 ? 's' : ''}`);
    pdfGet('pdf-save-btn').style.display = '';
    for (let i = 1; i <= n; i++) await pdfRenderPage(i);
    console.log('[PDFStudio] rendered', n, 'pages');
  } catch (e) { pdfSetStatus('⚠ ' + e.message); console.error(e); }
}

async function pdfRenderPage(pageNum) {
  const page     = await _pdfJsDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: PDF_SCALE });
  const W = viewport.width, H = viewport.height;

  // Wrapper
  const pageEl = document.createElement('div');
  pageEl.className       = 'pe-page';
  pageEl.dataset.pageNum = pageNum;
  pageEl.style.width     = W + 'px';
  pageEl.style.height    = H + 'px';

  // Canvas (rendered PDF — bottom, z 0)
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  pageEl.appendChild(canvas);

  // Text layer (invisible spans for hit-testing, z 1)
  const textLayer = document.createElement('div');
  textLayer.className = 'pe-text-layer';
  textLayer.style.cssText = `position:absolute;top:0;left:0;width:${W}px;height:${H}px;pointer-events:none;overflow:hidden;z-index:1;`;
  const tc = await page.getTextContent();
  tc.items.forEach(item => {
    if (!item.str.trim()) return;
    const tx    = _pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontH = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
    if (fontH < 1) return;
    const span = document.createElement('span');
    span.className   = 'pe-text-item';
    span.textContent = item.str;
    span.style.cssText = `position:absolute;left:${tx[4]}px;top:${tx[5] - fontH}px;font-size:${fontH}px;color:transparent;white-space:pre;line-height:1;`;
    span.dataset.pdfX     = item.transform[4];
    span.dataset.pdfY     = item.transform[5];
    span.dataset.pdfFs    = Math.abs(item.transform[0]);
    span.dataset.pdfWidth = item.width || 0;
    span.dataset.original = item.str;
    textLayer.appendChild(span);
  });
  pageEl.appendChild(textLayer);

  // SVG layer for shapes (z 2)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.className   = 'pe-shapes-svg';
  svg.style.cssText = `position:absolute;top:0;left:0;width:${W}px;height:${H}px;overflow:visible;pointer-events:none;z-index:2;`;
  pageEl.appendChild(svg);

  // Ink canvas (z 3, pointer-events toggled by tool)
  const inkCanvas = document.createElement('canvas');
  inkCanvas.className = 'pe-ink-canvas';
  inkCanvas.width = W; inkCanvas.height = H;
  inkCanvas.style.cssText = `position:absolute;top:0;left:0;pointer-events:none;z-index:3;`;
  pdfAttachInk(inkCanvas);
  pageEl.appendChild(inkCanvas);

  // Overlay for drawing tools (z 5, pointer-events set by pdfSetTool)
  const overlay = document.createElement('div');
  overlay.className = 'pe-overlay';
  overlay.style.cssText = `position:absolute;top:0;left:0;width:100%;height:100%;z-index:5;`;
  overlay.style.pointerEvents = DRAWING_TOOLS.has(_activeTool) ? 'auto' : 'none';
  overlay.style.cursor = ({
    select:'default', highlight:'crosshair', line:'crosshair',
    rect:'crosshair', callout:'crosshair', 'ai-rewrite':'crosshair', 'ai-annotate':'crosshair',
  })[_activeTool] || 'default';
  pdfAttachOverlay(overlay, pageEl, pageNum - 1, canvas, svg);
  pageEl.appendChild(overlay);

  // Page-level click for placement tools (note, textbox, edittext, rotate, delete)
  pdfAttachPageClick(pageEl, pageNum - 1);

  pdfGet('pdf-pages').appendChild(pageEl);
}

// ── Overlay: drag-based tools ─────────────────────────────────────────────────
function pdfAttachOverlay(overlay, pageEl, pageIdx, canvas, svg) {
  overlay.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    _dragging   = true;
    _dragPage   = pageEl;
    const r     = overlay.getBoundingClientRect();
    _dragStartX = e.clientX - r.left;
    _dragStartY = e.clientY - r.top;

    if (_activeTool === 'ink') {
      // Ink handled by ink canvas listener
    } else if (DRAWING_TOOLS.has(_activeTool)) {
      if (_selDiv) _selDiv.remove();
      _selDiv = document.createElement('div');
      _selDiv.className = 'pe-sel-rect';
      _selDiv.style.cssText = `position:absolute;left:${_dragStartX}px;top:${_dragStartY}px;width:0;height:0;z-index:6;pointer-events:none;`;
      if (_activeTool === 'line' || _activeTool === 'rect' || _activeTool === 'callout') {
        _currentShape = pdfBeginShape(_activeTool, svg, _dragStartX, _dragStartY);
      }
      pageEl.appendChild(_selDiv);
    }
  });

  overlay.addEventListener('mousemove', e => {
    if (!_dragging || _dragPage !== pageEl) return;
    const r  = overlay.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const x  = Math.min(_dragStartX, cx), y = Math.min(_dragStartY, cy);
    const w  = Math.abs(cx - _dragStartX), h = Math.abs(cy - _dragStartY);
    if (_selDiv) {
      _selDiv.style.left = x + 'px'; _selDiv.style.top = y + 'px';
      _selDiv.style.width = w + 'px'; _selDiv.style.height = h + 'px';
    }
    if (_currentShape) pdfUpdateShape(_activeTool, _currentShape, _dragStartX, _dragStartY, cx, cy);
  });

  overlay.addEventListener('mouseup', e => {
    if (!_dragging || _dragPage !== pageEl) return;
    _dragging = false;
    const r  = overlay.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const x  = Math.min(_dragStartX, cx), y = Math.min(_dragStartY, cy);
    const w  = Math.abs(cx - _dragStartX), h = Math.abs(cy - _dragStartY);

    if (_selDiv) { _selDiv.remove(); _selDiv = null; }
    _currentShape = null;

    if (w < 5 && h < 5) return; // ignore tiny drags

    switch (_activeTool) {
      case 'select':
        pdfOnSelectionDone(pageEl, pageIdx, canvas, x, y, w, h);
        break;
      case 'highlight':
        pdfHighlight(pageEl, x, y, w, h);
        break;
      case 'ai-rewrite':
        pdfOnSelectionDone(pageEl, pageIdx, canvas, x, y, w, h);
        setTimeout(() => pdfRunAI('Improve the writing quality and clarity while keeping the same meaning. Return only the improved text.'), 80);
        break;
      case 'ai-annotate':
        pdfOnSelectionDone(pageEl, pageIdx, canvas, x, y, w, h);
        setTimeout(() => pdfRunAI('Generate a brief, insightful annotation for this text. Be analytical and concise.'), 80);
        break;
      // line/rect/callout: shape already finalized by SVG update
    }
  });
}

document.addEventListener('mouseup', () => { _dragging = false; });

// ── Page click: placement tools ───────────────────────────────────────────────
function pdfAttachPageClick(pageEl, pageIdx) {
  pageEl.addEventListener('click', e => {
    const placement = ['note','textbox','edittext','rotate','deletepage'];
    if (!placement.includes(_activeTool)) return;
    if (e.target.closest('.pe-note, .pe-textbox, .pe-note-close, .pe-tb-close')) return;
    const r = pageEl.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    switch (_activeTool) {
      case 'note':       pdfPlaceNote(pageEl, pageIdx, x, y);    break;
      case 'textbox':    pdfPlaceTextbox(pageEl, pageIdx, x, y); break;
      case 'edittext':   pdfClickEdit(pageEl, x, y);              break;
      case 'rotate':     pdfRotatePage(pageEl, pageIdx);          break;
      case 'deletepage': pdfDeletePage(pageEl, pageIdx);          break;
    }
  });
}

// ── Ink drawing ───────────────────────────────────────────────────────────────
function pdfAttachInk(inkCanvas) {
  let drawing = false;
  const ctx   = inkCanvas.getContext('2d');

  inkCanvas.addEventListener('mousedown', e => {
    if (_activeTool !== 'ink') return;
    e.preventDefault();
    drawing = true;
    const r = inkCanvas.getBoundingClientRect();
    ctx.beginPath();
    ctx.moveTo(e.clientX - r.left, e.clientY - r.top);
    ctx.strokeStyle = _annotColor;
    ctx.lineWidth   = 2.5;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.globalAlpha = 0.85;
  });

  inkCanvas.addEventListener('mousemove', e => {
    if (!drawing) return;
    const r = inkCanvas.getBoundingClientRect();
    ctx.lineTo(e.clientX - r.left, e.clientY - r.top);
    ctx.stroke();
  });

  inkCanvas.addEventListener('mouseup', () => { drawing = false; });
}

// ── Highlight ─────────────────────────────────────────────────────────────────
function pdfHighlight(pageEl, x, y, w, h) {
  const textLayer = pageEl.querySelector('.pe-text-layer');
  let highlighted = 0;
  textLayer.querySelectorAll('.pe-text-item').forEach(span => {
    const sl = parseFloat(span.style.left);
    const st = parseFloat(span.style.top);
    const fs = parseFloat(span.style.fontSize) || 12;
    const sw = parseFloat(span.dataset.pdfWidth) * PDF_SCALE || fs * span.textContent.length * 0.55;
    if ((sl + sw) > x && sl < x + w && (st + fs) > y && st < y + h) {
      span.classList.add('pe-highlighted');
      span.style.setProperty('--hl-color', _annotColor + '66');
      highlighted++;
    }
  });
  pdfSetStatus(highlighted > 0 ? `Highlighted ${highlighted} text run${highlighted > 1 ? 's' : ''}` : 'No text in that region');
}

// ── SVG Shapes ────────────────────────────────────────────────────────────────
function pdfBeginShape(tool, svg, x, y) {
  const ns = 'http://www.w3.org/2000/svg';
  let el;
  if (tool === 'line') {
    el = document.createElementNS(ns, 'line');
    el.setAttribute('x1', x); el.setAttribute('y1', y);
    el.setAttribute('x2', x); el.setAttribute('y2', y);
    el.setAttribute('stroke', _annotColor);
    el.setAttribute('stroke-width', '2.5');
    el.setAttribute('stroke-linecap', 'round');
  } else if (tool === 'rect') {
    el = document.createElementNS(ns, 'rect');
    el.setAttribute('x', x); el.setAttribute('y', y);
    el.setAttribute('width', 0); el.setAttribute('height', 0);
    el.setAttribute('stroke', _annotColor); el.setAttribute('stroke-width', '2');
    el.setAttribute('fill', _annotColor + '18'); el.setAttribute('rx', '3');
  } else if (tool === 'callout') {
    el = document.createElementNS(ns, 'rect');
    el.setAttribute('x', x); el.setAttribute('y', y);
    el.setAttribute('width', 0); el.setAttribute('height', 0);
    el.setAttribute('stroke', _annotColor); el.setAttribute('stroke-width', '2');
    el.setAttribute('stroke-dasharray', '5 3');
    el.setAttribute('fill', _annotColor + '12'); el.setAttribute('rx', '8');
  }
  svg.appendChild(el);
  return el;
}

function pdfUpdateShape(tool, el, sx, sy, cx, cy) {
  if (tool === 'line') {
    el.setAttribute('x2', cx); el.setAttribute('y2', cy);
  } else {
    const x = Math.min(sx, cx), y = Math.min(sy, cy);
    el.setAttribute('x', x); el.setAttribute('y', y);
    el.setAttribute('width',  Math.abs(cx - sx));
    el.setAttribute('height', Math.abs(cy - sy));
  }
}

// ── Sticky Note ───────────────────────────────────────────────────────────────
function pdfPlaceNote(pageEl, pageIdx, x, y) {
  const note = document.createElement('div');
  note.className = 'pe-note';
  note.style.cssText = `position:absolute;left:${x}px;top:${y}px;z-index:15;`;
  note.innerHTML = `
    <div class="pe-note-handle" title="Drag to move">
      <span class="pe-note-title">📌 Note</span>
      <button class="pe-note-close" title="Delete note">✕</button>
    </div>
    <textarea class="pe-note-body" placeholder="Type note…" rows="3"></textarea>`;
  note.querySelector('.pe-note-close').addEventListener('click', () => note.remove());
  pdfMakeDraggable(note, note.querySelector('.pe-note-handle'));
  pageEl.appendChild(note);
  setTimeout(() => note.querySelector('textarea').focus(), 30);
}

// ── Text Box ──────────────────────────────────────────────────────────────────
function pdfPlaceTextbox(pageEl, pageIdx, x, y) {
  const tb = document.createElement('div');
  tb.className = 'pe-textbox';
  tb.style.cssText = `position:absolute;left:${x}px;top:${y}px;z-index:15;`;
  tb.innerHTML = `
    <div class="pe-tb-handle" title="Drag to move">
      <button class="pe-tb-close" title="Delete">✕</button>
    </div>
    <div class="pe-tb-content" contenteditable="true" spellcheck="true">Type here…</div>`;
  tb.querySelector('.pe-tb-close').addEventListener('click', () => tb.remove());
  pdfMakeDraggable(tb, tb.querySelector('.pe-tb-handle'));
  pageEl.appendChild(tb);
  const content = tb.querySelector('.pe-tb-content');
  setTimeout(() => { content.focus(); document.execCommand('selectAll'); }, 30);
}

// ── Edit existing text ────────────────────────────────────────────────────────
function pdfClickEdit(pageEl, cx, cy) {
  const textLayer = pageEl.querySelector('.pe-text-layer');
  const spans     = Array.from(textLayer.querySelectorAll('.pe-text-item'));
  let best = null, bestDist = Infinity;
  spans.forEach(span => {
    const sl = parseFloat(span.style.left);
    const st = parseFloat(span.style.top);
    const d  = Math.hypot(sl - cx, st - cy);
    if (d < bestDist) { bestDist = d; best = span; }
  });
  if (best && bestDist < 40) {
    best.contentEditable = 'true';
    best.style.color     = '#111';
    best.style.background = 'rgba(255,255,255,0.97)';
    best.style.outline   = '2px solid #3b82f6';
    best.style.padding   = '0 2px';
    best.style.borderRadius = '2px';
    best.focus();
    best.addEventListener('input', () => {
      best.dataset.changed = best.textContent !== best.dataset.original ? 'true' : '';
      if (best.dataset.changed) {
        best.dataset.newText  = best.textContent;
        best.style.background = 'rgba(255,220,50,0.35)';
        best.style.outline    = '2px solid #facc15';
      }
    });
    best.addEventListener('blur', () => {
      if (!best.dataset.changed) { best.style.color = 'transparent'; best.style.background = ''; best.style.outline = ''; }
    }, { once: true });
  }
}

// ── Page management ───────────────────────────────────────────────────────────
function pdfRotatePage(pageEl, pageIdx) {
  const cur = parseInt(pageEl.dataset.rotation || '0');
  const next = (cur + 90) % 360;
  pageEl.dataset.rotation = next;
  // Swap width/height for 90/270
  if (next === 90 || next === 270) {
    const W = pageEl.style.width, H = pageEl.style.height;
    pageEl.style.width  = H; pageEl.style.height = W;
  }
  const inner = pageEl.querySelector('canvas');
  const W = parseFloat(pageEl.style.width);
  const H = parseFloat(pageEl.style.height);
  // CSS transform rotation with offset so it stays in place
  pageEl.style.transform = `rotate(${next}deg)`;
  pdfSetStatus(`Page ${pageIdx + 1} rotated ${next}°`);
}

function pdfDeletePage(pageEl, pageIdx) {
  const pageNum = parseInt(pageEl.dataset.pageNum);
  if (!confirm(`Delete page ${pageNum}? This cannot be undone until you save.`)) return;
  pageEl.style.transition = 'opacity 0.2s, transform 0.2s';
  pageEl.style.opacity    = '0';
  pageEl.style.transform  = 'scale(0.95)';
  setTimeout(() => { pageEl.remove(); pdfSetStatus(`Page ${pageNum} deleted`); }, 220);
}

// ── Drag-to-move for notes/textboxes ─────────────────────────────────────────
function pdfMakeDraggable(el, handle) {
  handle.addEventListener('mousedown', e => {
    if (e.target.closest('button')) return;
    e.stopPropagation(); e.preventDefault();
    const startL = parseFloat(el.style.left) || 0;
    const startT = parseFloat(el.style.top)  || 0;
    const ox = e.clientX - startL, oy = e.clientY - startT;
    function onMove(e) {
      el.style.left = (e.clientX - ox) + 'px';
      el.style.top  = (e.clientY - oy) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

// ── Selection (select / ai tools) ────────────────────────────────────────────
function pdfOnSelectionDone(pageEl, pageIdx, canvas, x, y, w, h) {
  const textLayer = pageEl.querySelector('.pe-text-layer');
  const spans = Array.from(textLayer.querySelectorAll('.pe-text-item')).filter(span => {
    const sl = parseFloat(span.style.left);
    const st = parseFloat(span.style.top);
    const fs = parseFloat(span.style.fontSize) || 12;
    const sw = parseFloat(span.dataset.pdfWidth) * PDF_SCALE || fs * span.textContent.length * 0.55;
    return (sl + sw) > x && sl < x + w && (st + fs) > y && st < y + h;
  });
  const text = spans.map(s => s.textContent).join(' ').trim();
  _activeSel  = { pageEl, pageIdx, canvas, x, y, w, h, spans, text };

  // Flash selection rect on page
  const highlight = document.createElement('div');
  highlight.className = 'pe-sel-flash';
  highlight.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:4;pointer-events:none;`;
  pageEl.appendChild(highlight);
  setTimeout(() => highlight.remove(), 900);

  // Update right panel
  const selSection = pdfGet('ppp-selection');
  const emptyEl    = pdfGet('ppp-empty');
  const textEl     = pdfGet('ppp-sel-text');
  if (selSection) selSection.style.display = '';
  if (emptyEl)    emptyEl.style.display    = 'none';
  if (textEl) {
    textEl.textContent = text
      ? `"${text.slice(0, 200)}${text.length > 200 ? '…' : ''}"`
      : '(no text — image/drawing region)';
  }

  // Close any previous result
  const resEl = pdfGet('ppp-result');
  if (resEl) resEl.style.display = 'none';
  _lastAiText = '';

  console.log(`[PDFStudio] Selection: ${spans.length} spans — "${text.slice(0, 60)}"`);
}

function pdfClearSelection() {
  _activeSel = null; _lastAiText = '';
  document.querySelectorAll('.pe-sel-flash').forEach(e => e.remove());
  const selSection = pdfGet('ppp-selection');
  const emptyEl    = pdfGet('ppp-empty');
  const resEl      = pdfGet('ppp-result');
  if (selSection) selSection.style.display = 'none';
  if (emptyEl)    emptyEl.style.display    = '';
  if (resEl)      resEl.style.display      = 'none';
  pdfGet('ppp-apply-btn') && (pdfGet('ppp-apply-btn').style.display = 'none');
}

// ── AI panel ──────────────────────────────────────────────────────────────────
function pdfGetContext() {
  if (_activeSel?.text) return { text: _activeSel.text, source: 'selection' };
  const all = Array.from(document.querySelectorAll('.pe-text-item'))
    .map(s => s.textContent).join(' ').trim();
  return { text: all.slice(0, 5000), source: 'document' };
}

async function pdfRunAI(instruction) {
  const { text, source } = pdfGetContext();
  const resultEl   = pdfGet('ppp-result');
  const resultBody = pdfGet('ppp-result-body');
  const applyBtn   = pdfGet('ppp-apply-btn');
  if (!resultEl || !resultBody) return;

  resultEl.style.display = '';
  resultBody.innerHTML   = '<span class="pdf-ai-spinner"></span> Working…';
  if (applyBtn) applyBtn.style.display = 'none';
  _lastAiText = '';
  resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const isEdit = /\b(fix|replac|rewrit|chang|updat|correct|remov|delet|insert|make|translat|reword|shorten|expand|convert|format|capitaliz|lower|upper|improve|condense|structure|profess|smarter|cleaner|simpler|shorter|longer)\b/i.test(instruction);

  const prompt = source === 'selection'
    ? `Text selected from PDF:\n"${text}"\n\nInstruction: ${instruction}\n\n${isEdit ? 'Return ONLY the replacement text. No explanation, no quotation marks.' : 'Answer concisely in 2–4 sentences.'}`
    : `Full document text:\n${text}\n\nInstruction: ${instruction}\n\nRespond concisely.`;

  const model = pdfGet('model-select')?.value || 'gemma3:latest';
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true }),
    });
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    resultBody.textContent = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        try { const d = JSON.parse(l); if (d.message?.content) { _lastAiText += d.message.content; resultBody.textContent = _lastAiText; } } catch { }
      }
    }
    if (isEdit && _activeSel?.spans.length && _lastAiText.trim()) {
      if (applyBtn) applyBtn.style.display = '';
    }
  } catch (e) {
    resultBody.textContent = '⚠ ' + e.message;
  }
}

function pdfApplyEdit() {
  if (!_activeSel?.spans.length || !_lastAiText.trim()) return;
  const [first, ...rest] = _activeSel.spans;
  first.textContent      = _lastAiText.trim();
  first.dataset.changed  = 'true';
  first.dataset.newText  = _lastAiText.trim();
  first.style.color      = '#111';
  first.style.background = 'rgba(255,220,50,0.35)';
  first.style.padding    = '0 1px';
  first.contentEditable  = 'true';
  rest.forEach(s => { s.dataset.changed = 'true'; s.dataset.newText = ''; s.textContent = ''; });
  pdfClearSelection();
  pdfSetStatus('Edit applied — click 💾 Save to write to file');
}

// ── Save PDF ──────────────────────────────────────────────────────────────────
async function pdfSave() {
  if (!_pdfFile) return;
  pdfSetStatus('Saving…');
  try {
    await pdfEnsureLibs();
    const { PDFDocument, rgb, StandardFonts } = _PDFLib;
    const ab   = await _pdfFile.arrayBuffer();
    const doc  = await PDFDocument.load(ab, { ignoreEncryption: true });
    const font = await doc.embedFont(StandardFonts.Helvetica);

    document.querySelectorAll('.pe-text-item[data-changed="true"]').forEach(span => {
      const pageNum = parseInt(span.closest('.pe-page').dataset.pageNum) - 1;
      const page = doc.getPages()[pageNum];
      const x    = parseFloat(span.dataset.pdfX);
      const y    = parseFloat(span.dataset.pdfY);
      const fs   = parseFloat(span.dataset.pdfFs) || 12;
      const origW = parseFloat(span.dataset.pdfWidth) || fs * (span.dataset.original?.length || 1) * 0.6;
      const newText = (span.dataset.newText ?? span.textContent).trim();
      page.drawRectangle({ x: x - 1, y: y - fs * 0.15, width: origW + 4, height: fs * 1.35, color: rgb(1, 1, 1), borderWidth: 0 });
      if (newText) page.drawText(newText, { x, y, size: fs, font, color: rgb(0, 0, 0) });
    });

    const bytes = await doc.save();
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })),
      download: _pdfFile.name.replace(/\.pdf$/i, '_edited.pdf'),
    });
    a.click();
    _pdfFile = new File([bytes], _pdfFile.name, { type: 'application/pdf' });
    pdfSetStatus('Saved ✓');
  } catch (e) {
    pdfSetStatus('⚠ Save failed: ' + e.message);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
function pdfInit() {
  console.log('[PDFStudio] init');

  // File open
  pdfGet('pdf-open-btn')?.addEventListener('click', () => pdfGet('pdf-file-input')?.click());
  pdfGet('pdf-file-input')?.addEventListener('change', e => {
    const f = e.target.files[0]; if (f) pdfOpen(f); e.target.value = '';
  });

  // Drag & drop on viewer
  const wrap = pdfGet('pdf-viewer-wrap');
  wrap?.addEventListener('dragover', e => e.preventDefault());
  wrap?.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type === 'application/pdf') pdfOpen(f); });

  // Save
  pdfGet('pdf-save-btn')?.addEventListener('click', pdfSave);

  // Toolbar tool buttons
  document.querySelectorAll('.peb-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => pdfSetTool(btn.dataset.tool));
  });

  // Color swatches
  document.querySelectorAll('.peb-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      document.querySelectorAll('.peb-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      _annotColor = sw.dataset.color;
    });
  });

  // AI panel: workflow buttons
  document.querySelectorAll('.ppp-ai-btn').forEach(btn => {
    btn.addEventListener('click', () => pdfRunAI(btn.dataset.prompt));
  });

  // AI panel: translate
  pdfGet('ppp-translate-btn')?.addEventListener('click', () => {
    const lang = pdfGet('ppp-lang')?.value || 'Spanish';
    pdfRunAI(`Translate this text to ${lang}. Return only the translated text, nothing else.`);
  });

  // AI panel: custom instruction
  pdfGet('ppp-run-btn')?.addEventListener('click', () => {
    const txt = pdfGet('ppp-custom')?.value?.trim();
    if (txt) pdfRunAI(txt);
  });
  pdfGet('ppp-custom')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); pdfGet('ppp-run-btn')?.click(); }
  });

  // AI panel: clear selection
  pdfGet('ppp-sel-clear')?.addEventListener('click', pdfClearSelection);

  // AI panel: apply
  pdfGet('ppp-apply-btn')?.addEventListener('click', pdfApplyEdit);

  // AI panel: dismiss result
  pdfGet('ppp-result-close')?.addEventListener('click', () => {
    pdfGet('ppp-result').style.display = 'none'; _lastAiText = '';
    pdfGet('ppp-apply-btn').style.display = 'none';
  });

  // ESC exits active tool back to select
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('tab-pdf')?.classList.contains('active')) {
      pdfSetTool('select');
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', pdfInit);
} else {
  pdfInit();
}
