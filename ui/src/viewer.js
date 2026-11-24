// ═══════════════════════════════════════════════
// VIEWER — PDF rendering + page management
// ═══════════════════════════════════════════════
import { S, isPdfArchived } from './state.js';
import { syncOK, syncSpin, jumpToPage, setIsJumping, isUserScrolling, onScrollIdle, invalidatePageOffsetCache } from './ui.js';
import { dbLoadAnnotations, dbLoadDrawings, dbLoadBookmarks, dbGetSetting } from './db.js';
import { driveFetchPDF } from './drive.js';
import { renderColorDots } from './colors.js';
import { showTablePicker, handlePaste, handleCopy, insertBannerHeader, toggleGrayOut, handleEditorKeyDown, outdentLine, indentLine, buildHighlightDropdown, copyFirstSummaryTable } from './tablepicker.js';
import { openPdfLinkModal, insertWebLink } from './pdflink.js';
import { safeStorageGet, safeStorageSet, flushDebouncedStorageWrites } from './storage.js';
import { notifyTabOpened, notifyTabClosedToHome, renderStudyDesk } from './goodnotes-ui.js';
import { setupDrawListeners, renderCanvas } from './draw.js';
import { hasOcrData, applyOcrToRenderedPage } from './ocr.js';

// Guard set to prevent double listener registration (fixes bug #3)
const _boxDone  = new Set();
const _drawDone = new Set();
const _textDone = new Set();

// Shared offscreen canvas for fast text-width calibration (matches PDF.js TextLayer)
let _txtMeasureCtx = null;
function getMeasureCtx() {
  if (!_txtMeasureCtx) {
    const c = document.createElement('canvas');
    _txtMeasureCtx = c.getContext('2d');
  }
  return _txtMeasureCtx;
}

function resolvePdfFontFamily(tcStyles, fontName) {
  const raw = (tcStyles && fontName && tcStyles[fontName]?.fontFamily) || '';
  const lower = raw.toLowerCase();
  if (lower.includes('monospace') || lower.includes('courier')) return 'monospace';
  if (lower.includes('serif') && !lower.includes('sans')) return 'serif';
  return 'sans-serif';
}

function computeSpanScaleX(str, fh, fontFam, targetWidthPx) {
  if (!str || !str.trim() || !(targetWidthPx > 0) || !(fh > 0)) return 1;
  const ctx = getMeasureCtx();
  if (!ctx) return 1;
  ctx.font = `${fh}px ${fontFam}`;
  const naturalW = ctx.measureText(str).width;
  if (!(naturalW > 0)) return 1;
  const ratio = targetWidthPx / naturalW;
  if (!Number.isFinite(ratio) || ratio < 0.35 || ratio > 3.5) return 1;
  return Math.round(ratio * 10000) / 10000;
}

function buildSpanTransform(angle, scaleX) {
  const hasAngle = angle && Math.abs(angle) > 1e-4;
  const hasScale = scaleX && Math.abs(scaleX - 1) > 1e-3;
  if (hasAngle && hasScale) return `rotate(${angle}rad) scaleX(${scaleX})`;
  if (hasAngle) return `rotate(${angle}rad)`;
  if (hasScale) return `scaleX(${scaleX})`;
  return '';
}

let _currentFolderDocId = null;
let _folderDocDebounce = null;

export async function flushFolderDoc() {
  if (_currentFolderDocId) {
    const ed = document.getElementById('folder-doc-editor');
    const wasDebouncing = !!_folderDocDebounce;
    if (_folderDocDebounce) {
      clearTimeout(_folderDocDebounce);
      _folderDocDebounce = null;
    }
    if (ed && wasDebouncing) {
      const text = ed.innerHTML;
      const prevId = _currentFolderDocId;
      const f = S.folders.find(x => x.id === prevId);
      if (f) f.notes = text;
      safeStorageSet('local_folder_notes_' + prevId, text);
      
      try {
        const { dbUpdateFolderNotes } = await import('./db.js');
        await dbUpdateFolderNotes(prevId, text);
        const { autosave } = await import('./ui.js');
        autosave('saved');
      } catch {
        const { autosave } = await import('./ui.js');
        autosave('err');
      }
    }
  }
}

export async function openFolderDoc(fold) {
  // Capture #welcome template if still present
  getWelcomeHTML();
  // 1. Flush any pending notes from previously open folder and active PDF notepad first!
  await flushFolderDoc();
  try {
    const { flushNotepadSave, notepadOnPDFChange } = await import('./notepad.js');
    await flushNotepadSave();
    await notepadOnPDFChange(null);
  } catch {}

  S.curPDF = null;
  updateActivePDF();
  
  const { closeAnnPanel } = await import('./annotate.js');
  closeAnnPanel();
  const { clearSearchHighlights } = await import('./search.js');
  clearSearchHighlights();

  // 2. Look up fresh live folder from state
  const liveFold = S.folders.find(f => f.id === fold.id) || fold;
  notifyTabOpened(liveFold, 'folder');

  // Switch to Folder Document Mode
  document.getElementById('content-area').style.display = 'none';
  document.getElementById('folder-doc-viewer').style.display = 'flex';
  const { closeOtherPanels } = await import('./ui.js');
  closeOtherPanels();

  document.getElementById('folder-doc-title').textContent = liveFold.name;
  const cbInfo = document.getElementById('casebar-info');
  const cbTitle = document.getElementById('casebar-title');
  const cbMeta = document.getElementById('casebar-meta');
  const subj = (S.subjects || []).find(s => s.id === liveFold.subject_id);
  if (cbInfo && cbTitle && cbMeta) {
    cbTitle.textContent = liveFold.name || 'Folder Notes';
    cbMeta.textContent = `${subj?.name ? subj.name + ' · ' : ''}Folder Notes`;
    cbInfo.hidden = false;
  }
  const ed = document.getElementById('folder-doc-editor');
  const localNotes = safeStorageGet('local_folder_notes_' + liveFold.id, '') || '';
  const initialNotes = liveFold.notes || localNotes || '';
  if (initialNotes && !liveFold.notes) liveFold.notes = initialNotes;
  ed.innerHTML = initialNotes;
  _currentFolderDocId = liveFold.id;

  // Add listener only once
  if (!ed.dataset.listener) {
    ed.dataset.listener = 'true';
    
    ed.addEventListener('keydown', (e) => {
      handleEditorKeyDown(e, ed);
    });

    ed.addEventListener('input', async () => {
      const { autosave } = await import('./ui.js');
      autosave('saving');

      // Update in-memory state and localStorage immediately so folder switching never loses keystrokes
      const currentId = _currentFolderDocId;
      const currentText = ed.innerHTML;
      const f = S.folders.find(x => x.id === currentId);
      if (f) f.notes = currentText;
      if (currentId) safeStorageSet('local_folder_notes_' + currentId, currentText);

      clearTimeout(_folderDocDebounce);
      _folderDocDebounce = setTimeout(async () => {
        _folderDocDebounce = null;
        if (!currentId) {
          autosave('saved');
          return;
        }
        const { dbUpdateFolderNotes } = await import('./db.js');
        try {
          await dbUpdateFolderNotes(currentId, currentText);
          autosave('saved');
        } catch {
          autosave('err');
        }
      }, 800);
    });

    ed.addEventListener('paste', handlePaste);
    ed.addEventListener('copy', handleCopy);

    // Floating highlight menu on text selection (identical to PDF reader highlight popup)
    const onSelect = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
      const text = sel.toString().trim();
      const range = sel.getRangeAt(0);
      if (!ed.contains(range.commonAncestorContainer)) return;

      const rects = range.getClientRects();
      if (!rects.length) return;
      const last = rects[rects.length - 1];

      S.pendingEditorSel = { editor: ed, range: range.cloneRange(), text };
      S.pendingSel = null;

      const confirmBtn = document.getElementById('sel-confirm');
      if (confirmBtn) confirmBtn.style.display = '';
      import('./tags.js').then(m => m.updateSelMenuMassTagButton?.([])).catch(() => {});

      const m = document.getElementById('sel-menu');
      if (m) {
        const mx = Math.min(Math.max(10, last.right), window.innerWidth - 170);
        const my = Math.min(last.bottom + 6, window.innerHeight - 60);
        m.style.left = mx + 'px';
        m.style.top  = my + 'px';
        m.classList.add('open');
      }
    };

    ed.addEventListener('mouseup', onSelect);
    ed.addEventListener('touchend', () => setTimeout(onSelect, 60));
    ed.addEventListener('keyup', (e) => {
      if (e.shiftKey) onSelect();
    });

    // Bind toolbar commands
    document.getElementById('folder-doc-toolbar').addEventListener('mousedown', e => e.preventDefault());
    document.getElementById('folder-doc-toolbar').addEventListener('click', (e) => {
      const btn = e.target.closest('.folder-fmt-btn');
      if (!btn) return;
      
      e.stopPropagation();

      if (btn.id === 'folder-copy-summary-table') {
        copyFirstSummaryTable(ed);
        return;
      }
      if (btn.id === 'folder-doc-link-pdf') {
        openPdfLinkModal(ed, () => ed.dispatchEvent(new Event('input')));
        return;
      }
      if (btn.id === 'folder-doc-link-url') {
        insertWebLink(ed, () => ed.dispatchEvent(new Event('input')));
        return;
      }
      if (btn.id === 'folder-doc-highlight') {
        buildHighlightDropdown(btn, ed);
        return;
      }


      const cmd = btn.dataset.cmd;
      let val = btn.dataset.val || null;
      
      // Some browsers require tags to be wrapped in brackets for formatBlock
      if (cmd === 'formatBlock' && val && !val.startsWith('<')) {
        val = `<${val}>`;
      }
      
      try {
        if (cmd === 'insertTable') {
          showTablePicker(btn, ed);
        } else if (cmd === 'insertBanner') {
          insertBannerHeader(ed);
        } else if (cmd === 'grayOut') {
          toggleGrayOut(ed);
        } else if (cmd === 'outdent') {
          outdentLine(ed);
        } else if (cmd === 'indent') {
          indentLine(ed);
        } else if (cmd) {
          document.execCommand(cmd, false, val);
        }
      } catch (err) {
        console.error('execCommand failed:', err);
      } finally {
        ed.focus();
      }
    });
  }
}

// ── Virtualized Page Rendering Observer & Memory-Managed Document Renderer ──
let _pageObserver = null;
let _renderedPages = new Set();
let _renderingPages = new Set();
let _activeRenderTasks = new Map(); // pageNum -> PDF.js RenderTask
let _visibleQueue = new Set();      // pageNums currently intersecting observer
let _queueDrainScheduled = false;
let _bgRenderGen = 0;
let _renderScaleGen = 0;
let _activeZoomAnchor = null;
let _activeBlobUrl = null; // kept alive for the full PDF session; revoked on next PDF open

const MAX_SCROLL_CONCURRENT_RENDERS = 3;

function _cancelRenderTask(pageNum) {
  const task = _activeRenderTasks.get(pageNum);
  if (task) {
    _activeRenderTasks.delete(pageNum);
    try { task.cancel(); } catch {}
  }
}

function _cancelAllRenderTasks() {
  for (const [, task] of _activeRenderTasks) {
    try { task.cancel(); } catch {}
  }
  _activeRenderTasks.clear();
  _renderingPages.clear();
}

function _isPageFarFromViewport(pgState, thresholdPx = 1800) {
  const scrollEl = document.getElementById('canvas-scroll');
  const wrap = pgState?.wrap;
  if (!scrollEl || !wrap || !wrap.isConnected) return false;
  const viewHeight = scrollEl.clientHeight;
  if (!(viewHeight > 0)) return false;
  const viewTop = scrollEl.scrollTop;
  const viewBottom = viewTop + viewHeight;
  const wrapTop = wrap.offsetTop;
  const wrapHeight = wrap.offsetHeight || pgState.viewport?.height || 0;
  return (wrapTop + wrapHeight < viewTop - thresholdPx) || (wrapTop > viewBottom + thresholdPx);
}

function _scheduleQueueDrain() {
  if (_queueDrainScheduled) return;
  _queueDrainScheduled = true;
  requestAnimationFrame(() => {
    _queueDrainScheduled = false;
    _drainVisibleRenderQueue();
  });
}

function _drainVisibleRenderQueue() {
  if (!S.pdfDoc || !_visibleQueue.size) return;
  const scrollEl = document.getElementById('canvas-scroll');
  if (!scrollEl) return;

  // Single batched DOM layout read pass (no interleaved writes)
  const viewTop = scrollEl.scrollTop;
  const viewHeight = scrollEl.clientHeight || window.innerHeight || 900;
  const viewBottom = viewTop + viewHeight;
  const viewCenter = viewTop + viewHeight * 0.5;
  const scrolling = isUserScrolling();

  const inViewport = [];
  const nearViewport = [];

  for (const pNum of Array.from(_visibleQueue)) {
    const pg = S.pages?.[pNum];
    if (!pg || !pg.wrap || pg.rendered) {
      _visibleQueue.delete(pNum);
      continue;
    }
    const top = pg.wrap.offsetTop;
    const h = pg.wrap.offsetHeight || pg.viewport?.height || 0;
    const bottom = top + h;
    const dist = Math.abs((top + h * 0.5) - viewCenter);

    if (bottom >= viewTop && top <= viewBottom) {
      inViewport.push({ pNum, dist });
    } else if (bottom >= viewTop - 1200 && top <= viewBottom + 1200) {
      nearViewport.push({ pNum, dist });
    } else {
      _visibleQueue.delete(pNum);
    }
  }

  // During active fast scroll, cancel in-flight renders that are now far from viewport
  if (scrolling && _activeRenderTasks.size > 0) {
    for (const pNum of Array.from(_activeRenderTasks.keys())) {
      const pg = S.pages?.[pNum];
      if (pg && _isPageFarFromViewport(pg, 1800)) {
        _cancelRenderTask(pNum);
      }
    }
  }

  inViewport.sort((a, b) => a.dist - b.dist);
  nearViewport.sort((a, b) => a.dist - b.dist);

  if (scrolling) {
    // Scroll-velocity gating: do NOT trigger ±1 neighbor or off-screen margin renders while fast scrolling.
    // Keep only immediately visible viewport pages responsive up to concurrency cap.
    for (const { pNum } of inViewport) {
      if (_renderingPages.size >= MAX_SCROLL_CONCURRENT_RENDERS) break;
      const pg = S.pages?.[pNum];
      if (pg && !pg.rendered && !pg.rendering) {
        ensurePageRendered(pNum);
      }
    }
    return;
  }

  // Scrolling paused / idle: prioritize visible pages first, then margin pages, then ±1 lookahead
  for (const { pNum } of inViewport) {
    const pg = S.pages?.[pNum];
    if (pg && !pg.rendered && !pg.rendering) {
      ensurePageRendered(pNum);
    }
  }
  for (const { pNum } of nearViewport) {
    const pg = S.pages?.[pNum];
    if (pg && !pg.rendered && !pg.rendering) {
      ensurePageRendered(pNum);
    }
  }

  const primaryPage = inViewport[0]?.pNum ?? nearViewport[0]?.pNum;
  if (primaryPage) {
    if (primaryPage < S.totalPages && !S.pages[primaryPage + 1]?.rendered && !S.pages[primaryPage + 1]?.rendering) {
      ensurePageRendered(primaryPage + 1);
    }
    if (primaryPage > 1 && !S.pages[primaryPage - 1]?.rendered && !S.pages[primaryPage - 1]?.rendering) {
      ensurePageRendered(primaryPage - 1);
    }
  }
}

function _hydrateVisibleTextLayers() {
  if (!S.pdfDoc || isUserScrolling()) return;
  const scrollEl = document.getElementById('canvas-scroll');
  if (!scrollEl) return;
  const viewTop = scrollEl.scrollTop;
  const viewHeight = scrollEl.clientHeight || window.innerHeight || 900;
  const viewBottom = viewTop + viewHeight;
  const viewCenter = viewTop + viewHeight * 0.5;

  const candidates = [];
  for (const pNum of _renderedPages) {
    const pg = S.pages?.[pNum];
    if (!pg || !pg.rendered || pg.txtLayerPopulated || !pg.wrap) continue;
    const top = pg.wrap.offsetTop;
    const h = pg.wrap.offsetHeight || pg.viewport?.height || 0;
    if (top + h >= viewTop - 600 && top <= viewBottom + 600) {
      candidates.push({ pNum, dist: Math.abs((top + h * 0.5) - viewCenter) });
    }
  }
  if (!candidates.length) return;
  candidates.sort((a, b) => a.dist - b.dist);

  let idx = 0;
  const step = () => {
    if (isUserScrolling() || !S.pdfDoc) return;
    while (idx < candidates.length) {
      const { pNum } = candidates[idx++];
      const pg = S.pages?.[pNum];
      if (pg && pg.rendered && !pg.txtLayerPopulated) {
        ensurePageTextLayer(pNum);
        break;
      }
    }
    if (idx < candidates.length) {
      scheduleIdleWork(step);
    }
  };
  scheduleIdleWork(step);
}

function _ensureCanvasScrollDelegation() {
  if (typeof document === 'undefined') return;
  const scroll = document.getElementById('canvas-scroll');
  if (!scroll || scroll.dataset.txtHydrateDelegated === '1') return;
  scroll.dataset.txtHydrateDelegated = '1';

  const hydrateFromEvent = (e) => {
    const wrap = e.target?.closest?.('.pg-wrap[data-page]');
    if (!wrap) return;
    const pNum = parseInt(wrap.dataset.page, 10);
    if (pNum && S.pages?.[pNum]?.rendered && !S.pages[pNum].txtLayerPopulated) {
      ensurePageTextLayer(pNum);
    }
  };

  // Delegated hover & capture pointerdown hydrate deferred .txt-layer spans immediately on interaction
  scroll.addEventListener('pointerover', hydrateFromEvent, { passive: true });
  scroll.addEventListener('pointerdown', hydrateFromEvent, { capture: true, passive: true });
}
_ensureCanvasScrollDelegation();

export function captureZoomAnchor() {
  if (_activeZoomAnchor) return _activeZoomAnchor;
  const scrollEl = document.getElementById('canvas-scroll');
  const anchorPage = Math.max(1, Math.min(S.totalPages || 1, S.curPage || 1));
  const anchorWrap = S.pages?.[anchorPage]?.wrap;
  let anchorRatio = 0;
  if (scrollEl && anchorWrap && anchorWrap.offsetHeight > 0) {
    anchorRatio = Math.max(0, Math.min(0.95, (scrollEl.scrollTop - anchorWrap.offsetTop + 16) / anchorWrap.offsetHeight));
  }
  _activeZoomAnchor = { page: anchorPage, ratio: anchorRatio };
  setIsJumping(true);
  return _activeZoomAnchor;
}

// ── Memory-Safe Page Canvas Eviction for Large PDFs (500+ pages) ──
const MAX_RENDERED_CANVAS_PAGES = 16;
const EVICT_PAGE_DISTANCE = 10;

export function unrenderFarPages(centerPage = S.curPage || 1) {
  if (!S.totalPages || S.totalPages <= 50 || _renderedPages.size <= MAX_RENDERED_CANVAS_PAGES) {
    return;
  }
  const scrollEl = document.getElementById('canvas-scroll');
  const viewTop = scrollEl ? scrollEl.scrollTop - 1200 : -Infinity;
  const viewBottom = scrollEl ? scrollEl.scrollTop + scrollEl.clientHeight + 1200 : Infinity;
  for (const pNum of Array.from(_renderedPages)) {
    if (Math.abs(pNum - centerPage) > EVICT_PAGE_DISTANCE) {
      const pg = S.pages?.[pNum];
      // Never unload a page that is on (or near) the screen — the
      // IntersectionObserver would not re-render it and it would stay blank.
      if (pg?.wrap && scrollEl) {
        const top = pg.wrap.offsetTop;
        if (top + pg.wrap.offsetHeight > viewTop && top < viewBottom) continue;
      }
      if (pg && pg.rendered && !pg.rendering) {
        try {
          if (pg.pdfCanvas) { pg.pdfCanvas.width = 1; pg.pdfCanvas.height = 1; }
          if (pg.drawCanvas) { pg.drawCanvas.width = 1; pg.drawCanvas.height = 1; }
        } catch {}
        pg.pdfCanvas = null;
        pg.drawCanvas = null;
        pg.txtLayer = null;
        pg.annOv = null;
        pg.srchOv = null;
        pg.rendered = false;
        pg.txtLayerPopulated = false;
        pg._pendingTextData = null;
        pg._pendingOcr = false;
        pg._vaultHydrated = false;
        _textDone.delete(pNum);
        _drawDone.delete(pNum);
        if (pg.wrap) {
          pg.wrap.innerHTML = `<div class="pg-placeholder" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;font-family:var(--font-ui, 'Public Sans', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif);letter-spacing:.05em">Page ${pNum}</div>`;
        }
        _renderedPages.delete(pNum);
      }
    }
  }
}

export function scheduleUnrenderFarPages() {
  scheduleIdleWork(() => unrenderFarPages(S.curPage || 1));
}

// Cooperative idle scheduler helper: uses requestIdleCallback if available, or polite 35ms timeout
function scheduleIdleWork(fn) {
  if (typeof window.requestIdleCallback === 'function') {
    return window.requestIdleCallback(() => fn(), { timeout: 120 });
  }
  return setTimeout(fn, 35);
}

let _bgTriggerFn = null;

// Wake up queued visible renders, deferred text layers & background renderer when user stops scrolling
onScrollIdle(() => {
  const cur = S.curPage || 1;
  if (S.pdfDoc && S.pages) {
    for (let p = Math.max(1, cur - 1); p <= Math.min(S.totalPages || 0, cur + 1); p++) {
      const pg = S.pages[p];
      if (pg && !pg.rendered && !pg.rendering) {
        _visibleQueue.add(p);
      }
    }
  }
  _drainVisibleRenderQueue();
  _hydrateVisibleTextLayers();
  if (_bgTriggerFn) {
    const fn = _bgTriggerFn;
    _bgTriggerFn = null;
    fn();
  }
});

export function startBackgroundDocRenderer(docId) {
  const myGen = ++_bgRenderGen;

  const renderNextUnrendered = async () => {
    if (!S.pdfDoc || _bgRenderGen !== myGen) {
      return;
    }

    const cur = S.curPage || 1;
    let nextP = null;
    let minDiff = Infinity;
    // For large PDFs (> 50 pages), only pre-render a ±6 page lookahead window around curPage
    // so a 500-page 100MB PDF never allocates 8GB of canvases in RAM!
    const maxLookahead = S.totalPages > 50 ? 6 : S.totalPages;

    // Search for closest unrendered page to current reading position within lookahead window
    for (let p = Math.max(1, cur - maxLookahead); p <= Math.min(S.totalPages, cur + maxLookahead); p++) {
      const pg = S.pages?.[p];
      if (pg && !pg.rendered && !pg.rendering) {
        const diff = Math.abs(p - cur);
        if (diff < minDiff) {
          minDiff = diff;
          nextP = p;
        }
      }
    }

    if (nextP === null || _bgRenderGen !== myGen) {
      unrenderFarPages(cur);
      return;
    }

    // Priority-Tiered Strategy:
    // If user is actively scrolling and next page is distant (> 2 pages away),
    // yield and wait so visible and nearby lookahead pages get 100% of CPU and rendering bandwidth
    if (isUserScrolling() && Math.abs(nextP - cur) > 2) {
      _bgTriggerFn = () => {
        if (_bgRenderGen === myGen) scheduleIdleWork(renderNextUnrendered);
      };
      return;
    }

    try {
      await ensurePageRendered(nextP);
    } catch (e) {
      console.warn(`[Background Render] Page ${nextP} error:`, e);
    }

    if (_bgRenderGen === myGen) {
      // Use cooperative idle scheduling instead of 0ms tight loop
      scheduleIdleWork(renderNextUnrendered);
    }
  };

  _bgTriggerFn = () => {
    if (_bgRenderGen === myGen) scheduleIdleWork(renderNextUnrendered);
  };

  scheduleIdleWork(renderNextUnrendered);
}

// ── Smart Syllabus Pre-Fetching of Next PDF in Sequence ──
export async function scheduleNextPdfPrefetch(pdfFile) {
  if (!pdfFile || !S.pdfs?.length) return;

  // Find all sibling PDFs in the same folder, sorted in order
  const siblings = S.pdfs
    .filter(p => (p.folder_id || null) === (pdfFile.folder_id || null))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  const idx = siblings.findIndex(p => p.id === pdfFile.id);
  const nextPdf = (idx !== -1 && idx < siblings.length - 1) ? siblings[idx + 1] : null;
  if (!nextPdf) return;

  const targetDriveId = nextPdf.drive_file_id || S.pdfs.find(p => p.id === nextPdf.linked_pdf_id)?.drive_file_id;
  if (!targetDriveId) return;

  // Check if already in RAM or IndexedDB
  if (S.pdfCache[targetDriveId]) return;

  try {
    const { isPDFCached } = await import('./pdfcache.js');
    const cached = await isPDFCached(targetDriveId);
    if (cached) return;

    // Silently pre-cache next syllabus PDF in background during idle time (after 3 seconds)
    setTimeout(async () => {
      if (S.curPDF?.id === pdfFile.id && navigator.onLine && S.driveToken) {
        console.log(`[Smart Prefetch] Silently caching next syllabus PDF: "${nextPdf.name}"`);
        const { driveFetchPDF } = await import('./drive.js');
        await driveFetchPDF(targetDriveId, null, nextPdf.name).catch(() => {});
      }
    }, 3000);
  } catch (err) {
    console.warn('[Smart Prefetch] Check failed:', err);
  }
}

// ── Close active PDF & return to Welcome / Home ──
let _welcomeHTML = (typeof document !== 'undefined' && document.getElementById('welcome')?.outerHTML) || null;
export function getWelcomeHTML() {
  if (!_welcomeHTML && typeof document !== 'undefined') {
    const el = document.getElementById('welcome');
    if (el) _welcomeHTML = el.outerHTML;
  }
  return _welcomeHTML || '<div id="welcome"></div>';
}

export async function closeActivePDF() {
  try {
    const { flushNotepadSave, notepadOnPDFChange } = await import('./notepad.js');
    await flushNotepadSave();
    if (S.curPDF) await notepadOnPDFChange(null);
  } catch {}

  await flushFolderDoc();
  _currentFolderDocId = null;

  ++_renderScaleGen;
  ++_bgRenderGen;
  _cancelAllRenderTasks();
  _visibleQueue.clear();
  _renderedPages.clear();
  _boxDone.clear();
  _drawDone.clear();
  _textDone.clear();
  if (_pageObserver) {
    _pageObserver.disconnect();
    _pageObserver = null;
  }

  if (S.pdfDoc) {
    try { S.pdfDoc.destroy(); } catch {}
  }

  S.curPDF = null;
  S.pdfDoc = null;
  S.totalPages = 0;
  S.pages = {};
  invalidatePageOffsetCache();

  const { closeOtherPanels } = await import('./ui.js');
  closeOtherPanels();
  const { clearSearchHighlights } = await import('./search.js');
  clearSearchHighlights();

  const scroll = document.getElementById('canvas-scroll');
  if (scroll && !scroll.querySelector('#welcome')) {
    scroll.innerHTML = getWelcomeHTML();
  }

  document.getElementById('folder-doc-viewer').style.display = 'none';
  document.getElementById('content-area').style.display = 'flex';
  document.getElementById('pg-total').textContent = '0';
  document.getElementById('pg-input').value = '1';
  document.getElementById('zoom-lbl').textContent = '100%';
  document.getElementById('ocr-completion-banner')?.remove();
  import('./ocr-studio.js').then(m => m.updateReaderOcrStatusPill?.()).catch(() => {});

  updateActivePDF();
  notifyTabClosedToHome();
}

// ── Open PDF from library ──
export async function openPDFFromLibrary(pdfFile, retries = 5) {
  // Flush reading position for departing PDF and lock scroll listener IMMEDIATELY
  const { flushCurrentReadingPosition, setIsJumping, parseReadPosPayload, scrollToPageAndRatio } = await import('./ui.js');
  flushCurrentReadingPosition();
  setIsJumping(true);

  // Capture #welcome template before #canvas-scroll is overwritten
  getWelcomeHTML();
  try {
    const { flushNotepadSave } = await import('./notepad.js');
    await flushNotepadSave();
  } catch {}
  await flushFolderDoc();
  _currentFolderDocId = null;

  // Destroy previous PDF.js document immediately to free RAM/GPU memory
  _activeZoomAnchor = null;
  ++_renderScaleGen;
  ++_bgRenderGen;
  _cancelAllRenderTasks();
  _visibleQueue.clear();
  if (S.pdfDoc) {
    try { S.pdfDoc.destroy(); } catch {}
    S.pdfDoc = null;
  }

  S.curPDF = pdfFile;
  updateActivePDF();
  notifyTabOpened(pdfFile, 'pdf');

  const { closeOtherPanels } = await import('./ui.js');
  closeOtherPanels();

  const { clearSearchHighlights } = await import('./search.js');
  clearSearchHighlights();

  const trueId = pdfFile.linked_pdf_id || pdfFile.id;

  // Fire notepadOnPDFChange without blocking — it just flushes local state
  // and loads notes from Supabase in the background; the PDF fetch can start immediately
  import('./notepad.js').then(m => m.notepadOnPDFChange(trueId)).catch(() => {});

  // Flush any pending debounced localStorage writes before clearing S.annotations
  flushDebouncedStorageWrites();

  // Instantly clear memory of previous PDF's data so ghost highlights never bleed over
  S.annotations = [];
  S.drawData = {};
  S.bookmarks = [];

  // Prime immediately from local cache if present (instant 0ms restore)
  try {
    const cachedAnns = safeStorageGet('local_anns_' + trueId);
    if (cachedAnns) S.annotations = JSON.parse(cachedAnns);
    const cachedDraws = safeStorageGet('local_draws_' + trueId);
    if (cachedDraws) S.drawData = JSON.parse(cachedDraws);
    const cachedBms = safeStorageGet('local_bms_' + trueId);
    if (cachedBms) S.bookmarks = JSON.parse(cachedBms);
  } catch {}

  // Switch to PDF mode
  document.getElementById('folder-doc-viewer').style.display = 'none';
  document.getElementById('content-area').style.display = 'flex';

  const scroll = document.getElementById('canvas-scroll');
  _ensureCanvasScrollDelegation();
  if (scroll && scroll.dataset.massTagDelegated !== '1') {
    scroll.dataset.massTagDelegated = '1';
    scroll.addEventListener('mouseup', (e) => {
      if (S.mode === 'text') _handleCanvasScrollTextUp(e);
    });
    scroll.addEventListener('touchend', (e) => {
      if (S.mode === 'text') setTimeout(() => _handleCanvasScrollTextUp(e), 60);
    });
  }
  scroll.innerHTML = `<div class="spin-w"><div class="spinner"></div>${retries < 5 ? 'Retrying PDF...' : 'Loading PDF…'}</div>`;

  // Start PDF fetch and Supabase database queries in parallel
  const targetDriveId = pdfFile.drive_file_id || S.pdfs.find(p => p.id === pdfFile.linked_pdf_id)?.drive_file_id;
  if (typeof window !== 'undefined' && window.__DESKTOP_PDFIUM__?.getOcrCompressStatus && window.__DESKTOP_PDFIUM__?.readCachedPdfBytes) {
    try {
      const st = await window.__DESKTOP_PDFIUM__.getOcrCompressStatus(trueId);
      if (st && st.status === 'completed' && st.updatedAt) {
        const appliedKey = 'studio_applied_job_' + trueId;
        if (safeStorageGet(appliedKey) !== String(st.updatedAt)) {
          const freshBytes = await window.__DESKTOP_PDFIUM__.readCachedPdfBytes(trueId);
          if (freshBytes && freshBytes.byteLength > 100) {
            const freshBlob = new Blob([freshBytes], { type: 'application/pdf' });
            if (targetDriveId) {
              S.pdfCache[targetDriveId] = freshBlob;
              const { setCachedPDF } = await import('./pdfcache.js');
              await setCachedPDF(targetDriveId, freshBlob, pdfFile.name);
            }
            safeStorageSet(appliedKey, String(st.updatedAt));
          }
        }
      }
    } catch {}
  }
  const pdfFetchPromise = driveFetchPDF(targetDriveId, (pct, loadedMB, totalMB) => {
    if (scroll) {
      if (pct !== null) {
        scroll.innerHTML = `<div class="spin-w"><div class="spinner"></div>Loading PDF: ${pct}% (${loadedMB}/${totalMB} MB)</div>`;
      } else {
        scroll.innerHTML = `<div class="spin-w"><div class="spinner"></div>Loading PDF: ${loadedMB} MB…</div>`;
      }
    }
  }, pdfFile.name);
  const dbDataPromise = Promise.all([
    dbLoadBookmarks(trueId),
    dbLoadAnnotations(trueId),
    dbLoadDrawings(trueId),
    dbGetSetting('default_page_' + pdfFile.id).catch(() => null),
    dbGetSetting('read_pos_' + trueId).catch(() => null),
  ]);

  try {
    const blob = await pdfFetchPromise;

    // Convert Blob → ArrayBuffer once here for PDF.js (unavoidable).
    // Never duplicate or base64-encode 100MB buffers in JS!
    const buf = await blob.arrayBuffer();
    const byteLen = buf.byteLength;
    const onlyCopyIfSmall = byteLen <= 35 * 1024 * 1024 ? buf.slice(0) : null;
    if (typeof window !== 'undefined' && window.__DESKTOP_PDFIUM__?.openPdf) {
      // Pass `onlyCopyIfSmall || blob` so 100MB+ PDFs stream to disk cache in 4MB slices from `blob` without duplicating `buf`
      window.__DESKTOP_PDFIUM__.openPdf(trueId, onlyCopyIfSmall || blob, pdfFile._localPath || null, targetDriveId).catch(() => {});
    }
    let loadedDoc = null;
    let workerTask = null;
    try {
      workerTask = pdfjsLib.getDocument({ data: buf });
      loadedDoc = await Promise.race([
        workerTask.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('PDF_WORKER_TIMEOUT')), 7000)),
      ]);
    } catch (workerErr) {
      console.warn('[Viewer] PDF.js worker load stalled or failed, falling back to disableWorker=true:', workerErr);
      try { workerTask?.destroy?.(); } catch {}
      const fallbackBuf = await blob.arrayBuffer();
      loadedDoc = await pdfjsLib.getDocument({ data: fallbackBuf, disableWorker: true }).promise;
    }
    S.pdfDoc = loadedDoc;
    S.pdfDoc._desktopDocId = trueId;
    S.pdfDoc._driveFileId = targetDriveId;
    S.pdfDoc._byteLength = byteLen;
    S.pdfDoc._rawPdfBytes = onlyCopyIfSmall;
    S.totalPages = S.pdfDoc.numPages;
    document.getElementById('pg-total').textContent = S.totalPages;
    document.getElementById('pg-input').value = 1;
    document.getElementById('pg-input').max   = S.totalPages;

    scroll.innerHTML = '';
    S.pages = {};
    _boxDone.clear();
    _drawDone.clear();
    _textDone.clear();
    _renderedPages.clear();
    _renderingPages.clear();
    _visibleQueue.clear();
    _cancelAllRenderTasks();

    if (_pageObserver) {
      _pageObserver.disconnect();
      _pageObserver = null;
    }

    // Get page 1 viewport for default aspect ratio
    const p1 = await S.pdfDoc.getPage(1);
    const vp1 = p1.getViewport({ scale: S.scale });

    // Instantly create lightweight placeholders for all pages
    // Scrollbar and page navigation work immediately across all 700+ pages!
    for (let p = 1; p <= S.totalPages; p++) {
      const wrap = document.createElement('div');
      wrap.className = 'pg-wrap';
      wrap.dataset.page = p;
      wrap.style.width = vp1.width + 'px';
      wrap.style.height = vp1.height + 'px';
      wrap.innerHTML = `<div class="pg-placeholder" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;font-family:var(--font-ui, 'Public Sans', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif);letter-spacing:.05em">Page ${p}</div>`;
      scroll.appendChild(wrap);
      S.pages[p] = { wrap, rendered: false, rendering: false, viewport: vp1, textItems: [], txtLayerPopulated: false };
    }
    invalidatePageOffsetCache();

    // Determine starting page & ratio:
    // Manual folder-specific default page OVERRIDES automatic last-read bookmark!
    const manualDefault = safeStorageGet('default_page_' + pdfFile.id)
      || (pdfFile.folder_id ? safeStorageGet('default_page_f_' + pdfFile.folder_id + '_' + trueId) : null);

    let startPage = 1;
    let startRatio = 0;
    let hasManualDefault = false;

    if (manualDefault) {
      const parsedDef = parseInt(manualDefault, 10);
      if (parsedDef >= 1) {
        startPage = Math.min(S.totalPages, parsedDef);
        startRatio = 0;
        hasManualDefault = true;
      }
    }

    const localMetaRaw = safeStorageGet('read_pos_meta_' + trueId)
      || safeStorageGet('read_pos_meta_' + pdfFile.id)
      || safeStorageGet('bookmark_' + trueId)
      || safeStorageGet('bookmark_' + pdfFile.id);
    const localPos = parseReadPosPayload(localMetaRaw);

    if (!hasManualDefault && localPos && localPos.page >= 1) {
      startPage = Math.min(S.totalPages, Math.max(1, localPos.page));
      startRatio = localPos.ratio || 0;
    }

    S.curPage = startPage;
    document.getElementById('pg-input').value = startPage;
    document.getElementById('pg-input').max = S.totalPages;

    // Lock scroll watcher so initial scroll/layout doesn't overwrite bookmark with page 1
    setIsJumping(true);

    // ── INSTANT RESUME: jump to saved page before any rendering happens ──
    // All placeholders are uniform height (vp1.height) so scrollTop can be calculated
    // algebraically in 0ms — no page render required, no layout reflow needed.
    if (startPage > 1 || startRatio > 0) {
      const pageHeightWithGap = vp1.height + 24;
      scroll.scrollTop = Math.max(0, 28 + (startPage - 1) * pageHeightWithGap + Math.round(startRatio * vp1.height));

      const targetWrap = S.pages[startPage]?.wrap;
      if (targetWrap) {
        targetWrap.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    } else {
      scroll.scrollTop = 0;
    }

    // IntersectionObserver queues pages as they scroll into view (scroll-velocity gated)
    _pageObserver = new IntersectionObserver((entries) => {
      let added = false;
      for (const entry of entries) {
        const pNum = parseInt(entry.target.dataset.page, 10);
        if (!pNum) continue;
        if (entry.isIntersecting) {
          if (!S.pages?.[pNum]?.rendered) {
            _visibleQueue.add(pNum);
            added = true;
          }
        } else {
          _visibleQueue.delete(pNum);
        }
      }
      if (added) {
        _drainVisibleRenderQueue();
      }
    }, {
      root: scroll,
      rootMargin: '1200px 0px 1200px 0px',
    });

    for (let p = 1; p <= S.totalPages; p++) {
      _pageObserver.observe(S.pages[p].wrap);
    }

    // Eagerly render target page and neighbors
    await ensurePageRendered(startPage);
    if (startPage > 1) ensurePageRendered(startPage - 1);
    if (startPage < S.totalPages) ensurePageRendered(startPage + 1);

    // Precise sub-page alignment once target page is rendered
    await scrollToPageAndRatio(startPage, startRatio, false);

    // Release _isJumping lock once initial layout and scroll have fully settled
    setTimeout(() => {
      setIsJumping(false);
    }, 400);

    // Await parallel DB data queries
    const [, , , cloudDefaultPage, cloudReadPos] = await dbDataPromise;
    const cloudPos = parseReadPosPayload(cloudReadPos);

    // Cross-device sync fallback:
    if (!hasManualDefault && cloudDefaultPage) {
      const parsedCloudDef = parseInt(cloudDefaultPage, 10);
      if (parsedCloudDef >= 1 && parsedCloudDef <= S.totalPages && S.curPage !== parsedCloudDef) {
        safeStorageSet('default_page_' + pdfFile.id, parsedCloudDef);
        if (pdfFile.folder_id) safeStorageSet('default_page_f_' + pdfFile.folder_id + '_' + trueId, parsedCloudDef);
        const { jumpToPage } = await import('./ui.js');
        jumpToPage(parsedCloudDef, false);
      }
    } else if (!hasManualDefault && cloudPos && cloudPos.page >= 1 && cloudPos.page <= S.totalPages) {
      if (cloudPos.updatedAt > localPos.updatedAt || !localPos.page || (localPos.updatedAt === 0 && cloudPos.page !== localPos.page)) {
        safeStorageSet('bookmark_' + trueId, cloudPos.page);
        if (pdfFile.linked_pdf_id) safeStorageSet('bookmark_' + pdfFile.id, cloudPos.page);
        const metaStr = JSON.stringify(cloudPos);
        safeStorageSet('read_pos_meta_' + trueId, metaStr);
        safeStorageSet('read_pos_meta_' + pdfFile.id, metaStr);
        S.curPage = cloudPos.page;
        document.getElementById('pg-input').value = cloudPos.page;
        await scrollToPageAndRatio(cloudPos.page, cloudPos.ratio, false);
      }
    }

    // Redraw on any already rendered page
    const { redrawAllAnnotations } = await import('./annotate.js');
    const { redrawAllDrawings }    = await import('./draw.js');
    redrawAllAnnotations();
    redrawAllDrawings();
    renderColorDots();

    // Track recent PDFs
    pushRecent(pdfFile);

    // Load OCR layer & Tags for current PDF in background
    import('./ocr.js').then(m => m.loadOcrForCurrentPdf?.(trueId)).catch(() => {});
    import('./ocr-studio.js').then(m => m.updateReaderOcrStatusPill?.()).catch(() => {});
    import('./tags.js').then(m => m.loadTagsForPdf?.(trueId)).catch(() => {});

    // Start background progressive full-document renderer (ensures all pages are rendered without scrolling)
    startBackgroundDocRenderer(pdfFile.id);

    // Start background full-document text indexing across all 1000+ pages
    import('./search.js').then(m => m.indexAllPagesText(S.pdfDoc)).catch(() => {});

    // Smart syllabus pre-fetch: silently cache next PDF in folder for 0ms transition
    scheduleNextPdfPrefetch(pdfFile);

    syncOK('Ready');
  } catch (e) {
    const isOfflineMiss = !!e?.offline || e?.message === 'OFFLINE_NOT_DOWNLOADED' || (typeof navigator !== 'undefined' && navigator.onLine === false);
    if (isOfflineMiss) {
      // Not downloaded on this device and no internet — explain calmly, no retries.
      const _pdfRefOff = pdfFile;
      scroll.innerHTML = `<div style="color:var(--text);padding:20px;font-size:13px;max-width:440px;line-height:1.7"><strong>📴 You're offline</strong><br>
        This case hasn't been downloaded to this device yet, so it can't be opened without internet.<br><br>
        <span style="color:var(--muted)">Tip: next time you're online, right-click a folder → <strong>📥 Make Folder Available Offline</strong> to keep its cases and notes ready for offline review.</span><br><br>
        <button id="btn-retry-load" style="padding:6px 14px;background:var(--accent,#3b82f6);border:none;color:#fff;border-radius:6px;cursor:pointer;font-size:12px">↺ Try again</button></div>`;
      document.getElementById('btn-retry-load')?.addEventListener('click', () => {
        openPDFFromLibrary(_pdfRefOff, 2);
      });
      const { syncOK: _syncOK } = await import('./ui.js');
      _syncOK('Offline Mode (Local Cache)');
      return;
    }
    if (retries > 0 && !e.message?.includes('Not signed in') && !e.message?.includes('session expired') && !e.message?.includes('No Google Drive file')) {
      console.warn('PDF load failed, retrying...', e);
      await new Promise(r => setTimeout(r, 300));
      return openPDFFromLibrary(pdfFile, retries - 1);
    }
    console.error(e);
    const { recordError } = await import('./ui.js');
    recordError(e, 'PDF Load');
    let errCode = e?.status || (e?.message?.includes('401') ? '401' : (e?.message?.includes('403') ? '403' : 'ERR'));
    let msg = 'Could not load PDF.';
    const isAuthErr = e.message?.includes('session expired') || e.message?.includes('Not signed in') || errCode === '401';
    if (isAuthErr) {
      msg = 'Google Drive sign-in required. Use the orange banner at the top of the page to sign back in, then click "Try again" below.';
    } else if (errCode === '403') {
      msg = 'Google Drive permission denied or quota exceeded [403].';
    } else if (e.message) {
      msg = `Could not load PDF [${errCode}]: ${e.message}`;
    }
    // Capture pdfFile reference for retry button (closures work fine here)
    const _pdfRef = pdfFile;
    scroll.innerHTML = `<div style="color:var(--red);padding:20px;font-size:13px;max-width:400px;line-height:1.7"><strong>⚠️ Error loading PDF</strong><br>${msg}<br><br>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="btn-retry-load" style="padding:6px 14px;background:var(--accent,#3b82f6);border:none;color:#fff;border-radius:6px;cursor:pointer;font-size:12px">↺ Try again</button>
        <button onclick="window.location.reload()" style="padding:6px 12px;background:var(--navy-l);border:1px solid var(--navy-b);color:var(--text);border-radius:6px;cursor:pointer;font-size:12px">Reload App</button>
      </div></div>`;
    document.getElementById('btn-retry-load')?.addEventListener('click', () => {
      openPDFFromLibrary(_pdfRef, 2);
    });
    const { syncErr } = await import('./ui.js');
    syncErr(`Load failed [${errCode}]`);
  }
}

// ── Re-render all pages (after zoom change) ──
export async function reRenderAll() {
  if (!S.pdfDoc) {
    _activeZoomAnchor = null;
    setIsJumping(false);
    return;
  }

  // Capture reading anchor before any wrapper heights change (reuses gesture anchor if already captured)
  const anchor = captureZoomAnchor();
  const anchorPage = Math.max(1, Math.min(S.totalPages || 1, anchor.page || S.curPage || 1));
  const anchorRatio = anchor.ratio || 0;

  setIsJumping(true);
  const myScaleGen = ++_renderScaleGen;
  ++_bgRenderGen;
  _cancelAllRenderTasks();
  _visibleQueue.clear();

  const p1 = await S.pdfDoc.getPage(1);
  if (myScaleGen !== _renderScaleGen || !S.pdfDoc) return;
  const vp1 = p1.getViewport({ scale: S.scale });

  // Update sizes on all page wrappers synchronously
  for (let p = 1; p <= S.totalPages; p++) {
    const pg = S.pages[p];
    if (pg?.wrap) {
      pg.wrap.style.width = vp1.width + 'px';
      pg.wrap.style.height = vp1.height + 'px';
      pg.viewport = vp1;
      pg.textItems = [];
      pg.txtLayerPopulated = false;
      pg._pendingTextData = null;
      pg._pendingOcr = false;
      pg._vaultHydrated = false;
      if (pg.rendered || pg.rendering) {
        try {
          if (pg.pdfCanvas) { pg.pdfCanvas.width = 1; pg.pdfCanvas.height = 1; }
          if (pg.drawCanvas) { pg.drawCanvas.width = 1; pg.drawCanvas.height = 1; }
        } catch {}
        pg.rendered = false;
        pg.rendering = false;
        pg._renderPromise = null;
        pg.pdfCanvas = null;
        pg.drawCanvas = null;
        pg.txtLayer = null;
        pg.annOv = null;
        pg.srchOv = null;
        pg.wrap.innerHTML = `<div class="pg-placeholder" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;font-family:var(--font-ui, 'Public Sans', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif)">Page ${p}</div>`;
      }
    }
  }
  invalidatePageOffsetCache();

  _boxDone.clear();
  _drawDone.clear();
  _textDone.clear();
  _renderedPages.clear();
  _renderingPages.clear();

  // Synchronously restore scroll position to anchorPage + anchorRatio before yielding
  S.curPage = anchorPage;
  const pgInput = document.getElementById('pg-input');
  if (pgInput) pgInput.value = anchorPage;

  const scrollEl = document.getElementById('canvas-scroll');
  const anchorWrap = S.pages?.[anchorPage]?.wrap;
  if (scrollEl && anchorWrap) {
    const pageHeightWithGap = vp1.height + 24;
    const algebraicTop = Math.max(0, 28 + (anchorPage - 1) * pageHeightWithGap - 16 + Math.round(anchorRatio * vp1.height));
    const liveTop = anchorWrap.offsetTop > 0
      ? Math.max(0, anchorWrap.offsetTop - 16 + Math.round(anchorRatio * (anchorWrap.offsetHeight || vp1.height)))
      : algebraicTop;
    scrollEl.scrollTop = liveTop;
  }

  // Re-render anchor page and adjacent neighbors
  await ensurePageRendered(anchorPage);
  if (myScaleGen !== _renderScaleGen) return;

  if (scrollEl && anchorWrap) {
    scrollEl.scrollTop = Math.max(0, anchorWrap.offsetTop - 16 + Math.round(anchorRatio * (anchorWrap.offsetHeight || vp1.height)));
  }

  if (anchorPage > 1) ensurePageRendered(anchorPage - 1);
  if (anchorPage < S.totalPages) ensurePageRendered(anchorPage + 1);

  const { scrollToPageAndRatio } = await import('./ui.js');
  await scrollToPageAndRatio(anchorPage, anchorRatio, false);

  if (myScaleGen === _renderScaleGen) {
    _activeZoomAnchor = null;
    startBackgroundDocRenderer(S.curPDF?.id || 'zoom');
  }
}

// ── Lazily allocate, append, and wire drawCanvas on a rendered page ──
export function ensurePageDrawCanvas(pageNum) {
  const pg = S.pages?.[pageNum];
  if (!pg || !pg.rendered || !pg.wrap) return null;
  if (pg.drawCanvas && pg.drawCanvas.isConnected) {
    if (!_drawDone.has(pageNum)) {
      _drawDone.add(pageNum);
      setupDrawListeners(pg.drawCanvas, pageNum);
    }
    return pg.drawCanvas;
  }

  const vp = pg.viewport;
  const w = vp?.width || pg.pdfCanvas?.width || parseFloat(pg.wrap.style.width) || 0;
  const h = vp?.height || pg.pdfCanvas?.height || parseFloat(pg.wrap.style.height) || 0;
  if (!(w > 0 && h > 0)) return null;

  const drawCanvas = document.createElement('canvas');
  drawCanvas.width = w;
  drawCanvas.height = h;
  drawCanvas.className = 'draw-canvas' + (S.mode === 'draw' ? ' active' : '');
  drawCanvas.dataset.page = pageNum;
  pg.wrap.appendChild(drawCanvas);
  pg.drawCanvas = drawCanvas;

  if (!_drawDone.has(pageNum)) {
    _drawDone.add(pageNum);
    setupDrawListeners(drawCanvas, pageNum);
  }
  if (Array.isArray(S.drawData[pageNum]) && S.drawData[pageNum].length > 0) {
    renderCanvas(drawCanvas, S.drawData[pageNum]);
  }
  return drawCanvas;
}

// ── Populate deferred native .txt-layer spans from PDF.js textContent ──
function _populateTextLayerFromTC(pageNum, pgState, tc, vp, scale) {
  if (!pgState || !pgState.rendered || !pgState.txtLayer || pgState.txtLayerPopulated) return;
  const txtLayer = pgState.txtLayer;
  const textFrag = document.createDocumentFragment();
  const textItems = [];
  // tx[5] is the PDF baseline in CSS pixel coordinates (Y already flipped by vp.transform).
  // CSS renders font baselines at ~0.82x the em-size from the span's top edge.
  for (const item of (tc?.items || [])) {
    if (!item.str || !item.transform) continue;
    const span = document.createElement('span');
    const tx   = pdfjsLib.Util.transform(vp.transform, item.transform);
    const fh   = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
    const angle = Math.atan2(tx[1], tx[0]);
    const fontFam = resolvePdfFontFamily(tc.styles, item.fontName);
    const targetW = Math.abs(item.width || 0) * scale;
    const scaleX  = computeSpanScaleX(item.str, fh, fontFam, targetW);
    const topY    = tx[5] - fh * 0.82;
    span.textContent = item.str;
    span.style.cssText = `left:${tx[4]}px;top:${topY}px;height:${fh}px;line-height:1;font-size:${fh}px;font-family:${fontFam}`;
    const tf = buildSpanTransform(angle, scaleX);
    if (tf) span.style.transform = tf;
    textFrag.appendChild(span);
    textItems.push({
      str: item.str,
      x: tx[4],
      y: topY,
      w: targetW,
      h: item.height ? item.height * scale : fh,
    });
  }
  txtLayer.appendChild(textFrag);
  pgState.textItems = textItems;
  pgState.txtLayerPopulated = true;
  pgState._pendingTextData = null;
}

// ── Idempotently hydrate deferred .txt-layer spans for a rendered page ──
export function ensurePageTextLayer(pageNum) {
  const pgState = S.pages?.[pageNum];
  if (!pgState || !pgState.rendered || !pgState.txtLayer || pgState.txtLayerPopulated) {
    return;
  }

  // Prefer OCR layer when OCR cache exists for this page (zero double-OCR span build)
  const trueId = S.curPDF?.linked_pdf_id || S.curPDF?.id || null;
  if (trueId && hasOcrData(trueId, pageNum)) {
    const applied = applyOcrToRenderedPage(pageNum, trueId);
    if (applied || pgState.txtLayerPopulated) {
      pgState._pendingTextData = null;
      pgState._pendingOcr = false;
      return;
    }
  }

  const pending = pgState._pendingTextData;
  if (!pending || pending.scaleGen !== _renderScaleGen) return;

  // Synchronous hydration when textContent is already cached
  if (pending.tc) {
    _populateTextLayerFromTC(pageNum, pgState, pending.tc, pending.vp, pending.scale);
    return;
  }

  // Deduplicated async textContent fetch -> span build
  if (pending.tcPromise) return pending.tcPromise;
  const myScaleGen = pending.scaleGen;
  const page = pending.page;
  if (!page || typeof page.getTextContent !== 'function') return;

  pending.tcPromise = page.getTextContent().then((tc) => {
    if (myScaleGen !== _renderScaleGen || !S.pdfDoc) return;
    if (S.pages?.[pageNum] !== pgState || !pgState.rendered || pgState.txtLayerPopulated) return;
    pending.tc = tc;
    const tid = S.curPDF?.linked_pdf_id || S.curPDF?.id || null;
    if (tid && hasOcrData(tid, pageNum) && applyOcrToRenderedPage(pageNum, tid)) {
      pgState._pendingTextData = null;
      pgState._pendingOcr = false;
      return;
    }
    _populateTextLayerFromTC(pageNum, pgState, tc, pending.vp, pending.scale);
  }).catch(() => {}).finally(() => {
    if (pending) pending.tcPromise = null;
  });

  return pending.tcPromise;
}

// ── Render a single page on-demand ──
export async function ensurePageRendered(pageNum, container = null) {
  if (!S.pdfDoc) return;
  if (!S.pages[pageNum]) {
    const scroll = container || document.getElementById('canvas-scroll');
    if (!scroll) return;
    const wrap = document.createElement('div');
    wrap.className = 'pg-wrap';
    wrap.dataset.page = pageNum;
    scroll.appendChild(wrap);
    S.pages[pageNum] = { wrap, rendered: false, rendering: false, _renderPromise: null, viewport: null, textItems: [], txtLayerPopulated: false };
  }
  const pgState = S.pages[pageNum];
  if (pgState.rendered) return;
  if (pgState.rendering && pgState._renderPromise) {
    return pgState._renderPromise;
  }
  if (pgState.rendering) return;

  const startedNearViewport = container === null ? !_isPageFarFromViewport(pgState, 1800) : false;
  const shouldBailOut = () => {
    if (container !== null) return false;
    if (!_isPageFarFromViewport(pgState, 1800)) return false;
    // Do not bail out on non-scrolling programmatic jumps (jumpToPage / idle bg pre-render)
    if (!isUserScrolling() && !startedNearViewport) return false;
    return true;
  };

  if (shouldBailOut()) return;

  pgState.rendering = true;
  _renderingPages.add(pageNum);
  const myScaleGen = _renderScaleGen;
  let pdfRenderTask = null;
  let pdfCanvas = null;

  const renderTask = (async () => {
    try {
      const page = await S.pdfDoc.getPage(pageNum);
      if (myScaleGen !== _renderScaleGen || !S.pdfDoc || shouldBailOut()) return;
      const vp = page.getViewport({ scale: S.scale });

      // Render PDF page off-DOM first so bailouts/cancellations never thrash or corrupt live DOM
      pdfCanvas = document.createElement('canvas');
      pdfCanvas.width  = vp.width;
      pdfCanvas.height = vp.height;

      pdfRenderTask = page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: vp });
      _activeRenderTasks.set(pageNum, pdfRenderTask);
      await pdfRenderTask.promise;
      if (_activeRenderTasks.get(pageNum) === pdfRenderTask) {
        _activeRenderTasks.delete(pageNum);
      }

      if (myScaleGen !== _renderScaleGen || !S.pdfDoc || shouldBailOut()) {
        try { pdfCanvas.width = 1; pdfCanvas.height = 1; } catch {}
        pdfCanvas = null;
        return;
      }

      pgState.viewport = vp;

      const wrap = pgState.wrap;
      const scrollEl = container === null ? document.getElementById('canvas-scroll') : null;

      // ── READ PHASE: batch all DOM layout reads BEFORE any DOM style/content writes ──
      const prevHeight = wrap.offsetHeight || vp.height;
      const wrapTop = scrollEl ? wrap.offsetTop : 0;
      const prevScrollTop = scrollEl ? scrollEl.scrollTop : 0;
      // Only pages lying entirely above the viewport need scroll compensation —
      // a page that straddles the top edge keeps its top fixed so the visible
      // content does not shift.
      const wasFullyAbove = !!scrollEl && (wrapTop + prevHeight) <= prevScrollTop;
      const heightChanged = Math.abs(vp.height - prevHeight) > 1;

      // Lazy drawCanvas: only allocate if page has drawings or user is in draw mode
      const hasStrokes = Array.isArray(S.drawData[pageNum]) && S.drawData[pageNum].length > 0;
      let drawCanvas = null;
      if (hasStrokes || S.mode === 'draw') {
        drawCanvas = document.createElement('canvas');
        drawCanvas.width  = vp.width;
        drawCanvas.height = vp.height;
        drawCanvas.className   = 'draw-canvas' + (S.mode === 'draw' ? ' active' : '');
        drawCanvas.dataset.page = pageNum;
      }

      // Lightweight empty txt-layer container (1 DOM node); spans hydrated lazily
      const txtLayer = document.createElement('div');
      txtLayer.className = 'txt-layer' + (S.mode === 'text' || S.mode === 'select' ? ' sel' : '');
      txtLayer.style.width  = vp.width  + 'px';
      txtLayer.style.height = vp.height + 'px';

      const annOv = document.createElement('div');
      annOv.className       = 'ann-ov';
      annOv.dataset.page    = pageNum;
      annOv.style.width  = vp.width  + 'px';
      annOv.style.height = vp.height + 'px';

      const srchOv = document.createElement('div');
      srchOv.className    = 'srch-ov';
      srchOv.dataset.page = pageNum;
      srchOv.style.width  = vp.width  + 'px';
      srchOv.style.height = vp.height + 'px';

      // ── WRITE PHASE: apply all DOM mutations in one batch ──
      wrap.style.width  = vp.width  + 'px';
      wrap.style.height = vp.height + 'px';
      wrap.innerHTML = ''; // remove placeholder
      if (drawCanvas) {
        wrap.append(pdfCanvas, annOv, srchOv, txtLayer, drawCanvas);
      } else {
        wrap.append(pdfCanvas, annOv, srchOv, txtLayer);
      }

      if (scrollEl && wasFullyAbove && heightChanged) {
        scrollEl.scrollTop = prevScrollTop + (vp.height - prevHeight);
      }
      if (heightChanged) {
        invalidatePageOffsetCache();
      }

      pgState.pdfCanvas = pdfCanvas;
      pgState.drawCanvas = drawCanvas;
      pgState.txtLayer = txtLayer;
      pgState.annOv = annOv;
      pgState.srchOv = srchOv;
      pgState.textItems = pgState.textItems || [];
      pgState.txtLayerPopulated = false;
      pgState.rendered = true;
      _renderedPages.add(pageNum);
      _visibleQueue.delete(pageNum);

      // Store pending text-hydration state; defer span build while scrolling or when OCR will populate
      const trueId = S.curPDF?.linked_pdf_id || S.curPDF?.id || null;
      const hasOcr = !!(trueId && hasOcrData(trueId, pageNum));
      pgState._pendingOcr = hasOcr;
      pgState._pendingTextData = {
        page,
        vp,
        scale: S.scale,
        tc: null,
        tcPromise: null,
        scaleGen: myScaleGen,
      };

      if (!isUserScrolling()) {
        scheduleIdleWork(() => {
          if (myScaleGen === _renderScaleGen && !isUserScrolling() && S.pages?.[pageNum] === pgState && !pgState.txtLayerPopulated) {
            ensurePageTextLayer(pageNum);
          }
        });
      }

      // Setup listeners & visuals
      setupAllListeners(pageNum);
      applyModeVisuals(pageNum);

      // Redraw annotations on this page
      const { drawPageAnnotations } = await import('./annotate.js');
      if (myScaleGen !== _renderScaleGen || !S.pdfDoc) return;
      drawPageAnnotations(pageNum);

      // Redraw drawings on this page
      if (Array.isArray(S.drawData[pageNum]) && S.drawData[pageNum].length > 0) {
        const dc = pgState.drawCanvas || ensurePageDrawCanvas(pageNum);
        if (dc) renderCanvas(dc, S.drawData[pageNum]);
      }

      // Redraw search highlights on this page (skip import if no search results)
      if (S.searchResults && S.searchResults.length > 0) {
        const { drawSearchHL } = await import('./search.js');
        if (myScaleGen !== _renderScaleGen || !S.pdfDoc) return;
        for (let i = 0; i < S.searchResults.length; i++) {
          const res = S.searchResults[i];
          if (res.page === pageNum) {
            drawSearchHL(res, S.searchIdx === i, i);
          }
        }
      }

      if (S.totalPages > 50 && _renderedPages.size > MAX_RENDERED_CANVAS_PAGES) {
        scheduleUnrenderFarPages();
      }
    } catch (err) {
      const isCancelled = err?.name === 'RenderingCancelledException' || String(err?.message || '').includes('Rendering cancelled');
      if (!isCancelled) {
        console.error(`Failed to render page ${pageNum}:`, err);
      }
      if (pdfCanvas && !pgState.rendered) {
        try { pdfCanvas.width = 1; pdfCanvas.height = 1; } catch {}
      }
    } finally {
      if (_activeRenderTasks.get(pageNum) === pdfRenderTask) {
        _activeRenderTasks.delete(pageNum);
      }
      if (myScaleGen === _renderScaleGen) {
        pgState.rendering = false;
        _renderingPages.delete(pageNum);
      }
      if (pgState._renderPromise === renderTask) {
        pgState._renderPromise = null;
      }
      if (container === null && _visibleQueue.size > 0) {
        _scheduleQueueDrain();
      }
    }
  })();

  pgState._renderPromise = renderTask;
  return renderTask;
}

// Backward compatibility alias
export const renderPage = ensurePageRendered;

// ── Render a single page into an arbitrary container (for dual-view pane B) ──
// Uses its own paneState object instead of global S so it doesn't clobber pane A.
export async function renderPageInto(pageNum, container, pdfDocObj, paneState) {
  const page = await pdfDocObj.getPage(pageNum);
  const scale = paneState.scale || S.scale;
  const vp = page.getViewport({ scale });

  const wrap = document.createElement('div');
  wrap.className = 'pg-wrap';
  wrap.dataset.page = pageNum;
  wrap.style.width  = vp.width  + 'px';
  wrap.style.height = vp.height + 'px';

  const pdfCanvas  = document.createElement('canvas');
  pdfCanvas.width  = vp.width;
  pdfCanvas.height = vp.height;

  // Minimal layers for read-only viewing
  const drawCanvas  = document.createElement('canvas');
  drawCanvas.width  = vp.width;
  drawCanvas.height = vp.height;
  drawCanvas.className = 'draw-canvas';

  const txtLayer = document.createElement('div');
  txtLayer.className = 'txt-layer'; // pointer-events disabled via CSS for pane-b
  txtLayer.style.width  = vp.width  + 'px';
  txtLayer.style.height = vp.height + 'px';

  const annOv = document.createElement('div');
  annOv.className = 'ann-ov';
  annOv.dataset.page = pageNum;
  annOv.style.width  = vp.width  + 'px';
  annOv.style.height = vp.height + 'px';

  wrap.append(pdfCanvas, annOv, txtLayer, drawCanvas);
  container.appendChild(wrap);

  await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: vp }).promise;

  // Build text layer (same corrected ascender math + width calibration as main viewer)
  const tc = await page.getTextContent();
  for (const item of tc.items) {
    if (!item.str || !item.transform) continue;
    const span = document.createElement('span');
    const tx   = pdfjsLib.Util.transform(vp.transform, item.transform);
    const fh   = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
    const angle = Math.atan2(tx[1], tx[0]);
    const fontFam = resolvePdfFontFamily(tc.styles, item.fontName);
    const targetW = Math.abs(item.width || 0) * scale;
    const scaleX  = computeSpanScaleX(item.str, fh, fontFam, targetW);
    span.textContent = item.str;
    span.style.cssText = `left:${tx[4]}px;top:${tx[5] - fh * 0.8}px;font-size:${fh}px;font-family:${fontFam}`;
    const tf = buildSpanTransform(angle, scaleX);
    if (tf) span.style.transform = tf;
    txtLayer.appendChild(span);
  }

  if (!paneState.pages) paneState.pages = {};
  paneState.pages[pageNum] = { wrap, pdfCanvas, drawCanvas, txtLayer, annOv, viewport: vp };
}

// ── Mode ──
export function setMode(m) {
  S.mode = m;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  document.getElementById('draw-ctrls')?.classList.toggle('visible', m === 'draw');
  if (m !== 'text') {
    document.getElementById('sel-menu')?.classList.remove('open');
    const confirmBtn = document.getElementById('sel-confirm');
    if (confirmBtn) confirmBtn.style.display = '';
    S.pendingSel = null;
    import('./tags.js').then(tm => tm.updateSelMenuMassTagButton?.([])).catch(() => {});
  }
  for (const pn of Object.keys(S.pages)) applyModeVisuals(parseInt(pn));
}

function applyModeVisuals(pageNum) {
  const pg = S.pages[pageNum];
  if (!pg) return;
  if (S.mode === 'draw' && pg.rendered && !pg.drawCanvas) {
    ensurePageDrawCanvas(pageNum);
  }
  const { txtLayer, drawCanvas, wrap } = pg;
  if (txtLayer) txtLayer.className = 'txt-layer' + (S.mode === 'text' || S.mode === 'select' ? ' sel' : '');
  if (drawCanvas) drawCanvas.className = 'draw-canvas' + (S.mode === 'draw' ? ' active' : '');
  if (wrap) wrap.style.cursor = S.mode === 'draw' ? 'crosshair' : 'default';
}

// ── Set up all listeners once per page ──
function setupAllListeners(pageNum) {
  const pg = S.pages[pageNum];
  if (!pg) return;
  if (!_textDone.has(pageNum) && pg.txtLayer) {
    _textDone.add(pageNum);
    pg.txtLayer.addEventListener('mouseup', (e) => { if (S.mode === 'text') onTextUp(pageNum, e); });
    pg.txtLayer.addEventListener('touchend', (e) => { if (S.mode === 'text') setTimeout(() => onTextUp(pageNum, e), 60); });
  }
  if (!_boxDone.has(pageNum) && pg.wrap) {
    _boxDone.add(pageNum);
    setupBoxDrag(pg.wrap, pageNum);
  }
  // Only mark _drawDone when drawCanvas actually exists and is wired
  if (!_drawDone.has(pageNum) && pg.drawCanvas) {
    _drawDone.add(pageNum);
    setupDrawListeners(pg.drawCanvas, pageNum);
  }
}

// ── Text selection highlight ──
function extractRangeTextWithSpacing(range, txtLayer) {
  if (!range || !txtLayer) return '';
  const pNum = _getPageNumFromNode(txtLayer);
  if (pNum && S.pages?.[pNum]?.rendered && !S.pages[pNum].txtLayerPopulated) {
    ensurePageTextLayer(pNum);
  }
  const spans = txtLayer.querySelectorAll('span');
  if (!spans.length) return '';

  const pieces = [];
  for (const span of spans) {
    if (!range.intersectsNode(span)) continue;
    const spanRange = document.createRange();
    spanRange.selectNodeContents(span);
    try {
      if (range.compareBoundaryPoints(Range.START_TO_START, spanRange) > 0) {
        spanRange.setStart(range.startContainer, range.startOffset);
      }
      if (range.compareBoundaryPoints(Range.END_TO_END, spanRange) < 0) {
        spanRange.setEnd(range.endContainer, range.endOffset);
      }
    } catch {
      continue;
    }
    if (spanRange.collapsed) continue;
    const subText = spanRange.toString();
    if (!subText) continue;

    let rect = spanRange.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      rect = span.getBoundingClientRect();
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) continue;

    pieces.push({ el: span, text: subText, rect });
  }

  if (!pieces.length) return '';

  let out = pieces[0].text;
  for (let i = 1; i < pieces.length; i++) {
    const prev = pieces[i - 1];
    const curr = pieces[i];
    const lineHeight = Math.max(prev.rect.height, curr.rect.height, 10);
    const isNewLine =
      (curr.rect.top - prev.rect.top > lineHeight * 0.35) ||
      (curr.rect.bottom <= prev.rect.top + 2);
    const hasBoundarySpace = /\s$/.test(prev.text) || /^\s/.test(curr.text);

    if (isNewLine) {
      if (!hasBoundarySpace) out += ' ';
    } else {
      const gap = curr.rect.left - prev.rect.right;
      const fontSize = parseFloat(getComputedStyle(curr.el).fontSize) || lineHeight * 0.85;
      if (gap > fontSize * 0.14 && !hasBoundarySpace) {
        out += ' ';
      }
    }
    out += curr.text;
  }

  return out.trim();
}

const _handledTextUpEvents = new WeakSet();

function _getPageNumFromNode(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  const wrap = el?.closest?.('.pg-wrap[data-page]');
  return wrap ? parseInt(wrap.dataset.page, 10) : null;
}

function _normRectOverlapMatch(a, b) {
  if (!(a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0)) return false;
  const interW = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const interH = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const minW = Math.min(a.w, b.w);
  const minH = Math.min(a.h, b.h);
  if (interW > minW * 0.2 && interH > minH * 0.2) return true;
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  if (acx >= b.x && acx <= b.x + b.w && acy >= b.y && acy <= b.y + b.h) return true;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  if (bcx >= a.x && bcx <= a.x + a.w && bcy >= a.y && bcy <= a.y + a.h) return true;
  return false;
}

export async function findOverlappingAnnotationsForRange(range) {
  if (!range || range.collapsed || !Array.isArray(S.annotations) || !S.annotations.length || !S.pages) {
    return [];
  }
  const clientRects = Array.from(range.getClientRects()).filter(r => r.width > 1 && r.height > 1);
  if (!clientRects.length) return [];

  const pageSelections = [];
  for (const [k, pg] of Object.entries(S.pages)) {
    const pNum = parseInt(k, 10);
    if (!pg?.rendered || !pg?.txtLayer || !pg?.wrap) continue;
    let intersects = false;
    try {
      intersects = range.intersectsNode(pg.txtLayer) || (!pg.txtLayerPopulated && range.intersectsNode(pg.wrap));
    } catch {
      intersects = false;
    }
    if (!intersects) continue;
    if (!pg.txtLayerPopulated) {
      await ensurePageTextLayer(pNum);
    }

    const wr = pg.wrap.getBoundingClientRect();
    if (!(wr.width > 0 && wr.height > 0)) continue;

    const selNormRects = [];
    for (const cr of clientRects) {
      const left = Math.max(cr.left, wr.left);
      const right = Math.min(cr.right, wr.right);
      const top = Math.max(cr.top, wr.top);
      const bottom = Math.min(cr.bottom, wr.bottom);
      if (right - left <= 1 || bottom - top <= 1) continue;
      selNormRects.push({
        x: (left - wr.left) / wr.width,
        y: (top - wr.top) / wr.height,
        w: (right - left) / wr.width,
        h: (bottom - top) / wr.height,
      });
    }
    if (selNormRects.length) {
      pageSelections.push({ pNum, pg, wr, selNormRects });
    }
  }

  if (!pageSelections.length) return [];

  const { rectToPx, compareAnnotationsReadingOrder, getAnnotationsForPage } = await import('./annotate.js');
  const seenIds = new Set();
  const matchedAnns = [];

  for (const { pNum, pg, wr, selNormRects } of pageSelections) {
    const vpW = pg.viewport?.width || wr.width;
    const vpH = pg.viewport?.height || wr.height;
    if (!(vpW > 0 && vpH > 0)) continue;

    const pageAnns = getAnnotationsForPage(pNum);
    for (const ann of pageAnns) {
      if (ann.page !== pNum || seenIds.has(ann.id)) continue;
      const annNormRects = [];
      for (const r of (ann.rects || [])) {
        if (!r) continue;
        if (r.n === 1) {
          const nr = { x: Number(r.x) || 0, y: Number(r.y) || 0, w: Number(r.w) || 0, h: Number(r.h) || 0 };
          if (nr.w > 0 && nr.h > 0) annNormRects.push(nr);
        } else {
          const px = rectToPx(r, pg.viewport || pg.wrap);
          if (px.w > 0 && px.h > 0) {
            annNormRects.push({ x: px.x / vpW, y: px.y / vpH, w: px.w / vpW, h: px.h / vpH });
          }
        }
      }
      if (!annNormRects.length) continue;

      const hit = selNormRects.some(sr => annNormRects.some(ar => _normRectOverlapMatch(sr, ar)));
      if (hit) {
        seenIds.add(ann.id);
        matchedAnns.push(ann);
      }
    }
  }

  matchedAnns.sort(compareAnnotationsReadingOrder);
  return matchedAnns.map(a => a.id);
}

function _handleCanvasScrollTextUp(evt) {
  if (S.mode !== 'text') return;
  if (evt?.target?.closest?.('#sel-menu, #mass-tag-popover')) return;
  if (evt && _handledTextUpEvents.has(evt)) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString().trim()) return;
  const range = sel.getRangeAt(0);
  const scrollEl = document.getElementById('canvas-scroll');
  if (!scrollEl) return;
  let inScroll = false;
  try {
    inScroll = scrollEl.contains(range.commonAncestorContainer) || range.intersectsNode(scrollEl);
  } catch {
    inScroll = false;
  }
  if (!inScroll) return;
  const startPage = _getPageNumFromNode(range.startContainer);
  onTextUp(startPage, evt);
}

async function onTextUp(pageNum, evt = null) {
  if (S.mode !== 'text') return;
  if (evt?.target?.closest?.('#sel-menu, #mass-tag-popover')) return;
  if (evt) {
    if (_handledTextUpEvents.has(evt)) return;
    _handledTextUpEvents.add(evt);
  }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString().trim()) return;
  const range = sel.getRangeAt(0);
  const rawSelText = sel.toString().trim();
  const clientRects = Array.from(range.getClientRects()).filter(r => r.width > 1 && r.height > 1);
  if (!clientRects.length) return;

  if (pageNum && S.pages?.[pageNum]?.rendered && !S.pages[pageNum].txtLayerPopulated) {
    await ensurePageTextLayer(pageNum);
  }
  const intersectingPages = [];
  for (const [k, pState] of Object.entries(S.pages || {})) {
    if (!pState?.rendered || !pState?.txtLayer) continue;
    const pNum = parseInt(k, 10);
    try {
      const hitsLayer = range.intersectsNode(pState.txtLayer);
      const hitsWrap = !hitsLayer && !pState.txtLayerPopulated && pState.wrap && range.intersectsNode(pState.wrap);
      if (hitsLayer || hitsWrap) {
        if (!pState.txtLayerPopulated) await ensurePageTextLayer(pNum);
        intersectingPages.push(pNum);
      }
    } catch {}
  }
  intersectingPages.sort((a, b) => a - b);

  const startPage = _getPageNumFromNode(range.startContainer) ?? intersectingPages[0] ?? pageNum ?? null;
  const endPage = _getPageNumFromNode(range.endContainer) ?? intersectingPages[intersectingPages.length - 1] ?? startPage;
  const isCrossPage = (startPage != null && endPage != null && startPage !== endPage) || intersectingPages.length > 1;

  if (isCrossPage) {
    const overlappingAnnIds = await findOverlappingAnnotationsForRange(range);
    if (S.mode !== 'text' || !overlappingAnnIds.length) return;

    const lastClient = clientRects[clientRects.length - 1];
    const mx = Math.min(Math.max(10, lastClient.right), window.innerWidth - 170);
    const my = Math.min(Math.max(10, lastClient.bottom + 6), window.innerHeight - 60);

    const confirmBtn = document.getElementById('sel-confirm');
    if (confirmBtn) confirmBtn.style.display = 'none';

    S.pendingEditorSel = null;
    S.pendingSel = { pageNum: startPage, rects: [], text: rawSelText, overlappingAnnIds, multiPage: true };

    const m = document.getElementById('sel-menu');
    if (m) {
      m.style.left = mx + 'px';
      m.style.top  = my + 'px';
      m.classList.add('open');
    }
    const { updateSelMenuMassTagButton } = await import('./tags.js');
    updateSelMenuMassTagButton?.(overlappingAnnIds);
    return;
  }

  const targetPage = startPage ?? pageNum;
  const pg = S.pages[targetPage];
  if (!pg || !pg.wrap) return;
  if (!pg.txtLayerPopulated) {
    await ensurePageTextLayer(targetPage);
  }

  const text = extractRangeTextWithSpacing(range, pg.txtLayer) || rawSelText;
  const wr   = pg.wrap.getBoundingClientRect();
  let rects  = clientRects
    .map(r => ({ x: r.left - wr.left, y: r.top - wr.top, w: r.width, h: r.height }));

  if (!rects.length) return;

  // Merge rects on the same line to create continuous highlights and fix gaps
  rects.sort((a, b) => {
    const over = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return over > Math.min(a.h, b.h) * 0.5 ? a.x - b.x : a.y - b.y;
  });
  const merged = [rects[0]];
  for (let i = 1; i < rects.length; i++) {
    const curr = rects[i];
    const prev = merged[merged.length - 1];

    const over = Math.max(0, Math.min(prev.y + prev.h, curr.y + curr.h) - Math.max(prev.y, curr.y));
    const maxGap = Math.max(32, Math.min(prev.h, curr.h) * 2.2);
    // Must share >50% vertical height (same line) and be horizontally adjacent
    if (over > Math.min(prev.h, curr.h) * 0.5 && curr.x >= prev.x - 4 && curr.x <= prev.x + prev.w + maxGap) {
      const right = Math.max(prev.x + prev.w, curr.x + curr.w);
      const bottom = Math.max(prev.y + prev.h, curr.y + curr.h);
      prev.x = Math.min(prev.x, curr.x);
      prev.y = Math.min(prev.y, curr.y);
      prev.w = right - prev.x;
      prev.h = bottom - prev.y;
    } else {
      merged.push(curr);
    }
  }
  rects = merged;

  const last = rects[rects.length - 1];
  const mx = Math.min(Math.max(10, wr.left + last.x + last.w), window.innerWidth - 170);
  const my = Math.min(Math.max(10, wr.top  + last.y + last.h + 6), window.innerHeight - 60);
  const normRects = (wr.width > 0 && wr.height > 0)
    ? rects.map(r => ({ x: r.x / wr.width, y: r.y / wr.height, w: r.w / wr.width, h: r.h / wr.height, n: 1 }))
    : rects;

  const overlappingAnnIds = await findOverlappingAnnotationsForRange(range);
  if (S.mode !== 'text') return;

  const confirmBtn = document.getElementById('sel-confirm');
  if (confirmBtn) confirmBtn.style.display = '';

  S.pendingEditorSel = null;
  S.pendingSel = { pageNum: targetPage, rects: normRects, text, overlappingAnnIds, multiPage: false };

  const m = document.getElementById('sel-menu');
  if (m) {
    m.style.left = mx + 'px';
    m.style.top  = my + 'px';
    m.classList.add('open');
  }
  const { updateSelMenuMassTagButton } = await import('./tags.js');
  updateSelMenuMassTagButton?.(overlappingAnnIds);
}

// ── Box drag ──
function setupBoxDrag(wrap, pageNum) {
  const ghost = document.getElementById('drag-ghost');
  let sx, sy, dragging = false;

  function onStart(cx, cy) { if (S.mode !== 'box') return; sx = cx; sy = cy; dragging = false; }
  function onMove(cx, cy) {
    if (S.mode !== 'box' || sx === undefined) return;
    if (!dragging && Math.hypot(cx - sx, cy - sy) < 5) return;
    dragging = true;
    ghost.style.cssText = `display:block;left:${Math.min(sx,cx)}px;top:${Math.min(sy,cy)}px;width:${Math.abs(cx-sx)}px;height:${Math.abs(cy-sy)}px`;
  }
  function onEnd(cx, cy) {
    ghost.style.display = 'none';
    if (!dragging) { sx = undefined; return; }
    dragging = false;
    const wr  = wrap.getBoundingClientRect();
    const rx  = Math.min(sx, cx) - wr.left;
    const ry  = Math.min(sy, cy) - wr.top;
    const rw  = Math.abs(cx - sx);
    const rh  = Math.abs(cy - sy);
    sx = undefined;
    if (rw < 5 || rh < 5) return;
    const ti   = S.pages[pageNum]?.textItems || [];
    const text = ti.filter(it => it.x < rx + rw && it.x + it.w > rx && it.y < ry + rh && it.y + it.h > ry)
      .map(it => it.str).join(' ').trim() || '(selected region)';
    const boxRect = (wr.width > 0 && wr.height > 0)
      ? { x: rx / wr.width, y: ry / wr.height, w: rw / wr.width, h: rh / wr.height, n: 1 }
      : { x: rx, y: ry, w: rw, h: rh };
    import('./annotate.js').then(({ createAnnotation }) => createAnnotation(pageNum, [boxRect], text, 'box'));
  }

  wrap.addEventListener('mousedown', e => {
    if (S.mode !== 'box') return;
    e.preventDefault(); onStart(e.clientX, e.clientY);
    const mm = mv => onMove(mv.clientX, mv.clientY);
    const mu = up => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); onEnd(up.clientX, up.clientY); };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  });
  wrap.addEventListener('touchstart', e => { if (S.mode !== 'box') return; const t = e.touches[0]; onStart(t.clientX, t.clientY); }, { passive: true });
  wrap.addEventListener('touchmove',  e => { if (S.mode !== 'box') return; e.preventDefault(); const t = e.touches[0]; onMove(t.clientX, t.clientY); }, { passive: false });
  wrap.addEventListener('touchend',   e => { if (S.mode !== 'box') return; const t = e.changedTouches[0]; onEnd(t.clientX, t.clientY); });
}

// ── Helper: keep active PDF highlighted in sidebar ──
export function updateActivePDF() {
  document.querySelectorAll('.li-pdf').forEach(el =>
    el.classList.toggle('active', el.dataset.id === S.curPDF?.id)
  );
  import('./ui.js').then(m => m.updateAppTitle?.()).catch(()=>{});
  import('./smart-copy.js').then(m => m.updateCopyInstructionButtonState?.()).catch(()=>{});
}

// ── Recent PDFs tracking ──
function pushRecent(pdf) {
  S.recentPDFs = [pdf, ...S.recentPDFs.filter(p => p.id !== pdf.id)].slice(0, 5);
  renderRecentPDFs();
}

function renderRecentPDFs() {
  const list = document.getElementById('recent-list');
  if (!list) return;
  list.innerHTML = '';
  const visible = (Array.isArray(S.recentPDFs) ? S.recentPDFs : [])
    .filter(item => item && !isPdfArchived(item))
    .map(item => (typeof item === 'object' ? item : S.pdfs.find(p => String(p.id) === String(item))))
    .filter(Boolean);
  for (const pdf of visible) {
    const item = document.createElement('div');
    item.className = 'recent-item';
    item.innerHTML = `<span>📄</span><span class="recent-name" title="${pdf.name}">${pdf.name}</span>`;
    item.addEventListener('click', () => openPDFFromLibrary(pdf));
    list.appendChild(item);
  }
  const wrap = document.getElementById('recent-wrap');
  if (wrap) wrap.style.display = visible.length ? 'block' : 'none';
}

export { renderRecentPDFs };
