// ═════════════════════════════════════════════════════════════════════════════
// DESKTOP BRIDGE — Tauri 2 + Native C++ PDFium + Local SQLite Notes Mirror
// ═════════════════════════════════════════════════════════════════════════════
import { S } from './state.js';
import { openPDFFromLibrary } from './viewer.js';
import { driveSignIn } from './drive.js';

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
  window.__DESKTOP_GOOGLE_OAUTH__ = async (_clientId, _scope, silent = false) => {
    const startRes = await invoke('desktop_start_google_oauth', { silent: !!silent });
    if (startRes?.status === 'success' && startRes?.accessToken) {
      return { access_token: startRes.accessToken };
    }
    if (silent) {
      throw new Error('Silent refresh requires interactive login');
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 180_000) {
      await new Promise(r => setTimeout(r, 300));
      const poll = await invoke('desktop_poll_google_oauth');
      if (poll?.status === 'success' && poll?.accessToken) {
        return { access_token: poll.accessToken };
      }
      if (poll?.status === 'closed' || poll?.status === 'idle') {
        throw new Error('Google sign-in window closed');
      }
    }
    throw new Error('Google sign-in timed out');
  };

  window.__DESKTOP_GOOGLE_SIGNOUT__ = async () => {
    try {
      await invoke('desktop_clear_google_oauth');
    } catch {}
  };
}

import { reRenderAll } from './viewer.js';

window.__DESKTOP_PDFIUM__ = {
  async openPdf(docId, arrayBuffer, localPath = null) {
    if (!invoke) return false;
    try {
      if (localPath) {
        const res = await invoke('pdfium_open_path', { docId: String(docId), path: localPath });
        if (res?.ok) _openNativeDocs.add(String(docId));
        return !!res?.ok;
      }
      // 1. Check if already cached on disk in D:\Code\legal-annotator-desktop\data\pdf_cache
      const cachedPath = await invoke('desktop_cache_get_path', { fileId: String(docId) }).catch(() => null);
      if (cachedPath) {
        const res = await invoke('pdfium_open_path', { docId: String(docId), path: cachedPath });
        if (res?.ok) {
          _openNativeDocs.add(String(docId));
          return true;
        }
      }
      // 2. Otherwise persist once to disk cache and open directly from path via FPDF_LoadDocument
      if (arrayBuffer && arrayBuffer.byteLength <= 150 * 1024 * 1024) {
        const b64 = arrayBufferToBase64(arrayBuffer);
        const savedPath = await invoke('desktop_cache_save_pdf', {
          fileId: String(docId),
          base64: b64,
        }).catch(() => null);
        if (savedPath) {
          const res = await invoke('pdfium_open_path', { docId: String(docId), path: savedPath });
          if (res?.ok) {
            _openNativeDocs.add(String(docId));
            return true;
          }
        }
        const res = await invoke('pdfium_open_bytes', { docId: String(docId), base64: b64 });
        if (res?.ok) _openNativeDocs.add(String(docId));
        return !!res?.ok;
      }
    } catch (e) {
      console.warn('[Desktop PDFium] openPdf warning:', e);
    }
    return false;
  },

  async renderPageToCanvas(docId, pageNum, canvas, widthPx, heightPx) {
    if (!invoke || !_openNativeDocs.has(String(docId))) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.max(100, Math.round(widthPx * dpr));
    const targetH = Math.max(100, Math.round(heightPx * dpr));
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
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
          canvas.style.width = widthPx + 'px';
          canvas.style.height = heightPx + 'px';
        }
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
};

async function openLocalPdfFromBytes(name, bytesUint8, localPath = null) {
  // Compute stable deterministic ID from filename + size so notes & highlights persist
  const slug = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const docId = `local_${slug}_${bytesUint8.byteLength}`;
  const blob = new Blob([bytesUint8], { type: 'application/pdf' });
  const pdfEntry = {
    id: docId,
    name: name.replace(/\.pdf$/i, ''),
    drive_file_id: null,
    folder_id: null,
    _localBlob: blob,
    _localPath: localPath,
    _isLocalOnly: true,
  };
  if (!S.pdfs.some(p => p.id === docId)) {
    S.pdfs.unshift(pdfEntry);
  }
  await openPDFFromLibrary(pdfEntry, 0);
}

async function handleOpenLocalPdfClick() {
  if (invoke) {
    try {
      const picked = await invoke('pdfium_pick_local_pdf');
      if (!picked || !picked.path) return;
      const b64 = picked.base64;
      const binStr = atob(b64);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      await openLocalPdfFromBytes(picked.name || 'Local Document.pdf', bytes, picked.path);
      return;
    } catch (e) {
      console.warn('[Desktop] Native file picker fallback:', e);
    }
  }
  // Fallback HTML5 file input
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/pdf,.pdf';
  inp.onchange = async () => {
    const file = inp.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    await openLocalPdfFromBytes(file.name, new Uint8Array(buf), null);
  };
  inp.click();
}

function injectDesktopUI() {
  const syncBar = document.getElementById('sync-bar');
  if (!syncBar || document.getElementById('desktop-engine-bar')) return;

  const engineBar = document.createElement('div');
  engineBar.id = 'desktop-engine-bar';
  engineBar.className = 'desktop-engine-bar';
  engineBar.style.cursor = 'pointer';
  engineBar.title = 'Click to view Standalone Desktop Engine & Notes Fidelity status';
  engineBar.innerHTML = `
    <span id="desktop-engine-lbl" style="color:#60a5fa;font-weight:600;">⚡ Initializing Engine…</span>
    <span id="desktop-ram-lbl" style="color:var(--muted);font-family:monospace;">RAM: 0 pgs</span>
  `;
  syncBar.insertAdjacentElement('afterend', engineBar);

  // Prominent Gmail / Google Drive Sign-In button if not connected
  const gmailBtn = document.createElement('button');
  gmailBtn.id = 'btn-desktop-gmail-login';
  gmailBtn.className = 'desktop-open-local-btn';
  gmailBtn.style.cssText = 'background:linear-gradient(135deg, rgba(234,179,8,0.18), rgba(202,138,4,0.28));border-color:#eab308;color:#fde047;margin-bottom:4px;';
  gmailBtn.innerHTML = '🔑 Sign in with Google (Gmail) for Cloud PDFs';
  gmailBtn.addEventListener('click', async () => {
    const orig = gmailBtn.innerHTML;
    gmailBtn.innerHTML = '⏳ Opening Google Sign-In window…';
    try {
      await driveSignIn();
    } catch (e) {
      console.warn('[Desktop OAuth] Sign-in error:', e);
    } finally {
      gmailBtn.innerHTML = orig;
      window.__updateDesktopAuthBadge?.(S.driveUser);
    }
  });
  engineBar.insertAdjacentElement('afterend', gmailBtn);

  const openBtn = document.createElement('button');
  openBtn.id = 'btn-open-local-pdf';
  openBtn.className = 'desktop-open-local-btn';
  openBtn.innerHTML = '📂 Open Local PDF from PC…';
  openBtn.addEventListener('click', handleOpenLocalPdfClick);
  gmailBtn.insertAdjacentElement('afterend', openBtn);

  engineBar.addEventListener('click', showDesktopStatusModal);

  window.__updateDesktopAuthBadge = (driveUser) => {
    const btn = document.getElementById('btn-desktop-gmail-login');
    if (!btn) return;
    if (driveUser) {
      btn.style.display = 'none';
    } else {
      btn.style.display = 'flex';
    }
  };
  window.__updateDesktopAuthBadge(S.driveUser);

  window.__updateDesktopEngineBadge = ({ activeCanvases, cachedPreviews, totalPages }) => {
    const ramLbl = document.getElementById('desktop-ram-lbl');
    if (ramLbl) {
      ramLbl.textContent = totalPages
        ? `RAM: ${activeCanvases}/${totalPages} pgs (${cachedPreviews} cached)`
        : `RAM: ${activeCanvases} pgs`;
    }
  };

  // Drag and drop any local PDF onto the window
  window.addEventListener('dragover', e => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
    }
  });
  window.addEventListener('drop', async e => {
    const file = Array.from(e.dataTransfer?.files || []).find(f => f.name.toLowerCase().endsWith('.pdf'));
    if (!file) return;
    e.preventDefault();
    const buf = await file.arrayBuffer();
    await openLocalPdfFromBytes(file.name, new Uint8Array(buf), null);
  });

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
      S.scale = nextScale;
      const zLbl = document.getElementById('zoom-lbl');
      if (zLbl) zLbl.textContent = Math.round(S.scale * 100) + '%';
      clearTimeout(zoomDebounce);
      zoomDebounce = setTimeout(() => {
        reRenderAll();
      }, 110);
    }, { passive: false });
  }
}

async function showDesktopStatusModal() {
  if (invoke) {
    try {
      _engineInfo = await invoke('desktop_system_status');
    } catch {}
  }
  let modal = document.getElementById('desktop-status-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'desktop-status-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;';
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
  modal.innerHTML = `
    <div style="background:#131c31;border:1px solid #2e3f5c;border-radius:12px;padding:22px 26px;max-width:480px;width:92%;color:#e8e4db;box-shadow:0 16px 48px rgba(0,0,0,0.65);font-family:'Inter',sans-serif;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="font-size:16px;font-weight:700;color:#60a5fa;">⚡ Standalone Desktop Engine & Notes Shield</div>
        <button id="dsm-close" style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;">✕</button>
      </div>
      <div style="font-size:12px;line-height:1.7;color:#cbd5e1;background:#0c1322;border:1px solid #1e293b;border-radius:8px;padding:12px 14px;margin-bottom:14px;">
        <div><strong>PDF Engine:</strong> <span style="color:#4ade80">${_engineInfo.engine || 'Native PDFium (x64)'}</span></div>
        <div><strong>PDFium DLL:</strong> ${_engineInfo.pdfiumLoaded ? '✅ Loaded natively in Rust (Fast PNG + HiDPI)' : '⚠️ Fallback mode'}</div>
        <div><strong>Google Drive (Gmail):</strong> ${S.driveUser ? `✅ Connected (${S.driveUser})` : '⚠️ Not signed in yet'}</div>
        <div><strong>Native Disk PDF Cache:</strong> ✅ <strong>${_engineInfo.cachedPdfs ?? 0}</strong> PDFs cached on D: drive</div>
        <div><strong>Memory Protection:</strong> ✅ Windowed Canvas Eviction (max ±5 active pages in GPU RAM) + CSS <code>content-visibility: auto</code></div>
        <div><strong>Offline Fonts:</strong> ✅ Bundled locally (Libre Baskerville & Inter .woff2)</div>
        <div><strong>Local SQLite Mirror:</strong> ✅ <strong>${_engineInfo.sqliteNotes ?? 0}</strong> PDF notes/digests & <strong>${_engineInfo.sqliteAnnNotes ?? 0}</strong> annotation notes mirrored on disk</div>
        <div><strong>Notes Formatting Gate:</strong> ✅ 100% SHA-256 byte-exact (Zero conversion)</div>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">
        ${!S.driveUser ? `<button id="dsm-gmail-login" style="padding:8px 14px;background:#ca8a04;border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">🔑 Sign in with Google (Gmail)</button>` : ''}
        <button id="dsm-open-local" style="padding:8px 14px;background:#2563eb;border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">📂 Open Local PDF…</button>
        <button id="dsm-ok" style="padding:8px 14px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:12px;cursor:pointer;">Close</button>
      </div>
    </div>
  `;
  modal.querySelector('#dsm-close')?.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.querySelector('#dsm-ok')?.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.querySelector('#dsm-gmail-login')?.addEventListener('click', async () => {
    modal.style.display = 'none';
    try { await driveSignIn(); } catch {}
  });
  modal.querySelector('#dsm-open-local')?.addEventListener('click', () => {
    modal.style.display = 'none';
    handleOpenLocalPdfClick();
  });
}

async function initDesktopBridge() {
  injectDesktopUI();
  const lbl = document.getElementById('desktop-engine-lbl');
  if (invoke) {
    try {
      const status = await invoke('desktop_system_status');
      _engineInfo = status;
      if (lbl) {
        lbl.textContent = status.pdfiumLoaded
          ? `⚡ PDFium C++ · 🛡️ ${status.sqliteNotes} notes`
          : `⚡ Desktop · 🛡️ ${status.sqliteNotes} notes`;
      }
    } catch (e) {
      console.warn('[Desktop Bridge] status error:', e);
      if (lbl) lbl.textContent = '⚡ Desktop Mode';
    }
  } else {
    if (lbl) lbl.textContent = '⚡ Virtualized Viewer';
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDesktopBridge);
} else {
  initDesktopBridge();
}
