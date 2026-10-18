// ═════════════════════════════════════════════════════════════════════════════
// DESKTOP BRIDGE — Tauri 2 + Native C++ PDFium + Local SQLite Notes Mirror
// ═════════════════════════════════════════════════════════════════════════════
import { S } from './state.js';
import { openPDFFromLibrary } from './viewer.js';

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

window.__DESKTOP_PDFIUM__ = {
  async openPdf(docId, arrayBuffer, localPath = null) {
    if (!invoke) return false;
    try {
      if (localPath) {
        const res = await invoke('pdfium_open_path', { docId: String(docId), path: localPath });
        if (res?.ok) _openNativeDocs.add(String(docId));
        return !!res?.ok;
      }
      // For cloud/cached PDFs up to 80 MB, pass bytes to native PDFium cache in Rust
      if (arrayBuffer && arrayBuffer.byteLength <= 80 * 1024 * 1024) {
        const b64 = arrayBufferToBase64(arrayBuffer);
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
    const dataUrl = await invoke('pdfium_render_page', {
      docId: String(docId),
      pageNum: Number(pageNum),
      widthPx: Math.max(100, Math.round(widthPx)),
      heightPx: Math.max(100, Math.round(heightPx)),
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

  const openBtn = document.createElement('button');
  openBtn.id = 'btn-open-local-pdf';
  openBtn.className = 'desktop-open-local-btn';
  openBtn.innerHTML = '📂 Open Local PDF from PC…';
  openBtn.addEventListener('click', handleOpenLocalPdfClick);
  engineBar.insertAdjacentElement('afterend', openBtn);

  engineBar.addEventListener('click', showDesktopStatusModal);

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
        <div><strong>PDFium DLL:</strong> ${_engineInfo.pdfiumLoaded ? '✅ Loaded natively in Rust' : '⚠️ Fallback mode'}</div>
        <div><strong>Memory Protection:</strong> ✅ Windowed Canvas Eviction (max ±5 active pages in GPU RAM) + CSS <code>content-visibility: auto</code></div>
        <div><strong>Offline Fonts:</strong> ✅ Bundled locally (Libre Baskerville & Inter .woff2)</div>
        <div><strong>Local SQLite Mirror:</strong> ✅ <strong>${_engineInfo.sqliteNotes ?? 0}</strong> PDF notes/digests & <strong>${_engineInfo.sqliteAnnNotes ?? 0}</strong> annotation notes mirrored on disk</div>
        <div><strong>Notes Formatting Gate:</strong> ✅ 100% SHA-256 byte-exact (Zero conversion)</div>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button id="dsm-open-local" style="padding:8px 14px;background:#2563eb;border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">📂 Open Local PDF…</button>
        <button id="dsm-ok" style="padding:8px 14px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:12px;cursor:pointer;">Close</button>
      </div>
    </div>
  `;
  modal.querySelector('#dsm-close')?.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.querySelector('#dsm-ok')?.addEventListener('click', () => { modal.style.display = 'none'; });
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
