// ═════════════════════════════════════════════════════════════════════════════
// LEGAL PRINT STUDIO — Modular Standalone Notes, Case Digests, Folder Docs &
// Summary Tables Print Preview & Customization Studio
// ═════════════════════════════════════════════════════════════════════════════
import { S } from './state.js';
import { safeStorageGet, safeStorageSet, safeStorageRemove } from './storage.js';
import { toast } from './ui.js';
import {
  fetchPdfNotesAndDigest,
  fetchFolderNotes,
  fetchFirstAnnotationTable,
  buildPdfCaseHTML,
  buildFolderHTML,
  flushPendingNotesForExport,
  buildPrintDocumentHTML,
  hasMeaningfulContent,
  stripEmojis,
  escapeHtml,
  getCleanPdfTitle,
  getFolderPathString,
} from './export.js';

const PREFS_STORAGE_KEY = 'la_print_studio_prefs_v2';
const DEFAULT_PRESET_STORAGE_KEY = 'la_print_studio_default_v2';
const JOB_STORAGE_PREFIX = 'la_print_job_';
const PRINT_CHANNEL_NAME = 'la_print_studio';
const REALTIME_CHANNEL_NAME = 'legal_annotator_realtime';

const DEFAULT_PREFS = {
  includeDigest: true,
  includeNotes: true,
  includeFolderDocs: true,
  tablesOnly: false,
  includeToc: false,
  columns: 1,
  layout: 'tight',
  paperSize: 'a4',
  orientation: 'portrait',
  marginPreset: 'narrow',
  runningHeaders: true,
  previewZoom: 1,
};

let _studioController = null;
let _printChannel = null;

function getPrintChannel() {
  if (!_printChannel && typeof BroadcastChannel !== 'undefined') {
    try {
      _printChannel = new BroadcastChannel(PRINT_CHANNEL_NAME);
    } catch {}
  }
  return _printChannel;
}

function normalizePrefs(parsed, base = DEFAULT_PREFS) {
  if (!parsed || typeof parsed !== 'object') return { ...base };
  return {
    ...base,
    ...parsed,
    columns: parsed.columns !== undefined ? (Number(parsed.columns) === 2 ? 2 : 1) : base.columns,
    layout: ['tight', 'compact', 'standard'].includes(parsed?.layout) ? parsed.layout : base.layout,
    paperSize: ['letter', 'a4', 'legal'].includes(parsed?.paperSize) ? parsed.paperSize : base.paperSize,
    orientation: ['portrait', 'landscape'].includes(parsed?.orientation) ? parsed.orientation : base.orientation,
    marginPreset: ['normal', 'narrow', 'wide'].includes(parsed?.marginPreset) ? parsed.marginPreset : base.marginPreset,
    previewZoom: [0.75, 1, 1.25].includes(Number(parsed?.previewZoom)) ? Number(parsed.previewZoom) : base.previewZoom,
  };
}

function loadDefaultPreset() {
  try {
    const raw = safeStorageGet(DEFAULT_PRESET_STORAGE_KEY, null);
    if (!raw) return { ...DEFAULT_PREFS };
    return normalizePrefs(JSON.parse(raw), DEFAULT_PREFS);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function loadSavedPrefs() {
  const base = loadDefaultPreset();
  try {
    const raw = safeStorageGet(PREFS_STORAGE_KEY, null);
    if (!raw) return { ...base };
    return normalizePrefs(JSON.parse(raw), base);
  } catch {
    return { ...base };
  }
}

function savePrefs(prefs) {
  try {
    safeStorageSet(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {}
}

function pruneOldLocalJobs(keepCount = 3) {
  if (typeof localStorage === 'undefined') return;
  try {
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(JOB_STORAGE_PREFIX)) {
        let createdAt = 0;
        try {
          const parsed = JSON.parse(localStorage.getItem(k) || '{}');
          createdAt = Number(parsed?.createdAt || 0);
        } catch {}
        entries.push({ key: k, createdAt });
      }
    }
    if (entries.length > keepCount) {
      entries.sort((a, b) => b.createdAt - a.createdAt);
      for (const old of entries.slice(keepCount)) {
        safeStorageRemove(old.key);
      }
    }
  } catch {}
}

function saveLocalJob(jobId, payload) {
  if (!jobId) return;
  pruneOldLocalJobs(3);
  safeStorageSet(JOB_STORAGE_PREFIX + jobId, JSON.stringify(payload));
}

function loadLocalJob(jobId) {
  if (!jobId) return null;
  const keys = [JOB_STORAGE_PREFIX + jobId, 'print_job_' + jobId];
  for (const key of keys) {
    try {
      const raw = safeStorageGet(key, null);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch {}
  }
  return null;
}

async function loadPrintJobPayload(jobId) {
  if (!jobId) return null;
  if (typeof window !== 'undefined' && window.__DESKTOP_PRINT_STUDIO__?.loadJob) {
    try {
      const deskJob = await window.__DESKTOP_PRINT_STUDIO__.loadJob(jobId);
      if (deskJob && typeof deskJob === 'object') return deskJob;
    } catch (err) {
      console.warn('[PrintStudio] desktop loadJob failed:', err);
    }
  }
  return loadLocalJob(jobId);
}

function applyLibrarySnapshot(snap) {
  if (!snap || typeof snap !== 'object') return false;
  let applied = false;
  if (Array.isArray(snap.subjects) && snap.subjects.length) {
    S.subjects = snap.subjects;
    applied = true;
  }
  if (Array.isArray(snap.folders) && snap.folders.length) {
    S.folders = snap.folders;
    applied = true;
  }
  if (Array.isArray(snap.pdfs) && snap.pdfs.length) {
    S.pdfs = snap.pdfs;
    applied = true;
  }
  return applied;
}

async function hydrateLibraryState(job, requestedIds = {}) {
  let hydrated = applyLibrarySnapshot(job?.librarySnapshot);

  if (!S.subjects?.length && !S.folders?.length && !S.pdfs?.length) {
    try {
      const snapStr = safeStorageGet('local_lib_snapshot', null);
      if (snapStr) {
        hydrated = applyLibrarySnapshot(JSON.parse(snapStr)) || hydrated;
      }
    } catch {}
  }

  if ((!S.folders?.length && !S.pdfs?.length) && typeof window !== 'undefined' && window.__DESKTOP_SQLITE__?.loadLibrary) {
    try {
      const sqLib = await window.__DESKTOP_SQLITE__.loadLibrary();
      hydrated = applyLibrarySnapshot(sqLib) || hydrated;
    } catch {}
  }

  const missingRequestedDoc = requestedIds.docId && !S.pdfs?.some(p => p.id === requestedIds.docId);
  const missingRequestedFolder = requestedIds.folderId && !S.folders?.some(f => f.id === requestedIds.folderId);
  const needsSyncDb = (!S.folders?.length && !S.pdfs?.length) || missingRequestedDoc || missingRequestedFolder;

  const tryRemoteLoad = async () => {
    try {
      const dbMod = await import('./db.js');
      if (typeof dbMod.initAuth === 'function') {
        await dbMod.initAuth().catch(() => {});
      }
      if (typeof dbMod.dbLoadLibrary === 'function') {
        await dbMod.dbLoadLibrary();
      } else if (typeof dbMod.dbLoad === 'function') {
        await dbMod.dbLoad(1);
      }
      return true;
    } catch (err) {
      console.warn('[PrintStudio] Cloud library load skipped/failed:', err);
      return false;
    }
  };

  if (needsSyncDb) {
    await tryRemoteLoad();
  } else if (typeof navigator === 'undefined' || navigator.onLine !== false) {
    // Non-blocking background refresh if online so standalone window stays up-to-date
    tryRemoteLoad().then((ok) => {
      if (ok && _studioController) {
        _studioController.syncLiveFolderNotesFromLocal();
        _studioController.renderTree();
      }
    }).catch(() => {});
  }

  return hydrated;
}

function getAllDescendantFolderIds(rootFolderId) {
  const result = [];
  const queue = [rootFolderId];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    for (const f of S.folders) {
      if (f.parent_folder_id === id && !seen.has(f.id)) {
        queue.push(f.id);
      }
    }
  }
  return result;
}

function getAncestorFolderIds(folderId) {
  const result = [];
  let cur = folderId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    result.push(cur);
    const f = S.folders.find(x => x.id === cur);
    cur = f ? f.parent_folder_id : null;
  }
  return result;
}

function getFolderDisplayTitle(folder) {
  return stripEmojis(folder?.name) || 'Untitled Folder';
}

function buildQueueFromJobOrMode(job, modeInfo = {}) {
  const queueItems = [];
  const seenFolders = new Set();
  const seenPdfs = new Set();

  const rawFolderIds = Array.isArray(job?.folderIds) && job.folderIds.length
    ? job.folderIds
    : (modeInfo.folderId ? [modeInfo.folderId] : []);

  const rawPdfIds = Array.isArray(job?.pdfIds) && job.pdfIds.length
    ? job.pdfIds
    : (modeInfo.docId ? [modeInfo.docId] : []);

  // Deduplicate folders where an ancestor is already included
  const folderIdSet = new Set(rawFolderIds);
  for (const fid of rawFolderIds) {
    const folder = S.folders.find(f => f.id === fid);
    if (!folder) continue;
    const ancestors = getAncestorFolderIds(folder.parent_folder_id);
    if (ancestors.some(aid => folderIdSet.has(aid))) continue;
    if (!seenFolders.has(fid)) {
      seenFolders.add(fid);
      queueItems.push({ kind: 'folder', id: fid });
    }
  }

  // Mark all PDFs covered by queued folders
  const coveredPdfIds = new Set();
  for (const item of queueItems) {
    const branchIds = new Set(getAllDescendantFolderIds(item.id));
    for (const p of S.pdfs) {
      if (branchIds.has(p.folder_id)) coveredPdfIds.add(p.id);
    }
  }

  for (const pid of rawPdfIds) {
    if (!pid || coveredPdfIds.has(pid) || seenPdfs.has(pid)) continue;
    if (S.pdfs.some(p => p.id === pid)) {
      seenPdfs.add(pid);
      queueItems.push({ kind: 'pdf', id: pid });
    }
  }

  return queueItems;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. BOOTSTRAP & ENTRY POINT
// ═════════════════════════════════════════════════════════════════════════════

export async function checkAndBootPrintStudioApp() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  const isUrlStudio = params.get('print-studio') === '1';

  let modeInfo = {
    isPrintStudio: isUrlStudio,
    jobId: params.get('job') || params.get('jobId') || null,
    docId: params.get('docId') || params.get('doc') || null,
    folderId: params.get('folderId') || params.get('folder') || null,
  };

  if (window.__DESKTOP_PRINT_STUDIO__?.getMode) {
    try {
      const deskMode = await window.__DESKTOP_PRINT_STUDIO__.getMode();
      if (deskMode && (deskMode.isPrintStudio || isUrlStudio)) {
        modeInfo = {
          isPrintStudio: true,
          jobId: deskMode.jobId || modeInfo.jobId || null,
          docId: deskMode.docId || modeInfo.docId || null,
          folderId: deskMode.folderId || modeInfo.folderId || null,
        };
      }
    } catch (err) {
      console.warn('[PrintStudio] getMode error:', err);
    }
  }

  if (!modeInfo.isPrintStudio) return false;

  document.title = 'Legal Print Studio — Notes & Case Digests';
  document.body.className = 'ps-standalone-body';
  document.body.innerHTML = '<div id="print-studio-app"></div>';

  const job = await loadPrintJobPayload(modeInfo.jobId);
  await hydrateLibraryState(job, { docId: modeInfo.docId, folderId: modeInfo.folderId });

  const mountEl = document.getElementById('print-studio-app');
  _studioController = mountPrintStudioUI(mountEl, { job, modeInfo, isOverlay: false });

  // Live receiver for desktop window reuse and BroadcastChannel updates
  window.__PRINT_STUDIO_RECEIVE_JOB = async (incoming) => {
    const nextJobId = typeof incoming === 'string' ? incoming : incoming?.jobId;
    if (!nextJobId || !_studioController) return;
    await _studioController.receiveJob(nextJobId);
  };

  const ch = getPrintChannel();
  if (ch) {
    ch.onmessage = async (ev) => {
      const msg = ev?.data;
      if (msg?.type === 'PRINT_JOB' && msg.jobId && _studioController) {
        await _studioController.receiveJob(msg.jobId);
      }
    };
  }

  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const rt = new BroadcastChannel(REALTIME_CHANNEL_NAME);
      rt.onmessage = (ev) => {
        const msg = ev?.data;
        if (!_studioController) return;
        if (msg?.type === 'NOTEPAD_CHANGED') {
          _studioController.invalidatePdfCache(msg.pdfId);
          _studioController.schedulePreview();
        } else if (msg?.type === 'LIBRARY_CHANGED') {
          _studioController.refreshAll({ quiet: true });
        }
      };
    } catch {}
  }

  return true;
}

export async function openPrintStudio(jobSpec = {}) {
  const folderIds = Array.isArray(jobSpec.folderIds) ? jobSpec.folderIds.filter(Boolean) : [];
  const pdfIds = Array.isArray(jobSpec.pdfIds) ? jobSpec.pdfIds.filter(Boolean) : [];
  const targetType = jobSpec.targetType || (folderIds.length ? 'folder' : (pdfIds.length ? 'pdf' : 'library'));
  const jobId = jobSpec.jobId || `ps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const title = jobSpec.title || 'Legal Print Studio';
  const defaultMode = jobSpec.defaultMode === 'tables-only' ? 'tables-only' : 'all';
  const orientation = jobSpec.orientation === 'landscape'
    ? 'landscape'
    : (jobSpec.orientation === 'portrait' ? 'portrait' : null);

  const buildPayload = () => ({
    jobId,
    createdAt: Date.now(),
    title,
    targetType,
    folderIds,
    pdfIds,
    defaultMode,
    orientation,
    librarySnapshot: {
      subjects: Array.isArray(S.subjects) ? S.subjects : [],
      folders: Array.isArray(S.folders) ? S.folders : [],
      pdfs: Array.isArray(S.pdfs) ? S.pdfs : [],
    },
  });

  const desktopStudio = typeof window !== 'undefined' ? window.__DESKTOP_PRINT_STUDIO__ : null;

  // In Web Browser mode, pre-open the window synchronously BEFORE awaiting flushes so popup blockers allow it
  let preOpenedWin = null;
  if (!desktopStudio) {
    const initialPayload = buildPayload();
    saveLocalJob(jobId, initialPayload);
    const targetUrl = `?print-studio=1&job=${encodeURIComponent(jobId)}`;
    try {
      preOpenedWin = window.open(targetUrl, 'la_print_studio');
    } catch {
      preOpenedWin = null;
    }
  }

  await flushPendingNotesForExport();
  const payload = buildPayload();
  saveLocalJob(jobId, payload);

  const ch = getPrintChannel();
  if (ch) {
    try {
      ch.postMessage({ type: 'PRINT_JOB', jobId, createdAt: payload.createdAt });
    } catch {}
  }

  if (desktopStudio) {
    try {
      await desktopStudio.saveJob(jobId, payload);
      await desktopStudio.openWindow(jobId, title);
      return;
    } catch (err) {
      console.warn('[PrintStudio] Desktop window launch failed, falling back to overlay:', err);
    }
  }

  if (preOpenedWin && !preOpenedWin.closed) {
    try { preOpenedWin.focus(); } catch {}
    toast('🖨️ Opened in Legal Print Studio.');
    return;
  }

  // Fallback when popups are blocked (or desktop openWindow failed): mount inline #print-studio-overlay
  openPrintStudioOverlay(payload);
}

function openPrintStudioOverlay(job) {
  let overlay = document.getElementById('print-studio-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'print-studio-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = '<div id="print-studio-app"></div>';
  overlay.style.display = 'flex';

  const closeOverlay = () => {
    overlay.style.display = 'none';
    overlay.innerHTML = '';
    if (_studioController && _studioController.isOverlay) {
      _studioController.destroy();
      _studioController = null;
    }
  };

  const mountEl = overlay.querySelector('#print-studio-app');
  if (_studioController && _studioController.isOverlay) {
    _studioController.destroy();
  }
  _studioController = mountPrintStudioUI(mountEl, {
    job,
    modeInfo: { isPrintStudio: true, jobId: job?.jobId || null, docId: null, folderId: null },
    isOverlay: true,
    onClose: closeOverlay,
  });

  window.__PRINT_STUDIO_RECEIVE_JOB = async (incoming) => {
    const nextJobId = typeof incoming === 'string' ? incoming : incoming?.jobId;
    if (!nextJobId || !_studioController) return;
    await _studioController.receiveJob(nextJobId);
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. THREE-PANE STUDIO UI CONTROLLER
// ═════════════════════════════════════════════════════════════════════════════

function mountPrintStudioUI(rootEl, { job, modeInfo, isOverlay = false, onClose = null }) {
  const prefs = loadSavedPrefs();
  if (job?.defaultMode === 'tables-only') {
    prefs.tablesOnly = true;
  } else if (job?.defaultMode === 'all') {
    prefs.tablesOnly = false;
  }
  if (job?.orientation === 'landscape' || job?.orientation === 'portrait') {
    prefs.orientation = job.orientation;
  }

  const queueItems = buildQueueFromJobOrMode(job, modeInfo);

  const state = {
    jobTitle: job?.title || 'Legal Print Studio',
    prefs,
    queueItems,
    excludedFolderIds: new Set(),
    excludedPdfIds: new Set(),
    collapsedSubjects: new Set((S.subjects || []).map(s => s.id)),
    collapsedFolders: new Set([
      ...(S.folders || []).map(f => f.id),
      '__other_folders__',
      '__unfiled__',
    ]),
    sidebarOpen: queueItems.length === 0,
    searchQuery: '',
    searchTimer: null,
    lastPageCount: 0,
    notesCache: new Map(),
    folderNotesCache: new Map(),
    renderToken: 0,
    previewTimer: null,
    lastHtmlHasBody: false,
    destroyed: false,
  };

  function expandAncestorsForQueue(items) {
    const subjIdSet = new Set((S.subjects || []).map(s => s.id));
    for (const item of items) {
      if (item.kind === 'folder') {
        const fold = (S.folders || []).find(f => f.id === item.id);
        if (!fold) continue;
        const ancestors = getAncestorFolderIds(fold.parent_folder_id);
        for (const aid of ancestors) state.collapsedFolders.delete(aid);
        const rootId = ancestors.length ? ancestors[ancestors.length - 1] : fold.id;
        const rootFold = (S.folders || []).find(f => f.id === rootId) || fold;
        if (rootFold.subject_id && subjIdSet.has(rootFold.subject_id)) {
          state.collapsedSubjects.delete(rootFold.subject_id);
        } else {
          state.collapsedFolders.delete('__other_folders__');
        }
      } else if (item.kind === 'pdf') {
        const pdf = (S.pdfs || []).find(p => p.id === item.id);
        if (!pdf) continue;
        const fold = pdf.folder_id ? (S.folders || []).find(f => f.id === pdf.folder_id) : null;
        if (fold) {
          const ancestors = getAncestorFolderIds(fold.id);
          for (const aid of ancestors) state.collapsedFolders.delete(aid);
          const rootId = ancestors[ancestors.length - 1];
          const rootFold = (S.folders || []).find(f => f.id === rootId) || fold;
          if (rootFold.subject_id && subjIdSet.has(rootFold.subject_id)) {
            state.collapsedSubjects.delete(rootFold.subject_id);
          } else {
            state.collapsedFolders.delete('__other_folders__');
          }
        } else {
          state.collapsedFolders.delete('__unfiled__');
        }
      }
    }
  }

  expandAncestorsForQueue(state.queueItems);

  rootEl.innerHTML = `
    <header id="ps-header">
      <div class="ps-header-left">
        <button id="ps-btn-toggle-sidebar" class="ps-btn ps-btn-drawer" type="button" aria-expanded="${state.sidebarOpen}" title="Toggle Cases &amp; Print Order">Cases <span id="ps-queue-count" class="ps-count-pill">0</span></button>
        <div class="ps-header-titles">
          <span class="ps-brand-name">Print Studio</span>
          <span id="ps-preview-badge" class="ps-preview-badge">A4 Portrait</span>
        </div>
      </div>

      <div class="ps-toolbar-center">
        <div class="ps-seg-group" role="group" aria-label="Paper size">
          <button class="ps-seg-btn" data-ps-paper="a4" type="button">A4</button>
          <button class="ps-seg-btn" data-ps-paper="letter" type="button">Letter</button>
          <button class="ps-seg-btn" data-ps-paper="legal" type="button">Legal</button>
        </div>
        <div class="ps-seg-group" role="group" aria-label="Orientation">
          <button class="ps-seg-btn" data-ps-orient="portrait" type="button">Portrait</button>
          <button class="ps-seg-btn" data-ps-orient="landscape" type="button">Landscape</button>
        </div>
        <div class="ps-seg-group" role="group" aria-label="Margins">
          <button class="ps-seg-btn" data-ps-margin="narrow" type="button">Narrow</button>
          <button class="ps-seg-btn" data-ps-margin="normal" type="button">Normal</button>
          <button class="ps-seg-btn" data-ps-margin="wide" type="button">Wide</button>
        </div>
        <div class="ps-seg-group" role="group" aria-label="Spacing">
          <button class="ps-seg-btn" data-ps-layout="tight" type="button">Tight</button>
          <button class="ps-seg-btn" data-ps-layout="compact" type="button">Compact</button>
          <button class="ps-seg-btn" data-ps-layout="standard" type="button">Standard</button>
        </div>
        <div class="ps-seg-group" role="group" aria-label="Columns">
          <button id="ps-col-1" class="ps-seg-btn" data-ps-col="1" type="button">1 Col</button>
          <button id="ps-col-2" class="ps-seg-btn" data-ps-col="2" type="button">2 Col</button>
        </div>
        <div class="ps-pill-toggles">
          <label class="ps-pill-chk"><input id="ps-opt-digest" type="checkbox"><span>Digest</span></label>
          <label class="ps-pill-chk"><input id="ps-opt-notes" type="checkbox"><span>Notes</span></label>
          <label class="ps-pill-chk"><input id="ps-opt-folder-docs" type="checkbox"><span>Folder Notes</span></label>
          <label class="ps-pill-chk ps-pill-accent"><input id="ps-opt-tables-only" type="checkbox"><span>Tables Only</span></label>
          <label class="ps-pill-chk"><input id="ps-opt-toc" type="checkbox"><span>TOC</span></label>
          <label class="ps-pill-chk"><input id="ps-opt-running-headers" type="checkbox"><span>Page #</span></label>
        </div>
        <button id="ps-btn-default-preset" class="ps-btn ps-btn-ghost ps-btn-sm" type="button" title="Click: Reset to Default (A4, Portrait, Narrow, Tight) • Shift+Click: Save current setup as Default">Default</button>
      </div>

      <div class="ps-header-actions">
        <div class="ps-zoom-group" role="group" aria-label="Preview zoom">
          <button id="ps-zoom-75" class="ps-zoom-btn" data-ps-zoom="0.75" type="button">75%</button>
          <button id="ps-zoom-100" class="ps-zoom-btn" data-ps-zoom="1" type="button">100%</button>
          <button id="ps-zoom-125" class="ps-zoom-btn" data-ps-zoom="1.25" type="button">125%</button>
        </div>
        <button id="ps-btn-refresh" class="ps-btn ps-btn-sec ps-btn-sm" type="button" title="Reload latest Notes, Case Digests &amp; Folder Docs">Refresh</button>
        <button id="ps-btn-print" class="ps-btn ps-btn-primary" type="button" title="Print or Save as PDF (Ctrl+P)">Print / PDF</button>
        <button id="ps-btn-close" class="ps-btn ps-btn-ghost ps-btn-icon" type="button" title="Close Print Studio">✕</button>
      </div>
    </header>

    <div id="ps-workspace">
      <aside id="ps-left-pane"${state.sidebarOpen ? '' : ' class="collapsed"'}>
        <div class="ps-pane-head">
          <span id="ps-selection-summary" class="ps-selection-summary">Preparing selection…</span>
          <div class="ps-mini-actions">
            <button id="ps-btn-select-all" class="ps-link-btn" type="button">Select All</button>
            <span class="ps-dot-sep">&bull;</span>
            <button id="ps-btn-clear-all" class="ps-link-btn" type="button">Clear</button>
          </div>
        </div>

        <div class="ps-search-wrap">
          <input id="ps-search-input" type="search" placeholder="Search folders or cases…" autocomplete="off" spellcheck="false">
        </div>

        <div id="ps-tree" class="ps-tree"></div>

        <details id="ps-queue-section">
          <summary class="ps-pane-head ps-queue-head"><span class="ps-pane-title">Print Order</span></summary>
          <div id="ps-queue-list" class="ps-queue-list"></div>
        </details>
      </aside>

      <main id="ps-center-pane">
        <div id="ps-preview-stage">
          <div id="ps-loading-bar" style="display:none;">Gathering notes &amp; building preview…</div>
          <iframe id="ps-preview-frame" title="Legal Print Studio Preview"></iframe>
          <div id="ps-empty-state" style="display:none;">
            <div class="ps-empty-card">
              <h2 id="ps-empty-title">No items selected</h2>
              <p id="ps-empty-desc">Check one or more folders or cases in the Cases panel to preview and print Notes, Case Digests, Folder Docs, or Summary Tables.</p>
              <button id="ps-empty-reset-btn" class="ps-btn ps-btn-primary" type="button" style="display:none;">Show All Content Types</button>
            </div>
          </div>
        </div>
      </main>
    </div>
  `;

  const elLeftPane = rootEl.querySelector('#ps-left-pane');
  const elBtnToggleSidebar = rootEl.querySelector('#ps-btn-toggle-sidebar');
  const elSummary = rootEl.querySelector('#ps-selection-summary');
  const elTree = rootEl.querySelector('#ps-tree');
  const elQueueList = rootEl.querySelector('#ps-queue-list');
  const elQueueCount = rootEl.querySelector('#ps-queue-count');
  const elSearch = rootEl.querySelector('#ps-search-input');
  const elPreviewBarBadge = rootEl.querySelector('#ps-preview-badge');
  const elPreviewFrame = rootEl.querySelector('#ps-preview-frame');
  const elLoadingBar = rootEl.querySelector('#ps-loading-bar');
  const elEmptyState = rootEl.querySelector('#ps-empty-state');
  const elEmptyTitle = rootEl.querySelector('#ps-empty-title');
  const elEmptyDesc = rootEl.querySelector('#ps-empty-desc');
  const elEmptyResetBtn = rootEl.querySelector('#ps-empty-reset-btn');
  const btnPrint = rootEl.querySelector('#ps-btn-print');

  const chkDigest = rootEl.querySelector('#ps-opt-digest');
  const chkNotes = rootEl.querySelector('#ps-opt-notes');
  const chkFolderDocs = rootEl.querySelector('#ps-opt-folder-docs');
  const chkTablesOnly = rootEl.querySelector('#ps-opt-tables-only');
  const chkToc = rootEl.querySelector('#ps-opt-toc');
  const chkRunningHeaders = rootEl.querySelector('#ps-opt-running-headers');

  // ── Inclusion helpers ──
  function isFolderQueuedDirectly(folderId) {
    return state.queueItems.some(i => i.kind === 'folder' && i.id === folderId);
  }

  function isPdfQueuedDirectly(pdfId) {
    return state.queueItems.some(i => i.kind === 'pdf' && i.id === pdfId);
  }

  function isFolderCoveredByQueuedAncestor(folderId) {
    const folder = S.folders.find(f => f.id === folderId);
    if (!folder) return false;
    const ancestors = getAncestorFolderIds(folder.parent_folder_id);
    for (const aid of ancestors) {
      if (state.excludedFolderIds.has(aid)) return false;
      if (isFolderQueuedDirectly(aid)) return true;
    }
    return false;
  }

  function isFolderEffectivelyIncluded(folderId) {
    if (state.excludedFolderIds.has(folderId)) return false;
    if (isFolderQueuedDirectly(folderId)) return true;
    const ancestors = getAncestorFolderIds(folderId);
    // Walk from closest ancestor upward: if an excluded folder appears before a queued folder, it's excluded
    for (const aid of ancestors) {
      if (state.excludedFolderIds.has(aid)) return false;
      if (isFolderQueuedDirectly(aid)) return true;
    }
    return false;
  }

  function isPdfEffectivelyIncluded(pdf) {
    if (!pdf) return false;
    if (state.excludedPdfIds.has(pdf.id)) return false;
    if (isPdfQueuedDirectly(pdf.id)) return true;
    if (pdf.folder_id && isFolderEffectivelyIncluded(pdf.folder_id)) return true;
    return false;
  }

  function getFolderCheckState(folderId) {
    const selfIncluded = isFolderEffectivelyIncluded(folderId);
    const branchIds = new Set(getAllDescendantFolderIds(folderId));
    const branchPdfs = S.pdfs.filter(p => branchIds.has(p.folder_id));

    if (!selfIncluded) {
      const someChildIncluded = branchPdfs.some(p => isPdfEffectivelyIncluded(p)) ||
        Array.from(branchIds).some(id => id !== folderId && isFolderEffectivelyIncluded(id));
      return { checked: false, indeterminate: someChildIncluded };
    }

    const anyExcludedPdf = branchPdfs.some(p => !isPdfEffectivelyIncluded(p));
    const anyExcludedSub = Array.from(branchIds).some(id => id !== folderId && state.excludedFolderIds.has(id));
    return { checked: true, indeterminate: anyExcludedPdf || anyExcludedSub };
  }

  function toggleFolderSelection(folderId, wantChecked) {
    const branchFolderIds = new Set(getAllDescendantFolderIds(folderId));
    const branchPdfIds = new Set(S.pdfs.filter(p => branchFolderIds.has(p.folder_id)).map(p => p.id));

    if (wantChecked) {
      for (const fid of branchFolderIds) state.excludedFolderIds.delete(fid);
      for (const pid of branchPdfIds) state.excludedPdfIds.delete(pid);

      const coveredByAncestor = isFolderCoveredByQueuedAncestor(folderId);
      if (!coveredByAncestor && !isFolderQueuedDirectly(folderId)) {
        // Remove redundant nested entries before adding the parent folder
        state.queueItems = state.queueItems.filter(item => {
          if (item.kind === 'folder') return !branchFolderIds.has(item.id);
          if (item.kind === 'pdf') return !branchPdfIds.has(item.id);
          return true;
        });
        state.queueItems.push({ kind: 'folder', id: folderId });
      }
    } else {
      state.queueItems = state.queueItems.filter(item => {
        if (item.kind === 'folder' && branchFolderIds.has(item.id)) return false;
        if (item.kind === 'pdf' && branchPdfIds.has(item.id)) return false;
        return true;
      });
      if (isFolderCoveredByQueuedAncestor(folderId)) {
        state.excludedFolderIds.add(folderId);
      } else {
        for (const fid of branchFolderIds) state.excludedFolderIds.delete(fid);
      }
    }
  }

  function togglePdfSelection(pdfId, wantChecked) {
    const pdf = S.pdfs.find(p => p.id === pdfId);
    if (!pdf) return;
    const coveredByFolder = pdf.folder_id ? isFolderEffectivelyIncluded(pdf.folder_id) : false;

    if (wantChecked) {
      state.excludedPdfIds.delete(pdfId);
      if (!coveredByFolder && !isPdfQueuedDirectly(pdfId)) {
        state.queueItems.push({ kind: 'pdf', id: pdfId });
      }
    } else {
      state.queueItems = state.queueItems.filter(i => !(i.kind === 'pdf' && i.id === pdfId));
      if (coveredByFolder) {
        state.excludedPdfIds.add(pdfId);
      }
    }
  }

  function countEffectiveSelections() {
    let foldersCount = 0;
    let pdfsCount = 0;
    for (const f of S.folders) {
      if (isFolderEffectivelyIncluded(f.id)) foldersCount++;
    }
    for (const p of S.pdfs) {
      if (isPdfEffectivelyIncluded(p)) pdfsCount++;
    }
    return { foldersCount, pdfsCount };
  }

  function syncInspectorControls() {
    if (chkDigest) chkDigest.checked = Boolean(state.prefs.includeDigest);
    if (chkNotes) chkNotes.checked = Boolean(state.prefs.includeNotes);
    if (chkFolderDocs) chkFolderDocs.checked = Boolean(state.prefs.includeFolderDocs);
    if (chkTablesOnly) chkTablesOnly.checked = Boolean(state.prefs.tablesOnly);
    if (chkToc) chkToc.checked = Boolean(state.prefs.includeToc);
    if (chkRunningHeaders) chkRunningHeaders.checked = state.prefs.runningHeaders !== false;

    rootEl.querySelectorAll('[data-ps-col]').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.psCol) === Number(state.prefs.columns));
    });
    rootEl.querySelectorAll('[data-ps-layout]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.psLayout === state.prefs.layout);
    });
    rootEl.querySelectorAll('[data-ps-paper]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.psPaper === state.prefs.paperSize);
    });
    rootEl.querySelectorAll('[data-ps-orient]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.psOrient === state.prefs.orientation);
    });
    rootEl.querySelectorAll('[data-ps-margin]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.psMargin === state.prefs.marginPreset);
    });
    rootEl.querySelectorAll('[data-ps-zoom]').forEach(btn => {
      btn.classList.toggle('active', Math.abs(Number(btn.dataset.psZoom) - Number(state.prefs.previewZoom)) < 0.01);
    });
    if (elBtnToggleSidebar) {
      elBtnToggleSidebar.classList.toggle('active', Boolean(state.sidebarOpen));
      elBtnToggleSidebar.setAttribute('aria-expanded', String(Boolean(state.sidebarOpen)));
    }
  }

  function renderQueueList() {
    if (!elQueueList) return;
    elQueueList.innerHTML = '';
    if (elQueueCount) elQueueCount.textContent = String(state.queueItems.length);

    if (!state.queueItems.length) {
      elQueueList.innerHTML = '<div class="ps-queue-empty">Check folders or cases above to build your print packet.</div>';
      return;
    }

    state.queueItems.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'ps-queue-item';
      let icon = '📄';
      let label = 'Case';
      let meta = '';

      if (item.kind === 'folder') {
        const fold = S.folders.find(f => f.id === item.id);
        icon = '📁';
        label = fold ? getFolderDisplayTitle(fold) : 'Deleted Folder';
        const branchIds = new Set(getAllDescendantFolderIds(item.id));
        const totalCases = S.pdfs.filter(p => branchIds.has(p.folder_id)).length;
        const includedCases = S.pdfs.filter(p => branchIds.has(p.folder_id) && isPdfEffectivelyIncluded(p)).length;
        meta = totalCases === includedCases
          ? `${includedCases} ${includedCases === 1 ? 'case' : 'cases'}`
          : `${includedCases}/${totalCases} cases`;
      } else {
        const pdf = S.pdfs.find(p => p.id === item.id);
        icon = '📄';
        label = pdf ? getCleanPdfTitle(pdf) : 'Deleted Case';
        const fold = pdf?.folder_id ? S.folders.find(f => f.id === pdf.folder_id) : null;
        meta = fold ? getFolderDisplayTitle(fold) : 'Unfiled';
      }

      row.innerHTML = `
        <span class="ps-q-icon">${icon}</span>
        <div class="ps-q-info">
          <div class="ps-q-name">${escapeHtml(label)}</div>
          <div class="ps-q-meta">${escapeHtml(meta)}</div>
        </div>
        <div class="ps-q-btns">
          <button class="ps-q-btn" data-act="up" title="Move Up" ${idx === 0 ? 'disabled' : ''}>▲</button>
          <button class="ps-q-btn" data-act="down" title="Move Down" ${idx === state.queueItems.length - 1 ? 'disabled' : ''}>▼</button>
          <button class="ps-q-btn ps-q-rm" data-act="rm" title="Remove">✕</button>
        </div>
      `;

      row.querySelector('[data-act="up"]')?.addEventListener('click', () => {
        if (idx <= 0) return;
        const copy = [...state.queueItems];
        [copy[idx - 1], copy[idx]] = [copy[idx], copy[idx - 1]];
        state.queueItems = copy;
        renderQueueList();
        schedulePreview();
      });
      row.querySelector('[data-act="down"]')?.addEventListener('click', () => {
        if (idx >= state.queueItems.length - 1) return;
        const copy = [...state.queueItems];
        [copy[idx], copy[idx + 1]] = [copy[idx + 1], copy[idx]];
        state.queueItems = copy;
        renderQueueList();
        schedulePreview();
      });
      row.querySelector('[data-act="rm"]')?.addEventListener('click', () => {
        const removed = state.queueItems[idx];
        if (removed.kind === 'folder') {
          toggleFolderSelection(removed.id, false);
        } else {
          togglePdfSelection(removed.id, false);
        }
        renderTree();
        renderQueueList();
        schedulePreview();
      });

      elQueueList.appendChild(row);
    });
  }

  function renderTree() {
    if (!elTree) return;
    const q = (state.searchQuery || '').trim().toLowerCase();
    const { foldersCount, pdfsCount } = countEffectiveSelections();
    if (elSummary) {
      elSummary.textContent = (foldersCount || pdfsCount)
        ? `${pdfsCount} ${pdfsCount === 1 ? 'case' : 'cases'}${foldersCount ? ` • ${foldersCount} ${foldersCount === 1 ? 'folder' : 'folders'}` : ''}`
        : 'Select folders or cases to preview';
    }

    // Single O(F + P) precomputation pass for tree lookup and branch counts
    const allFolders = S.folders || [];
    const allPdfs = S.pdfs || [];
    const folderById = new Map();
    const childrenByParent = new Map();
    for (const f of allFolders) {
      folderById.set(f.id, f);
      const pid = f.parent_folder_id || null;
      if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
      childrenByParent.get(pid).push(f);
    }
    for (const list of childrenByParent.values()) {
      list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    }

    const pdfsByFolder = new Map();
    for (const p of allPdfs) {
      const fid = p.folder_id || null;
      if (!pdfsByFolder.has(fid)) pdfsByFolder.set(fid, []);
      pdfsByFolder.get(fid).push(p);
    }
    for (const list of pdfsByFolder.values()) {
      list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    }

    const branchPdfCounts = new Map();
    const computeBranchPdfCount = (folderId, visiting = new Set()) => {
      if (branchPdfCounts.has(folderId)) return branchPdfCounts.get(folderId);
      if (visiting.has(folderId)) return 0;
      visiting.add(folderId);
      let count = (pdfsByFolder.get(folderId) || []).length;
      for (const sub of (childrenByParent.get(folderId) || [])) {
        count += computeBranchPdfCount(sub.id, visiting);
      }
      visiting.delete(folderId);
      branchPdfCounts.set(folderId, count);
      return count;
    };
    for (const f of allFolders) {
      computeBranchPdfCount(f.id);
    }

    const folderMatchesCache = new Map();
    function folderOrDescMatches(folderId) {
      if (!q) return true;
      if (folderMatchesCache.has(folderId)) return folderMatchesCache.get(folderId);
      const fold = folderById.get(folderId);
      if (!fold) {
        folderMatchesCache.set(folderId, false);
        return false;
      }
      if ((fold.name || '').toLowerCase().includes(q)) {
        folderMatchesCache.set(folderId, true);
        return true;
      }
      const childPdfs = pdfsByFolder.get(folderId) || [];
      if (childPdfs.some(p => (p.name || '').toLowerCase().includes(q))) {
        folderMatchesCache.set(folderId, true);
        return true;
      }
      const subFolds = childrenByParent.get(folderId) || [];
      const anySub = subFolds.some(sf => folderOrDescMatches(sf.id));
      folderMatchesCache.set(folderId, anySub);
      return anySub;
    }

    elTree.innerHTML = '';

    function renderFolderNode(folder, containerEl, depth = 0) {
      if (!folderOrDescMatches(folder.id)) return;
      const isCollapsed = !q && state.collapsedFolders.has(folder.id);
      const subFolders = childrenByParent.get(folder.id) || [];
      const folderPdfs = pdfsByFolder.get(folder.id) || [];

      const hasChildren = subFolders.length > 0 || folderPdfs.length > 0;
      const chkState = getFolderCheckState(folder.id);

      const nodeWrap = document.createElement('div');
      nodeWrap.className = 'ps-tree-branch';

      const row = document.createElement('div');
      row.className = 'ps-tree-row ps-tree-folder';
      row.style.paddingLeft = `${8 + depth * 14}px`;

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'ps-twist';
      toggleBtn.textContent = hasChildren ? (isCollapsed ? '▸' : '▾') : '•';
      toggleBtn.disabled = !hasChildren;
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!hasChildren) return;
        if (state.collapsedFolders.has(folder.id)) state.collapsedFolders.delete(folder.id);
        else state.collapsedFolders.add(folder.id);
        renderTree();
      });

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'ps-chk';
      cb.checked = chkState.checked;
      cb.indeterminate = chkState.indeterminate;
      cb.addEventListener('change', () => {
        toggleFolderSelection(folder.id, cb.checked);
        renderTree();
        renderQueueList();
        schedulePreview();
      });

      const lbl = document.createElement('span');
      lbl.className = 'ps-tree-label';
      lbl.textContent = `📁 ${getFolderDisplayTitle(folder)}`;
      lbl.title = getFolderPathString(folder);
      lbl.addEventListener('click', () => {
        cb.checked = !cb.checked;
        toggleFolderSelection(folder.id, cb.checked);
        renderTree();
        renderQueueList();
        schedulePreview();
      });

      const badge = document.createElement('span');
      badge.className = 'ps-node-count';
      const branchPdfCount = branchPdfCounts.get(folder.id) || 0;
      if (branchPdfCount > 0) badge.textContent = String(branchPdfCount);

      row.appendChild(toggleBtn);
      row.appendChild(cb);
      row.appendChild(lbl);
      if (branchPdfCount > 0) row.appendChild(badge);
      nodeWrap.appendChild(row);

      if (hasChildren && !isCollapsed) {
        const childrenBox = document.createElement('div');
        childrenBox.className = 'ps-tree-children';

        for (const pdf of folderPdfs) {
          if (q && !(pdf.name || '').toLowerCase().includes(q) && !(folder.name || '').toLowerCase().includes(q)) {
            continue;
          }
          const pdfRow = document.createElement('div');
          pdfRow.className = 'ps-tree-row ps-tree-pdf';
          pdfRow.style.paddingLeft = `${26 + depth * 14}px`;

          const pcb = document.createElement('input');
          pcb.type = 'checkbox';
          pcb.className = 'ps-chk';
          pcb.checked = isPdfEffectivelyIncluded(pdf);
          pcb.addEventListener('change', () => {
            togglePdfSelection(pdf.id, pcb.checked);
            renderTree();
            renderQueueList();
            schedulePreview();
          });

          const plbl = document.createElement('span');
          plbl.className = 'ps-tree-label';
          plbl.textContent = `📄 ${getCleanPdfTitle(pdf)}`;
          plbl.title = pdf.name || '';
          plbl.addEventListener('click', () => {
            pcb.checked = !pcb.checked;
            togglePdfSelection(pdf.id, pcb.checked);
            renderTree();
            renderQueueList();
            schedulePreview();
          });

          pdfRow.appendChild(pcb);
          pdfRow.appendChild(plbl);
          childrenBox.appendChild(pdfRow);
        }

        for (const sf of subFolders) {
          renderFolderNode(sf, childrenBox, depth + 1);
        }

        nodeWrap.appendChild(childrenBox);
      }

      containerEl.appendChild(nodeWrap);
    }

    const subjects = [...(S.subjects || [])];
    const topLevelFolders = childrenByParent.get(null) || [];
    let renderedAny = false;

    for (const subj of subjects) {
      const rootFolders = topLevelFolders.filter(f => f.subject_id === subj.id);

      const subjNameMatches = q && (subj.name || '').toLowerCase().includes(q);
      const visibleFolders = subjNameMatches
        ? rootFolders
        : rootFolders.filter(f => folderOrDescMatches(f.id));
      if (!visibleFolders.length) continue;

      renderedAny = true;
      const subjEl = document.createElement('div');
      subjEl.className = 'ps-subj-group';

      const subjHdr = document.createElement('div');
      subjHdr.className = 'ps-subj-header';
      const isSubjCollapsed = !q && state.collapsedSubjects.has(subj.id);
      subjHdr.innerHTML = `
        <span class="ps-subj-twist">${isSubjCollapsed ? '▸' : '▾'}</span>
        <span class="ps-subj-dot" style="background:${escapeHtml(subj.hex_color || '#c9a84c')};"></span>
        <span class="ps-subj-name">${escapeHtml(stripEmojis(subj.name) || 'Subject')}</span>
      `;
      subjHdr.addEventListener('click', () => {
        if (state.collapsedSubjects.has(subj.id)) state.collapsedSubjects.delete(subj.id);
        else state.collapsedSubjects.add(subj.id);
        renderTree();
      });
      subjEl.appendChild(subjHdr);

      if (!isSubjCollapsed) {
        for (const rf of visibleFolders) {
          renderFolderNode(rf, subjEl, 0);
        }
      }
      elTree.appendChild(subjEl);
    }

    // Orphan folders (whose subject_id is missing)
    const subjIds = new Set(subjects.map(s => s.id));
    const orphanFolders = topLevelFolders.filter(f => !f.subject_id || !subjIds.has(f.subject_id));
    const visibleOrphans = orphanFolders.filter(f => folderOrDescMatches(f.id));
    if (visibleOrphans.length) {
      renderedAny = true;
      const groupEl = document.createElement('div');
      groupEl.className = 'ps-subj-group';
      const isOtherCollapsed = !q && state.collapsedFolders.has('__other_folders__');
      const hdr = document.createElement('div');
      hdr.className = 'ps-subj-header';
      hdr.innerHTML = `
        <span class="ps-subj-twist">${isOtherCollapsed ? '▸' : '▾'}</span>
        <span class="ps-subj-name">Other Folders</span>
      `;
      hdr.addEventListener('click', () => {
        if (state.collapsedFolders.has('__other_folders__')) state.collapsedFolders.delete('__other_folders__');
        else state.collapsedFolders.add('__other_folders__');
        renderTree();
      });
      groupEl.appendChild(hdr);
      if (!isOtherCollapsed) {
        for (const rf of visibleOrphans) renderFolderNode(rf, groupEl, 0);
      }
      elTree.appendChild(groupEl);
    }

    // Unfiled PDFs (folder_id missing or deleted)
    const unfiledPdfs = allPdfs.filter(p => !p.folder_id || !folderById.has(p.folder_id))
      .filter(p => !q || (p.name || '').toLowerCase().includes(q));
    if (unfiledPdfs.length) {
      renderedAny = true;
      const groupEl = document.createElement('div');
      groupEl.className = 'ps-subj-group';
      const isUnfiledCollapsed = !q && state.collapsedFolders.has('__unfiled__');
      const hdr = document.createElement('div');
      hdr.className = 'ps-subj-header';
      hdr.innerHTML = `
        <span class="ps-subj-twist">${isUnfiledCollapsed ? '▸' : '▾'}</span>
        <span class="ps-subj-name">Unfiled Cases</span>
      `;
      hdr.addEventListener('click', () => {
        if (state.collapsedFolders.has('__unfiled__')) state.collapsedFolders.delete('__unfiled__');
        else state.collapsedFolders.add('__unfiled__');
        renderTree();
      });
      groupEl.appendChild(hdr);
      if (!isUnfiledCollapsed) {
        for (const pdf of unfiledPdfs) {
          const pdfRow = document.createElement('div');
          pdfRow.className = 'ps-tree-row ps-tree-pdf';
          pdfRow.style.paddingLeft = '12px';
          const pcb = document.createElement('input');
          pcb.type = 'checkbox';
          pcb.className = 'ps-chk';
          pcb.checked = isPdfEffectivelyIncluded(pdf);
          pcb.addEventListener('change', () => {
            togglePdfSelection(pdf.id, pcb.checked);
            renderTree();
            renderQueueList();
            schedulePreview();
          });
          const plbl = document.createElement('span');
          plbl.className = 'ps-tree-label';
          plbl.textContent = `📄 ${getCleanPdfTitle(pdf)}`;
          plbl.addEventListener('click', () => {
            pcb.checked = !pcb.checked;
            togglePdfSelection(pdf.id, pcb.checked);
            renderTree();
            renderQueueList();
            schedulePreview();
          });
          pdfRow.appendChild(pcb);
          pdfRow.appendChild(plbl);
          groupEl.appendChild(pdfRow);
        }
      }
      elTree.appendChild(groupEl);
    }

    if (!renderedAny) {
      elTree.innerHTML = q
        ? '<div class="ps-tree-empty">No folders or cases match your search.</div>'
        : '<div class="ps-tree-empty">No library folders or cases found yet.</div>';
    }
  }

  async function prefetchPdf(pdf) {
    const trueId = pdf.linked_pdf_id || pdf.id;
    const existing = state.notesCache.get(trueId);
    const wantAnnTable = Boolean(state.prefs.tablesOnly);
    if (!existing) {
      const [nd, annTable] = await Promise.all([
        fetchPdfNotesAndDigest(pdf),
        wantAnnTable ? fetchFirstAnnotationTable(pdf) : Promise.resolve(undefined),
      ]);
      state.notesCache.set(trueId, wantAnnTable ? { ...nd, annotationTable: annTable } : { ...nd });
    } else if (wantAnnTable && existing.annotationTable === undefined) {
      const annTable = await fetchFirstAnnotationTable(pdf);
      state.notesCache.set(trueId, { ...existing, annotationTable: annTable });
    }
  }

  async function ensurePrefetchedForItem(item) {
    if (item.kind === 'pdf') {
      const pdf = S.pdfs.find(p => p.id === item.id);
      if (pdf) await prefetchPdf(pdf);
      return;
    }

    const branchIds = getAllDescendantFolderIds(item.id);
    const foldersToFetch = [];
    for (const fid of branchIds) {
      if (state.excludedFolderIds.has(fid)) continue;
      const fold = S.folders.find(f => f.id === fid);
      if (fold && !state.folderNotesCache.has(fid)) {
        foldersToFetch.push({ fid, fold });
      }
    }
    if (foldersToFetch.length) {
      await Promise.all(foldersToFetch.map(async ({ fid, fold }) => {
        const fn = await fetchFolderNotes(fold);
        state.folderNotesCache.set(fid, fn);
      }));
    }

    const branchSet = new Set(branchIds);
    const pdfs = S.pdfs.filter(p => branchSet.has(p.folder_id) && isPdfEffectivelyIncluded(p));
    // Fetch in small parallel batches of 6 so large folders load smoothly without overwhelming Supabase
    for (let i = 0; i < pdfs.length; i += 6) {
      const batch = pdfs.slice(i, i + 6);
      await Promise.all(batch.map(prefetchPdf));
    }
  }

  function applyZoomInPlace() {
    if (!elPreviewFrame?.contentWindow?.document) return;
    try {
      const paper = elPreviewFrame.contentWindow.document.querySelector('.paper-container');
      if (paper) paper.style.zoom = String(state.prefs.previewZoom);
    } catch {}
  }

  function showEmptyBanner({ title, desc, showReset }) {
    state.lastHtmlHasBody = false;
    if (btnPrint) btnPrint.disabled = true;
    if (elPreviewFrame) elPreviewFrame.style.visibility = 'hidden';
    if (elEmptyTitle) elEmptyTitle.textContent = title;
    if (elEmptyDesc) elEmptyDesc.textContent = desc;
    if (elEmptyResetBtn) elEmptyResetBtn.style.display = showReset ? 'inline-flex' : 'none';
    if (elEmptyState) elEmptyState.style.display = 'flex';
  }

  function hideEmptyBanner() {
    if (elEmptyState) elEmptyState.style.display = 'none';
    if (elPreviewFrame) elPreviewFrame.style.visibility = 'visible';
    if (btnPrint) btnPrint.disabled = false;
  }

  function getPaperOrientLabel() {
    const paperLabel = { letter: 'Letter', a4: 'A4', legal: 'Legal' }[state.prefs.paperSize] || 'A4';
    const orientLabel = state.prefs.orientation === 'landscape' ? 'Landscape' : 'Portrait';
    return `${paperLabel} ${orientLabel}`;
  }

  async function renderPreview() {
    if (state.destroyed) return;
    const myToken = ++state.renderToken;

    const { foldersCount, pdfsCount } = countEffectiveSelections();
    const paperOrientLabel = getPaperOrientLabel();

    if (!state.queueItems.length) {
      state.lastPageCount = 0;
      if (elPreviewBarBadge) elPreviewBarBadge.textContent = `0 sections • ${paperOrientLabel}`;
      showEmptyBanner({
        title: 'No folders or cases selected',
        desc: 'Check one or more folders or cases in the Cases panel to preview and print Notes, Case Digests, Folder Docs, or Summary Tables.',
        showReset: false,
      });
      return;
    }

    if (elLoadingBar) elLoadingBar.style.display = 'block';
    try {
      for (const item of state.queueItems) {
        await ensurePrefetchedForItem(item);
        if (myToken !== state.renderToken || state.destroyed) return;
      }

      const caseRegistry = [];
      const tocCollector = [];
      const visitedFolders = new Set();
      const seenPdfIds = new Set();
      const htmlParts = [];

      const commonOpts = {
        tablesOnly: Boolean(state.prefs.tablesOnly),
        includeDigest: Boolean(state.prefs.includeDigest),
        includeNotes: Boolean(state.prefs.includeNotes),
        includeFolderDocs: Boolean(state.prefs.includeFolderDocs),
        visitedFolders,
        seenPdfIds,
        excludedFolderIds: state.excludedFolderIds,
        excludedPdfIds: state.excludedPdfIds,
        notesCache: state.notesCache,
        folderNotesCache: state.folderNotesCache,
        tocCollector,
      };

      const folderDepth = state.queueItems.length > 1 || state.prefs.runningHeaders === false ? 2 : 1;

      for (const item of state.queueItems) {
        if (item.kind === 'folder') {
          const fHtml = await buildFolderHTML(item.id, folderDepth, caseRegistry, commonOpts);
          if (fHtml && hasMeaningfulContent(fHtml)) htmlParts.push(fHtml);
        } else if (item.kind === 'pdf') {
          const pdf = S.pdfs.find(p => p.id === item.id);
          if (!pdf) continue;
          const trueId = pdf.linked_pdf_id || pdf.id;
          const pHtml = await buildPdfCaseHTML(pdf, caseRegistry, {
            ...commonOpts,
            prefetched: state.notesCache.get(trueId),
          });
          if (pHtml && hasMeaningfulContent(pHtml)) htmlParts.push(pHtml);
        }
        if (myToken !== state.renderToken || state.destroyed) return;
      }

      const sectionsHtml = htmlParts.join('\n');
      const sectionCount = tocCollector.length || caseRegistry.length;

      if (elPreviewBarBadge) {
        elPreviewBarBadge.textContent = `${sectionCount} ${sectionCount === 1 ? 'section' : 'sections'} • ${paperOrientLabel}`;
      }

      if (!hasMeaningfulContent(sectionsHtml)) {
        const filtersDisabled = !state.prefs.includeDigest && !state.prefs.includeNotes && !state.prefs.includeFolderDocs;
        showEmptyBanner({
          title: filtersDisabled
            ? 'All content types are turned off'
            : (state.prefs.tablesOnly ? 'No summary tables found' : 'No matching notes or digests found'),
          desc: filtersDisabled
            ? 'Enable Digest, Notes, or Folder Notes in the top toolbar.'
            : (state.prefs.tablesOnly
                ? `None of the ${pdfsCount || foldersCount} selected item(s) have a summary table in Case Digest, Notes, or Annotation Summaries.`
                : `None of the ${pdfsCount || foldersCount} selected item(s) currently have saved Case Digest, Notes, or Folder Notes.`),
          showReset: filtersDisabled || Boolean(state.prefs.tablesOnly),
        });
        return;
      }

      const titleSuffix = state.prefs.tablesOnly ? 'Summary Tables Only' : 'Notes & Case Digests';
      let docTitle = state.jobTitle || `Legal Print Studio — ${titleSuffix}`;
      let subtitle = `${sectionCount} ${sectionCount === 1 ? 'section' : 'sections'}`;
      let fallbackPath = 'Library';

      if (state.queueItems.length === 1) {
        const only = state.queueItems[0];
        if (only.kind === 'folder') {
          const fold = S.folders.find(f => f.id === only.id);
          if (fold) {
            docTitle = `${getFolderDisplayTitle(fold)} — ${titleSuffix}`;
            fallbackPath = getFolderPathString(fold);
            subtitle = fallbackPath;
          }
        } else {
          const pdf = S.pdfs.find(p => p.id === only.id);
          if (pdf) {
            docTitle = `${getCleanPdfTitle(pdf)} — ${titleSuffix}`;
            const fold = pdf.folder_id ? S.folders.find(f => f.id === pdf.folder_id) : null;
            fallbackPath = fold ? getFolderPathString(fold) : 'Library';
            subtitle = fallbackPath;
          }
        }
      } else {
        const queuedFolders = state.queueItems
          .filter(i => i.kind === 'folder')
          .map(i => S.folders.find(f => f.id === i.id))
          .filter(Boolean);
        if (queuedFolders.length === state.queueItems.length && queuedFolders.length > 1) {
          const names = queuedFolders.slice(0, 3).map(getFolderDisplayTitle);
          docTitle = `${names.join(', ')}${queuedFolders.length > 3 ? ` +${queuedFolders.length - 3}` : ''} — ${titleSuffix}`;
        } else {
          docTitle = `Legal Print Packet (${pdfsCount || sectionCount} ${pdfsCount === 1 ? 'Case' : 'Cases'}) — ${titleSuffix}`;
        }
      }

      const fullHtml = buildPrintDocumentHTML(sectionsHtml, caseRegistry, {
        title: docTitle,
        subtitle,
        fallbackPath,
        orientation: state.prefs.orientation,
        paperSize: state.prefs.paperSize,
        layout: state.prefs.layout,
        columns: state.prefs.columns,
        includeToc: Boolean(state.prefs.includeToc),
        tocEntries: tocCollector,
        includeFolderDocs: Boolean(state.prefs.includeFolderDocs),
        includeDigest: Boolean(state.prefs.includeDigest),
        includeNotes: Boolean(state.prefs.includeNotes),
        tablesOnly: Boolean(state.prefs.tablesOnly),
        marginPreset: state.prefs.marginPreset,
        runningHeaders: state.prefs.runningHeaders !== false,
        previewZoom: state.prefs.previewZoom,
        embeddedPreview: true,
        autoPrint: false,
      });

      hideEmptyBanner();
      state.lastHtmlHasBody = true;

      if (elPreviewFrame?.contentWindow) {
        let prevScrollTop = 0;
        try {
          prevScrollTop = elPreviewFrame.contentWindow.scrollY || elPreviewFrame.contentWindow.document?.documentElement?.scrollTop || 0;
        } catch {}

        const doc = elPreviewFrame.contentWindow.document;
        doc.open();
        doc.write(fullHtml);
        doc.close();

        if (prevScrollTop > 0) {
          requestAnimationFrame(() => {
            try { elPreviewFrame.contentWindow.scrollTo(0, prevScrollTop); } catch {}
          });
        }
      }
    } finally {
      if (myToken === state.renderToken && elLoadingBar) {
        elLoadingBar.style.display = 'none';
      }
    }
  }

  function schedulePreview(delay = 120) {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(() => {
      renderPreview().catch(err => console.warn('[PrintStudio] renderPreview error:', err));
    }, delay);
  }

  function syncLiveFolderNotesFromLocal() {
    for (const f of S.folders) {
      const localVal = safeStorageGet('local_folder_notes_' + f.id, null);
      if (localVal !== null) {
        f.notes = localVal;
      }
    }
  }

  async function refreshAll({ quiet = false } = {}) {
    state.notesCache.clear();
    state.folderNotesCache.clear();
    try {
      const snapStr = safeStorageGet('local_lib_snapshot', null);
      if (snapStr) applyLibrarySnapshot(JSON.parse(snapStr));
    } catch {}
    syncLiveFolderNotesFromLocal();
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      try {
        const dbMod = await import('./db.js');
        if (typeof dbMod.dbLoadLibrary === 'function') await dbMod.dbLoadLibrary();
        else if (typeof dbMod.dbLoad === 'function') await dbMod.dbLoad(1);
        syncLiveFolderNotesFromLocal();
      } catch {}
    }
    renderTree();
    renderQueueList();
    await renderPreview();
    if (!quiet) toast('🔄 Notes & Case Digests refreshed.');
  }

  function printPreviewFrame() {
    if (!state.lastHtmlHasBody || !elPreviewFrame?.contentWindow) {
      toast('Nothing to print yet — select folders or cases with notes/digests.');
      return;
    }
    try {
      elPreviewFrame.contentWindow.focus();
      elPreviewFrame.contentWindow.print();
    } catch (err) {
      console.warn('[PrintStudio] iframe print failed, trying window.print:', err);
      window.print();
    }
  }

  async function handleClose() {
    if (isOverlay && typeof onClose === 'function') {
      onClose();
      return;
    }
    if (typeof window !== 'undefined' && window.__DESKTOP_PRINT_STUDIO__?.closeWindow) {
      try {
        await window.__DESKTOP_PRINT_STUDIO__.closeWindow();
        return;
      } catch (err) {
        console.warn('[PrintStudio] closeWindow failed:', err);
      }
    }
    window.close();
    setTimeout(() => {
      if (!window.closed) {
        toast('You can now close this browser tab.');
      }
    }, 150);
  }

  // ── Event Bindings ──
  elBtnToggleSidebar?.addEventListener('click', () => {
    state.sidebarOpen = !state.sidebarOpen;
    elLeftPane?.classList.toggle('collapsed', !state.sidebarOpen);
    elBtnToggleSidebar.classList.toggle('active', state.sidebarOpen);
    elBtnToggleSidebar.setAttribute('aria-expanded', String(state.sidebarOpen));
  });

  elSearch?.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.searchQuery = elSearch.value || '';
      renderTree();
    }, 120);
  });

  rootEl.querySelector('#ps-btn-select-all')?.addEventListener('click', () => {
    const q = (state.searchQuery || '').trim().toLowerCase();
    if (!q) {
      state.excludedFolderIds.clear();
      state.excludedPdfIds.clear();
      const rootFolders = S.folders
        .filter(f => !f.parent_folder_id)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      const folderSet = new Set(S.folders.map(f => f.id));
      const unfiled = S.pdfs.filter(p => !p.folder_id || !folderSet.has(p.folder_id));
      state.queueItems = [
        ...rootFolders.map(f => ({ kind: 'folder', id: f.id })),
        ...unfiled.map(p => ({ kind: 'pdf', id: p.id })),
      ];
    } else {
      const matchingPdfs = S.pdfs.filter(p => (p.name || '').toLowerCase().includes(q));
      const matchingFolders = S.folders.filter(f => (f.name || '').toLowerCase().includes(q));
      matchingFolders.forEach(f => toggleFolderSelection(f.id, true));
      matchingPdfs.forEach(p => togglePdfSelection(p.id, true));
    }
    renderTree();
    renderQueueList();
    schedulePreview(40);
  });

  rootEl.querySelector('#ps-btn-clear-all')?.addEventListener('click', () => {
    state.queueItems = [];
    state.excludedFolderIds.clear();
    state.excludedPdfIds.clear();
    renderTree();
    renderQueueList();
    schedulePreview(40);
  });

  rootEl.querySelector('#ps-btn-refresh')?.addEventListener('click', () => {
    refreshAll({ quiet: false });
  });

  btnPrint?.addEventListener('click', printPreviewFrame);
  rootEl.querySelector('#ps-btn-close')?.addEventListener('click', handleClose);

  elEmptyResetBtn?.addEventListener('click', () => {
    state.prefs.includeDigest = true;
    state.prefs.includeNotes = true;
    state.prefs.includeFolderDocs = true;
    state.prefs.tablesOnly = false;
    savePrefs(state.prefs);
    syncInspectorControls();
    schedulePreview(20);
  });

  const bindToggle = (el, key) => {
    el?.addEventListener('change', () => {
      state.prefs[key] = Boolean(el.checked);
      savePrefs(state.prefs);
      schedulePreview(60);
    });
  };
  bindToggle(chkDigest, 'includeDigest');
  bindToggle(chkNotes, 'includeNotes');
  bindToggle(chkFolderDocs, 'includeFolderDocs');
  bindToggle(chkTablesOnly, 'tablesOnly');
  bindToggle(chkToc, 'includeToc');
  bindToggle(chkRunningHeaders, 'runningHeaders');

  rootEl.querySelectorAll('[data-ps-col]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.prefs.columns = Number(btn.dataset.psCol) === 2 ? 2 : 1;
      savePrefs(state.prefs);
      syncInspectorControls();
      schedulePreview(40);
    });
  });

  rootEl.querySelectorAll('[data-ps-layout]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.psLayout;
      state.prefs.layout = ['tight', 'compact', 'standard'].includes(val) ? val : 'tight';
      savePrefs(state.prefs);
      syncInspectorControls();
      schedulePreview(40);
    });
  });

  rootEl.querySelectorAll('[data-ps-paper]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.psPaper;
      state.prefs.paperSize = ['letter', 'a4', 'legal'].includes(val) ? val : 'a4';
      savePrefs(state.prefs);
      syncInspectorControls();
      schedulePreview(40);
    });
  });

  rootEl.querySelectorAll('[data-ps-orient]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.prefs.orientation = btn.dataset.psOrient === 'landscape' ? 'landscape' : 'portrait';
      savePrefs(state.prefs);
      syncInspectorControls();
      schedulePreview(40);
    });
  });

  rootEl.querySelectorAll('[data-ps-margin]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.psMargin;
      state.prefs.marginPreset = ['narrow', 'normal', 'wide'].includes(val) ? val : 'narrow';
      savePrefs(state.prefs);
      syncInspectorControls();
      schedulePreview(40);
    });
  });

  rootEl.querySelector('#ps-btn-default-preset')?.addEventListener('click', (e) => {
    if (e.shiftKey) {
      try {
        safeStorageSet(DEFAULT_PRESET_STORAGE_KEY, JSON.stringify(state.prefs));
      } catch {}
      savePrefs(state.prefs);
      toast('Saved current print setup as Default.');
    } else {
      state.prefs = { ...loadDefaultPreset(), previewZoom: state.prefs.previewZoom };
      savePrefs(state.prefs);
      syncInspectorControls();
      schedulePreview(20);
      toast('Reset to Default print setup.');
    }
  });

  rootEl.querySelectorAll('[data-ps-zoom]').forEach(btn => {
    btn.addEventListener('click', () => {
      const z = Number(btn.dataset.psZoom);
      state.prefs.previewZoom = [0.75, 1, 1.25].includes(z) ? z : 1;
      savePrefs(state.prefs);
      syncInspectorControls();
      applyZoomInPlace();
    });
  });

  const onWindowMessage = (e) => {
    if (state.destroyed) return;
    if (e.data?.type === 'ps-pagination-done') {
      state.lastPageCount = Number(e.data.pageCount) || 1;
      if (elPreviewBarBadge) {
        elPreviewBarBadge.textContent = `${state.lastPageCount} ${state.lastPageCount === 1 ? 'page' : 'pages'} • ${getPaperOrientLabel()}`;
      }
    }
  };
  window.addEventListener('message', onWindowMessage);

  const onKeyDown = (e) => {
    if (state.destroyed) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      e.stopPropagation();
      printPreviewFrame();
    } else if (e.key === 'Escape' && isOverlay) {
      e.preventDefault();
      handleClose();
    }
  };
  document.addEventListener('keydown', onKeyDown, true);

  // Initial render
  syncLiveFolderNotesFromLocal();
  syncInspectorControls();
  renderTree();
  renderQueueList();
  renderPreview().catch(err => console.warn('[PrintStudio] initial preview error:', err));

  return {
    isOverlay,
    renderTree,
    syncLiveFolderNotesFromLocal,
    refreshAll,
    invalidatePdfCache(pdfId) {
      if (pdfId) state.notesCache.delete(pdfId);
      else state.notesCache.clear();
    },
    schedulePreview() {
      schedulePreview(120);
    },
    async receiveJob(newJobId) {
      const newJob = await loadPrintJobPayload(newJobId);
      if (!newJob) return;
      state.notesCache.clear();
      state.folderNotesCache.clear();
      applyLibrarySnapshot(newJob.librarySnapshot);
      syncLiveFolderNotesFromLocal();
      state.jobTitle = newJob.title || 'Legal Print Studio';
      state.excludedFolderIds.clear();
      state.excludedPdfIds.clear();
      state.queueItems = buildQueueFromJobOrMode(newJob, {});
      state.collapsedSubjects = new Set((S.subjects || []).map(s => s.id));
      state.collapsedFolders = new Set([
        ...(S.folders || []).map(f => f.id),
        '__other_folders__',
        '__unfiled__',
      ]);
      expandAncestorsForQueue(state.queueItems);
      state.sidebarOpen = state.queueItems.length === 0;
      elLeftPane?.classList.toggle('collapsed', !state.sidebarOpen);
      elBtnToggleSidebar?.setAttribute('aria-expanded', String(state.sidebarOpen));
      if (newJob.defaultMode === 'tables-only') state.prefs.tablesOnly = true;
      else if (newJob.defaultMode === 'all') state.prefs.tablesOnly = false;
      if (newJob.orientation === 'landscape' || newJob.orientation === 'portrait') {
        state.prefs.orientation = newJob.orientation;
      }
      savePrefs(state.prefs);
      syncInspectorControls();
      renderTree();
      renderQueueList();
      await renderPreview();
    },
    destroy() {
      state.destroyed = true;
      clearTimeout(state.previewTimer);
      clearTimeout(state.searchTimer);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('message', onWindowMessage);
    },
  };
}
