// ═══════════════════════════════════════════════
// VIEWER — PDF rendering + page management
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { syncOK, syncSpin, jumpToPage, setIsJumping, isUserScrolling, onScrollIdle } from './ui.js';
import { dbLoadAnnotations, dbLoadDrawings, dbLoadBookmarks, dbGetSetting } from './db.js';
import { driveFetchPDF } from './drive.js';
import { renderColorDots } from './colors.js';
import { showTablePicker, handlePaste, insertBannerHeader, toggleGrayOut, handleEditorKeyDown, outdentLine, indentLine, buildHighlightDropdown } from './tablepicker.js';
import { openPdfLinkModal, insertWebLink } from './pdflink.js';
import { safeStorageGet, safeStorageSet } from './storage.js';

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
      window.__DESKTOP_SQLITE__?.saveFolderNote?.(prevId, text);
      
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

  // Switch to Folder Document Mode
  document.getElementById('content-area').style.display = 'none';
  document.getElementById('folder-doc-viewer').style.display = 'flex';
  const { closeOtherPanels } = await import('./ui.js');
  closeOtherPanels();

  document.getElementById('folder-doc-title').textContent = liveFold.name;
  const ed = document.getElementById('folder-doc-editor');
  const localNotes = safeStorageGet('local_folder_notes_' + liveFold.id, '') || '';
  let sqliteNotes = '';
  if (!liveFold.notes && !localNotes && window.__DESKTOP_SQLITE__?.loadFolderNote) {
    sqliteNotes = (await window.__DESKTOP_SQLITE__.loadFolderNote(liveFold.id)) || '';
  }
  const initialNotes = liveFold.notes || localNotes || sqliteNotes || '';
  if (initialNotes && !liveFold.notes) liveFold.notes = initialNotes;
  if (initialNotes) window.__DESKTOP_SQLITE__?.saveFolderNote?.(liveFold.id, initialNotes);
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

      // Update in-memory state, localStorage, and Native SQLite immediately so folder switching never loses keystrokes
      const currentId = _currentFolderDocId;
      const currentText = ed.innerHTML;
      const f = S.folders.find(x => x.id === currentId);
      if (f) f.notes = currentText;
      if (currentId) {
        safeStorageSet('local_folder_notes_' + currentId, currentText);
        window.__DESKTOP_SQLITE__?.saveFolderNote?.(currentId, currentText);
      }

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

// ── Permanent Page Vault (In-Memory Session DOM Vault + Disk Page Vault) ──
let _pageObserver = null;
let _renderedPages = new Set();
let _bgRenderGen = 0;
let _activeBlobUrl = null;
let _evictTimer = null;
const _pagePreviewCache = new Map();
let _mountedDocId = null; // trueId currently mounted inside #canvas-scroll
const _pdfSessionVault = new Map(); // trueId -> { pdfDoc, totalPages, scale, pages, renderedPages, boxDone, drawDone, textDone, curPage, scrollTop, fragment }

let _welcomeHTML = null;

export function getWelcomeHTML() {
  if (!_welcomeHTML && typeof document !== 'undefined') {
    const el = document.getElementById('welcome');
    if (el) _welcomeHTML = el.outerHTML;
  }
  return _welcomeHTML || '<div id="welcome"></div>';
}

function saveMountedPdfToSessionVault() {
  const scroll = document.getElementById('canvas-scroll');
  if (!_mountedDocId || !S.pdfDoc || !scroll) return;
  // Guard: ONLY vault if scroll actually contains rendered PDF page elements (.pg-wrap)
  if (!scroll.querySelector('.pg-wrap')) {
    _mountedDocId = null;
    return;
  }
  if (_pageObserver) {
    _pageObserver.disconnect();
    _pageObserver = null;
  }
  const frag = document.createDocumentFragment();
  while (scroll.firstChild) {
    frag.appendChild(scroll.firstChild);
  }
  _pdfSessionVault.set(_mountedDocId, {
    pdfDoc: S.pdfDoc,
    totalPages: S.totalPages,
    scale: S.scale,
    pages: S.pages,
    renderedPages: new Set(_renderedPages),
    boxDone: new Set(_boxDone),
    drawDone: new Set(_drawDone),
    textDone: new Set(_textDone),
    curPage: S.curPage || 1,
    scrollTop: scroll.scrollTop || 0,
    fragment: frag,
  });
  _mountedDocId = null;
}

function attachPageObserver(scroll) {
  if (_pageObserver) {
    _pageObserver.disconnect();
  }
  _pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const pNum = parseInt(entry.target.dataset.page);
      setTimeout(() => {
        if (!S.pages?.[pNum] || S.pages[pNum].rendered || S.pages[pNum].rendering) return;
        if (Math.abs(pNum - (S.curPage || 1)) <= 4) {
          ensurePageRendered(pNum);
          if (pNum < S.totalPages && !S.pages[pNum + 1]?.rendered && !S.pages[pNum + 1]?.rendering) {
            ensurePageRendered(pNum + 1);
          }
          if (pNum > 1 && !S.pages[pNum - 1]?.rendered && !S.pages[pNum - 1]?.rendering) {
            ensurePageRendered(pNum - 1);
          }
        }
      }, 30);
    }
  }, {
    root: scroll,
    rootMargin: '800px 0px 800px 0px',
  });

  for (let p = 1; p <= S.totalPages; p++) {
    if (S.pages[p]?.wrap && !S.pages[p].rendered) {
      _pageObserver.observe(S.pages[p].wrap);
    }
  }
}

function updateDesktopEngineStats() {
  if (typeof window.__updateDesktopEngineBadge === 'function') {
    window.__updateDesktopEngineBadge({
      activeCanvases: _renderedPages.size,
      cachedPreviews: _pagePreviewCache.size,
      totalPages: S.totalPages || 0,
    });
  }
}

export function unrenderFarPages() {
  // Disabled: keep all rendered pages permanently loaded so scrolling never jumps or reloads
  updateDesktopEngineStats();
}

export function scheduleUnrenderFarPages() {
  updateDesktopEngineStats();
}

// Cooperative idle scheduler helper: uses polite timeout so scrolling stays 60fps while loading all pages
function scheduleIdleWork(fn) {
  return setTimeout(fn, 8);
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
  const BATCH_CONCURRENCY = 4;

  const renderNextBatch = async () => {
    if (!S.pdfDoc || _bgRenderGen !== myGen) {
      return;
    }

    const cur = S.curPage || 1;
    const candidates = [];

    // Find all unrendered pages sorted by distance from current reading position
    for (let p = 1; p <= S.totalPages; p++) {
      const pg = S.pages?.[p];
      if (pg && !pg.rendered && !pg.rendering) {
        candidates.push({ p, diff: Math.abs(p - cur) });
      }
    }

    if (!candidates.length || _bgRenderGen !== myGen) {
      updateDesktopEngineStats();
      return;
    }

    candidates.sort((a, b) => a.diff - b.diff);
    const batch = candidates.slice(0, BATCH_CONCURRENCY).map(c => c.p);

    if (isUserScrolling() && candidates[0].diff > 2) {
      _bgTriggerFn = () => {
        if (_bgRenderGen === myGen) scheduleIdleWork(renderNextBatch);
      };
      return;
    }

    try {
      await Promise.all(batch.map(pNum => ensurePageRendered(pNum)));
    } catch (e) {
      console.warn('[Background Render] Batch error:', e);
    }

    if (_bgRenderGen === myGen) {
      scheduleIdleWork(renderNextBatch);
    }
  };

  _bgTriggerFn = () => {
    if (_bgRenderGen === myGen) scheduleIdleWork(renderNextBatch);
  };

  scheduleIdleWork(renderNextBatch);
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
export async function closeActivePDF() {
  if (!S.curPDF && !_mountedDocId) return;

  try {
    const { flushNotepadSave, notepadOnPDFChange } = await import('./notepad.js');
    await flushNotepadSave();
    await notepadOnPDFChange(null);
  } catch {}

  await flushFolderDoc();

  if (_mountedDocId && S.pdfDoc) {
    saveMountedPdfToSessionVault();
  }

  S.curPDF = null;
  S.pdfDoc = null;
  S.totalPages = 0;
  S.pages = {};
  _mountedDocId = null;

  const { closeOtherPanels } = await import('./ui.js');
  closeOtherPanels();
  const { clearSearchHighlights } = await import('./search.js');
  clearSearchHighlights();

  const scroll = document.getElementById('canvas-scroll');
  if (scroll) {
    scroll.innerHTML = getWelcomeHTML();
  }

  document.getElementById('folder-doc-viewer').style.display = 'none';
  document.getElementById('content-area').style.display = 'flex';
  document.getElementById('pg-total').textContent = '0';
  document.getElementById('pg-input').value = '1';
  document.getElementById('zoom-lbl').textContent = '100%';

  updateActivePDF();
  window.__updateDesktopEngineBadge?.({ activeCanvases: 0, totalPages: 0 });
}

// ── Open PDF from library ──
export async function openPDFFromLibrary(pdfFile, retries = 5) {
  try {
    const { flushNotepadSave } = await import('./notepad.js');
    await flushNotepadSave();
  } catch {}
  await flushFolderDoc();
  _currentFolderDocId = null;

  const trueId = pdfFile.linked_pdf_id || pdfFile.id;
  const scroll = document.getElementById('canvas-scroll');

  S.curPDF = pdfFile;
  updateActivePDF();

  const { closeOtherPanels } = await import('./ui.js');
  closeOtherPanels();

  const { clearSearchHighlights } = await import('./search.js');
  clearSearchHighlights();

  // Fire notepadOnPDFChange without blocking
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

  // ── FAST PATH 1: Already mounted in #canvas-scroll (e.g. returning from Folder Doc or clicking same PDF) ──
  const isActuallyMounted = scroll && scroll.querySelector('.pg-wrap');
  if (_mountedDocId === trueId && S.pdfDoc && S.totalPages > 0 && Object.keys(S.pages || {}).length === S.totalPages && isActuallyMounted) {
    const manualDefault = safeStorageGet('default_page_' + pdfFile.id)
      || (pdfFile.folder_id ? safeStorageGet('default_page_f_' + pdfFile.folder_id + '_' + trueId) : null);
    if (manualDefault && parseInt(manualDefault) >= 1) {
      const targetP = Math.min(S.totalPages, parseInt(manualDefault));
      if (targetP !== S.curPage) jumpToPage(targetP, false);
    }
    const { redrawAllAnnotations } = await import('./annotate.js');
    const { redrawAllDrawings }    = await import('./draw.js');
    redrawAllAnnotations();
    redrawAllDrawings();
    renderColorDots();
    pushRecent(pdfFile);
    updateDesktopEngineStats();
    if (_renderedPages.size < S.totalPages) {
      startBackgroundDocRenderer(trueId);
    }
    Promise.all([
      dbLoadBookmarks(trueId),
      dbLoadAnnotations(trueId),
      dbLoadDrawings(trueId),
    ]).then(() => {
      if (S.curPDF && (S.curPDF.linked_pdf_id || S.curPDF.id) === trueId) {
        redrawAllAnnotations();
        redrawAllDrawings();
        renderColorDots();
      }
    }).catch(() => {});
    syncOK('Ready');
    return;
  }

  // Save currently mounted PDF (if any) into the Session DOM Vault instead of destroying it!
  if (_mountedDocId && _mountedDocId !== trueId && S.pdfDoc) {
    saveMountedPdfToSessionVault();
  }

  // ── FAST PATH 2: Restore from In-Memory Session DOM Vault (0ms instant restore of all 300 pages!) ──
  if (_pdfSessionVault.has(trueId)) {
    const vaulted = _pdfSessionVault.get(trueId);
    _pdfSessionVault.delete(trueId);

    // Verify vaulted fragment actually contains PDF pages (.pg-wrap)
    const hasVaultedPages = vaulted && vaulted.fragment && vaulted.fragment.querySelector && vaulted.fragment.querySelector('.pg-wrap');
    if (hasVaultedPages) {
      S.pdfDoc = vaulted.pdfDoc;
      S.totalPages = vaulted.totalPages;
      S.scale = vaulted.scale;
      S.pages = vaulted.pages;
      S.curPage = vaulted.curPage || 1;

      _renderedPages = new Set(vaulted.renderedPages);
      _boxDone.clear(); vaulted.boxDone.forEach(x => _boxDone.add(x));
      _drawDone.clear(); vaulted.drawDone.forEach(x => _drawDone.add(x));
      _textDone.clear(); vaulted.textDone.forEach(x => _textDone.add(x));

      scroll.innerHTML = '';
      scroll.appendChild(vaulted.fragment);
      _mountedDocId = trueId;

      document.getElementById('pg-total').textContent = S.totalPages;
      document.getElementById('pg-input').max = S.totalPages;
      document.getElementById('pg-input').value = S.curPage;

      setIsJumping(true);
      const manualDefault = safeStorageGet('default_page_' + pdfFile.id)
        || (pdfFile.folder_id ? safeStorageGet('default_page_f_' + pdfFile.folder_id + '_' + trueId) : null);
      if (manualDefault && parseInt(manualDefault) >= 1) {
        const targetP = Math.min(S.totalPages, parseInt(manualDefault));
        S.curPage = targetP;
        document.getElementById('pg-input').value = targetP;
        S.pages[targetP]?.wrap?.scrollIntoView({ behavior: 'auto', block: 'start' });
      } else {
        scroll.scrollTop = vaulted.scrollTop || 0;
      }
      setTimeout(() => setIsJumping(false), 250);

      attachPageObserver(scroll);

      const { redrawAllAnnotations } = await import('./annotate.js');
      const { redrawAllDrawings }    = await import('./draw.js');
      redrawAllAnnotations();
      redrawAllDrawings();
      renderColorDots();
      pushRecent(pdfFile);
      updateDesktopEngineStats();

      if (_renderedPages.size < S.totalPages) {
        startBackgroundDocRenderer(trueId);
      }

      Promise.all([
        dbLoadBookmarks(trueId),
        dbLoadAnnotations(trueId),
        dbLoadDrawings(trueId),
      ]).then(() => {
        if (S.curPDF && (S.curPDF.linked_pdf_id || S.curPDF.id) === trueId) {
          redrawAllAnnotations();
          redrawAllDrawings();
          renderColorDots();
        }
      }).catch(() => {});
      syncOK('Ready');
      return;
    } else {
      _mountedDocId = null;
    }
  }

  scroll.innerHTML = `<div class="spin-w"><div class="spinner"></div>${retries < 5 ? 'Retrying PDF...' : 'Loading PDF…'}</div>`;

  // Start PDF fetch and Supabase/SQLite database queries in parallel
  const targetDriveId = pdfFile.drive_file_id || S.pdfs.find(p => p.id === pdfFile.linked_pdf_id)?.drive_file_id;
  const pdfFetchPromise = pdfFile._localBlob
    ? Promise.resolve(pdfFile._localBlob)
    : driveFetchPDF(targetDriveId, (pct, loadedMB, totalMB) => {
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
    pdfFile._isLocalOnly ? Promise.resolve(null) : dbGetSetting('default_page_' + pdfFile.id).catch(() => null),
    pdfFile._isLocalOnly ? Promise.resolve(null) : dbGetSetting('read_pos_' + trueId).catch(() => null),
  ]);

  try {
    const blob = await pdfFetchPromise;

    // Convert Blob → ArrayBuffer once here for PDF.js (unavoidable).
    // All storage (RAM cache + IndexedDB) remains Blob — this is the only copy.
    const buf = await blob.arrayBuffer();
    if (window.__DESKTOP_PDFIUM__?.openPdf) {
      await window.__DESKTOP_PDFIUM__.openPdf(trueId, buf, pdfFile._localPath || null).catch(e => {
        console.warn('[Desktop PDFium] openPdf fallback to PDF.js:', e);
      });
    }
    S.pdfDoc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    S.totalPages = S.pdfDoc.numPages;
    _mountedDocId = trueId;
    document.getElementById('pg-total').textContent = S.totalPages;
    document.getElementById('pg-input').value = 1;
    document.getElementById('pg-input').max   = S.totalPages;

    scroll.innerHTML = '';
    S.pages = {};
    _boxDone.clear();
    _drawDone.clear();
    _textDone.clear();
    _renderedPages.clear();
    _pagePreviewCache.clear();

    // Get page 1 viewport and page 2 (body page) viewport so cover-page size differences never cause layout shifts
    const p1 = await S.pdfDoc.getPage(1);
    const vp1 = p1.getViewport({ scale: S.scale });
    let vpBody = vp1;
    if (S.totalPages >= 2) {
      try {
        const p2 = await S.pdfDoc.getPage(2);
        vpBody = p2.getViewport({ scale: S.scale });
      } catch {}
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

    // Instantly create fixed-size placeholders for all pages (flex-shrink: 0 in CSS prevents any shrinking)
    for (let p = 1; p <= S.totalPages; p++) {
      const vpInit = p === 1 ? vp1 : vpBody;
      const wrap = document.createElement('div');
      wrap.className = 'pg-wrap';
      wrap.dataset.page = p;
      wrap.style.width = vpInit.width + 'px';
      wrap.style.height = vpInit.height + 'px';
      wrap.style.minHeight = vpInit.height + 'px';
      wrap.style.flexShrink = '0';
      wrap.innerHTML = `<div class="pg-placeholder" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;font-family:'Inter',sans-serif;letter-spacing:.05em">Page ${p}</div>`;
      scroll.appendChild(wrap);
      S.pages[p] = { wrap, rendered: false, rendering: false, viewport: vpInit, textItems: [] };
    }

    S.curPage = startPage;
    document.getElementById('pg-input').value = startPage;
    document.getElementById('pg-input').max = S.totalPages;

    // Lock scroll watcher so initial scroll/layout doesn't overwrite bookmark with page 1
    setIsJumping(true);

    // ── INSTANT RESUME: jump to saved page before any rendering happens ──
    if (startPage > 1) {
      const targetWrap = S.pages[startPage]?.wrap;
      if (targetWrap) {
        targetWrap.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    } else {
      scroll.scrollTop = 0;
    }

    attachPageObserver(scroll);

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

    // Start background renderer to load all pages outward from current position
    startBackgroundDocRenderer(trueId);

    // Smart syllabus pre-fetch: silently cache next PDF in folder for 0ms transition
    scheduleNextPdfPrefetch(pdfFile);

    updateDesktopEngineStats();
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
  let vpBody = vp1;
  if (S.totalPages >= 2) {
    try {
      const p2 = await S.pdfDoc.getPage(2);
      vpBody = p2.getViewport({ scale: S.scale });
    } catch {}
  }

  _pagePreviewCache.clear();

  // Update sizes on all page wrappers
  for (let p = 1; p <= S.totalPages; p++) {
    const vpInit = p === 1 ? vp1 : vpBody;
    const pg = S.pages[p];
    if (pg?.wrap) {
      pg.wrap.style.width = vpInit.width + 'px';
      pg.wrap.style.height = vpInit.height + 'px';
      pg.wrap.style.minHeight = vpInit.height + 'px';
      if (pg.rendered) {
        if (pg.pdfCanvas) { pg.pdfCanvas.width = 0; pg.pdfCanvas.height = 0; }
        if (pg.drawCanvas) { pg.drawCanvas.width = 0; pg.drawCanvas.height = 0; }
        pg.rendered = false;
        pg.wrap.innerHTML = `<div class="pg-placeholder" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;font-family:'Inter',sans-serif">Page ${p}</div>`;
      }
    }
  }

  _boxDone.clear();
  _drawDone.clear();
  _textDone.clear();
  _renderedPages.clear();

  // Re-render current page and nearby lookahead
  await ensurePageRendered(S.curPage);
  if (S.curPage > 1) ensurePageRendered(S.curPage - 1);
  if (S.curPage < S.totalPages) ensurePageRendered(S.curPage + 1);
  startBackgroundDocRenderer(_mountedDocId || S.curPDF?.id || 'zoom');
}

// ── Render a single page on-demand (Permanent Disk Page Vault + Native PDFium) ──
export async function ensurePageRendered(pageNum, container = null) {
  if (!S.pdfDoc) return;
  const scroll = container || document.getElementById('canvas-scroll');
  if (!S.pages[pageNum]) {
    if (!scroll) return;
    const wrap = document.createElement('div');
    wrap.className = 'pg-wrap';
    wrap.dataset.page = pageNum;
    wrap.style.flexShrink = '0';
    scroll.appendChild(wrap);
    S.pages[pageNum] = { wrap, rendered: false, rendering: false, viewport: null, textItems: [] };
  }
  const pgState = S.pages[pageNum];
  if (pgState.rendered || pgState.rendering) return;
  pgState.rendering = true;

  try {
    const trueId = _mountedDocId || S.curPDF?.linked_pdf_id || S.curPDF?.id;
    const scaleKey = 'v2_' + Math.round(S.scale * 100);

    // 1. Check Permanent Disk Page Vault for pre-extracted text & dimensions (skips S.pdfDoc.getPage & getTextContent!)
    let cachedText = null;
    if (trueId && window.__DESKTOP_PDFIUM__?.getPageText) {
      cachedText = await window.__DESKTOP_PDFIUM__.getPageText(trueId, pageNum, scaleKey);
    }

    let page = null;
    let vp = null;
    if (cachedText && cachedText.w && cachedText.h && Array.isArray(cachedText.spans)) {
      vp = { width: cachedText.w, height: cachedText.h, scale: S.scale };
    } else {
      page = await S.pdfDoc.getPage(pageNum);
      vp = page.getViewport({ scale: S.scale });
    }
    pgState.viewport = vp;

    const wrap = pgState.wrap;
    const oldH = parseFloat(wrap.style.height) || wrap.offsetHeight || vp.height;
    const deltaH = vp.height - oldH;

    wrap.style.width      = vp.width  + 'px';
    wrap.style.height     = vp.height + 'px';
    wrap.style.minHeight  = vp.height + 'px';
    wrap.style.flexShrink = '0';

    // If a page above the current scroll position has a different height than the placeholder,
    // immediately compensate scrollTop by deltaH so the visible page never jumps!
    if (scroll && scroll.offsetParent !== null && Math.abs(deltaH) > 0.5 && wrap.offsetTop < scroll.scrollTop) {
      scroll.scrollTop += deltaH;
    }

    wrap.innerHTML = ''; // remove placeholder

    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.width  = vp.width;
    pdfCanvas.height = vp.height;
    pdfCanvas.style.width  = vp.width + 'px';
    pdfCanvas.style.height = vp.height + 'px';

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

    // 2. Render PDF page canvas: loads straight from Permanent Disk Page Vault (or renders via Native C++ PDFium and saves to vault)
    let renderedByNativePdfium = false;
    if (trueId && window.__DESKTOP_PDFIUM__?.renderPageToCanvas) {
      try {
        renderedByNativePdfium = await window.__DESKTOP_PDFIUM__.renderPageToCanvas(
          trueId,
          pageNum,
          pdfCanvas,
          Math.round(vp.width),
          Math.round(vp.height)
        );
      } catch (e) {
        console.warn('[Desktop PDFium] Page render fallback:', e);
      }
    }
    if (!renderedByNativePdfium) {
      if (!page) {
        page = await S.pdfDoc.getPage(pageNum);
        vp = page.getViewport({ scale: S.scale });
      }
      await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: vp }).promise;
    }

    // 3. Build text layer (from Disk Page Vault if cached, otherwise extract once and save to Disk Page Vault)
    let textItems = [];
    if (cachedText && Array.isArray(cachedText.spans)) {
      const txtFrag = document.createDocumentFragment();
      for (const sp of cachedText.spans) {
        const span = document.createElement('span');
        span.textContent = sp.s;
        span.style.cssText = `left:${sp.l}px;top:${sp.t}px;font-size:${sp.fs}px;font-family:${sp.ff || 'sans-serif'}`;
        const tf = buildSpanTransform(sp.a, sp.sx);
        if (tf) span.style.transform = tf;
        txtFrag.appendChild(span);
      }
      txtLayer.appendChild(txtFrag);
      textItems = cachedText.textItems || [];
    } else {
      if (!page) {
        page = await S.pdfDoc.getPage(pageNum);
        vp = page.getViewport({ scale: S.scale });
      }
      const tc = await page.getTextContent();
      const spansToVault = [];
      const txtFrag = document.createDocumentFragment();
      for (const item of tc.items) {
        if (!item.str || !item.transform) continue;
        const span = document.createElement('span');
        const tx   = pdfjsLib.Util.transform(vp.transform, item.transform);
        const fh   = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
        const angle = Math.atan2(tx[1], tx[0]);
        const leftPx = tx[4];
        const topPx = tx[5] - fh * 0.8;
        const fontFam = resolvePdfFontFamily(tc.styles, item.fontName);
        const targetW = Math.abs(item.width || 0) * S.scale;
        const scaleX  = computeSpanScaleX(item.str, fh, fontFam, targetW);
        span.textContent = item.str;
        span.style.cssText = `left:${leftPx}px;top:${topPx}px;font-size:${fh}px;font-family:${fontFam}`;
        const tf = buildSpanTransform(angle, scaleX);
        if (tf) span.style.transform = tf;
        txtFrag.appendChild(span);
        spansToVault.push({
          s: item.str,
          l: Math.round(leftPx * 100) / 100,
          t: Math.round(topPx * 100) / 100,
          fs: Math.round(fh * 100) / 100,
          ff: fontFam,
          a: angle ? Math.round(angle * 10000) / 10000 : 0,
          sx: scaleX,
        });
        textItems.push({
          str: item.str,
          x: item.transform[4] * S.scale,
          y: vp.height - item.transform[5] * S.scale,
          w: (item.width  || 0) * S.scale,
          h: (item.height || fh) * S.scale,
        });
      }
      txtLayer.appendChild(txtFrag);
      if (trueId && window.__DESKTOP_PDFIUM__?.savePageText) {
        window.__DESKTOP_PDFIUM__.savePageText(trueId, pageNum, scaleKey, {
          w: vp.width,
          h: vp.height,
          spans: spansToVault,
          textItems,
        });
      }
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
    updateDesktopEngineStats();
    scheduleUnrenderFarPages();
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
  if (!paneState.pages) paneState.pages = {};
  const existing = paneState.pages[pageNum];
  if (existing?.rendered || existing?.rendering) return;
  if (existing) existing.rendering = true;

  const scale = paneState.scale || S.scale;
  const scaleKey = 'v2_' + Math.round(scale * 100);
  const trueId = paneState.pdfFile?.linked_pdf_id || paneState.pdfFile?.id || null;

  try {
    let cachedText = null;
    if (trueId && window.__DESKTOP_PDFIUM__?.getPageText) {
      cachedText = await window.__DESKTOP_PDFIUM__.getPageText(trueId, pageNum, scaleKey);
    }

    let page = null;
    let vp = null;
    if (cachedText && cachedText.w > 0 && cachedText.h > 0) {
      vp = { width: cachedText.w, height: cachedText.h };
    } else {
      page = await pdfDocObj.getPage(pageNum);
      vp = page.getViewport({ scale });
    }

    let wrap = existing?.wrap;
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'pg-wrap';
      wrap.dataset.page = pageNum;
      container.appendChild(wrap);
    }
    wrap.innerHTML = '';
    wrap.style.width  = vp.width  + 'px';
    wrap.style.height = vp.height + 'px';

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const pdfCanvas  = document.createElement('canvas');
    pdfCanvas.width  = Math.round(vp.width * dpr);
    pdfCanvas.height = Math.round(vp.height * dpr);
    pdfCanvas.style.width  = vp.width  + 'px';
    pdfCanvas.style.height = vp.height + 'px';

    const drawCanvas  = document.createElement('canvas');
    drawCanvas.width  = vp.width;
    drawCanvas.height = vp.height;
    drawCanvas.className = 'draw-canvas';

    const txtLayer = document.createElement('div');
    txtLayer.className = 'txt-layer';
    txtLayer.style.width  = vp.width  + 'px';
    txtLayer.style.height = vp.height + 'px';

    const annOv = document.createElement('div');
    annOv.className = 'ann-ov';
    annOv.dataset.page = pageNum;
    annOv.style.width  = vp.width  + 'px';
    annOv.style.height = vp.height + 'px';

    wrap.append(pdfCanvas, annOv, txtLayer, drawCanvas);

    let renderedViaNative = false;
    if (window.__DESKTOP_PDFIUM__ && trueId) {
      try {
        renderedViaNative = await window.__DESKTOP_PDFIUM__.renderPageToCanvas(
          trueId,
          pageNum,
          pdfCanvas,
          vp.width * dpr,
          vp.height * dpr
        );
      } catch {
        renderedViaNative = false;
      }
    }

    if (!renderedViaNative) {
      if (!page) {
        page = await pdfDocObj.getPage(pageNum);
        vp = page.getViewport({ scale });
      }
      pdfCanvas.width  = vp.width;
      pdfCanvas.height = vp.height;
      await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: vp }).promise;
    }

    if (cachedText && Array.isArray(cachedText.spans)) {
      const frag = document.createDocumentFragment();
      for (const sp of cachedText.spans) {
        const span = document.createElement('span');
        span.textContent = sp.s;
        span.style.cssText = `left:${sp.l}px;top:${sp.t}px;font-size:${sp.fs}px;font-family:${sp.ff || 'sans-serif'}`;
        const tf = buildSpanTransform(sp.a, sp.sx);
        if (tf) span.style.transform = tf;
        frag.appendChild(span);
      }
      txtLayer.appendChild(frag);
    } else {
      if (!page) {
        page = await pdfDocObj.getPage(pageNum);
        vp = page.getViewport({ scale });
      }
      const tc = await page.getTextContent();
      const spansToVault = [];
      const textItems = [];
      const frag = document.createDocumentFragment();
      for (const item of tc.items) {
        if (!item.str || !item.transform) continue;
        const span = document.createElement('span');
        const tx   = pdfjsLib.Util.transform(vp.transform, item.transform);
        const fh   = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
        const angle = Math.atan2(tx[1], tx[0]);
        const leftPx = tx[4];
        const topPx = tx[5] - fh * 0.8;
        const fontFam = resolvePdfFontFamily(tc.styles, item.fontName);
        const targetW = Math.abs(item.width || 0) * scale;
        const scaleX  = computeSpanScaleX(item.str, fh, fontFam, targetW);
        span.textContent = item.str;
        span.style.cssText = `left:${leftPx}px;top:${topPx}px;font-size:${fh}px;font-family:${fontFam}`;
        const tf = buildSpanTransform(angle, scaleX);
        if (tf) span.style.transform = tf;
        frag.appendChild(span);
        spansToVault.push({
          s: item.str,
          l: Math.round(leftPx * 100) / 100,
          t: Math.round(topPx * 100) / 100,
          fs: Math.round(fh * 100) / 100,
          ff: fontFam,
          a: angle ? Math.round(angle * 10000) / 10000 : 0,
          sx: scaleX,
        });
        textItems.push({
          str: item.str,
          x: item.transform[4] * scale,
          y: vp.height - item.transform[5] * scale,
          w: (item.width  || 0) * scale,
          h: (item.height || fh) * scale,
        });
      }
      txtLayer.appendChild(frag);
      if (trueId && window.__DESKTOP_PDFIUM__?.savePageText) {
        window.__DESKTOP_PDFIUM__.savePageText(trueId, pageNum, scaleKey, {
          w: vp.width,
          h: vp.height,
          spans: spansToVault,
          textItems,
        });
      }
    }

    paneState.pages[pageNum] = {
      wrap,
      pdfCanvas,
      drawCanvas,
      txtLayer,
      annOv,
      viewport: vp,
      rendered: true,
      rendering: false,
    };
  } catch (err) {
    console.warn(`[DualView] Failed to render page ${pageNum}:`, err);
    if (paneState.pages[pageNum]) paneState.pages[pageNum].rendering = false;
  }
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
