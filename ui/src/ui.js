// ═══════════════════════════════════════════════
// UI — toast, autosave, sync status, zoom, nav,
//      modals, keyboard shortcuts, export
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { safeStorageSet, safeStorageGet, safeStorageRemove } from './storage.js';
import { handleEditorKeyDown } from './tablepicker.js';
import { getColorCategoryForHex } from './colors.js';

// ── Sync status ──
const $sdot = () => document.getElementById('sdot');
const $stxt = () => document.getElementById('stxt');
export const syncSpin = (m) => { $sdot().className = 'sdot spin'; $stxt().textContent = m || 'Working…'; };
export const syncOK   = (m) => { $sdot().className = 'sdot ok';   $stxt().textContent = m || 'Synced'; };
export const syncErr  = (m) => { $sdot().className = 'sdot err';  $stxt().textContent = m || 'Error'; };

// ── Auto-save indicator ──
let autosaveTimer = null;
export function autosave(state) {
  const lbl = document.getElementById('autosave-lbl');
  if (!lbl) return;
  clearTimeout(autosaveTimer);
  lbl.className = '';
  if (state === 'saving') {
    lbl.textContent = '↑ Saving…';
    lbl.className = 'saving';
    // Safety watchdog: never stay stuck on "Saving…" forever if a network call stalls or a caller exits early
    autosaveTimer = setTimeout(() => {
      lbl.textContent = '✓ Saved';
      lbl.className = 'saved';
      autosaveTimer = setTimeout(() => { lbl.textContent = ''; lbl.className = ''; }, 2000);
    }, 6000);
  } else if (state === 'saved') {
    lbl.textContent = '✓ Saved';
    lbl.className = 'saved';
    autosaveTimer = setTimeout(() => { lbl.textContent = ''; lbl.className = ''; }, 2500);
  } else if (state === 'err') {
    lbl.textContent = '✗ Error';
    lbl.className = 'err';
    autosaveTimer = setTimeout(() => { lbl.textContent = ''; lbl.className = ''; }, 4000);
  }
}

// ── Error Formatting & Recording (Option 1 & 2) ──
S.lastError = null;

export function formatError(err, context = '') {
  if (!err) return null;
  let code = err.code || err.status || '';
  let message = err.message || err.error_description || (typeof err === 'string' ? err : 'Unknown error');
  let details = err.details || err.hint || '';
  
  // Extract Postgres error code from string if present
  if (!code && message.includes('22P02')) code = '22P02';
  if (!code && message.includes('23505')) code = '23505';
  if (!code && message.includes('42501')) code = '42501';
  if (!code && message.includes('401')) code = '401';
  if (!code && message.includes('403')) code = '403';
  if (!code && message.includes('404')) code = '404';

  const codePrefix = code ? `[${code}] ` : '';
  const ctxPrefix = context ? `${context}: ` : '';
  
  return {
    code: code || 'ERR',
    message: message,
    details: details,
    display: `${ctxPrefix}${codePrefix}${message}`,
    time: new Date().toLocaleTimeString(),
    context
  };
}

export function recordError(err, context = '') {
  const formatted = formatError(err, context);
  if (formatted) {
    S.lastError = formatted;
    console.error(`[LegalAnnotator Error ${formatted.code}]`, context, err);
  }
  return formatted;
}

export function toastError(err, context = 'Error') {
  const rec = recordError(err, context);
  if (rec) toast(`⚠️ ${rec.display}`);
  else toast(`⚠️ ${context}`);
  return rec;
}

// ── Toast ──
let toastTimer = null;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ── Modal open/close ──
export function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
export function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

export function closeOtherPanels(exceptId = null) {
  if (exceptId !== 'notepad-panel') {
    import('./notepad.js').then(m => m.flushNotepadSave?.()).catch(() => {});
  }

  const panelIds = ['notepad-panel', 'ann-panel', 'search-panel', 'tags-panel'];
  panelIds.forEach(id => {
    if (id !== exceptId) {
      document.getElementById(id)?.classList.remove('open');
    }
  });

  // These modules may have internal cleanup state beyond just the CSS class
  if (exceptId !== 'ann-panel') {
    import('./annotate.js').then(m => m.closeAnnPanel?.()).catch(() => {});
  }
  if (exceptId !== 'search-panel') {
    import('./search.js').then(m => m.closeSearch?.()).catch(() => {});
  }
}


// ── Sync & Error Diagnostics Modal Wiring ──
export function openSyncDiagnosticsModal() {
  import('./outbox.js').then(outbox => {
    const queue = outbox.getOutboxQueue();
    const netStatus = document.getElementById('diag-net-status');
    const queueCount = document.getElementById('diag-queue-count');
    const errTime = document.getElementById('diag-err-time');
    const errCode = document.getElementById('diag-err-code');
    const errMsg = document.getElementById('diag-err-msg');
    const errDetailsWrap = document.getElementById('diag-err-details-wrap');
    const errDetails = document.getElementById('diag-err-details');

    if (netStatus) {
      netStatus.textContent = navigator.onLine ? 'Online' : 'Offline';
      netStatus.style.color = navigator.onLine ? 'var(--green)' : 'var(--red)';
    }

    if (queueCount) {
      queueCount.textContent = `${queue.length} edit${queue.length === 1 ? '' : 's'}`;
      queueCount.style.color = queue.length > 0 ? 'var(--gold)' : 'var(--green)';
    }

    if (S.lastError) {
      if (errTime) errTime.textContent = S.lastError.time || '';
      if (errCode) errCode.textContent = S.lastError.code || 'ERR';
      if (errMsg) errMsg.textContent = S.lastError.display || S.lastError.message || 'Error occurred';
      if (errDetails && S.lastError.details) {
        errDetails.textContent = S.lastError.details;
        errDetailsWrap.style.display = 'block';
      } else if (errDetailsWrap) {
        errDetailsWrap.style.display = 'none';
      }
    } else {
      if (errTime) errTime.textContent = '';
      if (errCode) errCode.textContent = 'None';
      if (errMsg) errMsg.textContent = 'No errors recorded. Everything is operating normally.';
      if (errDetailsWrap) errDetailsWrap.style.display = 'none';
    }

    openModal('mo-sync-diag');
  });
}
window.openSyncDiagnosticsModal = openSyncDiagnosticsModal;
window.openSyncDiagnostics = openSyncDiagnosticsModal;

export function initSyncDiagnostics() {
  const syncBar = document.getElementById('sync-bar');
  if (syncBar) {
    syncBar.addEventListener('click', () => {
      openSyncDiagnosticsModal();
    });
  }

  // Force Sync buttons (Diagnostics modal, Settings modal)
  ['diag-btn-force-sync', 'settings-btn-force-sync'].forEach(btnId => {
    document.getElementById(btnId)?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { forceSyncAll } = await import('./notepad.js');
      await forceSyncAll();
    });
  });

  // Copy Error button
  document.getElementById('diag-btn-copy')?.addEventListener('click', () => {
    import('./outbox.js').then(outbox => {
      const payload = {
        time: S.lastError?.time || new Date().toLocaleTimeString(),
        code: S.lastError?.code || 'None',
        context: S.lastError?.context || '',
        message: S.lastError?.message || 'No error recorded',
        details: S.lastError?.details || '',
        online: navigator.onLine,
        pendingQueueCount: outbox.getOutboxQueue().length,
        pendingQueue: outbox.getOutboxQueue()
      };
      navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(() => {
        toast('📋 Copied error diagnostics to clipboard!');
      }).catch(() => {
        toast('Failed to copy to clipboard.');
      });
    });
  });

  // Clear Queue button
  document.getElementById('diag-btn-clear-queue')?.addEventListener('click', () => {
    safeStorageRemove('offline_outbox_queue');
    import('./outbox.js').then(outbox => {
      outbox.updateOutboxUI();
      closeModal('mo-sync-diag');
      toast('🗑 Offline queue reset.');
    });
  });
}

// Wire all [data-close] buttons and backdrop clicks
export function initModals() {
  initSyncDiagnostics();

  document.querySelectorAll('[data-close]').forEach(b =>
    b.addEventListener('click', () => closeModal(b.dataset.close))
  );

  document.querySelectorAll('.modal-ov').forEach(ov => {
    let isMouseDownOnBackdrop = false;

    ov.addEventListener('mousedown', e => {
      // Only true if the click began directly on the dark overlay (not inside the modal box)
      isMouseDownOnBackdrop = (e.target === ov);
    });

    ov.addEventListener('click', e => {
      // Only close if the mouse press originated and released on the overlay itself
      if (e.target === ov && isMouseDownOnBackdrop) {
        closeModal(ov.id);
      }
      isMouseDownOnBackdrop = false;
    });
  });
}

// ── Sidebar (Auto-Hide, Hover-Peek & Mobile) ──
let _hoverCloseTimer = null;
let _sidebarResizing = false;

function _isCtxMenuOpen(el) {
  if (!el) return false;
  if (el.hidden) return false;
  if (el.classList.contains('open') || el.classList.contains('show')) return true;
  const disp = el.style.display;
  return Boolean(disp && disp !== 'none');
}

function _isSidebarBusy() {
  if (_sidebarResizing) return true;
  if (document.getElementById('lib-resize-handle')?.classList.contains('resizing')) return true;
  return ['lib-ctx-menu', 'folder-ctx-menu', 'multi-folder-ctx-menu'].some(
    id => _isCtxMenuOpen(document.getElementById(id))
  );
}

export function isSidebarAutoHide() {
  return safeStorageGet('sidebar_autohide', 'false') === 'true';
}

export function setSidebarAutoHide(enabled, showNotification = true) {
  safeStorageSet('sidebar_autohide', String(enabled));
  const app = document.getElementById('app');
  const pinBtn = document.getElementById('btn-pin-sidebar');
  if (app) {
    app.classList.toggle('sidebar-autohide', enabled);
    app.setAttribute('data-rail-autohide', enabled ? 'true' : 'false');
  }

  if (pinBtn) {
    pinBtn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-pin"/></svg>';
    pinBtn.setAttribute('aria-pressed', String(!enabled));
    pinBtn.classList.toggle('is-autohide', enabled);
    pinBtn.style.color = '';
    pinBtn.style.borderColor = '';
    if (enabled) {
      pinBtn.title = 'Sidebar: Auto-Hide Mode (Hover left edge to show) — Click to Pin';
      pinBtn.setAttribute('aria-label', 'Auto-Hide active, click to Pin sidebar');
    } else {
      pinBtn.title = 'Sidebar: Pinned (Always visible) — Click to Auto-Hide';
      pinBtn.setAttribute('aria-label', 'Sidebar pinned, click to enable Auto-Hide');
    }
  }

  if (enabled) {
    closeSidebar();
    if (showNotification) toast('Sidebar Auto-Hide active (hover left edge to reveal)');
  } else {
    document.getElementById('lib-side')?.classList.remove('hover-open');
    if (showNotification) toast('Sidebar pinned (always visible)');
  }
}

export function openSidebar() {
  document.getElementById('lib-side')?.classList.add('open');
  document.getElementById('lib-backdrop')?.classList.add('open');
}

export function closeSidebar() {
  const side = document.getElementById('lib-side');
  if (side) {
    side.classList.remove('open');
    side.classList.remove('hover-open');
  }
  document.getElementById('lib-backdrop')?.classList.remove('open');
}

export function toggleSidebar() {
  const side = document.getElementById('lib-side');
  if (side?.classList.contains('open') || side?.classList.contains('hover-open')) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

export function initSidebar() {
  // 1. Initialize auto-hide state from storage
  const isAutoHide = isSidebarAutoHide();
  setSidebarAutoHide(isAutoHide, false);

  // 2. Pin / Auto-Hide toggle button
  document.getElementById('btn-pin-sidebar')?.addEventListener('click', () => {
    const current = isSidebarAutoHide();
    setSidebarAutoHide(!current, true);
  });

  // 3. Mobile / Desktop hamburger toggle
  document.getElementById('mob-menu-btn')?.addEventListener('click', toggleSidebar);
  document.getElementById('lib-close')?.addEventListener('click', closeSidebar);
  document.getElementById('lib-backdrop')?.addEventListener('click', closeSidebar);

  // 4. Hover peek trigger zone on the far-left edge
  const hoverZone = document.getElementById('lib-hover-zone');
  const libSide = document.getElementById('lib-side');

  function handleHoverEnter() {
    if (!isSidebarAutoHide()) return;
    if (_hoverCloseTimer) {
      clearTimeout(_hoverCloseTimer);
      _hoverCloseTimer = null;
    }
    libSide?.classList.add('hover-open');
  }

  function handleHoverLeave() {
    if (!isSidebarAutoHide()) return;
    if (_isSidebarBusy()) return;
    if (_hoverCloseTimer) clearTimeout(_hoverCloseTimer);
    _hoverCloseTimer = setTimeout(() => {
      _hoverCloseTimer = null;
      if (!isSidebarAutoHide() || _isSidebarBusy()) return;
      libSide?.classList.remove('hover-open');
    }, 280);
  }

  if (hoverZone) {
    hoverZone.addEventListener('mouseenter', handleHoverEnter);
  }
  if (libSide) {
    libSide.addEventListener('mouseenter', handleHoverEnter);
    libSide.addEventListener('mouseleave', handleHoverLeave);
  }

  // Re-evaluate hover collapse once a sidebar context menu closes
  ['lib-ctx-menu', 'folder-ctx-menu', 'multi-folder-ctx-menu'].forEach(menuId => {
    const menuEl = document.getElementById(menuId);
    if (!menuEl) return;
    menuEl.addEventListener('mouseenter', () => {
      if (_hoverCloseTimer) {
        clearTimeout(_hoverCloseTimer);
        _hoverCloseTimer = null;
      }
    });
    const obs = new MutationObserver(() => {
      if (!_isCtxMenuOpen(menuEl) && isSidebarAutoHide() && libSide?.classList.contains('hover-open')) {
        if (!libSide.matches(':hover') && !hoverZone?.matches(':hover')) {
          handleHoverLeave();
        }
      }
    });
    obs.observe(menuEl, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  });

  // 5. Global mouse move near left edge (safety net for quick mouse motions)
  window.addEventListener('mousemove', (e) => {
    if (!isSidebarAutoHide()) return;
    if (e.clientX <= 12) {
      handleHoverEnter();
    }
  });

  // 6. Close sidebar when clicking outside or resizing
  window.addEventListener('resize', () => {
    if (window.innerWidth <= 1024) {
      closeSidebar();
    }
  });

  // 7. Drag resizer on right edge of sidebar
  initSidebarResizer(handleHoverLeave);
}

function initSidebarResizer(onHoverLeave) {
  const libSide = document.getElementById('lib-side');
  const handle = document.getElementById('lib-resize-handle');
  if (!handle || !libSide) return;

  // Restore saved width from localStorage
  const savedWidth = safeStorageGet('lib_sidebar_width');
  if (savedWidth) {
    const w = parseInt(savedWidth);
    if (w >= 200 && w <= window.innerWidth * 0.6) {
      document.documentElement.style.setProperty('--lib-w', w + 'px');
    }
  }

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    _sidebarResizing = true;
    if (_hoverCloseTimer) {
      clearTimeout(_hoverCloseTimer);
      _hoverCloseTimer = null;
    }
    startX = e.clientX;
    startWidth = libSide.offsetWidth;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('resizing');
    libSide.style.transition = 'none';
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  });

  handle.addEventListener('pointermove', (e) => {
    if (!isResizing) return;
    const deltaX = e.clientX - startX;
    const minW = 200;
    const maxW = Math.max(minW, Math.floor(window.innerWidth * 0.6));
    const newWidth = Math.max(minW, Math.min(maxW, startWidth + deltaX));
    document.documentElement.style.setProperty('--lib-w', newWidth + 'px');
  });

  const stopResize = (e) => {
    if (!isResizing) return;
    isResizing = false;
    _sidebarResizing = false;
    handle.classList.remove('resizing');
    libSide.style.transition = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {}

    const curWidth = libSide.offsetWidth;
    safeStorageSet('lib_sidebar_width', String(curWidth));
    if (isSidebarAutoHide() && !libSide.matches(':hover') && typeof onHoverLeave === 'function') {
      onHoverLeave();
    }
  };

  handle.addEventListener('pointerup', stopResize);
  handle.addEventListener('pointercancel', stopResize);
}

// ── Zoom ──
export async function changeZoom(delta) {
  const ns = Math.max(0.5, Math.min(3, S.scale + delta));
  if (ns === S.scale) return;
  const { reRenderAll, captureZoomAnchor } = await import('./viewer.js');
  if (S.pdfDoc) captureZoomAnchor();
  S.scale = ns;
  document.getElementById('zoom-lbl').textContent = Math.round(ns / 1.5 * 100) + '%';
  if (!S.pdfDoc) return;

  // Re-render all pages
  reRenderAll();
}

// ── Copy Entire PDF Text to Clipboard ──
let _isExtractingPdfText = false;

// ── Exclude Commercial Footers (e.g., CD Technologies Asia, Inc. & cdasiaonline.com) ──
const _FOOTER_EXCLUDE_PATTERNS = [
  /(?:(?:copyright|©|\(c\))\s+)?(?:\d{4}\s+)?CD\s+Technologies\s+Asia(?:,?\s*Inc\.?)?(?:\s*(?:copyright|©|\(c\))?\s*\(?\d{4}\)?\.?)?/gi,
  /(?:https?:\/\/)?(?:www\.)?cdasia(?:online)?\.com(?:\/[^\s]*)?/gi
];

export function stripExcludedFooters(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const resultLines = [];

  for (let i = 0; i < lines.length; i++) {
    const orig = lines[i];
    let cleaned = orig;
    let hadFooter = false;

    for (const pat of _FOOTER_EXCLUDE_PATTERNS) {
      pat.lastIndex = 0;
      if (pat.test(cleaned)) {
        hadFooter = true;
        pat.lastIndex = 0;
        cleaned = cleaned.replace(pat, '');
      }
    }

    if (hadFooter) {
      // If line only had footer or divider symbols remaining, omit it completely
      if (/^[\s|•·\-/]*$/.test(cleaned)) {
        continue;
      }
      cleaned = cleaned.replace(/[ \t]+/g, ' ').trim();
      resultLines.push(cleaned);
    } else {
      resultLines.push(orig);
    }
  }

  return resultLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function cleanPageTextContent(tc) {
  if (!tc || !tc.items || !tc.items.length) return '';
  let text = '';
  let lastY = null;
  let lastX = null;

  for (const item of tc.items) {
    if (!item || typeof item.str !== 'string') continue;
    const str = item.str;
    if (!str && !item.hasEOL) continue;

    const transform = item.transform;
    const y = transform ? transform[5] : null;
    const x = transform ? transform[4] : null;

    if (lastY !== null && y !== null) {
      if (Math.abs(y - lastY) > 5) {
        if (!text.endsWith('\n')) text += '\n';
      } else if (
        lastX !== null &&
        x !== null &&
        x > lastX + 2 &&
        !text.endsWith(' ') &&
        !text.endsWith('\n') &&
        !str.startsWith(' ')
      ) {
        text += ' ';
      }
    }

    text += str;
    if (item.hasEOL && !text.endsWith('\n')) {
      text += '\n';
    }

    lastY = y;
    lastX = (x !== null && typeof item.width === 'number') ? (x + item.width) : x;
  }

  return stripExcludedFooters(text);
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.warn('[copyEntirePdfText] navigator.clipboard.writeText failed, using fallback:', e);
    }
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    console.error('[copyEntirePdfText] Fallback execCommand copy failed:', err);
    return false;
  }
}

export async function copyEntirePdfText() {
  try {
    const smartMod = await import('./smart-copy.js').catch(() => null);
    if (smartMod?.copyEntirePdfTextSmart) {
      return await smartMod.copyEntirePdfTextSmart();
    }
  } catch (err) {
    console.warn('[copyEntirePdfText] Delegating to smart-copy failed, falling back:', err);
  }

  if (_isExtractingPdfText) return;

  if (!S.pdfDoc || !S.totalPages || S.totalPages <= 0) {
    toast('⚠️ No PDF is currently open');
    return;
  }

  const btn = document.getElementById('btn-copy-pdf-text');
  const originalHtml = btn ? btn.innerHTML : '';
  const originalTitle = btn ? btn.title : '';

  _isExtractingPdfText = true;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('loading');
    btn.title = 'Extracting and copying entire PDF text…';
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 14"/></svg> <span>Copying…</span>';
  }

  const total = S.totalPages;
  const doc = S.pdfDoc;
  const pageTexts = new Array(total);
  const BATCH_SIZE = 10;

  try {
    toast(`⏳ Extracting text from ${total} page${total === 1 ? '' : 's'}…`);

    for (let i = 1; i <= total; i += BATCH_SIZE) {
      if (doc !== S.pdfDoc) {
        throw new Error('PDF changed during extraction');
      }
      const batchPromises = [];
      for (let p = i; p < i + BATCH_SIZE && p <= total; p++) {
        const pageNum = p;
        batchPromises.push((async () => {
          try {
            const page = await doc.getPage(pageNum);
            const tc = await page.getTextContent();
            pageTexts[pageNum - 1] = cleanPageTextContent(tc);
          } catch (err) {
            console.warn(`[copyEntirePdfText] Failed extracting page ${pageNum}:`, err);
            pageTexts[pageNum - 1] = '';
          }
        })());
      }
      await Promise.all(batchPromises);
      if (i + BATCH_SIZE <= total) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    const hasAnyText = pageTexts.some(t => t && t.trim().length > 0);
    if (!hasAnyText) {
      toast('⚠️ No selectable text found in this PDF (it may be a scanned document without OCR).');
      return;
    }

    let fullText = '';
    if (total === 1) {
      fullText = (pageTexts[0] || '').trim();
    } else {
      const parts = [];
      for (let p = 1; p <= total; p++) {
        const pText = (pageTexts[p - 1] || '').trim();
        parts.push(`--- Page ${p} ---\n${pText || '[No selectable text on this page]'}`);
      }
      fullText = parts.join('\n\n').trim();
    }
    fullText = stripExcludedFooters(fullText);

    const ok = await copyTextToClipboard(fullText);
    if (!ok) {
      toast('❌ Failed to copy to clipboard. Please check clipboard permissions.');
      return;
    }

    const wordCount = fullText.split(/\s+/).filter(Boolean).length;
    const pageLabel = total === 1 ? '1 page' : `${total} pages`;

    if (btn) {
      btn.classList.remove('loading');
      btn.classList.add('copied');
      btn.innerHTML = '<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> <span>Copied!</span>';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = originalHtml;
        btn.title = originalTitle;
      }, 2200);
    }

    toast(`✅ Copied entire PDF text (${wordCount.toLocaleString()} words, ${pageLabel}) to clipboard!`);
  } catch (err) {
    console.error('[copyEntirePdfText] Error:', err);
    toast(`⚠️ Text extraction stopped: ${err.message || err}`);
  } finally {
    _isExtractingPdfText = false;
    if (btn) {
      btn.disabled = false;
      if (!btn.classList.contains('copied')) {
        btn.classList.remove('loading');
        btn.innerHTML = originalHtml;
        btn.title = originalTitle;
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.copyEntirePdfText = copyEntirePdfText;
}

function _openColorManager() {
  import('./colors.js')
    .then(m => {
      if (typeof m.openColorCategoriesModal === 'function') {
        m.openColorCategoriesModal();
      } else {
        openModal('mo-color');
      }
    })
    .catch(() => openModal('mo-color'));
}

export function initZoom() {
  document.getElementById('btn-zin')?.addEventListener('click',  () => changeZoom( 0.25));
  document.getElementById('btn-zout')?.addEventListener('click', () => changeZoom(-0.25));
  document.getElementById('btn-copy-pdf-text')?.addEventListener('click', copyEntirePdfText);
  document.getElementById('btn-manage-colors')?.addEventListener('click', _openColorManager);
  document.getElementById('btn-panel-manage-colors')?.addEventListener('click', _openColorManager);
  document.getElementById('btn-cmd-palette')?.addEventListener('click', () => openCommandPalette());
  initCommandPalette();
}

let _scrollTimer = null;
let _isJumping = false;
let _isUserScrolling = false;
let _scrollIdleTimer = null;
const _scrollIdleCallbacks = new Set();

export function isUserScrolling() {
  return _isUserScrolling;
}

export function onScrollIdle(cb) {
  _scrollIdleCallbacks.add(cb);
  return () => _scrollIdleCallbacks.delete(cb);
}

function _markUserScrolling() {
  _isUserScrolling = true;
  if (_scrollIdleTimer) clearTimeout(_scrollIdleTimer);
  _scrollIdleTimer = setTimeout(() => {
    _scrollIdleTimer = null;
    _isUserScrolling = false;
    _scrollIdleCallbacks.forEach(cb => {
      try { cb(); } catch (e) { console.warn(e); }
    });
  }, 220);
}

export function setIsJumping(val) {
  _isJumping = !!val;
}

const _cloudBmTimers = new Map();

export function parseReadPosPayload(raw) {
  if (!raw) return { page: 1, ratio: 0, updatedAt: 0 };
  if (typeof raw === 'object') {
    return {
      page: Number(raw.page) || 1,
      ratio: Number(raw.ratio) || 0,
      updatedAt: Number(raw.updatedAt) || 0
    };
  }
  const str = String(raw).trim();
  if (!str) return { page: 1, ratio: 0, updatedAt: 0 };
  if (str.startsWith('{')) {
    try {
      const parsed = JSON.parse(str);
      return {
        page: Number(parsed.page) || 1,
        ratio: Number(parsed.ratio) || 0,
        updatedAt: Number(parsed.updatedAt) || 0
      };
    } catch {}
  }
  const pg = parseInt(str, 10);
  return {
    page: !isNaN(pg) && pg >= 1 ? pg : 1,
    ratio: 0,
    updatedAt: 0
  };
}

export function saveReadingPosition(pdfFile, pageNum, scrollRatio = null, immediateCloud = false) {
  if (!pdfFile || !pageNum) return;
  const trueId = pdfFile.linked_pdf_id || pdfFile.id;
  let ratio = 0;
  if (scrollRatio === null) {
    const wrap = S.pages?.[pageNum]?.wrap;
    const scrollEl = document.getElementById('canvas-scroll');
    ratio = (wrap && scrollEl && wrap.offsetHeight > 0)
      ? Math.max(0, Math.min(0.95, (scrollEl.scrollTop - wrap.offsetTop) / wrap.offsetHeight))
      : 0;
  } else {
    ratio = Math.max(0, Math.min(0.95, Number(scrollRatio) || 0));
  }

  const payload = {
    page: pageNum,
    ratio: Number(ratio.toFixed(4)),
    updatedAt: Date.now()
  };
  const payloadStr = JSON.stringify(payload);

  // Backwards-compatible legacy bookmark keys
  safeStorageSet('bookmark_' + pdfFile.id, pageNum);
  if (pdfFile.linked_pdf_id) safeStorageSet('bookmark_' + pdfFile.linked_pdf_id, pageNum);

  // Rich metadata keys
  safeStorageSet('read_pos_meta_' + trueId, payloadStr);
  safeStorageSet('read_pos_meta_' + pdfFile.id, payloadStr);

  // Cloud sync
  if (immediateCloud) {
    if (_cloudBmTimers.has(trueId)) {
      clearTimeout(_cloudBmTimers.get(trueId));
      _cloudBmTimers.delete(trueId);
    }
    import('./db.js').then(m => m.dbSetSetting?.('read_pos_' + trueId, payloadStr)).catch(() => {});
  } else {
    if (_cloudBmTimers.has(trueId)) {
      clearTimeout(_cloudBmTimers.get(trueId));
    }
    const timer = setTimeout(() => {
      _cloudBmTimers.delete(trueId);
      import('./db.js').then(m => m.dbSetSetting?.('read_pos_' + trueId, payloadStr)).catch(() => {});
    }, 1000);
    _cloudBmTimers.set(trueId, timer);
  }
}

export function flushCurrentReadingPosition() {
  if (S.curPDF && S.curPage && !_isJumping) {
    saveReadingPosition(S.curPDF, S.curPage, null, true);
  }
}

let _jumpGen = 0;

export async function scrollToPageAndRatio(pageNum, ratio = 0, smooth = false) {
  if (!S.totalPages || pageNum < 1 || pageNum > S.totalPages) return;
  const myJump = ++_jumpGen;
  _isJumping = true;

  const { ensurePageRendered } = await import('./viewer.js');
  await ensurePageRendered(pageNum);
  if (myJump !== _jumpGen) return; // a newer jump took over
  if (pageNum > 1) ensurePageRendered(pageNum - 1);

  const scrollEl = document.getElementById('canvas-scroll');
  const wrap = S.pages?.[pageNum]?.wrap;
  // Always recompute the target from the page element's live position, so
  // pages above that finish rendering (and change height) don't make us snap
  // back to a stale pixel offset.
  const targetTop = () => Math.max(0, wrap.offsetTop - 16 + Math.round((ratio || 0) * (wrap.offsetHeight || 0)));
  if (wrap && scrollEl) {
    const exactTop = targetTop();
    if (smooth && scrollEl.scrollTo) {
      scrollEl.scrollTo({ top: exactTop, behavior: 'smooth' });
    } else {
      scrollEl.scrollTop = exactTop;
    }
    const settle = () => {
      if (myJump !== _jumpGen) return;
      const t = targetTop();
      if (Math.abs(scrollEl.scrollTop - t) > 8) scrollEl.scrollTop = t;
    };
    requestAnimationFrame(settle);
    setTimeout(settle, 120);
  }

  setTimeout(() => {
    if (myJump === _jumpGen) _isJumping = false;
  }, 280);
}

// ── Page navigation ──
export function initNavButtons() {
  document.getElementById('btn-prev').addEventListener('click', () => {
    if (S.curPage > 1) jumpToPage(S.curPage - 1, true);
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    if (S.curPage < S.totalPages) jumpToPage(S.curPage + 1, true);
  });
  document.getElementById('pg-input').addEventListener('change', function () {
    const v = parseInt(this.value);
    if (v >= 1 && v <= S.totalPages) jumpToPage(v, false);
  });

  const scrollEl = document.getElementById('canvas-scroll');
  scrollEl.addEventListener('wheel', _markUserScrolling, { passive: true });
  scrollEl.addEventListener('touchmove', _markUserScrolling, { passive: true });

  if (scrollEl && !scrollEl.dataset.desktopWheelZoom) {
    scrollEl.dataset.desktopWheelZoom = 'true';
    let zoomDebounce = null;
    scrollEl.addEventListener('wheel', async (e) => {
      if (!(e.ctrlKey || e.metaKey) || !S.pdfDoc) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.12 : -0.12;
      const nextScale = Math.min(3.0, Math.max(0.6, Math.round((S.scale + delta) * 100) / 100));
      if (nextScale === S.scale) return;
      const { reRenderAll, captureZoomAnchor } = await import('./viewer.js');
      captureZoomAnchor();
      S.scale = nextScale;
      const zLbl = document.getElementById('zoom-lbl');
      if (zLbl) zLbl.textContent = Math.round(S.scale / 1.5 * 100) + '%';
      clearTimeout(zoomDebounce);
      zoomDebounce = setTimeout(() => {
        reRenderAll();
      }, 110);
    }, { passive: false });
  }

  scrollEl.addEventListener('scroll', function () {
    _markUserScrolling();
    if (_isJumping) return;
    if (_scrollTimer) return;
    _scrollTimer = setTimeout(() => {
      _scrollTimer = null;
      if (_isJumping || !S.totalPages) return;

      const targetY = scrollEl.scrollTop + 80;

      // Binary search over the real page positions. Pages can have different
      // sizes (and placeholders differ from rendered pages), so a uniform-slot
      // estimate can be many pages off in large PDFs — which used to set the
      // wrong current page, evict the visible pages and cause endless jumps.
      let lo = 1, hi = S.totalPages, foundPage = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const w = S.pages?.[mid]?.wrap;
        if (!w) break;
        if (w.offsetTop <= targetY) { foundPage = mid; lo = mid + 1; }
        else hi = mid - 1;
      }

      if (foundPage && foundPage !== S.curPage && foundPage >= 1 && foundPage <= S.totalPages) {
        S.curPage = foundPage;
        document.getElementById('pg-input').value = foundPage;
        if (S.curPDF) {
          saveReadingPosition(S.curPDF, foundPage, null, false);
        }

        // Efficient thumbnail highlight: only toggle previous and current thumbnail instead of scanning all items
        const prevThumb = document.querySelector('.thumb-item.active');
        if (prevThumb && parseInt(prevThumb.dataset.page) !== foundPage) {
          prevThumb.classList.remove('active');
        }
        const newThumb = document.querySelector(`.thumb-item[data-page="${foundPage}"]`);
        if (newThumb) {
          newThumb.classList.add('active');
        }

        updateAppTitle();
      }
    }, 60);
  });
}

export async function jumpToPage(pg, smooth = false, ratio = 0) {
  if (!S.totalPages || pg < 1 || pg > S.totalPages) return;
  S.curPage = pg;
  document.getElementById('pg-input').value = pg;
  if (S.curPDF) {
    saveReadingPosition(S.curPDF, pg, ratio || 0, false);
  }

  // Efficient thumbnail highlight
  const prevThumb = document.querySelector('.thumb-item.active');
  if (prevThumb && parseInt(prevThumb.dataset.page) !== pg) {
    prevThumb.classList.remove('active');
  }
  const newThumb = document.querySelector(`.thumb-item[data-page="${pg}"]`);
  if (newThumb) {
    newThumb.classList.add('active');
  }

  updateAppTitle();
  await scrollToPageAndRatio(pg, ratio || 0, smooth);
}

// ── Command Palette (Ctrl/Cmd+K) ──
let _paletteWired = false;
let _paletteDeps = null;

function _populatePaletteCases() {
  const group = document.getElementById('paletteCasesGroup');
  if (!group) return;
  group.querySelectorAll('.palette__item').forEach(el => el.remove());

  const pdfs = Array.isArray(S.pdfs) ? S.pdfs : [];
  const subjMap = new Map((S.subjects || []).map(s => [s.id, s.name]));
  const foldMap = new Map((S.folders || []).map(f => [f.id, f]));

  pdfs.slice(0, 60).forEach((pdf) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'palette__item';
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', 'false');
    btn.dataset.cmd = 'open-case';
    btn.dataset.pdfId = String(pdf.id);

    const lbl = document.createElement('span');
    lbl.className = 'palette__item-label';
    lbl.textContent = pdf.name || 'Untitled PDF';

    const folder = foldMap.get(pdf.folder_id);
    const subjName = folder ? (subjMap.get(folder.subject_id) || folder.name) : (subjMap.get(pdf.subject_id) || 'Library');
    const hint = document.createElement('span');
    hint.className = 'palette__item-hint';
    hint.textContent = folder && subjName !== folder.name ? `${subjName} / ${folder.name}` : subjName;

    btn.appendChild(lbl);
    btn.appendChild(hint);
    group.appendChild(btn);
  });
}

function _getVisiblePaletteItems() {
  return Array.from(document.querySelectorAll('#paletteResults .palette__item')).filter(el => !el.hidden);
}

function _setActivePaletteItem(target) {
  const items = _getVisiblePaletteItems();
  items.forEach(el => el.setAttribute('aria-selected', el === target ? 'true' : 'false'));
  if (target) target.scrollIntoView({ block: 'nearest' });
}

function _filterPaletteItems(query) {
  const q = String(query || '').trim().toLowerCase();
  const palette = document.getElementById('commandPalette');
  if (!palette) return;

  let anyVisible = false;
  palette.querySelectorAll('.palette__group').forEach(group => {
    let groupVisible = 0;
    group.querySelectorAll('.palette__item').forEach(item => {
      const txt = item.textContent.toLowerCase();
      const match = !q || txt.includes(q);
      item.hidden = !match;
      if (match) groupVisible++;
    });
    group.hidden = groupVisible === 0;
    anyVisible = anyVisible || groupVisible > 0;
  });

  const empty = document.getElementById('paletteEmpty');
  if (empty) empty.hidden = anyVisible;

  const visible = _getVisiblePaletteItems();
  _setActivePaletteItem(visible[0] || null);
}

async function _executePaletteItem(item) {
  const palette = document.getElementById('commandPalette');
  if (!item) return;
  const cmd = item.dataset.cmd;
  const pdfId = item.dataset.pdfId;
  if (palette?.open) palette.close();

  if (cmd === 'open-case' && pdfId) {
    const pdf = (S.pdfs || []).find(p => String(p.id) === String(pdfId));
    if (pdf) {
      const { openPDFFromLibrary } = await import('./viewer.js');
      await openPDFFromLibrary(pdf);
    }
  } else if (cmd === 'go-desk') {
    const homeTab = document.querySelector('.gn-tab-home');
    if (homeTab) homeTab.click();
    else {
      const { closeActivePDF } = await import('./viewer.js');
      closeActivePDF?.();
    }
  } else if (cmd === 'perplexity-digest') {
    document.getElementById('btn-perplexity-digest')?.click();
  } else if (cmd === 'gemini-digest') {
    document.getElementById('btn-gemini-digest')?.click();
  } else if (cmd === 'open-digest') {
    const npPanel = document.getElementById('notepad-panel');
    if (npPanel && !npPanel.classList.contains('open')) {
      document.getElementById('btn-notepad')?.click();
    }
    document.getElementById('nptab-digest')?.click();
    document.getElementById('np-digest-editor')?.focus();
  } else if (cmd === 'open-notes') {
    document.getElementById('btn-notepad')?.click();
  } else if (cmd === 'open-color-categories') {
    _openColorManager();
  } else if (cmd === 'toggle-rail-autohide') {
    setSidebarAutoHide(!isSidebarAutoHide(), true);
  } else if (cmd === 'toggle-skin') {
    document.getElementById('btn-theme-toggle')?.click();
  } else if (cmd === 'toggle-search') {
    _paletteDeps?.openSearch?.();
  } else if (cmd === 'toggle-tags') {
    document.getElementById('btn-tags')?.click();
  } else if (cmd === 'zoom-in') {
    await changeZoom(0.25);
  } else if (cmd === 'zoom-out') {
    await changeZoom(-0.25);
  }
}

export function openCommandPalette() {
  const palette = document.getElementById('commandPalette');
  const input = document.getElementById('paletteInput');
  if (!palette) return;
  if (palette.open) {
    palette.close();
    return;
  }
  _populatePaletteCases();
  if (input) input.value = '';
  _filterPaletteItems('');
  if (typeof palette.showModal === 'function') palette.showModal();
  else palette.setAttribute('open', '');
  if (input) input.focus();
}

export function closeCommandPalette() {
  const palette = document.getElementById('commandPalette');
  if (!palette) return;
  if (palette.open && typeof palette.close === 'function') palette.close();
  else palette.removeAttribute('open');
}

function initCommandPalette() {
  if (_paletteWired) return;
  const palette = document.getElementById('commandPalette');
  const input = document.getElementById('paletteInput');
  if (!palette) return;
  _paletteWired = true;

  palette.addEventListener('click', (e) => {
    if (e.target === palette) {
      closeCommandPalette();
      return;
    }
    const item = e.target.closest('.palette__item');
    if (item) _executePaletteItem(item);
  });

  palette.addEventListener('keydown', (e) => {
    const visible = _getVisiblePaletteItems();
    if (!visible.length) return;
    let currentIdx = visible.findIndex(el => el.getAttribute('aria-selected') === 'true');
    if (currentIdx === -1) currentIdx = 0;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _setActivePaletteItem(visible[(currentIdx + 1) % visible.length]);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _setActivePaletteItem(visible[(currentIdx - 1 + visible.length) % visible.length]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      _executePaletteItem(visible[currentIdx]);
    }
  });

  input?.addEventListener('input', () => _filterPaletteItems(input.value));
}

// ── Keyboard shortcuts ──
export function initKeyboard(deps) {
  // deps: { setMode, openSearch, closeSearch, closeAnnPanel }
  _paletteDeps = deps;
  initCommandPalette();

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openCommandPalette();
      return;
    }

    const tag      = document.activeElement?.tagName;
    const editable = document.activeElement?.contentEditable === 'true';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || editable) return;

    if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      const scrollEl = document.getElementById('canvas-scroll');
      if (scrollEl) {
        const amount = scrollEl.clientHeight * 0.85;
        scrollEl.scrollBy({ top: e.key === 'PageDown' ? amount : -amount, behavior: 'smooth' });
      }
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const scrollEl = document.getElementById('canvas-scroll');
      if (scrollEl && document.activeElement !== scrollEl) {
        e.preventDefault();
        scrollEl.scrollBy({ top: e.key === 'ArrowDown' ? 80 : -80, behavior: 'smooth' });
        return;
      }
    }

    if (e.key === 't' || e.key === 'T') deps.setMode('text');
    else if (e.key === 'b' || e.key === 'B') deps.setMode('box');
    else if (e.key === 'd' || e.key === 'D') deps.setMode('draw');
    else if (e.key === '?') openModal('mo-keys');
    else if (e.key === 'Escape') {
      closeCommandPalette();
      deps.closeAnnPanel();
      deps.closeSearch();
      closeModal('mo-keys');
      document.getElementById('tags-panel')?.classList.remove('open');
      ['mo-color-categories', 'mo-color', 'topic-notes-modal', 'mo-syllabus', 'mo-move-to-folder', 'mo-ocr-tool'].forEach(id => {
        closeModal(id);
        const m = document.getElementById(id);
        if (m && m.style.display && m.style.display !== 'none') m.style.display = 'none';
      });
      document.getElementById('lib-ctx-menu')?.classList.remove('open');
      const tblMenu = document.getElementById('table-ctx-menu');
      if (tblMenu) tblMenu.style.display = 'none';
      document.getElementById('sel-menu')?.classList.remove('open');
      import('./notepad.js').then(m => m.closeNotepad?.()).catch(() => {
        document.getElementById('notepad-panel')?.classList.remove('open');
      });
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      toggleSidebar();
    }
    else if (e.key === '[') {
      toggleSidebar();
    }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); deps.openSearch(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && S.mode === 'draw') {
      document.getElementById('btn-undo').click();
    }
  });

  // Automatically blur toolbar buttons on click to prevent keyboard accidental activations
  document.querySelectorAll('.tb-btn').forEach(btn => {
    btn.addEventListener('mouseup', () => btn.blur());
  });

  document.getElementById('note-editor').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      document.getElementById('btn-add-note').click();
      return;
    }
    handleEditorKeyDown(e, document.getElementById('note-editor'));
  });
}

// ── Export annotations to Markdown ──
export function exportAnnotations() {
  if (!S.curPDF || !S.annotations.length) {
    toast('No annotations to export');
    return;
  }
  const lines = [`# Annotations — ${S.curPDF.name}`, ''];
  const sorted = [...S.annotations].sort((a, b) => a.page - b.page);
  for (const ann of sorted) {
    const cat = getColorCategoryForHex(ann.hex_color);
    const catSuffix = cat?.name ? ` · ${cat.name}` : '';
    lines.push(`## Page ${ann.page}${catSuffix}`);
    lines.push(`> ${ann.highlighted_text}`);
    lines.push('');
    if (ann.notes.length) {
      for (const note of ann.notes) {
        const plain = note.note_html.replace(/<[^>]*>/g, '');
        lines.push(`- ${plain}`);
      }
      lines.push('');
    }
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${S.curPDF.name.replace(/\.pdf$/i, '')}_annotations.md`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported!');
}

// ── Dynamic Window Title & Multi-Monitor Indicator ──
export function getScreenIndicator() {
  const x = window.screenLeft ?? window.screenX ?? 0;
  const y = window.screenTop ?? window.screenY ?? 0;
  const w = window.screen?.width || 1920;
  const h = window.screen?.height || 1080;

  const isExtended = Boolean(window.screen && window.screen.isExtended);
  const isOffPrimary = (x < -100 || x >= w - 100 || y < -100 || y >= h - 100);

  // Single-screen laptop mode: keep title clean
  if (!isExtended && !isOffPrimary) {
    return '';
  }

  // Dual/Multi-screen setup:
  if (isOffPrimary) {
    return '[Screen 2] ';
  } else {
    return '[Screen 1] ';
  }
}

export function updateAppTitle() {
  const prefix = getScreenIndicator();
  const cbInfo = document.getElementById('casebar-info');
  const cbTitle = document.getElementById('casebar-title');
  const cbMeta = document.getElementById('casebar-meta');

  if (S.curPDF) {
    const pageStr = S.curPage ? `(p. ${S.curPage})` : '';
    document.title = `${prefix}📄 ${S.curPDF.name} ${pageStr} — Legal Annotator`;
    if (cbInfo && cbTitle && cbMeta) {
      const folder = (S.folders || []).find(f => f.id === S.curPDF.folder_id);
      const subj = folder
        ? (S.subjects || []).find(s => s.id === folder.subject_id)
        : (S.subjects || []).find(s => s.id === S.curPDF.subject_id);
      cbTitle.textContent = S.curPDF.name || 'Case Document';
      const parts = [];
      if (subj?.name) parts.push(subj.name);
      if (folder?.name) parts.push(folder.name);
      if (S.curPage && S.totalPages) parts.push(`p. ${S.curPage} / ${S.totalPages}`);
      cbMeta.textContent = parts.join(' · ');
      cbInfo.hidden = false;
    }
  } else {
    document.title = `${prefix}Legal Annotator`;
    if (cbInfo) cbInfo.hidden = true;
  }
}

// Keep title updated on window resize, focus, and movement
if (typeof window !== 'undefined') {
  window.addEventListener('resize', updateAppTitle);
  window.addEventListener('focus', updateAppTitle);
  setInterval(updateAppTitle, 2000);
}
