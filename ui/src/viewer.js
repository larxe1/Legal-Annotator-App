// ═══════════════════════════════════════════════
// VIEWER — PDF rendering + page management
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { syncOK, syncSpin, jumpToPage, setIsJumping, isUserScrolling, onScrollIdle } from './ui.js';
import { dbLoadAnnotations, dbLoadDrawings, dbLoadBookmarks, dbGetSetting } from './db.js';
import { driveFetchPDF } from './drive.js';
import { renderColorDots } from './colors.js';
import { showTablePicker, handlePaste, insertBannerHeader, toggleGrayOut, handleEditorKeyDown, outdentLine, indentLine, buildHighlightDropdown, copyFirstSummaryTable } from './tablepicker.js';
import { openPdfLinkModal, insertWebLink } from './pdflink.js';
import { safeStorageGet, safeStorageSet } from './storage.js';
import { notifyTabOpened, notifyTabClosedToHome, renderStudyDesk } from './goodnotes-ui.js';

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
let _bgRenderGen = 0;
let _activeBlobUrl = null; // kept alive for the full PDF session; revoked on next PDF open

// ── Full PDF Rendering (partial loading / page unrendering disabled so full PDF stays loaded) ──
export function unrenderFarPages() {
  // Intentionally disabled: user requested the full PDF to always load and stay rendered.
}

export function scheduleUnrenderFarPages() {
  // Intentionally disabled: user requested the full PDF to always load and stay rendered.
}

// Cooperative idle scheduler helper: uses requestIdleCallback if available, or polite 35ms timeout
function scheduleIdleWork(fn) {
  if (typeof window.requestIdleCallback === 'function') {
    return window.requestIdleCallback(() => fn(), { timeout: 120 });
  }
  return setTimeout(fn, 35);
}

let _bgTriggerFn = null;

// Wake up background renderer when user stops scrolling
onScrollIdle(() => {
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

    // Search for closest unrendered page to current reading position
    for (let p = 1; p <= S.totalPages; p++) {
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

  if (S.pdfDoc) {
    try { S.pdfDoc.destroy(); } catch {}
  }

  S.curPDF = null;
  S.pdfDoc = null;
  S.totalPages = 0;
  S.pages = {};

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

  updateActivePDF();
  notifyTabClosedToHome();
}

// ── Open PDF from library ──
export async function openPDFFromLibrary(pdfFile, retries = 5) {
  // Capture #welcome template before #canvas-scroll is overwritten
  getWelcomeHTML();
  try {
    const { flushNotepadSave } = await import('./notepad.js');
    await flushNotepadSave();
  } catch {}
  await flushFolderDoc();
  _currentFolderDocId = null;

  // Destroy previous PDF.js document immediately to free RAM/GPU memory
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
  scroll.innerHTML = `<div class="spin-w"><div class="spinner"></div>${retries < 5 ? 'Retrying PDF...' : 'Loading PDF…'}</div>`;

  // Start PDF fetch and Supabase database queries in parallel
  const targetDriveId = pdfFile.drive_file_id || S.pdfs.find(p => p.id === pdfFile.linked_pdf_id)?.drive_file_id;
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
    // All storage (RAM cache + IndexedDB) remains Blob — this is the only copy.
    const buf = await blob.arrayBuffer();
    S.pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
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
      wrap.innerHTML = `<div class="pg-placeholder" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;font-family:'Inter',sans-serif;letter-spacing:.05em">Page ${p}</div>`;
      scroll.appendChild(wrap);
      S.pages[p] = { wrap, rendered: false, rendering: false, viewport: vp1, textItems: [] };
    }

    // Determine starting page:
    // Manual folder-specific default page OVERRIDES automatic last-read bookmark!
    const manualDefault = safeStorageGet('default_page_' + pdfFile.id)
      || (pdfFile.folder_id ? safeStorageGet('default_page_f_' + pdfFile.folder_id + '_' + trueId) : null);

    let startPage;
    let hasManualDefault = false;

    if (manualDefault) {
      const parsedDef = parseInt(manualDefault);
      if (parsedDef >= 1) {
        startPage = Math.min(S.totalPages, parsedDef);
        hasManualDefault = true;
      }
    }

    const savedStart = safeStorageGet('bookmark_' + trueId) || safeStorageGet('bookmark_' + pdfFile.id);
    if (!hasManualDefault) {
      startPage = savedStart ? Math.min(S.totalPages, Math.max(1, parseInt(savedStart))) : 1;
    }

    S.curPage = startPage;
    document.getElementById('pg-input').value = startPage;
    document.getElementById('pg-input').max = S.totalPages;

    // Lock scroll watcher so initial scroll/layout doesn't overwrite bookmark with page 1
    setIsJumping(true);

    // ── INSTANT RESUME: jump to saved page before any rendering happens ──
    // All placeholders are uniform height (vp1.height) so scrollTop can be calculated
    // algebraically in 0ms — no page render required, no layout reflow needed.
    if (startPage > 1) {
      const pageHeightWithGap = vp1.height + 24;
      scroll.scrollTop = 28 + (startPage - 1) * pageHeightWithGap;

      const targetWrap = S.pages[startPage]?.wrap;
      if (targetWrap) {
        targetWrap.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    } else {
      scroll.scrollTop = 0;
    }

    // IntersectionObserver renders pages as they scroll into view (with 1200px pre-render margin)
    _pageObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const pNum = parseInt(entry.target.dataset.page);
        if (entry.isIntersecting) {
          // Tier 1: Newly visible page (highest priority, immediate)
          ensurePageRendered(pNum);

          // Tier 2: Lookahead buffer (prepare adjacent ±1 page so user never scrolls into blanks)
          if (pNum < S.totalPages && !S.pages[pNum + 1]?.rendered && !S.pages[pNum + 1]?.rendering) {
            ensurePageRendered(pNum + 1);
          }
          if (pNum > 1 && !S.pages[pNum - 1]?.rendered && !S.pages[pNum - 1]?.rendering) {
            ensurePageRendered(pNum - 1);
          }
        }
      }
    }, {
      root: scroll,
      rootMargin: '1200px 0px 1200px 0px',
    });

    for (let p = 1; p <= S.totalPages; p++) {
      _pageObserver.observe(S.pages[p].wrap);
    }

    // Eagerly render just the target page so it appears as fast as possible
    await ensurePageRendered(startPage);
    if (startPage > 1) ensurePageRendered(startPage - 1);
    if (startPage < S.totalPages) ensurePageRendered(startPage + 1);

    // Re-verify alignment once target page is rendered to absorb any subpixel variance
    if (startPage > 1) {
      const targetWrap = S.pages[startPage]?.wrap;
      if (targetWrap) {
        targetWrap.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    }

    // Release _isJumping lock once initial layout and scroll have fully settled
    setTimeout(() => {
      setIsJumping(false);
    }, 400);

    // Await parallel DB data queries
    const [, , , cloudDefaultPage, cloudReadPos] = await dbDataPromise;

    // Cross-device sync fallback:
    if (!hasManualDefault && cloudDefaultPage) {
      const parsedCloudDef = parseInt(cloudDefaultPage);
      if (parsedCloudDef >= 1 && parsedCloudDef <= S.totalPages && S.curPage !== parsedCloudDef) {
        safeStorageSet('default_page_' + pdfFile.id, parsedCloudDef);
        if (pdfFile.folder_id) safeStorageSet('default_page_f_' + pdfFile.folder_id + '_' + trueId, parsedCloudDef);
        jumpToPage(parsedCloudDef, false);
      }
    } else if (!hasManualDefault && !savedStart && cloudReadPos) {
      const cPage = parseInt(cloudReadPos);
      if (cPage > 1 && cPage <= S.totalPages && S.curPage === 1) {
        safeStorageSet('bookmark_' + trueId, cPage);
        if (pdfFile.linked_pdf_id) safeStorageSet('bookmark_' + pdfFile.id, cPage);
        jumpToPage(cPage, false);
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

    // Start background progressive full-document renderer (ensures all pages are rendered without scrolling)
    startBackgroundDocRenderer(pdfFile.id);

    // Start background full-document text indexing across all 1000+ pages
    import('./search.js').then(m => m.indexAllPagesText(S.pdfDoc)).catch(() => {});

    // Smart syllabus pre-fetch: silently cache next PDF in folder for 0ms transition
    scheduleNextPdfPrefetch(pdfFile);

    syncOK('Ready');
  } catch (e) {
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
  if (!S.pdfDoc) return;
  const p1 = await S.pdfDoc.getPage(1);
  const vp1 = p1.getViewport({ scale: S.scale });

  // Update sizes on all page wrappers
  for (let p = 1; p <= S.totalPages; p++) {
    const pg = S.pages[p];
    if (pg?.wrap) {
      pg.wrap.style.width = vp1.width + 'px';
      pg.wrap.style.height = vp1.height + 'px';
      if (pg.rendered) {
        pg.rendered = false;
        pg.wrap.innerHTML = `<div class="pg-placeholder" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;font-family:'Inter',sans-serif">Page ${p}</div>`;
      }
    }
  }

  _boxDone.clear();
  _drawDone.clear();
  _textDone.clear();
  _renderedPages.clear();

  // Re-render current page and all remaining pages in the PDF
  await ensurePageRendered(S.curPage);
  if (S.curPage > 1) ensurePageRendered(S.curPage - 1);
  if (S.curPage < S.totalPages) ensurePageRendered(S.curPage + 1);
  startBackgroundDocRenderer(S.curPDF?.id || 'zoom');
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
    S.pages[pageNum] = { wrap, rendered: false, rendering: false, viewport: null, textItems: [] };
  }
  const pgState = S.pages[pageNum];
  if (pgState.rendered || pgState.rendering) return;
  pgState.rendering = true;

  try {
    const page = await S.pdfDoc.getPage(pageNum);
    const vp = page.getViewport({ scale: S.scale });
    pgState.viewport = vp;

    const wrap = pgState.wrap;
    wrap.style.width  = vp.width  + 'px';
    wrap.style.height = vp.height + 'px';
    wrap.innerHTML = ''; // remove placeholder

    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.width  = vp.width;
    pdfCanvas.height = vp.height;

    const drawCanvas = document.createElement('canvas');
    drawCanvas.width  = vp.width;
    drawCanvas.height = vp.height;
    drawCanvas.className   = 'draw-canvas' + (S.mode === 'draw' ? ' active' : '');
    drawCanvas.dataset.page = pageNum;

    const txtLayer = document.createElement('div');
    txtLayer.className = 'txt-layer' + (S.mode === 'text' ? ' sel' : '');
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

    wrap.append(pdfCanvas, annOv, srchOv, txtLayer, drawCanvas);

    // Render PDF page canvas
    await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: vp }).promise;

    // Build text layer.
    // tx[5] is the PDF baseline in CSS pixel coordinates (Y already flipped by vp.transform).
    // CSS renders font baselines at ~0.8× the em-size from the span's top edge, so:
    //   top = tx[5] - fh * 0.8   (places the span so its internal baseline == tx[5])
    // The old code used tx[5] - fh (1.0×), which sat ~15-20% of fh too high vs the canvas.
    const tc = await page.getTextContent();
    const textItems = [];
    for (const item of tc.items) {
      if (!item.str || !item.transform) continue;
      const span = document.createElement('span');
      const tx   = pdfjsLib.Util.transform(vp.transform, item.transform);
      const fh   = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
      const angle = Math.atan2(tx[1], tx[0]);
      const fontFam = resolvePdfFontFamily(tc.styles, item.fontName);
      const targetW = Math.abs(item.width || 0) * S.scale;
      const scaleX  = computeSpanScaleX(item.str, fh, fontFam, targetW);
      span.textContent = item.str;
      span.style.cssText = `left:${tx[4]}px;top:${tx[5] - fh * 0.8}px;font-size:${fh}px;font-family:${fontFam}`;
      const tf = buildSpanTransform(angle, scaleX);
      if (tf) span.style.transform = tf;
      txtLayer.appendChild(span);
      textItems.push({
        str: item.str,
        x: item.transform[4] * S.scale,
        y: vp.height - item.transform[5] * S.scale,
        w: (item.width  || 0) * S.scale,
        h: (item.height || fh) * S.scale,
      });
    }

    pgState.pdfCanvas = pdfCanvas;
    pgState.drawCanvas = drawCanvas;
    pgState.txtLayer = txtLayer;
    pgState.annOv = annOv;
    pgState.srchOv = srchOv;
    pgState.textItems = textItems;
    pgState.rendered = true;

    // Setup listeners & visuals
    setupAllListeners(pageNum);
    applyModeVisuals(pageNum);

    // Redraw annotations on this page
    const { drawAnnotation } = await import('./annotate.js');
    for (const ann of S.annotations.filter(a => a.page === pageNum)) {
      drawAnnotation(ann);
    }

    // Redraw drawings on this page
    if (S.drawData[pageNum]) {
      const { renderCanvas } = await import('./draw.js');
      renderCanvas(drawCanvas, S.drawData[pageNum]);
    }

    // Redraw search highlights on this page
    const { drawSearchHL } = await import('./search.js');
    for (let i = 0; i < S.searchResults.length; i++) {
      const res = S.searchResults[i];
      if (res.page === pageNum) {
        drawSearchHL(res, S.searchIdx === i);
      }
    }

    _renderedPages.add(pageNum);
  } catch (err) {
    console.error(`Failed to render page ${pageNum}:`, err);
  } finally {
    pgState.rendering = false;
  }
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
  document.getElementById('draw-ctrls').classList.toggle('visible', m === 'draw');
  for (const pn of Object.keys(S.pages)) applyModeVisuals(parseInt(pn));
}

function applyModeVisuals(pageNum) {
  const { txtLayer, drawCanvas, wrap } = S.pages[pageNum];
  txtLayer.className = 'txt-layer' + (S.mode === 'text' ? ' sel' : '');
  drawCanvas.className = 'draw-canvas' + (S.mode === 'draw' ? ' active' : '');
  wrap.style.cursor = S.mode === 'draw' ? 'crosshair' : 'default';
}

// ── Set up all listeners once per page ──
function setupAllListeners(pageNum) {
  if (!_textDone.has(pageNum)) {
    _textDone.add(pageNum);
    const { txtLayer } = S.pages[pageNum];
    txtLayer.addEventListener('mouseup', () => { if (S.mode === 'text') onTextUp(pageNum); });
    txtLayer.addEventListener('touchend', () => { if (S.mode === 'text') setTimeout(() => onTextUp(pageNum), 60); });
  }
  if (!_boxDone.has(pageNum)) {
    _boxDone.add(pageNum);
    setupBoxDrag(S.pages[pageNum].wrap, pageNum);
  }
  if (!_drawDone.has(pageNum)) {
    _drawDone.add(pageNum);
    // Use dynamic import to avoid circular dependency
    import('./draw.js').then(({ setupDrawListeners }) => {
      setupDrawListeners(S.pages[pageNum].drawCanvas, pageNum);
    });
  }
}

// ── Text selection highlight ──
function onTextUp(pageNum) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
  const text  = sel.toString().trim();
  const range = sel.getRangeAt(0);
  const pg    = S.pages[pageNum]; if (!pg) return;
  const wr    = pg.wrap.getBoundingClientRect();
  let rects = Array.from(range.getClientRects())
    .filter(r => r.width > 1 && r.height > 1)
    .map(r => ({ x: r.left - wr.left, y: r.top - wr.top, w: r.width, h: r.height }));
  
  if (!rects.length) return;

  // Merge rects on the same line to create continuous highlights and fix gaps
  rects.sort((a,b) => {
    const over = Math.max(0, Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y));
    return over > Math.min(a.h, b.h) * 0.5 ? a.x - b.x : a.y - b.y;
  });
  const merged = [rects[0]];
  for (let i = 1; i < rects.length; i++) {
    const curr = rects[i];
    const prev = merged[merged.length - 1];
    
    const over = Math.max(0, Math.min(prev.y+prev.h, curr.y+curr.h) - Math.max(prev.y, curr.y));
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
  S.pendingSel = { pageNum, rects, text };
  const mx = Math.min(wr.left + last.x + last.w, window.innerWidth - 170);
  const my = Math.min(wr.top  + last.y + last.h + 6, window.innerHeight - 60);
  const m  = document.getElementById('sel-menu');
  m.style.left = mx + 'px';
  m.style.top  = my + 'px';
  m.classList.add('open');
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
    import('./annotate.js').then(({ createAnnotation }) => createAnnotation(pageNum, [{ x: rx, y: ry, w: rw, h: rh }], text, 'box'));
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
}

// ── Recent PDFs tracking ──
function pushRecent(pdf) {
  S.recentPDFs = [pdf, ...S.recentPDFs.filter(p => p.id !== pdf.id)].slice(0, 5);
  renderRecentPDFs();
}

function renderRecentPDFs() {
  const list = document.getElementById('recent-list');
  list.innerHTML = '';
  for (const pdf of S.recentPDFs) {
    const item = document.createElement('div');
    item.className = 'recent-item';
    item.innerHTML = `<span>📄</span><span class="recent-name" title="${pdf.name}">${pdf.name}</span>`;
    item.addEventListener('click', () => openPDFFromLibrary(pdf));
    list.appendChild(item);
  }
  document.getElementById('recent-wrap').style.display = S.recentPDFs.length ? 'block' : 'none';
}

export { renderRecentPDFs };
