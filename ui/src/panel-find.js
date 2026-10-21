// ═══════════════════════════════════════════════
// PANEL FIND — Ctrl+F inside the Notes / Case Digest notepad
// and the annotation Notes / Case Summaries panel.
// Uses the CSS Custom Highlight API so the editable note HTML
// is never modified (nothing extra can be saved into notes).
// ═══════════════════════════════════════════════

const PANEL_IDS = ['notepad-panel', 'ann-panel'];
const HL_ALL = 'panel-find-all';
const HL_CUR = 'panel-find-cur';
const hasHighlightAPI = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

let _bar = null;
let _panel = null;   // panel element the bar is attached to
let _ranges = [];
let _idx = -1;
let _debounce = null;

function openPanel() {
  for (const id of PANEL_IDS) {
    const el = document.getElementById(id);
    if (el && el.classList.contains('open')) return el;
  }
  return null;
}

function isVisible(el) {
  return !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
}

// Areas of the open panel that contain readable note text
function searchRoots(panel) {
  if (panel.id === 'notepad-panel') {
    return ['np-editor', 'np-digest-editor'].map(id => document.getElementById(id)).filter(isVisible);
  }
  return ['ann-notes', 'note-editor'].map(id => document.getElementById(id)).filter(isVisible);
}

function buildBar() {
  const bar = document.createElement('div');
  bar.id = 'panel-find-bar';
  bar.innerHTML = `
    <input id="pf-input" type="text" placeholder="Find in notes…" autocomplete="off" spellcheck="false">
    <span id="pf-count"></span>
    <button id="pf-prev" title="Previous (Shift+Enter)">▲</button>
    <button id="pf-next" title="Next (Enter)">▼</button>
    <button id="pf-close" title="Close (Esc)">✕</button>`;
  const input = bar.querySelector('#pf-input');
  input.addEventListener('input', () => {
    clearTimeout(_debounce);
    _debounce = setTimeout(() => runFind(true), 150);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanelFind(); }
  });
  bar.querySelector('#pf-prev').addEventListener('click', () => step(-1));
  bar.querySelector('#pf-next').addEventListener('click', () => step(1));
  bar.querySelector('#pf-close').addEventListener('click', closePanelFind);
  return bar;
}

export function openPanelFind(panel) {
  if (!_bar) _bar = buildBar();
  if (_panel !== panel || !_bar.isConnected) {
    _panel = panel;
    // Sit directly under the panel header so nothing is covered
    const header = panel.querySelector(':scope > .np-hd, :scope > .ap-hd');
    if (header) header.after(_bar); else panel.prepend(_bar);
  }
  _bar.style.display = 'flex';
  const input = _bar.querySelector('#pf-input');
  // Pre-fill with the currently selected text (like a browser)
  const sel = window.getSelection()?.toString().trim();
  if (sel && sel.length < 100 && !sel.includes('\n')) input.value = sel;
  input.focus();
  input.select();
  runFind(true);
}

export function closePanelFind() {
  if (_bar) _bar.style.display = 'none';
  clearHighlights();
  _ranges = [];
  _idx = -1;
}

function clearHighlights() {
  if (hasHighlightAPI) {
    CSS.highlights.delete(HL_ALL);
    CSS.highlights.delete(HL_CUR);
  }
}

function runFind(resetIdx) {
  if (!_panel || !_bar || _bar.style.display === 'none') return;
  const q = _bar.querySelector('#pf-input').value.trim().toLowerCase();
  const countEl = _bar.querySelector('#pf-count');
  clearHighlights();
  _ranges = [];
  if (!q) { countEl.textContent = ''; _idx = -1; return; }

  for (const root of searchRoots(_panel)) {
    // Concatenate the text nodes so matches can span bold/italic boundaries
    const nodes = [];
    let full = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, start: full.length });
      full += n.nodeValue;
    }
    const hay = full.toLowerCase();
    const locate = (pos) => {
      let lo = 0, hi = nodes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (nodes[mid].start <= pos) lo = mid; else hi = mid - 1;
      }
      return nodes[lo];
    };
    for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) {
      const a = locate(i);
      const b = locate(i + q.length - 1);
      const r = document.createRange();
      r.setStart(a.node, i - a.start);
      r.setEnd(b.node, i + q.length - b.start);
      _ranges.push(r);
    }
  }

  if (!_ranges.length) { countEl.textContent = 'No matches'; _idx = -1; return; }
  if (resetIdx || _idx < 0 || _idx >= _ranges.length) _idx = 0;
  if (hasHighlightAPI) CSS.highlights.set(HL_ALL, new Highlight(..._ranges));
  showCurrent();
}

function step(dir) {
  if (!_ranges.length) { runFind(true); return; }
  _idx = (_idx + dir + _ranges.length) % _ranges.length;
  showCurrent();
}

function showCurrent() {
  const r = _ranges[_idx];
  if (!r) return;
  _bar.querySelector('#pf-count').textContent = `${_idx + 1} / ${_ranges.length}`;
  if (hasHighlightAPI) {
    CSS.highlights.set(HL_CUR, new Highlight(r));
  } else {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  const el = r.startContainer.parentElement;
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function initPanelFind() {
  // Capture phase on window runs before the PDF search shortcut listeners,
  // so Ctrl+F searches the notes whenever a notes panel is open.
  window.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return;
    const panel = openPanel();
    if (!panel) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openPanelFind(panel);
  }, true);

  // Keep results fresh while typing in the notes or switching tabs
  const refresh = () => {
    if (!_bar || _bar.style.display === 'none') return;
    clearTimeout(_debounce);
    _debounce = setTimeout(() => runFind(false), 250);
  };
  for (const id of PANEL_IDS) {
    const p = document.getElementById(id);
    if (!p) continue;
    p.addEventListener('input', e => { if (e.target?.id !== 'pf-input') refresh(); });
    p.addEventListener('click', e => { if (e.target.closest?.('.ap-tab')) refresh(); });
    // Hide the bar when the panel closes
    new MutationObserver(() => {
      if (_panel === p && !p.classList.contains('open')) closePanelFind();
    }).observe(p, { attributes: true, attributeFilter: ['class'] });
  }
}
