// ═══════════════════════════════════════════════
// ANNOTATE — highlights, annotation panel, notes
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { toast, autosave, openModal, closeModal, closeOtherPanels, jumpToPage } from './ui.js';
import { normalizeHexColor, getColorCategoryForHex } from './colors.js';
import {
  dbCreateAnnotation, dbUpdateAnnColor, dbDelAnnotation,
  dbCreateNote, dbUpdateNote, dbDelNote,
} from './db.js';
import { handlePaste, handleCopy, showTablePicker, insertBannerHeader, toggleGrayOut, handleEditorKeyDown, outdentLine, indentLine, applyEditorHighlight, copyFirstSummaryTable } from './tablepicker.js';
import { openPdfLinkModal, insertWebLink } from './pdflink.js';
import { safeStorageSet, safeStorageGet, scheduleDebouncedLocalAnnsSave } from './storage.js';
import {
  loadTagsForPdf, getAnnTags, addTagToAnn, removeTagFromAnn,
  getAllTopicsForCurrentPdf, renderAnnPanelTagsSection,
  initTagsPanel, toggleTagsPanel, redrawTagBadgeForAnn,
  getActiveQuickTag, setActiveQuickTag, onAnnDeleted,
  updateSelMenuMassTagButton
} from './tags.js';

export {
  loadTagsForPdf, getAnnTags, addTagToAnn, removeTagFromAnn,
  getAllTopicsForCurrentPdf, renderAnnPanelTagsSection,
  initTagsPanel, toggleTagsPanel, getActiveQuickTag, setActiveQuickTag
};

function _escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function _notifyAnnotationsChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('la:annotations-changed'));
  }
}

// ── Create annotation (text or box) ──
export async function createAnnotation(pageNum, rects, text, mode_) {
  if (!S.curPDF) return;
  const trueId = S.curPDF.linked_pdf_id || S.curPDF.id;
  const activeTag = getActiveQuickTag();
  const ann = {
    id: 'ann_' + Date.now(),
    pdf_file_id: trueId,
    page: pageNum,
    rects,
    highlighted_text: text,
    hex_color: normalizeHexColor(S.activeColor) || S.activeColor || '#c9a84c',
    highlight_mode: mode_,
    notes: [],
    tags: activeTag ? [activeTag] : [],
  };
  try {
    autosave('saving');
    await dbCreateAnnotation(ann);
    S.annotations.push(ann);
    invalidateAnnotationPageIndex();
    if (activeTag) {
      addTagToAnn(ann, activeTag, { skipSaveAnn: true });
    }
    // Update badge count
    S.annCounts[trueId] = (S.annCounts[trueId] || 0) + 1;
    updateAnnBadge(trueId);
    drawAnnotation(ann);
    if (S.selAnn && document.getElementById('ann-panel')?.classList.contains('open')) {
      updateAnnPanelNav(S.selAnn);
    }
    _notifyAnnotationsChanged();
    autosave('saved');
    toast(activeTag ? `Highlight saved (${activeTag})` : 'Highlight saved');
  } catch (e) {
    autosave('err');
    toast('Save failed — check connection');
  }
}

let activeNoteTab = 'general'; // 'general' | 'case'

export function getNoteType(note) {
  if (!note || !note.note_html) return 'general';
  if (note.note_html.includes('data-note-type="case"') || note.note_html.includes("data-note-type='case'")) {
    return 'case';
  }
  return 'general';
}

export function getNoteBody(note) {
  if (!note || !note.note_html) return '';
  let html = note.note_html;
  const match = html.match(/^<div\s+data-note-type=["'](?:case|general)["'][^>]*>([\s\S]*)<\/div>$/i);
  if (match) html = match[1];

  // Auto-clean any legacy corrupted markup (e.g. copied PDF highlight rects / canvas / hi-grp / absolute elements)
  if (html.includes('class="hr"') || html.includes('class="hi-grp"') || html.includes('class="ann-ov"') || html.includes('class="txt-layer"') || html.includes('position: absolute') || html.includes('position:absolute')) {
    const d = new DOMParser().parseFromString(html, 'text/html');
    d.querySelectorAll('.hi-grp, .hr, .ann-ov, .txt-layer, .draw-canvas, canvas, .srch-ov, #sel-menu, #drag-ghost').forEach(el => el.remove());
    d.querySelectorAll('*').forEach(el => {
      if (el.style.position === 'absolute' || el.style.position === 'fixed') el.remove();
    });
    html = d.body.innerHTML;
  }

  // Ensure tables have containment styling
  if (html.includes('<table') && !html.includes('note-table')) {
    html = html.replace(/<table(?:\s+[^>]*)?>/gi, '<table class="note-table" style="width:100%; max-width:100%; border-collapse:collapse; margin:10px 0; table-layout:auto; word-break:break-word;">');
  }

  return html;
}

export function wrapNoteHtml(html, type) {
  if (type === 'case') {
    return `<div data-note-type="case">${html}</div>`;
  }
  return html;
}

const LEGACY_BASE_SCALE = 1.5;

function _escAttrVal(val) {
  const s = String(val ?? '');
  return (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
    ? CSS.escape(s)
    : s.replace(/["\\]/g, '\\$&');
}

function hexToRgba(hex, alpha) {
  const norm = normalizeHexColor(hex) || '#c9a84c';
  const r = parseInt(norm.slice(1, 3), 16);
  const g = parseInt(norm.slice(3, 5), 16);
  const b = parseInt(norm.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Convert a stored highlight rect (normalized [0..1] when r.n === 1, or legacy px at 1.5 scale)
 * into CSS pixel coordinates { x, y, w, h } for the page's current rendered size.
 */
export function rectToPx(r, pageOrWrap) {
  if (!r) return { x: 0, y: 0, w: 0, h: 0 };
  const rx = Number(r.x) || 0;
  const ry = Number(r.y) || 0;
  const rw = Number(r.w) || 0;
  const rh = Number(r.h) || 0;

  if (r.n === 1) {
    let pw = 0, ph = 0;
    if (typeof pageOrWrap === 'number') {
      const pg = S.pages?.[pageOrWrap];
      pw = pg?.viewport?.width || pg?.wrap?.clientWidth || 0;
      ph = pg?.viewport?.height || pg?.wrap?.clientHeight || 0;
    } else if (pageOrWrap && typeof pageOrWrap === 'object') {
      pw = pageOrWrap.width || pageOrWrap.clientWidth || pageOrWrap.offsetWidth || 0;
      ph = pageOrWrap.height || pageOrWrap.clientHeight || pageOrWrap.offsetHeight || 0;
    }
    if (!(pw > 0 && ph > 0)) {
      const fallbackPg = Object.values(S.pages || {}).find(p => p?.viewport?.width > 0 || p?.wrap?.clientWidth > 0);
      pw = fallbackPg?.viewport?.width || fallbackPg?.wrap?.clientWidth || (612 * (S.scale || LEGACY_BASE_SCALE));
      ph = fallbackPg?.viewport?.height || fallbackPg?.wrap?.clientHeight || (792 * (S.scale || LEGACY_BASE_SCALE));
    }
    return { x: rx * pw, y: ry * ph, w: rw * pw, h: rh * ph };
  }

  const ratio = (S.scale || LEGACY_BASE_SCALE) / LEGACY_BASE_SCALE;
  return { x: rx * ratio, y: ry * ratio, w: rw * ratio, h: rh * ratio };
}

/**
 * Normalize a stored rect (normalized or legacy px) into [0..1] page coordinates.
 */
export function rectToNorm(r, page) {
  if (!r) return { x: 0, y: 0, w: 0, h: 0 };
  if (r.n === 1) {
    return {
      x: Number(r.x) || 0,
      y: Number(r.y) || 0,
      w: Number(r.w) || 0,
      h: Number(r.h) || 0,
    };
  }
  const pg = typeof page === 'number' ? S.pages?.[page] : null;
  const pw = pg?.viewport?.width || pg?.wrap?.clientWidth || (612 * (S.scale || LEGACY_BASE_SCALE));
  const ph = pg?.viewport?.height || pg?.wrap?.clientHeight || (792 * (S.scale || LEGACY_BASE_SCALE));
  const px = rectToPx(r, pg?.viewport || page);
  return {
    x: pw > 0 ? px.x / pw : 0,
    y: ph > 0 ? px.y / ph : 0,
    w: pw > 0 ? px.w / pw : 0,
    h: ph > 0 ? px.h / ph : 0,
  };
}

function _compareNormReadingOrder(pageA, rA, idA, pageB, rB, idB) {
  const pageDiff = pageA - pageB;
  if (pageDiff !== 0) return pageDiff;

  const xA = rA.x, yA = rA.y, hA = rA.h;
  const xB = rB.x, yB = rB.y, hB = rB.h;

  const minH = Math.min(hA, hB);
  const overlapY = Math.min(yA + hA, yB + hB) - Math.max(yA, yB);
  const sameLine = (minH > 0 && overlapY > minH * 0.45) || (Math.abs(yA - yB) < Math.max(0.008, minH * 0.5));

  if (sameLine) {
    if (xA !== xB) return xA - xB;
  } else {
    if (yA !== yB) return yA - yB;
  }
  if (yA !== yB) return yA - yB;
  if (xA !== xB) return xA - xB;
  return idA.localeCompare(idB);
}

/**
 * Compare two annotations in natural PDF reading order:
 * page ascending -> top-to-bottom -> same-line left-to-right -> id tie-break.
 */
export function compareAnnotationsReadingOrder(a, b) {
  return _compareNormReadingOrder(
    Number(a?.page) || 0,
    rectToNorm(a?.rects?.[0], a?.page),
    String(a?.id ?? ''),
    Number(b?.page) || 0,
    rectToNorm(b?.rects?.[0], b?.page),
    String(b?.id ?? '')
  );
}

/**
 * Return annotations sorted in natural PDF reading order (O(1) cached for S.annotations).
 */
export function getReadingOrderAnnotations(anns = S.annotations) {
  if (!Array.isArray(anns)) return [];
  if (anns === S.annotations) {
    _ensureAnnotationIndex();
    return _orderedAnnotations || [];
  }
  return [...anns].sort(compareAnnotationsReadingOrder);
}

// ── Fast Page & ID Annotation Index ──
let _annsByPage = new Map();
let _annById = new Map();
let _indexedAnnsRef = null;
let _indexedAnnsLen = -1;
let _orderedAnnotations = null;
const _tooltipHtmlCache = new Map();

export function invalidateAnnotationPageIndex() {
  _indexedAnnsRef = null;
  _indexedAnnsLen = -1;
  _orderedAnnotations = null;
  _annsByPage.clear();
  _annById.clear();
  _tooltipHtmlCache.clear();
}

function _ensureAnnotationIndex() {
  const anns = Array.isArray(S.annotations) ? S.annotations : [];
  if (anns !== _indexedAnnsRef || anns.length !== _indexedAnnsLen || !_orderedAnnotations) {
    _annsByPage = new Map();
    _annById = new Map();
    const sortable = [];
    for (const ann of anns) {
      if (!ann) continue;
      const p = Number(ann.page) || 0;
      let list = _annsByPage.get(p);
      if (!list) {
        list = [];
        _annsByPage.set(p, list);
      }
      list.push(ann);
      if (ann.id != null) _annById.set(String(ann.id), ann);
      sortable.push({
        ann,
        page: p,
        norm: rectToNorm(ann.rects?.[0], ann.page),
        id: String(ann.id ?? ''),
      });
    }
    sortable.sort((a, b) => _compareNormReadingOrder(a.page, a.norm, a.id, b.page, b.norm, b.id));
    _orderedAnnotations = sortable.map(item => item.ann);
    _indexedAnnsRef = anns;
    _indexedAnnsLen = anns.length;
  }
}

function _getAnnotationsForPage(pageNum) {
  _ensureAnnotationIndex();
  return _annsByPage.get(Number(pageNum) || 0) || [];
}

export function getAnnotationsForPage(pageNum) {
  return _getAnnotationsForPage(pageNum);
}

function _findAnnotationById(id) {
  if (id == null) return null;
  _ensureAnnotationIndex();
  const key = String(id);
  let found = _annById.get(key);
  if (!found && Array.isArray(S.annotations)) {
    found = S.annotations.find(a => String(a?.id) === key) || null;
    if (found) _annById.set(key, found);
  }
  return found || null;
}

export function getAnnotationById(id) {
  return _findAnnotationById(id) || null;
}

function _sortRectsReadingOrder(rects, pageNum) {
  if (!Array.isArray(rects)) return [];
  const valid = rects.filter(Boolean);
  if (valid.length <= 1) return valid;
  const items = valid.map((r, idx) => ({ r, norm: rectToNorm(r, pageNum), idx }));
  items.sort((a, b) => {
    const rA = a.norm;
    const rB = b.norm;
    const minH = Math.min(rA.h, rB.h);
    const overlapY = Math.min(rA.y + rA.h, rB.y + rB.h) - Math.max(rA.y, rB.y);
    const sameLine = (minH > 0 && overlapY > minH * 0.45) || (Math.abs(rA.y - rB.y) < Math.max(0.008, minH * 0.5));
    if (sameLine) {
      if (rA.x !== rB.x) return rA.x - rB.x;
    } else {
      if (rA.y !== rB.y) return rA.y - rB.y;
    }
    if (rA.y !== rB.y) return rA.y - rB.y;
    if (rA.x !== rB.x) return rA.x - rB.x;
    return a.idx - b.idx;
  });
  return items.map(it => it.r);
}

function _getAnnTooltipSig(ann) {
  const notes = Array.isArray(ann?.notes) ? ann.notes : [];
  const notesSig = notes
    .map(n => `${n?.id ?? ''}:${n?.updated_at ?? n?.updatedAt ?? ''}:${n?.note_html ?? ''}`)
    .join('\x1e');
  const tags = Array.isArray(ann?.tags) ? ann.tags.join(',') : '';
  return [
    ann?.hex_color ?? ann?.color ?? '',
    ann?.highlighted_text ?? ann?.text ?? '',
    ann?.note ?? '',
    notes.length,
    notesSig,
    tags,
  ].join('\x1f');
}

function _buildAnnTooltipHtml(ann) {
  const cacheKey = ann?.id != null ? String(ann.id) : null;
  const sig = cacheKey ? _getAnnTooltipSig(ann) : null;
  if (cacheKey) {
    const cached = _tooltipHtmlCache.get(cacheKey);
    if (cached && cached.sig === sig) return cached.html;
  }

  const notes = Array.isArray(ann?.notes) ? ann.notes : [];
  const genNotes = notes.filter(n => getNoteType(n) === 'general');
  const caseCount = notes.filter(n => getNoteType(n) === 'case').length;
  if (!genNotes.length && !caseCount) {
    if (cacheKey) _tooltipHtmlCache.set(cacheKey, { sig, html: '' });
    return '';
  }

  let html = '';
  const catInfo = getColorCategoryForHex(ann.hex_color);
  const dotColor = catInfo.hex_color || ann.hex_color || '#c9a84c';
  html += `<div style="display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:600; color:var(--ink-muted, var(--muted, #b0aaa0)); margin-bottom:6px;"><span style="width:9px; height:9px; border-radius:50%; background:${_escHtml(dotColor)}; display:inline-block; flex-shrink:0;"></span><span>${_escHtml(catInfo.name)}</span></div>`;
  if (caseCount > 0) {
    const caseLabel = caseCount === 1 ? 'case' : 'cases';
    html += `<div style="display:flex; align-items:center; gap:6px; font-size:0.9em; font-weight:600; color:var(--accent, #c9a84c); background:var(--accent-soft, rgba(201,168,76,0.12)); border:1px solid var(--border-strong, rgba(201,168,76,0.35)); border-radius:6px; padding:4px 10px; margin-bottom:${genNotes.length ? '8px' : '0'};"><svg class="icon" style="width:14px;height:14px;flex-shrink:0" aria-hidden="true"><use href="#i-scale"/></svg> (${caseCount}) ${caseLabel}</div>`;
  }

  const toShow = Math.min(genNotes.length, 3);
  for (let i = 0; i < toShow; i++) {
    if (i > 0) html += '<div style="border-top: 1px solid var(--border, rgba(255,255,255,0.15)); margin: 6px 0; padding-top: 6px;"></div>';
    html += getNoteBody(genNotes[i]);
  }

  if (genNotes.length > 3) {
    html += `<div style="border-top: 1px solid var(--border, rgba(255,255,255,0.15)); margin: 6px 0; padding-top: 6px; font-size: 0.9em; color: var(--ink-muted, var(--muted, #b0aaa0)); text-align: center; font-style: italic;">...and ${genNotes.length - 3} more notes (click to view)</div>`;
  } else if (genNotes.length > 1) {
    html += `<div style="border-top: 1px solid var(--border, rgba(255,255,255,0.15)); margin: 6px 0; padding-top: 6px; font-size: 0.9em; color: var(--ink-muted, var(--muted, #b0aaa0)); text-align: center; font-style: italic;">(click to manage notes)</div>`;
  }
  if (cacheKey) _tooltipHtmlCache.set(cacheKey, { sig, html });
  return html;
}

function _ensureAnnHiLayer(annOv) {
  if (!annOv) return null;
  let layer = annOv.querySelector('.ann-hi-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'ann-hi-layer';
    annOv.insertBefore(layer, annOv.firstChild || null);
  } else if (annOv.firstChild !== layer) {
    annOv.insertBefore(layer, annOv.firstChild);
  }
  return layer;
}

let _hoveredAnnId = null;
let _hoveredGrp = null;
let _hoverGraceTimer = null;

function _clearHoverState() {
  if (_hoverGraceTimer) {
    clearTimeout(_hoverGraceTimer);
    _hoverGraceTimer = null;
  }
  if (_hoveredGrp) {
    _hoveredGrp.classList.remove('is-hovered');
    _hoveredGrp = null;
  }
  _hoveredAnnId = null;
}

function _ensureAnnOverlayDelegation(annOv) {
  if (!annOv || annOv.dataset.annDelegated === '1') return;
  annOv.dataset.annDelegated = '1';

  annOv.addEventListener('click', (e) => {
    const sel = typeof window !== 'undefined' ? window.getSelection?.() : null;
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    const hr = e.target?.closest?.('.hr');
    if (!hr) return;
    const grp = hr.closest('.hi-grp');
    if (!grp || !annOv.contains(grp)) return;
    const ann = _findAnnotationById(grp.dataset.id);
    if (!ann) return;
    e.stopPropagation();
    openAnnPanel(ann);
  });

  annOv.addEventListener('contextmenu', (e) => {
    if (e.target?.closest?.('#canvas-scroll-b') || annOv.closest?.('#canvas-scroll-b')) return;
    const hr = e.target?.closest?.('.hr');
    if (!hr) return;
    const grp = hr.closest('.hi-grp');
    if (!grp || !annOv.contains(grp)) return;
    const ann = _findAnnotationById(grp.dataset.id);
    if (!ann) return;
    openAnnContextMenu(e, ann);
  });

  annOv.addEventListener('pointerover', (e) => {
    const hr = e.target?.closest?.('.hr');
    if (!hr) return;
    const grp = hr.closest('.hi-grp');
    if (!grp || !annOv.contains(grp)) return;
    const annId = String(grp.dataset.id ?? '');
    if (_hoverGraceTimer) {
      clearTimeout(_hoverGraceTimer);
      _hoverGraceTimer = null;
    }
    if (_hoveredAnnId === annId && _hoveredGrp === grp && grp.isConnected) {
      if (tip && tip.style.display !== 'none') moveTip(e);
      return;
    }
    if (_hoveredGrp && _hoveredGrp !== grp) _hoveredGrp.classList.remove('is-hovered');
    _hoveredAnnId = annId;
    _hoveredGrp = grp;
    grp.classList.add('is-hovered');
    const ann = _findAnnotationById(annId);
    if (!ann) {
      hideTip();
      return;
    }
    const html = _buildAnnTooltipHtml(ann);
    if (html) showTip(e, html);
    else hideTip();
  });

  annOv.addEventListener('pointerout', (e) => {
    const hr = e.target?.closest?.('.hr');
    if (!hr) return;
    const grp = hr.closest('.hi-grp');
    if (!grp || !annOv.contains(grp)) return;
    if (e.relatedTarget?.closest?.('.hi-grp') === grp) return;
    if (_hoverGraceTimer) clearTimeout(_hoverGraceTimer);
    _hoverGraceTimer = setTimeout(() => {
      _hoverGraceTimer = null;
      if (_hoveredGrp === grp) {
        grp.classList.remove('is-hovered');
        _hoveredGrp = null;
        _hoveredAnnId = null;
        hideTip();
      }
    }, 45);
  });

  annOv.addEventListener('pointermove', (e) => {
    if (!tip || tip.style.display === 'none') return;
    if (_hoveredAnnId && _hoveredGrp) {
      moveTip(e);
      return;
    }
    const hr = e.target?.closest?.('.hr');
    if (!hr || !hr.closest('.hi-grp')) return;
    moveTip(e);
  });
}

function _buildHiGroupEl(ann, pageDims) {
  const grp = document.createElement('div');
  const isSelected = Boolean(S.selAnn && String(S.selAnn.id) === String(ann.id));
  grp.className = 'hi-grp' + (isSelected ? ' selected' : '');
  grp.dataset.id = ann.id;

  const baseColor = normalizeHexColor(ann.hex_color) || ann.hex_color || '#c9a84c';
  grp.style.setProperty('--hi-bg', hexToRgba(baseColor, 0.4));
  grp.style.setProperty('--hi-bg-hover', hexToRgba(baseColor, 0.56));
  grp.style.setProperty('--hi-cap', hexToRgba(baseColor, 0.92));
  grp.style.setProperty('--hi-outline', hexToRgba(baseColor, 0.85));

  const sortedRects = _sortRectsReadingOrder(ann.rects, ann.page);
  const pageWidthPx = pageDims?.width || pageDims?.clientWidth || 0;

  for (let i = 0; i < sortedRects.length; i++) {
    const r = sortedRects[i];
    const isStart = i === 0;
    const isEnd = i === sortedRects.length - 1;
    const d = document.createElement('div');
    d.className = 'hr' + (isStart ? ' hr-start' : '') + (isEnd ? ' hr-end' : '');

    if (r && r.n === 1) {
      const rw = Number(r.w) || 0;
      const xPct = ((Number(r.x) || 0) * 100).toFixed(5);
      const yPct = ((Number(r.y) || 0) * 100).toFixed(5);
      const wPct = (rw * 100).toFixed(5);
      const hPct = ((Number(r.h) || 0) * 100).toFixed(5);

      // Apply 1px micro-inset on start/end edges so adjacent same-color highlights stay distinct.
      const approxPxW = pageWidthPx > 0 ? rw * pageWidthPx : Infinity;
      const insetLeft = (isStart && approxPxW > 4) ? 1 : 0;
      const insetRight = (isEnd && approxPxW > 4) ? 1 : 0;
      const totalInset = insetLeft + insetRight;
      const leftCss = insetLeft ? `calc(${xPct}% + ${insetLeft}px)` : `${xPct}%`;
      const widthCss = totalInset ? `max(2px, calc(${wPct}% - ${totalInset}px))` : `${wPct}%`;
      d.style.cssText = `left:${leftCss};top:${yPct}%;width:${widthCss};height:${hPct}%;`;
    } else {
      const px = rectToPx(r, pageDims || ann.page);
      const insetLeft = (isStart && px.w > 4) ? 1 : 0;
      const insetRight = (isEnd && px.w > 4) ? 1 : 0;
      const totalInset = insetLeft + insetRight;
      const leftPx = px.x + insetLeft;
      const widthPx = totalInset ? Math.max(2, px.w - totalInset) : px.w;
      d.style.cssText = `left:${leftPx}px;top:${px.y}px;width:${widthPx}px;height:${px.h}px;`;
    }
    grp.appendChild(d);
  }
  return grp;
}

// ── Draw all annotations for a single rendered page (O(pageAnns)) ──
export function drawPageAnnotations(pageNum) {
  const pg = S.pages?.[pageNum];
  if (!pg || !pg.rendered || !pg.annOv) return;
  const annOv = pg.annOv;
  _ensureAnnOverlayDelegation(annOv);
  const layer = _ensureAnnHiLayer(annOv);
  layer.textContent = '';
  if (_hoveredGrp && !_hoveredGrp.isConnected) {
    _clearHoverState();
    hideTip();
  }
  annOv.querySelectorAll('.ann-tag-pill-badge').forEach(el => el.remove());

  const pageAnns = _getAnnotationsForPage(pageNum);
  if (!pageAnns.length) return;

  const pageDims = pg.viewport || pg.wrap;
  const frag = document.createDocumentFragment();
  const taggedAnns = [];
  for (const ann of pageAnns) {
    frag.appendChild(_buildHiGroupEl(ann, pageDims));
    const tags = getAnnTags(ann);
    if (tags && tags.length > 0) taggedAnns.push(ann);
  }
  layer.appendChild(frag);

  for (const ann of taggedAnns) {
    redrawTagBadgeForAnn(ann, pg.viewport);
  }
}

// ── Draw annotation overlay ──
export function drawAnnotation(ann) {
  if (!ann) return;
  const pg = S.pages?.[ann.page];
  if (!pg || !pg.rendered || !pg.annOv) return;
  const annOv = pg.annOv;
  _ensureAnnOverlayDelegation(annOv);
  const layer = _ensureAnnHiLayer(annOv);

  const safeId = _escAttrVal(ann.id);
  layer.querySelectorAll(`[data-id="${safeId}"]`).forEach(el => el.remove());
  if (_hoveredGrp && !_hoveredGrp.isConnected) {
    _clearHoverState();
    hideTip();
  }
  layer.appendChild(_buildHiGroupEl(ann, pg.viewport || pg.wrap));

  const tags = getAnnTags(ann);
  if (tags && tags.length > 0) {
    redrawTagBadgeForAnn(ann, pg.viewport);
  } else {
    annOv.querySelectorAll(`.ann-tag-pill-badge[data-id="${safeId}"]`).forEach(el => el.remove());
  }
}

export function redrawAllAnnotations() {
  invalidateAnnotationPageIndex();
  for (const [pKey, pg] of Object.entries(S.pages || {})) {
    if (pg?.rendered) {
      drawPageAnnotations(Number(pKey));
    }
  }
  _notifyAnnotationsChanged();
}

export function clearAnnMark(id) {
  if (_hoveredAnnId === String(id)) {
    _clearHoverState();
    hideTip();
  }
  const safeId = _escAttrVal(id);
  document.querySelectorAll(`[data-id="${safeId}"]`).forEach(el => el.remove());
}

// ── Annotation badge helper ──
export function updateAnnBadge(pdfId) {
  document.querySelectorAll(`.li-pdf[data-id="${pdfId}"] .ann-badge`).forEach(b => {
    const count = S.annCounts[pdfId] || 0;
    if (count > 0) { b.textContent = count; b.style.display = ''; }
    else b.style.display = 'none';
  });
}

// ── Tooltip ──
let tip = null;
let _tipHtml = '';
let _tipW = 0;
let _tipH = 0;
let _tipRaf = 0;
let _pendingTipX = 0;
let _pendingTipY = 0;
// Track the real input device: touchscreen laptops report maxTouchPoints > 0
// even when the user is hovering with a mouse/touchpad, so only skip the
// hover tooltip when the last interaction was an actual finger touch.
let _lastPointerType = 'mouse';
const _trackPointer = e => { if (e.pointerType) _lastPointerType = e.pointerType; };
window.addEventListener('pointerdown', _trackPointer, { capture: true, passive: true });
window.addEventListener('pointermove', _trackPointer, { capture: true, passive: true });
window.addEventListener('resize', () => { _tipW = 0; _tipH = 0; }, { passive: true });

function _applyTipPosition(clientX, clientY) {
  if (!tip) return;
  const pad = 12;
  const w = _tipW || 420;
  const h = _tipH || 160;
  let x = clientX + 14;
  let y = clientY - 10;
  if (x + w + pad > window.innerWidth) {
    x = Math.max(pad, clientX - w - 14);
  }
  if (y + h + pad > window.innerHeight) {
    y = Math.max(pad, window.innerHeight - h - pad);
  }
  if (y < pad) y = pad;
  tip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

function showTip(e, html) {
  if (_lastPointerType === 'touch' || e?.sourceCapabilities?.firesTouchEvents) return;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'ann-hover-tip note-body';
    tip.style.cssText = 'position:fixed;left:0;top:0;will-change:transform;background:var(--surface-paper, var(--navy, #1a2540));border:1px solid var(--border-strong, var(--accent, #c9a84c));border-radius:10px;padding:14px 18px;font-size:13.5px;min-width:260px;width:max-content;max-width:min(520px,85vw);max-height:80vh;overflow-y:auto;line-height:1.6;z-index:700;pointer-events:none;color:var(--ink, var(--text, #e8e4db));box-shadow:var(--shadow-float, 0 8px 28px rgba(0,0,0,.22));word-break:break-word;';
    document.body.appendChild(tip);
  }
  if (_tipRaf) {
    cancelAnimationFrame(_tipRaf);
    _tipRaf = 0;
  }
  const htmlChanged = _tipHtml !== html;
  if (htmlChanged) {
    tip.innerHTML = html;
    _tipHtml = html;
  }
  tip.style.display = 'block';
  if (htmlChanged || !_tipW || !_tipH) {
    _tipW = tip.offsetWidth || 420;
    _tipH = tip.offsetHeight || 160;
  }
  _applyTipPosition(e.clientX, e.clientY);
}
function moveTip(e) {
  if (!tip) return;
  _pendingTipX = e.clientX;
  _pendingTipY = e.clientY;
  if (_tipRaf) return;
  _tipRaf = requestAnimationFrame(() => {
    _tipRaf = 0;
    _applyTipPosition(_pendingTipX, _pendingTipY);
  });
}
function hideTip() {
  if (_tipRaf) {
    cancelAnimationFrame(_tipRaf);
    _tipRaf = 0;
  }
  if (tip) tip.style.display = 'none';
}

export function updateAnnPanelNav(ann = S.selAnn) {
  const prevBtn = document.getElementById('ap-prev-hi');
  const nextBtn = document.getElementById('ap-next-hi');
  const posEl = document.getElementById('ap-nav-pos');
  if (!prevBtn && !nextBtn && !posEl) return;

  const ordered = getReadingOrderAnnotations(S.annotations);
  const total = ordered.length;
  const idx = ann ? ordered.findIndex(a => String(a.id) === String(ann.id)) : -1;

  if (posEl) {
    if (total === 0) posEl.textContent = '0 / 0';
    else if (idx === -1) posEl.textContent = `— / ${total}`;
    else posEl.textContent = `${idx + 1} / ${total}`;
  }
  if (prevBtn) prevBtn.disabled = idx <= 0;
  if (nextBtn) nextBtn.disabled = idx === -1 || idx >= total - 1;
}

export async function navigateAnnPanel(delta) {
  const ordered = getReadingOrderAnnotations(S.annotations);
  if (!ordered.length) return null;
  const curIdx = S.selAnn ? ordered.findIndex(a => String(a.id) === String(S.selAnn.id)) : -1;
  const nextIdx = curIdx === -1 ? (delta >= 0 ? 0 : ordered.length - 1) : curIdx + (delta >= 0 ? 1 : -1);
  if (nextIdx < 0 || nextIdx >= ordered.length) return null;

  const target = ordered[nextIdx];
  openAnnPanel(target);

  if (S.curPage !== target.page) {
    await jumpToPage(target.page, false);
  }
  if (!S.pages?.[target.page]?.rendered) {
    const { ensurePageRendered } = await import('./viewer.js');
    await ensurePageRendered(target.page);
  }
  if (String(S.selAnn?.id) !== String(target.id)) return target;

  const grp = document.querySelector(`.hi-grp[data-id="${_escAttrVal(target.id)}"]`);
  if (grp) {
    document.querySelectorAll('.hi-grp.selected').forEach(g => {
      if (g !== grp) g.classList.remove('selected');
    });
    grp.classList.add('selected');
    (grp.querySelector('.hr') || grp).scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }
  return target;
}

// ── Annotation Panel ──
export function openAnnPanel(ann) {
  S.selAnn = ann;
  const notes = Array.isArray(ann.notes) ? ann.notes : [];
  const genCount = notes.filter(n => getNoteType(n) === 'general').length;
  const caseCount = notes.filter(n => getNoteType(n) === 'case').length;
  activeNoteTab = (genCount === 0 && caseCount > 0) ? 'case' : 'general';
  document.querySelectorAll('.ap-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.aptab === activeNoteTab);
  });
  document.querySelectorAll('.hi-grp.selected').forEach(g => g.classList.remove('selected'));
  document.querySelector(`.hi-grp[data-id="${_escAttrVal(ann.id)}"]`)?.classList.add('selected');
  const exEl = document.getElementById('ap-ex');
  if (exEl) {
    const txt = ann.highlighted_text || '';
    exEl.textContent = txt.length > 90 ? txt.slice(0, 90) + '…' : txt;
  }
  updateAnnPanelNav(ann);
  renderAnnColors();
  renderAnnPanelTagsSection(ann);
  renderNotes(ann);
  const ed = document.getElementById('note-editor');
  if (ed) ed.innerHTML = '';
  closeOtherPanels('ann-panel');
  document.getElementById('ann-panel')?.classList.add('open');
}

export function closeAnnPanel() {
  document.getElementById('ann-panel')?.classList.remove('open');
  document.querySelectorAll('.hi-grp.selected').forEach(g => g.classList.remove('selected'));
  S.selAnn = null;
}

/**
 * Update an annotation's highlight color across memory, local cache, PDF overlay,
 * open annotation panel, Highlights tab, and cloud DB.
 */
export async function updateAnnotationColor(ann, nextHex) {
  if (!ann) return;
  const norm = normalizeHexColor(nextHex) || nextHex;
  if (!norm) return;
  autosave('saving');
  try {
    ann.hex_color = norm;
    const inList = Array.isArray(S.annotations) ? S.annotations.find(a => a.id === ann.id) : null;
    if (inList && inList !== ann) inList.hex_color = norm;
    invalidateAnnotationPageIndex();

    const trueId = ann.pdf_file_id || S.curPDF?.linked_pdf_id || S.curPDF?.id;
    if (trueId) {
      scheduleDebouncedLocalAnnsSave(trueId, () => S.annotations);
    }

    drawAnnotation(ann);
    if (S.selAnn?.id === ann.id) {
      S.selAnn.hex_color = norm;
      document.querySelector(`.hi-grp[data-id="${_escAttrVal(ann.id)}"]`)?.classList.add('selected');
      renderAnnColors();
    }
    _notifyAnnotationsChanged();
    await dbUpdateAnnColor(ann.id, norm);
    autosave('saved');
    toast('Color updated');
  } catch (e) {
    console.error(e);
    autosave('err');
  }
}

/**
 * Delete an annotation from memory, overlay, tags, panel, and cloud DB.
 */
export async function deleteAnnotation(targetAnn) {
  if (!targetAnn) return;
  if (_hoveredAnnId === String(targetAnn.id)) _clearHoverState();
  hideTip();
  autosave('saving');
  try {
    S.annotations = S.annotations.filter(x => x.id !== targetAnn.id);
    invalidateAnnotationPageIndex();
    const trueId = targetAnn.pdf_file_id || S.curPDF?.linked_pdf_id || S.curPDF?.id;
    if (trueId) {
      S.annCounts[trueId] = Math.max(0, (S.annCounts[trueId] || 1) - 1);
      updateAnnBadge(trueId);
      scheduleDebouncedLocalAnnsSave(trueId, () => S.annotations);
    }
    clearAnnMark(targetAnn.id);
    if (S.selAnn?.id === targetAnn.id) closeAnnPanel();
    else if (S.selAnn && document.getElementById('ann-panel')?.classList.contains('open')) {
      updateAnnPanelNav(S.selAnn);
    }
    onAnnDeleted(targetAnn.id);
    _notifyAnnotationsChanged();
    await dbDelAnnotation(targetAnn.id);
    autosave('saved');
    toast('Highlight deleted');
  } catch (e) {
    console.error(e);
    autosave('err');
  }
}

let _annCtxHandlersBound = false;

/** Close the highlight right-click context menu if open. */
export function closeAnnContextMenu() {
  const menu = document.getElementById('ann-ctx-menu');
  if (!menu) return;
  menu.classList.remove('open', 'show');
}

function _ensureAnnCtxCloseHandlers() {
  if (_annCtxHandlersBound) return;
  _annCtxHandlersBound = true;
  document.addEventListener('pointerdown', (ev) => {
    if (!ev.target?.closest?.('#ann-ctx-menu')) closeAnnContextMenu();
  }, true);
  document.addEventListener('contextmenu', (ev) => {
    if (!ev.target?.closest?.('#ann-ctx-menu')) closeAnnContextMenu();
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeAnnContextMenu();
  });
  window.addEventListener('scroll', (ev) => {
    const menu = document.getElementById('ann-ctx-menu');
    if (!menu || (!menu.classList.contains('open') && !menu.classList.contains('show'))) return;
    if (ev.target === menu || menu.contains(ev.target)) return;
    closeAnnContextMenu();
  }, { capture: true, passive: true });
  window.addEventListener('resize', closeAnnContextMenu);
  window.addEventListener('blur', closeAnnContextMenu);
}

/**
 * Open the highlight right-click context menu for changing color, opening notes,
 * or deleting the annotation.
 */
export function openAnnContextMenu(e, ann) {
  if (!e || !ann) return;
  if (e.target?.closest?.('#canvas-scroll-b')) return;
  e.preventDefault();
  e.stopPropagation();
  hideTip();

  document.querySelectorAll('.ctx-menu').forEach(m => {
    if (m.id === 'ann-ctx-menu') return;
    m.classList.remove('open', 'show');
    if (m.id === 'subj-ctx-menu' || m.id === 'folder-ctx-menu' || m.id === 'multi-folder-ctx-menu') {
      m.hidden = true;
    }
    if (m.id === 'table-ctx-menu') {
      m.style.display = 'none';
    }
  });

  const menu = document.getElementById('ann-ctx-menu');
  if (!menu) return;
  _ensureAnnCtxCloseHandlers();
  menu.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'ctx-menu__label';
  header.textContent = 'Change color';
  menu.appendChild(header);

  const currentNorm = normalizeHexColor(ann.hex_color);
  for (const cat of S.colorCats || []) {
    const catNorm = normalizeHexColor(cat.hex_color) || cat.hex_color;
    const isActive = Boolean(currentNorm && normalizeHexColor(catNorm) === currentNorm);

    const item = document.createElement('div');
    item.className = 'ctx-item ctx-item--color' + (isActive ? ' ctx-item--active' : '');
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(isActive));

    const dot = document.createElement('span');
    dot.className = 'ctx-color-dot';
    dot.style.background = catNorm;
    dot.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'ctx-item__name';
    name.textContent = cat.name || catNorm;

    item.append(dot, name);
    if (isActive) {
      const chk = document.createElement('span');
      chk.className = 'ctx-item__check';
      chk.textContent = '✓';
      chk.setAttribute('aria-hidden', 'true');
      item.appendChild(chk);
    }

    item.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeAnnContextMenu();
      updateAnnotationColor(ann, catNorm);
    });
    menu.appendChild(item);
  }

  const sep = document.createElement('div');
  sep.className = 'ctx-sep';
  menu.appendChild(sep);

  const openItem = document.createElement('div');
  openItem.className = 'ctx-item';
  openItem.setAttribute('role', 'menuitem');
  openItem.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-note"/></svg><span>Open notes</span>';
  openItem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeAnnContextMenu();
    openAnnPanel(ann);
  });
  menu.appendChild(openItem);

  const delItem = document.createElement('div');
  delItem.className = 'ctx-item ctx-item--danger';
  delItem.setAttribute('role', 'menuitem');
  delItem.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg><span>Delete highlight</span>';
  delItem.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeAnnContextMenu();
    deleteAnnotation(ann);
  });
  menu.appendChild(delItem);

  menu.hidden = false;
  menu.style.left = '-9999px';
  menu.style.top = '-9999px';
  menu.classList.add('open');

  const pad = 6;
  const mw = menu.offsetWidth || 210;
  const mh = menu.offsetHeight || 240;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = e.clientX;
  let top = e.clientY;
  if (left + mw + pad > vw) left = Math.max(pad, e.clientX - mw);
  if (top + mh + pad > vh) top = Math.max(pad, e.clientY - mh);
  left = Math.max(pad, Math.min(left, Math.max(pad, vw - mw - pad)));
  top = Math.max(pad, Math.min(top, Math.max(pad, vh - mh - pad)));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function renderAnnColors() {
  const c = document.getElementById('ap-colors');
  if (!c) return;
  const manageBtn = c.querySelector('#btn-panel-manage-colors');
  if (manageBtn && manageBtn.parentNode === c) manageBtn.remove();

  const selInfo = getColorCategoryForHex(S.selAnn?.hex_color);
  const selNorm = selInfo.hex_color;

  c.innerHTML = '';
  const lbl = document.createElement('div');
  lbl.className = 'ap-colors-lbl';
  lbl.textContent = S.selAnn ? `Highlight Color — ${selInfo.name}` : 'Highlight Color';
  c.appendChild(lbl);

  for (const cat of S.colorCats || []) {
    const norm = normalizeHexColor(cat.hex_color) || cat.hex_color;
    const d = document.createElement('div');
    d.className = 'apc-dot' + (selNorm && normalizeHexColor(norm) === selNorm ? ' sel' : '');
    if (norm) d.dataset.color = norm;
    d.style.background = norm;
    d.title = cat.name;
    d.setAttribute('aria-label', cat.name);
    d.addEventListener('click', () => {
      if (S.selAnn) updateAnnotationColor(S.selAnn, norm);
    });
    c.appendChild(d);
  }

  if (S.selAnn && selInfo.isLegacy && selNorm) {
    const legacyDot = document.createElement('div');
    legacyDot.className = 'apc-dot sel apc-legacy';
    legacyDot.dataset.color = selNorm;
    legacyDot.style.background = selNorm;
    legacyDot.title = selInfo.name;
    legacyDot.setAttribute('aria-label', selInfo.name);
    c.appendChild(legacyDot);
  }

  if (manageBtn) c.appendChild(manageBtn);
}

function updateTabBadges(ann) {
  if (!ann) return;
  const genCount = ann.notes.filter(n => getNoteType(n) === 'general').length;
  const caseCount = ann.notes.filter(n => getNoteType(n) === 'case').length;
  const bgGen = document.getElementById('badge-general');
  const bgCase = document.getElementById('badge-case');
  if (bgGen) bgGen.textContent = genCount;
  if (bgCase) bgCase.textContent = caseCount;
}

function updateEditorState() {
  const ed = document.getElementById('note-editor');
  const addBtn = document.getElementById('btn-add-note');
  if (activeNoteTab === 'case') {
    if (ed) ed.setAttribute('data-ph', 'Case Title / G.R. No. (e.g. Laurel v. Garcia), Ruling, Ratio…');
    if (addBtn) addBtn.textContent = 'Add Case Summary';
  } else {
    if (ed) ed.setAttribute('data-ph', 'Add a note, doctrine, citation…');
    if (addBtn) addBtn.textContent = 'Add Note';
  }
}

function renderNotes(ann) {
  if (!ann) return;
  const list = document.getElementById('ann-notes');
  if (!list) return;
  list.innerHTML = '';
  updateTabBadges(ann);
  updateEditorState();

  const filtered = ann.notes.filter(n => getNoteType(n) === activeNoteTab);

  if (!filtered.length) {
    const emptyMsg = activeNoteTab === 'case'
      ? 'No case summaries yet — add a case digest or ruling below.'
      : 'No notes yet — add one below.';
    list.innerHTML = `<div class="note-empty">${emptyMsg}</div>`;
    return;
  }

  const catInfo = getColorCategoryForHex(ann.hex_color);
  const annColor = catInfo.hex_color || normalizeHexColor(ann.hex_color) || ann.hex_color || '#c9a84c';
  const rawHighlight = String(ann.highlighted_text || '').replace(/\s+/g, ' ').trim();
  const excerpt = rawHighlight.length > 140 ? rawHighlight.slice(0, 137).trimEnd() + '…' : rawHighlight;

  filtered.forEach((note, i) => {
    const card = document.createElement('div');
    const isCase = activeNoteTab === 'case';
    card.className = 'note-card' + (isCase ? ' case-card' : '');
    const cleanBody = getNoteBody(note);
    const hasTable = /<table[\s>]/i.test(cleanBody);

    card.innerHTML = `
      <div class="note-card-header note-card__head">
        <span class="note-card__meta">
          <span class="note-card__swatch" style="background:${_escHtml(annColor)}" aria-hidden="true"></span>
          <span class="note-num">${isCase ? `<svg class="icon" style="width:12px;height:12px;vertical-align:-2px;margin-right:4px" aria-hidden="true"><use href="#i-scale"/></svg>` : ''}Page ${_escHtml(ann.page || '?')} · #${i + 1}</span>
        </span>
        <span class="note-card__ink">${_escHtml(catInfo.name || 'Highlight')}</span>
        <div class="note-actions">
          ${hasTable ? `<button class="note-act-btn copy-tbl-btn" title="Copy 1st summary table preserving formatting (ignores untabled text below)"><svg class="icon" style="width:12px;height:12px;vertical-align:-2px;margin-right:4px" aria-hidden="true"><use href="#i-copy"/></svg>Copy Summary Table</button>` : ''}
          <button class="note-act-btn edit-btn" title="Edit Note"><svg class="icon" style="width:12px;height:12px;vertical-align:-2px;margin-right:3px" aria-hidden="true"><use href="#i-pen"/></svg>Edit</button>
          <button class="note-act-btn del" title="Delete Note"><svg class="icon" style="width:12px;height:12px;vertical-align:-2px;margin-right:3px" aria-hidden="true"><use href="#i-trash"/></svg>Delete</button>
        </div>
      </div>
      ${i === 0 && excerpt ? `<blockquote class="note-card__quote">“${_escHtml(excerpt)}”</blockquote>` : ''}
      <div class="note-body">${cleanBody}</div>
    `;
    
    // Intercept PDF links
    card.querySelectorAll('[data-pdf-link]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const pdfId = link.getAttribute('data-pdf-link');
        const pdf = S.pdfs.find(p => p.id === pdfId);
        if (pdf) {
          import('./viewer.js').then(m => m.openPDFFromLibrary(pdf));
        } else {
          import('./ui.js').then(m => m.toast('PDF not found or deleted'));
        }
      });
    });

    card.querySelector('.note-act-btn.copy-tbl-btn')?.addEventListener('click', () => {
      copyFirstSummaryTable(card.querySelector('.note-body'));
    });

    card.querySelector('.note-act-btn.edit-btn').addEventListener('click', () => {
      S.editingNoteId = note.id;
      const modalTitle = document.getElementById('mo-edit-note-title');
      if (modalTitle) modalTitle.textContent = isCase ? 'Edit Case Summary' : 'Edit Note';
      document.getElementById('edit-note-ed').innerHTML = cleanBody;
      import('./ui.js').then(m => m.openModal('mo-edit-note'));
    });

    card.querySelector('.note-act-btn.del').addEventListener('click', async () => {
      autosave('saving');
      try {
        ann.notes = ann.notes.filter(n => n.id !== note.id);
        invalidateAnnotationPageIndex();
        const trueId = ann.pdf_file_id;
        if (trueId) {
          scheduleDebouncedLocalAnnsSave(trueId, () => S.annotations);
        }
        renderNotes(ann);
        _notifyAnnotationsChanged();
        await dbDelNote(note.id);
        autosave('saved');
        import('./ui.js').then(m => m.toast(isCase ? 'Case summary deleted' : 'Note deleted'));
      } catch (e) {
        console.error(e);
        autosave('err');
      }
    });

    list.appendChild(card);
  });
}

let _annNavKeysBound = false;

// ── Wire annotation panel buttons ──
export function initAnnPanel() {
  initTagsPanel();
  document.getElementById('ap-close').addEventListener('click', closeAnnPanel);
  document.getElementById('ap-prev-hi')?.addEventListener('click', () => navigateAnnPanel(-1));
  document.getElementById('ap-next-hi')?.addEventListener('click', () => navigateAnnPanel(1));

  if (!_annNavKeysBound) {
    _annNavKeysBound = true;
    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const panel = document.getElementById('ann-panel');
      if (!panel || !panel.classList.contains('open')) return;
      const active = document.activeElement;
      const tag = active?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active?.isContentEditable || active?.contentEditable === 'true') {
        return;
      }
      e.preventDefault();
      navigateAnnPanel(e.key === 'ArrowLeft' ? -1 : 1);
    });
  }

  // Tab switching
  document.querySelectorAll('.ap-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeNoteTab = btn.dataset.aptab;
      document.querySelectorAll('.ap-tab').forEach(b => b.classList.toggle('active', b === btn));
      if (S.selAnn) renderNotes(S.selAnn);
      else updateEditorState();
    });
  });

  document.getElementById('btn-del-hi').addEventListener('click', () => {
    if (S.selAnn) deleteAnnotation(S.selAnn);
  });

  // Add note / Case summary — with empty-editor shake (fixes bug #5)
  document.getElementById('btn-add-note').addEventListener('click', async () => {
    const ed = document.getElementById('note-editor');
    const rawHtml = ed.innerHTML.trim();
    const targetAnn = S.selAnn;
    if (!rawHtml || rawHtml === '<br>' || !targetAnn) {
      ed.classList.remove('shake');
      void ed.offsetWidth; // reflow to restart animation
      ed.classList.add('shake');
      return;
    }
    const savedTab = activeNoteTab;
    const htmlToSave = wrapNoteHtml(rawHtml, savedTab);
    autosave('saving');
    try {
      const note = await dbCreateNote(targetAnn.id, htmlToSave, targetAnn.notes.length);
      targetAnn.notes.push(note);
      invalidateAnnotationPageIndex();
      const trueId = targetAnn.pdf_file_id;
      if (trueId) {
        scheduleDebouncedLocalAnnsSave(trueId, () => S.annotations);
      }
      ed.innerHTML = '';
      if (S.selAnn?.id === targetAnn.id) renderNotes(targetAnn);
      _notifyAnnotationsChanged();
      autosave('saved');
      toast(savedTab === 'case' ? 'Case summary added' : 'Note added');
    } catch (e) {
      console.error(e);
      autosave('err');
    }
  });

  // Save edited note / Case summary
  document.getElementById('save-edit-note').addEventListener('click', async () => {
    const rawHtml = document.getElementById('edit-note-ed').innerHTML.trim();
    if (!rawHtml) return;
    let targetAnn = S.selAnn;
    let note = targetAnn?.notes.find(n => n.id === S.editingNoteId);
    if (!note && S.editingNoteId) {
      for (const a of (S.annotations || [])) {
        const found = a.notes?.find(n => n.id === S.editingNoteId);
        if (found) { targetAnn = a; note = found; break; }
      }
    }
    const noteType = getNoteType(note);
    const htmlToSave = wrapNoteHtml(rawHtml, noteType);
    autosave('saving');
    try {
      if (note) {
        note.note_html = htmlToSave;
        invalidateAnnotationPageIndex();
        const trueId = targetAnn?.pdf_file_id;
        if (trueId) {
          scheduleDebouncedLocalAnnsSave(trueId, () => S.annotations);
        }
        if (S.selAnn?.id === targetAnn?.id) renderNotes(targetAnn);
        _notifyAnnotationsChanged();
      }
      closeModal('mo-edit-note');
      await dbUpdateNote(S.editingNoteId, htmlToSave);
      autosave('saved');
      toast(noteType === 'case' ? 'Case summary updated' : 'Note updated');
    } catch (e) {
      console.error(e);
      autosave('err');
    }
  });

  // Format buttons (add-note editor)
  document.querySelectorAll('#add-note-area .fmt-btn').forEach(b => {
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => {
      const ed = document.getElementById('note-editor');
      if (!ed) return;

      const cmd = b.dataset.cmd;
      let val = b.dataset.val || null;
      if (cmd === 'formatBlock' && val && !val.startsWith('<')) {
        val = `<${val}>`;
      }

      if (cmd === 'insertTable') {
        showTablePicker(b, ed);
      } else if (cmd === 'insertBanner') {
        insertBannerHeader(ed);
      } else if (cmd === 'grayOut') {
        toggleGrayOut(ed);
      } else if (cmd === 'outdent') {
        outdentLine(ed);
      } else if (cmd === 'indent') {
        indentLine(ed);
      } else if (b.id === 'btn-add-pdflink') {
        openPdfLinkModal(ed);
      } else if (b.id === 'btn-add-weblink') {
        insertWebLink(ed);
      } else if (cmd) {
        ed.focus();
        document.execCommand(cmd, false, val);
      }
    });
  });

  // Format buttons (edit-note editor)
  document.querySelectorAll('#mo-edit-note .fmt-btn').forEach(b => {
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => {
      const ed = document.getElementById('edit-note-ed');
      if (!ed) return;

      const cmd = b.dataset.cmd2;
      let val = b.dataset.val2 || null;
      if (cmd === 'formatBlock' && val && !val.startsWith('<')) {
        val = `<${val}>`;
      }

      if (cmd === 'insertTable') {
        showTablePicker(b, ed);
      } else if (cmd === 'insertBanner') {
        insertBannerHeader(ed);
      } else if (cmd === 'grayOut') {
        toggleGrayOut(ed);
      } else if (cmd === 'outdent') {
        outdentLine(ed);
      } else if (cmd === 'indent') {
        indentLine(ed);
      } else if (b.id === 'btn-edit-copy-table') {
        copyFirstSummaryTable(ed);
      } else if (b.id === 'btn-edit-pdflink') {
        openPdfLinkModal(ed);
      } else if (b.id === 'btn-edit-weblink') {
        insertWebLink(ed);
      } else if (cmd) {
        ed.focus();
        document.execCommand(cmd, false, val);
      }
    });
  });

  // Attach sanitized paste & copy handling to note editors
  document.getElementById('note-editor')?.addEventListener('paste', handlePaste);
  document.getElementById('note-editor')?.addEventListener('copy', handleCopy);
  document.getElementById('edit-note-ed')?.addEventListener('paste', handlePaste);
  document.getElementById('edit-note-ed')?.addEventListener('copy', handleCopy);
  document.getElementById('ann-notes')?.addEventListener('copy', handleCopy);

  document.getElementById('edit-note-ed')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      document.getElementById('save-edit-note')?.click();
      return;
    }
    handleEditorKeyDown(e, document.getElementById('edit-note-ed'));
  });

  // Selection confirm/cancel (works for both PDF text and folder/notepad editors)
  document.getElementById('sel-confirm').addEventListener('mousedown', e => e.preventDefault());
  document.getElementById('sel-confirm').addEventListener('click', () => {
    if (S.pendingEditorSel) {
      const { editor, range } = S.pendingEditorSel;
      document.getElementById('sel-menu').classList.remove('open');
      applyEditorHighlight(editor, range, normalizeHexColor(S.activeColor) || S.activeColor || '#c9a84c');
      S.pendingEditorSel = null;
      window.getSelection()?.removeAllRanges();
      updateSelMenuMassTagButton([]);
      return;
    }
    if (!S.pendingSel) return;
    window.getSelection()?.removeAllRanges();
    document.getElementById('sel-menu').classList.remove('open');
    if (S.pendingSel.multiPage || !S.pendingSel.rects?.length) {
      S.pendingSel = null;
      updateSelMenuMassTagButton([]);
      return;
    }
    createAnnotation(S.pendingSel.pageNum, S.pendingSel.rects, S.pendingSel.text, 'text');
    S.pendingSel = null;
    updateSelMenuMassTagButton([]);
  });
  document.getElementById('sel-cancel').addEventListener('click', () => {
    window.getSelection()?.removeAllRanges();
    document.getElementById('sel-menu').classList.remove('open');
    S.pendingSel = null;
    S.pendingEditorSel = null;
    updateSelMenuMassTagButton([]);
  });

  // Auto-close selection menu when clicking outside
  document.addEventListener('mousedown', e => {
    const selMenu = document.getElementById('sel-menu');
    if ((S.pendingSel || S.pendingEditorSel) && selMenu.classList.contains('open')) {
      if (e.target?.closest?.('#mass-tag-popover')) return;
      if (!selMenu.contains(e.target)) {
        selMenu.classList.remove('open');
        S.pendingSel = null;
        S.pendingEditorSel = null;
        updateSelMenuMassTagButton([]);
      }
    }
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('la:color-cats-changed', () => {
      _tooltipHtmlCache.clear();
      if (S.selAnn && document.getElementById('ann-panel')?.classList.contains('open')) {
        renderAnnColors();
      }
    });
  }

  initAnnPanelResizer();
}

function initAnnPanelResizer() {
  const panel = document.getElementById('ann-panel');
  const handle = document.getElementById('ap-resize-handle');
  if (!handle || !panel) return;

  // Restore saved width from localStorage
  const savedWidth = safeStorageGet('ann_panel_width');
  if (savedWidth) {
    const w = parseInt(savedWidth);
    if (w >= 260 && w <= window.innerWidth * 0.85) {
      panel.style.width = w + 'px';
    }
  }

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('resizing');
    panel.style.transition = 'none'; // disable CSS transition while dragging for instant responsiveness
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  });

  handle.addEventListener('pointermove', (e) => {
    if (!isResizing) return;
    const deltaX = startX - e.clientX; // dragging left increases width
    const minW = 260;
    const maxW = Math.floor(window.innerWidth * 0.85);
    const newWidth = Math.max(minW, Math.min(maxW, startWidth + deltaX));
    panel.style.width = newWidth + 'px';
  });

  const stopResize = (e) => {
    if (!isResizing) return;
    isResizing = false;
    handle.classList.remove('resizing');
    panel.style.transition = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {}
    safeStorageSet('ann_panel_width', panel.offsetWidth);
  };

  handle.addEventListener('pointerup', stopResize);
  handle.addEventListener('pointercancel', stopResize);
}
