// ═══════════════════════════════════════════════
// GOOGLE DRIVE — auth + upload + fetch PDF
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { toast, syncSpin, syncOK, syncErr } from './ui.js';
import { getCachedPDF, setCachedPDF, deleteCachedPDF } from './pdfcache.js';
import { safeStorageSet, safeStorageGet, safeStorageRemove } from './storage.js';

const CLIENT_ID   = window.APP_CONFIG?.GOOGLE_CLIENT_ID || '';
const SCOPE       = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Legal Annotator';

let _tokenRefreshTimer = null;
let _healthCheckInterval = null;

// ── Internal: request/refresh an access token ──
// silent=true → no popup (works if user already granted + has active Google session)
function _requestToken(silent = false) {
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: async (resp) => {
        if (resp.error) { reject(resp); return; }
        S.driveToken = resp.access_token;
        safeStorageSet('driveToken', S.driveToken);
        safeStorageSet('driveTokenExpiry', Date.now() + 3500000); // ~58 mins
        // Get user info (only needed on first sign-in)
        if (!S.driveUser) {
          try {
            const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
              headers: { Authorization: `Bearer ${S.driveToken}` }
            });
            const info = await r.json();
            S.driveUser = info.email || 'Connected';
            safeStorageSet('driveUser', S.driveUser);
          } catch {
            S.driveUser = 'Connected';
            safeStorageSet('driveUser', S.driveUser);
          }
        }
        // Ensure our app folder exists
        S.driveFolderId = await ensureAppFolder();
        safeStorageSet('driveFolderId', S.driveFolderId);
        updateDriveBar();
        _scheduleRefresh();   // schedule the next silent refresh
        _startHealthCheck(); // begin periodic token health checks
        resolve();
      },
    });
    // prompt: '' = silent (no UI shown if already authorised)
    // prompt: 'select_account' = show picker (used for explicit sign-in)
    client.requestAccessToken({ prompt: silent ? '' : 'select_account' });
  });
}

let _isAutoPrompting = false;

// -- Schedule a silent token refresh ~50 mins from now --
function _scheduleRefresh() {
  if (_tokenRefreshTimer) clearTimeout(_tokenRefreshTimer);
  _tokenRefreshTimer = setTimeout(async () => {
    try {
      await _requestToken(true); // silent
      await _verifyToken();      // confirm it actually works
    } catch {
      // Silent refresh failed — automatically trigger account picker prompt
      _onSessionExpired();
    }
  }, 50 * 60 * 1000); // 50 minutes
}

// -- Start a periodic health check every 5 minutes --
function _startHealthCheck() {
  _stopHealthCheck(); // clear any existing interval first
  _healthCheckInterval = setInterval(async () => {
    // Only check if we think we're signed in
    if (S.driveToken) {
      await _verifyToken();
    }
  }, 5 * 60 * 1000); // every 5 minutes
}

// -- Stop the periodic health check --
function _stopHealthCheck() {
  if (_healthCheckInterval) {
    clearInterval(_healthCheckInterval);
    _healthCheckInterval = null;
  }
}

// -- Ping Google OAuth endpoint to confirm token is actually valid --
async function _verifyToken() {
  if (!S.driveToken) return;
  try {
    const r = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(S.driveToken)}`
    );
    if (r.status === 400 || r.status === 401) {
      console.warn('[Drive] Token verification failed (expired or revoked):', r.status);
      _onSessionExpired();
    } else if (r.ok) {
      hideDriveWarning();
    }
  } catch {
    // Network error — don't sign out, just warn
    showDriveWarning('No internet connection. Drive is offline.');
  }
}

// -- Called when we detect the Drive session is dead / needs login --
export function _onSessionExpired() {
  _stopHealthCheck();
  if (_tokenRefreshTimer) { clearTimeout(_tokenRefreshTimer); _tokenRefreshTimer = null; }
  S.driveToken    = null;
  S.driveUser     = null;
  S.driveFolderId = null;
  safeStorageRemove('driveToken');
  safeStorageRemove('driveUser');
  safeStorageRemove('driveTokenExpiry');
  safeStorageRemove('driveFolderId');
  updateDriveBar();

  // Automatically trigger the Google Account Picker prompt so user just clicks their email
  if (!_isAutoPrompting && typeof google !== 'undefined' && google.accounts?.oauth2) {
    _isAutoPrompting = true;
    showDriveWarning('Google Drive session expired. Opening sign-in prompt...');
    _requestToken(false)
      .then(() => {
        _isAutoPrompting = false;
        hideDriveWarning();
        toast('Google Drive reconnected!');
      })
      .catch(err => {
        _isAutoPrompting = false;
        console.warn('Auto-login prompt cancelled or blocked:', err);
        showDriveWarning('Google Drive session expired. Click "Sign in again" to reconnect.');
      });
  } else {
    showDriveWarning('Google Drive session expired. Click "Sign in again" to reconnect.');
  }
}

// -- Show / hide the Drive warning banner --
export function showDriveWarning(msg) {
  let banner = document.getElementById('drive-warn-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'drive-warn-banner';
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
      'background:#7f1d1d', 'color:#fecaca',
      'font-size:13px', 'font-family:Inter,sans-serif',
      'padding:10px 16px', 'display:flex', 'align-items:center', 'gap:12px',
      'box-shadow:0 4px 12px rgba(0,0,0,.5)',
      'border-bottom:1px solid #991b1b',
      'animation:slideDown .25s ease',
    ].join(';');
    document.head.insertAdjacentHTML('beforeend',
      '<style>@keyframes slideDown{from{transform:translateY(-100%)}to{transform:translateY(0)}}</style>');
    document.body.appendChild(banner);
  }
  banner.innerHTML = `
    <span style="font-size:18px">⚠️</span>
    <span style="flex:1">${msg}</span>
    <button id="drive-warn-signin" style="background:#991b1b;border:1px solid #ef4444;color:#fecaca;
      border-radius:5px;padding:4px 12px;cursor:pointer;font-size:12px;font-family:Inter,sans-serif;
      white-space:nowrap;transition:background .15s">Sign in again</button>
    <button id="drive-warn-close" style="background:none;border:none;color:#fca5a5;font-size:18px;
      cursor:pointer;padding:0 2px;line-height:1" title="Dismiss">×</button>
  `;
  document.getElementById('drive-warn-signin')?.addEventListener('click', async () => {
    try {
      await driveSignIn();
      hideDriveWarning();
      toast('Google Drive reconnected!');
    } catch { toast('Sign-in failed. Try again.'); }
  });
  document.getElementById('drive-warn-close')?.addEventListener('click', hideDriveWarning);
}

export function hideDriveWarning() {
  document.getElementById('drive-warn-banner')?.remove();
}

// ── Sign in (user-initiated, shows account picker) ──
export async function driveSignIn() {
  return _requestToken(false);
}

export function driveSignOut() {
  if (S.driveToken) google.accounts.oauth2.revoke(S.driveToken);
  if (_tokenRefreshTimer) clearTimeout(_tokenRefreshTimer);
  _stopHealthCheck();
  S.driveToken = null;
  S.driveUser  = null;
  S.driveFolderId = null;
  localStorage.removeItem('driveToken');
  localStorage.removeItem('driveUser');
  localStorage.removeItem('driveTokenExpiry');
  localStorage.removeItem('driveFolderId');
  hideDriveWarning();
  updateDriveBar();
}

function updateDriveBar() {
  const userEl = document.getElementById('drive-user');
  const btnEl  = document.getElementById('drive-sign-btn');
  if (S.driveUser) {
    userEl.textContent = S.driveUser;
    btnEl.textContent  = 'Sign out';
    btnEl.onclick = driveSignOut;
  } else {
    userEl.textContent = 'Not connected';
    btnEl.textContent  = 'Sign in';
    btnEl.onclick = async () => {
      try {
        await driveSignIn();
        toast('Google Drive connected!');
        driveOrganizeAll({ silent: true }).catch(() => {});
      } catch {
        toast('Drive sign-in failed');
      }
    };
  }
}

// ── Ensure "Legal Annotator" folder exists in Drive ──
export async function ensureAppFolder() {
  if (!S.driveToken) throw new Error('Not signed in to Google Drive');
  if (S.driveFolderId) {
    try {
      const check = await driveGet(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(S.driveFolderId)}?fields=id,trashed`);
      if (check && check.id && !check.trashed) return S.driveFolderId;
    } catch {
      S.driveFolderId = null;
    }
  }

  const q = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const resp = await driveGet(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,createdTime)&orderBy=createdTime`);
  if (resp.files && resp.files.length > 0) {
    S.driveFolderId = resp.files[0].id;
    safeStorageSet('driveFolderId', S.driveFolderId);
    return S.driveFolderId;
  }

  // Create it
  const meta = { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' };
  const created = await drivePost('https://www.googleapis.com/drive/v3/files?fields=id', meta);
  S.driveFolderId = created.id;
  safeStorageSet('driveFolderId', S.driveFolderId);
  return created.id;
}

// ── Sanitize folder/file name for Drive queries ──
function _cleanDriveName(name) {
  return String(name || 'Untitled').trim().replace(/\s+/g, ' ');
}

function _escapeDriveQueryStr(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ── Ensure a named subfolder exists inside a parent Drive folder ──
export async function driveEnsureSubFolder(name, parentId, folderCache = null) {
  const cleanName = _cleanDriveName(name);
  const safeParent = parentId || S.driveFolderId || (await ensureAppFolder());
  const cacheKey = `${safeParent}::${cleanName.toLowerCase()}`;

  if (folderCache && folderCache.has(cacheKey)) {
    return folderCache.get(cacheKey);
  }

  const q = `name='${_escapeDriveQueryStr(cleanName)}' and mimeType='application/vnd.google-apps.folder' and '${_escapeDriveQueryStr(safeParent)}' in parents and trashed=false`;
  const resp = await driveGet(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=createdTime`);
  if (resp.files && resp.files.length > 0) {
    const foundId = resp.files[0].id;
    if (folderCache) folderCache.set(cacheKey, foundId);
    return foundId;
  }

  // Create it
  const meta = { name: cleanName, mimeType: 'application/vnd.google-apps.folder', parents: [safeParent] };
  const created = await drivePost('https://www.googleapis.com/drive/v3/files?fields=id', meta);
  if (folderCache) folderCache.set(cacheKey, created.id);
  return created.id;
}

// ── Resolve the full ancestor chain [Subject -> Root Folder -> Subfolder -> ... -> Target Folder] ──
export function getLibraryFolderChain(folderId) {
  const folder = S.folders.find(f => f.id === folderId);
  if (!folder) return { subject: null, chain: [] };

  const chain = [folder];
  const seen = new Set([folder.id]);
  let curr = folder;
  while (curr.parent_folder_id) {
    if (seen.has(curr.parent_folder_id)) break; // prevent circular loop
    seen.add(curr.parent_folder_id);
    const parent = S.folders.find(f => f.id === curr.parent_folder_id);
    if (!parent) break;
    chain.unshift(parent);
    curr = parent;
  }

  // Find subject from the folder or its root ancestor
  const subjId = folder.subject_id || chain[0]?.subject_id;
  const subject = subjId ? S.subjects.find(s => s.id === subjId) : null;
  return { subject, chain };
}

// ── Ensure the complete Subject / Folder / Subfolder / ... path exists in Google Drive ──
export async function driveResolveFolderPath(folderId, folderCache = null) {
  if (!S.driveToken) throw new Error('Not signed in to Google Drive');
  const rootId = await ensureAppFolder();
  if (!folderId) return rootId;

  const { subject, chain } = getLibraryFolderChain(folderId);
  if (chain.length === 0) return rootId;

  let currentParentId = rootId;
  if (subject) {
    currentParentId = await driveEnsureSubFolder(subject.name, currentParentId, folderCache);
  }
  for (const fold of chain) {
    currentParentId = await driveEnsureSubFolder(fold.name, currentParentId, folderCache);
  }
  return currentParentId;
}

// ── Ensure a Subject's root folder exists in Google Drive ──
export async function driveResolveSubjectPath(subjectId, folderCache = null) {
  if (!S.driveToken) return null;
  const rootId = await ensureAppFolder();
  const subject = S.subjects.find(s => s.id === subjectId);
  if (!subject) return rootId;
  return driveEnsureSubFolder(subject.name, rootId, folderCache);
}

// ── Sync a single PDF's location and filename in Google Drive after move/rename ──
export async function driveSyncPdfLocation(pdf, folderCache = null) {
  if (!S.driveToken || !pdf) return;
  try {
    const targetDriveFolderId = await driveResolveFolderPath(pdf.folder_id, folderCache);
    if (!targetDriveFolderId) return;

    const desiredName = pdf.name.toLowerCase().endsWith('.pdf') ? _cleanDriveName(pdf.name) : `${_cleanDriveName(pdf.name)}.pdf`;

    // If this is a master PDF (or owns a drive_file_id without linked_pdf_id)
    if (!pdf.linked_pdf_id && pdf.drive_file_id) {
      const info = await driveGet(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(pdf.drive_file_id)}?fields=id,name,parents,trashed`
      );
      if (!info || info.trashed) return;

      const parents = info.parents || [];
      const needsMove = !parents.includes(targetDriveFolderId) || parents.length !== 1;
      const needsRename = info.name !== desiredName;

      if (needsMove || needsRename) {
        const params = new URLSearchParams({ fields: 'id,name,parents' });
        if (needsMove) {
          params.set('addParents', targetDriveFolderId);
          const toRemove = parents.filter(p => p !== targetDriveFolderId).join(',');
          if (toRemove) params.set('removeParents', toRemove);
        }
        await drivePatch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(pdf.drive_file_id)}?${params.toString()}`,
          needsRename ? { name: desiredName } : {}
        );
      }
    } else if (pdf.linked_pdf_id) {
      // It's a shortcut in the library — ensure a Drive shortcut exists in targetDriveFolderId
      const master = S.pdfs.find(p => p.id === pdf.linked_pdf_id);
      const targetFileId = pdf.drive_file_id || master?.drive_file_id;
      if (!targetFileId) return;

      const q = `mimeType='application/vnd.google-apps.shortcut' and '${_escapeDriveQueryStr(targetDriveFolderId)}' in parents and trashed=false`;
      const existing = await driveGet(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,shortcutDetails)`);
      const match = (existing.files || []).find(f => f.shortcutDetails?.targetId === targetFileId);
      if (!match) {
        await drivePost('https://www.googleapis.com/drive/v3/files?fields=id', {
          name: desiredName,
          mimeType: 'application/vnd.google-apps.shortcut',
          parents: [targetDriveFolderId],
          shortcutDetails: { targetId: targetFileId }
        }).catch(() => {});
      } else if (match.name !== desiredName) {
        await drivePatch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(match.id)}?fields=id`, {
          name: desiredName
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('[Drive] driveSyncPdfLocation error:', e);
  }
}

// ── Helper: Run async tasks with bounded concurrency ──
async function _runParallel(items, concurrency, fn) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      try {
        await fn(items[cur], cur);
      } catch (e) {
        console.warn('[Drive Batch Worker]', e);
      }
    }
  });
  await Promise.all(workers);
}

// ── Full Google Drive Organizer: Mirrors the exact App Library structure in Google Drive ──
let _isOrganizingDrive = false;
let _organizeForceLoud = false;
let _organizeDebounceTimer = null;

export function scheduleDriveOrganize(delayMs = 1500) {
  if (!S.driveToken) return;
  if (_organizeDebounceTimer) clearTimeout(_organizeDebounceTimer);
  _organizeDebounceTimer = setTimeout(() => {
    _organizeDebounceTimer = null;
    driveOrganizeAll({ silent: true }).catch(() => {});
  }, delayMs);
}

export async function driveOrganizeAll({ silent = false } = {}) {
  if (!S.driveToken) {
    if (!silent) toast('⚠️ Sign in to Google Drive first to organize your Drive folders.');
    return { ok: false, reason: 'not_signed_in' };
  }
  if (_isOrganizingDrive) {
    if (!silent) {
      _organizeForceLoud = true;
      syncSpin('Organizing Google Drive…');
      toast('⏳ Finishing Google Drive organization…');
    }
    return { ok: false, reason: 'busy' };
  }
  if (!S.subjects?.length && !S.folders?.length && !S.pdfs?.length) {
    return { ok: false, reason: 'empty_library' };
  }

  _isOrganizingDrive = true;
  _organizeForceLoud = !silent;

  const setBtnState = (busy, label) => {
    const btn = document.getElementById('settings-btn-organize-drive');
    if (btn) {
      btn.disabled = busy;
      btn.textContent = label;
    }
  };

  setBtnState(true, '⏳ Organizing Google Drive…');
  if (!silent) {
    syncSpin('Organizing Google Drive…');
    toast('📁 Organizing Google Drive to match your library structure…');
  }

  try {
    const rootId = await ensureAppFolder();

    // 1. Fetch all non-trashed files & folders visible to this app in Google Drive
    const allDriveItems = await driveListAll(
      'trashed=false',
      'id,name,mimeType,parents,createdTime,shortcutDetails'
    );

    const FOLDER_MIME = 'application/vnd.google-apps.folder';
    const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

    const driveFolders = allDriveItems.filter(f => f.mimeType === FOLDER_MIME);
    const driveShortcuts = allDriveItems.filter(f => f.mimeType === SHORTCUT_MIME);
    const driveFiles = allDriveItems.filter(f => f.mimeType !== FOLDER_MIME && f.mimeType !== SHORTCUT_MIME);

    const fileById = new Map(driveFiles.map(f => [f.id, f]));

    // Prime folderCache with existing Drive folders (oldest first so canonical folders win)
    driveFolders.sort((a, b) => String(a.createdTime || '').localeCompare(String(b.createdTime || '')));
    const folderCache = new Map();
    for (const df of driveFolders) {
      if (df.id === rootId) continue;
      for (const pid of (df.parents || [])) {
        const key = `${pid}::${_cleanDriveName(df.name).toLowerCase()}`;
        if (!folderCache.has(key)) {
          folderCache.set(key, df.id);
        }
      }
    }

    // Track all Drive folder IDs that belong to the active library structure
    const activeDriveFolderIds = new Set([rootId]);

    // 2. Ensure every Subject folder exists under "Legal Annotator"
    for (const subj of S.subjects) {
      const sDriveId = await driveEnsureSubFolder(subj.name, rootId, folderCache);
      activeDriveFolderIds.add(sDriveId);
    }

    // 3. Ensure every Folder & Subfolder (at any depth) exists in the exact hierarchy
    const foldDriveMap = new Map();
    for (const fold of S.folders) {
      const fDriveId = await driveResolveFolderPath(fold.id, folderCache);
      foldDriveMap.set(fold.id, fDriveId);
      activeDriveFolderIds.add(fDriveId);

      const { subject, chain } = getLibraryFolderChain(fold.id);
      let currParent = rootId;
      if (subject) {
        const sid = folderCache.get(`${currParent}::${_cleanDriveName(subject.name).toLowerCase()}`);
        if (sid) { activeDriveFolderIds.add(sid); currParent = sid; }
      }
      for (const c of chain) {
        const cid = folderCache.get(`${currParent}::${_cleanDriveName(c.name).toLowerCase()}`);
        if (cid) { activeDriveFolderIds.add(cid); currParent = cid; }
      }
    }

    // 4. Group library PDFs by drive_file_id so we know each file's primary folder & shortcut folders
    let movedFiles = 0;
    let renamedFiles = 0;
    let shortcutsSynced = 0;
    let cleanedFolders = 0;

    const primaryByDriveId = new Map();
    const shortcutsByDriveId = new Map();

    for (const pdf of S.pdfs) {
      const driveId = pdf.drive_file_id || (pdf.linked_pdf_id ? S.pdfs.find(p => p.id === pdf.linked_pdf_id)?.drive_file_id : null);
      if (!driveId) continue;
      if (!pdf.linked_pdf_id && !primaryByDriveId.has(driveId)) {
        primaryByDriveId.set(driveId, pdf);
      }
    }
    for (const pdf of S.pdfs) {
      const driveId = pdf.drive_file_id || (pdf.linked_pdf_id ? S.pdfs.find(p => p.id === pdf.linked_pdf_id)?.drive_file_id : null);
      if (!driveId) continue;
      if (!primaryByDriveId.has(driveId)) {
        primaryByDriveId.set(driveId, pdf);
      } else if (primaryByDriveId.get(driveId).id !== pdf.id) {
        if (!shortcutsByDriveId.has(driveId)) shortcutsByDriveId.set(driveId, []);
        shortcutsByDriveId.get(driveId).push(pdf);
      }
    }

    // 5. Move & rename active PDF files in parallel (concurrency = 8)
    const moveTasks = [];
    for (const [driveId, pdf] of primaryByDriveId.entries()) {
      const targetFolderId = foldDriveMap.get(pdf.folder_id);
      if (!targetFolderId) continue;
      activeDriveFolderIds.add(targetFolderId);

      const dFile = fileById.get(driveId);
      if (!dFile || dFile.trashed) continue;

      const desiredName = pdf.name.toLowerCase().endsWith('.pdf') ? _cleanDriveName(pdf.name) : `${_cleanDriveName(pdf.name)}.pdf`;
      const currentParents = dFile.parents || [];
      const needsMove = !currentParents.includes(targetFolderId) || currentParents.length !== 1;
      const needsRename = dFile.name !== desiredName;

      if (needsMove || needsRename) {
        moveTasks.push({ driveId, dFile, targetFolderId, desiredName, needsMove, needsRename });
      }
    }

    if (moveTasks.length > 0) {
      let done = 0;
      await _runParallel(moveTasks, 8, async (task) => {
        const { driveId, dFile, targetFolderId, desiredName, needsMove, needsRename } = task;
        const params = new URLSearchParams({ fields: 'id,name,parents' });
        if (needsMove) {
          params.set('addParents', targetFolderId);
          const removeList = (dFile.parents || []).filter(p => p !== targetFolderId).join(',');
          if (removeList) params.set('removeParents', removeList);
        }
        const updated = await drivePatch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}?${params.toString()}`,
          needsRename ? { name: desiredName } : {}
        );
        dFile.parents = updated.parents || [targetFolderId];
        dFile.name = updated.name || desiredName;
        if (needsMove) movedFiles++;
        if (needsRename) renamedFiles++;
        done++;
        setBtnState(true, `⏳ Moving PDFs (${done}/${moveTasks.length})…`);
      });
    }

    // 6. Sync Google Drive shortcuts in parallel
    const validShortcutKeys = new Set();
    const shortcutTasks = [];
    for (const [driveId, scList] of shortcutsByDriveId.entries()) {
      for (const scPdf of scList) {
        const targetFolderId = foldDriveMap.get(scPdf.folder_id);
        if (!targetFolderId) continue;
        activeDriveFolderIds.add(targetFolderId);

        const desiredName = scPdf.name.toLowerCase().endsWith('.pdf') ? _cleanDriveName(scPdf.name) : `${_cleanDriveName(scPdf.name)}.pdf`;
        const key = `${targetFolderId}::${driveId}`;
        validShortcutKeys.add(key);

        const existingSc = driveShortcuts.find(
          s => s.shortcutDetails?.targetId === driveId && (s.parents || []).includes(targetFolderId)
        );
        if (!existingSc || existingSc.name !== desiredName) {
          shortcutTasks.push({ driveId, targetFolderId, desiredName, existingSc });
        }
      }
    }

    if (shortcutTasks.length > 0) {
      await _runParallel(shortcutTasks, 8, async ({ driveId, targetFolderId, desiredName, existingSc }) => {
        if (!existingSc) {
          await drivePost('https://www.googleapis.com/drive/v3/files?fields=id', {
            name: desiredName,
            mimeType: SHORTCUT_MIME,
            parents: [targetFolderId],
            shortcutDetails: { targetId: driveId }
          });
          shortcutsSynced++;
        } else {
          await drivePatch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(existingSc.id)}?fields=id`, {
            name: desiredName
          });
        }
      });
    }

    // Remove obsolete Drive shortcuts in parallel
    const obsoleteShortcuts = driveShortcuts.filter(sc => {
      const parentId = (sc.parents || [])[0];
      const targetId = sc.shortcutDetails?.targetId;
      return !validShortcutKeys.has(`${parentId}::${targetId}`);
    });
    if (obsoleteShortcuts.length > 0) {
      await _runParallel(obsoleteShortcuts, 8, async (sc) => {
        await driveDeleteRaw(sc.id);
      });
    }

    // 7. Handle any stray/unlinked PDF files sitting loose in root "Legal Annotator" or old obsolete folders
    const strayFiles = driveFiles.filter(dFile => !primaryByDriveId.has(dFile.id));
    if (strayFiles.length > 0) {
      let archiveFolderId = null;
      for (const dFile of strayFiles) {
        const normDriveName = _cleanDriveName(dFile.name).replace(/\.pdf$/i, '').toLowerCase();
        const matchingLibPdf = S.pdfs.find(
          p => !p.drive_file_id && !p.linked_pdf_id && _cleanDriveName(p.name).replace(/\.pdf$/i, '').toLowerCase() === normDriveName
        );
        if (matchingLibPdf) {
          matchingLibPdf.drive_file_id = dFile.id;
          import('./db.js').then(m => m.db.from('pdf_files').update({ drive_file_id: dFile.id }).eq('id', matchingLibPdf.id)).catch(() => {});
          const targetFolderId = foldDriveMap.get(matchingLibPdf.folder_id);
          if (targetFolderId) {
            const removeList = (dFile.parents || []).filter(p => p !== targetFolderId).join(',');
            const params = new URLSearchParams({ addParents: targetFolderId, fields: 'id,parents' });
            if (removeList) params.set('removeParents', removeList);
            await drivePatch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(dFile.id)}?${params.toString()}`, {}).catch(() => {});
            dFile.parents = [targetFolderId];
            movedFiles++;
            continue;
          }
        }

        if (!archiveFolderId) {
          archiveFolderId = await driveEnsureSubFolder('_Unlinked Archive', rootId, folderCache);
          activeDriveFolderIds.add(archiveFolderId);
        }
        const currentParents = dFile.parents || [];
        if (!currentParents.includes(archiveFolderId) || currentParents.length !== 1) {
          const removeList = currentParents.filter(p => p !== archiveFolderId).join(',');
          const params = new URLSearchParams({ addParents: archiveFolderId, fields: 'id,parents' });
          if (removeList) params.set('removeParents', removeList);
          await drivePatch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(dFile.id)}?${params.toString()}`, {}).catch(() => {});
          dFile.parents = [archiveFolderId];
          movedFiles++;
        }
      }
    }

    // 8. Clean up all obsolete/empty Drive folders that are NOT in activeDriveFolderIds
    const finalItems = await driveListAll('trashed=false', 'id,name,mimeType,parents');
    const finalFolders = finalItems.filter(f => f.mimeType === FOLDER_MIME && f.id !== rootId);
    const nonFolderItems = finalItems.filter(f => f.mimeType !== FOLDER_MIME);

    const deletedFolderIds = new Set();
    let madeProgress = true;
    while (madeProgress) {
      madeProgress = false;
      const leafFoldersToDelete = [];
      for (const folder of finalFolders) {
        if (deletedFolderIds.has(folder.id)) continue;
        if (activeDriveFolderIds.has(folder.id)) continue;

        const hasFilesInside = nonFolderItems.some(item => (item.parents || []).includes(folder.id));
        const hasSubfoldersInside = finalFolders.some(
          sub => !deletedFolderIds.has(sub.id) && (sub.parents || []).includes(folder.id)
        );

        if (!hasFilesInside && !hasSubfoldersInside) {
          leafFoldersToDelete.push(folder);
        }
      }

      if (leafFoldersToDelete.length > 0) {
        await _runParallel(leafFoldersToDelete, 8, async (folder) => {
          await driveDeleteRaw(folder.id);
          deletedFolderIds.add(folder.id);
          cleanedFolders++;
        });
        madeProgress = true;
      }
    }

    safeStorageSet('last_drive_organize_ts', Date.now());
    safeStorageSet('drive_organized_v2', '1');

    const summaryParts = [];
    if (movedFiles > 0) summaryParts.push(`${movedFiles} PDF${movedFiles === 1 ? '' : 's'} moved`);
    if (renamedFiles > 0) summaryParts.push(`${renamedFiles} renamed`);
    if (shortcutsSynced > 0) summaryParts.push(`${shortcutsSynced} shortcut${shortcutsSynced === 1 ? '' : 's'} synced`);
    if (cleanedFolders > 0) summaryParts.push(`${cleanedFolders} old folder${cleanedFolders === 1 ? '' : 's'} cleaned`);

    const msg = summaryParts.length > 0
      ? `✅ Drive organized (${summaryParts.join(', ')})!`
      : '✅ Google Drive is 100% organized and in sync with your library!';

    syncOK('DB Sync Active');
    if (_organizeForceLoud) {
      toast(msg);
    } else if (summaryParts.length > 0) {
      console.log('[Drive Auto-Organize]', msg);
    }

    return { ok: true, movedFiles, renamedFiles, shortcutsSynced, cleanedFolders };
  } catch (e) {
    console.error('[Drive Organize Error]', e);
    if (_organizeForceLoud) {
      syncErr('Drive organize failed');
      toast(`❌ Could not organize Google Drive: ${e.message || 'Unknown error'}`);
    }
    return { ok: false, error: e };
  } finally {
    _isOrganizingDrive = false;
    _organizeForceLoud = false;
    setBtnState(false, '📁 Organize Google Drive Folders Now');
  }
}

// ── Upload PDF to Drive ──
// targetFolderId: optional Drive folder ID to place the file in (defaults to root app folder)
export async function driveUploadPDF(file, targetFolderId) {
  if (!S.driveToken) throw new Error('Not signed in to Google Drive');
  if (!S.driveFolderId) S.driveFolderId = await ensureAppFolder();

  const parentId = targetFolderId || S.driveFolderId;

  syncSpin('Uploading to Drive…');
  const meta = {
    name: file.name,
    parents: [parentId],
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', file);

  const resp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${S.driveToken}` },
      body: form,
    }
  );
  if (!resp.ok) {
    const err = await resp.text();
    syncErr('Upload failed');
    throw new Error(err);
  }
  const data = await resp.json();
  syncOK('Uploaded to Drive');
  return data; // { id, name }
}

// ── Fetch PDF bytes from Drive (with RAM + IndexedDB disk cache) ──
export async function driveFetchPDF(drive_file_id, onProgress = null, pdfName = '') {
  if (!drive_file_id) {
    throw new Error('No Google Drive file attached to this PDF entry.');
  }

  // 1. Check in-memory RAM cache (instant 0ms)
  if (S.pdfCache[drive_file_id]) return S.pdfCache[drive_file_id];

  // 2. Check persistent IndexedDB disk cache (instant < 15ms without network)
  const cachedBuf = await getCachedPDF(drive_file_id);
  if (cachedBuf) {
    S.pdfCache[drive_file_id] = cachedBuf;
    syncOK('Loaded from Local Cache');
    return cachedBuf;
  }

  if (!S.driveToken) {
    throw new Error('Not signed in to Google Drive');
  }

  // ── Inner helper: attempt one fetch with the current token ──
  async function _doFetch(token) {
    return fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(drive_file_id)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  }

  syncSpin('Downloading from Drive…');
  let resp = await _doFetch(S.driveToken);

  // ── On 401: try one silent token refresh before giving up ──
  if (resp.status === 401) {
    try {
      await _requestToken(true); // silent refresh — no popup, fast if Google session is active
      resp = await _doFetch(S.driveToken); // retry with the fresh token
    } catch {
      // Silent refresh failed — must show login prompt
      _onSessionExpired();
      throw new Error('Google Drive session expired. Please sign in again.');
    }
    // If the retry also fails with 401, fall through to the error handler below
  }

  if (!resp.ok) {
    if (resp.status === 401) {
      _onSessionExpired();
      throw new Error('Google Drive session expired. Please sign in again.');
    }
    syncErr('Download failed');
    throw new Error(`Drive download failed (${resp.status}): ${resp.statusText || 'File inaccessible'}`);
  }

  // Stream chunks with live percentage & MB progress indicator
  const contentLength = resp.headers.get('Content-Length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  let loaded = 0;

  const reader = resp.body.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;

    if (total > 0) {
      const pct = Math.min(100, Math.round((loaded / total) * 100));
      const loadedMB = (loaded / (1024 * 1024)).toFixed(1);
      const totalMB = (total / (1024 * 1024)).toFixed(1);
      syncSpin(`Downloading: ${pct}% (${loadedMB}/${totalMB} MB)`);
      if (onProgress) onProgress(pct, loadedMB, totalMB);
    } else {
      const loadedMB = (loaded / (1024 * 1024)).toFixed(1);
      syncSpin(`Downloading: ${loadedMB} MB…`);
      if (onProgress) onProgress(null, loadedMB, null);
    }
  }

  const blob = new Blob(chunks, { type: 'application/pdf' });

  // Store Blob directly in RAM — no ArrayBuffer conversion, no extra 150MB memory copy
  S.pdfCache[drive_file_id] = blob;
  syncOK('Downloaded & Cached');

  // Save to persistent IndexedDB disk cache as Blob (single write, zero V8 clone overhead)
  setCachedPDF(drive_file_id, blob, pdfName);
  return blob;
}

// ── Internal helper: fetch with 15s timeout so Drive API calls never hang forever ──
async function _fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Lightweight Drive delete (for empty folders/shortcuts without IndexedDB PDF cache overhead) ──
async function driveDeleteRaw(drive_id) {
  if (!drive_id || !S.driveToken) return;
  await _fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(drive_id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${S.driveToken}` },
  }).catch(() => {});
}

// ── Delete file from Drive + Local Cache ──
export async function driveDeleteFile(drive_file_id) {
  if (!drive_file_id) return;
  delete S.pdfCache[drive_file_id];
  deleteCachedPDF(drive_file_id);
  await driveDeleteRaw(drive_file_id);
}

// ── Helper: Paginated list of all files matching query ──
async function driveListAll(q, fields = 'id,name,mimeType,parents') {
  const results = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({
      q,
      pageSize: '1000',
      fields: `nextPageToken,files(${fields})`,
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await driveGet(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);
    if (data.files && data.files.length) {
      results.push(...data.files);
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return results;
}

// ── Helper: authenticated GET ──
async function driveGet(url) {
  const r = await _fetchWithTimeout(url, { headers: { Authorization: `Bearer ${S.driveToken}` } });
  if (r.status === 401) { _onSessionExpired(); throw new Error('Drive session expired'); }
  if (!r.ok) throw new Error(`Drive request failed (${r.status})`);
  return r.json();
}

// ── Helper: authenticated POST with JSON body ──
async function drivePost(url, body) {
  const r = await _fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${S.driveToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (r.status === 401) { _onSessionExpired(); throw new Error('Drive session expired'); }
  if (!r.ok) throw new Error(`Drive request failed (${r.status})`);
  return r.json();
}

// ── Helper: authenticated PATCH with JSON body ──
async function drivePatch(url, body = {}) {
  const r = await _fetchWithTimeout(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${S.driveToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (r.status === 401) { _onSessionExpired(); throw new Error('Drive session expired'); }
  if (!r.ok) throw new Error(`Drive PATCH failed (${r.status})`);
  return r.json();
}

// ── Init: render drive bar on load ──
export function initDriveBar() {
  const token  = safeStorageGet('driveToken');
  const expiry = safeStorageGet('driveTokenExpiry');
  const user   = safeStorageGet('driveUser');

  if (token && expiry && Date.now() < parseInt(expiry)) {
    // Token still valid from cache — restore session
    S.driveToken    = token;
    S.driveUser     = user;
    S.driveFolderId = safeStorageGet('driveFolderId');
    updateDriveBar();
    // Verify the cached token is actually still accepted by Google
    // (It may have been revoked, even if it hasn't expired yet)
    setTimeout(() => _verifyToken(), 2000);
    _scheduleRefresh();
    _startHealthCheck(); // begin 5-min periodic checks
  } else if (user) {
    // Token expired but user previously signed in — try silent refresh
    S.driveUser = user; // keep name visible while refreshing
    updateDriveBar();
    const trySilent = async () => {
      try {
        await _requestToken(true);
        await _verifyToken();
      } catch {
        _onSessionExpired();
      }
    };
    if (typeof google !== 'undefined') {
      trySilent();
    } else {
      setTimeout(trySilent, 1000);
    }
  } else {
    // Never signed in — render button, onclick already set by updateDriveBar()
    updateDriveBar();
  }
  // NOTE: Do NOT add an addEventListener here — updateDriveBar() already sets btnEl.onclick.
  // Two event bindings on the same button cause duplicate OAuth requests which browsers block.
}
