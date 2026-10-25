// ═══════════════════════════════════════════════
// NOTEPAD — per-PDF general notes with auto-save
// ═══════════════════════════════════════════════
import { S } from './state.js';
import {
  db,
  dbLoad,
  dbLoadAnnCounts,
  dbLoadNotepad,
  dbSaveNotepad,
  dbFetchCloudNotepadRaw,
  ensurePdfExistsInCloud,
  dbLoadAnnotations,
  dbLoadDrawings,
  dbLoadBookmarks,
} from './db.js';
import { replayOutbox } from './outbox.js';
import { showTablePicker, handlePaste, insertBannerHeader, toggleGrayOut, handleEditorKeyDown, outdentLine, indentLine, buildHighlightDropdown, copyFirstSummaryTable } from './tablepicker.js';
import { openPdfLinkModal, insertWebLink } from './pdflink.js';
import { closeOtherPanels, toast } from './ui.js';
import { safeStorageSet, safeStorageGet } from './storage.js';
import { getNotepadHistoryIDB, saveNotepadHistoryIDB } from './pdfcache.js';
import { getNotepadDiagnostics, generateDiagnosticReport, logNotepadDiagnostic } from './diag.js';

// ── Timestamp helpers for conflict detection ──
function setWriteTs(pdfId)  { safeStorageSet('local_notepad_write_ts_' + pdfId, Date.now()); }
function setSyncTs(pdfId)   { safeStorageSet('local_notepad_sync_ts_' + pdfId,  Date.now()); }
function getWriteTs(pdfId)  { return parseInt(safeStorageGet('local_notepad_write_ts_' + pdfId, '0') || '0'); }
function getSyncTs(pdfId)   { return parseInt(safeStorageGet('local_notepad_sync_ts_'  + pdfId, '0') || '0'); }

// ── Merge two HTML note bodies without losing either side ──
function mergeNoteHtml(localHtml, remoteHtml) {
  if (!localHtml && !remoteHtml) return '';
  if (!localHtml) return remoteHtml;
  if (!remoteHtml) return localHtml;
  if (localHtml === remoteHtml) return localHtml;
  return (
    localHtml +
    '<hr style="border-color:var(--gold);margin:14px 0;opacity:.5">' +
    '<p style="color:var(--gold);font-size:11px;font-family:Inter,sans-serif;margin:0 0 6px">⚠️ Notes recovered from another device — please review and merge manually:</p>' +
    remoteHtml
  );
}

// In-memory per-PDF cache: pdfId -> { content, digest, dirty, timestamp }
const _notepadCache = new Map();

// Active loaded PDF ID currently bound to editor UI
let _activePdfId = null;

// PDF ID whose content is currently mounted in #np-editor / #np-digest-editor DOM
let _domBoundPdfId = null;
const _loadingPdfIds = new Set();

// Debounce timer for auto-saving
let _saveTimer = null;

// Target PDF ID bound specifically to _saveTimer
let _timerPdfId = null;

// Monotonic sequence token to discard stale async dbLoad responses
let _loadSeq = 0;

// Active editor tab: 'notes' | 'digest'
let _activeTab = 'notes';

function $panel()        { return document.getElementById('notepad-panel'); }
function $notesEditor()  { return document.getElementById('np-editor'); }
function $digestEditor() { return document.getElementById('np-digest-editor'); }
function $currentEditor(){ return _activeTab === 'digest' ? $digestEditor() : $notesEditor(); }
function $saveLbl()      { return document.getElementById('np-save-lbl'); }

// ── Snapshot backup helper to protect against any data loss ──
async function saveHistorySnapshot(pdfId, content, digest) {
  if (!pdfId || (!content && !digest)) return;
  try {
    const histKey = 'notepad_history_' + pdfId;
    let history = await getNotepadHistoryIDB(pdfId);
    if (!Array.isArray(history) || history.length === 0) {
      history = JSON.parse(safeStorageGet(histKey, '[]') || '[]');
    }
    const latest = history[history.length - 1];
    if (!latest || latest.content !== content || latest.digest !== digest) {
      history.push({
        t: Date.now(),
        content: content || '',
        digest: digest || ''
      });
      if (history.length > 50) history.shift();
      // 1. Save full rich history to IndexedDB (virtually unlimited quota)
      await saveNotepadHistoryIDB(pdfId, history);
      // 2. Keep only top 3 in localStorage so quota is never exceeded
      const top3 = history.slice(-3);
      safeStorageSet(histKey, JSON.stringify(top3));
      // 3. Log the snapshot creation so it appears in the Error & Sync Log tab
      logNotepadDiagnostic(pdfId, 'SNAPSHOT', 'OK', 'SNAPSHOT_SAVED',
        `History snapshot saved (Notes: ${(content||'').length} chars, Digest: ${(digest||'').length} chars). Total snapshots: ${history.length}.`,
        { contentLen: (content||'').length, digestLen: (digest||'').length, totalSnapshots: history.length });
    }
  } catch (e) {
    console.warn('[Notepad] saveHistorySnapshot error:', e);
    logNotepadDiagnostic(pdfId, 'SNAPSHOT', 'ERR', 'ERR_SNAPSHOT_FAIL',
      `Failed to save history snapshot: ${e?.message || String(e)}`, { error: String(e) });
  }
}


// ── Last value this device KNOWS the cloud holds, per PDF (set on successful load/save) ──
// A save only sends the field(s) the user actually changed relative to this baseline.
// That stops a save from the Notes tab clobbering a Digest written by another device (and
// vice versa), and guarantees an empty / not-yet-loaded field is never written over real
// cloud data. When the cloud state is unknown (load failed/offline) blanks are never sent.
const _cloudBase = new Map(); // canonical pdfId -> { content?: string, digest?: string }
const _baseKey = (id) => S.pdfs?.find(p => p.id === id)?.linked_pdf_id || id;

function _setCloudBase(pdfId, content, digest) {
  if (!pdfId) return;
  const k = _baseKey(pdfId);
  const b = _cloudBase.get(k) || {};
  if (content !== undefined) b.content = content;
  if (digest  !== undefined) b.digest  = digest;
  _cloudBase.set(k, b);
}

function _changedField(val, baseVal) {
  if (baseVal === undefined) return val ? val : undefined; // cloud state unknown → never send a blank
  return val !== baseVal ? val : undefined;
}

// Save only the changed field(s); returns the same shape as dbSaveNotepad().
async function _saveChangedFields(pdfId, content, digest) {
  const base = _cloudBase.get(_baseKey(pdfId)) || {};
  const sendC = _changedField(content, base.content);
  const sendD = _changedField(digest,  base.digest);
  if (sendC === undefined && sendD === undefined) {
    return { saved: true, code: '200_OK', noop: true }; // cloud already has exactly this
  }
  const res = await dbSaveNotepad(pdfId, sendC, sendD);
  if (res?.saved && !res?.localOnly && !res?.queued) {
    // Read the row back: an HTTP 200 only proves Supabase accepted the request, not that the row
    // now holds what we sent. Skipped for huge payloads (embedded diagram/screenshot images).
    const size = (sendC?.length || 0) + (sendD?.length || 0);
    if (size <= 300_000 && res.code !== 'WARN_SAVED_WITHOUT_DIGEST') {
      const chk = await dbFetchCloudNotepadRaw(pdfId);
      const okC = sendC === undefined || chk.content === sendC;
      const okD = sendD === undefined || chk.digestKnown === false || chk.digest === sendD;
      if (chk.ok && (!chk.exists || !okC || !okD)) {
        const why = !chk.exists ? 'row missing' : (!okC && !okD ? 'notes + digest differ' : (!okC ? 'notes differ' : 'digest differs'));
        logNotepadDiagnostic(pdfId, 'SAVE', 'ERR', 'ERR_SAVE_NOT_PERSISTED',
          `Supabase accepted the save but the row does not hold it (${why}; cloud now has Notes: ${chk.content?.length || 0}, Digest: ${chk.digest?.length || 0} chars). Another device may have overwritten it, or the write went to a different row. Local copy is safe.`,
          { sent: { content: sendC?.length, digest: sendD?.length }, cloud: { exists: chk.exists, content: chk.content?.length, digest: chk.digest?.length } });
        return { saved: false, error: `Save not persisted (${why})`, code: 'ERR_SAVE_NOT_PERSISTED' };
      }
    }
    // Digest column missing → only the notes reached the cloud
    _setCloudBase(pdfId, sendC, res.code === 'WARN_SAVED_WITHOUT_DIGEST' ? undefined : sendD);
  }
  return res;
}

// ── Startup / resume: alert user if any save errors happened while they were away ──
// Uses a persistent sticky banner (not a 3s toast) so the warning stays visible.
function checkAndAlertSaveErrors() {
  try {
    // Read raw localStorage directly — safeStorageGet is synchronous.
    const globalLogs = JSON.parse(
      safeStorageGet('notepad_global_diag_log', '[]') || '[]'
    );

    // Find the timestamp of the last time the user acknowledged warnings
    const lastAckedTs = parseInt(safeStorageGet('notepad_warn_acked_ts', '0') || '0');

    // Collect ERR-level entries that are newer than the last acknowledgement
    const unackedErrors = globalLogs.filter(
      e => e.status === 'ERR' && e.ts > lastAckedTs
    );

    if (unackedErrors.length === 0) {
      _removeSaveErrorBanner();
      return;
    }

    const newest = unackedErrors[0]; // logs are newest-first
    const dStr = (() => {
      try {
        return new Date(newest.ts).toLocaleString(undefined, {
          month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit'
        });
      } catch { return 'recently'; }
    })();

    _showSaveErrorBanner(unackedErrors.length, newest.code, dStr);
  } catch (e) {
    console.warn('[Notepad] checkAndAlertSaveErrors failed:', e);
  }
}

function _removeSaveErrorBanner() {
  document.getElementById('np-save-error-banner')?.remove();
}

function _showSaveErrorBanner(count, lastCode, lastTime) {
  // Only show one banner at a time
  _removeSaveErrorBanner();

  const banner = document.createElement('div');
  banner.id = 'np-save-error-banner';
  banner.style.cssText = [
    'position: fixed',
    'bottom: 0',
    'left: 0',
    'right: 0',
    'z-index: 99999',
    'background: #7f1d1d',
    'color: #fee2e2',
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    'font-size: 12px',
    'padding: 8px 16px',
    'display: flex',
    'align-items: center',
    'gap: 10px',
    'box-shadow: 0 -2px 12px rgba(0,0,0,0.4)',
    'border-top: 2px solid #ef4444',
  ].join(';');

  banner.innerHTML = `
    <span style="font-size:16px">⚠️</span>
    <span style="flex:1">
      <strong>${count} save error${count > 1 ? 's' : ''} occurred</strong> while you were away
      (last: <code style="background:rgba(0,0,0,.3);padding:1px 4px;border-radius:3px">${lastCode}</code> at ${lastTime}).
      Your notes are <strong>safe in local storage</strong> — but cloud sync may have gaps.
    </span>
    <button id="np-serr-view-log"
      style="background:#ef4444;color:#fff;border:none;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap">
      View Error Log
    </button>
    <button id="np-serr-dismiss"
      style="background:transparent;color:#fca5a5;border:1px solid #fca5a5;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:12px;white-space:nowrap">
      Dismiss
    </button>
  `;

  document.body.appendChild(banner);

  banner.querySelector('#np-serr-view-log')?.addEventListener('click', () => {
    // Mark as acknowledged so we don't re-show until new errors occur
    safeStorageSet('notepad_warn_acked_ts', String(Date.now()));
    _removeSaveErrorBanner();
    // Open the notepad error log panel if a PDF is active, otherwise prompt
    if (_activePdfId) {
      // Make sure notepad panel is open first
      const panel = $panel();
      if (panel && !panel.classList.contains('open')) {
        const pdf = window.S?.pdfs?.find(p => p.id === _activePdfId);
        if (pdf) openNotepad(_activePdfId);
      }
      openHistoryPanel('logs');
    } else {
      toast('📂 Open a PDF notepad first, then click the 🕐 history button to see the Error Log.');
    }
  });

  banner.querySelector('#np-serr-dismiss')?.addEventListener('click', () => {
    safeStorageSet('notepad_warn_acked_ts', String(Date.now()));
    _removeSaveErrorBanner();
  });
}

// ── Read the best available content for a PDF from DOM + cache + localStorage ──
// Priority:
//   1. If the notepad panel is OPEN for this PDF → DOM is the authoritative source.
//      Both editors are in the DOM even when hidden (display:none), so innerHTML is always
//      available. We only fall back to cache when the DOM element is genuinely missing.
//   2. If the panel is NOT open (closed or a different PDF is active) → use in-memory
//      cache first (most recently captured), then localStorage as final fallback.
// We deliberately do NOT use "pick longest" because that would restore deleted content
// when a user purposely clears their notes.
function _readEditorContent(pdfId) {
  const entry = _notepadCache.get(pdfId);
  const isDomBound = (_domBoundPdfId === pdfId) && (_activePdfId === pdfId);

  if (isDomBound) {
    // DOM editors are bound to this PDF. Both are always in the DOM even if one is
    // display:none, so innerHTML is reliable regardless of which tab is active or if .open was just removed.
    const notesEl  = $notesEditor();
    const digestEl = $digestEditor();
    const domContent = notesEl  ? (notesEl.innerHTML  ?? '') : null;
    const domDigest  = digestEl ? (digestEl.innerHTML ?? '') : null;

    const storedC = safeStorageGet('local_notepad_' + pdfId, '') ?? '';
    const storedD = safeStorageGet('local_digest_'  + pdfId, '') ?? '';

    const isDirty = entry ? !!entry.dirty : false;
    let content = domContent !== null ? domContent : (entry?.content ?? storedC);
    let digest  = domDigest  !== null ? domDigest  : (entry?.digest  ?? storedD);

    // Safety: if editor was NOT dirtied by actual user input, prefer non-empty stored/cached content
    if (!isDirty) {
      if (!content && (entry?.content || storedC)) content = entry?.content || storedC;
      if (!digest && (entry?.digest || storedD))   digest  = entry?.digest  || storedD;
    }

    return { content, digest, wasDirty: isDirty };
  } else {
    // DOM editors are not bound to this PDF. Use cache if dirty, otherwise prefer non-empty cache or localStorage.
    const storedC = safeStorageGet('local_notepad_' + pdfId, '') ?? '';
    const storedD = safeStorageGet('local_digest_'  + pdfId, '') ?? '';
    const content = entry ? (entry.dirty ? (entry.content ?? '') : (entry.content || storedC)) : storedC;
    const digest  = entry ? (entry.dirty ? (entry.digest  ?? '') : (entry.digest  || storedD)) : storedD;
    return { content, digest, wasDirty: entry ? !!entry.dirty : false };
  }
}

// ── Update the local-save indicator (💾) in the notepad header ──
function updateLocalSaveLabel(state) {
  // state: 'saving' | 'saved' | 'error'
  const lbl = document.getElementById('np-local-lbl');
  if (!lbl) return;
  if (state === 'saved') {
    lbl.textContent = '💾 Local ✓';
    lbl.title = 'Saved to this device\'s local storage';
    lbl.style.color = '#4ade80';
  } else if (state === 'saving') {
    lbl.textContent = '💾 Saving…';
    lbl.title = 'Writing to local storage…';
    lbl.style.color = 'var(--gold, #facc15)';
  } else {
    lbl.textContent = '💾 Local ✗';
    lbl.title = 'Local save error';
    lbl.style.color = '#f87171';
  }
}


// ── Helper to update save status label consistently across auto-save and flush ──
// This reflects CLOUD (Supabase) save status only. Local save status is shown via updateLocalSaveLabel.
function updateSaveStatusLabel(targetPdfId, res) {
  if (_activePdfId !== targetPdfId) return;
  const lbl = $saveLbl();
  if (!lbl) return;

  if (res?.saved && (res?.code === '200_OK' || !res?.code)) {
    lbl.textContent = '☁️ Cloud ✓';
    lbl.className = 'saved';
    lbl.title = 'Saved to Supabase cloud (Click for Error & Sync Log)';
  } else if (res?.code === 'WARN_SAVED_WITHOUT_DIGEST') {
    lbl.textContent = '☁️ ⚠️ No Digest';
    lbl.className = 'saving';
    lbl.title = 'Notes saved to cloud, but "digest" column is missing in Supabase. Digest saved locally. Click for Error Log.';
  } else if (res?.code === 'ERR_23503_FK' || res?.localOnly) {
    lbl.textContent = '☁️ Local Only';
    lbl.className = 'saving';
    lbl.title = 'PDF missing in Supabase library table (23503). Saved safely to local storage. Click for Error Log.';
  } else if (res?.queued) {
    lbl.textContent = '☁️ Queued…';
    lbl.className = 'saving';
    lbl.title = 'Offline or cloud sync pending. Queued in outbox. Click for Error Log.';
  } else if (res?.error && !res?.saved) {
    lbl.textContent = `☁️ ✗ ${res.code || 'FAIL'}`;
    lbl.className = 'err';
    lbl.title = `Cloud save failed: ${res.error}. Click to open Error Log.`;
  } else if (res?.saved) {
    lbl.textContent = '☁️ Cloud ✓';
    lbl.className = 'saved';
    lbl.title = 'Saved to cloud (Click for Error & Sync Log)';
  }

  setTimeout(() => {
    if (_activePdfId === targetPdfId && (lbl.textContent.includes('✓') || lbl.textContent === '☁️ Cloud ✓')) {
      lbl.textContent = '';
      lbl.className = '';
      lbl.title = '';
    }
  }, 3500);
}


// ── Execute an explicit save for a specific PDF ID ──
async function executeSaveForPdf(targetPdfId) {
  if (!targetPdfId || _loadingPdfIds.has(targetPdfId)) return;

  // DOM-first when bound, cache/localStorage when closed
  let { content, digest, wasDirty } = _readEditorContent(targetPdfId);

  // Mark cache clean (no longer dirty now that we're saving)
  const entry = _notepadCache.get(targetPdfId);
  if (entry) entry.dirty = false;

  // ANTI-WIPE SAFETY GUARD (per field):
  // Never allow an empty editor to overwrite non-empty local storage unless user actively typed an edit!
  const existingC = safeStorageGet('local_notepad_' + targetPdfId, '') || '';
  const existingD = safeStorageGet('local_digest_' + targetPdfId, '') || '';
  if (!content && existingC && !entry?.hadUserInput) content = existingC;
  if (!digest && existingD && !entry?.hadUserInput)   digest = existingD;
  if (!content && !digest && (existingC || existingD) && !entry?.hadUserInput) {
    console.warn(`[Notepad Safety] Blocked accidental wipe in executeSaveForPdf for ${targetPdfId}`);
    return;
  }

  _notepadCache.set(targetPdfId, {
    content,
    digest,
    dirty: false,
    hadUserInput: false,
    timestamp: Date.now(),
  });

  try {
    const savedWriteTs = getWriteTs(targetPdfId);
    // ── Snapshot BEFORE the cloud save: if DB throws or tab closes mid-flight,
    //    the content is already preserved in IndexedDB and localStorage history. ──
    await saveHistorySnapshot(targetPdfId, content, digest);
    const res = await _saveChangedFields(targetPdfId, content, digest);
    // Only mark synced if Supabase confirmed AND no new writes arrived during the save
    if (res?.saved && !res?.localOnly && !res?.queued && getWriteTs(targetPdfId) === savedWriteTs) {
      setSyncTs(targetPdfId);
    } else if (!res?.saved) {
      const cur = _notepadCache.get(targetPdfId);
      if (cur) cur.dirty = true;
    }

    updateSaveStatusLabel(targetPdfId, res);
    // If save did not succeed (and wasn't just a local-only FK edge case), show the warning banner
    if (res && !res.saved && res.error && !res.localOnly) {
      checkAndAlertSaveErrors();
    }
  } catch (err) {
    const cur = _notepadCache.get(targetPdfId);
    if (cur) cur.dirty = true;
    console.error(`[Notepad] Save failed for ${targetPdfId}:`, err);
    logNotepadDiagnostic(targetPdfId, 'SAVE', 'ERR', err?.code || 'FAIL',
      `Save exception: ${err?.message || String(err)}.`, { error: String(err) });
    // Show the persistent warning banner immediately so the user sees something is wrong
    checkAndAlertSaveErrors();
    if (_activePdfId === targetPdfId) {
      const lbl = $saveLbl();
      if (lbl) {
        lbl.textContent = `✗ Err: ${err?.code || 'FAIL'}`;
        lbl.className = 'err';
        lbl.title = `Save failed: ${err?.message || err}. Click to open Error Log.`;
      }
    }
  }
}

// ── Schedule auto-save 1.0s after last keystroke, strictly locked to targetPdfId ──
function scheduleSaveForPdf(pdfId) {
  if (!pdfId) return;

  const lbl = $saveLbl();
  if (lbl && _activePdfId === pdfId) {
    lbl.textContent = 'Unsaved…';
    lbl.className = 'saving';
    lbl.title = 'Unsaved local changes (auto-saving in 1s…)';
  }

  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }

  _timerPdfId = pdfId;
  _saveTimer = setTimeout(async () => {
    const toSave = _timerPdfId;
    _saveTimer = null;
    _timerPdfId = null;
    if (toSave) {
      await executeSaveForPdf(toSave);
    }
  }, 1000);
}

// ── Immediately flush pending save for the active PDF ──
export async function flushNotepadSave(specificPdfId = null) {
  const targetPdfId = specificPdfId || _timerPdfId || _activePdfId;
  if (!targetPdfId || _loadingPdfIds.has(targetPdfId)) return;

  const hadTimer = !!_saveTimer;
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
    _timerPdfId = null;
  }

  if (targetPdfId) {
    const entry = _notepadCache.get(targetPdfId);

    // Check if the live DOM editors have uncaptured edits compared to the cached entry
    let domDiffers = false;
    if (_domBoundPdfId === targetPdfId && _activePdfId === targetPdfId) {
      const domC = $notesEditor()?.innerHTML ?? '';
      const domD = $digestEditor()?.innerHTML ?? '';
      const prevC = entry ? (entry.content ?? '') : (safeStorageGet('local_notepad_' + targetPdfId, '') ?? '');
      const prevD = entry ? (entry.digest  ?? '') : (safeStorageGet('local_digest_'  + targetPdfId, '') ?? '');
      if (domC !== prevC || domD !== prevD) {
        domDiffers = true;
        setWriteTs(targetPdfId);
        if (entry) {
          entry.content = domC;
          entry.digest = domD;
          entry.dirty = true;
          entry.hadUserInput = true;
        }
      }
    }

    // If not dirty, no save timer was active, and DOM matches cache, nothing was changed — skip saving!
    if (!entry?.dirty && !hadTimer && !domDiffers) {
      return;
    }

    // Use the shared helper: DOM-first when bound, cache/localStorage when closed
    let { content, digest, wasDirty } = _readEditorContent(targetPdfId);
    if (domDiffers) wasDirty = true;
    if (!wasDirty && !hadTimer) {
      return;
    }

    // ANTI-WIPE SAFETY GUARD (per field):
    const existingC = safeStorageGet('local_notepad_' + targetPdfId, '') || '';
    const existingD = safeStorageGet('local_digest_' + targetPdfId, '') || '';
    if (!content && existingC && !entry?.hadUserInput) content = existingC;
    if (!digest && existingD && !entry?.hadUserInput)   digest = existingD;
    if (!content && !digest && (existingC || existingD) && !entry?.hadUserInput) {
      console.warn(`[Notepad Safety] Blocked accidental wipe in flushNotepadSave for ${targetPdfId}`);
      return;
    }

    if (entry) entry.dirty = false;

    _notepadCache.set(targetPdfId, {
      content,
      digest,
      dirty: false,
      hadUserInput: false,
      timestamp: Date.now()
    });

    safeStorageSet('local_notepad_' + targetPdfId, content);
    safeStorageSet('local_digest_' + targetPdfId, digest);

    // ── Snapshot BEFORE cloud save: data is preserved even if DB throws ──
    await saveHistorySnapshot(targetPdfId, content, digest);

    try {
      const savedWriteTs = getWriteTs(targetPdfId);
      const res = await _saveChangedFields(targetPdfId, content, digest);
      if (res?.saved && !res?.localOnly && !res?.queued && getWriteTs(targetPdfId) === savedWriteTs) {
        setSyncTs(targetPdfId);
      } else if (!res?.saved) {
        const cur = _notepadCache.get(targetPdfId);
        if (cur) cur.dirty = true;
      }
      updateSaveStatusLabel(targetPdfId, res);
    } catch (err) {
      const cur = _notepadCache.get(targetPdfId);
      if (cur) cur.dirty = true;
      // Flush errors must NEVER be silent — log to diag and show in UI
      logNotepadDiagnostic(targetPdfId, 'SAVE', 'ERR', err?.code || 'ERR_FLUSH',
        `flushNotepadSave exception: ${err?.message || String(err)}. Data is safe in localStorage + history.`,
        { error: String(err) });
      // Show the persistent warning banner immediately
      checkAndAlertSaveErrors();
      if (_activePdfId === targetPdfId) {
        const lbl = $saveLbl();
        if (lbl) {
          lbl.textContent = '✗ Flush Err';
          lbl.className = 'err';
          lbl.title = `Flush save failed: ${err?.message || err}. Click to open Error Log.`;
        }
      }
    }
  }
}

// ── Open notepad for a specific PDF with atomic sequencing & cache priming ──
export async function openNotepad(pdfId) {
  if (!pdfId) {
    _domBoundPdfId = null;
    if ($notesEditor()) $notesEditor().innerHTML = '';
    if ($digestEditor()) $digestEditor().innerHTML = '';
    const lbl = $saveLbl();
    if (lbl) { lbl.textContent = ''; lbl.className = ''; lbl.title = ''; }
    return;
  }

  // 1. Flush previous PDF notes if switching
  if (_activePdfId && _activePdfId !== pdfId) {
    await flushNotepadSave(_activePdfId);
  }

  _activePdfId = pdfId;
  const seq = ++_loadSeq;

  const panel = $panel();
  const notesEd = $notesEditor();
  const digestEd = $digestEditor();

  closeOtherPanels('notepad-panel');
  panel.classList.add('open');

  // Reset/sync save status label for the active PDF
  const lbl = $saveLbl();
  if (lbl) {
    const cachedEntry = _notepadCache.get(pdfId);
    if (cachedEntry?.dirty) {
      lbl.textContent = 'Unsaved…';
      lbl.className = 'saving';
      lbl.title = 'Unsaved local changes';
    } else {
      lbl.textContent = '';
      lbl.className = '';
      lbl.title = '';
    }
  }

  // 2. Prime UI immediately from memory or local cache (0ms instant response, no blank flash)
  let initialContent = '';
  let initialDigest = '';

  const truePdfId = S.pdfs?.find(p => p.id === pdfId)?.linked_pdf_id || pdfId;
  const storedC = safeStorageGet('local_notepad_' + truePdfId, '') || (truePdfId !== pdfId ? safeStorageGet('local_notepad_' + pdfId, '') : '') || '';
  const storedD = safeStorageGet('local_digest_'  + truePdfId, '') || (truePdfId !== pdfId ? safeStorageGet('local_digest_'  + pdfId, '') : '') || '';

  if (_notepadCache.has(pdfId)) {
    const entry = _notepadCache.get(pdfId);
    initialContent = entry.dirty ? (entry.content || '') : (entry.content || storedC);
    initialDigest  = entry.dirty ? (entry.digest  || '') : (entry.digest  || storedD);
  } else if (_notepadCache.has(truePdfId)) {
    const entry = _notepadCache.get(truePdfId);
    initialContent = entry.dirty ? (entry.content || '') : (entry.content || storedC);
    initialDigest  = entry.dirty ? (entry.digest  || '') : (entry.digest  || storedD);
  } else {
    initialContent = storedC;
    initialDigest  = storedD;
  }

  if (notesEd) notesEd.innerHTML = initialContent;
  if (digestEd) digestEd.innerHTML = initialDigest;
  _domBoundPdfId = pdfId;

  const activeEd = $currentEditor();
  if (activeEd) {
    try {
      const range = document.createRange();
      const sel   = window.getSelection();
      range.selectNodeContents(activeEd);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      activeEd.focus();
    } catch {}
  }

  // 3. Load latest data from database
  _loadingPdfIds.add(pdfId);
  try {
    const {
      content: remoteContent,
      digest: remoteDigest,
      cloudContent = '',
      cloudDigest = '',
      cloudExists = false,
      cloudOk = false,
    } = await dbLoadNotepad(pdfId);

    // Sequence check: discard if user hopped to another PDF while loading
    if (_loadSeq !== seq || _activePdfId !== pdfId) return;

    // Remember exactly what the CLOUD row holds (not the local fallback) so later saves
    // only send what the user actually changes.
    if (cloudOk) _setCloudBase(pdfId, cloudContent || '', cloudDigest || '');

    const currentEntry = _notepadCache.get(pdfId);
    // If user typed while cloud load was in flight, merge their live edits with any newly arrived cloud data
    if (currentEntry?.dirty) {
      const liveC = notesEd ? (notesEd.innerHTML ?? '') : (currentEntry.content || '');
      const liveD = digestEd ? (digestEd.innerHTML ?? '') : (currentEntry.digest || '');
      const mergedC = (!initialContent && cloudContent && liveC !== cloudContent)
        ? mergeNoteHtml(liveC, cloudContent)
        : (liveC || cloudContent);
      const mergedD = (!initialDigest && cloudDigest && liveD !== cloudDigest)
        ? mergeNoteHtml(liveD, cloudDigest)
        : (liveD || cloudDigest);
      if (notesEd && notesEd.innerHTML !== mergedC) notesEd.innerHTML = mergedC;
      if (digestEd && digestEd.innerHTML !== mergedD) digestEd.innerHTML = mergedD;
      _notepadCache.set(pdfId, { content: mergedC, digest: mergedD, dirty: true, timestamp: Date.now() });
      safeStorageSet('local_notepad_' + pdfId, mergedC);
      safeStorageSet('local_digest_' + pdfId, mergedD);
      setWriteTs(pdfId);
      scheduleSaveForPdf(pdfId);
      return;
    }

    // Use raw cloudContent/cloudDigest when cloud query succeeded so local fallback never masks missing cloud data!
    const localContent = initialContent || (!cloudContent && remoteContent ? remoteContent : '');
    const localDigest  = initialDigest  || (!cloudDigest  && remoteDigest  ? remoteDigest  : '');
    const remC = cloudOk ? (cloudContent || '') : (remoteContent || '');
    const remD = cloudOk ? (cloudDigest  || '') : (remoteDigest  || '');

    // ── Conflict detection: did this device have unsynced local writes? ──
    const writeTs = getWriteTs(pdfId);
    const syncTs  = getSyncTs(pdfId);
    const hasLocalUnsaved = writeTs > 0 && writeTs > syncTs;
    const hasLegacyLocal  = writeTs === 0 && syncTs === 0 && !!(localContent || localDigest) && (localContent !== remC || localDigest !== remD);

    let finalContent = remC;
    let finalDigest  = remD;
    let didMerge = false;
    let pushLocal = false;

    // Resolve Notes (content) independently
    if (localContent && !remC) {
      finalContent = localContent;
      if (cloudOk) pushLocal = true;
    } else if (!localContent && remC) {
      finalContent = remC;
    } else if (localContent && remC && localContent !== remC) {
      if (hasLocalUnsaved || hasLegacyLocal) {
        finalContent = mergeNoteHtml(localContent, remC);
        didMerge = true;
      } else {
        finalContent = remC;
      }
    } else {
      finalContent = remC || localContent || '';
    }

    // Resolve Case Digest (digest) independently
    if (localDigest && !remD) {
      finalDigest = localDigest;
      if (cloudOk) pushLocal = true;
    } else if (!localDigest && remD) {
      finalDigest = remD;
    } else if (localDigest && remD && localDigest !== remD) {
      if (hasLocalUnsaved || hasLegacyLocal) {
        finalDigest = mergeNoteHtml(localDigest, remD);
        didMerge = true;
      } else {
        finalDigest = remD;
      }
    } else {
      finalDigest = remD || localDigest || '';
    }

    _notepadCache.set(pdfId, {
      content:   finalContent,
      digest:    finalDigest,
      dirty:     didMerge || pushLocal,
      timestamp: Date.now()
    });

    safeStorageSet('local_notepad_' + pdfId, finalContent);
    safeStorageSet('local_digest_'  + pdfId, finalDigest);

    if (notesEd) notesEd.innerHTML = finalContent;
    if (digestEd) digestEd.innerHTML = finalDigest;
    _domBoundPdfId = pdfId;

    if (didMerge || pushLocal) {
      // Push the merged/recovered local notes or digest to Supabase immediately
      setWriteTs(pdfId);
      executeSaveForPdf(pdfId);
      if (didMerge) toast('⚠️ Notes from two devices were merged — please review and clean up.');
      else if (pushLocal) toast('☁️ Local notes/digest synced to cloud.');
    } else {
      // Only stamp sync_ts when Supabase was actually queried and matches both finalContent and finalDigest
      if (cloudOk && (cloudExists || (!finalContent && !finalDigest)) && remC === finalContent && remD === finalDigest) {
        setSyncTs(pdfId);
      }
      const curLbl = $saveLbl();
      if (curLbl && !currentEntry?.dirty) {
        curLbl.textContent = '';
        curLbl.className = '';
        curLbl.title = '';
      }
    }
  } catch (e) {
    console.error('[Notepad load error]', e);
    logNotepadDiagnostic(pdfId, 'LOAD', 'ERR', e?.code || 'ERR_LOAD',
      `Failed to load notes from cloud: ${e?.message || String(e)}. Local data is safe.`,
      { error: String(e) });
    // Show error in save label so it's visible
    const lbl = $saveLbl();
    if (lbl && _activePdfId === pdfId) {
      lbl.textContent = '⚠️ Load Err';
      lbl.className = 'err';
      lbl.title = `Cloud load failed: ${e?.message || e}. Using local data. Click to see Error Log.`;
    }
  } finally {
    _loadingPdfIds.delete(pdfId);
    // If the user typed and then switched away while the load lock was held, their save was
    // skipped by the lock. Push it now instead of waiting for the next background sweep.
    if (_activePdfId !== pdfId && _notepadCache.get(pdfId)?.dirty) {
      executeSaveForPdf(pdfId).catch(() => {});
    }
  }
}

export async function closeNotepad() {
  // Flush BEFORE removing .open so DOM editors are guaranteed to be read
  await flushNotepadSave();
  $panel()?.classList.remove('open');
  const lbl = $saveLbl();
  if (lbl && (lbl.textContent === 'Unsaved…' || lbl.className === 'saving')) {
    lbl.textContent = '';
    lbl.className = '';
    lbl.title = '';
  }
}

// ── Switch between Notes and Digest tabs ──
export function switchNotepadTab(tab) {
  // Capture latest text from both editors into cache if dirty, but do NOT mark dirty
  // merely from clicking tabs (prevents empty tab clicks during load from overwriting cloud data).
  if (_activePdfId && _domBoundPdfId === _activePdfId) {
    const curContent = $notesEditor()?.innerHTML ?? '';
    const curDigest  = $digestEditor()?.innerHTML ?? '';
    const existing   = _notepadCache.get(_activePdfId);
    const hasChanged = existing
      ? (curContent !== (existing.content ?? '') || curDigest !== (existing.digest ?? ''))
      : false;

    if (hasChanged) {
      _notepadCache.set(_activePdfId, {
        content: curContent,
        digest: curDigest,
        dirty: true,
        timestamp: Date.now(),
      });
      safeStorageSet('local_notepad_' + _activePdfId, curContent);
      safeStorageSet('local_digest_' + _activePdfId, curDigest);
      setWriteTs(_activePdfId);
      scheduleSaveForPdf(_activePdfId);
    }
  }

  _activeTab = tab;
  document.querySelectorAll('#np-tabs .ap-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.nptab === tab);
  });

  const notesEd = $notesEditor();
  const digestEd = $digestEditor();

  if (tab === 'digest') {
    if (notesEd) notesEd.style.display = 'none';
    if (digestEd) digestEd.style.display = 'block';
    digestEd?.focus();
  } else {
    if (digestEd) digestEd.style.display = 'none';
    if (notesEd) notesEd.style.display = 'block';
    notesEd?.focus();
  }
}

// ── Called whenever the active PDF changes in viewer or dual-view ──
export async function notepadOnPDFChange(newPdfId) {
  const oldPdfId = _activePdfId;

  // 1. Immediately flush old PDF data before clearing editor DOM
  if (oldPdfId && oldPdfId !== newPdfId) {
    await flushNotepadSave(oldPdfId);
  }

  // 2. Clear editor DOM and save label immediately
  _domBoundPdfId = null;
  const notesEd = $notesEditor();
  const digestEd = $digestEditor();
  if (notesEd) notesEd.innerHTML = '';
  if (digestEd) digestEd.innerHTML = '';
  const lbl = $saveLbl();
  if (lbl) {
    lbl.textContent = '';
    lbl.className = '';
    lbl.title = '';
  }

  // 3. Update active pointer
  _activePdfId = newPdfId;

  // 4. If notepad panel is open, open for new PDF
  if (newPdfId && $panel()?.classList.contains('open')) {
    await openNotepad(newPdfId);
  }
}

// ── History panel: show snapshots and allow revert ──
function formatHistoryDate(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return String(ts); }
}

function htmlToPlainPreview(html) {
  if (!html) return '(empty)';
  try {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) || '(empty)';
  } catch { return '(empty)'; }
}

// ── History & Diagnostics panel: show snapshots and live error logs ──
export async function openHistoryPanel(initialTab = 'snapshots') {
  const pdfId = _activePdfId;
  if (!pdfId) {
    toast('Open a PDF first to view its note history and error logs.');
    return;
  }

  const modal = document.getElementById('np-history-modal');
  const snapList  = document.getElementById('np-history-list');
  const diagList  = document.getElementById('np-diag-list');
  const btnSnapshots = document.getElementById('nhm-tab-snapshots');
  const btnLogs      = document.getElementById('nhm-tab-logs');
  const viewSnapshots= document.getElementById('np-history-view-snapshots');
  const viewLogs     = document.getElementById('np-history-view-logs');
  const copyBtn      = document.getElementById('nhm-copy-diag-btn');
  const countSpan    = document.getElementById('nhm-log-count');

  if (!modal) return;

  modal.classList.add('open');

  // Wire up tabs
  function switchTab(t) {
    if (t === 'logs') {
      btnLogs?.classList.add('active');
      btnSnapshots?.classList.remove('active');
      if (viewLogs) viewLogs.style.display = 'flex';
      if (viewSnapshots) viewSnapshots.style.display = 'none';
      renderLogs();
    } else {
      btnSnapshots?.classList.add('active');
      btnLogs?.classList.remove('active');
      if (viewSnapshots) viewSnapshots.style.display = 'flex';
      if (viewLogs) viewLogs.style.display = 'none';
      renderSnapshots();
    }
  }

  if (btnSnapshots) btnSnapshots.onclick = () => switchTab('snapshots');
  if (btnLogs) btnLogs.onclick = () => switchTab('logs');

  // Copy diagnostics button
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const curPdf = S.pdfs?.find(p => p.id === pdfId);
      const report = generateDiagnosticReport(pdfId, curPdf?.name || '');
      try {
        await navigator.clipboard.writeText(report);
        copyBtn.textContent = '✓ Copied Report!';
        setTimeout(() => { copyBtn.textContent = '📋 Copy Diagnostics'; }, 2500);
        toast('📋 Diagnostic error report copied to clipboard!');
      } catch {
        toast('Clipboard copy blocked by browser. Please select text manually.');
      }
    };
  }

  // Render logs tab
  function renderLogs() {
    if (!diagList) return;
    const logs = getNotepadDiagnostics(pdfId);
    if (countSpan) countSpan.textContent = String(logs.length);

    if (logs.length === 0) {
      diagList.innerHTML = '<div class="nhm-empty">No sync or error events recorded for this PDF yet.<br>Saving or loading notes will automatically record detailed error codes here.</div>';
      return;
    }

    diagList.innerHTML = '';
    logs.forEach(item => {
      const div = document.createElement('div');
      div.className = 'diag-entry';

      const badgeClass = item.status === 'OK' ? 'diag-badge-ok' :
                         item.status === 'WARN' ? 'diag-badge-warn' :
                         item.status === 'ERR' ? 'diag-badge-err' : 'diag-badge-info';

      const dStr = formatHistoryDate(item.ts);
      let extraHtml = '';
      if (item.extra && Object.keys(item.extra).length > 0) {
        extraHtml = `<pre class="diag-extra">${JSON.stringify(item.extra, null, 2)}</pre>`;
      }

      div.innerHTML = `
        <div class="diag-entry-hd">
          <span class="diag-ts">${dStr}</span>
          <span class="diag-action">[${item.action}]</span>
          <span class="diag-badge ${badgeClass}">${item.code} (${item.status})</span>
        </div>
        <div class="diag-msg">${item.message}</div>
        ${extraHtml}
      `;
      diagList.appendChild(div);
    });
  }

  // Render snapshots tab
  async function renderSnapshots() {
    if (!snapList) return;
    snapList.innerHTML = '<div class="nhm-empty">Loading history…</div>';

    // Snapshot current state
    const curContent = $notesEditor()?.innerHTML ?? '';
    const curDigest  = $digestEditor()?.innerHTML ?? '';
    if (curContent || curDigest) {
      await saveHistorySnapshot(pdfId, curContent, curDigest);
    }

    const entries = [];

    try {
      const { dbLoadNotepad: load } = await import('./db.js');
      const cloudData = await load(pdfId);
      if (cloudData.content || cloudData.digest) {
        entries.push({
          t: null,
          content: cloudData.content || '',
          digest:  cloudData.digest  || '',
          badge:   'cloud',
          label:   '☁️ Cloud (Supabase) — current saved version'
        });
      }
    } catch (err) {
      console.warn('[History] Cloud fetch error:', err);
    }

    try {
      let hist = await getNotepadHistoryIDB(pdfId);
      if (!Array.isArray(hist) || hist.length === 0) {
        hist = JSON.parse(safeStorageGet('notepad_history_' + pdfId, '[]') || '[]');
      }
      for (let i = hist.length - 1; i >= 0; i--) {
        const snap = hist[i];
        entries.push({
          t:       snap.t,
          content: snap.content || '',
          digest:  snap.digest  || '',
          badge:   i === hist.length - 1 ? 'current' : 'local',
          label:   i === hist.length - 1 ? '📍 Latest local snapshot' : '📂 Local snapshot'
        });
      }
    } catch {}

    if (entries.length === 0) {
      snapList.innerHTML = '<div class="nhm-empty">No history snapshots found for this PDF yet.<br>Snapshots are created automatically each time notes are saved.</div>';
      return;
    }

    snapList.innerHTML = '';
    entries.forEach((entry, idx) => {
      const div = document.createElement('div');
      div.className = 'nhm-entry';

      const tsStr = entry.t ? formatHistoryDate(entry.t) : '';
      const badgeClass = entry.badge === 'cloud' ? 'nhm-badge-cloud' :
                         entry.badge === 'current' ? 'nhm-badge-current' : 'nhm-badge-local';

      const hd = document.createElement('div');
      hd.className = 'nhm-entry-hd';
      hd.innerHTML = `
        <span class="nhm-ts">${entry.label}${tsStr ? ' — ' + tsStr : ''}</span>
        <span class="nhm-badge ${badgeClass}">${entry.badge === 'cloud' ? 'CLOUD' : entry.badge === 'current' ? 'LATEST' : 'LOCAL'}</span>
        <button class="nhm-restore-btn" data-idx="${idx}" title="Restore this version">Restore</button>
      `;

      const preview = document.createElement('div');
      preview.className = 'nhm-preview';
      const notesPreview = htmlToPlainPreview(entry.content);
      const digestPreview = htmlToPlainPreview(entry.digest);
      preview.textContent = notesPreview !== '(empty)'
        ? notesPreview
        : digestPreview !== '(empty)' ? '(Digest) ' + digestPreview : '(empty)';

      div.appendChild(hd);
      div.appendChild(preview);
      snapList.appendChild(div);

      hd.querySelector('.nhm-restore-btn').addEventListener('click', async () => {
        const confirmRestore = confirm(
          `Restore this version?\n\n"${notesPreview.slice(0, 120)}…"\n\nYour current notes will be snapshotted first so you can always revert again.`
        );
        if (!confirmRestore) return;

        const before = $notesEditor()?.innerHTML ?? '';
        const beforeD = $digestEditor()?.innerHTML ?? '';
        saveHistorySnapshot(pdfId, before, beforeD);

        const notesEd = $notesEditor();
        const digestEd = $digestEditor();
        if (notesEd) notesEd.innerHTML = entry.content;
        if (digestEd) digestEd.innerHTML = entry.digest;

        _notepadCache.set(pdfId, {
          content:   entry.content,
          digest:    entry.digest,
          dirty:     true,
          timestamp: Date.now()
        });
        setWriteTs(pdfId);
        safeStorageSet('local_notepad_' + pdfId, entry.content);
        safeStorageSet('local_digest_' + pdfId, entry.digest);

        logNotepadDiagnostic(pdfId, 'RESTORE', 'INFO', 'INFO_USER_RESTORE', `User restored version from ${entry.label}`);

        modal.classList.remove('open');
        toast('⏪ Notes restored — saving to cloud…');
        await executeSaveForPdf(pdfId);
        toast('✓ Restored version saved to cloud.');
      });
    });
  }

  // Update diagnostic count badge
  const allLogs = getNotepadDiagnostics(pdfId);
  if (countSpan) countSpan.textContent = String(allLogs.length);

  // Show requested initial tab
  switchTab(initialTab);
}

export function getCachedNotepad(pdfId) {
  if (!pdfId) return null;
  if (_activePdfId === pdfId) {
    return {
      content: $notesEditor()?.innerHTML ?? '',
      digest: $digestEditor()?.innerHTML ?? ''
    };
  }
  if (_notepadCache.has(pdfId)) {
    const entry = _notepadCache.get(pdfId);
    return {
      content: entry.content || '',
      digest: entry.digest || ''
    };
  }
  return null;
}

// ── Called by sync.js after a realtime notepad refresh so in-memory cache stays fresh ──
export function updateNotepadCacheFromRemote(pdfId, content, digest) {
  if (!pdfId) return;
  const existing = _notepadCache.get(pdfId);
  // Don't overwrite if the user has unsaved (dirty) local changes
  if (existing?.dirty) return;

  const localC = existing?.content || safeStorageGet('local_notepad_' + pdfId, '') || '';
  const localD = existing?.digest  || safeStorageGet('local_digest_'  + pdfId, '') || '';

  // ANTI-WIPE GUARD: Don't overwrite non-empty local data with empty remote data.
  if (!content && !digest && (localC || localD)) {
    logNotepadDiagnostic(pdfId, 'SYNC', 'WARN', 'SYNC_BLOCKED_EMPTY_REMOTE',
      `Blocked empty remote sync from overwriting local data (Notes: ${localC.length} chars, Digest: ${localD.length} chars).`);
    return;
  }

  // Per-field protection if local has unsynced writes or remote field is unexpectedly empty
  const hasUnsaved = getWriteTs(pdfId) > getSyncTs(pdfId);
  const safeContent = (content || (hasUnsaved ? localC : '') || localC) ? (content || localC) : '';
  const safeDigest  = (digest  || (hasUnsaved ? localD : '') || localD) ? (digest  || localD) : '';

  _notepadCache.set(pdfId, {
    content: safeContent,
    digest: safeDigest,
    dirty: false,
    timestamp: Date.now()
  });
  // Keep localStorage in sync too
  safeStorageSet('local_notepad_' + pdfId, safeContent);
  safeStorageSet('local_digest_' + pdfId, safeDigest);
  logNotepadDiagnostic(pdfId, 'SYNC', 'OK', 'SYNC_CACHE_UPDATED',
    `In-memory cache updated from realtime sync (Notes: ${safeContent.length} chars, Digest: ${safeDigest.length} chars)`);
}

// ── Random spot-check: verify a few notes against the REAL cloud row and repair drift ──
// Catches the "local is fine but cloud silently lost / never received it" case even when
// write_ts/sync_ts say everything is synced (e.g. a write that was reported OK but dropped).
let _isVerifying = false;
export async function verifyRandomNotesAgainstCloud({ sampleSize = 3, silent = true } = {}) {
  if (_isVerifying || _isSyncing) return;
  if (!navigator.onLine) return;
  const allPdfs = S.pdfs || [];
  if (allPdfs.length === 0) return;

  // Candidates: unique canonical PDFs that have local content and are NOT currently being edited
  const now = Date.now();
  const seenIds = new Set();
  const candidates = [];
  for (const p of allPdfs) {
    const id = p.linked_pdf_id || p.id;
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    if (id === _activePdfId && _notepadCache.get(id)?.dirty) continue;
    if (now - getWriteTs(id) < 15_000) continue; // too fresh, auto-save still in flight
    const hasLocal = !!(
      safeStorageGet('local_notepad_' + id, '') ||
      safeStorageGet('local_digest_'  + id, '') ||
      safeStorageGet('local_notepad_' + p.id, '') ||
      safeStorageGet('local_digest_'  + p.id, '')
    );
    if (hasLocal) candidates.push(p);
  }
  if (candidates.length === 0) return;

  // Fisher–Yates partial shuffle → random sample
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const sample = candidates.slice(0, sampleSize);

  _isVerifying = true;
  let repaired = 0, adopted = 0, errors = 0;
  try {
    for (const pdf of sample) {
      const id = pdf.linked_pdf_id || pdf.id;
      try {
        const localC = safeStorageGet('local_notepad_' + id, '') || safeStorageGet('local_notepad_' + pdf.id, '') || '';
        const localD = safeStorageGet('local_digest_'  + id, '') || safeStorageGet('local_digest_'  + pdf.id, '') || '';
        const cloud = await dbFetchCloudNotepadRaw(id);
        if (!cloud.ok) {
          errors++;
          logNotepadDiagnostic(id, 'VERIFY', 'ERR', 'ERR_VERIFY_READ', `Spot-check could not read cloud row: ${cloud.error}`);
          continue;
        }
        const digestMatch = cloud.digestKnown === false || cloud.digest === localD;
        if (cloud.exists && cloud.content === localC && digestMatch) {
          logNotepadDiagnostic(id, 'VERIFY', 'OK', 'VERIFY_MATCH', 'Spot-check: local and cloud are identical.');
          continue;
        }

        const cloudEmpty = !cloud.exists || (!cloud.content && !cloud.digest);
        const missingCloudC = !!(localC && !cloud.content);
        const missingCloudD = !!(localD && cloud.digestKnown !== false && !cloud.digest);
        const localDirty = getWriteTs(id) > getSyncTs(id) || getSyncTs(id) === 0;

        if (cloudEmpty || missingCloudC || missingCloudD || localDirty) {
          // Cloud is missing Notes or Digest that exist locally, or local has newer edits → push combined up!
          const uploadC = localC || cloud.content || '';
          const uploadD = localD || cloud.digest  || '';
          const res = await dbSaveNotepad(id, uploadC, uploadD);
          const re = res?.saved && !res?.localOnly ? await dbFetchCloudNotepadRaw(id) : null;
          const ok = re?.ok && re.exists && re.content === uploadC && (re.digestKnown === false || re.digest === uploadD);
          if (ok) {
            _setCloudBase(id, uploadC, re.digestKnown === false ? undefined : uploadD);
            setSyncTs(id);
            repaired++;
            logNotepadDiagnostic(id, 'VERIFY', 'WARN', 'VERIFY_REPAIRED_CLOUD',
              `Spot-check found cloud ${cloudEmpty ? 'missing/empty' : (missingCloudD ? 'missing digest' : 'behind local')} — re-uploaded from this device and verified.`);
          } else {
            errors++;
            logNotepadDiagnostic(id, 'VERIFY', 'ERR', 'ERR_VERIFY_REPAIR_FAILED',
              `Spot-check found cloud out of date and re-upload could not be verified (${res?.error || 'read-back mismatch'}).`);
          }
        } else if (id !== _activePdfId) {
          // Local is clean (was synced) and cloud has non-empty content/digest from another device.
          // NEVER overwrite a non-empty local field with an empty cloud field!
          // Keep a restorable copy of what we're about to replace (visible in 🕐 History → Snapshots)
          await saveHistorySnapshot(id, localC, localD);
          if (cloud.content) safeStorageSet('local_notepad_' + id, cloud.content);
          if (cloud.digestKnown !== false && cloud.digest) safeStorageSet('local_digest_' + id, cloud.digest);
          _notepadCache.delete(id);
          _setCloudBase(id, cloud.content, cloud.digestKnown === false ? undefined : cloud.digest);
          setSyncTs(id);
          adopted++;
          logNotepadDiagnostic(id, 'VERIFY', 'WARN', 'VERIFY_ADOPTED_CLOUD',
            'Spot-check: cloud had a newer version from another device — local copy updated.');
        }
      } catch (err) {
        errors++;
        logNotepadDiagnostic(id, 'VERIFY', 'ERR', 'ERR_VERIFY', `Spot-check exception: ${err?.message || String(err)}`, { error: String(err) });
      }
    }
  } finally {
    _isVerifying = false;
  }

  if (errors > 0) checkAndAlertSaveErrors();
  if (!silent || repaired || adopted) {
    if (repaired) toast(`☁️ Sync check: re-uploaded ${repaired} note${repaired === 1 ? '' : 's'}/digest${repaired === 1 ? '' : 's'} missing from cloud.`);
    else if (adopted) toast(`☁️ Sync check: updated ${adopted} note${adopted === 1 ? '' : 's'} from another device.`);
    else if (!errors) toast('☁️ Sync check passed — cloud matches this device.');
  }
}

// ── Background sync: push any notes whose local write_ts > sync_ts (or never synced) to the cloud ──
// This is the "belt-and-suspenders" safeguard: even if an individual auto-save or
// manual save silently failed to reach Supabase, this sweep catches it on the next
// startup, tab-resume, or 3-minute tick and re-uploads from localStorage.
let _isSyncing = false;
export async function syncAllUnsyncedNotes({ silent = false } = {}) {
  if (_isSyncing) return;          // don't stack concurrent runs
  if (!navigator.onLine) return;   // pointless offline

  const allPdfs = S.pdfs || [];
  if (allPdfs.length === 0) return;

  // Collect every canonical pdfId where local write is newer than last confirmed cloud sync
  // OR where local notes/digest exist but sync_ts is 0 (never confirmed synced).
  const now = Date.now();
  const MIN_AGE_MS = 10_000;
  const seenIds = new Set();
  const toSync = [];
  for (const pdf of allPdfs) {
    const id = pdf.linked_pdf_id || pdf.id;
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    const wt = Math.max(getWriteTs(id), getWriteTs(pdf.id));
    const st = Math.max(getSyncTs(id), getSyncTs(pdf.id));
    const content = safeStorageGet('local_notepad_' + id, '') || safeStorageGet('local_notepad_' + pdf.id, '') || '';
    const digest  = safeStorageGet('local_digest_'  + id, '') || safeStorageGet('local_digest_'  + pdf.id, '') || '';

    if (!content && !digest) continue;

    const isUnsyncedEdit = wt > 0 && wt > st && (now - wt) >= MIN_AGE_MS;
    const isNeverSynced  = st === 0 && (wt === 0 || (now - wt) >= MIN_AGE_MS);

    if (isUnsyncedEdit || isNeverSynced) {
      toSync.push({ trueId: id, content, digest, wtAtStart: wt });
    }
  }

  if (toSync.length === 0) return;

  _isSyncing = true;

  // Show a subtle indicator in the sync-status bar
  const stxt = document.getElementById('stxt');
  const sdot = document.getElementById('sdot');
  if (!silent && stxt) stxt.textContent = `☁️ Syncing ${toSync.length} note${toSync.length === 1 ? '' : 's'} to cloud…`;
  if (!silent && sdot) { sdot.className = 'sdot spin'; sdot.style.background = 'var(--gold)'; }

  let successCount = 0;
  let failCount = 0;

  try {
    for (const { trueId, content, digest, wtAtStart } of toSync) {
      try {
        // Never let this device's copy silently overwrite what another device saved:
        // read the real cloud row first and resolve each field loss-free.
        let finalC = content;
        let finalD = digest;
        const existingCloud = await dbFetchCloudNotepadRaw(trueId);
        if (!existingCloud.ok) {
          failCount++;
          logNotepadDiagnostic(trueId, 'BGSYNC', 'ERR', 'ERR_BGSYNC_READ',
            `Background sync could not read the cloud row before uploading: ${existingCloud.error}. Will retry.`);
          continue;
        }
        if (existingCloud.exists) {
          const unsaved = wtAtStart > 0 && wtAtStart > getSyncTs(trueId);
          const cRes = _resolveFieldForForceSync(content, existingCloud.content, unsaved);
          const dRes = existingCloud.digestKnown === false
            ? { finalVal: digest, action: 'push' }
            : _resolveFieldForForceSync(digest, existingCloud.digest, unsaved);
          finalC = cRes.finalVal;
          finalD = dRes.finalVal;

          // The open editor is refreshed by openNotepad/realtime, not by this sweep.
          if (trueId === _activePdfId && [cRes.action, dRes.action].some(a => a === 'pull' || a === 'merge')) continue;

          // Cloud already holds the resolved value → just adopt it locally, nothing to upload.
          if (finalC === existingCloud.content && (existingCloud.digestKnown === false || finalD === existingCloud.digest)) {
            safeStorageSet('local_notepad_' + trueId, finalC);
            if (existingCloud.digestKnown !== false) safeStorageSet('local_digest_' + trueId, finalD);
            _setCloudBase(trueId, existingCloud.content, existingCloud.digestKnown === false ? undefined : existingCloud.digest);
            if (trueId !== _activePdfId) _notepadCache.delete(trueId);
            if (getWriteTs(trueId) <= wtAtStart) setSyncTs(trueId);
            successCount++;
            continue;
          }
        }

        const res = await dbSaveNotepad(trueId, finalC, finalD);
        if (res?.saved && !res?.localOnly) {
          // Read the row back from Supabase and confirm it really matches before
          // declaring this note synced. If it doesn't, leave sync_ts alone so the
          // next sweep retries.
          const check = await dbFetchCloudNotepadRaw(trueId);
          const digestOk = check.digestKnown === false || check.digest === finalD;
          if (check.ok && check.exists && check.content === finalC && digestOk) {
            _setCloudBase(trueId, finalC, check.digestKnown === false ? undefined : finalD);
            if (trueId !== _activePdfId) _notepadCache.delete(trueId);
            if (getWriteTs(trueId) <= wtAtStart) setSyncTs(trueId);
            successCount++;
          } else {
            failCount++;
            logNotepadDiagnostic(trueId, 'BGSYNC', 'ERR', 'ERR_VERIFY_MISMATCH',
              `Upload reported success but cloud read-back did not match (${check.ok ? (check.exists ? 'content differs' : 'row missing') : check.error}). Will retry.`,
              { check: { ok: check.ok, exists: check.exists } });
          }
        } else if (res?.localOnly || res?.queued) {
          // Not confirmed in cloud (FK error / queued in outbox) — don't stamp sync_ts
          failCount++;
        } else {
          failCount++;
          logNotepadDiagnostic(trueId, 'BGSYNC', 'ERR', res?.code || 'ERR_BGSYNC',
            `Background sync failed for ${trueId}: ${res?.error || 'unknown'}`, { res });
        }
      } catch (err) {
        failCount++;
        logNotepadDiagnostic(trueId, 'BGSYNC', 'ERR', err?.code || 'ERR_BGSYNC',
          `Background sync exception for ${trueId}: ${err?.message || String(err)}`, { error: String(err) });
      }
    }
  } finally {
    // ALWAYS reset the lock — even if something unexpected throws outside the inner try/catch
    _isSyncing = false;
  }

  // Restore the sync-status bar to normal after a short delay
  if (!silent && stxt) {
    if (failCount === 0) {
      stxt.textContent = `✓ ${successCount} note${successCount === 1 ? '' : 's'} synced to cloud`;
      if (sdot) { sdot.className = 'sdot ok'; sdot.style.background = ''; }
      setTimeout(() => {
        if (stxt && stxt.textContent.startsWith('✓')) {
          stxt.textContent = 'DB Sync Active';
          if (sdot) sdot.style.background = '';
        }
      }, 4000);
    } else {
      stxt.textContent = `⚠️ ${failCount} note${failCount === 1 ? '' : 's'} failed cloud sync — check Error Log`;
      if (sdot) { sdot.className = 'sdot'; sdot.style.background = '#ef4444'; }
      checkAndAlertSaveErrors();
    }
  } else if (failCount > 0) {
    checkAndAlertSaveErrors();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FORCE SYNC TO SUPABASE (Single PDF, Folder & Subtree, or Entire App)
// ═══════════════════════════════════════════════════════════════════════════
let _isForceSyncing = false;

function _setForceSyncUiState(active, statusText = '') {
  const stxt = document.getElementById('stxt');
  const sdot = document.getElementById('sdot');
  const btnBar = document.getElementById('btn-force-sync-all');
  const btnDiag = document.getElementById('diag-btn-force-sync');
  const btnSet = document.getElementById('settings-btn-force-sync');

  [btnBar, btnDiag, btnSet].forEach(b => {
    if (!b) return;
    b.disabled = active;
    b.style.opacity = active ? '0.65' : '';
    if (b === btnBar) {
      b.textContent = active ? '⏳ Syncing…' : '☁️ Force Sync';
    } else {
      b.textContent = active ? '⏳ Force Syncing with Supabase…' : '☁️ Force Sync Entire App Now';
    }
  });

  if (active) {
    if (stxt && statusText) stxt.textContent = statusText;
    if (sdot) { sdot.className = 'sdot spin'; sdot.style.background = 'var(--gold)'; }
  }
}

// Helper: Read best local content & digest for a PDF (DOM -> cache -> localStorage -> IDB snapshot)
async function _getBestLocalNotepadData(trueId, aliasId = null) {
  let localC = '';
  let localD = '';

  const cached = _notepadCache.get(trueId) || (aliasId ? _notepadCache.get(aliasId) : null);
  if (_domBoundPdfId === trueId && _activePdfId === trueId && cached?.dirty) {
    localC = $notesEditor()?.innerHTML ?? '';
    localD = $digestEditor()?.innerHTML ?? '';
  }
  const storedC = safeStorageGet('local_notepad_' + trueId, '') || (aliasId ? safeStorageGet('local_notepad_' + aliasId, '') : '') || '';
  const storedD = safeStorageGet('local_digest_'  + trueId, '') || (aliasId ? safeStorageGet('local_digest_'  + aliasId, '') : '') || '';

  if (!localC) localC = cached?.content || storedC || '';
  if (!localD) localD = cached?.digest  || storedD || '';

  // If local storage was cleared or quota-blocked, check IndexedDB snapshot history
  if (!localC && !localD) {
    try {
      let hist = await getNotepadHistoryIDB(trueId);
      if ((!Array.isArray(hist) || hist.length === 0) && aliasId) {
        hist = await getNotepadHistoryIDB(aliasId);
      }
      if (Array.isArray(hist) && hist.length > 0) {
        for (let i = hist.length - 1; i >= 0; i--) {
          const snap = hist[i];
          if (snap && (snap.content || snap.digest)) {
            localC = snap.content || '';
            localD = snap.digest || '';
            break;
          }
        }
      }
    } catch {}
  }

  return { localC, localD };
}

// Helper: Resolve local vs cloud field without EVER losing non-empty content on either side
function _resolveFieldForForceSync(localVal, cloudVal, hasLocalUnsaved) {
  const l = localVal || '';
  const c = cloudVal || '';
  if (l === c) return { finalVal: l, action: 'match' };
  if (l && !c) return { finalVal: l, action: 'push' };
  if (!l && c) return { finalVal: c, action: 'pull' };

  // Both l and c are non-empty and differ:
  if (hasLocalUnsaved) {
    return { finalVal: l, action: 'push' };
  }
  // If local contains all of cloud plus additions, push local
  if (l.includes(c) && l.length > c.length) {
    return { finalVal: l, action: 'push' };
  }
  // If cloud contains all of local plus additions from another device, pull cloud
  if (c.includes(l) && c.length > l.length) {
    return { finalVal: c, action: 'pull' };
  }
  // Truly divergent (neither contains the other) and this device has no unsaved edits:
  // the cloud copy came from another device. The old code blindly pushed local over it
  // (contradicting its own comment) which silently destroyed the other device's work.
  // Merge instead so NOTHING is lost; the merged result is then written to both sides.
  return { finalVal: mergeNoteHtml(l, c), action: 'merge' };
}

// Helper: Core batch sync for a set of PDFs and Folders
async function _executeForceSyncScope({ foldersToSync = [], pdfsToSync = [], scopeLabel = 'App', isFullApp = false }) {
  if (_isForceSyncing) {
    toast('⏳ Force Sync is already in progress…');
    return { ok: false, busy: true };
  }
  if (!navigator.onLine) {
    toast('⚠️ You are offline. Connect to the internet to Force Sync with Supabase.');
    return { ok: false, offline: true };
  }

  _isForceSyncing = true;
  _setForceSyncUiState(true, `☁️ Force syncing ${scopeLabel}…`);
  toast(`☁️ Force syncing ${scopeLabel} with Supabase…`);

  let uploadedNotes = 0;
  let pulledNotes = 0;
  let verifiedNotes = 0;
  let syncedFolders = 0;
  let syncedPdfs = 0;
  let failCount = 0;

  try {
    // 1. Flush active editors first ONLY IF they have unsaved user edits
    if (_activePdfId && _notepadCache.get(_activePdfId)?.dirty) {
      await flushNotepadSave(_activePdfId);
    }
    try {
      const { flushFolderDoc } = await import('./viewer.js');
      await flushFolderDoc();
    } catch {}

    // 2. Replay any queued offline outbox writes
    try {
      await replayOutbox(db);
    } catch (e) {
      console.warn('[ForceSync] Outbox replay warning:', e);
    }

    // 3. Collect all ancestor folders & subjects needed for foreign-key integrity
    const folderMap = new Map();
    const addFolderWithAncestors = (fold) => {
      let cur = fold;
      const chain = [];
      const seen = new Set();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        chain.unshift(cur);
        cur = cur.parent_folder_id ? S.folders?.find(f => f.id === cur.parent_folder_id) : null;
      }
      for (const f of chain) {
        if (!folderMap.has(f.id)) folderMap.set(f.id, f);
      }
    };

    for (const f of foldersToSync) addFolderWithAncestors(f);
    for (const p of pdfsToSync) {
      const parentFold = S.folders?.find(f => f.id === p.folder_id);
      if (parentFold) addFolderWithAncestors(parentFold);
      if (p.linked_pdf_id) {
        const masterPdf = S.pdfs?.find(mp => mp.id === p.linked_pdf_id);
        const masterFold = masterPdf ? S.folders?.find(f => f.id === masterPdf.folder_id) : null;
        if (masterFold) addFolderWithAncestors(masterFold);
      }
    }

    const orderedFolders = Array.from(folderMap.values());
    const subjectIds = new Set(orderedFolders.map(f => f.subject_id).filter(Boolean));
    if (isFullApp) {
      for (const s of (S.subjects || [])) subjectIds.add(s.id);
    }

    // Library rows are only CREATED here when missing (needed for foreign-key integrity of notes).
    // `ignoreDuplicates` means a stale device can never overwrite a name / folder notes / location
    // that another device changed. Failures are logged instead of silently ignored.
    const createOnly = { onConflict: 'id', ignoreDuplicates: true };
    const structErr = (what, id, err) => {
      failCount++;
      logNotepadDiagnostic(id, 'FORCESYNC', 'ERR', 'ERR_FORCESYNC_' + what,
        `Force Sync could not create missing ${what} "${id}" in Supabase: ${err?.message || String(err)} (${err?.code || 'no code'})`,
        { error: err });
    };

    // 4. Create missing Subjects  (subjects table columns: id, name, hex_color)
    for (const sid of subjectIds) {
      const subj = S.subjects?.find(s => s.id === sid);
      if (!subj) continue;
      const { error: sErr } = await db.from('subjects').upsert({
        id: subj.id,
        name: subj.name,
        hex_color: subj.hex_color || '#6366f1',
      }, createOnly);
      if (sErr) structErr('SUBJECT', subj.id, sErr);
    }

    // 5. Create missing Folders (root-to-leaf) & sync Folder Notes
    for (const fold of orderedFolders) {
      const localFoldNotes = safeStorageGet('local_folder_notes_' + fold.id, '') || '';
      const bestNotes = fold.notes || localFoldNotes || '';
      if (bestNotes && !fold.notes) fold.notes = bestNotes;
      if (bestNotes) safeStorageSet('local_folder_notes_' + fold.id, bestNotes);

      const foldPayload = {
        id: fold.id,
        subject_id: fold.subject_id,
        name: fold.name,
        parent_folder_id: fold.parent_folder_id || null,
        sort_order: fold.sort_order ?? 0,
        notes: bestNotes,
      };
      let { error: foldErr } = await db.from('folders').upsert(foldPayload, createOnly);
      if (foldErr && foldPayload.notes !== undefined) {
        delete foldPayload.notes;
        ({ error: foldErr } = await db.from('folders').upsert(foldPayload, createOnly));
      }
      if (foldErr) structErr('FOLDER', fold.id, foldErr);
      else syncedFolders++;
    }

    // 6. Create missing PDF records (master PDFs first, then shortcuts)
    const pdfMap = new Map();
    for (const p of pdfsToSync) {
      if (p.linked_pdf_id) {
        const master = S.pdfs?.find(mp => mp.id === p.linked_pdf_id);
        if (master && !pdfMap.has(master.id)) pdfMap.set(master.id, master);
      }
      if (!pdfMap.has(p.id)) pdfMap.set(p.id, p);
    }

    for (const pdf of pdfMap.values()) {
      const pdfPayload = {
        id: pdf.id,
        folder_id: pdf.folder_id,
        name: pdf.name,
        drive_file_id: pdf.drive_file_id || '',
        linked_pdf_id: pdf.linked_pdf_id || null,
        storage_path: pdf.storage_path || '',
        sort_order: pdf.sort_order ?? 0,
      };
      const { error: pErr } = await db.from('pdf_files').upsert(pdfPayload, createOnly);
      if (pErr) structErr('PDF', pdf.id, pErr);
      else syncedPdfs++;
    }

    // 7. Batch-fetch existing cloud pdf_notes for all canonical PDF IDs in scope
    const canonicalMap = new Map(); // trueId -> pdf
    for (const p of pdfsToSync) {
      const trueId = p.linked_pdf_id || p.id;
      if (trueId && !canonicalMap.has(trueId)) canonicalMap.set(trueId, p);
    }
    const canonicalIds = Array.from(canonicalMap.keys());

    const cloudNotesMap = new Map(); // trueId -> { exists, content, digest }
    const CHUNK = 80;
    for (let i = 0; i < canonicalIds.length; i += CHUNK) {
      const slice = canonicalIds.slice(i, i + CHUNK);
      const { data, error } = await db.from('pdf_notes').select('pdf_id, content, digest').in('pdf_id', slice);
      if (!error && Array.isArray(data)) {
        for (const row of data) {
          cloudNotesMap.set(row.pdf_id, {
            exists: true,
            content: row.content || '',
            digest: row.digest || '',
          });
        }
      } else {
        // Fallback per-PDF if batch select failed
        for (const tid of slice) {
          const raw = await dbFetchCloudNotepadRaw(tid);
          if (raw.ok && raw.exists) {
            cloudNotesMap.set(tid, {
              exists: true,
              content: raw.content || '',
              digest: raw.digest || '',
            });
          }
        }
      }
    }

    // 8. Sync Notes & Case Digests for every canonical PDF in scope
    let idx = 0;
    for (const [trueId, pdfObj] of canonicalMap.entries()) {
      idx++;
      if (canonicalIds.length > 3 && idx % 3 === 0) {
        _setForceSyncUiState(true, `☁️ Syncing PDF ${idx}/${canonicalIds.length}…`);
      }

      try {
        const { localC, localD } = await _getBestLocalNotepadData(trueId, pdfObj.id);
        const cloudRow = cloudNotesMap.get(trueId) || { exists: false, content: '', digest: '' };

        // Skip completely empty PDFs that have no local or cloud notes/digest
        if (!localC && !localD && !cloudRow.exists) {
          continue;
        }

        const wt = Math.max(getWriteTs(trueId), getWriteTs(pdfObj.id));
        const st = Math.max(getSyncTs(trueId), getSyncTs(pdfObj.id));
        const hasLocalUnsaved = (wt > 0 && wt > st) || st === 0 || (_activePdfId === trueId);

        const cRes = _resolveFieldForForceSync(localC, cloudRow.content, hasLocalUnsaved);
        const dRes = _resolveFieldForForceSync(localD, cloudRow.digest, hasLocalUnsaved);

        const finalC = cRes.finalVal;
        const finalD = dRes.finalVal;

        const needsUpload = !cloudRow.exists || finalC !== cloudRow.content || finalD !== cloudRow.digest || cRes.action === 'push' || dRes.action === 'push';
        const needsPull   = finalC !== localC || finalD !== localD || cRes.action === 'pull' || dRes.action === 'pull';

        // Always keep local storage & cache updated with the combined best content + digest
        safeStorageSet('local_notepad_' + trueId, finalC);
        safeStorageSet('local_digest_'  + trueId, finalD);
        if (pdfObj.id !== trueId) {
          safeStorageSet('local_notepad_' + pdfObj.id, finalC);
          safeStorageSet('local_digest_'  + pdfObj.id, finalD);
        }
        _notepadCache.set(trueId, {
          content: finalC,
          digest: finalD,
          dirty: false,
          timestamp: Date.now(),
        });

        // If this PDF is currently open in the Notepad panel, refresh its live DOM editors too
        if (_activePdfId === trueId) {
          if ($notesEditor() && $notesEditor().innerHTML !== finalC) $notesEditor().innerHTML = finalC;
          if ($digestEditor() && $digestEditor().innerHTML !== finalD) $digestEditor().innerHTML = finalD;
          _domBoundPdfId = trueId;
        }

        if (needsUpload && (finalC || finalD || cloudRow.exists)) {
          const saveRes = await dbSaveNotepad(trueId, finalC, finalD);
          if (saveRes?.saved && !saveRes?.localOnly) {
            const verify = await dbFetchCloudNotepadRaw(trueId);
            const digestOk = verify.digestKnown === false || verify.digest === finalD;
            if (verify.ok && verify.exists && verify.content === finalC && digestOk) {
              _setCloudBase(trueId, finalC, verify.digestKnown === false ? undefined : finalD);
              setSyncTs(trueId);
              if (pdfObj.id !== trueId) setSyncTs(pdfObj.id);
              uploadedNotes++;
              verifiedNotes++;
              if (_activePdfId === trueId) updateSaveStatusLabel(trueId, { saved: true, code: '200_OK' });
            } else {
              failCount++;
              logNotepadDiagnostic(trueId, 'FORCESYNC', 'ERR', 'ERR_FORCESYNC_VERIFY',
                `Force Sync read-back mismatch for "${pdfObj.name}" (${trueId}).`,
                { verify });
            }
          } else {
            failCount++;
            logNotepadDiagnostic(trueId, 'FORCESYNC', 'ERR', saveRes?.code || 'ERR_FORCESYNC_SAVE',
              `Force Sync failed to save "${pdfObj.name}" (${trueId}): ${saveRes?.error || 'unknown'}`);
          }
        } else {
          if (needsPull) pulledNotes++;
          _setCloudBase(trueId, cloudRow.content, cloudRow.digest);
          setSyncTs(trueId);
          if (pdfObj.id !== trueId) setSyncTs(pdfObj.id);
          verifiedNotes++;
        }
      } catch (pdfErr) {
        failCount++;
        logNotepadDiagnostic(trueId, 'FORCESYNC', 'ERR', 'ERR_FORCESYNC_EX',
          `Force Sync error on "${pdfObj?.name || trueId}": ${pdfErr?.message || String(pdfErr)}`);
      }
    }

    // 9. If full app sync (or active PDF in scope), refresh library & active PDF annotations from cloud
    if (isFullApp) {
      await dbLoad();
      await dbLoadAnnCounts();
      // Pull any newly discovered folders' notes into local cache
      for (const f of (S.folders || [])) {
        if (f.notes) safeStorageSet('local_folder_notes_' + f.id, f.notes);
      }
      try {
        const { renderLibrary } = await import('./library.js');
        renderLibrary();
      } catch {}
    }

    const activeTrueId = S.curPDF ? (S.curPDF.linked_pdf_id || S.curPDF.id) : null;
    if (activeTrueId && canonicalMap.has(activeTrueId)) {
      await Promise.all([
        dbLoadAnnotations(activeTrueId),
        dbLoadDrawings(activeTrueId),
        dbLoadBookmarks(activeTrueId),
      ]);
      try {
        const { renderAllAnnotations, renderAllDrawings } = await import('./viewer.js');
        const { updateAnnotBadge } = await import('./annotations.js');
        renderAllAnnotations();
        renderAllDrawings();
        updateAnnotBadge();
      } catch {}
    }

    // 10. Report status in UI
    const stxt = document.getElementById('stxt');
    const sdot = document.getElementById('sdot');
    if (failCount === 0) {
      if (stxt) stxt.textContent = `✓ Force Sync OK (${uploadedNotes} pushed, ${pulledNotes} pulled, ${verifiedNotes} verified)`;
      if (sdot) { sdot.className = 'sdot ok'; sdot.style.background = ''; }
      setTimeout(() => {
        if (stxt && stxt.textContent.startsWith('✓')) {
          stxt.textContent = 'DB Sync Active';
        }
      }, 5000);
      toast(`✅ Force Sync complete for ${scopeLabel}! (${uploadedNotes} uploaded, ${pulledNotes} pulled from cloud, ${verifiedNotes} notes/digests verified)`);
    } else {
      if (stxt) stxt.textContent = `⚠️ Force Sync: ${failCount} failed (${uploadedNotes} synced)`;
      if (sdot) { sdot.className = 'sdot'; sdot.style.background = '#ef4444'; }
      checkAndAlertSaveErrors();
      toast(`⚠️ Force Sync finished with ${failCount} error${failCount === 1 ? '' : 's'} (${uploadedNotes} uploaded, ${verifiedNotes} verified). Check Error Log.`);
    }

    // 11. Also ensure Google Drive folder structure mirrors the library
    if (S.driveToken) {
      import('./drive.js').then(async (m) => {
        if (isFullApp) {
          await m.driveOrganizeAll({ silent: true });
        } else {
          for (const p of pdfsToSync) {
            await m.driveSyncPdfLocation(p);
          }
        }
      }).catch(() => {});
    }

    return { ok: failCount === 0, uploadedNotes, pulledNotes, verifiedNotes, syncedFolders, syncedPdfs, failCount };
  } catch (err) {
    console.error('[ForceSync] Fatal error:', err);
    toast(`❌ Force Sync error: ${err?.message || String(err)}`);
    return { ok: false, error: err?.message || String(err) };
  } finally {
    _isForceSyncing = false;
    _setForceSyncUiState(false);
  }
}

// ── Public 1: Force Sync a single PDF (from right-click context menu or notepad) ──
export async function forceSyncPdf(pdfOrId) {
  const pdfObj = typeof pdfOrId === 'string'
    ? S.pdfs?.find(p => p.id === pdfOrId || p.linked_pdf_id === pdfOrId)
    : pdfOrId;
  if (!pdfObj) {
    toast('⚠️ Could not find PDF to sync.');
    return;
  }
  const fold = S.folders?.find(f => f.id === pdfObj.folder_id);
  return _executeForceSyncScope({
    foldersToSync: fold ? [fold] : [],
    pdfsToSync: [pdfObj],
    scopeLabel: `"${pdfObj.name}"`,
    isFullApp: false,
  });
}

// ── Public 2: Force Sync one or more Folders + all their descendant subfolders & PDFs ──
export async function forceSyncFolders(foldersOrIds) {
  const rawList = Array.isArray(foldersOrIds) ? foldersOrIds : [foldersOrIds];
  const rootFolders = rawList
    .map(item => (typeof item === 'string' ? S.folders?.find(f => f.id === item) : item))
    .filter(Boolean);

  if (rootFolders.length === 0) {
    toast('⚠️ No folder selected to sync.');
    return;
  }

  // Recursively collect all descendant folders in root-to-leaf order
  const collectedIds = new Set();
  const collectedFolders = [];
  function collectSubtree(fold) {
    if (!fold || collectedIds.has(fold.id)) return;
    collectedIds.add(fold.id);
    collectedFolders.push(fold);
    const children = (S.folders || []).filter(f => f.parent_folder_id === fold.id);
    for (const child of children) collectSubtree(child);
  }
  for (const rf of rootFolders) collectSubtree(rf);

  // Collect all PDFs inside any of these folders
  const pdfsInScope = (S.pdfs || []).filter(p => collectedIds.has(p.folder_id));

  const label = rootFolders.length === 1
    ? `folder "${rootFolders[0].name}" (${pdfsInScope.length} PDF${pdfsInScope.length === 1 ? '' : 's'})`
    : `${rootFolders.length} folders (${pdfsInScope.length} PDF${pdfsInScope.length === 1 ? '' : 's'})`;

  return _executeForceSyncScope({
    foldersToSync: collectedFolders,
    pdfsToSync: pdfsInScope,
    scopeLabel: label,
    isFullApp: false,
  });
}

// ── Public 3: Force Sync the ENTIRE app (all subjects, folders, PDFs, notes & digests) ──
export async function forceSyncAll() {
  return _executeForceSyncScope({
    foldersToSync: S.folders || [],
    pdfsToSync: S.pdfs || [],
    scopeLabel: `Entire App (${(S.pdfs || []).length} PDFs)`,
    isFullApp: true,
  });
}

if (typeof window !== 'undefined') {
  window.forceSyncAll = forceSyncAll;
  window.forceSyncFolders = forceSyncFolders;
  window.forceSyncPdf = forceSyncPdf;
}

// ── Manual save: force an immediate cloud save regardless of dirty state ──
// Called by the "Save Now" button and Ctrl+S shortcut.
async function _manualSave() {
  const pdfId = _activePdfId;
  if (!pdfId) {
    toast('Open a PDF notepad first before saving.');
    return;
  }

  const btn = document.getElementById('np-save-now-btn');
  const lbl = $saveLbl();

  // Visual feedback: show saving state on button
  if (btn) {
    btn.textContent = '⏳ Saving…';
    btn.disabled = true;
    btn.style.opacity = '0.7';
  }
  if (lbl) {
    lbl.textContent = 'Saving…';
    lbl.className = 'saving';
    lbl.title = 'Manual save in progress…';
  }

  try {
    // Cancel any pending auto-save timer so we don't double-save
    if (_saveTimer) {
      clearTimeout(_saveTimer);
      _saveTimer = null;
      _timerPdfId = null;
    }

    // Read best available content from DOM + cache + localStorage
    const { content, digest } = _readEditorContent(pdfId);

    // Update cache and localStorage first (synchronous, always safe)
    _notepadCache.set(pdfId, { content, digest, dirty: false, timestamp: Date.now() });
    safeStorageSet('local_notepad_' + pdfId, content);
    safeStorageSet('local_digest_'  + pdfId, digest);
    setWriteTs(pdfId);
    updateLocalSaveLabel('saved'); // ✅ local save always succeeds

    // Snapshot before cloud save
    await saveHistorySnapshot(pdfId, content, digest);

    // Force cloud save
    const res = await dbSaveNotepad(pdfId, content, digest);

    // Read the row back from Supabase to PROVE the cloud has it (not just "no error returned")
    let verified = false;
    let verifyMsg = '';
    if (res?.saved && !res?.localOnly) {
      const check = await dbFetchCloudNotepadRaw(pdfId);
      verified = !!(check.ok && check.exists && check.content === content &&
                    (check.digestKnown === false || check.digest === digest));
      if (!verified) {
        verifyMsg = check.ok ? (check.exists ? 'cloud content differs' : 'row missing in cloud') : check.error;
        logNotepadDiagnostic(pdfId, 'SAVE', 'ERR', 'ERR_VERIFY_MISMATCH',
          `Manual save reported success but read-back did not match (${verifyMsg}).`);
      }
    }
    if (verified) setSyncTs(pdfId);

    // Show result in label
    updateSaveStatusLabel(pdfId, res);
    if (res?.saved && !res?.localOnly && !verified) {
      const l = $saveLbl();
      if (l) { l.textContent = '☁️ ⚠️ Unverified'; l.className = 'err'; l.title = `Cloud read-back failed: ${verifyMsg}. Will retry automatically.`; }
    }

    // Button feedback
    if (btn) {
      if (verified) {
        btn.textContent = '✓ Verified in cloud';
        btn.style.background = '#14532d';
      } else if (res?.saved && !res?.localOnly) {
        btn.textContent = '⚠️ Not verified';
        btn.style.background = '#78350f';
        toast('⚠️ Saved, but the cloud copy could not be verified. It will retry automatically — check the Error Log if this repeats.');
      } else if (res?.localOnly) {
        btn.textContent = '💾 Local only';
        btn.style.background = '#78350f';
      } else if (res?.queued) {
        btn.textContent = '⏳ Queued';
        btn.style.background = '#78350f';
      } else {
        btn.textContent = '✗ Failed';
        btn.style.background = '#7f1d1d';
        // Show error banner if the save actually failed
        if (res?.error && !res?.localOnly) checkAndAlertSaveErrors();
      }
    }
  } catch (err) {
    console.error('[Manual Save] Error:', err);
    logNotepadDiagnostic(pdfId, 'SAVE', 'ERR', err?.code || 'ERR_MANUAL_SAVE',
      `Manual save exception: ${err?.message || String(err)}`, { error: String(err) });
    checkAndAlertSaveErrors();
    if (btn) {
      btn.textContent = '✗ Failed';
      btn.style.background = '#7f1d1d';
    }
    if (lbl) {
      lbl.textContent = `✗ Err`;
      lbl.className = 'err';
      lbl.title = `Manual save failed: ${err?.message || err}`;
    }
  } finally {
    // Reset button after 2.5s
    setTimeout(() => {
      if (btn) {
        btn.textContent = '💾 Save Now';
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.background = '#1e6b3a';
      }
    }, 2500);
  }
}

export function initNotepad() {
  document.getElementById('btn-notepad')?.addEventListener('click', () => {
    const panel = $panel();
    if (panel.classList.contains('open')) {
      closeNotepad();
    } else {
      if (S.curPDF) {
        const trueId = S.curPDF.linked_pdf_id || S.curPDF.id;
        openNotepad(trueId);
      } else {
        if ($notesEditor()) $notesEditor().innerHTML = '';
        if ($digestEditor()) $digestEditor().innerHTML = '';
        panel.classList.add('open');
      }
    }
  });

  document.getElementById('np-close')?.addEventListener('click', closeNotepad);

  // Clicking save status indicator opens the Error & Sync Log tab directly
  const saveLbl = document.getElementById('np-save-lbl');
  if (saveLbl) {
    saveLbl.style.cursor = 'pointer';
    saveLbl.addEventListener('click', () => {
      openHistoryPanel('logs');
    });
  }

  // History button — opens the history/recovery panel
  document.getElementById('np-history-btn')?.addEventListener('click', () => {
    openHistoryPanel('snapshots');
  });

  // ── Manual Save Now button ──
  document.getElementById('np-save-now-btn')?.addEventListener('click', async () => {
    await _manualSave();
  });

  // Ctrl+S / Cmd+S keyboard shortcut when notepad is open
  document.addEventListener('keydown', async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's' && $panel()?.classList.contains('open')) {
      e.preventDefault();
      await _manualSave();
    }
  });
  document.getElementById('np-history-close')?.addEventListener('click', () => {
    document.getElementById('np-history-modal')?.classList.remove('open');
  });
  // Close history modal on backdrop click
  document.getElementById('np-history-modal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('np-history-modal')) {
      document.getElementById('np-history-modal').classList.remove('open');
    }
  });

  // Tab switching (Notes vs Digest)
  document.querySelectorAll('#np-tabs .ap-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      switchNotepadTab(btn.dataset.nptab);
    });
  });

  // Bind formatting toolbar commands for PDF Notepad
  const npToolbar = document.getElementById('np-toolbar');
  if (npToolbar) {
    npToolbar.addEventListener('mousedown', e => e.preventDefault());
    npToolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('.np-fmt-btn');
      if (!btn) return;
      
      e.stopPropagation();
      const activeEd = $currentEditor();

      if (btn.id === 'np-copy-summary-table') {
        const fallbackEd = activeEd === $digestEditor() ? $notesEditor() : $digestEditor();
        copyFirstSummaryTable(activeEd, fallbackEd);
        return;
      }
      if (btn.id === 'np-link-pdf') {
        openPdfLinkModal(activeEd, () => {
          activeEd?.dispatchEvent(new Event('input'));
          if (_activePdfId) scheduleSaveForPdf(_activePdfId);
        });
        return;
      }
      if (btn.id === 'np-link-url') {
        insertWebLink(activeEd, () => {
          activeEd?.dispatchEvent(new Event('input'));
          if (_activePdfId) scheduleSaveForPdf(_activePdfId);
        });
        return;
      }
      if (btn.id === 'np-highlight-btn') {
        buildHighlightDropdown(btn, activeEd);
        return;
      }

      const cmd = btn.dataset.cmd;
      let val = btn.dataset.val || null;
      
      if (cmd === 'formatBlock' && val && !val.startsWith('<')) {
        val = `<${val}>`;
      }
      
      try {
        if (cmd === 'insertTable') {
          showTablePicker(btn, activeEd);
        } else if (cmd === 'insertBanner') {
          insertBannerHeader(activeEd);
        } else if (cmd === 'grayOut') {
          toggleGrayOut(activeEd);
        } else if (cmd === 'outdent') {
          outdentLine(activeEd);
        } else if (cmd === 'indent') {
          indentLine(activeEd);
        } else if (cmd) {
          document.execCommand(cmd, false, val);
        }
      } catch (err) {
        console.error('execCommand failed:', err);
      } finally {
        activeEd?.focus();
        if (_activePdfId) {
          const content = $notesEditor()?.innerHTML ?? '';
          const digest = $digestEditor()?.innerHTML ?? '';
          _notepadCache.set(_activePdfId, { content, digest, dirty: true, hadUserInput: true, timestamp: Date.now() });
          setWriteTs(_activePdfId);
          safeStorageSet('local_notepad_' + _activePdfId, content);
          safeStorageSet('local_digest_' + _activePdfId, digest);
          scheduleSaveForPdf(_activePdfId);
        }
      }
    });
  }

  // Setup input, keydown, paste, cut, drop, and blur for both editors
  const captureEditorChange = () => {
    if (_activePdfId && _domBoundPdfId === _activePdfId) {
      const content = $notesEditor()?.innerHTML ?? '';
      const digest = $digestEditor()?.innerHTML ?? '';
      const existing = _notepadCache.get(_activePdfId);
      if (!existing || existing.content !== content || existing.digest !== digest) {
        _notepadCache.set(_activePdfId, { content, digest, dirty: true, hadUserInput: true, timestamp: Date.now() });
        setWriteTs(_activePdfId); // record that this device has local unsaved changes
        safeStorageSet('local_notepad_' + _activePdfId, content);
        safeStorageSet('local_digest_' + _activePdfId, digest);
        updateLocalSaveLabel('saved');
        scheduleSaveForPdf(_activePdfId);
      }
    }
  };

  [$notesEditor(), $digestEditor()].forEach(ed => {
    if (!ed) return;
    ed.addEventListener('keydown', e => {
      handleEditorKeyDown(e, ed);
    });

    ed.addEventListener('input', captureEditorChange);
    ed.addEventListener('cut', () => setTimeout(captureEditorChange, 0));
    ed.addEventListener('drop', () => setTimeout(captureEditorChange, 0));
    ed.addEventListener('blur', () => {
      captureEditorChange();
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
  });

  // Close on Esc
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $panel()?.classList.contains('open')) {
      closeNotepad();
    }
  });

  // ── Bug A fix: flush notes when tab is closed, hidden, or app is backgrounded ──
  // visibilitychange fires reliably on iOS/iPad when switching apps
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && _activePdfId) {
      // Synchronous localStorage write is already done by the input handler.
      // Fire the async Supabase save — the browser gives us a few seconds of grace.
      flushNotepadSave();
    } else if (document.visibilityState === 'visible') {
      // User just returned to the app (e.g. opened laptop, switched back from another app).
      // 1. Show any unacknowledged save-error banner.
      checkAndAlertSaveErrors();
      // 2. Run the background sync sweep: any PDF whose local write > sync_ts gets pushed.
      //    Small delay so the app finishes re-rendering before hitting the network.
      setTimeout(async () => {
        await syncAllUnsyncedNotes();
        await verifyRandomNotesAgainstCloud({ sampleSize: 5 });
      }, 1500);
    }
  });

  // ── Startup checks ──
  // Show error banner quickly (1.5s) — doesn't depend on S.pdfs being loaded.
  setTimeout(checkAndAlertSaveErrors, 1500);
  // Background sync sweep (15s) — must wait for S.pdfs to fully load from DB.
  setTimeout(() => syncAllUnsyncedNotes(), 15_000);
  // Random cloud spot-check (25s) — runs after the sweep has had a chance to finish.
  setTimeout(() => verifyRandomNotesAgainstCloud({ sampleSize: 5 }), 25_000);

  // ── Periodic background sync every 3 minutes ──
  // Keeps cloud in sync even if individual auto-saves are spotty.
  setInterval(() => { syncAllUnsyncedNotes({ silent: true }); }, 3 * 60 * 1000);
  // ── Periodic random spot-check every 5 minutes (3 random notes vs. the real cloud row) ──
  setInterval(() => { verifyRandomNotesAgainstCloud({ sampleSize: 3 }); }, 5 * 60 * 1000);

  // beforeunload is the last-resort on desktop tab close / navigation
  window.addEventListener('beforeunload', () => {
    if (_activePdfId) {
      // Ensure localStorage has the latest (sync operation, always succeeds)
      try {
        const content = $notesEditor()?.innerHTML ?? '';
        const digest  = $digestEditor()?.innerHTML ?? '';
        if (content || digest) {
          safeStorageSet('local_notepad_' + _activePdfId, content);
          safeStorageSet('local_digest_'  + _activePdfId, digest);
          setWriteTs(_activePdfId);
          saveHistorySnapshot(_activePdfId, content, digest);
        }
      } catch {}
      // Fire the async Supabase write — browser may or may not let it complete
      flushNotepadSave();
    }
  });

  initNotepadResizer();
}

function initNotepadResizer() {
  const panel = $panel();
  const handle = document.getElementById('np-resize-handle');
  if (!handle || !panel) return;

  // Restore saved width from localStorage
  const savedWidth = safeStorageGet('notepad_width');
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
    panel.style.transition = 'none';
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  });

  handle.addEventListener('pointermove', (e) => {
    if (!isResizing) return;
    const deltaX = startX - e.clientX;
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
    safeStorageSet('notepad_width', panel.offsetWidth);
  };

  handle.addEventListener('pointerup', stopResize);
  handle.addEventListener('pointercancel', stopResize);
}

// NOTE: beforeunload, pagehide, and visibilitychange listeners are registered
// inside initNotepad() — do NOT duplicate them here at module level.
