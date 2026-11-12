// ═════════════════════════════════════════════════════════════════════════════
// DESKTOP BRIDGE — Tauri 2 + Native C++ PDFium + Local SQLite Notes Mirror
// ═════════════════════════════════════════════════════════════════════════════
import { S } from './state.js';
import { driveSignIn } from './drive.js';
import { safeStorageGet, safeStorageSet } from './storage.js';

const invoke = window.__TAURI_INTERNALS__?.invoke
  ? (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)
  : null;

const _openNativeDocs = new Set();
let _engineInfo = { available: false, engine: 'WebView2 + Virtualized Canvas', sqliteNotes: 0, sqliteAnnNotes: 0 };

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  const parts = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
  }
  return btoa(parts.join(''));
}

// ── Native Tauri Google (Gmail) OAuth Bridge ──────────────────────────────
if (invoke) {
  window.__DESKTOP_GOOGLE_OAUTH__ = async (
    _clientId,
    _scope,
    silent = false,
    forSyllabus = false,
    loginHint = null,
    forceRefresh = false
  ) => {
    const startRes = await invoke('desktop_start_google_oauth', {
      silent: !!silent,
      forSyllabus: !!forSyllabus,
      loginHint: loginHint ? String(loginHint) : null,
      forceRefresh: !!forceRefresh,
    });
    if (startRes?.status === 'success' && startRes?.accessToken) {
      return { access_token: startRes.accessToken };
    }
    if (startRes?.status === 'needs_interactive') {
      throw new Error('Silent refresh requires interactive login');
    }

    const maxWait = silent ? 7_500 : 180_000;
    const pollInterval = silent ? 200 : 300;
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));
      const poll = await invoke('desktop_poll_google_oauth', {
        forSyllabus: !!forSyllabus,
      });
      if (poll?.status === 'success' && poll?.accessToken) {
        return { access_token: poll.accessToken };
      }
      if (
        poll?.status === 'needs_interactive' ||
        poll?.status === 'closed' ||
        poll?.status === 'idle'
      ) {
        throw new Error(
          silent ? 'Silent refresh requires interactive login' : 'Google sign-in window closed'
        );
      }
    }
    throw new Error(silent ? 'Silent refresh timed out' : 'Google sign-in timed out');
  };

  window.__DESKTOP_GOOGLE_SIGNOUT__ = async (forSyllabus = false) => {
    try {
      await invoke('desktop_clear_google_oauth', { forSyllabus: !!forSyllabus });
    } catch {}
  };

  window.desktopOpenUrl = async (url) => {
    try {
      return await invoke('desktop_open_url', { url: String(url) });
    } catch (err) {
      console.warn('[Desktop] desktop_open_url failed:', err);
      return false;
    }
  };

  window.desktopGetPerplexityPrefs = async () => {
    try {
      return await invoke('desktop_get_perplexity_prefs');
    } catch {
      return null;
    }
  };

  window.desktopSavePerplexityPrefs = async (prefs) => {
    try {
      return await invoke('desktop_save_perplexity_prefs', { prefs });
    } catch {
      return false;
    }
  };

  window.desktopOpenPerplexityStudio = async (opts = {}) => {
    try {
      return await invoke('desktop_open_perplexity_studio', {
        pdfId: String(opts.pdfId || ''),
        pdfName: String(opts.pdfName || 'Current PDF'),
        subfolderName: opts.subfolderName ? String(opts.subfolderName) : '',
        instructionText: opts.instructionText ? String(opts.instructionText) : '',
        pdfText: String(opts.pdfText || ''),
        fullPromptText: String(opts.fullPromptText || ''),
        pinnedProjectUrl: opts.pinnedProjectUrl ? String(opts.pinnedProjectUrl) : null,
        autoSubmit: typeof opts.autoSubmit === 'boolean' ? opts.autoSubmit : null,
        digestMode: opts.digestMode ? String(opts.digestMode) : null,
        autoSendDigest: typeof opts.autoSendDigest === 'boolean' ? opts.autoSendDigest : null,
      });
    } catch (err) {
      console.warn('[Desktop] desktop_open_perplexity_studio failed:', err);
      return false;
    }
  };

  window.desktopFocusPerplexityStudio = async () => {
    try {
      return Boolean(await invoke('desktop_focus_perplexity_studio'));
    } catch (err) {
      console.warn('[Desktop] desktop_focus_perplexity_studio failed:', err);
      return false;
    }
  };

  const VALID_PPLX_STUDIO_STATES = new Set(['idle', 'extracting', 'submitted', 'streaming', 'done', 'error']);
  window.__desktopForwardPerplexityStatus = (raw) => {
    if (!raw || typeof raw !== 'object') return;
    const isErr = raw.action === 'studio_error' || raw.state === 'error';
    const state = isErr
      ? 'error'
      : (VALID_PPLX_STUDIO_STATES.has(raw.state) ? raw.state : 'idle');
    const payload = {
      state,
      stepLabel: typeof raw.stepLabel === 'string' ? raw.stepLabel : '',
      message: typeof raw.message === 'string' ? raw.message : '',
      pdfId: raw.pdfId != null ? String(raw.pdfId) : '',
      canRetry: typeof raw.canRetry === 'boolean' ? raw.canRetry : isErr,
    };
    window.__lastPerplexityStudioStatus = payload;
    if (typeof window.__onPerplexityStudioStatus === 'function') {
      try {
        window.__onPerplexityStudioStatus(payload);
      } catch (err) {
        console.warn('[Desktop] __onPerplexityStudioStatus handler failed:', err);
      }
    }
  };

  window.__DESKTOP_PRINT_STUDIO__ = {
    async getMode() {
      try {
        return await invoke('desktop_get_print_studio_mode');
      } catch {
        return { isPrintStudio: false, jobId: null, docId: null, folderId: null };
      }
    },

    async saveJob(jobId, payloadObj) {
      const payloadJson = typeof payloadObj === 'string'
        ? payloadObj
        : JSON.stringify(payloadObj ?? {});
      return await invoke('desktop_save_print_job', {
        jobId: String(jobId || ''),
        payloadJson,
      });
    },

    async loadJob(jobId) {
      if (!jobId) return null;
      try {
        const raw = await invoke('desktop_load_print_job', {
          jobId: String(jobId),
        });
        if (!raw) return null;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        return null;
      }
    },

    async openWindow(jobId = null, title = null) {
      await invoke('desktop_open_print_studio', {
        jobId: jobId ? String(jobId) : null,
        title: title ? String(title) : null,
      });
    },

    async launchProcess(opts = {}) {
      const { jobId = null, docId = null, folderId = null } = opts || {};
      await invoke('desktop_launch_print_studio_process', {
        jobId: jobId ? String(jobId) : null,
        docId: docId ? String(docId) : null,
        folderId: folderId ? String(folderId) : null,
      });
    },

    async closeWindow() {
      try {
        await invoke('desktop_close_print_studio');
      } catch {
        window.close();
      }
    },
  };

  const _origWindowOpen = window.open ? window.open.bind(window) : null;
  window.open = function (url, target, features) {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      window.desktopOpenUrl(url);
      return { closed: false, close() {}, focus() {} };
    }
    return _origWindowOpen ? _origWindowOpen(url, target, features) : null;
  };
}

import { reRenderAll, captureZoomAnchor } from './viewer.js';

window.__DESKTOP_PDFIUM__ = {
  async openPdf(docId, arrayBuffer, localPath = null, driveFileId = null) {
    if (!invoke) return false;
    try {
      if (localPath) {
        const res = await invoke('pdfium_open_path', { docId: String(docId), path: localPath });
        if (res?.ok) _openNativeDocs.add(String(docId));
        return !!res?.ok;
      }
      // 1. Check if already cached on disk under docId OR driveFileId in data\pdf_cache
      let cachedPath = await invoke('desktop_cache_get_path', { fileId: String(docId) }).catch(() => null);
      if (!cachedPath && driveFileId && String(driveFileId) !== String(docId)) {
        cachedPath = await invoke('desktop_cache_get_path', { fileId: String(driveFileId) }).catch(() => null);
      }
      if (cachedPath) {
        const res = await invoke('pdfium_open_path', { docId: String(docId), path: cachedPath });
        if (res?.ok) {
          _openNativeDocs.add(String(docId));
          if (driveFileId && String(driveFileId) !== String(docId)) {
            await invoke('pdfium_open_path', { docId: String(driveFileId), path: cachedPath }).catch(() => {});
            _openNativeDocs.add(String(driveFileId));
          }
          return true;
        }
      }
      // 2. Otherwise persist to disk cache in 4 MB chunks (handles 100 MB+ PDFs safely without Base64 OOM)
      if (arrayBuffer) {
        const savedPath = await this.savePdfBlobToCacheChunked(docId, arrayBuffer, driveFileId).catch(() => null);
        if (savedPath) {
          const res = await invoke('pdfium_open_path', { docId: String(docId), path: savedPath });
          if (res?.ok) {
            _openNativeDocs.add(String(docId));
            if (driveFileId && String(driveFileId) !== String(docId)) {
              await invoke('pdfium_open_path', { docId: String(driveFileId), path: savedPath }).catch(() => {});
              _openNativeDocs.add(String(driveFileId));
            }
            return true;
          }
        }
        if (arrayBuffer.byteLength && arrayBuffer.byteLength <= 35 * 1024 * 1024) {
          const b64 = arrayBufferToBase64(arrayBuffer);
          const res = await invoke('pdfium_open_bytes', { docId: String(docId), base64: b64 });
          if (res?.ok) _openNativeDocs.add(String(docId));
          return !!res?.ok;
        }
      }
    } catch (e) {
      console.warn('[Desktop PDFium] openPdf warning:', e);
    }
    return false;
  },

  async savePdfBlobToCacheChunked(docId, blobOrBuffer, driveFileId = null) {
    if (!invoke || !docId || !blobOrBuffer) return null;
    try {
      let existing = await invoke('desktop_cache_get_path', { fileId: String(docId) }).catch(() => null);
      if (existing) return existing;

      const isBlob = typeof Blob !== 'undefined' && blobOrBuffer instanceof Blob;
      const totalBytes = isBlob
        ? blobOrBuffer.size
        : (blobOrBuffer.byteLength || 0);
      if (!totalBytes || totalBytes < 100) return null;

      const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB per IPC chunk
      let savedPath = null;
      for (let offset = 0; offset < totalBytes; offset += CHUNK_SIZE) {
        const end = Math.min(totalBytes, offset + CHUNK_SIZE);
        let sliceBuf;
        if (isBlob) {
          sliceBuf = await blobOrBuffer.slice(offset, end).arrayBuffer();
        } else if (blobOrBuffer instanceof ArrayBuffer) {
          sliceBuf = blobOrBuffer.slice(offset, end);
        } else if (ArrayBuffer.isView(blobOrBuffer)) {
          sliceBuf = blobOrBuffer.buffer.slice(
            blobOrBuffer.byteOffset + offset,
            blobOrBuffer.byteOffset + end
          );
        } else {
          return null;
        }
        const b64Chunk = arrayBufferToBase64(sliceBuf);
        const isLast = end >= totalBytes;
        savedPath = await invoke('desktop_cache_write_chunk', {
          fileId: String(docId),
          base64Chunk: b64Chunk,
          append: offset > 0,
          copyToFileId:
            isLast && driveFileId && String(driveFileId) !== String(docId)
              ? String(driveFileId)
              : null,
        });
      }
      return savedPath;
    } catch (e) {
      console.warn('[Desktop PDFium] savePdfBlobToCacheChunked warning:', e);
      return null;
    }
  },

  async renderPageToCanvas(docId, pageNum, canvas, widthPx, heightPx) {
    if (!invoke || !_openNativeDocs.has(String(docId))) return false;
    const targetW = Math.max(100, Math.round(widthPx));
    const targetH = Math.max(100, Math.round(heightPx));
    const dataUrl = await invoke('pdfium_render_page', {
      docId: String(docId),
      pageNum: Number(pageNum),
      widthPx: targetW,
      heightPx: targetH,
    });
    if (!dataUrl || typeof dataUrl !== 'string') return false;

    await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve();
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
    return true;
  },

  async getPageText(docId, pageNum, scaleKey) {
    if (!invoke) return null;
    try {
      const raw = await invoke('desktop_vault_get_page_text', {
        docId: String(docId),
        pageNum: Number(pageNum),
        scaleKey: String(scaleKey),
      });
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  async savePageText(docId, pageNum, scaleKey, payload) {
    if (!invoke) return false;
    try {
      return await invoke('desktop_vault_save_page_text', {
        docId: String(docId),
        pageNum: Number(pageNum),
        scaleKey: String(scaleKey),
        json: JSON.stringify(payload),
      });
    } catch {
      return false;
    }
  },

  async downloadGDriveFile(fileId, token = null, fallbackToken = null) {
    if (!invoke) return { ok: false, blob: null, error: 'Desktop bridge unavailable', diagnostics: [] };
    try {
      const res = await invoke('desktop_gdrive_download_file', {
        fileId: String(fileId),
        token: token ? String(token) : null,
        fallbackToken: fallbackToken ? String(fallbackToken) : null,
      });
      if (!res?.ok || !res?.base64) {
        return {
          ok: false,
          blob: null,
          error: res?.error || 'Download failed',
          diagnostics: Array.isArray(res?.diagnostics) ? res.diagnostics : [],
        };
      }
      const binStr = atob(res.base64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      return {
        ok: true,
        blob: new Blob([bytes], { type: 'application/pdf' }),
        error: null,
        diagnostics: Array.isArray(res?.diagnostics) ? res.diagnostics : [],
      };
    } catch (e) {
      console.warn('[Desktop GDrive] downloadGDriveFile error:', e);
      return {
        ok: false,
        blob: null,
        error: String(e?.message || e || 'Unknown error'),
        diagnostics: [String(e?.message || e)],
      };
    }
  },

  async listGDriveFolder(folderId, token = null) {
    if (!invoke) return null;
    try {
      const res = await invoke('desktop_gdrive_list_folder', {
        folderId: String(folderId),
        token: token ? String(token) : null,
      });
      return Array.isArray(res?.files) ? res.files : null;
    } catch (e) {
      console.warn('[Desktop GDrive] listGDriveFolder error:', e);
      return null;
    }
  },

  async ocrPage(docId, pageNum, widthPx = 1600, heightPx = 2200) {
    if (!invoke) return null;
    try {
      return await invoke('desktop_ocr_page', {
        docId: String(docId),
        pageNum: Number(pageNum),
        widthPx: Math.round(widthPx),
        heightPx: Math.round(heightPx),
      });
    } catch (e) {
      console.warn('[Desktop OCR] ocrPage notice (will fallback to ocrPng):', e);
      return null;
    }
  },

  async ocrPng(pngBase64) {
    if (!invoke || !pngBase64) return null;
    return await invoke('desktop_ocr_png', {
      pngBase64: String(pngBase64),
    });
  },

  async saveSearchablePdf(defaultName, arrayBufferOrBase64, overwritePath = null) {
    if (!invoke) return { ok: false, error: 'Desktop bridge unavailable' };
    const b64 = typeof arrayBufferOrBase64 === 'string'
      ? arrayBufferOrBase64
      : arrayBufferToBase64(arrayBufferOrBase64);
    return await invoke('desktop_save_searchable_pdf', {
      defaultName: String(defaultName || 'Document_OCR.pdf'),
      base64: b64,
      overwritePath: overwritePath ? String(overwritePath) : null,
    });
  },

  async getStudioMode() {
    if (!invoke) return { isStudio: false };
    try {
      return await invoke('desktop_get_studio_mode');
    } catch {
      return { isStudio: false };
    }
  },

  async launchOcrStudio({ docId = null, driveId = null, filePath = null, pdfName = null, preset = 'balanced', autoStart = false, oauthToken = null } = {}) {
    if (!invoke) return { ok: false, error: 'Desktop bridge unavailable' };
    return await invoke('desktop_launch_ocr_studio', {
      docId: docId ? String(docId) : null,
      driveId: driveId ? String(driveId) : null,
      filePath: filePath ? String(filePath) : null,
      pdfName: pdfName ? String(pdfName) : null,
      preset: preset ? String(preset) : 'balanced',
      autoStart: !!autoStart,
      oauthToken: oauthToken ? String(oauthToken) : null,
    });
  },

  async pickPdfPathOnly() {
    if (!invoke) return null;
    return await invoke('desktop_pick_pdf_path_only');
  },

  async startOcrCompressJob({ docId = null, driveId = null, inputPath = null, pdfName = null, preset = 'balanced', oauthToken = null } = {}) {
    if (!invoke) throw new Error('Desktop bridge unavailable');
    return await invoke('desktop_start_ocr_compress_job', {
      docId: docId ? String(docId) : null,
      driveId: driveId ? String(driveId) : null,
      inputPath: inputPath ? String(inputPath) : null,
      pdfName: pdfName ? String(pdfName) : null,
      preset: preset ? String(preset) : 'balanced',
      oauthToken: oauthToken ? String(oauthToken) : null,
    });
  },

  async getOcrCompressStatus(docId = null) {
    if (!invoke) return null;
    try {
      return await invoke('desktop_get_ocr_compress_status', {
        docId: docId ? String(docId) : null,
      });
    } catch {
      return null;
    }
  },

  async cancelOcrCompressJob(docId) {
    if (!invoke || !docId) return false;
    try {
      return await invoke('desktop_cancel_ocr_compress_job', { docId: String(docId) });
    } catch {
      return false;
    }
  },

  async exportCompressedPdfAs(docId = null, defaultName = null) {
    if (!invoke) return { ok: false, error: 'Desktop bridge unavailable' };
    return await invoke('desktop_export_compressed_pdf_as', {
      docId: docId ? String(docId) : null,
      defaultName: defaultName ? String(defaultName) : null,
    });
  },

  async splitPdfToFolder({
    docId = null,
    driveId = null,
    inputPath = null,
    defaultName = null,
    splitMode = 'pages',
    splitValue = '100',
    preset = 'balanced',
  } = {}) {
    if (!invoke) return { ok: false, error: 'Desktop bridge unavailable' };
    return await invoke('desktop_split_pdf_to_folder', {
      docId: docId ? String(docId) : null,
      driveId: driveId ? String(driveId) : null,
      inputPath: inputPath ? String(inputPath) : null,
      defaultName: defaultName ? String(defaultName) : null,
      splitMode: String(splitMode || 'pages'),
      splitValue: String(splitValue || '100'),
      preset: preset ? String(preset) : 'balanced',
    });
  },

  async getPdfOcrSummary(docId, totalPages = 0) {
    if (!invoke || !docId) return null;
    try {
      return await invoke('desktop_get_pdf_ocr_summary', {
        docId: String(docId),
        totalPages: Number(totalPages) || 0,
      });
    } catch {
      return null;
    }
  },

  async closeStudioWindow() {
    if (!invoke) {
      window.close();
      return false;
    }
    try {
      return await invoke('desktop_close_studio_window');
    } catch {
      window.close();
      return false;
    }
  },

  async readCachedPdfBytes(fileId) {
    if (!invoke || !fileId) return null;
    try {
      const b64 = await invoke('desktop_cache_read_pdf', { fileId: String(fileId) });
      if (!b64 || typeof b64 !== 'string') return null;
      const binStr = atob(b64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      return bytes;
    } catch {
      return null;
    }
  },
};

window.__DESKTOP_SQLITE__ = {
  async syncAnnotations(pdfFileId, annotations) {
    if (!invoke || !pdfFileId) return false;
    try {
      return await invoke('desktop_sqlite_sync_annotations', {
        pdfFileId: String(pdfFileId),
        annotationsJson: JSON.stringify(annotations || []),
      });
    } catch {
      return false;
    }
  },
  async loadAnnotations(pdfFileId) {
    if (!invoke || !pdfFileId) return null;
    try {
      const raw = await invoke('desktop_sqlite_load_annotations', { pdfFileId: String(pdfFileId) });
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  async syncDrawings(pdfFileId, drawData) {
    if (!invoke || !pdfFileId) return false;
    try {
      return await invoke('desktop_sqlite_sync_drawings', {
        pdfFileId: String(pdfFileId),
        drawMapJson: JSON.stringify(drawData || {}),
      });
    } catch {
      return false;
    }
  },
  async loadDrawings(pdfFileId) {
    if (!invoke || !pdfFileId) return null;
    try {
      const raw = await invoke('desktop_sqlite_load_drawings', { pdfFileId: String(pdfFileId) });
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  async syncBookmarks(pdfFileId, bookmarks) {
    if (!invoke || !pdfFileId) return false;
    try {
      return await invoke('desktop_sqlite_sync_bookmarks', {
        pdfFileId: String(pdfFileId),
        bookmarksJson: JSON.stringify(bookmarks || []),
      });
    } catch {
      return false;
    }
  },
  async loadBookmarks(pdfFileId) {
    if (!invoke || !pdfFileId) return null;
    try {
      const raw = await invoke('desktop_sqlite_load_bookmarks', { pdfFileId: String(pdfFileId) });
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  async upsertPdfNote(pdfId, content, digest) {
    if (!invoke || !pdfId) return false;
    try {
      return await invoke('desktop_sqlite_upsert_pdf_note', {
        pdfId: String(pdfId),
        content: String(content ?? ''),
        digest: String(digest ?? ''),
      });
    } catch {
      return false;
    }
  },
  async loadPdfNote(pdfId) {
    if (!invoke || !pdfId) return null;
    try {
      const raw = await invoke('desktop_sqlite_load_pdf_note', { pdfId: String(pdfId) });
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  async saveFolderNote(folderId, notesHtml) {
    if (!invoke || !folderId) return false;
    try {
      return await invoke('desktop_sqlite_save_folder_note', {
        folderId: String(folderId),
        notesHtml: String(notesHtml ?? ''),
      });
    } catch {
      return false;
    }
  },
  async loadFolderNote(folderId) {
    if (!invoke || !folderId) return null;
    try {
      return await invoke('desktop_sqlite_load_folder_note', { folderId: String(folderId) });
    } catch {
      return null;
    }
  },
  async saveNotepadHistory(pdfId, ts, content, digest) {
    if (!invoke || !pdfId) return false;
    try {
      return await invoke('desktop_sqlite_save_notepad_history', {
        pdfId: String(pdfId),
        ts: Number(ts || Date.now()),
        content: String(content ?? ''),
        digest: String(digest ?? ''),
      });
    } catch {
      return false;
    }
  },
  async loadNotepadHistory(pdfId) {
    if (!invoke || !pdfId) return [];
    try {
      const raw = await invoke('desktop_sqlite_load_notepad_history', { pdfId: String(pdfId) });
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },
  async saveOutbox(queue) {
    if (!invoke) return false;
    try {
      return await invoke('desktop_sqlite_save_outbox', {
        queueJson: JSON.stringify(queue || []),
      });
    } catch {
      return false;
    }
  },
  async loadOutbox() {
    if (!invoke) return [];
    try {
      const raw = await invoke('desktop_sqlite_load_outbox');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },
};

function desktopSvgIcon(name, size = 14) {
  const paths = {
    bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    sync: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  };
  const inner = paths[name] || paths.info;
  return `<svg class="icon icon-sm desktop-svg-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

function ensureDesktopBridgeStyles() {
  if (document.getElementById('desktop-bridge-styles')) return;
  const style = document.createElement('style');
  style.id = 'desktop-bridge-styles';
  style.textContent = `
    .desktop-svg-icon {
      display: inline-block;
      vertical-align: middle;
      flex-shrink: 0;
    }
    .desktop-inline-row {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .desktop-engine-bar {
      position: fixed;
      bottom: 12px;
      right: 12px;
      z-index: 25;
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 5px 10px;
      background: var(--surface-paper, var(--surface, #1c1916));
      border: 1px solid var(--rule, #332d27);
      border-radius: var(--radius-s, 4px);
      font-family: var(--font-ui, "Public Sans", "Segoe UI", system-ui, sans-serif);
      font-size: 11px;
      color: var(--ink, #e6dfd4);
      cursor: pointer;
      box-shadow: var(--shadow-lift, 0 2px 6px rgba(0, 0, 0, 0.22));
      opacity: 0;
      transition: opacity 0.2s ease, border-color 0.15s ease;
    }
    .desktop-engine-bar.visible {
      display: flex;
      opacity: 1;
    }
    .desktop-engine-bar:hover {
      border-color: var(--rule-strong, var(--accent, #dd6c45));
    }
    .desktop-engine-pulse {
      display: inline-flex;
      align-items: center;
      color: var(--accent, #164a38);
    }
    #desktop-engine-lbl {
      font-weight: 600;
      color: var(--accent, #164a38);
    }
    .desktop-engine-bar[data-status="vaulted"] .desktop-engine-pulse,
    .desktop-engine-bar[data-status="vaulted"] #desktop-engine-lbl {
      color: var(--cb-sage-text, var(--accent, #164a38));
    }
    .desktop-engine-sep {
      color: var(--ink-muted, #8a8073);
    }
    #desktop-ram-lbl {
      color: var(--ink-muted, #8a8073);
      font-family: var(--font-num, var(--font-ui, monospace));
      font-variant-numeric: tabular-nums;
    }
    .desktop-engine-bar[data-status="vaulted"] #desktop-ram-lbl {
      color: var(--cb-sage-text, var(--accent, #164a38));
    }
    #btn-desktop-update {
      background: transparent;
      border: 1px solid var(--rule, #332d27);
      color: var(--accent, #164a38);
      border-radius: var(--radius-s, 4px);
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: background-color 0.15s ease, border-color 0.15s ease;
    }
    #btn-desktop-update:hover {
      background: var(--surface-2, #25211d);
      border-color: var(--rule-strong, var(--accent, #164a38));
    }
    #btn-desktop-gmail-login.desktop-gmail-login-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: calc(100% - 24px);
      margin: 6px 12px 4px;
      padding: 7px 10px;
      background: var(--surface-paper, var(--surface, #1c1916));
      border: 1px solid var(--rule-strong, var(--rule, #332d27));
      border-radius: var(--radius-s, 4px);
      color: var(--ink, #e6dfd4);
      font-family: var(--font-ui, "Public Sans", "Segoe UI", system-ui, sans-serif);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    #btn-desktop-gmail-login.desktop-gmail-login-btn:hover {
      background: var(--surface-2, #25211d);
      border-color: var(--accent, #164a38);
      color: var(--accent, #164a38);
    }
    #desktop-update-pill {
      position: fixed;
      bottom: 58px;
      right: 20px;
      z-index: 1250;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 14px;
      background: var(--surface-paper, var(--surface, #1c1916));
      border: 1px solid var(--accent, #164a38);
      border-radius: var(--radius-m, 7px);
      box-shadow: var(--shadow-lift, 0 8px 24px rgba(0, 0, 0, 0.28));
      color: var(--ink, #e6dfd4);
      font-family: var(--font-ui, "Public Sans", "Segoe UI", system-ui, sans-serif);
      font-size: 12px;
      font-weight: 600;
      user-select: none;
      transition: border-color 0.2s ease, transform 0.2s ease;
    }
    #desktop-update-pill[data-tone="error"] {
      border-color: var(--danger, #8f2622);
      color: var(--danger, #8f2622);
    }
    #desktop-update-pill[data-tone="ok"] {
      border-color: var(--cb-sage-text, var(--accent, #164a38));
    }
    #desktop-update-dismiss {
      background: transparent;
      border: none;
      color: var(--ink-muted, #8a8073);
      cursor: pointer;
      padding: 2px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-s, 4px);
    }
    #desktop-update-dismiss:hover {
      color: var(--ink, #e6dfd4);
      background: var(--surface-2, rgba(0, 0, 0, 0.08));
    }
    #desktop-status-modal {
      position: fixed;
      inset: 0;
      z-index: 99999;
      background: rgba(17, 24, 34, 0.56);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--font-ui, "Public Sans", "Segoe UI", system-ui, sans-serif);
    }
    .dsm-card {
      background: var(--surface-paper, var(--surface, #1c1916));
      border: 1px solid var(--rule-strong, var(--rule, #332d27));
      border-radius: var(--radius-m, 7px);
      padding: 22px 24px;
      max-width: 480px;
      width: 92%;
      color: var(--ink, #e6dfd4);
      box-shadow: var(--shadow-lift, 0 12px 32px rgba(0, 0, 0, 0.35));
      font-family: var(--font-ui, "Public Sans", "Segoe UI", system-ui, sans-serif);
    }
    .dsm-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
      gap: 10px;
    }
    .dsm-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--ink, #e6dfd4);
      display: inline-flex;
      align-items: center;
      gap: 7px;
    }
    .dsm-title .desktop-svg-icon {
      color: var(--accent, #164a38);
    }
    #dsm-close {
      background: transparent;
      border: 1px solid transparent;
      color: var(--ink-muted, #8a8073);
      cursor: pointer;
      width: 28px;
      height: 28px;
      border-radius: var(--radius-s, 4px);
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    #dsm-close:hover {
      color: var(--ink, #e6dfd4);
      background: var(--surface-2, #25211d);
      border-color: var(--rule, #332d27);
    }
    .dsm-well {
      font-size: 12px;
      line-height: 1.7;
      color: var(--ink, #e6dfd4);
      background: var(--surface-2, var(--surface, #25211d));
      border: 1px solid var(--rule, #332d27);
      border-radius: var(--radius-s, 4px);
      padding: 12px 14px;
      margin-bottom: 14px;
    }
    .dsm-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .dsm-ok-val { color: var(--cb-sage-text, var(--accent, #164a38)); font-weight: 600; }
    .dsm-warn-val { color: var(--gilt, #c7a455); font-weight: 600; }
    .dsm-err-val { color: var(--danger, #8f2622); font-weight: 600; }
    .dsm-accent-val { color: var(--accent, #164a38); font-weight: 600; }
    #dsm-update-status {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--rule, #332d27);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dsm-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .dsm-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 13px;
      border-radius: var(--radius-s, 4px);
      font-family: var(--font-ui, "Public Sans", "Segoe UI", system-ui, sans-serif);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--rule, #332d27);
      background: var(--surface-2, #25211d);
      color: var(--ink, #e6dfd4);
      transition: background-color 0.15s ease, border-color 0.15s ease;
    }
    .dsm-btn:hover {
      border-color: var(--rule-strong, var(--accent, #164a38));
    }
    .dsm-btn--primary {
      background: var(--accent, #164a38);
      border-color: var(--accent, #164a38);
      color: var(--accent-ink, #f7f8f5);
    }
    .dsm-btn--primary:hover {
      background: var(--accent-hover, var(--accent, #113c2d));
    }
    .dsm-btn--gold {
      background: var(--gilt, #c7a455);
      border-color: var(--gilt, #c7a455);
      color: #14110f;
    }
    #settings-version-card {
      background: var(--surface-2, var(--surface, #25211d));
      border: 1px solid var(--rule, #332d27);
      border-radius: var(--radius-m, 7px);
      padding: 10px 12px;
      font-family: var(--font-ui, "Public Sans", "Segoe UI", system-ui, sans-serif);
      font-size: 12px;
      line-height: 1.6;
      color: var(--ink, #e6dfd4);
    }
    .svc-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .svc-title {
      color: var(--ink, #e6dfd4);
      font-size: 12.5px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .svc-title .desktop-svg-icon {
      color: var(--accent, #164a38);
    }
    .svc-foot {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid var(--rule, #332d27);
    }
    .svc-val {
      color: var(--accent, #164a38);
      font-family: var(--font-num, var(--font-ui, sans-serif));
      font-variant-numeric: tabular-nums;
    }
    .svc-status-line {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex-wrap: wrap;
    }
  `;
  document.head.appendChild(style);
}

function injectDesktopUI() {
  ensureDesktopBridgeStyles();
  if (document.getElementById('desktop-engine-bar')) return;

  // Lower-right floating vaulting indicator pill
  const engineBar = document.createElement('div');
  engineBar.id = 'desktop-engine-bar';
  engineBar.className = 'desktop-engine-bar';
  engineBar.dataset.status = 'active';
  engineBar.title = 'Click to view Standalone Desktop Engine & Vault status';
  engineBar.innerHTML = `
    <span class="desktop-engine-pulse">${desktopSvgIcon('bolt', 12)}</span>
    <span id="desktop-engine-lbl">PDFium</span>
    <span class="desktop-engine-sep">·</span>
    <span id="desktop-ram-lbl">Vaulting…</span>
  `;
  document.body.appendChild(engineBar);
  engineBar.addEventListener('click', showDesktopStatusModal);

  // Position updater to avoid overlapping with right-hand panels (Notes & Case Summaries / Notepad)
  function updateDesktopEngineBarPosition() {
    const bar = document.getElementById('desktop-engine-bar');
    if (!bar) return;

    const annPanel = document.getElementById('ann-panel');
    const npPanel = document.getElementById('notepad-panel');
    const isAnnOpen = annPanel && annPanel.classList.contains('open');
    const isNpOpen = npPanel && npPanel.classList.contains('open');

    if (window.innerWidth <= 1024) {
      if (isAnnOpen || isNpOpen) {
        const openPanel = isAnnOpen ? annPanel : npPanel;
        const panelHeight = openPanel.offsetHeight || Math.round(window.innerHeight * 0.6);
        bar.style.bottom = `${panelHeight + 12}px`;
        bar.style.right = '12px';
      } else {
        bar.style.bottom = '12px';
        bar.style.right = '12px';
      }
    } else {
      if (isAnnOpen || isNpOpen) {
        const openPanel = isAnnOpen ? annPanel : npPanel;
        const panelWidth = openPanel.offsetWidth || 380;
        bar.style.right = `${panelWidth + 14}px`;
        bar.style.bottom = '12px';
      } else {
        bar.style.right = '12px';
        bar.style.bottom = '12px';
      }
    }
  }

  // Observe opening/closing/resizing of right-hand panels
  const panelObserver = new MutationObserver(() => {
    updateDesktopEngineBarPosition();
  });
  const annPanelEl = document.getElementById('ann-panel');
  const npPanelEl = document.getElementById('notepad-panel');
  if (annPanelEl) panelObserver.observe(annPanelEl, { attributes: true, attributeFilter: ['class', 'style'] });
  if (npPanelEl) panelObserver.observe(npPanelEl, { attributes: true, attributeFilter: ['class', 'style'] });
  window.addEventListener('resize', updateDesktopEngineBarPosition);
  updateDesktopEngineBarPosition();

  const settingsBtn = document.getElementById('btn-settings');
  if (settingsBtn && !document.getElementById('btn-desktop-update')) {
    const updBtn = document.createElement('button');
    updBtn.id = 'btn-desktop-update';
    updBtn.title = 'Desktop Engine Status & Check for App Updates';
    updBtn.setAttribute('aria-label', 'Desktop Engine Status & Check for App Updates');
    updBtn.innerHTML = desktopSvgIcon('bolt', 14);
    updBtn.addEventListener('click', showDesktopStatusModal);
    settingsBtn.insertAdjacentElement('beforebegin', updBtn);
  }

  // Prominent Gmail / Google Drive Sign-In button if not connected
  const driveBar = document.getElementById('drive-bar');
  if (driveBar) {
    const gmailBtn = document.createElement('button');
    gmailBtn.id = 'btn-desktop-gmail-login';
    gmailBtn.className = 'desktop-gmail-login-btn';
    const defaultGmailHtml = `${desktopSvgIcon('cloud', 14)}<span>Sign in with Google (Gmail) for Cloud PDFs</span>`;
    gmailBtn.innerHTML = defaultGmailHtml;
    gmailBtn.addEventListener('click', async () => {
      gmailBtn.innerHTML = `${desktopSvgIcon('clock', 14)}<span>Opening Google Sign-In window…</span>`;
      try {
        await driveSignIn();
      } catch (e) {
        console.warn('[Desktop OAuth] Sign-in error:', e);
      } finally {
        gmailBtn.innerHTML = defaultGmailHtml;
        window.__updateDesktopAuthBadge?.(S.driveUser);
      }
    });
    driveBar.insertAdjacentElement('afterend', gmailBtn);
  }

  window.__updateDesktopAuthBadge = (driveUser) => {
    const btn = document.getElementById('btn-desktop-gmail-login');
    if (!btn) return;
    btn.style.display = driveUser ? 'none' : 'flex';
  };
  window.__updateDesktopAuthBadge(S.driveUser);

  let _disappearTimer = null;
  window.__updateDesktopEngineBadge = ({ activeCanvases, totalPages }) => {
    const bar = document.getElementById('desktop-engine-bar');
    const ramLbl = document.getElementById('desktop-ram-lbl');
    const engineLbl = document.getElementById('desktop-engine-lbl');
    const pulse = bar?.querySelector('.desktop-engine-pulse');
    if (!bar) return;

    updateDesktopEngineBarPosition();

    if (!totalPages || totalPages <= 0) {
      clearTimeout(_disappearTimer);
      bar.classList.remove('visible');
      bar.style.display = 'none';
      return;
    }

    if (activeCanvases >= totalPages) {
      // Document is fully vaulted — display confirmation briefly, then disappear
      bar.dataset.status = 'vaulted';
      if (ramLbl) ramLbl.textContent = `${totalPages}/${totalPages} pgs`;
      if (engineLbl) engineLbl.textContent = 'Vaulted';
      if (pulse) pulse.innerHTML = desktopSvgIcon('check', 12);

      clearTimeout(_disappearTimer);
      _disappearTimer = setTimeout(() => {
        bar.classList.remove('visible');
        setTimeout(() => {
          if (!bar.classList.contains('visible')) {
            bar.style.display = 'none';
          }
        }, 300);
      }, 1200);
    } else {
      // Actively vaulting pages
      clearTimeout(_disappearTimer);
      bar.dataset.status = 'active';
      bar.style.display = 'flex';
      void bar.offsetWidth; // Force reflow for CSS transition
      bar.classList.add('visible');

      const pct = Math.round((activeCanvases / totalPages) * 100);
      if (engineLbl) engineLbl.textContent = 'PDFium';
      if (pulse) pulse.innerHTML = desktopSvgIcon('bolt', 12);
      if (ramLbl) ramLbl.textContent = `Vault: ${activeCanvases}/${totalPages} (${pct}%)`;
    }
  };

  // Smooth Ctrl + Mouse Wheel / Trackpad Pinch Zoom in PDF Viewer
  const scrollEl = document.getElementById('canvas-scroll');
  if (scrollEl && !scrollEl.dataset.desktopWheelZoom) {
    scrollEl.dataset.desktopWheelZoom = 'true';
    let zoomDebounce = null;
    scrollEl.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !S.pdfDoc) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.12 : -0.12;
      const nextScale = Math.min(3.0, Math.max(0.6, Math.round((S.scale + delta) * 100) / 100));
      if (nextScale === S.scale) return;
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
}

let _updateInfo = null;
let _isUpdating = false;
let _lastCheckTime = 0;

function isAutoUpdateEnabled() {
  return safeStorageGet('desktop_auto_update_enabled', 'true') !== 'false';
}

function setAutoUpdateEnabled(val) {
  safeStorageSet('desktop_auto_update_enabled', val ? 'true' : 'false');
}

function getUpdatePill() {
  ensureDesktopBridgeStyles();
  let pill = document.getElementById('desktop-update-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'desktop-update-pill';
    document.body.appendChild(pill);
  }
  return pill;
}

async function performAutoUpdate(info) {
  if (_isUpdating || !info?.hasUpdate || !invoke) return;
  _isUpdating = true;
  const pill = getUpdatePill();
  pill.style.display = 'flex';
  pill.style.cursor = 'wait';
  pill.dataset.tone = 'ok';
  pill.innerHTML = `<span class="desktop-inline-row">${desktopSvgIcon('sync', 14)}<span>Auto-updating to Build #${info.remoteBuild}… Downloading in background (~32 MB)</span></span>`;

  try {
    // Flush notes before update so local and cloud state are 100% saved
    try {
      const { flushNotepadSave } = await import('./notepad.js');
      await flushNotepadSave();
    } catch {}

    pill.innerHTML = `<span class="desktop-inline-row">${desktopSvgIcon('clock', 14)}<span>Downloading update from GitHub (~32 MB)… Please wait</span></span>`;
    await invoke('desktop_apply_github_update', { downloadUrl: info.downloadUrl || null, expectedBuild: info.remoteBuild ?? null });
    pill.innerHTML = `<span class="desktop-inline-row">${desktopSvgIcon('check', 14)}<span>Update installed! Restarting Legal Annotator…</span></span>`;
  } catch (err) {
    _isUpdating = false;
    pill.style.cursor = 'pointer';
    pill.dataset.tone = 'error';
    pill.innerHTML = `<span class="desktop-inline-row">${desktopSvgIcon('alert', 14)}<span>Auto-update paused: ${err} (will retry automatically)</span></span>`;
    setTimeout(() => { if (!_isUpdating) pill.style.display = 'none'; }, 8000);
  }
}

function showUpdateBanner(info) {
  _updateInfo = info;
  const pill = getUpdatePill();
  pill.style.display = 'flex';
  pill.style.cursor = 'pointer';
  pill.dataset.tone = 'ok';
  pill.title = info.notes || 'Click to download latest Legal Annotator.exe from GitHub and restart';
  pill.innerHTML = `
    <span class="desktop-inline-row">${desktopSvgIcon('sync', 14)}<span>Update Available (Build #${info.remoteBuild}) — <u>Click to Update &amp; Restart</u></span></span>
    <button id="desktop-update-dismiss" title="Dismiss" aria-label="Dismiss update notification">${desktopSvgIcon('close', 13)}</button>
  `;
  pill.querySelector('#desktop-update-dismiss')?.addEventListener('click', (e) => {
    e.stopPropagation();
    pill.style.display = 'none';
  });
  pill.onclick = async () => {
    if (_isUpdating) return;
    performAutoUpdate(info);
  };
}

async function checkAndNotifyGitHubUpdate(manual = false) {
  if (!invoke) return null;
  _lastCheckTime = Date.now();
  try {
    const info = await invoke('desktop_check_github_update');
    _updateInfo = info;
    if (info?.hasUpdate) {
      if (isAutoUpdateEnabled() && !manual) {
        performAutoUpdate(info);
      } else {
        showUpdateBanner(info);
      }
    }
    return info;
  } catch (e) {
    if (manual) console.warn('[Desktop Auto-Update] Check error:', e);
    return null;
  }
}

async function showDesktopStatusModal() {
  ensureDesktopBridgeStyles();
  if (invoke) {
    try {
      _engineInfo = await invoke('desktop_system_status');
    } catch {}
  }
  let modal = document.getElementById('desktop-status-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'desktop-status-modal';
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
  const buildLbl = _updateInfo?.localBuild ? `v${_updateInfo.localVersion || '1.1.0'} (Build #${_updateInfo.localBuild})` : 'v1.1.0';
  modal.innerHTML = `
    <div class="dsm-card">
      <div class="dsm-head">
        <div class="dsm-title">${desktopSvgIcon('bolt', 16)}<span>Standalone Desktop Engine &amp; Auto-Updater</span></div>
        <button id="dsm-close" title="Close" aria-label="Close">${desktopSvgIcon('close', 16)}</button>
      </div>
      <div class="dsm-well">
        <div class="dsm-row"><strong>Installed Build:</strong> <span class="dsm-accent-val">${buildLbl}</span></div>
        <div class="dsm-row"><strong>PDF Engine:</strong> <span class="dsm-ok-val">${_engineInfo.engine || 'Native PDFium (x64)'}</span></div>
        <div class="dsm-row"><strong>PDFium DLL:</strong> ${_engineInfo.pdfiumLoaded ? `<span class="dsm-ok-val desktop-inline-row">${desktopSvgIcon('check', 13)}<span>Embedded &amp; Loaded natively in Rust</span></span>` : `<span class="dsm-warn-val desktop-inline-row">${desktopSvgIcon('alert', 13)}<span>Fallback mode</span></span>`}</div>
        <div class="dsm-row"><strong>Google Drive (Gmail):</strong> ${S.driveUser ? `<span class="dsm-ok-val desktop-inline-row">${desktopSvgIcon('check', 13)}<span>Connected (${S.driveUser})</span></span>` : `<span class="dsm-warn-val desktop-inline-row">${desktopSvgIcon('alert', 13)}<span>Not signed in yet</span></span>`}</div>
        <div class="dsm-row"><strong>Native Disk PDF Cache:</strong> <span class="desktop-inline-row">${desktopSvgIcon('check', 13)}<span><strong>${_engineInfo.cachedPdfs ?? 0}</strong> PDFs cached locally</span></span></div>
        <div class="dsm-row"><strong>Permanent Page Vault:</strong> <span class="desktop-inline-row">${desktopSvgIcon('check', 13)}<span>Rendered pages &amp; text layers stay permanently vaulted</span></span></div>
        <div class="dsm-row"><strong>Local SQLite Mirror:</strong> <span class="desktop-inline-row">${desktopSvgIcon('check', 13)}<span><strong>${_engineInfo.sqliteNotes ?? 0}</strong> PDF notes/digests &amp; <strong>${_engineInfo.sqliteAnnNotes ?? 0}</strong> annotation notes mirrored</span></span></div>
        <div id="dsm-update-status">
          ${_updateInfo?.hasUpdate ? `<span class="dsm-warn-val desktop-inline-row">${desktopSvgIcon('sync', 13)}<strong>New GitHub Update Available: Build #${_updateInfo.remoteBuild}</strong></span>` : `<span class="dsm-ok-val desktop-inline-row">${desktopSvgIcon('check', 13)}<span>GitHub Auto-Updater active (checks on startup)</span></span>`}
        </div>
      </div>
      <div class="dsm-actions">
        ${!S.driveUser ? `<button id="dsm-gmail-login" class="dsm-btn dsm-btn--gold">${desktopSvgIcon('cloud', 13)}<span>Sign in with Google (Gmail)</span></button>` : ''}
        <button id="dsm-check-update" class="dsm-btn dsm-btn--primary">${desktopSvgIcon('sync', 13)}<span>Check for Updates</span></button>
        <button id="dsm-ok" class="dsm-btn">Close</button>
      </div>
    </div>
  `;
  modal.querySelector('#dsm-close')?.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.querySelector('#dsm-ok')?.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.querySelector('#dsm-gmail-login')?.addEventListener('click', async () => {
    modal.style.display = 'none';
    try { await driveSignIn(); } catch {}
  });
  modal.querySelector('#dsm-check-update')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const statusEl = modal.querySelector('#dsm-update-status');
    btn.disabled = true;
    btn.innerHTML = `${desktopSvgIcon('clock', 13)}<span>Checking GitHub…</span>`;
    const info = await checkAndNotifyGitHubUpdate(true);
    if (info?.hasUpdate) {
      if (statusEl) {
        statusEl.innerHTML = `<span class="dsm-accent-val desktop-inline-row">${desktopSvgIcon('sync', 13)}<strong>Update Found (Build #${info.remoteBuild})!</strong> Downloading &amp; restarting…</span>`;
      }
      btn.innerHTML = `${desktopSvgIcon('download', 13)}<span>Installing Update…</span>`;
      try {
        await invoke('desktop_apply_github_update', { downloadUrl: info.downloadUrl || null, expectedBuild: info.remoteBuild ?? null });
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = `${desktopSvgIcon('sync', 13)}<span>Retry Update</span>`;
        if (statusEl) statusEl.innerHTML = `<span class="dsm-err-val desktop-inline-row">${desktopSvgIcon('alert', 13)}<span>Update failed: ${err}</span></span>`;
      }
    } else {
      btn.disabled = false;
      btn.innerHTML = `${desktopSvgIcon('check', 13)}<span>Up to Date</span>`;
      if (statusEl) {
        statusEl.innerHTML = `<span class="dsm-ok-val desktop-inline-row">${desktopSvgIcon('check', 13)}<span>You are on the latest build (Build #${info?.localBuild ?? 2}).</span></span>`;
      }
    }
  });
}

window.openDesktopEngineStatus = showDesktopStatusModal;

// ── Settings → "App Version & Updates" card ──
// Shows this device's installed version/build next to the latest build published
// on GitHub, so it is obvious whether the laptop and this PC run the same version.
function injectSettingsVersionCard() {
  ensureDesktopBridgeStyles();
  const modal = document.getElementById('mo-settings');
  if (!modal || document.getElementById('settings-version-card')) return;
  const list = modal.querySelector('.modal-box > div[style*="flex-direction:column"]');
  if (!list) return;
  const card = document.createElement('div');
  card.id = 'settings-version-card';
  card.innerHTML = `
    <div class="svc-head">
      <strong class="svc-title">${desktopSvgIcon('tag', 13)}<span>App Version &amp; Updates</span></strong>
      <button id="svc-check" class="btn-sec desktop-inline-row" style="padding:3px 9px;font-size:11px;">${desktopSvgIcon('sync', 12)}<span>Check now</span></button>
    </div>
    <div>This device: <strong id="svc-local" class="svc-val">checking…</strong></div>
    <div>Latest published: <strong id="svc-remote" class="svc-val">checking…</strong></div>
    <div id="svc-status" style="margin-top:4px;"></div>
    <div class="svc-foot">
      <span>Automatic updates:</span>
      <button id="svc-toggle-auto" class="btn-sec desktop-inline-row" style="padding:2px 8px;font-size:11px;cursor:pointer;"></button>
    </div>`;
  list.prepend(card);
  card.querySelector('#svc-check').addEventListener('click', () => refreshSettingsVersionCard(true));

  const updateAutoBtn = () => {
    const enabled = isAutoUpdateEnabled();
    const tbtn = card.querySelector('#svc-toggle-auto');
    if (tbtn) {
      tbtn.innerHTML = enabled
        ? `${desktopSvgIcon('check', 12)}<span>Auto-Update: ON</span>`
        : `${desktopSvgIcon('pause', 12)}<span>Auto-Update: OFF</span>`;
      tbtn.style.color = enabled ? 'var(--cb-sage-text, var(--accent))' : 'var(--gilt, var(--ink-muted))';
      tbtn.title = enabled ? 'Click to pause automatic updates' : 'Click to enable automatic background updates';
    }
  };
  updateAutoBtn();
  card.querySelector('#svc-toggle-auto')?.addEventListener('click', () => {
    setAutoUpdateEnabled(!isAutoUpdateEnabled());
    updateAutoBtn();
  });

  // Re-check every time the Settings window is opened
  new MutationObserver(() => {
    if (modal.classList.contains('open')) refreshSettingsVersionCard(false);
  }).observe(modal, { attributes: true, attributeFilter: ['class'] });
}

let _svcBusy = false;
async function refreshSettingsVersionCard(manual) {
  const card = document.getElementById('settings-version-card');
  if (!card || _svcBusy) return;
  _svcBusy = true;
  const $ = sel => card.querySelector(sel);
  const btn = $('#svc-check');
  btn.disabled = true;
  btn.innerHTML = `${desktopSvgIcon('clock', 12)}<span>Checking…</span>`;
  try {
    const info = await checkAndNotifyGitHubUpdate(manual);
    if (!info) {
      $('#svc-local').textContent = 'unknown';
      $('#svc-remote').textContent = 'unknown';
      $('#svc-status').innerHTML = `<span class="dsm-err-val svc-status-line">${desktopSvgIcon('alert', 12)}<span>Could not run the update check.</span></span>`;
      return;
    }
    $('#svc-local').textContent = `v${info.localVersion} (Build #${info.localBuild})`;
    if (info.error || info.remoteBuild === undefined) {
      $('#svc-remote').textContent = 'unavailable';
      $('#svc-status').innerHTML = `<span class="dsm-warn-val svc-status-line">${desktopSvgIcon('alert', 12)}<span>Couldn't reach GitHub (offline?). Try again later.</span></span>`;
      return;
    }
    const when = info.updatedAt ? new Date(info.updatedAt).toLocaleString() : '';
    $('#svc-remote').textContent = `v${info.remoteVersion} (Build #${info.remoteBuild})${when ? ' — ' + when : ''}`;
    const status = $('#svc-status');
    if (info.remoteBuild > info.localBuild) {
      status.innerHTML = `<span class="dsm-warn-val svc-status-line">${desktopSvgIcon('sync', 12)}<span>Update available.</span></span> <button id="svc-install" class="btn-gold desktop-inline-row" style="padding:3px 10px;font-size:11px;margin-left:6px;">${desktopSvgIcon('download', 12)}<span>Install &amp; restart</span></button>`;
      status.querySelector('#svc-install').addEventListener('click', async e => {
        e.currentTarget.disabled = true;
        e.currentTarget.innerHTML = `${desktopSvgIcon('clock', 12)}<span>Downloading…</span>`;
        try {
          await invoke('desktop_apply_github_update', { downloadUrl: info.downloadUrl || null, expectedBuild: info.remoteBuild ?? null });
        } catch (err) {
          status.innerHTML = `<span class="dsm-err-val svc-status-line">${desktopSvgIcon('alert', 12)}<span>Update failed: ${err}</span></span>`;
        }
      });
    } else if (info.remoteBuild === info.localBuild) {
      status.innerHTML = `<span class="dsm-ok-val svc-status-line">${desktopSvgIcon('check', 12)}<span>Up to date — this device has the latest published version.</span></span>`;
    } else {
      status.innerHTML = `<span class="dsm-warn-val svc-status-line">${desktopSvgIcon('info', 12)}<span>This copy is newer than the version on GitHub. If an update was just published, GitHub may need a few minutes to catch up — press "Check now" again shortly.</span></span>`;
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${desktopSvgIcon('sync', 12)}<span>Check now</span>`;
    _svcBusy = false;
  }
}

async function initDesktopBridge() {
  const isPrintStudioQuery = new URLSearchParams(window.location.search || '').get('print-studio') === '1';
  let isPrintStudioMode = isPrintStudioQuery || !!document.getElementById('print-studio-app');
  if (!isPrintStudioMode && window.__DESKTOP_PRINT_STUDIO__?.getMode) {
    try {
      const mode = await window.__DESKTOP_PRINT_STUDIO__.getMode();
      if (mode?.isPrintStudio) isPrintStudioMode = true;
    } catch {}
  }
  if (isPrintStudioMode) return;

  injectDesktopUI();
  try { injectSettingsVersionCard(); } catch (e) { console.warn('[Desktop Bridge] version card error:', e); }
  if (invoke) {
    try {
      _engineInfo = await invoke('desktop_system_status');
    } catch (e) {
      console.warn('[Desktop Bridge] status error:', e);
    }
    // Automatically check GitHub for updates 2.5s after launch
    setTimeout(() => {
      checkAndNotifyGitHubUpdate(false);
    }, 2500);

    // Periodic automatic check every 15 minutes while running
    setInterval(() => {
      checkAndNotifyGitHubUpdate(false);
    }, 15 * 60 * 1000);

    // Check on window focus if more than 5 minutes have elapsed since last check
    window.addEventListener('focus', () => {
      if (Date.now() - _lastCheckTime > 5 * 60 * 1000) {
        checkAndNotifyGitHubUpdate(false);
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDesktopBridge);
} else {
  initDesktopBridge();
}
