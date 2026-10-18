// ═══════════════════════════════════════════════
// STORAGE — Safe LocalStorage Manager & Quota Recovery
// Handles quota errors, automatic cache pruning, and persistent storage safety
// ═══════════════════════════════════════════════
import { S } from './state.js';

// ── Check if an error is a QuotaExceededError ──
export function isQuotaError(err) {
  if (!err) return false;
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014 ||
    err.number === -2147024882 ||
    String(err).toLowerCase().includes('quota')
  );
}

// ── Safe LocalStorage Set with Quota Auto-Recovery ──
export function safeStorageSet(key, value) {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    if (isQuotaError(err)) {
      console.warn(`[Storage] Quota exceeded on setItem('${key}'). Running emergency prune...`);
      pruneLocalStorage();
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (err2) {
        console.warn(`[Storage] Quota still exceeded after pruning for '${key}'. Suppressing error.`);
        return false;
      }
    }
    console.warn(`[Storage] Failed to setItem('${key}'):`, err);
    return false;
  }
}

// ── Safe LocalStorage Get ──
export function safeStorageGet(key, fallback = null) {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const val = localStorage.getItem(key);
    return val !== null ? val : fallback;
  } catch {
    return fallback;
  }
}

// ── Safe LocalStorage Remove ──
export function safeStorageRemove(key) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {}
}

// ── Estimate total localStorage usage in bytes ──
export function getLocalStorageUsage() {
  if (typeof localStorage === 'undefined') return 0;
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k);
      total += (k ? k.length : 0) + (v ? v.length : 0);
    }
  } catch {}
  return total * 2; // UTF-16 characters ~2 bytes
}

// ── Emergency / Maintenance Pruning of LocalStorage ──
export function pruneLocalStorage() {
  if (typeof localStorage === 'undefined') return;
  console.log('[Storage] Starting localStorage pruning...');

  const curPdfId = S.curPDF ? (S.curPDF.linked_pdf_id || S.curPDF.id) : null;
  const keysToRemove = [];
  const historyKeysToTrim = [];
  const bookmarkKeys = [];

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;

      if (k.startsWith('notepad_history_')) {
        if (!curPdfId || !k.endsWith(curPdfId)) {
          // Full 50-snapshot history is stored in IndexedDB; free localStorage space for inactive PDFs
          keysToRemove.push(k);
        } else {
          historyKeysToTrim.push(k);
        }
      } else if (k.startsWith('notepad_diag_log_') && (!curPdfId || !k.endsWith(curPdfId))) {
        keysToRemove.push(k);
      } else if (k.startsWith('local_draws_') && (!curPdfId || !k.endsWith(curPdfId))) {
        // Inactive PDF drawings cache (authoritative copy is in DB)
        keysToRemove.push(k);
      } else if (k.startsWith('local_anns_') && (!curPdfId || !k.endsWith(curPdfId))) {
        // Inactive PDF annotations cache (authoritative copy is in DB)
        keysToRemove.push(k);
      } else if (k.startsWith('local_bms_') && (!curPdfId || !k.endsWith(curPdfId))) {
        // Inactive PDF bookmarks cache (authoritative copy is in DB)
        keysToRemove.push(k);
      } else if (k.startsWith('bookmark_')) {
        bookmarkKeys.push(k);
      }
    }

    // 1. Remove non-active drawings, annotations, history, diag logs, and bookmark list caches
    keysToRemove.forEach(k => safeStorageRemove(k));

    // 2. Trim active notepad_history to at most 1 snapshot in localStorage (full history in IndexedDB)
    historyKeysToTrim.forEach(k => {
      try {
        const raw = localStorage.getItem(k);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr) && arr.length > 1) {
            const trimmed = arr.slice(-1);
            localStorage.setItem(k, JSON.stringify(trimmed));
          }
        }
      } catch {}
    });

    // 3. Trim global diagnostic log to 30 entries
    try {
      const rawGlobal = localStorage.getItem('notepad_global_diag_log');
      if (rawGlobal) {
        const gArr = JSON.parse(rawGlobal);
        if (Array.isArray(gArr) && gArr.length > 30) {
          localStorage.setItem('notepad_global_diag_log', JSON.stringify(gArr.slice(0, 30)));
        }
      }
    } catch {}

    // 4. Keep only the 30 most recently saved page bookmarks
    if (bookmarkKeys.length > 30) {
      bookmarkKeys.slice(0, bookmarkKeys.length - 30).forEach(k => {
        if (!curPdfId || !k.endsWith(curPdfId)) {
          safeStorageRemove(k);
        }
      });
    }

    console.log(`[Storage] Pruning complete. Removed ${keysToRemove.length} cache items, trimmed ${historyKeysToTrim.length} history items.`);
  } catch (e) {
    console.warn('[Storage] Error during pruning:', e);
  }
}

// ── Startup Health Check ──
export function initStorageManager() {
  try {
    const bytes = getLocalStorageUsage();
    // 2.5MB threshold out of ~5MB browser limit
    if (bytes > 2.5 * 1024 * 1024) {
      console.warn(`[Storage] High localStorage usage detected (${(bytes / 1024 / 1024).toFixed(2)} MB). Pruning cache...`);
      pruneLocalStorage();
    }
  } catch (e) {
    console.warn('[Storage] Error during storage health check:', e);
  }
}
