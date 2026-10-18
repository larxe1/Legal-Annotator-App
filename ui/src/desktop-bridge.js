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

function injectDesktopUI() {
  if (document.getElementById('desktop-engine-bar')) return;

  // Lower-right floating vaulting indicator pill
  const engineBar = document.createElement('div');
  engineBar.id = 'desktop-engine-bar';
  engineBar.className = 'desktop-engine-bar';
  engineBar.title = 'Click to view Standalone Desktop Engine & Vault status';
  engineBar.innerHTML = `
    <span class="desktop-engine-pulse">⚡</span>
    <span id="desktop-engine-lbl" style="color:#60a5fa;font-weight:600;">PDFium</span>
    <span style="color:#475569;">·</span>
    <span id="desktop-ram-lbl" style="color:#cbd5e1;font-family:monospace;">Vaulting…</span>
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
    updBtn.style.cssText = 'background:none;border:1px solid var(--navy-b);color:#60a5fa;border-radius:6px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:13px;transition:all .15s;';
    updBtn.innerHTML = '⚡';
    updBtn.addEventListener('click', showDesktopStatusModal);
    settingsBtn.insertAdjacentElement('beforebegin', updBtn);
  }

  // Prominent Gmail / Google Drive Sign-In button if not connected
  const driveBar = document.getElementById('drive-bar');
  if (driveBar) {
    const gmailBtn = document.createElement('button');
    gmailBtn.id = 'btn-desktop-gmail-login';
    gmailBtn.className = 'desktop-gmail-login-btn';
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
      if (ramLbl) {
        ramLbl.textContent = `${totalPages}/${totalPages} pgs`;
        ramLbl.style.color = '#4ade80';
      }
      if (engineLbl) {
        engineLbl.textContent = 'Vaulted';
        engineLbl.style.color = '#4ade80';
      }
      if (pulse) pulse.textContent = '✅';

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
      bar.style.display = 'flex';
      void bar.offsetWidth; // Force reflow for CSS transition
      bar.classList.add('visible');

      const pct = Math.round((activeCanvases / totalPages) * 100);
      if (engineLbl) {
        engineLbl.textContent = 'PDFium';
        engineLbl.style.color = '#60a5fa';
      }
      if (pulse) pulse.textContent = '⚡';
      if (ramLbl) {
        ramLbl.textContent = `Vault: ${activeCanvases}/${totalPages} (${pct}%)`;
        ramLbl.style.color = '#cbd5e1';
      }
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

function showUpdateBanner(info) {
  _updateInfo = info;
  let pill = document.getElementById('desktop-update-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'desktop-update-pill';
    pill.style.cssText = [
      'position:fixed',
      'bottom:58px',
      'right:20px',
      'z-index:1250',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'padding:9px 16px',
      'background:linear-gradient(135deg, rgba(16,185,129,0.95), rgba(5,150,105,0.95))',
      'border:1px solid #6ee7b7',
      'border-radius:22px',
      'box-shadow:0 8px 28px rgba(0,0,0,0.55)',
      'color:#ffffff',
      'font-family:Inter,system-ui,sans-serif',
      'font-size:12px',
      'font-weight:600',
      'cursor:pointer',
      'user-select:none',
      'transition:transform 0.2s ease, filter 0.2s ease',
    ].join(';');
    document.body.appendChild(pill);
  }
  pill.style.display = 'flex';
  pill.title = info.notes || 'Click to download latest Legal Annotator.exe from GitHub and restart';
  pill.innerHTML = `
    <span>🔄 Update Available (Build #${info.remoteBuild}) — <u>Click to Update &amp; Restart</u></span>
    <button id="desktop-update-dismiss" title="Dismiss" style="background:none;border:none;color:#d1fae5;font-size:13px;cursor:pointer;padding:0 2px;">✕</button>
  `;
  pill.querySelector('#desktop-update-dismiss')?.addEventListener('click', (e) => {
    e.stopPropagation();
    pill.style.display = 'none';
  });
  pill.onclick = async () => {
    if (pill.dataset.updating === '1') return;
    pill.dataset.updating = '1';
    pill.style.cursor = 'wait';
    pill.innerHTML = `<span>⏳ Downloading update from GitHub (~32 MB)… Please wait</span>`;
    try {
      await invoke('desktop_apply_github_update', { downloadUrl: info.downloadUrl || null });
      pill.innerHTML = `<span>✅ Update installed! Restarting app…</span>`;
    } catch (err) {
      pill.dataset.updating = '0';
      pill.style.cursor = 'pointer';
      pill.style.background = 'linear-gradient(135deg, #b91c1c, #991b1b)';
      pill.innerHTML = `<span>⚠️ Update failed: ${err} (Click to retry)</span>`;
    }
  };
}

async function checkAndNotifyGitHubUpdate(manual = false) {
  if (!invoke) return null;
  try {
    const info = await invoke('desktop_check_github_update');
    _updateInfo = info;
    if (info?.hasUpdate) {
      showUpdateBanner(info);
    }
    return info;
  } catch (e) {
    if (manual) console.warn('[Desktop Auto-Update] Check error:', e);
    return null;
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
  const buildLbl = _updateInfo?.localBuild ? `v${_updateInfo.localVersion || '1.1.0'} (Build #${_updateInfo.localBuild})` : 'v1.1.0';
  modal.innerHTML = `
    <div style="background:#131c31;border:1px solid #2e3f5c;border-radius:12px;padding:22px 26px;max-width:480px;width:92%;color:#e8e4db;box-shadow:0 16px 48px rgba(0,0,0,0.65);font-family:'Inter',sans-serif;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="font-size:16px;font-weight:700;color:#60a5fa;">⚡ Standalone Desktop Engine &amp; Auto-Updater</div>
        <button id="dsm-close" style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;">✕</button>
      </div>
      <div style="font-size:12px;line-height:1.7;color:#cbd5e1;background:#0c1322;border:1px solid #1e293b;border-radius:8px;padding:12px 14px;margin-bottom:14px;">
        <div><strong>Installed Build:</strong> <span style="color:#93c5fd">${buildLbl}</span></div>
        <div><strong>PDF Engine:</strong> <span style="color:#4ade80">${_engineInfo.engine || 'Native PDFium (x64)'}</span></div>
        <div><strong>PDFium DLL:</strong> ${_engineInfo.pdfiumLoaded ? '✅ Embedded &amp; Loaded natively in Rust' : '⚠️ Fallback mode'}</div>
        <div><strong>Google Drive (Gmail):</strong> ${S.driveUser ? `✅ Connected (${S.driveUser})` : '⚠️ Not signed in yet'}</div>
        <div><strong>Native Disk PDF Cache:</strong> ✅ <strong>${_engineInfo.cachedPdfs ?? 0}</strong> PDFs cached locally</div>
        <div><strong>Permanent Page Vault:</strong> ✅ Rendered pages &amp; text layers stay permanently vaulted</div>
        <div><strong>Local SQLite Mirror:</strong> ✅ <strong>${_engineInfo.sqliteNotes ?? 0}</strong> PDF notes/digests &amp; <strong>${_engineInfo.sqliteAnnNotes ?? 0}</strong> annotation notes mirrored</div>
        <div id="dsm-update-status" style="margin-top:6px;padding-top:6px;border-top:1px solid #1e293b;color:#a7f3d0;">
          ${_updateInfo?.hasUpdate ? `🔄 <strong>New GitHub Update Available: Build #${_updateInfo.remoteBuild}</strong>` : '✅ GitHub Auto-Updater active (checks on startup)'}
        </div>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;">
        ${!S.driveUser ? `<button id="dsm-gmail-login" style="padding:8px 14px;background:#ca8a04;border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">🔑 Sign in with Google (Gmail)</button>` : ''}
        <button id="dsm-check-update" style="padding:8px 14px;background:#059669;border:none;border-radius:6px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">🔄 Check for Updates</button>
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
  modal.querySelector('#dsm-check-update')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const statusEl = modal.querySelector('#dsm-update-status');
    btn.disabled = true;
    btn.textContent = '⏳ Checking GitHub…';
    const info = await checkAndNotifyGitHubUpdate(true);
    if (info?.hasUpdate) {
      if (statusEl) {
        statusEl.innerHTML = `🔄 <strong>Update Found (Build #${info.remoteBuild})!</strong> Downloading &amp; restarting…`;
      }
      btn.textContent = '⬇️ Installing Update…';
      try {
        await invoke('desktop_apply_github_update', { downloadUrl: info.downloadUrl || null });
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '🔄 Retry Update';
        if (statusEl) statusEl.innerHTML = `<span style="color:#fca5a5;">⚠️ Update failed: ${err}</span>`;
      }
    } else {
      btn.disabled = false;
      btn.textContent = '✅ Up to Date';
      if (statusEl) {
        statusEl.innerHTML = `✅ You are on the latest build (Build #${info?.localBuild ?? 2}).`;
      }
    }
  });
}

window.openDesktopEngineStatus = showDesktopStatusModal;

async function initDesktopBridge() {
  injectDesktopUI();
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
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDesktopBridge);
} else {
  initDesktopBridge();
}
