// ═════════════════════════════════════════════════════════════════════════════
// LEGAL OCR & COMPRESSOR STUDIO — Standalone Linked App UI + Reader Status Bar
// Option A Architecture:
// 1. Standalone "Legal OCR Studio.exe" mode (--ocr-studio): dedicated native
//    Windows utility for 500+ page disk-to-disk OCR & Grayscale JPEG compression.
// 2. 1-Click Linked Launch + Live Toolbar Status Pill + Persistent Completion
//    Banner inside Legal Annotator so OCR status is 100% unmistakable.
// ═════════════════════════════════════════════════════════════════════════════

import { S } from './state.js';
import { safeStorageGet, safeStorageSet } from './storage.js';
import { toast, closeModal } from './ui.js';

let _studioWatchTimer = null;
let _lastCompletedJobIdShown = null;

export function formatBytesMB(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return '0 MB';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function getTrueId(pdfObj = null) {
  const p = pdfObj || S.curPDF;
  if (!p) return null;
  return p.linked_pdf_id || p.id || null;
}

export function getSavedOcrBadgeMeta(trueId) {
  if (!trueId) return null;
  try {
    const raw = safeStorageGet('ocr_ready_badge_' + trueId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSavedOcrBadgeMeta(trueId, meta) {
  if (!trueId || !meta) return;
  try {
    safeStorageSet('ocr_ready_badge_' + trueId, JSON.stringify({
      ...meta,
      updatedAt: Date.now(),
    }));
  } catch {}
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. TOP READER TOOLBAR OCR STATUS PILL (UNMISTAKABLE STATUS AT ALL TIMES)
// ═════════════════════════════════════════════════════════════════════════════

export function initReaderOcrStatusPill() {
  const ocrBtn = document.getElementById('btn-ocr-pdf');
  if (!ocrBtn || document.getElementById('ocr-status-pill')) return;

  const pill = document.createElement('button');
  pill.id = 'ocr-status-pill';
  pill.type = 'button';
  pill.className = 'tb-btn ocr-status-pill-btn';
  pill.style.cssText = [
    'display:none',
    'align-items:center',
    'gap:6px',
    'padding:3px 10px',
    'border-radius:999px',
    'font-size:11.5px',
    'font-weight:600',
    'cursor:pointer',
    'transition:all 0.2s ease',
    'white-space:nowrap',
  ].join(';');
  pill.title = 'Click to view OCR status or open Legal OCR & Compressor Studio';

  ocrBtn.insertAdjacentElement('afterend', pill);

  pill.addEventListener('click', () => {
    import('./ocr.js').then(m => m.openOcrToolModal?.()).catch(() => {});
  });
}

export async function updateReaderOcrStatusPill(overrideState = null) {
  initReaderOcrStatusPill();
  const pill = document.getElementById('ocr-status-pill');
  if (!pill) return;

  if (!S.curPDF || !S.pdfDoc) {
    pill.style.display = 'none';
    return;
  }

  const tid = getTrueId();
  const totalPages = S.totalPages || S.pdfDoc?.numPages || 1;
  pill.style.display = 'inline-flex';

  // 1. If an explicit override state is passed (e.g. live scanning progress)
  if (overrideState) {
    if (overrideState.state === 'running') {
      const pct = Math.min(99, Math.max(0, Math.round(overrideState.pct || 0)));
      const curP = overrideState.currentPage || 1;
      const totP = overrideState.totalPages || totalPages;
      pill.innerHTML = `<span class="ocr-pulse-dot" style="width:8px;height:8px;border-radius:50%;background:#facc15;display:inline-block;box-shadow:0 0 8px #facc15;"></span><span>⏳ OCR ${overrideState.isStudio ? '& Compress' : 'Scan'}: ${curP}/${totP} (${pct}%)</span>`;
      pill.style.background = 'rgba(234, 179, 8, 0.16)';
      pill.style.border = '1px solid rgba(250, 204, 21, 0.55)';
      pill.style.color = '#fde047';
      return;
    }
    if (overrideState.state === 'ready') {
      const extra = overrideState.savedPct > 1
        ? ` • Compressed -${Math.round(overrideState.savedPct)}% (${formatBytesMB(overrideState.compressedBytes)})`
        : ` (${overrideState.pages || totalPages} pgs)`;
      pill.innerHTML = `<span>🟢</span><span>OCR Ready & Searchable${extra}</span>`;
      pill.style.background = 'rgba(34, 197, 94, 0.16)';
      pill.style.border = '1px solid rgba(74, 222, 128, 0.5)';
      pill.style.color = '#4ade80';
      return;
    }
  }

  // 2. Check saved badge metadata or desktop summary
  const savedBadge = getSavedOcrBadgeMeta(tid);
  if (typeof window !== 'undefined' && window.__DESKTOP_PDFIUM__?.getPdfOcrSummary) {
    try {
      const summary = await window.__DESKTOP_PDFIUM__.getPdfOcrSummary(tid, totalPages);
      const job = summary?.studioJob;
      if (job && job.status === 'running') {
        const pct = job.totalPages > 0 ? Math.round((job.currentPage / job.totalPages) * 100) : 0;
        pill.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:#facc15;display:inline-block;"></span><span>⏳ Studio OCR & Compress: ${job.currentPage}/${job.totalPages || totalPages} (${pct}%)</span>`;
        pill.style.background = 'rgba(234, 179, 8, 0.16)';
        pill.style.border = '1px solid rgba(250, 204, 21, 0.55)';
        pill.style.color = '#fde047';
        watchStudioJobForCurrentPdf(tid);
        return;
      }
      if (job && job.status === 'completed') {
        setSavedOcrBadgeMeta(tid, {
          pages: job.totalPages || totalPages,
          words: job.wordsRecognized || 0,
          originalBytes: job.originalBytes || 0,
          compressedBytes: job.compressedBytes || 0,
          savedPct: job.savedPct || 0,
        });
        const pctTxt = job.savedPct > 1
          ? ` • ${formatBytesMB(job.compressedBytes)} (-${Math.round(job.savedPct)}%)`
          : ` (${job.totalPages || totalPages} pgs)`;
        pill.innerHTML = `<span>🟢</span><span>OCR Ready${pctTxt}</span>`;
        pill.style.background = 'rgba(34, 197, 94, 0.16)';
        pill.style.border = '1px solid rgba(74, 222, 128, 0.5)';
        pill.style.color = '#4ade80';
        return;
      }
      if (summary && summary.ocrPages > 0) {
        if (summary.ocrPages >= Math.max(1, Math.floor(totalPages * 0.8))) {
          setSavedOcrBadgeMeta(tid, { pages: summary.ocrPages });
          pill.innerHTML = `<span>🟢</span><span>OCR Ready (${summary.ocrPages}/${totalPages} pgs)</span>`;
          pill.style.background = 'rgba(34, 197, 94, 0.16)';
          pill.style.border = '1px solid rgba(74, 222, 128, 0.5)';
          pill.style.color = '#4ade80';
          return;
        } else {
          pill.innerHTML = `<span>🟡</span><span>Partial OCR (${summary.ocrPages}/${totalPages} pgs)</span>`;
          pill.style.background = 'rgba(245, 158, 11, 0.15)';
          pill.style.border = '1px solid rgba(251, 191, 36, 0.45)';
          pill.style.color = '#fbbf24';
          return;
        }
      }
    } catch {}
  }

  if (savedBadge && savedBadge.pages > 0) {
    const extra = savedBadge.savedPct > 1
      ? ` • ${formatBytesMB(savedBadge.compressedBytes)} (-${Math.round(savedBadge.savedPct)}%)`
      : ` (${savedBadge.pages}/${totalPages} pgs)`;
    pill.innerHTML = `<span>🟢</span><span>OCR Ready${extra}</span>`;
    pill.style.background = 'rgba(34, 197, 94, 0.16)';
    pill.style.border = '1px solid rgba(74, 222, 128, 0.5)';
    pill.style.color = '#4ade80';
    return;
  }

  // 3. Check if first few pages already have native digital text in PDF.js
  try {
    const samplePageNum = Math.min(S.curPage || 1, totalPages);
    const page = await S.pdfDoc.getPage(samplePageNum);
    const tc = await page.getTextContent();
    try { page.cleanup?.(); } catch {}
    const meaningfulWords = (tc?.items || []).filter(it => it.str && it.str.trim().length > 1).length;
    if (meaningfulWords >= 12) {
      pill.innerHTML = `<span>🟢</span><span>Searchable PDF (Digital Text)</span>`;
      pill.style.background = 'rgba(34, 197, 94, 0.12)';
      pill.style.border = '1px solid rgba(74, 222, 128, 0.35)';
      pill.style.color = '#86efac';
      return;
    }
  } catch {}

  // 4. Otherwise it's an un-OCR'd scanned PDF!
  const sizeStr = S.pdfDoc?._byteLength ? ` (${formatBytesMB(S.pdfDoc._byteLength)})` : '';
  pill.innerHTML = `<span>⚪</span><span>Scanned PDF${sizeStr} — Click to OCR & Compress</span>`;
  pill.style.background = 'rgba(248, 113, 113, 0.14)';
  pill.style.border = '1px solid rgba(248, 113, 113, 0.45)';
  pill.style.color = '#fca5a5';
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. PERSISTENT COMPLETION SUMMARY BANNER (NEVER MISS WHEN OCR IS DONE!)
// ═════════════════════════════════════════════════════════════════════════════

export function showPersistentOcrCompletionBanner({
  pages = 1,
  totalPages = 1,
  words = 0,
  originalBytes = 0,
  compressedBytes = 0,
  savedPct = 0,
  fromStudio = false,
} = {}) {
  const existing = document.getElementById('ocr-completion-banner');
  if (existing) existing.remove();

  const contentArea = document.getElementById('content-area') || document.body;
  const banner = document.createElement('div');
  banner.id = 'ocr-completion-banner';
  banner.style.cssText = [
    'position:fixed',
    'top:54px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:9500',
    'background:linear-gradient(135deg, #0d2818 0%, #133822 100%)',
    'border:1.5px solid #4ade80',
    'border-radius:12px',
    'box-shadow:0 14px 36px rgba(0,0,0,0.55)',
    'padding:14px 20px',
    'display:flex',
    'align-items:center',
    'gap:16px',
    'max-width:92vw',
    'color:#ecfdf5',
    'font-family:Inter, sans-serif',
  ].join(';');

  const hasCompression = originalBytes > 0 && compressedBytes > 0 && savedPct > 1;
  const sizeBadgeHtml = hasCompression
    ? `<span style="background:rgba(74,222,128,0.2);border:1px solid rgba(74,222,128,0.45);color:#86efac;padding:3px 9px;border-radius:6px;font-weight:700;font-size:12px;">🗜️ Compressed ${formatBytesMB(originalBytes)} → ${formatBytesMB(compressedBytes)} (-${Math.round(savedPct)}%)</span>`
    : '';
  const wordsTxt = words > 0 ? ` • ${words.toLocaleString()} words indexed` : '';

  banner.innerHTML = `
    <div style="font-size:26px;line-height:1;">✅</div>
    <div style="display:flex;flex-direction:column;gap:4px;flex:1;">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <strong style="font-size:14px;color:#4ade80;letter-spacing:0.01em;">
          ${fromStudio ? 'Legal OCR & Compressor Studio Complete!' : 'OCR Scan Complete — PDF is Now Searchable & Editable!'}
        </strong>
        ${sizeBadgeHtml}
      </div>
      <div style="font-size:12px;color:#d1fae5;line-height:1.4;">
        Recognized <b>${pages} of ${totalPages} page${totalPages === 1 ? '' : 's'}</b>${wordsTxt}. You can now press <b>Ctrl+F</b> to search, select & highlight words, or use Smart Copy Text.
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
      <button id="ocr-banner-btn-search" style="padding:7px 13px;border-radius:7px;border:1px solid #4ade80;background:#16a34a;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">
        🔍 Test Search (Ctrl+F)
      </button>
      <button id="ocr-banner-btn-dismiss" style="padding:7px 11px;border-radius:7px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);color:#d1fae5;font-size:12px;cursor:pointer;">
        ✓ Got It
      </button>
    </div>
  `;

  contentArea.appendChild(banner);

  document.getElementById('ocr-banner-btn-search')?.addEventListener('click', () => {
    banner.remove();
    import('./search.js').then(m => m.openSearch?.()).catch(() => {});
  });
  document.getElementById('ocr-banner-btn-dismiss')?.addEventListener('click', () => {
    banner.remove();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. LAUNCH SEPARATE LINKED STUDIO APP & WATCH FOR AUTO-SYNC BACK TO READER
// ═════════════════════════════════════════════════════════════════════════════

export async function launchLinkedOcrStudioForPdf(pdfObj = null, preset = 'balanced', autoStart = false) {
  const targetPdf = pdfObj || S.curPDF;
  if (!targetPdf && !window.__DESKTOP_PDFIUM__?.launchOcrStudio) {
    toast('⚠️ Please open or select a PDF first.');
    return;
  }

  const isDesktop = typeof window !== 'undefined' && typeof window.__DESKTOP_PDFIUM__?.launchOcrStudio === 'function';
  if (!isDesktop) {
    toast('ℹ️ The standalone Legal OCR & Compressor Studio app requires the Windows Desktop app.');
    return;
  }

  const tid = targetPdf ? (targetPdf.linked_pdf_id || targetPdf.id) : null;
  const driveId = targetPdf
    ? (targetPdf.drive_file_id || S.pdfs?.find(p => p.id === targetPdf.linked_pdf_id)?.drive_file_id || null)
    : null;
  const filePath = targetPdf?._localPath || null;
  const pdfName = targetPdf?.name || 'Document.pdf';

  try {
    closeModal('mo-ocr-tool');
  } catch {}

  try {
    const activeToken =
      S.driveToken ||
      (typeof localStorage !== 'undefined' ? localStorage.getItem('driveToken') : null) ||
      null;
    const res = await window.__DESKTOP_PDFIUM__.launchOcrStudio({
      docId: tid,
      driveId,
      filePath,
      pdfName,
      preset,
      autoStart,
      oauthToken: activeToken,
    });
    if (res?.ok) {
      toast(`🚀 Launched "Legal OCR & Compressor Studio" for "${pdfName}"!`);
      if (tid) {
        watchStudioJobForCurrentPdf(tid);
      }
    } else {
      toast('⚠️ Could not launch Legal OCR Studio: ' + (res?.error || 'Unknown error'));
    }
  } catch (err) {
    toast('❌ Failed to launch Legal OCR Studio: ' + (err.message || err));
  }
}

export function watchStudioJobForCurrentPdf(docId) {
  if (!docId || typeof window === 'undefined' || !window.__DESKTOP_PDFIUM__?.getOcrCompressStatus) return;
  if (_studioWatchTimer) clearInterval(_studioWatchTimer);

  _studioWatchTimer = setInterval(async () => {
    try {
      const st = await window.__DESKTOP_PDFIUM__.getOcrCompressStatus(docId);
      if (!st) return;

      const curTid = getTrueId();
      if (st.status === 'downloading' || st.status === 'running') {
        if (curTid === docId) {
          const pct = st.totalPages > 0 ? Math.round((st.currentPage / st.totalPages) * 100) : 0;
          updateReaderOcrStatusPill({
            state: 'running',
            isStudio: true,
            currentPage: st.currentPage || 0,
            totalPages: st.totalPages || S.totalPages || 1,
            pct,
          });
        }
      } else if (st.status === 'completed') {
        clearInterval(_studioWatchTimer);
        _studioWatchTimer = null;

        if (_lastCompletedJobIdShown === st.jobId) return;
        _lastCompletedJobIdShown = st.jobId;

        setSavedOcrBadgeMeta(docId, {
          pages: st.totalPages || S.totalPages || 1,
          words: st.wordsRecognized || 0,
          originalBytes: st.originalBytes || 0,
          compressedBytes: st.compressedBytes || 0,
          savedPct: st.savedPct || 0,
        });

        // Refresh library badges
        import('./library.js').then(m => m.renderLibrary?.()).catch(() => {});

        // If this document is currently open in the reader, reload its OCR layer and compressed PDF!
        if (curTid === docId) {
          const { loadOcrForCurrentPdf } = await import('./ocr.js');
          await loadOcrForCurrentPdf(docId);

          // Also sync compressed PDF to IndexedDB & Google Drive in background if <= 60 MB
          if (window.__DESKTOP_PDFIUM__?.readCachedPdfBytes) {
            const newBytes = await window.__DESKTOP_PDFIUM__.readCachedPdfBytes(docId);
            if (newBytes && newBytes.byteLength > 100) {
              const driveId = S.curPDF?.drive_file_id || S.pdfs?.find(p => p.id === S.curPDF?.linked_pdf_id)?.drive_file_id;
              if (driveId) {
                import('./drive.js').then(m => m.driveUpdatePDF?.(driveId, newBytes, S.curPDF?.name)).catch(() => {});
              }
            }
          }

          updateReaderOcrStatusPill({
            state: 'ready',
            pages: st.totalPages || S.totalPages || 1,
            originalBytes: st.originalBytes,
            compressedBytes: st.compressedBytes,
            savedPct: st.savedPct,
          });

          showPersistentOcrCompletionBanner({
            pages: st.totalPages || S.totalPages || 1,
            totalPages: st.totalPages || S.totalPages || 1,
            words: st.wordsRecognized || 0,
            originalBytes: st.originalBytes || 0,
            compressedBytes: st.compressedBytes || 0,
            savedPct: st.savedPct || 0,
            fromStudio: true,
          });
        }
      } else if (st.status === 'cancelled' || st.status === 'error') {
        clearInterval(_studioWatchTimer);
        _studioWatchTimer = null;
        if (curTid === docId) {
          updateReaderOcrStatusPill();
        }
      }
    } catch {}
  }, 750);
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. STANDALONE "LEGAL OCR & COMPRESSOR STUDIO" FULL-WINDOW APP MODE
// ═════════════════════════════════════════════════════════════════════════════

export async function checkAndBootOcrStudioApp() {
  const isUrlStudio = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('studio') === '1';
  let studioInfo = { isStudio: isUrlStudio };

  if (typeof window !== 'undefined' && window.__DESKTOP_PDFIUM__?.getStudioMode) {
    try {
      const modeRes = await window.__DESKTOP_PDFIUM__.getStudioMode();
      if (modeRes?.isStudio || isUrlStudio) {
        studioInfo = { ...modeRes, isStudio: true };
      }
    } catch {}
  }

  if (!studioInfo.isStudio) return false;

  renderStandaloneOcrStudioUI(studioInfo);
  return true;
}

function renderStandaloneOcrStudioUI(studioInfo) {
  document.title = 'Legal OCR & Compressor Studio — Linked with Legal Annotator';

  const state = {
    docId: studioInfo.docId || null,
    driveId: studioInfo.driveId || null,
    filePath: studioInfo.filePath || null,
    pdfName: studioInfo.pdfName || null,
    preset: studioInfo.preset || 'balanced',
    sizeBytes: 0,
    pageCount: 0,
    running: false,
    pollTimer: null,
  };

  document.body.innerHTML = `
    <div id="ocr-studio-app" style="min-height:100vh;background:#0a0f1a;color:#e8e4db;font-family:'Inter',sans-serif;display:flex;flex-direction:column;box-sizing:border-box;user-select:none;">
      
      <!-- Top Studio Bar -->
      <header style="background:#111a2c;border-bottom:1px solid #22334d;padding:16px 26px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="width:42px;height:42px;border-radius:10px;background:linear-gradient(135deg,#c9a84c,#9b7824);display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 4px 14px rgba(201,168,76,0.3);">
            🗜️
          </div>
          <div>
            <h1 style="margin:0;font-family:'Libre Baskerville',serif;font-size:19px;color:#f3ead6;display:flex;align-items:center;gap:10px;">
              Legal OCR &amp; Compressor Studio
              <span style="font-family:'Inter',sans-serif;font-size:11px;padding:3px 9px;border-radius:999px;background:rgba(34,197,94,0.15);color:#4ade80;border:1px solid rgba(74,222,128,0.4);">
                🔗 Linked with Legal Annotator
              </span>
            </h1>
            <p style="margin:3px 0 0 0;font-size:12px;color:#8ea0b8;">
              100% Local Disk-to-Disk Streaming • Converts 500-Page Scanned Codals into Compact, Searchable &amp; Editable PDFs (&lt; 40 MB RAM)
            </p>
          </div>
        </div>

        <!-- Unmistakable Top Status Badge -->
        <div id="studio-top-status-badge" style="padding:8px 16px;border-radius:999px;font-size:12.5px;font-weight:700;background:rgba(255,255,255,0.06);border:1px solid #2e4366;color:#cbd5e1;display:flex;align-items:center;gap:8px;">
          <span>⚪</span>
          <span id="studio-top-status-text">Ready — Select a PDF</span>
        </div>
      </header>

      <!-- Main Studio Workspace -->
      <main style="flex:1;max-width:960px;width:100%;margin:0 auto;padding:24px 26px;display:flex;flex-direction:column;gap:20px;box-sizing:border-box;">
        
        <!-- Step 1: Source PDF Selection -->
        <section style="background:#111a2c;border:1px solid #22334d;border-radius:12px;padding:18px 20px;display:flex;flex-direction:column;gap:12px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <label style="font-size:11.5px;font-weight:700;text-transform:uppercase;color:#c9a84c;letter-spacing:0.06em;">
              1. Source Scanned PDF Document
            </label>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button id="studio-btn-pick-file" style="padding:7px 14px;border-radius:7px;border:1px solid #c9a84c;background:rgba(201,168,76,0.14);color:#f3ead6;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;">
                📂 Pick Any PDF from Computer…
              </button>
            </div>
          </div>

          <div id="studio-file-card" style="background:#0b111e;border:1px solid #22334d;border-radius:9px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:14px;">
            <div style="display:flex;align-items:center;gap:12px;min-width:0;">
              <div style="font-size:28px;">📄</div>
              <div style="min-width:0;">
                <div id="studio-file-name" style="font-size:15px;font-weight:700;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${state.pdfName ? state.pdfName : 'No PDF selected yet'}
                </div>
                <div id="studio-file-meta" style="font-size:12px;color:#8ea0b8;margin-top:3px;">
                  ${state.filePath ? state.filePath : (state.docId || state.driveId ? '☁️ Linked to Legal Annotator Cloud Library (Auto-Downloads to Local Disk Cache if needed)' : 'Click "Pick Any PDF from Computer…" or launch directly from Legal Annotator')}
                </div>
              </div>
            </div>
            <div id="studio-file-pill" style="padding:5px 11px;border-radius:7px;background:rgba(201,168,76,0.12);border:1px solid rgba(201,168,76,0.3);color:#c9a84c;font-size:12px;font-weight:600;white-space:nowrap;">
              ${state.docId ? 'Linked to Legal Annotator' : 'Standalone File'}
            </div>
          </div>
        </section>

        <!-- Step 2: Compression & OCR Quality Preset -->
        <section style="background:#111a2c;border:1px solid #22334d;border-radius:12px;padding:18px 20px;display:flex;flex-direction:column;gap:12px;">
          <label style="font-size:11.5px;font-weight:700;text-transform:uppercase;color:#c9a84c;letter-spacing:0.06em;">
            2. Choose OCR + File Size Compression Level
          </label>

          <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:12px;">
            <!-- Preset 1: Balanced -->
            <div class="studio-preset-card" data-preset="balanced" style="background:#0b111e;border:2px solid #c9a84c;border-radius:10px;padding:14px;cursor:pointer;display:flex;flex-direction:column;gap:6px;">
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <strong style="font-size:13.5px;color:#f3ead6;">⭐ Crisp Legal Scan</strong>
                <span style="font-size:10.5px;padding:2px 7px;border-radius:5px;background:rgba(34,197,94,0.18);color:#4ade80;font-weight:700;">~75–80% Smaller</span>
              </div>
              <div style="font-size:11.5px;color:#94a3b8;line-height:1.45;">
                <b>Recommended for 500-page Codals.</b> 165 DPI Grayscale + Adaptive Paper Whitening + Dark Ink Boost + Searchable OCR Layer. Shrinks ~100 MB down to ~20 MB.
              </div>
            </div>

            <!-- Preset 2: Max Compression -->
            <div class="studio-preset-card" data-preset="max" style="background:#0b111e;border:2px solid #22334d;border-radius:10px;padding:14px;cursor:pointer;display:flex;flex-direction:column;gap:6px;">
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <strong style="font-size:13.5px;color:#f3ead6;">⚡ Max Compression</strong>
                <span style="font-size:10.5px;padding:2px 7px;border-radius:5px;background:rgba(56,189,248,0.18);color:#38bdf8;font-weight:700;">~85% Smaller</span>
              </div>
              <div style="font-size:11.5px;color:#94a3b8;line-height:1.45;">
                <b>Fastest Cloud &amp; Mobile Sync.</b> 130 DPI Grayscale + Aggressive Paper Whitening + Searchable OCR Layer. Shrinks ~100 MB down to ~14 MB.
              </div>
            </div>

            <!-- Preset 3: Archival -->
            <div class="studio-preset-card" data-preset="archival" style="background:#0b111e;border:2px solid #22334d;border-radius:10px;padding:14px;cursor:pointer;display:flex;flex-direction:column;gap:6px;">
              <div style="display:flex;align-items:center;justify-content:space-between;">
                <strong style="font-size:13.5px;color:#f3ead6;">🔍 High-DPI Archival</strong>
                <span style="font-size:10.5px;padding:2px 7px;border-radius:5px;background:rgba(201,168,76,0.18);color:#c9a84c;font-weight:700;">~60% Smaller</span>
              </div>
              <div style="font-size:11.5px;color:#94a3b8;line-height:1.45;">
                <b>For Tiny Footnotes.</b> 210 DPI Grayscale + Gentle Paper Cleanup + Searchable OCR Layer. Maximum fine-print clarity.
              </div>
            </div>
          </div>
        </section>

        <!-- Step 3: Execution Controls & Unmistakable Progress / Completion Dashboard -->
        <section style="background:#111a2c;border:1px solid #22334d;border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:16px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <div>
              <div style="font-size:14px;font-weight:700;color:#f3ead6;">
                3. Run Native Disk-to-Disk OCR &amp; Compression
              </div>
              <div style="font-size:12px;color:#8ea0b8;margin-top:2px;">
                Embeds word-by-word searchable &amp; editable PDF text layer + compresses scanned page images in one pass.
              </div>
            </div>
            <div style="display:flex;gap:10px;">
              <button id="studio-btn-cancel" style="display:none;padding:10px 18px;border-radius:8px;border:1px solid #ef4444;background:rgba(239,68,68,0.15);color:#fca5a5;font-size:13px;font-weight:700;cursor:pointer;">
                ⏹ Stop Job
              </button>
              <button id="studio-btn-start" style="padding:11px 24px;border-radius:8px;border:none;background:linear-gradient(135deg,#c9a84c,#a8842c);color:#090d16;font-size:13.5px;font-weight:800;cursor:pointer;box-shadow:0 4px 14px rgba(201,168,76,0.3);">
                🚀 Start OCR &amp; Compress PDF
              </button>
            </div>
          </div>

          <!-- Live Progress Box -->
          <div id="studio-progress-panel" style="display:none;background:#0b111e;border:1.5px solid #eab308;border-radius:10px;padding:18px;flex-direction:column;gap:12px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:20px;">⏳</span>
                <div>
                  <div id="studio-prog-headline" style="font-size:15px;font-weight:700;color:#fde047;">
                    Processing Page 1 of 500…
                  </div>
                  <div id="studio-prog-sub" style="font-size:12px;color:#94a3b8;margin-top:2px;">
                    Windows Native OCR + Grayscale JPEG Streamer • Memory isolated from Legal Annotator
                  </div>
                </div>
              </div>
              <div id="studio-prog-pct" style="font-size:24px;font-weight:800;color:#fde047;font-family:monospace;">
                0%
              </div>
            </div>

            <div style="width:100%;height:14px;background:rgba(255,255,255,0.08);border-radius:999px;overflow:hidden;">
              <div id="studio-prog-bar" style="width:0%;height:100%;background:linear-gradient(90deg,#c9a84c,#4ade80);transition:width 0.25s ease;"></div>
            </div>

            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding-top:4px;">
              <div style="background:rgba(255,255,255,0.03);padding:8px 12px;border-radius:7px;border:1px solid #1e293b;">
                <div style="font-size:10.5px;color:#64748b;text-transform:uppercase;">Words Recognized</div>
                <div id="studio-prog-words" style="font-size:14px;font-weight:700;color:#e2e8f0;margin-top:2px;">0 words</div>
              </div>
              <div style="background:rgba(255,255,255,0.03);padding:8px 12px;border-radius:7px;border:1px solid #1e293b;">
                <div style="font-size:10.5px;color:#64748b;text-transform:uppercase;">Original File Size</div>
                <div id="studio-prog-orig-size" style="font-size:14px;font-weight:700;color:#e2e8f0;margin-top:2px;">—</div>
              </div>
              <div style="background:rgba(255,255,255,0.03);padding:8px 12px;border-radius:7px;border:1px solid #1e293b;">
                <div style="font-size:10.5px;color:#64748b;text-transform:uppercase;">Compressed Output So Far</div>
                <div id="studio-prog-out-size" style="font-size:14px;font-weight:700;color:#4ade80;margin-top:2px;">—</div>
              </div>
            </div>
          </div>

          <!-- Big Green Completion Card (Impossible to Miss!) -->
          <div id="studio-complete-panel" style="display:none;background:linear-gradient(135deg,#0c2919 0%,#113823 100%);border:2px solid #4ade80;border-radius:12px;padding:20px;flex-direction:column;gap:16px;box-shadow:0 10px 30px rgba(34,197,94,0.18);">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:12px;">
                <div style="font-size:34px;">✅</div>
                <div>
                  <h2 style="margin:0;font-size:18px;color:#4ade80;font-weight:800;">
                    OCR &amp; PDF COMPRESSION COMPLETE!
                  </h2>
                  <div id="studio-done-sub" style="font-size:12.5px;color:#d1fae5;margin-top:3px;">
                    Your PDF is now 100% searchable (Ctrl+F), selectable, editable, and compressed.
                  </div>
                </div>
              </div>
              <span style="padding:6px 12px;border-radius:999px;background:#16a34a;color:#fff;font-size:12px;font-weight:700;">
                ✓ Synced to Legal Annotator
              </span>
            </div>

            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">
              <div style="background:rgba(0,0,0,0.28);padding:12px 14px;border-radius:9px;border:1px solid rgba(74,222,128,0.3);">
                <div style="font-size:11px;color:#86efac;text-transform:uppercase;font-weight:600;">Searchable Pages &amp; Words</div>
                <div id="studio-done-pages" style="font-size:17px;font-weight:800;color:#fff;margin-top:4px;">—</div>
              </div>
              <div style="background:rgba(0,0,0,0.28);padding:12px 14px;border-radius:9px;border:1px solid rgba(74,222,128,0.3);">
                <div style="font-size:11px;color:#86efac;text-transform:uppercase;font-weight:600;">File Size Before → After</div>
                <div id="studio-done-sizes" style="font-size:17px;font-weight:800;color:#fff;margin-top:4px;">—</div>
              </div>
              <div style="background:rgba(0,0,0,0.28);padding:12px 14px;border-radius:9px;border:1px solid rgba(74,222,128,0.3);">
                <div style="font-size:11px;color:#86efac;text-transform:uppercase;font-weight:600;">Total Space Saved</div>
                <div id="studio-done-saved" style="font-size:17px;font-weight:800;color:#4ade80;margin-top:4px;">—</div>
              </div>
            </div>

            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px solid rgba(74,222,128,0.25);padding-top:14px;">
              <div style="font-size:12px;color:#a7f3d0;">
                💡 If this PDF is open in Legal Annotator, it has already been automatically updated &amp; unlocked for search!
              </div>
              <div style="display:flex;gap:10px;flex-wrap:wrap;">
                <button id="studio-btn-save-as" style="padding:9px 16px;border-radius:8px;border:1px solid #4ade80;background:rgba(22,163,74,0.25);color:#ecfdf5;font-size:12.5px;font-weight:700;cursor:pointer;">
                  💾 Save Single Compressed PDF As…
                </button>
                <button id="studio-btn-jump-split" style="padding:9px 16px;border-radius:8px;border:1px solid #38bdf8;background:rgba(56,189,248,0.18);color:#e0f2fe;font-size:12.5px;font-weight:700;cursor:pointer;">
                  ✂️ Split &amp; Save into Folder…
                </button>
                <button id="studio-btn-close-win" style="padding:9px 18px;border-radius:8px;border:none;background:#4ade80;color:#052e16;font-size:12.5px;font-weight:800;cursor:pointer;">
                  ✓ Done — Return to Legal Annotator
                </button>
              </div>
            </div>
          </div>

        </section>

        <!-- Step 4: Split & Save PDF into Another Folder (External Use Only — Leaves Google Drive Untouched) -->
        <section id="studio-split-section" style="background:#111a2c;border:1px solid #22334d;border-radius:12px;padding:18px 20px;display:flex;flex-direction:column;gap:14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <div>
              <label style="font-size:11.5px;font-weight:700;text-transform:uppercase;color:#38bdf8;letter-spacing:0.06em;display:flex;align-items:center;gap:6px;">
                <span>✂️</span> 4. Split &amp; Save PDF into a Folder (For External Use Outside Legal Annotator)
              </label>
              <div style="font-size:12px;color:#8ea0b8;margin-top:3px;">
                Saves multiple smaller, compressed &amp; OCR-searchable PDF parts into any folder you choose (e.g. for NotebookLM, ChatGPT, or sharing) while keeping your main book unified inside Legal Annotator &amp; Google Drive.
              </div>
            </div>
            <button id="studio-btn-split-folder" style="padding:10px 18px;border-radius:8px;border:1px solid #38bdf8;background:linear-gradient(135deg,#0284c7,#0369a1);color:#f0f9ff;font-size:13px;font-weight:800;cursor:pointer;white-space:nowrap;box-shadow:0 4px 12px rgba(2,132,199,0.3);">
              📂 Choose Folder &amp; Save Split PDFs…
            </button>
          </div>

          <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:12px;align-items:end;background:#0b111e;border:1px solid #1e293b;border-radius:9px;padding:14px;">
            <div style="display:flex;flex-direction:column;gap:6px;">
              <label style="font-size:11.5px;font-weight:600;color:#cbd5e1;">How do you want to split the PDF?</label>
              <select id="studio-split-mode" style="padding:9px 12px;border-radius:7px;border:1px solid #2e4366;background:#111a2c;color:#f8fafc;font-size:13px;outline:none;cursor:pointer;">
                <option value="pages" selected>📄 By Pages per File (e.g. every 100 pages)</option>
                <option value="size_mb">🗜️ By Max File Size per Part (e.g. max 15 MB each)</option>
                <option value="parts">🔢 Into N Equal Parts (e.g. split into 5 files)</option>
                <option value="ranges">📑 By Custom Page Ranges (e.g. 1-120, 121-250, 251-500)</option>
              </select>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;">
              <label id="studio-split-val-label" style="font-size:11.5px;font-weight:600;color:#cbd5e1;">Pages per Split PDF File:</label>
              <input id="studio-split-value" type="text" value="100" placeholder="e.g. 100" style="padding:9px 12px;border-radius:7px;border:1px solid #2e4366;background:#111a2c;color:#f8fafc;font-size:13px;outline:none;" />
            </div>
          </div>

          <div id="studio-split-result" style="display:none;background:rgba(56,189,248,0.1);border:1px solid rgba(56,189,248,0.4);border-radius:9px;padding:12px 14px;font-size:12.5px;color:#e0f2fe;line-height:1.5;"></div>
        </section>
      </main>
    </div>
  `;

  // Wire Preset Selection
  const presetCards = document.querySelectorAll('.studio-preset-card');
  const selectPreset = (p) => {
    state.preset = p;
    presetCards.forEach(c => {
      const active = c.dataset.preset === p;
      c.style.border = active ? '2px solid #c9a84c' : '2px solid #22334d';
      c.style.background = active ? 'rgba(201,168,76,0.08)' : '#0b111e';
    });
  };
  selectPreset(state.preset);
  presetCards.forEach(c => {
    c.addEventListener('click', () => {
      if (!state.running) selectPreset(c.dataset.preset);
    });
  });

  // Wire File Picker
  document.getElementById('studio-btn-pick-file')?.addEventListener('click', async () => {
    if (state.running) return;
    const picked = await window.__DESKTOP_PDFIUM__?.pickPdfPathOnly?.();
    if (!picked) return;
    state.filePath = picked.path;
    state.pdfName = picked.name;
    state.sizeBytes = picked.sizeBytes || 0;
    state.pageCount = picked.pageCount || 0;
    state.docId = null;
    state.driveId = null;

    document.getElementById('studio-file-name').textContent = state.pdfName;
    document.getElementById('studio-file-meta').textContent = `${state.pageCount ? state.pageCount + ' pages • ' : ''}${formatBytesMB(state.sizeBytes)} • ${state.filePath}`;
    document.getElementById('studio-file-pill').textContent = 'Local Computer File';
    document.getElementById('studio-complete-panel').style.display = 'none';
  });

  const topBadge = document.getElementById('studio-top-status-badge');
  const setTopBadge = (mode, text) => {
    if (!topBadge) return;
    if (mode === 'running') {
      topBadge.style.background = 'rgba(234,179,8,0.18)';
      topBadge.style.borderColor = '#eab308';
      topBadge.style.color = '#fde047';
      topBadge.innerHTML = `<span>⏳</span><span>${text}</span>`;
    } else if (mode === 'done') {
      topBadge.style.background = 'rgba(34,197,94,0.2)';
      topBadge.style.borderColor = '#4ade80';
      topBadge.style.color = '#4ade80';
      topBadge.innerHTML = `<span>🟢</span><span>${text}</span>`;
    } else if (mode === 'error') {
      topBadge.style.background = 'rgba(239,68,68,0.2)';
      topBadge.style.borderColor = '#ef4444';
      topBadge.style.color = '#fca5a5';
      topBadge.innerHTML = `<span>❌</span><span>${text}</span>`;
    } else {
      topBadge.style.background = 'rgba(255,255,255,0.06)';
      topBadge.style.borderColor = '#2e4366';
      topBadge.style.color = '#cbd5e1';
      topBadge.innerHTML = `<span>⚪</span><span>${text}</span>`;
    }
  };

  const startJob = async () => {
    if (state.running) return;
    if (!state.filePath && !state.docId && !state.driveId) {
      const picked = await window.__DESKTOP_PDFIUM__?.pickPdfPathOnly?.();
      if (!picked) return;
      state.filePath = picked.path;
      state.pdfName = picked.name;
      state.sizeBytes = picked.sizeBytes || 0;
      state.pageCount = picked.pageCount || 0;
      document.getElementById('studio-file-name').textContent = state.pdfName;
      document.getElementById('studio-file-meta').textContent = `${state.pageCount ? state.pageCount + ' pages • ' : ''}${formatBytesMB(state.sizeBytes)} • ${state.filePath}`;
    }

    const btnStart = document.getElementById('studio-btn-start');
    const btnCancel = document.getElementById('studio-btn-cancel');
    const progPanel = document.getElementById('studio-progress-panel');
    const donePanel = document.getElementById('studio-complete-panel');

    try {
      state.running = true;
      btnStart.disabled = true;
      btnStart.style.opacity = '0.5';
      btnCancel.style.display = 'inline-block';
      progPanel.style.display = 'flex';
      donePanel.style.display = 'none';
      setTopBadge('running', 'Starting OCR & Compression…');

      const activeToken =
        S.driveToken ||
        (typeof localStorage !== 'undefined' ? localStorage.getItem('driveToken') : null) ||
        null;
      const job = await window.__DESKTOP_PDFIUM__.startOcrCompressJob({
        docId: state.docId,
        driveId: state.driveId,
        inputPath: state.filePath,
        pdfName: state.pdfName,
        preset: state.preset,
        oauthToken: activeToken,
      });

      state.docId = job.docId;

      if (state.pollTimer) clearInterval(state.pollTimer);
      state.pollTimer = setInterval(async () => {
        const st = await window.__DESKTOP_PDFIUM__.getOcrCompressStatus(state.docId);
        if (!st) return;

        if (st.status === 'downloading') {
          document.getElementById('studio-prog-headline').textContent =
            '☁️ Downloading PDF from Google Drive to Local Disk Cache…';
          document.getElementById('studio-prog-pct').textContent = '…';
          document.getElementById('studio-prog-bar').style.width = '8%';
          setTopBadge('running', 'Downloading PDF from Google Drive to Local Disk…');
          return;
        }

        const tot = Math.max(1, st.totalPages || state.pageCount || 1);
        const cur = st.currentPage || 0;
        const pct = st.status === 'completed' ? 100 : Math.min(99, Math.round((cur / tot) * 100));

        document.getElementById('studio-prog-headline').textContent =
          `OCR & Compressing Page ${cur} of ${tot}…`;
        document.getElementById('studio-prog-pct').textContent = `${pct}%`;
        document.getElementById('studio-prog-bar').style.width = `${pct}%`;
        document.getElementById('studio-prog-words').textContent =
          `${(st.wordsRecognized || 0).toLocaleString()} words`;
        document.getElementById('studio-prog-orig-size').textContent =
          formatBytesMB(st.originalBytes);
        document.getElementById('studio-prog-out-size').textContent =
          formatBytesMB(st.compressedBytes);

        setTopBadge('running', `Processing Page ${cur}/${tot} (${pct}%)`);

        if (st.status === 'completed') {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
          state.running = false;
          btnStart.disabled = false;
          btnStart.style.opacity = '1';
          btnStart.textContent = '🔄 Re-Run OCR & Compress';
          btnCancel.style.display = 'none';
          progPanel.style.display = 'none';
          donePanel.style.display = 'flex';

          const savedBytes = Math.max(0, (st.originalBytes || 0) - (st.compressedBytes || 0));
          const savedPct = Math.round(st.savedPct || 0);

          document.getElementById('studio-done-pages').textContent =
            `${st.totalPages} pages (${(st.wordsRecognized || 0).toLocaleString()} words)`;
          document.getElementById('studio-done-sizes').textContent =
            `${formatBytesMB(st.originalBytes)} → ${formatBytesMB(st.compressedBytes)}`;
          document.getElementById('studio-done-saved').textContent =
            savedPct > 0 ? `-${savedPct}% (${formatBytesMB(savedBytes)} saved)` : `Searchable PDF Ready (${formatBytesMB(st.compressedBytes)})`;

          setTopBadge('done', `COMPLETE — ${st.totalPages} Pages Searchable & Compressed!`);
          setSavedOcrBadgeMeta(state.docId, {
            pages: st.totalPages,
            words: st.wordsRecognized || 0,
            originalBytes: st.originalBytes || 0,
            compressedBytes: st.compressedBytes || 0,
            savedPct: st.savedPct || 0,
          });
        } else if (st.status === 'cancelled' || st.status === 'error') {
          clearInterval(state.pollTimer);
          state.pollTimer = null;
          state.running = false;
          btnStart.disabled = false;
          btnStart.style.opacity = '1';
          btnCancel.style.display = 'none';
          setTopBadge(
            st.status === 'error' ? 'error' : 'idle',
            st.status === 'error' ? `Error: ${st.error || 'Failed'}` : 'Stopped by user'
          );
        }
      }, 450);
    } catch (err) {
      state.running = false;
      btnStart.disabled = false;
      btnStart.style.opacity = '1';
      btnCancel.style.display = 'none';
      setTopBadge('error', err.message || String(err));
    }
  };

  document.getElementById('studio-btn-start')?.addEventListener('click', startJob);
  document.getElementById('studio-btn-cancel')?.addEventListener('click', async () => {
    if (state.docId) {
      await window.__DESKTOP_PDFIUM__?.cancelOcrCompressJob?.(state.docId);
    }
  });

  document.getElementById('studio-btn-save-as')?.addEventListener('click', async () => {
    await window.__DESKTOP_PDFIUM__?.exportCompressedPdfAs?.(state.docId, state.pdfName);
  });

  document.getElementById('studio-btn-jump-split')?.addEventListener('click', () => {
    const sec = document.getElementById('studio-split-section');
    sec?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('studio-btn-split-folder')?.click();
  });

  const splitModeEl = document.getElementById('studio-split-mode');
  const splitValLabelEl = document.getElementById('studio-split-val-label');
  const splitValInputEl = document.getElementById('studio-split-value');

  splitModeEl?.addEventListener('change', () => {
    const m = splitModeEl.value;
    if (m === 'pages') {
      splitValLabelEl.textContent = 'Pages per Split PDF File:';
      splitValInputEl.value = '100';
      splitValInputEl.placeholder = 'e.g. 50 or 100';
    } else if (m === 'size_mb') {
      splitValLabelEl.textContent = 'Max Megabytes (MB) per File:';
      splitValInputEl.value = '15';
      splitValInputEl.placeholder = 'e.g. 10, 15, or 25';
    } else if (m === 'parts') {
      splitValLabelEl.textContent = 'Number of Equal PDF Files:';
      splitValInputEl.value = '5';
      splitValInputEl.placeholder = 'e.g. 2, 4, or 5';
    } else if (m === 'ranges') {
      splitValLabelEl.textContent = 'Custom Page Ranges (comma-separated):';
      splitValInputEl.value = state.pageCount > 200 ? `1-100, 101-200, 201-${state.pageCount}` : '1-50, 51-100';
      splitValInputEl.placeholder = 'e.g. 1-120, 121-250, 251-500';
    }
  });

  document.getElementById('studio-btn-split-folder')?.addEventListener('click', async () => {
    const btnSplit = document.getElementById('studio-btn-split-folder');
    const resBox = document.getElementById('studio-split-result');
    if (!state.filePath && !state.docId && !state.driveId) {
      const picked = await window.__DESKTOP_PDFIUM__?.pickPdfPathOnly?.();
      if (!picked) return;
      state.filePath = picked.path;
      state.pdfName = picked.name;
      state.sizeBytes = picked.sizeBytes || 0;
      state.pageCount = picked.pageCount || 0;
      document.getElementById('studio-file-name').textContent = state.pdfName;
      document.getElementById('studio-file-meta').textContent = `${state.pageCount ? state.pageCount + ' pages • ' : ''}${formatBytesMB(state.sizeBytes)} • ${state.filePath}`;
    }

    const splitMode = splitModeEl?.value || 'pages';
    const splitValue = (splitValInputEl?.value || '100').trim();

    try {
      btnSplit.disabled = true;
      btnSplit.textContent = '⏳ Splitting & Saving PDFs…';
      if (resBox) {
        resBox.style.display = 'block';
        resBox.innerHTML = '⏳ Selecting destination folder and generating compressed, searchable split PDF parts…';
      }

      const res = await window.__DESKTOP_PDFIUM__?.splitPdfToFolder?.({
        docId: state.docId,
        driveId: state.driveId,
        inputPath: state.filePath,
        defaultName: state.pdfName,
        splitMode,
        splitValue,
        preset: state.preset,
      });

      btnSplit.disabled = false;
      btnSplit.textContent = '📂 Choose Folder & Save Split PDFs…';

      if (res?.cancelled) {
        if (resBox) resBox.style.display = 'none';
        return;
      }

      if (res?.ok) {
        const filesList = (res.files || [])
          .slice(0, 8)
          .map(f => `<span style="display:inline-block;background:rgba(0,0,0,0.3);padding:2px 8px;border-radius:5px;margin:2px 4px 2px 0;font-family:monospace;font-size:11.5px;">${f.name} (${formatBytesMB(f.sizeBytes)})</span>`)
          .join('');
        const moreTxt = (res.files || []).length > 8 ? ` <span style="color:#94a3b8;">+${res.files.length - 8} more files</span>` : '';
        if (resBox) {
          resBox.style.display = 'block';
          resBox.innerHTML = `
            <div style="font-weight:700;color:#4ade80;margin-bottom:4px;">
              ✅ Saved ${res.totalParts} Split &amp; Searchable PDF Files (${formatBytesMB(res.totalBytes)} total) to:
            </div>
            <div style="font-family:monospace;font-size:12px;color:#f8fafc;margin-bottom:6px;word-break:break-all;">
              📁 ${res.folderPath}
            </div>
            <div>${filesList}${moreTxt}</div>
          `;
        }
      } else if (resBox) {
        resBox.style.display = 'block';
        resBox.innerHTML = `<span style="color:#fca5a5;">❌ Failed to split PDF: ${res?.error || 'Unknown error'}</span>`;
      }
    } catch (err) {
      btnSplit.disabled = false;
      btnSplit.textContent = '📂 Choose Folder & Save Split PDFs…';
      if (resBox) {
        resBox.style.display = 'block';
        resBox.innerHTML = `<span style="color:#fca5a5;">❌ Error: ${err.message || err}</span>`;
      }
    }
  });

  document.getElementById('studio-btn-close-win')?.addEventListener('click', async () => {
    if (window.__DESKTOP_PDFIUM__?.closeStudioWindow) {
      await window.__DESKTOP_PDFIUM__.closeStudioWindow();
    } else {
      window.close();
    }
  });

  if (studioInfo.autoStart && (state.filePath || state.docId || state.driveId)) {
    setTimeout(startJob, 350);
  }
}
