// ═══════════════════════════════════════════════
// OFFLINE STUDY MANAGER
// Pre-downloads all notes/digests/highlights across the library AND allows
// pinning specific folders (all their case PDFs + notes) for 100% offline study
// without Wi-Fi, plus one-click cleanup when finished reviewing.
// ═══════════════════════════════════════════════

import { S } from './state.js';
import { db, dbLoad } from './db.js';
import { driveFetchPDF } from './drive.js';
import { isPDFCached, deleteCachedPDF } from './pdfcache.js';
import {
  safeStorageGet,
  safeStorageSet,
  safeStorageRemove,
  setStorageMirrorHook,
} from './storage.js';
import { toast, syncSpin, syncOK } from './ui.js';

const OFFLINE_DB_NAME = 'LegalAnnotatorOfflineDB';
const OFFLINE_DB_VERSION = 1;
const RECORDS_STORE = 'offline_records';

const ALL_NOTES_META_KEY = 'offline_all_notes_meta';
const OFFLINE_FOLDERS_KEY = 'offline_folders_map';

let _offlineDbPromise = null;

function getOfflineDB() {
  if (_offlineDbPromise) return _offlineDbPromise;
  _offlineDbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
      req.onupgradeneeded = (e) => {
        const idb = e.target.result;
        if (!idb.objectStoreNames.contains(RECORDS_STORE)) {
          idb.createObjectStore(RECORDS_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return _offlineDbPromise;
}

// ── Read a single PDF's offline record from IndexedDB ──
export async function getOfflineRecord(pdfId) {
  if (!pdfId) return null;
  try {
    const idb = await getOfflineDB();
    if (!idb) return null;
    return await new Promise((resolve) => {
      const tx = idb.transaction(RECORDS_STORE, 'readonly');
      const store = tx.objectStore(RECORDS_STORE);
      const req = store.get(String(pdfId));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

// ── Save or merge a single PDF's offline record in IndexedDB ──
export async function putOfflineRecord(pdfId, partial) {
  if (!pdfId || !partial) return;
  try {
    const idb = await getOfflineDB();
    if (!idb) return;
    const existing = (await getOfflineRecord(pdfId)) || { id: String(pdfId) };
    const merged = {
      ...existing,
      ...partial,
      id: String(pdfId),
      updated_at: Date.now(),
    };
    await new Promise((resolve) => {
      const tx = idb.transaction(RECORDS_STORE, 'readwrite');
      const store = tx.objectStore(RECORDS_STORE);
      store.put(merged);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {}
}

export async function deleteOfflineRecord(pdfId) {
  if (!pdfId) return;
  try {
    const idb = await getOfflineDB();
    if (!idb) return;
    await new Promise((resolve) => {
      const tx = idb.transaction(RECORDS_STORE, 'readwrite');
      tx.objectStore(RECORDS_STORE).delete(String(pdfId));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {}
}

// ── Keep IndexedDB offline records automatically in sync with local edits ──
let _mirrorInitialized = false;
export function initOfflineMirror() {
  if (_mirrorInitialized) return;
  _mirrorInitialized = true;
  setStorageMirrorHook((key, value) => {
    if (!key || typeof key !== 'string') return;
    if (key.startsWith('local_notepad_') && !key.startsWith('local_notepad_write_ts_') && !key.startsWith('local_notepad_sync_ts_')) {
      const pdfId = key.slice('local_notepad_'.length);
      if (pdfId) putOfflineRecord(pdfId, { content: value ?? '' });
    } else if (key.startsWith('local_digest_') && key !== 'local_digest_map') {
      const pdfId = key.slice('local_digest_'.length);
      if (pdfId) putOfflineRecord(pdfId, { digest: value ?? '' });
    } else if (key.startsWith('local_anns_')) {
      const pdfId = key.slice('local_anns_'.length);
      if (pdfId) {
        try { putOfflineRecord(pdfId, { annotations: JSON.parse(value || '[]') }); } catch {}
      }
    } else if (key.startsWith('local_bms_')) {
      const pdfId = key.slice('local_bms_'.length);
      if (pdfId) {
        try { putOfflineRecord(pdfId, { bookmarks: JSON.parse(value || '[]') }); } catch {}
      }
    } else if (key.startsWith('local_draws_')) {
      const pdfId = key.slice('local_draws_'.length);
      if (pdfId) {
        try { putOfflineRecord(pdfId, { drawings: JSON.parse(value || '{}') }); } catch {}
      }
    }
  });
}

// Self-initialize mirror hook on import
initOfflineMirror();

// ── Metadata helpers for Settings & Sidebar badges ──
export function getAllNotesOfflineMeta() {
  try {
    const raw = safeStorageGet(ALL_NOTES_META_KEY, '');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getOfflineFoldersMap() {
  try {
    const raw = safeStorageGet(OFFLINE_FOLDERS_KEY, '{}');
    return JSON.parse(raw || '{}') || {};
  } catch {
    return {};
  }
}

function saveOfflineFoldersMap(map) {
  safeStorageSet(OFFLINE_FOLDERS_KEY, JSON.stringify(map || {}));
}

export function isFolderOfflineReady(folderId) {
  if (!folderId) return false;
  const map = getOfflineFoldersMap();
  return Boolean(map[folderId]);
}

function _hasUnsyncedLocalNotepad(pdfId) {
  const writeTs = parseInt(safeStorageGet('local_notepad_write_ts_' + pdfId, '0') || '0', 10);
  const syncTs = parseInt(safeStorageGet('local_notepad_sync_ts_' + pdfId, '0') || '0', 10);
  return writeTs > 0 && writeTs > syncTs;
}

function _hasMeaningfulDigest(html) {
  if (!html || typeof html !== 'string') return false;
  const stripped = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
  return stripped.length > 0 || /<img\b|<table\b/i.test(html);
}

// ── Collect all folders & PDFs in a folder (or multi-folder) subtree ──
export function collectFolderSubtree(foldersOrFolder) {
  const roots = (Array.isArray(foldersOrFolder) ? foldersOrFolder : [foldersOrFolder]).filter(Boolean);
  const folderIds = new Set();
  const folderList = [];

  function walk(f) {
    if (!f || folderIds.has(f.id)) return;
    folderIds.add(f.id);
    folderList.push(f);
    const children = (S.folders || [])
      .filter(ch => ch.parent_folder_id === f.id)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    for (const ch of children) walk(ch);
  }

  for (const r of roots) {
    const fObj = typeof r === 'string' ? (S.folders || []).find(x => x.id === r) : r;
    if (fObj) walk(fObj);
  }

  const seenPdfIds = new Set();
  const pdfList = [];
  for (const p of (S.pdfs || [])) {
    if (folderIds.has(p.folder_id) && !seenPdfIds.has(p.id)) {
      seenPdfIds.add(p.id);
      pdfList.push(p);
    }
  }

  return { folders: folderList, folderIds: [...folderIds], pdfs: pdfList };
}

// ── Internal batch downloader for a set of PDF IDs (or all PDFs when targetPdfIds is null) ──
async function _downloadNotesBatch(targetPdfIds = null, onProgress = null) {
  // 1. Refresh library structure if online
  await dbLoad(1).catch(() => {});

  const allPdfs = S.pdfs || [];
  const pdfSubset = targetPdfIds
    ? allPdfs.filter(p => targetPdfIds.has(p.id) || (p.linked_pdf_id && targetPdfIds.has(p.linked_pdf_id)))
    : allPdfs;

  // Include both pdf.id and pdf.linked_pdf_id so alias lookups always hit
  const queryIdsSet = new Set();
  for (const p of pdfSubset) {
    if (p.id) queryIdsSet.add(p.id);
    if (p.linked_pdf_id) queryIdsSet.add(p.linked_pdf_id);
  }
  const queryIds = [...queryIdsSet];

  if (onProgress) onProgress('Downloading case notes & digests…');

  // Save folder notes into local storage
  for (const fold of (S.folders || [])) {
    if (fold.notes) {
      safeStorageSet('local_folder_notes_' + fold.id, fold.notes);
    }
  }

  // Helper to fetch in chunks if filtering by IDs, or full table if downloading all
  const CHUNK = 150;
  async function fetchRows(table, col, selectCols = '*') {
    if (!targetPdfIds) {
      const { data, error } = await db.from(table).select(selectCols);
      if (error) throw error;
      return data || [];
    }
    const out = [];
    for (let i = 0; i < queryIds.length; i += CHUNK) {
      const slice = queryIds.slice(i, i + CHUNK);
      const { data, error } = await db.from(table).select(selectCols).in(col, slice);
      if (error) throw error;
      if (data) out.push(...data);
    }
    return out;
  }

  // 2. Fetch pdf_notes (with fallback if digest column doesn't exist)
  let notesRows = [];
  try {
    notesRows = await fetchRows('pdf_notes', 'pdf_id', 'pdf_id, content, digest');
  } catch {
    notesRows = await fetchRows('pdf_notes', 'pdf_id', 'pdf_id, content').catch(() => []);
  }

  if (onProgress) onProgress('Downloading highlights & annotation notes…');
  const annRows = await fetchRows('annotations', 'pdf_file_id', '*').catch(() => []);
  const annIds = annRows.map(a => a.id).filter(Boolean);
  let annNoteRows = [];
  if (annIds.length) {
    if (!targetPdfIds) {
      const { data } = await db.from('annotation_notes').select('*').order('order_index');
      annNoteRows = data || [];
    } else {
      for (let i = 0; i < annIds.length; i += CHUNK) {
        const slice = annIds.slice(i, i + CHUNK);
        const { data } = await db.from('annotation_notes').select('*').in('annotation_id', slice).order('order_index');
        if (data) annNoteRows.push(...data);
      }
    }
  }

  if (onProgress) onProgress('Downloading bookmarks & drawings…');
  const bmRows = await fetchRows('pdf_bookmarks', 'pdf_file_id', '*').catch(() => []);
  const drawRows = await fetchRows('drawings', 'pdf_file_id', '*').catch(() => []);

  // Group by pdfId
  const notesByPdf = new Map();
  for (const r of notesRows) {
    if (r?.pdf_id) notesByPdf.set(r.pdf_id, { content: r.content || '', digest: r.digest || '' });
  }

  const notesByAnnId = new Map();
  for (const n of annNoteRows) {
    if (!n?.annotation_id) continue;
    if (!notesByAnnId.has(n.annotation_id)) notesByAnnId.set(n.annotation_id, []);
    notesByAnnId.get(n.annotation_id).push(n);
  }

  const annsByPdf = new Map();
  for (const a of annRows) {
    if (!a?.pdf_file_id) continue;
    if (!annsByPdf.has(a.pdf_file_id)) annsByPdf.set(a.pdf_file_id, []);
    annsByPdf.get(a.pdf_file_id).push({
      ...a,
      notes: notesByAnnId.get(a.id) || [],
    });
  }

  const bmsByPdf = new Map();
  for (const b of bmRows) {
    if (!b?.pdf_file_id) continue;
    if (!bmsByPdf.has(b.pdf_file_id)) bmsByPdf.set(b.pdf_file_id, []);
    bmsByPdf.get(b.pdf_file_id).push(b);
  }
  for (const arr of bmsByPdf.values()) {
    arr.sort((a, b) => (a.page || 0) - (b.page || 0));
  }

  const drawsByPdf = new Map();
  for (const d of drawRows) {
    if (!d?.pdf_file_id) continue;
    if (!drawsByPdf.has(d.pdf_file_id)) drawsByPdf.set(d.pdf_file_id, {});
    drawsByPdf.get(d.pdf_file_id)[d.page] = d.strokes || [];
  }

  // Write all records into IndexedDB in a single transaction
  const idb = await getOfflineDB();
  const allTargetIds = new Set([
    ...queryIds,
    ...notesByPdf.keys(),
    ...annsByPdf.keys(),
    ...bmsByPdf.keys(),
    ...drawsByPdf.keys(),
  ]);

  const recordsToWrite = [];
  if (!S.annCounts) S.annCounts = {};
  if (!S.digestMap) S.digestMap = {};

  for (const pid of allTargetIds) {
    if (!pid) continue;
    const hasUnsynced = _hasUnsyncedLocalNotepad(pid);
    const localC = safeStorageGet('local_notepad_' + pid, '');
    const localD = safeStorageGet('local_digest_' + pid, '');
    const cloudND = notesByPdf.get(pid);

    const finalContent = hasUnsynced
      ? (localC || cloudND?.content || '')
      : (cloudND?.content ?? localC ?? '');
    const finalDigest = hasUnsynced
      ? (localD || cloudND?.digest || '')
      : (cloudND?.digest ?? localD ?? '');
    const finalAnns = annsByPdf.get(pid) || [];
    const finalBms = bmsByPdf.get(pid) || [];
    const finalDraws = drawsByPdf.get(pid) || {};

    recordsToWrite.push({
      id: String(pid),
      content: finalContent,
      digest: finalDigest,
      annotations: finalAnns,
      bookmarks: finalBms,
      drawings: finalDraws,
      updated_at: Date.now(),
    });

    // Also prime localStorage for instant 0ms synchronous access when space permits
    if (finalContent) safeStorageSet('local_notepad_' + pid, finalContent);
    if (finalDigest) safeStorageSet('local_digest_' + pid, finalDigest);
    if (finalAnns.length) safeStorageSet('local_anns_' + pid, JSON.stringify(finalAnns));
    if (finalBms.length) safeStorageSet('local_bms_' + pid, JSON.stringify(finalBms));

    if (finalAnns.length) S.annCounts[pid] = finalAnns.length;
    if (_hasMeaningfulDigest(finalDigest)) S.digestMap[pid] = true;
  }

  // Also mirror records under alias pdf.id when linked_pdf_id is used
  for (const p of pdfSubset) {
    if (p.linked_pdf_id && p.linked_pdf_id !== p.id) {
      const masterRec = recordsToWrite.find(r => r.id === String(p.linked_pdf_id));
      if (masterRec) {
        recordsToWrite.push({ ...masterRec, id: String(p.id) });
        if (_hasMeaningfulDigest(masterRec.digest)) S.digestMap[p.id] = true;
      }
    }
  }

  if (idb && recordsToWrite.length) {
    await new Promise((resolve) => {
      const tx = idb.transaction(RECORDS_STORE, 'readwrite');
      const store = tx.objectStore(RECORDS_STORE);
      for (const rec of recordsToWrite) {
        store.put(rec);
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  safeStorageSet('local_ann_counts', JSON.stringify(S.annCounts));
  safeStorageSet('local_digest_map', JSON.stringify(S.digestMap));

  return {
    pdfCount: pdfSubset.length,
    recordCount: recordsToWrite.length,
    folderCount: (S.folders || []).length,
  };
}

// ── Public Action 1: Pre-download ALL Notes, Digests, Highlights & Bookmarks for Offline Review ──
export async function downloadAllNotesOffline(onProgress = null) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    toast('📴 You are offline — connect to Wi-Fi first to download your notes for offline study.');
    return null;
  }

  syncSpin('Downloading all notes for offline study…');
  toast('📥 Downloading all notes, digests & highlights for offline study…');

  try {
    const res = await _downloadNotesBatch(null, onProgress);
    const meta = {
      savedAt: Date.now(),
      pdfCount: res.pdfCount,
      folderCount: res.folderCount,
    };
    safeStorageSet(ALL_NOTES_META_KEY, JSON.stringify(meta));
    syncOK('All Notes Ready Offline');
    toast(`✅ All notes & digests (${res.pdfCount} cases) are now saved for offline review!`);
    import('./library.js').then(m => m.renderLibrary?.()).catch(() => {});
    return meta;
  } catch (err) {
    console.error('[Offline] downloadAllNotesOffline failed:', err);
    toast('❌ Could not download all notes: ' + (err?.message || 'Network error'));
    return null;
  }
}

// ── Public Action 2: Remove Offline Notes Cache ──
export async function removeAllNotesOffline() {
  try {
    const idb = await getOfflineDB();
    if (idb) {
      await new Promise((resolve) => {
        const tx = idb.transaction(RECORDS_STORE, 'readwrite');
        tx.objectStore(RECORDS_STORE).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    }
    safeStorageRemove(ALL_NOTES_META_KEY);
    toast('🗑 Offline notes cache cleared.');
  } catch (err) {
    console.warn('[Offline] removeAllNotesOffline failed:', err);
  }
}

// ── Public Action 3: Make a Folder (and its Subfolders) Available Offline (Cases + Notes) ──
export async function makeFolderAvailableOffline(foldersOrFolder, onProgress = null) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    toast('📴 You are offline — connect to Wi-Fi first to download this folder for offline study.');
    return null;
  }

  const { folders, pdfs } = collectFolderSubtree(foldersOrFolder);
  if (!folders.length) return null;

  const label = folders.length === 1 ? `"${folders[0].name}"` : `${folders.length} folders`;
  toast(`📥 Preparing ${label} (${pdfs.length} case${pdfs.length === 1 ? '' : 's'}) for offline review…`);
  syncSpin(`Caching ${label}…`);

  // 1. Download all notes/digests/highlights for the PDFs in this folder subtree
  const targetPdfIds = new Set(pdfs.map(p => p.id));
  try {
    await _downloadNotesBatch(targetPdfIds, onProgress);
  } catch (err) {
    console.warn('[Offline] Notes batch download warning:', err);
  }

  // 2. Download each case PDF in the folder subtree into the local PDF cache
  let downloaded = 0;
  let alreadyCached = 0;
  let failed = 0;
  const cachedDriveIds = [];

  for (let i = 0; i < pdfs.length; i++) {
    const pdf = pdfs[i];
    const driveId = pdf.drive_file_id || (pdf.linked_pdf_id ? (S.pdfs || []).find(p => p.id === pdf.linked_pdf_id)?.drive_file_id : null);
    if (!driveId) continue;

    const stepMsg = `(${i + 1}/${pdfs.length}) ${pdf.name}`;
    if (onProgress) onProgress(`Downloading PDF ${stepMsg}`);
    syncSpin(`Offline ${i + 1}/${pdfs.length}: ${pdf.name.slice(0, 24)}…`);

    try {
      const exists = await isPDFCached(driveId);
      if (exists) {
        alreadyCached++;
        cachedDriveIds.push(driveId);
        continue;
      }
      await driveFetchPDF(driveId, (pct) => {
        if (pct !== null && onProgress) {
          onProgress(`Downloading ${stepMsg} — ${pct}%`);
        }
      }, pdf.name);
      downloaded++;
      cachedDriveIds.push(driveId);
    } catch (err) {
      console.warn(`[Offline] Failed to cache PDF "${pdf.name}":`, err);
      failed++;
    }
  }

  // 3. Record all folders in the subtree as offline-ready
  const map = getOfflineFoldersMap();
  const now = Date.now();
  for (const f of folders) {
    const fSub = collectFolderSubtree(f);
    const fDriveIds = fSub.pdfs
      .map(p => p.drive_file_id || (p.linked_pdf_id ? (S.pdfs || []).find(x => x.id === p.linked_pdf_id)?.drive_file_id : null))
      .filter(Boolean);
    map[f.id] = {
      folderId: f.id,
      name: f.name,
      savedAt: now,
      pdfCount: fSub.pdfs.length,
      driveIds: [...new Set(fDriveIds)],
    };
  }
  saveOfflineFoldersMap(map);

  syncOK('Folder Ready Offline');
  import('./library.js').then(m => m.renderLibrary?.()).catch(() => {});

  if (failed > 0) {
    toast(`⚠️ ${label}: ${downloaded + alreadyCached}/${pdfs.length} cases ready offline (${failed} failed — check Drive sign-in).`);
  } else {
    toast(`✅ ${label} is now ready for offline study (${pdfs.length} case${pdfs.length === 1 ? '' : 's'} + all notes)!`);
  }

  return {
    folderCount: folders.length,
    pdfCount: pdfs.length,
    downloaded,
    alreadyCached,
    failed,
  };
}

// ── Public Action 4: Remove a Folder's Offline Cache (Delete Downloaded PDFs & Free Space) ──
export async function removeFolderOfflineCache(foldersOrFolder) {
  const { folders, folderIds, pdfs } = collectFolderSubtree(foldersOrFolder);
  if (!folders.length) return { removedPdfs: 0 };

  const folderIdSet = new Set(folderIds);
  const map = getOfflineFoldersMap();
  for (const fid of folderIds) {
    delete map[fid];
  }
  saveOfflineFoldersMap(map);

  // Any drive_file_id still pinned by a remaining offline folder should be kept
  const stillPinnedDriveIds = new Set();
  for (const entry of Object.values(map)) {
    for (const did of (entry?.driveIds || [])) {
      stillPinnedDriveIds.add(did);
    }
  }

  const allNotesPinned = Boolean(getAllNotesOfflineMeta());
  let removedPdfs = 0;

  for (const pdf of pdfs) {
    const driveId = pdf.drive_file_id || (pdf.linked_pdf_id ? (S.pdfs || []).find(p => p.id === pdf.linked_pdf_id)?.drive_file_id : null);
    if (driveId && !stillPinnedDriveIds.has(driveId)) {
      if (S.pdfCache) delete S.pdfCache[driveId];
      await deleteCachedPDF(driveId);
      removedPdfs++;
    }
    if (!allNotesPinned) {
      const trueId = pdf.linked_pdf_id || pdf.id;
      await deleteOfflineRecord(pdf.id);
      if (trueId !== pdf.id) await deleteOfflineRecord(trueId);
    }
  }

  const label = folders.length === 1 ? `"${folders[0].name}"` : `${folders.length} folders`;
  toast(`🗑 Removed offline cache for ${label} (${removedPdfs} cached PDF${removedPdfs === 1 ? '' : 's'} deleted).`);
  import('./library.js').then(m => m.renderLibrary?.()).catch(() => {});

  return { removedPdfs, removedFolders: folderIdSet.size };
}
