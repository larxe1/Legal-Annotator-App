// ═════════════════════════════════════════════════════════════════════
// OCR — Standalone Scan-to-OCR Module for Scanned Legal PDFs
// Makes scanned PDFs searchable (Ctrl+F), selectable, and highlightable.
// 100% Local OCR: Windows Native OCR (Desktop) + Tesseract.js (Web).
// Modifies PDF binary with embedded invisible searchable text layer.
// ═════════════════════════════════════════════════════════════════════

import { S } from './state.js';
import { dbGetSetting, dbSetSetting } from './db.js';
import { safeStorageGet, safeStorageSet } from './storage.js';
import { openModal, closeModal, toast } from './ui.js';
import { driveFetchPDF, driveUpdatePDF } from './drive.js';

// ── In-Memory OCR Cache: trueId → { [pageNum]: { lines: [{ str, x, y, w, h, words }], fullText, updatedAt } }
const _ocrCache = {};

// ── Background Task & Worker State ──
let _tessPromise = null;
let _tessWorker = null;
let _pdfLibPromise = null;
let _isScanning = false;
let _scanCancelled = false;
let _measureCanvas = null;
let _measureCtx = null;

// ── Text Measurement Helper for Span Scale Matching ──
function getMeasureCtx() {
  if (!_measureCtx) {
    _measureCanvas = document.createElement('canvas');
    _measureCtx = _measureCanvas.getContext('2d');
  }
  return _measureCtx;
}

function computeSpanScaleX(str, fh, fontFam, targetWidthPx) {
  if (!str || !str.trim() || !(targetWidthPx > 0) || !(fh > 0)) return 1;
  const ctx = getMeasureCtx();
  if (!ctx) return 1;
  ctx.font = `${fh}px ${fontFam || 'sans-serif'}`;
  const naturalW = ctx.measureText(str).width;
  if (!(naturalW > 0)) return 1;
  const ratio = targetWidthPx / naturalW;
  if (!Number.isFinite(ratio) || ratio < 0.35 || ratio > 3.5) return 1;
  return Math.round(ratio * 10000) / 10000;
}

// ── Dynamic Tesseract.js Loader (Web Fallback) ──
export async function loadTesseract() {
  if (typeof window !== 'undefined' && window.Tesseract) {
    return window.Tesseract;
  }
  if (_tessPromise) return _tessPromise;

  _tessPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-lib="tesseract"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.Tesseract));
      existing.addEventListener('error', e => reject(new Error('Failed to load Tesseract.js: ' + e)));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    script.async = true;
    script.dataset.lib = 'tesseract';
    script.onload = () => {
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error('Tesseract script loaded but window.Tesseract is not defined'));
    };
    script.onerror = () => reject(new Error('Network error loading Tesseract.js CDN. Please check your internet connection.'));
    document.head.appendChild(script);
  });

  return _tessPromise;
}

// ── Tesseract Worker Lifecycle Helper ──
async function getTessWorker(onProgress) {
  const T = await loadTesseract();
  if (_tessWorker) return _tessWorker;
  if (typeof T.createWorker === 'function') {
    try {
      _tessWorker = await T.createWorker('eng', 1, {
        logger: m => {
          if (onProgress && m.status === 'recognizing text' && typeof m.progress === 'number') {
            onProgress(m.progress);
          }
        }
      });
      return _tessWorker;
    } catch (err) {
      console.warn('[OCR] Tesseract createWorker failed, falling back to direct recognize:', err);
      return null;
    }
  }
  return null;
}

// ── Dynamic pdf-lib Loader ──
export async function loadPdfLib() {
  if (typeof window !== 'undefined' && window.PDFLib) {
    return window.PDFLib;
  }
  if (_pdfLibPromise) return _pdfLibPromise;

  _pdfLibPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-lib="pdf-lib"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.PDFLib));
      existing.addEventListener('error', e => reject(new Error('Failed to load pdf-lib: ' + e)));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
    script.async = true;
    script.dataset.lib = 'pdf-lib';
    script.onload = () => {
      if (window.PDFLib) resolve(window.PDFLib);
      else reject(new Error('pdf-lib loaded but window.PDFLib is undefined'));
    };
    script.onerror = () => reject(new Error('Network error loading pdf-lib CDN.'));
    document.head.appendChild(script);
  });

  return _pdfLibPromise;
}

// ── WinAnsi Sanitizer for pdf-lib text drawing ──
function sanitizeForPdfLib(text) {
  if (!text) return '';
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ')
    .trim();
}

// ── True ID Helper (Links vs Physical PDFs) ──
function getTruePdfId(customPdf = null) {
  const pdf = customPdf || S.curPDF;
  if (!pdf) return null;
  return pdf.linked_pdf_id || pdf.id || null;
}

// ═════════════════════════════════════════════════════════════════════
// PERSISTENCE & CACHE API
// ═════════════════════════════════════════════════════════════════════

// ── Read OCR Data for Page ──
export function getOcrPageData(trueId, pageNum) {
  const tid = trueId || getTruePdfId();
  if (!tid || !pageNum) return null;

  // 1. In-memory cache
  if (_ocrCache[tid]?.[pageNum]) {
    return _ocrCache[tid][pageNum];
  }

  // 2. LocalStorage cache
  try {
    const raw = safeStorageGet('ocr_cache_' + tid);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!_ocrCache[tid]) _ocrCache[tid] = {};
      Object.assign(_ocrCache[tid], parsed);
      return _ocrCache[tid][pageNum] || null;
    }
  } catch (e) {
    console.warn('[OCR] Error reading local OCR cache:', e);
  }

  return null;
}

// ── Read Full Text for Page ──
export function getOcrPageText(trueId, pageNum) {
  const data = getOcrPageData(trueId, pageNum);
  if (!data) return '';
  if (data.fullText) return data.fullText;
  if (Array.isArray(data.lines) && data.lines.length) {
    return data.lines.map(l => l.str || '').filter(Boolean).join('\n');
  }
  return '';
}

// ── Check if Page Has OCR Data ──
export function hasOcrData(trueId, pageNum) {
  const data = getOcrPageData(trueId, pageNum);
  return !!(data && (data.fullText || (data.lines && data.lines.length > 0)));
}

// ── Save Page OCR Data (Memory + LocalStorage + Desktop Vault + Supabase) ──
export async function saveOcrPageData(trueId, pageNum, pageResult) {
  const tid = trueId || getTruePdfId();
  if (!tid || !pageNum || !pageResult) return;

  if (!_ocrCache[tid]) _ocrCache[tid] = {};
  _ocrCache[tid][pageNum] = {
    lines: pageResult.lines || [],
    fullText: pageResult.fullText || '',
    updatedAt: Date.now()
  };

  // 1. LocalStorage
  const serialized = JSON.stringify(_ocrCache[tid]);
  safeStorageSet('ocr_cache_' + tid, serialized);

  // 2. Desktop Vault (if running in Desktop App)
  if (typeof window !== 'undefined' && window.__DESKTOP_PDFIUM__?.savePageText) {
    try {
      window.__DESKTOP_PDFIUM__.savePageText(tid, pageNum, 'ocr', {
        lines: pageResult.lines || [],
        fullText: pageResult.fullText || '',
        updatedAt: Date.now()
      });
    } catch (e) {
      console.warn('[OCR] Failed to save page text to Desktop Vault:', e);
    }
  }

  // 3. Supabase Cloud Sync (fire and forget / async)
  dbSetSetting('ocr_cache_' + tid, serialized).catch(err => {
    console.warn('[OCR] Failed to sync OCR cache to Supabase:', err);
  });

  // 4. Update global search text cache for instant Ctrl+F search
  if (!S.pageTextCache) S.pageTextCache = {};
  S.pageTextCache[pageNum] = _ocrCache[tid][pageNum].fullText ||
    _ocrCache[tid][pageNum].lines.map(l => l.str).join('\n');

  // 5. Apply to currently rendered page if active
  applyOcrToRenderedPage(pageNum, tid);
}

// ── Load OCR Data for PDF (LocalStorage, Desktop Vault & Supabase) ──
export async function loadOcrForCurrentPdf(trueId = null) {
  const tid = trueId || getTruePdfId();
  if (!tid) return {};

  // 1. Initial hydrate from local storage for instant responsiveness
  try {
    const rawLocal = safeStorageGet('ocr_cache_' + tid);
    if (rawLocal) {
      const parsedLocal = JSON.parse(rawLocal);
      if (!_ocrCache[tid]) _ocrCache[tid] = {};
      Object.assign(_ocrCache[tid], parsedLocal);
    }
  } catch (e) {
    console.warn('[OCR] Failed reading local snapshot:', e);
  }

  // 2. Desktop Vault Hydration (if running in Desktop App)
  if (typeof window !== 'undefined' && window.__DESKTOP_PDFIUM__?.getPageText && S.totalPages) {
    try {
      for (let p = 1; p <= S.totalPages; p++) {
        if (!_ocrCache[tid]?.[p]) {
          const dText = await window.__DESKTOP_PDFIUM__.getPageText(tid, p, 'ocr').catch(() => null);
          if (dText) {
            if (!_ocrCache[tid]) _ocrCache[tid] = {};
            _ocrCache[tid][p] = dText;
          }
        }
      }
    } catch (vaultErr) {
      console.warn('[OCR] Desktop vault hydration notice:', vaultErr);
    }
  }

  // 3. Sync from Supabase in background
  try {
    const remoteVal = await dbGetSetting('ocr_cache_' + tid);
    if (remoteVal) {
      const parsedRemote = typeof remoteVal === 'string' ? JSON.parse(remoteVal) : remoteVal;
      if (!_ocrCache[tid]) _ocrCache[tid] = {};

      for (const [pgKey, rData] of Object.entries(parsedRemote)) {
        const lData = _ocrCache[tid][pgKey];
        if (!lData || (rData.updatedAt && (!lData.updatedAt || rData.updatedAt > lData.updatedAt))) {
          _ocrCache[tid][pgKey] = rData;
        }
      }
      safeStorageSet('ocr_cache_' + tid, JSON.stringify(_ocrCache[tid]));
    }
  } catch (err) {
    console.warn('[OCR] Remote OCR fetch failed, using local cache:', err);
  }

  // 4. Hydrate S.pageTextCache and apply to all currently rendered pages
  const pdfOcr = _ocrCache[tid] || {};
  if (!S.pageTextCache) S.pageTextCache = {};

  for (const [pgStr, pData] of Object.entries(pdfOcr)) {
    const pNum = Number(pgStr);
    if (!pNum) continue;
    const pageText = pData.fullText || (pData.lines || []).map(l => l.str).join('\n') || '';
    S.pageTextCache[pNum] = pageText;

    if (S.pages?.[pNum]?.rendered) {
      applyOcrToRenderedPage(pNum, tid);
    }
  }

  return pdfOcr;
}

// ═════════════════════════════════════════════════════════════════════
// RENDER & TEXT-LAYER INJECTION (SEARCH, SELECTION, HIGHLIGHTING)
// ═════════════════════════════════════════════════════════════════════

// ── Populate pgState.txtLayer and pgState.textItems with Positioned OCR Spans ──
export function applyOcrToRenderedPage(pageNum, trueId = null) {
  const tid = trueId || getTruePdfId();
  if (!tid || !pageNum) return false;

  const pgState = S.pages?.[pageNum];
  if (!pgState || !pgState.rendered || !pgState.txtLayer) return false;

  const ocrData = getOcrPageData(tid, pageNum);
  if (!ocrData || !Array.isArray(ocrData.lines) || ocrData.lines.length === 0) {
    return false;
  }

  // Determine whether page needs OCR overlay:
  // Either native text layer is empty (scanned page) or already populated with OCR spans
  const hasNativeText = pgState.textItems && pgState.textItems.length > 0 && !pgState.textItems.some(i => i.ocr);
  if (hasNativeText) {
    // Page has native digital text; do not overwrite unless no text is present
    return false;
  }

  const scale = S.scale || 1.5;
  const txtLayer = pgState.txtLayer;

  // Clear existing OCR spans to avoid duplication
  const oldOcrSpans = txtLayer.querySelectorAll('[data-ocr="true"]');
  oldOcrSpans.forEach(el => el.remove());

  // Also clear empty native spans if this is a scanned page with blank spans
  if (!hasNativeText && (!pgState.textItems || pgState.textItems.length === 0 || pgState.textItems.every(i => i.ocr))) {
    txtLayer.innerHTML = '';
  }

  const newTextItems = [];
  const fragment = document.createDocumentFragment();

  for (const line of ocrData.lines) {
    if (!line.str || !line.str.trim()) continue;

    const sx = (line.x || 0) * scale;
    const sy = (line.y || 0) * scale;
    const sw = (line.w || 0) * scale;
    const sh = (line.h || 14) * scale;
    const fh = Math.max(9, Math.round(sh * 0.82));
    const fontFam = 'sans-serif';
    const scaleX = computeSpanScaleX(line.str, fh, fontFam, sw);

    const span = document.createElement('span');
    span.textContent = line.str;
    span.dataset.ocr = 'true';
    span.style.cssText = `position:absolute;left:${sx}px;top:${sy}px;width:${sw}px;height:${sh}px;font-size:${fh}px;line-height:${sh}px;font-family:${fontFam};color:transparent;white-space:pre;transform-origin:0% 0%;pointer-events:all;user-select:text;-webkit-user-select:text;cursor:text;`;

    if (scaleX && Math.abs(scaleX - 1) > 0.005) {
      span.style.transform = `scaleX(${scaleX})`;
    }

    fragment.appendChild(span);

    newTextItems.push({
      str: line.str,
      x: sx,
      y: sy,
      w: sw,
      h: sh,
      ocr: true,
    });
  }

  txtLayer.appendChild(fragment);
  pgState.textItems = newTextItems;

  // Ensure text selection layer respects current interaction mode
  if (S.mode === 'text') {
    txtLayer.classList.add('sel');
  }

  // Update search cache for page
  if (!S.pageTextCache) S.pageTextCache = {};
  S.pageTextCache[pageNum] = ocrData.fullText || ocrData.lines.map(l => l.str).join('\n');

  return true;
}

// ═════════════════════════════════════════════════════════════════════
// OCR ENGINES (ENGINE 1: WINDOWS NATIVE OCR, ENGINE 2: TESSERACT.JS)
// ═════════════════════════════════════════════════════════════════════

// ── Render PDF Page to Offscreen High-Res Canvas (Web Tesseract Fallback) ──
async function renderPageToOffscreenCanvas(pageNum, renderScale = 2.0) {
  if (!S.pdfDoc) throw new Error('No PDF document loaded');
  const page = await S.pdfDoc.getPage(pageNum);
  const vp = page.getViewport({ scale: renderScale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, renderScale, vp };
}

// ── Web Fallback Engine: Local Tesseract.js Recognition ──
async function runTesseractEngine(canvas, renderScale, onProgress = null) {
  const worker = await getTessWorker(onProgress);
  let data = null;

  if (worker) {
    const res = await worker.recognize(canvas);
    data = res.data;
  } else {
    const T = await loadTesseract();
    const res = await T.recognize(canvas, 'eng', {
      logger: m => {
        if (onProgress && m.status === 'recognizing text' && typeof m.progress === 'number') {
          onProgress(m.progress);
        }
      }
    });
    data = res.data;
  }

  if (!data) throw new Error('Tesseract returned no recognition data');

  const lines = [];
  const rawLines = data.lines || [];

  for (const rawLine of rawLines) {
    const text = (rawLine.text || '').replace(/\r?\n/g, ' ').trim();
    if (!text) continue;

    const b = rawLine.bbox || { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height };
    const x = Math.round((b.x0 / renderScale) * 10) / 10;
    const y = Math.round((b.y0 / renderScale) * 10) / 10;
    const w = Math.round(((b.x1 - b.x0) / renderScale) * 10) / 10;
    const h = Math.round(((b.y1 - b.y0) / renderScale) * 10) / 10;

    const words = (rawLine.words || []).map(wItem => {
      const wb = wItem.bbox || b;
      return {
        str: (wItem.text || '').trim(),
        x: Math.round((wb.x0 / renderScale) * 10) / 10,
        y: Math.round((wb.y0 / renderScale) * 10) / 10,
        w: Math.round(((wb.x1 - wb.x0) / renderScale) * 10) / 10,
        h: Math.round(((wb.y1 - wb.y0) / renderScale) * 10) / 10,
      };
    }).filter(wItem => wItem.str);

    lines.push({ str: text, x, y, w, h, words });
  }

  // Fallback: If no structured lines returned but text exists
  if (lines.length === 0 && data.text && data.text.trim()) {
    const pageW = canvas.width / renderScale;
    const pageH = canvas.height / renderScale;
    const splitLines = data.text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const estH = Math.max(14, pageH / Math.max(splitLines.length + 2, 35));

    splitLines.forEach((str, idx) => {
      lines.push({
        str,
        x: 40,
        y: 40 + idx * (estH + 4),
        w: pageW - 80,
        h: estH,
      });
    });
  }

  const fullText = lines.map(l => l.str).join('\n') || (data.text || '').trim();
  return { lines, fullText };
}

// ── Single Page OCR Runner (Desktop Native OCR or Tesseract Web Fallback) ──
export async function scanPage(pageNum, options = {}) {
  const { onProgress = null } = options;
  const tid = getTruePdfId();
  if (!tid) throw new Error('No active PDF open to scan');
  if (!S.pdfDoc) throw new Error('No PDF document loaded');

  const isDesktopOcr = typeof window !== 'undefined' && typeof window.__DESKTOP_PDFIUM__?.ocrPage === 'function';

  let lines = [];
  let fullText = '';

  if (isDesktopOcr) {
    if (onProgress) onProgress({ status: 'recognizing_native', page: pageNum, pct: 25 });
    const docId = S.pdfDoc._desktopDocId || tid;
    const raw = await window.__DESKTOP_PDFIUM__.ocrPage(docId, pageNum, 1600, 2200);

    if (onProgress) onProgress({ status: 'parsing', page: pageNum, pct: 70 });
    const page = await S.pdfDoc.getPage(pageNum);
    const vp1 = page.getViewport({ scale: 1.0 });

    const rawLines = Array.isArray(raw?.lines) ? raw.lines : (Array.isArray(raw) ? raw : []);
    for (const rLine of rawLines) {
      const str = (rLine.str || rLine.text || '').replace(/\r?\n/g, ' ').trim();
      if (!str) continue;
      const rx = typeof rLine.rx === 'number' ? rLine.rx : (typeof rLine.x === 'number' ? rLine.x : 0);
      const ry = typeof rLine.ry === 'number' ? rLine.ry : (typeof rLine.y === 'number' ? rLine.y : 0);
      const rw = typeof rLine.rw === 'number' ? rLine.rw : (typeof rLine.w === 'number' ? rLine.w : 0);
      const rh = typeof rLine.rh === 'number' ? rLine.rh : (typeof rLine.h === 'number' ? rLine.h : 0);

      const x = Math.round(rx * vp1.width * 10) / 10;
      const y = Math.round(ry * vp1.height * 10) / 10;
      const w = Math.round(rw * vp1.width * 10) / 10;
      const h = Math.round(rh * vp1.height * 10) / 10;

      const rawWords = Array.isArray(rLine.words) ? rLine.words : [];
      const words = rawWords.map(wItem => {
        const wrx = typeof wItem.rx === 'number' ? wItem.rx : (typeof wItem.x === 'number' ? wItem.x : rx);
        const wry = typeof wItem.ry === 'number' ? wItem.ry : (typeof wItem.y === 'number' ? wItem.y : ry);
        const wrw = typeof wItem.rw === 'number' ? wItem.rw : (typeof wItem.w === 'number' ? wItem.w : rw);
        const wrh = typeof wItem.rh === 'number' ? wItem.rh : (typeof wItem.h === 'number' ? wItem.h : rh);
        return {
          str: (wItem.str || wItem.text || '').trim(),
          x: Math.round(wrx * vp1.width * 10) / 10,
          y: Math.round(wry * vp1.height * 10) / 10,
          w: Math.round(wrw * vp1.width * 10) / 10,
          h: Math.round(wrh * vp1.height * 10) / 10,
        };
      }).filter(wItem => wItem.str);

      lines.push({ str, x, y, w, h, words });
    }

    fullText = (raw?.fullText || raw?.text || lines.map(l => l.str).join('\n')).trim();
  } else {
    // Web Fallback: Local Tesseract.js v5
    if (onProgress) onProgress({ status: 'rendering', page: pageNum, pct: 10 });
    const { canvas, renderScale } = await renderPageToOffscreenCanvas(pageNum, 2.0);

    if (onProgress) onProgress({ status: 'recognizing', page: pageNum, pct: 30 });
    const localResult = await runTesseractEngine(canvas, renderScale, subPct => {
      if (onProgress) {
        const overall = 30 + Math.round(subPct * 55);
        onProgress({ status: 'recognizing', page: pageNum, pct: overall });
      }
    });

    lines = localResult.lines;
    fullText = localResult.fullText;
  }

  // Persist and apply
  if (onProgress) onProgress({ status: 'saving', page: pageNum, pct: 95 });
  await saveOcrPageData(tid, pageNum, { lines, fullText });

  if (onProgress) onProgress({ status: 'done', page: pageNum, pct: 100 });
  return { pageNum, lines, fullText };
}

// ═════════════════════════════════════════════════════════════════════
// PDF BINARY EMBEDDER & DRIVE SYNC
// ═════════════════════════════════════════════════════════════════════

// ── Modify PDF Binary with Embedded Invisible Searchable Text Layer ──
export async function embedOcrIntoPdfAndSync(trueId = null) {
  const tid = trueId || getTruePdfId();
  if (!tid) return { ok: false, error: 'No active PDF' };

  const pageDataMap = _ocrCache[tid];
  if (!pageDataMap || Object.keys(pageDataMap).length === 0) {
    return { ok: false, error: 'No OCR data found to embed' };
  }

  // 1. Load pdf-lib on demand
  const { PDFDocument, StandardFonts } = await loadPdfLib();

  // 2. Fetch current PDF bytes via driveFetchPDF
  const targetDriveId = S.curPDF?.drive_file_id ||
    (S.curPDF?.linked_pdf_id ? S.pdfs.find(p => p.id === S.curPDF.linked_pdf_id)?.drive_file_id : null) ||
    tid;

  let pdfBytes = null;
  try {
    const blobOrBuf = await driveFetchPDF(targetDriveId, null, S.curPDF?.name || 'document.pdf');
    if (blobOrBuf instanceof Blob) {
      pdfBytes = await blobOrBuf.arrayBuffer();
    } else if (blobOrBuf instanceof ArrayBuffer) {
      pdfBytes = blobOrBuf;
    } else if (blobOrBuf?.buffer instanceof ArrayBuffer) {
      pdfBytes = blobOrBuf.buffer;
    }
  } catch (err) {
    console.warn('[OCR] driveFetchPDF notice in embedOcrIntoPdfAndSync, checking fallback cache:', err);
    if (S.pdfCache[targetDriveId]) {
      const b = S.pdfCache[targetDriveId];
      pdfBytes = (b instanceof Blob) ? await b.arrayBuffer() : b;
    }
  }

  if (!pdfBytes) {
    throw new Error('Could not retrieve PDF binary data to embed OCR text layer');
  }

  // 3. Load PDF with pdf-lib
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const totalDocPages = pdfDoc.getPageCount();

  // 4. Iterate over every page that has OCR data
  let embeddedCount = 0;
  for (const [pgStr, pData] of Object.entries(pageDataMap)) {
    const pageNum = Number(pgStr);
    if (!pageNum || pageNum < 1 || pageNum > totalDocPages) continue;
    const lines = pData?.lines || [];
    if (!lines.length) continue;

    const page = pdfDoc.getPage(pageNum - 1); // 0-indexed in pdf-lib
    const { width: pageWidth, height: pageHeight } = page.getSize();

    for (const line of lines) {
      const str = sanitizeForPdfLib(line.str);
      if (!str) continue;

      const x = typeof line.x === 'number' ? line.x : 0;
      const y = typeof line.y === 'number' ? line.y : 0;
      const h = (typeof line.h === 'number' && line.h > 0) ? line.h : 14;

      const fontSize = Math.max(6, Math.min(24, h * 0.85));
      const pdfY = pageHeight - y - h;

      try {
        page.drawText(str, {
          x: Math.max(0, x),
          y: Math.max(0, pdfY),
          size: fontSize,
          font: font,
          opacity: 0.001, // invisible to the eye, 100% selectable and searchable
        });
      } catch (drawErr) {
        console.warn(`[OCR] drawText skipped unencodable line on page ${pageNum}:`, drawErr.message);
      }
    }
    embeddedCount++;
  }

  // 5. Save modified PDF bytes and wrap in Blob
  const modifiedBytes = await pdfDoc.save();
  const modifiedBlob = new Blob([modifiedBytes], { type: 'application/pdf' });
  const pdfName = S.curPDF?.name || 'document.pdf';

  // 6. Overwrite RAM cache, IndexedDB, Desktop Vault, and Google Drive
  const syncRes = await driveUpdatePDF(targetDriveId, modifiedBlob, pdfName);

  return { ok: true, embeddedPages: embeddedCount, updatedDrive: syncRes?.updatedDrive };
}

// ═════════════════════════════════════════════════════════════════════
// BATCH OCR SCANNER & RANGE PARSER
// ═════════════════════════════════════════════════════════════════════

export function parsePageRange(rangeStr, totalPages) {
  if (!rangeStr || !rangeStr.trim()) return [];
  const max = totalPages || 9999;
  const pages = new Set();
  const parts = rangeStr.split(/[,;\s]+/);

  for (const part of parts) {
    if (!part) continue;
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end)) {
        const lo = Math.max(1, Math.min(start, end));
        const hi = Math.min(max, Math.max(start, end));
        for (let p = lo; p <= hi; p++) pages.add(p);
      }
    } else {
      const p = parseInt(part, 10);
      if (!isNaN(p) && p >= 1 && p <= max) {
        pages.add(p);
      }
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
}

export async function detectScannedPages(doc = S.pdfDoc, maxPages = S.totalPages) {
  if (!doc || !maxPages) return [];
  const scanned = [];

  for (let p = 1; p <= maxPages; p++) {
    try {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const hasText = tc.items && tc.items.some(i => i.str && i.str.trim().length > 0);
      if (!hasText) {
        scanned.push(p);
      }
    } catch {
      scanned.push(p);
    }
  }
  return scanned;
}

// ═════════════════════════════════════════════════════════════════════
// INTERACTIVE SCAN-TO-OCR MODAL UI
// ═════════════════════════════════════════════════════════════════════

const MODAL_ID = 'mo-ocr-tool';

export function initOcrTool() {
  if (document.getElementById(MODAL_ID)) return;

  const modalHtml = `
  <div class="modal-ov" id="${MODAL_ID}">
    <div class="modal-box" style="width:520px;max-width:94vw;max-height:90vh;display:flex;flex-direction:column;padding:22px;gap:14px;box-sizing:border-box;">
      
      <!-- Header -->
      <div style="display:flex;align-items:flex-start;justify-content:space-between;border-bottom:1px solid var(--navy-b,#22334d);padding-bottom:12px;">
        <div>
          <h3 style="margin:0;font-family:'Libre Baskerville',serif;font-size:18px;color:var(--gold,#c9a84c);display:flex;align-items:center;gap:8px;">
            <span>🔍</span> Scan-to-OCR
          </h3>
          <p style="margin:4px 0 0 0;font-size:12px;color:var(--muted,#8ea0b8);line-height:1.4;">
            Make scanned legal PDFs searchable (<kbd style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;">Ctrl+F</kbd>), selectable, and highlightable.
          </p>
        </div>
        <button id="ocr-btn-close-x" style="background:none;border:none;color:var(--muted,#8ea0b8);font-size:18px;cursor:pointer;padding:4px;" title="Close">✕</button>
      </div>

      <!-- Scope Options -->
      <div style="display:flex;flex-direction:column;gap:8px;">
        <label style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--muted,#8ea0b8);letter-spacing:0.5px;">1. Select Pages to Scan</label>
        
        <div style="display:flex;flex-direction:column;gap:6px;background:rgba(0,0,0,0.2);padding:10px 12px;border-radius:8px;border:1px solid var(--navy-b,#22334d);">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text,#e2e8f0);">
            <input type="radio" name="ocr-scope" value="current" checked style="accent-color:var(--gold,#c9a84c);">
            <span id="ocr-label-scope-current">Current Page (Page 1)</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text,#e2e8f0);">
            <input type="radio" name="ocr-scope" value="scanned" style="accent-color:var(--gold,#c9a84c);">
            <span>All Scanned Pages (Auto-Detect pages without text)</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text,#e2e8f0);">
            <input type="radio" name="ocr-scope" value="all" style="accent-color:var(--gold,#c9a84c);">
            <span id="ocr-label-scope-all">All Pages in PDF</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;color:var(--text,#e2e8f0);">
            <input type="radio" name="ocr-scope" value="custom" style="accent-color:var(--gold,#c9a84c);">
            <span>Custom Page Range:</span>
          </label>
          <input type="text" id="ocr-scope-range" placeholder="e.g. 1-15, 18, 22-30" style="margin-left:22px;padding:6px 10px;background:var(--navy-d,#0b111e);border:1px solid var(--navy-b,#22334d);border-radius:6px;color:var(--text,#e2e8f0);font-size:12px;font-family:monospace;outline:none;" disabled>
        </div>
      </div>

      <!-- Engine & Features -->
      <div style="display:flex;flex-direction:column;gap:8px;">
        <label style="font-size:11px;font-weight:600;text-transform:uppercase;color:var(--muted,#8ea0b8);letter-spacing:0.5px;">2. OCR Engine (100% Local & Offline)</label>
        
        <div style="display:flex;flex-direction:column;gap:8px;background:rgba(0,0,0,0.2);padding:10px 12px;border-radius:8px;border:1px solid var(--navy-b,#22334d);">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="font-size:22px;">⚡</div>
            <div style="flex:1;">
              <div style="display:flex;align-items:center;gap:6px;">
                <strong id="ocr-engine-title" style="color:var(--gold,#c9a84c);">Windows Native OCR</strong>
                <span id="ocr-engine-badge" style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(34,197,94,0.15);color:#4ade80;border:1px solid rgba(34,197,94,0.3);">Hardware Accelerated</span>
              </div>
              <span id="ocr-engine-desc" style="font-size:11px;color:var(--muted,#8ea0b8);display:block;margin-top:2px;">100% Offline C++/Rust • Zero API keys • Word bounding boxes • Searchable text embedded into PDF</span>
            </div>
          </div>

          <div style="border-top:1px solid var(--navy-b,#22334d);padding-top:8px;margin-top:2px;display:flex;flex-direction:column;gap:6px;">
            <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text,#e2e8f0);">
              <input type="checkbox" id="ocr-opt-apply" checked disabled style="accent-color:var(--gold,#c9a84c);">
              <span>Apply Searchable Layer in App, Embed in PDF & Sync to Cloud</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text,#e2e8f0);cursor:pointer;">
              <input type="checkbox" id="ocr-opt-skip" checked style="accent-color:var(--gold,#c9a84c);">
              <span>Skip pages already OCR-scanned</span>
            </label>
          </div>
        </div>
      </div>

      <!-- Live Progress Bar & Status -->
      <div id="ocr-progress-container" style="display:none;flex-direction:column;gap:6px;background:rgba(0,0,0,0.3);padding:12px;border-radius:8px;border:1px solid var(--navy-b,#22334d);">
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;">
          <span id="ocr-progress-label" style="color:var(--gold,#c9a84c);font-weight:600;">Scanning…</span>
          <span id="ocr-progress-pct" style="color:var(--muted,#8ea0b8);font-family:monospace;">0%</span>
        </div>
        <div style="width:100%;height:8px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden;">
          <div id="ocr-progress-bar" style="width:0%;height:100%;background:var(--gold,#c9a84c);transition:width 0.2s ease;"></div>
        </div>
        <div id="ocr-progress-detail" style="font-size:11px;color:var(--muted,#8ea0b8);">Initializing recognition engine…</div>
      </div>

      <!-- Modal Footer / Actions -->
      <div style="display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--navy-b,#22334d);padding-top:14px;margin-top:4px;">
        <button id="ocr-btn-download" style="padding:7px 12px;font-size:12px;background:var(--navy-m,#162032);border:1px solid var(--navy-b,#22334d);color:var(--text,#e2e8f0);border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:6px;" title="Download recognized text report as a text file">
          <span>📄</span> Download Text Report
        </button>

        <div style="display:flex;gap:8px;">
          <button id="ocr-btn-cancel" class="btn-sec" style="padding:7px 14px;font-size:12px;border-radius:6px;cursor:pointer;">Close</button>
          <button id="ocr-btn-start" class="btn-gold" style="padding:7px 18px;font-size:12px;border-radius:6px;cursor:pointer;font-weight:600;">Start OCR Scan</button>
        </div>
      </div>

    </div>
  </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);
  wireOcrToolModalEvents();
}

function wireOcrToolModalEvents() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;

  const btnCloseX = document.getElementById('ocr-btn-close-x');
  const btnCancel = document.getElementById('ocr-btn-cancel');
  const btnStart = document.getElementById('ocr-btn-start');
  const btnDownload = document.getElementById('ocr-btn-download');
  const scopeRangeInput = document.getElementById('ocr-scope-range');
  const radioScopes = modal.querySelectorAll('input[name="ocr-scope"]');

  // Backdrop click to close (only when not scanning)
  modal.addEventListener('mousedown', e => {
    if (e.target === modal && !_isScanning) {
      closeModal(MODAL_ID);
    }
  });

  // Scope radio toggle handler
  radioScopes.forEach(r => {
    r.addEventListener('change', () => {
      scopeRangeInput.disabled = (r.value !== 'custom');
      if (r.value === 'custom') scopeRangeInput.focus();
    });
  });

  // Close / Cancel handlers
  const handleClose = () => {
    if (_isScanning) {
      _scanCancelled = true;
      btnCancel.textContent = 'Stopping…';
      btnCancel.disabled = true;
      toast('Stopping OCR scan…');
    } else {
      closeModal(MODAL_ID);
    }
  };

  btnCloseX?.addEventListener('click', handleClose);
  btnCancel?.addEventListener('click', handleClose);

  // Start button handler
  btnStart?.addEventListener('click', async () => {
    if (_isScanning) return;
    await executeOcrWorkflow();
  });

  // Download Report handler
  btnDownload?.addEventListener('click', () => {
    downloadOcrReport();
  });
}

// ── Open and Populate the Modal ──
export function openOcrToolModal() {
  initOcrTool();

  if (!S.pdfDoc || !S.curPDF) {
    toast('⚠️ Please open a PDF in the viewer first to scan.');
    return;
  }

  const tid = getTruePdfId();
  const modal = document.getElementById(MODAL_ID);
  if (!modal) return;

  // Refresh labels
  const curPage = S.curPage || 1;
  const totalPages = S.totalPages || 1;

  const labelCurrent = document.getElementById('ocr-label-scope-current');
  if (labelCurrent) labelCurrent.textContent = `Current Page (Page ${curPage})`;

  const labelAll = document.getElementById('ocr-label-scope-all');
  if (labelAll) labelAll.textContent = `All Pages in PDF (1 to ${totalPages})`;

  const scopeRangeInput = document.getElementById('ocr-scope-range');
  if (scopeRangeInput) {
    scopeRangeInput.value = `${curPage}-${Math.min(curPage + 10, totalPages)}`;
  }

  // Refresh Engine display based on Desktop capability
  const isDesktop = typeof window !== 'undefined' && typeof window.__DESKTOP_PDFIUM__?.ocrPage === 'function';
  const engineTitle = document.getElementById('ocr-engine-title');
  const engineBadge = document.getElementById('ocr-engine-badge');
  const engineDesc = document.getElementById('ocr-engine-desc');

  if (engineTitle && engineBadge && engineDesc) {
    if (isDesktop) {
      engineTitle.textContent = 'Windows Native OCR (Desktop)';
      engineBadge.textContent = 'Hardware Accelerated (~10 pgs/sec)';
      engineBadge.style.color = '#4ade80';
      engineBadge.style.borderColor = 'rgba(34,197,94,0.3)';
      engineBadge.style.background = 'rgba(34,197,94,0.15)';
      engineDesc.textContent = '100% Offline C++/Rust • Zero API keys • Word bounding boxes • Searchable text embedded into PDF';
    } else {
      engineTitle.textContent = 'Tesseract Local OCR (In-Browser)';
      engineBadge.textContent = 'WebAssembly Engine (100% Offline)';
      engineBadge.style.color = 'var(--gold,#c9a84c)';
      engineBadge.style.borderColor = 'rgba(201,168,76,0.3)';
      engineBadge.style.background = 'rgba(201,168,76,0.15)';
      engineDesc.textContent = 'Client-side recognition • Zero API keys • Word bounding boxes • Searchable text embedded into PDF';
    }
  }

  // Refresh download button state
  const btnDownload = document.getElementById('ocr-btn-download');
  if (btnDownload) {
    const hasAnyOcr = _ocrCache[tid] && Object.keys(_ocrCache[tid]).length > 0;
    btnDownload.disabled = !hasAnyOcr;
    btnDownload.style.opacity = hasAnyOcr ? '1' : '0.5';
  }

  // Reset progress UI
  const progressBox = document.getElementById('ocr-progress-container');
  if (progressBox) progressBox.style.display = 'none';

  const btnStart = document.getElementById('ocr-btn-start');
  if (btnStart) {
    btnStart.disabled = false;
    btnStart.textContent = 'Start OCR Scan';
  }

  const btnCancel = document.getElementById('ocr-btn-cancel');
  if (btnCancel) {
    btnCancel.disabled = false;
    btnCancel.textContent = 'Close';
  }

  openModal(MODAL_ID);
}

// ── Execute Batch Scanning Workflow ──
async function executeOcrWorkflow() {
  const modal = document.getElementById(MODAL_ID);
  if (!modal || !S.pdfDoc) return;

  const tid = getTruePdfId();
  if (!tid) return;

  // 1. Determine Scope
  const selectedScope = modal.querySelector('input[name="ocr-scope"]:checked')?.value || 'current';
  const totalPages = S.totalPages || 1;
  let targetPages = [];

  const progressBox = document.getElementById('ocr-progress-container');
  const progressLabel = document.getElementById('ocr-progress-label');
  const progressPct = document.getElementById('ocr-progress-pct');
  const progressBar = document.getElementById('ocr-progress-bar');
  const progressDetail = document.getElementById('ocr-progress-detail');
  const btnStart = document.getElementById('ocr-btn-start');
  const btnCancel = document.getElementById('ocr-btn-cancel');
  const btnDownload = document.getElementById('ocr-btn-download');

  if (selectedScope === 'current') {
    targetPages = [S.curPage || 1];
  } else if (selectedScope === 'all') {
    targetPages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else if (selectedScope === 'custom') {
    const rangeVal = document.getElementById('ocr-scope-range')?.value || '';
    targetPages = parsePageRange(rangeVal, totalPages);
    if (!targetPages.length) {
      toast('⚠️ Please enter a valid page range (e.g. 1-10).');
      return;
    }
  } else if (selectedScope === 'scanned') {
    if (progressBox) progressBox.style.display = 'flex';
    if (progressLabel) progressLabel.textContent = 'Detecting scanned pages…';
    if (progressDetail) progressDetail.textContent = 'Scanning PDF structure for pages without digital text…';
    targetPages = await detectScannedPages(S.pdfDoc, totalPages);
    if (!targetPages.length) {
      if (progressBox) progressBox.style.display = 'none';
      toast('ℹ️ All pages in this document already have native selectable text!');
      return;
    }
  }

  // 2. Check "Skip pages already scanned"
  const skipExisting = document.getElementById('ocr-opt-skip')?.checked ?? true;
  if (skipExisting) {
    targetPages = targetPages.filter(p => !hasOcrData(tid, p));
    if (!targetPages.length) {
      toast('ℹ️ All selected pages have already been recognized. Uncheck "Skip" to re-scan.');
      return;
    }
  }

  // 3. Engine Choice: Desktop Native OCR vs Tesseract Local
  const isDesktop = typeof window !== 'undefined' && typeof window.__DESKTOP_PDFIUM__?.ocrPage === 'function';
  const BATCH_SIZE = isDesktop ? 4 : 1;

  // 4. Update UI to scanning state
  _isScanning = true;
  _scanCancelled = false;
  btnStart.disabled = true;
  btnCancel.textContent = 'Cancel Scan';
  btnCancel.disabled = false;
  if (progressBox) progressBox.style.display = 'flex';

  let completedCount = 0;
  const totalCount = targetPages.length;

  try {
    for (let i = 0; i < totalCount; i += BATCH_SIZE) {
      if (_scanCancelled) {
        toast('Scan stopped by user.');
        break;
      }

      const batch = targetPages.slice(i, i + BATCH_SIZE);
      const overallBase = Math.round((i / totalCount) * 100);

      if (progressLabel) {
        progressLabel.textContent = batch.length > 1
          ? `Scanning pages ${batch[0]}–${batch[batch.length - 1]} (${Math.min(i + batch.length, totalCount)} of ${totalCount})…`
          : `Scanning page ${batch[0]} (${i + 1} of ${totalCount})…`;
      }
      if (progressPct) progressPct.textContent = `${overallBase}%`;
      if (progressBar) progressBar.style.width = `${overallBase}%`;
      if (progressDetail) {
        progressDetail.textContent = isDesktop
          ? `Running Windows Native OCR in parallel (batch of ${batch.length})…`
          : `Running Local in-browser OCR on page ${batch[0]}…`;
      }

      await Promise.all(batch.map(pNum => scanPage(pNum, {
        onProgress: info => {
          if (_scanCancelled) return;
          const pageContrib = (info.pct / 100) * (100 / totalCount);
          const currentTotal = Math.min(99, Math.round(overallBase + pageContrib));
          if (progressPct) progressPct.textContent = `${currentTotal}%`;
          if (progressBar) progressBar.style.width = `${currentTotal}%`;
        }
      })));

      completedCount += batch.length;
      // Yield to main thread for responsive UI & cancel button handling
      await new Promise(r => setTimeout(r, 16));
    }

    if (progressBar) progressBar.style.width = '100%';
    if (progressPct) progressPct.textContent = '100%';

    // Step 5: Embed OCR into PDF binary and sync across caches + Drive!
    if (completedCount > 0) {
      if (progressLabel) progressLabel.textContent = 'Embedding text into PDF…';
      if (progressDetail) progressDetail.textContent = 'Embedding invisible searchable text layer into PDF & syncing to Drive…';
      try {
        await embedOcrIntoPdfAndSync(tid);
      } catch (embErr) {
        console.warn('[OCR] Embedding text into PDF failed:', embErr);
      }
    }

    if (!_scanCancelled) {
      if (progressLabel) progressLabel.textContent = '✅ Scan complete!';
      if (progressDetail) progressDetail.textContent = `Successfully processed ${completedCount} page${completedCount === 1 ? '' : 's'}. PDF is now 100% searchable and selectable!`;
      toast(`✅ OCR complete for ${completedCount} page${completedCount === 1 ? '' : 's'}!`);
    } else {
      if (progressLabel) progressLabel.textContent = 'Scan stopped';
      if (progressDetail) progressDetail.textContent = `Processed ${completedCount} page${completedCount === 1 ? '' : 's'} before stopping.`;
    }

    // Enable download report button
    if (btnDownload) {
      btnDownload.disabled = false;
      btnDownload.style.opacity = '1';
    }

  } catch (err) {
    console.error('[OCR] Workflow failed:', err);
    if (progressLabel) progressLabel.textContent = '❌ Error during scan';
    if (progressDetail) progressDetail.textContent = err.message || 'An error occurred during OCR recognition.';
    toast(`❌ OCR Scan failed: ${err.message || 'Unknown error'}`);
  } finally {
    _isScanning = false;
    _scanCancelled = false;
    btnStart.disabled = false;
    btnStart.textContent = 'Start OCR Scan';
    btnCancel.disabled = false;
    btnCancel.textContent = 'Close';
  }
}

// ── Download OCR Text Report ──
export function downloadOcrReport() {
  const tid = getTruePdfId();
  if (!tid || !_ocrCache[tid]) {
    toast('⚠️ No OCR data available to download yet.');
    return;
  }

  const pageEntries = Object.entries(_ocrCache[tid])
    .map(([pStr, data]) => ({ pageNum: Number(pStr), data }))
    .sort((a, b) => a.pageNum - b.pageNum);

  if (!pageEntries.length) {
    toast('⚠️ No OCR data available to download yet.');
    return;
  }

  const pdfName = S.curPDF?.name || 'Document';
  let report = `═════════════════════════════════════════════════════════════════════\n`;
  report += `LEGAL ANNOTATOR — SCAN-TO-OCR RECOGNITION REPORT\n`;
  report += `Document: ${pdfName}\n`;
  report += `Generated: ${new Date().toLocaleString()}\n`;
  report += `Total Recognized Pages: ${pageEntries.length}\n`;
  report += `═════════════════════════════════════════════════════════════════════\n\n`;

  for (const { pageNum, data } of pageEntries) {
    report += `--- PAGE ${pageNum} ---\n`;
    const text = data.fullText || (data.lines || []).map(l => l.str).join('\n') || '';
    report += text + `\n\n`;
  }

  const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = (pdfName || 'document').replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  a.href = url;
  a.download = `${safeName}_OCR_Report.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  toast('📄 OCR Report downloaded successfully!');
}
