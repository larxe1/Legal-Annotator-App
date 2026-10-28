// ═══════════════════════════════════════════════
// PEN — Apple Pencil / stylus input layer (modular add-on)
//
// Self-contained. Loaded with a dynamic import from main.js inside try/catch,
// so a failure here can never break app startup.
//
//  • Manual toggle button ("✒ Pen") in the toolbar. Persisted in localStorage.
//  • Text mode + Pen ON: dragging the Pencil over text selects/highlights text
//    live character-by-character and line-by-line (just like clicking and dragging
//    with a mouse or highlighting in Apple Books), then saves on lift via the
//    EXISTING createAnnotation() — DB / sync / export are untouched.
//  • Draw mode + Pen ON: only the Pencil draws (draw.js checks S.penMode); fingers scroll.
//  • Palm rejection: while the Pencil is down (and for a short moment after) other
//    touches on the PDF area are ignored so a resting hand can't scroll/select.
//  • Fingers are never touched when Pen is OFF, and Box mode is never touched.
//
//  FINGER (touchscreen laptop) highlighting — adaptive, mouse is never affected:
//  • Every pointer reports its type (mouse / pen / touch), so each gesture is routed
//    automatically: the mouse keeps the normal select → "✓ Highlight" flow.
//  • Text mode + Pen OFF + Finger Highlighting ON (default): one finger dragged across
//    text highlights it live and saves on lift (same createAnnotation path as the Pencil).
//  • One finger starting on a blank margin / between pages scrolls natively.
//  • Two fingers scroll (with momentum) anywhere; pinch-zoom stays in draw.js.
//  • A quick tap is left to the browser, so tapping a highlight still opens it.
//  • Toggle: Settings → "Touchscreen Finger Highlighting" (localStorage 'finger_highlight').
//
// Kill switches: toolbar toggle, or open the app with ?nopen=1.
// Desktop testing: localStorage.setItem('pen_debug_mouse','1') makes the mouse act as a pen.
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { toast } from './ui.js';
import { safeStorageGet, safeStorageSet } from './storage.js';

const LS_KEY       = 'pen_mode';
const TAP_MAX_MOVE = 6;      // px  — shorter than this (and quick) = a tap, not a drag
const TAP_MAX_MS   = 450;
const PALM_MS      = 250;    // ignore new finger touches this long after the Pencil lifts
const STUCK_MS     = 15000;  // safety: never keep touches blocked longer than this
const MAX_ERRORS   = 3;
const LS_FINGER       = 'finger_highlight';
const FINGER_TAP_MOVE = 10;  // px  — fingers jitter more than a Pencil

let _enabled    = false;
let _installed  = false;
let _errors     = 0;
let _btn        = null;
let _stroke     = null;   // { id, pn, x0, y0, curX, curY, maxMove, t0, geo, startCaret, previewEl, lastRes }
let _penDown    = false;
let _penDownTs  = 0;
let _lastPenUp  = 0;
let _raf        = 0;
let _scroll     = null;
let _fingerOn   = true;       // finger highlighting (touchscreens); mouse is unaffected
const _touchPts = new Set();  // touch pointerIds currently down on the PDF area
let _pan        = null;       // two-finger scroll tracking { x, y, t, vx, vy }
let _inertiaRaf = 0;
const _sharedRange = document.createRange();

const debugMouse = () => safeStorageGet('pen_debug_mouse', '0') === '1';
const isPenEvent = e => e.pointerType === 'pen' || (e.pointerType === 'mouse' && debugMouse());

// ───────────────────────── init / toggle ─────────────────────────
export function initPen() {
  try {
    if (_installed) return;
    if (new URLSearchParams(location.search).get('nopen') === '1') return;
    _scroll = document.getElementById('canvas-scroll');
    const toolbar = document.getElementById('toolbar');
    if (!_scroll || !toolbar) return;
    _installed = true;
    injectStyle();
    buildButton(toolbar);
    attach(_scroll);
    if (safeStorageGet(LS_KEY, '0') === '1') setPenMode(true, { silent: true });
    _fingerOn = safeStorageGet(LS_FINGER, '1') !== '0';
    try { buildFingerSetting(); } catch (e) { console.warn('[Pen] finger setting UI failed:', e); }
  } catch (e) {
    console.warn('[Pen] init failed — pen support disabled:', e);
  }
}

export function isPenMode() { return _enabled; }

export function setPenMode(on, { silent = false } = {}) {
  _enabled = !!on;
  S.penMode = _enabled;                       // read by draw.js (pen-only drawing + pressure)
  if (_enabled) _errors = 0;
  document.body.classList.toggle('pen-on', _enabled);
  _btn?.classList.toggle('active', _enabled);
  _btn?.setAttribute('aria-pressed', String(_enabled));
  const sb = document.getElementById('btn-pen-setting');
  if (sb) sb.textContent = _enabled ? 'Pen Mode: ON (tap to turn off)' : 'Pen Mode: OFF (tap to turn on)';
  safeStorageSet(LS_KEY, _enabled ? '1' : '0');
  if (!_enabled) cancelStroke();
  if (!silent) {
    toast(_enabled
      ? '✒ Pen mode ON — drag Pencil over text to highlight, fingers scroll & zoom'
      : '✒ Pen mode OFF');
  }
}

// ───────────────────────── finger highlighting toggle ─────────────────────────
export function isFingerHighlight() { return _fingerOn; }

export function setFingerHighlight(on, { silent = false } = {}) {
  _fingerOn = !!on;
  if (!_fingerOn && _stroke?.finger) cancelStroke();
  safeStorageSet(LS_FINGER, _fingerOn ? '1' : '0');
  updateFingerSettingBtn();
  if (!silent) {
    toast(_fingerOn
      ? '✋ Finger highlighting ON — drag a finger over text to highlight, two fingers scroll'
      : '✋ Finger highlighting OFF — fingers scroll and select text as before');
  }
}

function fingerActiveForMode() { return _fingerOn && !_enabled && S.mode === 'text'; }

function updateFingerSettingBtn() {
  const b = document.getElementById('btn-finger-setting');
  if (b) b.textContent = _fingerOn ? 'Finger Highlighting: ON (tap to turn off)' : 'Finger Highlighting: OFF (tap to turn on)';
}

// Adds a "Touchscreen Finger Highlighting" card right below the Pen card in Settings.
function buildFingerSetting() {
  if (document.getElementById('btn-finger-setting')) return;
  const penCard = document.getElementById('btn-pen-setting')?.parentElement;
  if (!penCard?.parentNode) return;
  const card = document.createElement('div');
  card.id = 'finger-setting-card';
  card.style.cssText = penCard.style.cssText;
  card.innerHTML = `
    <div style="font-size:13px; font-weight:600; color:#e8e4db; margin-bottom:4px;">✋ Touchscreen Finger Highlighting</div>
    <div style="font-size:11px; color:var(--muted); margin-bottom:10px;">The app detects mouse vs. finger automatically. With a finger: drag across text to highlight it instantly, drag on a blank margin or use two fingers to scroll, pinch to zoom, and tap a highlight to open it. The mouse keeps working exactly as before. (Pauses while Pen mode is on.)</div>
    <button class="btn-sec" id="btn-finger-setting" type="button" style="width:100%; padding:7px 10px; font-size:12px;"></button>`;
  penCard.parentNode.insertBefore(card, penCard.nextSibling);
  card.querySelector('#btn-finger-setting').addEventListener('click', () => setFingerHighlight(!_fingerOn));
  updateFingerSettingBtn();
}

function injectStyle() {
  if (document.getElementById('pen-style')) return;
  const st = document.createElement('style');
  st.id = 'pen-style';
  st.textContent = `
    #pen-toggle { white-space: nowrap; }
    #pen-toggle.active { background: var(--gold-bg); color: var(--gold); border-color: var(--gold); }
    .hi-grp.pen-preview { pointer-events: none !important; opacity: 0.4; mix-blend-mode: multiply; }
    .hi-grp.pen-preview .hr { pointer-events: none !important; transition: none !important; }
    body.pen-on #canvas-scroll { -webkit-touch-callout: none; }
  `;
  document.head.appendChild(st);
}

function buildButton(toolbar) {
  _btn = document.createElement('button');
  _btn.id = 'pen-toggle';
  _btn.type = 'button';
  _btn.className = 'tb-btn';
  _btn.title = 'Pen mode: use Apple Pencil to highlight text / draw. Fingers keep scrolling and zooming.';
  _btn.innerHTML = '✒ <span>Pen</span>';
  const anchor = document.getElementById('mode-tog');
  if (anchor?.parentNode) anchor.parentNode.insertBefore(_btn, anchor.nextSibling);
  else toolbar.appendChild(_btn);
  _btn.addEventListener('click', () => setPenMode(!_enabled));

  const sb = document.getElementById('btn-pen-setting');
  if (sb) {
    sb.textContent = 'Pen Mode: OFF (tap to turn on)';
    sb.addEventListener('click', () => setPenMode(!_enabled));
  }
}

// ───────────────────────── error guard ─────────────────────────
function guard(fn) {
  return function (...args) {
    try { return fn.apply(this, args); }
    catch (err) {
      _errors++;
      console.error('[Pen] handler error', err);
      cancelStroke();
      if (_errors >= MAX_ERRORS && _enabled) {
        setPenMode(false, { silent: true });
        toast('✒ Pen mode turned off after repeated errors — app is unaffected.');
      } else if (_errors >= MAX_ERRORS && _fingerOn) {
        setFingerHighlight(false, { silent: true });
        toast('✋ Finger highlighting turned off after repeated errors — app is unaffected.');
      }
    }
  };
}

// ───────────────────────── event wiring ─────────────────────────
function attach(scroll) {
  const cap = { capture: true };
  scroll.addEventListener('pointerdown',   guard(onPointerDown), cap);
  scroll.addEventListener('pointermove',   guard(onPointerMove), cap);
  scroll.addEventListener('pointerup',     guard(onPointerUp),   cap);
  scroll.addEventListener('pointercancel', guard(onPointerCancel), cap);
  // Non-passive touch listeners so we can stop the page scrolling for Pencil touches only.
  scroll.addEventListener('touchstart', guard(onTouchGuard), { capture: true, passive: false });
  scroll.addEventListener('touchmove',  guard(onTouchGuard), { capture: true, passive: false });
  scroll.addEventListener('touchend',    guard(onTouchEnd), { capture: true, passive: true });
  scroll.addEventListener('touchcancel', guard(onTouchEnd), { capture: true, passive: true });
  // No native text selection / callout while the Pencil (or a highlighting finger) is down.
  document.addEventListener('selectstart', e => { if ((_enabled && _penDown) || _stroke?.finger) e.preventDefault(); }, true);
  scroll.addEventListener('contextmenu',   e => { if ((_enabled && _penDown) || _stroke?.finger) e.preventDefault(); }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelStroke(); });
  window.addEventListener('blur', cancelStroke);
}

function penActiveForMode() { return _enabled && S.mode !== 'box'; }

function onPointerDown(e) {
  if (e.pointerType === 'touch') { onFingerDown(e); return; }
  if (!penActiveForMode() || !isPenEvent(e)) return;

  // Draw mode: draw.js does the drawing. We only note "pen is down" so touches are blocked.
  if (S.mode === 'draw') { markPenDown(); return; }

  // Text mode: click-and-drag text selection with the Pencil.
  if (S.mode !== 'text') return;
  const pn = pageAt(e.clientX, e.clientY);
  if (pn == null) return;

  e.preventDefault();
  markPenDown();
  window.getSelection()?.removeAllRanges();
  document.getElementById('sel-menu')?.classList.remove('open');

  const geo = buildPageSpanGeo(pn);
  const startCaret = geo.length ? caretAt(geo, e.clientX, e.clientY, true) : null;

  _stroke = {
    id: e.pointerId,
    pn,
    x0: e.clientX,
    y0: e.clientY,
    curX: e.clientX,
    curY: e.clientY,
    maxMove: 0,
    t0: performance.now(),
    geo,
    startCaret,
    previewEl: null,
    lastRes: null,
  };
  try { _scroll.setPointerCapture(e.pointerId); } catch {}
}

// Finger on a touchscreen. Only starts a highlight when the finger lands on text;
// blank margins / gaps between pages keep normal one-finger scrolling.
function onFingerDown(e) {
  if (e.isPrimary) _touchPts.clear();         // a new gesture — drop any stale ids
  _touchPts.add(e.pointerId);
  stopInertia();
  if (_touchPts.size > 1) {                   // second finger → scroll / zoom, never a highlight
    if (_stroke?.finger) cancelStroke();
    return;
  }
  if (!fingerActiveForMode() || _stroke) return;
  const pn = pageAt(e.clientX, e.clientY);
  if (pn == null) return;
  const geo = buildPageSpanGeo(pn);
  const startCaret = geo.length ? caretAt(geo, e.clientX, e.clientY, true) : null;
  if (!startCaret) return;

  // No preventDefault and no pointer capture here: a quick tap must still reach the
  // element under the finger as a normal click (e.g. tapping a highlight opens it).
  window.getSelection()?.removeAllRanges();
  document.getElementById('sel-menu')?.classList.remove('open');
  _stroke = {
    id: e.pointerId,
    finger: true,
    pn,
    x0: e.clientX,
    y0: e.clientY,
    curX: e.clientX,
    curY: e.clientY,
    maxMove: 0,
    t0: performance.now(),
    geo,
    startCaret,
    previewEl: null,
    lastRes: null,
  };
}

function onPointerMove(e) {
  if (!_stroke || e.pointerId !== _stroke.id) return;
  e.preventDefault();
  _stroke.curX = e.clientX;
  _stroke.curY = e.clientY;
  const move = Math.hypot(e.clientX - _stroke.x0, e.clientY - _stroke.y0);
  if (move > _stroke.maxMove) _stroke.maxMove = move;

  // If user touched down slightly outside a word and dragged onto text, anchor on first text hit
  if (!_stroke.startCaret && _stroke.geo.length) {
    _stroke.startCaret = caretAt(_stroke.geo, e.clientX, e.clientY, true);
  }
  schedulePreview();
}

function onPointerUp(e) {
  if (e.pointerType === 'touch') _touchPts.delete(e.pointerId);
  if (isPenEvent(e)) { _penDown = false; _lastPenUp = Date.now(); }
  if (!_stroke || e.pointerId !== _stroke.id) return;
  const st = _stroke;
  _stroke = null;
  st.curX = e.clientX;
  st.curY = e.clientY;
  const move = Math.hypot(e.clientX - st.x0, e.clientY - st.y0);
  if (move > st.maxMove) st.maxMove = move;

  removePreview(st);
  try { _scroll.releasePointerCapture(e.pointerId); } catch {}
  window.getSelection()?.removeAllRanges();
  finishStroke(st);
}

function onPointerCancel(e) {
  if (e.pointerType === 'touch') _touchPts.delete(e.pointerId);
  if (isPenEvent(e)) { _penDown = false; _lastPenUp = Date.now(); }
  if (_stroke && e.pointerId === _stroke.id) cancelStroke();
}

// Block page scroll / selection for Pencil touches + palm rejection.
// Also: two-finger scrolling, and no native scroll while a finger is highlighting.
function onTouchGuard(e) {
  if (e.type === 'touchstart') stopInertia();

  // Two fingers (no Pencil involved) → smooth manual scroll. Pinch-zoom is handled in draw.js.
  if (e.touches.length >= 2 && !stylusInvolved(e)) {
    if (_stroke?.finger) cancelStroke();
    if (e.cancelable) { e.preventDefault(); trackPan(e); }
    else _pan = null;                         // browser already scrolling natively — leave it
    return;
  }

  // One finger highlighting text → stop the page scrolling under it. (touchstart is NOT
  // cancelled, so a quick tap still produces a normal click.)
  if (_stroke?.finger) {
    if (e.type === 'touchmove' && e.cancelable) e.preventDefault();
    return;
  }

  if (!penActiveForMode()) return;
  if (_penDown && Date.now() - _penDownTs > STUCK_MS) _penDown = false;   // safety release

  let stylus = false;
  for (const t of e.changedTouches) if (t.touchType === 'stylus') { stylus = true; break; }

  const palmWindow = e.type === 'touchstart' && (Date.now() - _lastPenUp) < PALM_MS;
  if ((stylus || _penDown || palmWindow) && e.cancelable) {
    e.preventDefault();                       // stops scroll + native selection for these touches
  }
}

function markPenDown() { _penDown = true; _penDownTs = Date.now(); }

// True when the Pencil is part of this touch (iPad reports it as a 'stylus' touch),
// so two-finger scrolling never fights palm rejection while writing.
function stylusInvolved(e) {
  if (_penDown) return true;
  if (_enabled && Date.now() - _lastPenUp < PALM_MS) return true;
  for (const t of e.touches) if (t.touchType === 'stylus') return true;
  return false;
}

// ───────────────────────── two-finger scrolling ─────────────────────────
function trackPan(e) {
  const t0 = e.touches[0], t1 = e.touches[1];
  const mx = (t0.clientX + t1.clientX) / 2;
  const my = (t0.clientY + t1.clientY) / 2;
  const now = performance.now();
  if (!_pan || e.type === 'touchstart') { _pan = { x: mx, y: my, t: now, vx: 0, vy: 0 }; return; }
  const dx = mx - _pan.x, dy = my - _pan.y, dt = Math.max(1, now - _pan.t);
  _scroll.scrollLeft -= dx;
  _scroll.scrollTop  -= dy;
  _pan.vx = 0.7 * (dx / dt) + 0.3 * _pan.vx;
  _pan.vy = 0.7 * (dy / dt) + 0.3 * _pan.vy;
  _pan.x = mx; _pan.y = my; _pan.t = now;
}

function onTouchEnd(e) {
  if (_pan && e.touches.length < 2) {
    const { vx, vy, t } = _pan;
    _pan = null;
    if (performance.now() - t < 80) startInertia(vx, vy);   // fingers were still moving → glide
  }
}

function startInertia(vx, vy) {
  stopInertia();
  if (Math.hypot(vx, vy) < 0.1) return;
  let last = performance.now();
  const step = now => {
    const dt = Math.min(48, now - last);
    last = now;
    _scroll.scrollLeft -= vx * dt;
    _scroll.scrollTop  -= vy * dt;
    const decay = Math.pow(0.95, dt / 16);
    vx *= decay; vy *= decay;
    _inertiaRaf = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
  };
  _inertiaRaf = requestAnimationFrame(step);
}

function stopInertia() {
  if (_inertiaRaf) { cancelAnimationFrame(_inertiaRaf); _inertiaRaf = 0; }
}

function cancelStroke() {
  if (_stroke) removePreview(_stroke);
  _stroke = null;
  _penDown = false;
}

// ───────────────────────── live text-selection preview ─────────────────────────
function removePreview(st) {
  if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
  if (st?.previewEl) {
    st.previewEl.remove();
    st.previewEl = null;
  }
  document.querySelectorAll('.hi-grp.pen-preview').forEach(el => el.remove());
}

function schedulePreview() {
  if (_raf) return;
  _raf = requestAnimationFrame(() => {
    _raf = 0;
    if (!_stroke || _stroke.maxMove < (_stroke.finger ? FINGER_TAP_MOVE : TAP_MAX_MOVE) || !_stroke.startCaret) return;
    const pg = S.pages[_stroke.pn];
    if (!pg?.annOv || !pg.wrap) return;

    const endCaret = caretAt(_stroke.geo, _stroke.curX, _stroke.curY, false);
    if (!endCaret) return;

    const wr = pg.wrap.getBoundingClientRect();
    const res = computeRangeHighlight(_stroke.geo, wr, _stroke.startCaret, endCaret);
    _stroke.lastRes = res;

    if (! _stroke.previewEl) {
      const grp = document.createElement('div');
      grp.className = 'hi-grp pen-preview';
      pg.annOv.appendChild(grp);
      _stroke.previewEl = grp;
    }

    const grp = _stroke.previewEl;
    grp.innerHTML = '';
    if (!res || !res.rects.length) return;
    const col = S.activeColor || '#c9a84c';
    for (const r of res.rects) {
      const d = document.createElement('div');
      d.className = 'hr';
      d.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${col};`;
      grp.appendChild(d);
    }
  });
}

// ───────────────────────── click-and-drag text geometry ─────────────────────────
function pageAt(x, y) {
  for (const k of Object.keys(S.pages || {})) {
    const pg = S.pages[k];
    if (!pg?.wrap || !pg.rendered || !pg.txtLayer) continue;
    const r = pg.wrap.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return parseInt(k, 10);
  }
  return null;
}

function buildPageSpanGeo(pn) {
  const pg = S.pages[pn];
  if (!pg?.txtLayer) return [];
  const geo = [];
  for (const el of pg.txtLayer.children) {
    if (el.tagName !== 'SPAN') continue;
    const node = el.firstChild;
    if (!node || node.nodeType !== 3) continue;
    const str = node.data;
    if (!str) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) continue;
    geo.push({
      idx: geo.length,
      el,
      node,
      str,
      len: str.length,
      l: r.left,
      r: r.right,
      t: r.top,
      b: r.bottom,
      cy: (r.top + r.bottom) / 2,
      h: r.height,
    });
  }
  return geo;
}

// Find the exact character position { spanIdx, offset } at viewport point (x, y),
// matching how mouse click-and-drag text selection anchors and extends across lines.
function caretAt(geo, x, y, isStart) {
  if (!geo.length) return null;

  // 1. Find spans on the line at y (or nearest line when dragging)
  let lineSpans = [];
  for (let i = 0; i < geo.length; i++) {
    const g = geo[i];
    if (y >= g.t - g.h * 0.25 && y <= g.b + g.h * 0.25) lineSpans.push(g);
  }

  if (!lineSpans.length) {
    let bestG = null, bestDy = Infinity;
    for (let i = 0; i < geo.length; i++) {
      const g = geo[i];
      const dy = Math.abs(y - g.cy);
      if (dy < bestDy) { bestDy = dy; bestG = g; }
    }
    if (!bestG) return null;
    // On initial touchdown, ignore taps far away from any text line
    if (isStart && bestDy > bestG.h * 1.1) return null;
    for (let i = 0; i < geo.length; i++) {
      const g = geo[i];
      if (Math.abs(g.cy - bestG.cy) <= Math.min(g.h, bestG.h) * 0.5) lineSpans.push(g);
    }
  }

  // 2. Pick the span on that line closest horizontally to x
  let chosen = null, bestDx = Infinity;
  for (const g of lineSpans) {
    const dx = x < g.l ? (g.l - x) : (x > g.r ? (x - g.r) : 0);
    if (dx < bestDx) { bestDx = dx; chosen = g; }
  }
  if (!chosen) return null;
  if (isStart && bestDx > chosen.h * 2.2) return null;

  // 3. Binary-search the character offset inside the chosen span's text node
  if (x <= chosen.l) return { spanIdx: chosen.idx, offset: 0 };
  if (x >= chosen.r) return { spanIdx: chosen.idx, offset: chosen.len };

  let lo = 0, hi = chosen.len - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    _sharedRange.setStart(chosen.node, mid);
    _sharedRange.setEnd(chosen.node, mid + 1);
    const cr = _sharedRange.getBoundingClientRect();
    if (x > cr.right) lo = mid + 1;
    else hi = mid;
  }
  _sharedRange.setStart(chosen.node, lo);
  _sharedRange.setEnd(chosen.node, lo + 1);
  const cr = _sharedRange.getBoundingClientRect();
  const offset = x > (cr.left + cr.right) / 2 ? lo + 1 : lo;
  return { spanIdx: chosen.idx, offset };
}

// Compute crisp per-line highlight rects and text between startCaret and endCaret
function computeRangeHighlight(geo, wr, startCaret, endCaret) {
  if (!startCaret || !endCaret) return null;
  let c0 = startCaret, c1 = endCaret;
  if (c0.spanIdx > c1.spanIdx || (c0.spanIdx === c1.spanIdx && c0.offset > c1.offset)) {
    [c0, c1] = [c1, c0];
  }
  if (c0.spanIdx === c1.spanIdx && c0.offset === c1.offset) return null;

  const rects = [];
  const texts = [];

  for (let s = c0.spanIdx; s <= c1.spanIdx; s++) {
    const g = geo[s];
    const i0 = (s === c0.spanIdx) ? c0.offset : 0;
    const i1 = (s === c1.spanIdx) ? c1.offset : g.len;
    if (i1 <= i0) continue;

    const sub = g.str.slice(i0, i1);
    if (!sub.trim()) continue;

    _sharedRange.setStart(g.node, i0);
    _sharedRange.setEnd(g.node, i1);
    const rr = _sharedRange.getBoundingClientRect();
    if (rr.width < 1 || rr.height < 1) continue;

    rects.push({
      x: rr.left - wr.left,
      y: rr.top  - wr.top,
      w: rr.width,
      h: rr.height,
    });
    texts.push(sub.trim());
  }

  if (!rects.length) return null;

  // Sort top-to-bottom by line, then left-to-right within the same line
  rects.sort((a, b) => {
    const over = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return over > Math.min(a.h, b.h) * 0.5 ? a.x - b.x : a.y - b.y;
  });

  // Merge rects ONLY when they share >50% vertical height (same line) and are horizontally close
  const merged = [{ ...rects[0] }];
  for (let i = 1; i < rects.length; i++) {
    const cur = rects[i], prev = merged[merged.length - 1];
    const over = Math.max(0, Math.min(prev.y + prev.h, cur.y + cur.h) - Math.max(prev.y, cur.y));
    const maxGap = Math.max(32, Math.min(prev.h, cur.h) * 2.2);
    if (over > Math.min(prev.h, cur.h) * 0.5 && cur.x >= prev.x - 4 && cur.x <= prev.x + prev.w + maxGap) {
      const right  = Math.max(prev.x + prev.w, cur.x + cur.w);
      const bottom = Math.max(prev.y + prev.h, cur.y + cur.h);
      prev.x = Math.min(prev.x, cur.x);
      prev.y = Math.min(prev.y, cur.y);
      prev.w = right - prev.x;
      prev.h = bottom - prev.y;
    } else {
      merged.push({ ...cur });
    }
  }

  const text = texts.join(' ').replace(/\s+/g, ' ').trim();
  return { rects: merged, text: text || '(highlighted text)' };
}

function finishStroke(st) {
  const dur = performance.now() - st.t0;
  if (st.finger) {
    // Finger tap → left to the browser's own click (opens a tapped highlight).
    // Finger held still without dragging → nothing.
    if (st.maxMove < FINGER_TAP_MOVE) return;
  } else if (st.maxMove < TAP_MAX_MOVE && dur < TAP_MAX_MS) {
    handleTap(st);
    return;
  }

  let res = st.lastRes;
  if (!res && st.startCaret && st.geo.length) {
    const pg = S.pages[st.pn];
    const endCaret = caretAt(st.geo, st.curX, st.curY, false);
    if (pg?.wrap && endCaret) {
      res = computeRangeHighlight(st.geo, pg.wrap.getBoundingClientRect(), st.startCaret, endCaret);
    }
  }
  if (!res || !res.rects.length) return;

  import('./annotate.js')
    .then(({ createAnnotation }) => createAnnotation(st.pn, res.rects, res.text, 'text'))
    .catch(err => { console.error('[Pen] createAnnotation failed', err); toast('Highlight failed — try again'); });
}

// Tap an existing highlight with the Pencil → open it (same as clicking it).
function handleTap(st) {
  const pg = S.pages[st.pn];
  if (!pg?.wrap) return;
  const wr = pg.wrap.getBoundingClientRect();
  const x = st.x0 - wr.left, y = st.y0 - wr.top;
  const hit = (S.annotations || []).filter(a => a.page === st.pn &&
    (a.rects || []).some(r => x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y - 2 && y <= r.y + r.h + 2)).pop();
  if (hit) pg.annOv?.querySelector(`[data-id="${hit.id}"]`)?.click();
}
