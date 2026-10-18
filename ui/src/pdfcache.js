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
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => {
      console.warn('[PDFCache] IndexedDB open error', e);
      resolve(null);
    };
  });
  return _dbPromise;
}

// ── Notepad History in IndexedDB (virtually unlimited quota) ──
export async function getNotepadHistoryIDB(pdfId) {
  try {
    const db = await getDB();
    if (!db || !db.objectStoreNames.contains(HISTORY_STORE)) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(HISTORY_STORE, 'readonly');
      const store = tx.objectStore(HISTORY_STORE);
      const req = store.get(pdfId);
      req.onsuccess = () => resolve(req.result ? req.result.history : null);
      req.onerror = () => resolve(null);
    });
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
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(CONFIG_STORE, 'readonly');
      const store = tx.objectStore(CONFIG_STORE);
      const req = store.get('custom_dir_handle');
      req.onsuccess = () => resolve(req.result ? req.result.handle : null);
      req.onerror = () => resolve(null);
    });
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

async function verifyPermission(fileHandle, readWrite = false) {
  if (!fileHandle) return false;
  const options = { mode: readWrite ? 'readwrite' : 'read' };
  try {
    if ((await fileHandle.queryPermission(options)) === 'granted') return true;
    if ((await fileHandle.requestPermission(options)) === 'granted') return true;
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

    const ok = await verifyPermission(handle, true);
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
    if (!db) return false;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.count(fileId);
      req.onsuccess = () => resolve(req.result > 0);
      req.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

export async function getCachedPDF(fileId) {
  try {
    const db = await getDB();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(fileId);
      req.onsuccess = async () => {
        const item = req.result;
        if (!item) return resolve(null);
        try {
          // Return the Blob directly — caller uses URL.createObjectURL(), no conversion needed
          if (item.blob) return resolve(item.blob);
          if (item.buffer) {
            // Legacy ArrayBuffer entries: wrap in Blob for consistency
            return resolve(new Blob([item.buffer], { type: 'application/pdf' }));
          }
          resolve(null);
        } catch {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
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

    // 1. Always save in IndexedDB for fast random access
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({
      id: fileId,
      name: name,
      size: size,
      blob: blob,
      saved_at: Date.now(),
    });

    // 2. Also save to Custom PC Folder if configured
    const dirHandle = await getStoredDirHandle();
    if (dirHandle) {
      const hasPerm = await verifyPermission(dirHandle, true);
      if (hasPerm) {
        await writeToCustomDir(dirHandle, fileId, blob, name);
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

    if (!db) {
      return { count: 0, totalBytes: 0, formattedSize: '0 MB', customDir, isCustomSupported };
    }
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const items = req.result || [];
        let totalBytes = 0;
        items.forEach(item => {
          totalBytes += item.size || item.blob?.size || item.buffer?.byteLength || 0;
        });
        const mb = (totalBytes / (1024 * 1024)).toFixed(1);
        resolve({
          count: items.length,
          totalBytes,
          formattedSize: `${mb} MB`,
          customDir,
          isCustomSupported
        });
      };
      req.onerror = () => resolve({ count: 0, totalBytes: 0, formattedSize: '0 MB', customDir, isCustomSupported });
    });
  } catch (e) {
    console.warn('[PDFCache] getCacheStorageStats failed', e);
    return { count: 0, totalBytes: 0, formattedSize: '0 MB', customDir: null, isCustomSupported: false };
  }
}

// ── Clear all cached PDFs from local disk ──
export async function clearAllCachedPDFs() {
  try {
    const db = await getDB();
    if (!db) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
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
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(CONFIG_STORE, 'readonly');
      const store = tx.objectStore(CONFIG_STORE);
      const req = store.get(DL_FOLDER_KEY);
      req.onsuccess = () => resolve(req.result ? req.result.handle : null);
      req.onerror = () => resolve(null);
    });
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
    const ok = await verifyPermission(handle, true);
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
      const hasPerm = await verifyPermission(dirHandle, true);
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
