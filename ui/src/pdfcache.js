// ═══════════════════════════════════════════════
// PDF CACHE — Persistent IndexedDB & Custom Folder Storage
// Supports both Browser Sandboxed IndexedDB and Custom PC Folders (File System Access API)
// ═══════════════════════════════════════════════

import { safeStorageSet, safeStorageGet, safeStorageRemove } from './storage.js';

const DB_NAME = 'LegalAnnotatorCache';
const DB_VERSION = 3;
const STORE_NAME = 'pdf_blobs';
const CONFIG_STORE = 'fs_config';
const HISTORY_STORE = 'notepad_history';

let _dbPromise = null;

function getDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      return resolve(null);
    }
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      if (!val) _dbPromise = null;
      resolve(val);
    };
    const timer = setTimeout(() => {
      console.warn('[PDFCache] IndexedDB open timed out after 2500ms; continuing with fallback');
      done(null);
    }, 2500);
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(CONFIG_STORE)) {
          db.createObjectStore(CONFIG_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(HISTORY_STORE)) {
          db.createObjectStore(HISTORY_STORE, { keyPath: 'pdf_id' });
        }
      };
      request.onsuccess = (e) => {
        clearTimeout(timer);
        done(e.target.result);
      };
      request.onerror = (e) => {
        clearTimeout(timer);
        console.warn('[PDFCache] IndexedDB open error', e);
        done(null);
      };
      request.onblocked = () => {
        clearTimeout(timer);
        console.warn('[PDFCache] IndexedDB open blocked');
        done(null);
      };
    } catch (err) {
      clearTimeout(timer);
      done(null);
    }
  });
  return _dbPromise;
}

// ── Timeout & IndexedDB Transaction Helpers ──
async function _withTimeout(promise, ms, fallbackValue) {
  let timer = null;
  const safePromise = Promise.resolve(promise).catch(() => fallbackValue);
  try {
    return await Promise.race([
      safePromise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function _runIdbRequest(db, storeName, mode, runReq, timeoutMs = 2500, fallbackValue = null) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(val);
    };
    timer = setTimeout(() => done(fallbackValue), timeoutMs);
    try {
      const tx = db.transaction(storeName, mode);
      tx.onabort = () => done(fallbackValue);
      tx.onerror = () => done(fallbackValue);
      const store = tx.objectStore(storeName);
      const req = runReq(store);
      req.onsuccess = () => done(req.result);
      req.onerror = () => done(fallbackValue);
    } catch {
      done(fallbackValue);
    }
  });
}

function _idbGetWithTimeout(db, storeName, key, timeoutMs = 2500) {
  return _runIdbRequest(db, storeName, 'readonly', (store) => store.get(key), timeoutMs, null);
}

function _runIdbWrite(db, storeName, runReq, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (ok = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    timer = setTimeout(() => {
      console.warn(`[PDFCache] IndexedDB write on "${storeName}" timed out; continuing`);
      done(false);
    }, timeoutMs);
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.oncomplete = () => done(true);
      tx.onabort = () => done(false);
      tx.onerror = (e) => {
        console.warn(`[PDFCache] IndexedDB write error on "${storeName}"`, tx.error || e);
        done(false);
      };
      const store = tx.objectStore(storeName);
      const req = runReq(store);
      if (req) req.onerror = () => done(false);
    } catch {
      done(false);
    }
  });
}

// ── Notepad History in IndexedDB (virtually unlimited quota) ──
export async function getNotepadHistoryIDB(pdfId) {
  try {
    const db = await getDB();
    if (!db || !db.objectStoreNames.contains(HISTORY_STORE)) return null;
    const res = await _idbGetWithTimeout(db, HISTORY_STORE, pdfId, 2500);
    return res ? res.history : null;
  } catch (err) {
    console.warn('[PDFCache] getNotepadHistoryIDB error', err);
    return null;
  }
}

export async function saveNotepadHistoryIDB(pdfId, history) {
  try {
    const db = await getDB();
    if (!db || !db.objectStoreNames.contains(HISTORY_STORE)) return;
    const tx = db.transaction(HISTORY_STORE, 'readwrite');
    const store = tx.objectStore(HISTORY_STORE);
    store.put({ pdf_id: pdfId, history: history, updated_at: Date.now() });
  } catch (err) {
    console.warn('[PDFCache] saveNotepadHistoryIDB error', err);
  }
}

// ── Ask browser to never purge our cache under low disk space ──
export async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persist();
      console.log(`[PDFCache] Persistent storage granted: ${isPersisted}`);
      return isPersisted;
    } catch (e) {
      console.warn('[PDFCache] Error requesting storage persistence:', e);
    }
  }
  return false;
}

// ── Custom Directory Handle Management (File System Access API) ──
async function getStoredDirHandle() {
  try {
    const db = await getDB();
    if (!db || !db.objectStoreNames.contains(CONFIG_STORE)) return null;
    const res = await _idbGetWithTimeout(db, CONFIG_STORE, 'custom_dir_handle', 2500);
    return res ? res.handle : null;
  } catch {
    return null;
  }
}

async function setStoredDirHandle(handle, name) {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(CONFIG_STORE, 'readwrite');
    const store = tx.objectStore(CONFIG_STORE);
    store.put({ key: 'custom_dir_handle', handle, name, saved_at: Date.now() });
  } catch (e) {
    console.warn('[PDFCache] Failed to store custom directory handle:', e);
  }
}

async function clearStoredDirHandle() {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(CONFIG_STORE, 'readwrite');
    const store = tx.objectStore(CONFIG_STORE);
    store.delete('custom_dir_handle');
  } catch (e) {
    console.warn('[PDFCache] Failed to clear custom directory handle:', e);
  }
}

async function verifyPermission(fileHandle, readWrite = false, interactive = false) {
  if (!fileHandle) return false;
  const options = { mode: readWrite ? 'readwrite' : 'read' };
  try {
    const queried = await _withTimeout(fileHandle.queryPermission(options), 1500, 'denied');
    if (queried === 'granted') return true;
    if (!interactive) return false;
    const requested = await _withTimeout(fileHandle.requestPermission(options), 15000, 'denied');
    return requested === 'granted';
  } catch (e) {
    console.warn('[PDFCache] Permission verification failed:', e);
  }
  return false;
}

// ── User-Facing: Pick a Custom Storage Folder on PC ──
export async function chooseCustomDirectory() {
  if (!('showDirectoryPicker' in window)) {
    alert('Custom folder storage is not supported in this browser. Using default browser storage.');
    return null;
  }
  try {
    const handle = await window.showDirectoryPicker({
      id: 'legal_annotator_pdf_vault',
      mode: 'readwrite',
      startIn: 'documents'
    });

    const ok = await verifyPermission(handle, true, true);
    if (!ok) {
      alert('Permission to write to the selected folder was not granted.');
      return null;
    }

    await setStoredDirHandle(handle, handle.name);
    safeStorageSet('custom_cache_dir_name', handle.name);

    // Sync all currently cached PDFs into the new folder
    await exportAllCachedToCustomDir(handle);

    return handle.name;
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('[PDFCache] Directory picker error:', e);
    }
    return null;
  }
}

// ── User-Facing: Reset back to Default Browser Sandbox ──
export async function resetToDefaultStorage() {
  await clearStoredDirHandle();
  safeStorageRemove('custom_cache_dir_name');
}

export function getCustomDirectoryName() {
  return safeStorageGet('custom_cache_dir_name', null);
}

// ── Write binary to custom folder ──
async function writeToCustomDir(dirHandle, fileId, buffer, filename) {
  try {
    const safeBaseName = (filename || fileId).replace(/[/\\?%*:|"<>]/g, '_').trim();
    const finalName = safeBaseName.toLowerCase().endsWith('.pdf') ? safeBaseName : `${safeBaseName}.pdf`;
    
    const fileHandle = await dirHandle.getFileHandle(finalName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(buffer);
    await writable.close();
    console.log(`[PDFCache] Saved "${finalName}" directly to custom folder "${dirHandle.name}"`);
  } catch (e) {
    console.warn('[PDFCache] Could not write to custom directory handle:', e);
  }
}

async function exportAllCachedToCustomDir(dirHandle) {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = async () => {
      const items = req.result || [];
      for (const item of items) {
        const payload = item.blob || item.buffer;
        if (payload) {
          await writeToCustomDir(dirHandle, item.id, payload, item.name);
        }
      }
    };
  } catch (e) {
    console.warn('[PDFCache] Export to custom dir failed:', e);
  }
}

export async function isPDFCached(fileId) {
  if (!fileId) return false;
  try {
    const db = await getDB();
    if (!db || !db.objectStoreNames.contains(STORE_NAME)) return false;
    const count = await _runIdbRequest(db, STORE_NAME, 'readonly', (store) => store.count(fileId), 2500, 0);
    return (count || 0) > 0;
  } catch {
    return false;
  }
}

export async function getCachedPDF(fileId) {
  try {
    const db = await getDB();
    if (!db || !db.objectStoreNames.contains(STORE_NAME)) return null;
    const item = await _idbGetWithTimeout(db, STORE_NAME, fileId, 5000);
    if (!item) return null;
    // Return the Blob directly — caller uses URL.createObjectURL(), no conversion needed
    if (item.blob) return item.blob;
    if (item.buffer) {
      // Legacy ArrayBuffer entries: wrap in Blob for consistency
      return new Blob([item.buffer], { type: 'application/pdf' });
    }
    return null;
  } catch (err) {
    console.warn('[PDFCache] getCachedPDF failed', err);
    return null;
  }
}

export async function setCachedPDF(fileId, data, name = '') {
  try {
    const db = await getDB();
    if (!db || !data) return;

    // Store as native Blob in IndexedDB (zero-copy streaming, avoids V8 clone memory spikes)
    const blob = (data instanceof Blob) ? data : new Blob([data], { type: 'application/pdf' });
    const size = blob.size;

    // 1. Always save in IndexedDB for fast random access (bounded so a stuck tx never hangs)
    await _runIdbWrite(
      db,
      STORE_NAME,
      (store) =>
        store.put({
          id: fileId,
          name: name,
          size: size,
          blob: blob,
          saved_at: Date.now(),
        }),
      4000
    );

    // 2. Also save to Custom PC Folder if configured (non-interactive only so background saves never prompt/hang)
    const dirHandle = await getStoredDirHandle();
    if (dirHandle) {
      const hasPerm = await verifyPermission(dirHandle, true, false);
      if (hasPerm) {
        await _withTimeout(writeToCustomDir(dirHandle, fileId, blob, name), 4000, undefined);
      }
    }
  } catch (err) {
    console.warn('[PDFCache] setCachedPDF failed', err);
  }
}

export async function deleteCachedPDF(fileId) {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(fileId);
  } catch (err) {
    console.warn('[PDFCache] deleteCachedPDF failed', err);
  }
}

// ── Get cache statistics for Settings Modal ──
export async function getCacheStorageStats() {
  try {
    const db = await getDB();
    const customDir = getCustomDirectoryName();
    const isCustomSupported = 'showDirectoryPicker' in window;

    if (!db || !db.objectStoreNames.contains(STORE_NAME)) {
      return { count: 0, totalBytes: 0, formattedSize: '0 MB', customDir, isCustomSupported };
    }
    const result = await _runIdbRequest(db, STORE_NAME, 'readonly', (store) => store.getAll(), 5000, null);
    const items = Array.isArray(result) ? result : [];
    let totalBytes = 0;
    items.forEach(item => {
      totalBytes += item.size || item.blob?.size || item.buffer?.byteLength || 0;
    });
    const mb = (totalBytes / (1024 * 1024)).toFixed(1);
    return {
      count: items.length,
      totalBytes,
      formattedSize: `${mb} MB`,
      customDir,
      isCustomSupported
    };
  } catch (e) {
    console.warn('[PDFCache] getCacheStorageStats failed', e);
    return { count: 0, totalBytes: 0, formattedSize: '0 MB', customDir: null, isCustomSupported: false };
  }
}

// ── Clear all cached PDFs from local disk ──
export async function clearAllCachedPDFs() {
  try {
    const db = await getDB();
    if (!db || !db.objectStoreNames.contains(STORE_NAME)) return;
    await _runIdbWrite(db, STORE_NAME, (store) => store.clear(), 4000);
  } catch (e) {
    console.warn('[PDFCache] clearAllCachedPDFs failed', e);
  }
}

// ── Download and Cache a PDF on demand (e.g. from right-click menu) ──
export async function preCachePDF(pdf) {
  const { driveFetchPDF } = await import('./drive.js');
  const { toast } = await import('./ui.js');

  const driveId = pdf.drive_file_id || (pdf.linked_pdf_id ? (await import('./state.js')).S.pdfs.find(p => p.id === pdf.linked_pdf_id)?.drive_file_id : null);
  if (!driveId) {
    toast('Cannot save: PDF is not linked to Google Drive.');
    return;
  }

  const already = await isPDFCached(driveId);
  if (already) {
    toast(`"${pdf.name}" is already saved for offline study!`);
    return;
  }

  toast(`Downloading "${pdf.name}" for offline use…`);
  try {
    // driveFetchPDF downloads via stream, updates live progress, and saves to IndexedDB once (no duplicate write!)
    await driveFetchPDF(driveId, (pct, loadedMB, totalMB) => {
      if (pct !== null) {
        toast(`Downloading "${pdf.name}": ${pct}% (${loadedMB}/${totalMB} MB)`);
      }
    }, pdf.name);

    toast(`✅ "${pdf.name}" is now ready for offline reading!`);
  } catch (err) {
    console.error('Failed to pre-cache PDF:', err);
    toast('❌ Failed to download PDF for offline use.');
  }
}

// ── Download Folder Handle (separate from the offline cache folder) ──
const DL_FOLDER_KEY = 'download_folder_handle';

export async function getDownloadFolderHandle() {
  try {
    const db = await getDB();
    if (!db || !db.objectStoreNames.contains(CONFIG_STORE)) return null;
    const res = await _idbGetWithTimeout(db, CONFIG_STORE, DL_FOLDER_KEY, 2500);
    return res ? res.handle : null;
  } catch {
    return null;
  }
}

export async function setDownloadFolderHandle(handle) {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(CONFIG_STORE, 'readwrite');
    const store = tx.objectStore(CONFIG_STORE);
    store.put({ key: DL_FOLDER_KEY, handle, name: handle.name, saved_at: Date.now() });
    safeStorageSet('download_folder_name', handle.name);
  } catch (e) {
    console.warn('[PDFCache] Failed to store download folder handle:', e);
  }
}

export async function clearDownloadFolderHandle() {
  try {
    const db = await getDB();
    if (!db) return;
    const tx = db.transaction(CONFIG_STORE, 'readwrite');
    const store = tx.objectStore(CONFIG_STORE);
    store.delete(DL_FOLDER_KEY);
    safeStorageRemove('download_folder_name');
  } catch (e) {
    console.warn('[PDFCache] Failed to clear download folder handle:', e);
  }
}

export function getDownloadFolderName() {
  return safeStorageGet('download_folder_name', null);
}

// ── Pick a new download folder ──
export async function chooseDownloadFolder() {
  if (!('showDirectoryPicker' in window)) {
    return null; // caller should show fallback message
  }
  try {
    const handle = await window.showDirectoryPicker({
      id: 'legal_annotator_download',
      mode: 'readwrite',
      startIn: 'downloads'
    });
    const ok = await verifyPermission(handle, true, true);
    if (!ok) return null;
    await setDownloadFolderHandle(handle);
    return handle.name;
  } catch (e) {
    if (e.name !== 'AbortError') console.error('[PDFCache] Download folder picker error:', e);
    return null;
  }
}

// ── Download a PDF blob to PC (via folder or browser download dialog) ──
export async function downloadPDFToPC(blob, filename) {
  const safeName = (filename || 'document').replace(/[/\\?%*:|"<>]/g, '_').trim();
  const finalName = safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`;

  // Try configured download folder first (File System Access API)
  try {
    const dirHandle = await getDownloadFolderHandle();
    if (dirHandle) {
      const hasPerm = await verifyPermission(dirHandle, true, true);
      if (hasPerm) {
        const fileHandle = await dirHandle.getFileHandle(finalName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return { saved: true, folder: dirHandle.name };
      }
    }
  } catch (e) {
    console.warn('[PDFCache] Could not save to download folder, falling back to dialog:', e);
  }

  // Fallback: browser download dialog
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = finalName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { saved: true, folder: null };
}
