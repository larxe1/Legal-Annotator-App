// ═══════════════════════════════════════════════════════════════════════════
// SYLLABUS IMPORTER & AUTO-ORDER — Paste syllabus table rows / Drive links,
// auto-fetch PDFs from Google Drive or local files, name cleanly, and sort!
// Includes dedicated Source Gmail Sign-In for restricted links + Diagnostics.
// ═══════════════════════════════════════════════════════════════════════════
import { S } from './state.js';
import { toast, openModal, closeModal } from './ui.js';
import { dbRegisterPDF, dbRenamePDF, dbReorderPDF } from './db.js';
import { driveUploadPDF, driveResolveFolderPath, driveFetchPDF } from './drive.js';
import { getCachedPDF, setCachedPDF } from './pdfcache.js';
import { safeStorageGet, safeStorageSet, safeStorageRemove } from './storage.js';

const CLIENT_ID = window.APP_CONFIG?.GOOGLE_CLIENT_ID || '';
const SYLLABUS_SCOPE = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file email profile';

let _targetFolderId = null;
let _parsedRows = [];
let _sharedFolderFiles = []; // [{ id, name }]
let _localFiles = []; // File[]
let _isRunning = false;
let _diagnosticLogs = []; // string[]

let _syllabusToken = safeStorageGet('syllabusSourceToken') || null;
let _syllabusEmail = safeStorageGet('syllabusSourceEmail') || null;
let _syllabusHasReadonly = false;

const LEGAL_STOPWORDS = new Set([
  'people', 'philippines', 'republic', 'court', 'appeals', 'supreme', 'sandiganbayan',
  'commission', 'department', 'office', 'secretary', 'hon', 'judge', 'justice',
  'spouses', 'heirs', 'estate', 'inc', 'corp', 'corporation', 'company', 'co', 'ltd',
  'bank', 'national', 'central', 'city', 'province', 'municipality', 'barangay',
  'vs', 'v', 'and', 'the', 'of', 'in', 're', 'on', 'for', 'to', 'by', 'at', 'from',
  'de', 'del', 'dela', 'delos', 'las', 'los', 'san', 'sta', 'sto', 'jr', 'sr', 'ii', 'iii', 'iv',
  'et', 'al', 'ano', 'no', 'nos', 'gr', 'am', 'ac', 'bm', 'ca', 'udk', 'l',
  'xxx', 'yyy', 'zzz', 'aaa', 'bbb', 'ccc', 'ddd', 'eee'
]);

function getActiveSourceToken() {
  const exp = Number(safeStorageGet('syllabusSourceExpiry') || 0);
  if (_syllabusToken && (!exp || Date.now() < exp)) {
    return _syllabusToken;
  }
  return S.driveToken || null;
}

// ── Verify token scopes & email via Google tokeninfo / userinfo ──
async function verifySourceTokenStatus() {
  const statusEl = document.getElementById('syl-auth-status');
  const btnEl = document.getElementById('syl-auth-btn');
  if (!statusEl) return;

  const tok = getActiveSourceToken();
  if (!tok) {
    _syllabusHasReadonly = false;
    statusEl.innerHTML = `<span style="color:#fca5a5;">⚠️ Not signed in — restricted Google Drive links require Gmail sign-in</span>`;
    if (btnEl) btnEl.textContent = '🔑 Sign in Gmail for Restricted Links';
    return;
  }

  try {
    const r = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(tok)}`);
    if (!r.ok) {
      if (tok === _syllabusToken) {
        _syllabusToken = null;
        safeStorageRemove('syllabusSourceToken');
      }
      _syllabusHasReadonly = false;
      statusEl.innerHTML = `<span style="color:#fca5a5;">⚠️ Source Gmail session expired — click to sign in for restricted links</span>`;
      if (btnEl) btnEl.textContent = '🔑 Sign in Gmail for Restricted Links';
      return;
    }
    const info = await r.json();
    const scopes = String(info.scope || '');
    const email = _syllabusEmail || info.email || S.driveUser || 'Connected Account';
    _syllabusHasReadonly = scopes.includes('drive.readonly') || scopes.includes(' auth/drive ');

    if (_syllabusHasReadonly) {
      statusEl.innerHTML = `<span style="color:#4ade80;">✅ Reading restricted links as: <strong>${email}</strong> (Shared Read Access active)</span>`;
      if (btnEl) btnEl.textContent = '🔄 Switch Source Gmail';
    } else {
      statusEl.innerHTML = `<span style="color:#fcd34d;">⚠️ Signed in as <strong>${email}</strong>, but token only has app-file access (missing shared-link read access)</span>`;
      if (btnEl) btnEl.textContent = '🔑 Authorize Gmail for Restricted Links';
    }
  } catch {
    statusEl.innerHTML = `<span style="color:var(--muted);">🔑 Source Gmail: ${_syllabusEmail || S.driveUser || 'Default'}</span>`;
  }
}

// ── Sign in with a specific Gmail account for reading restricted syllabus links ──
async function signInSyllabusGmail() {
  const btnEl = document.getElementById('syl-auth-btn');
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = '⏳ Signing in…';
  }
  try {
    let accessToken = null;
    if (typeof window.__DESKTOP_GOOGLE_OAUTH__ === 'function') {
      const resp = await window.__DESKTOP_GOOGLE_OAUTH__(CLIENT_ID, SYLLABUS_SCOPE, false, true);
      accessToken = resp?.access_token || null;
    } else if (typeof google !== 'undefined' && google.accounts?.oauth2) {
      accessToken = await new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: SYLLABUS_SCOPE,
          callback: resp => {
            if (resp.error) reject(new Error(resp.error_description || resp.error));
            else resolve(resp.access_token);
          },
        });
        client.requestAccessToken({ prompt: 'select_account consent' });
      });
    } else {
      throw new Error('Google Sign-In library not loaded');
    }

    if (!accessToken) throw new Error('No access token returned');

    let email = 'Connected Gmail';
    try {
      const ur = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (ur.ok) {
        const uinfo = await ur.json();
        if (uinfo.email) email = uinfo.email;
      }
    } catch {}

    _syllabusToken = accessToken;
    _syllabusEmail = email;
    safeStorageSet('syllabusSourceToken', accessToken);
    safeStorageSet('syllabusSourceEmail', email);
    safeStorageSet('syllabusSourceExpiry', Date.now() + 3500_000);

    // If the user wasn't signed into the main Drive at all, also populate S.driveToken
    if (!S.driveToken) {
      S.driveToken = accessToken;
      S.driveUser = email;
      safeStorageSet('driveToken', accessToken);
      safeStorageSet('driveUser', email);
    }

    await verifySourceTokenStatus();
    toast(`✅ Signed in as ${email} for restricted syllabus links!`);
  } catch (err) {
    console.warn('[Syllabus] Gmail sign-in error:', err);
    toast('⚠️ Gmail sign-in cancelled or failed: ' + (err.message || err));
    await verifySourceTokenStatus();
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

// ── Inject modal DOM & styles once ──
function ensureSyllabusModal() {
  if (document.getElementById('mo-syllabus')) return;

  const style = document.createElement('style');
  style.textContent = `
    #mo-syllabus .syl-paste-zone {
      min-height: 76px;
      max-height: 120px;
      overflow-y: auto;
      background: rgba(10, 16, 30, 0.75);
      border: 1.5px dashed var(--gold);
      border-radius: 8px;
      padding: 9px 12px;
      color: #e8e4db;
      font-size: 12px;
      line-height: 1.45;
      outline: none;
      cursor: text;
      transition: border-color .15s, background .15s;
    }
    #mo-syllabus .syl-paste-zone:focus {
      border-style: solid;
      background: rgba(10, 16, 30, 0.95);
    }
    #mo-syllabus .syl-paste-zone:empty::before {
      content: attr(data-placeholder);
      color: var(--muted);
      pointer-events: none;
      display: block;
    }
    #mo-syllabus .syl-paste-zone table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
    }
    #mo-syllabus .syl-paste-zone td, #mo-syllabus .syl-paste-zone th {
      border: 1px solid rgba(255,255,255,0.1);
      padding: 2px 6px;
    }
    #mo-syllabus .syl-row-list {
      flex: 1;
      min-height: 150px;
      max-height: 250px;
      overflow-y: auto;
      background: rgba(10, 16, 30, 0.55);
      border: 1px solid var(--navy-b);
      border-radius: 8px;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    #mo-syllabus .syl-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 8px;
      background: var(--navy);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 6px;
      font-size: 12px;
    }
    #mo-syllabus .syl-num {
      min-width: 42px;
      text-align: center;
      font-weight: 600;
      color: var(--gold-l);
      background: rgba(201,168,76,0.14);
      border: 1px solid rgba(201,168,76,0.3);
      border-radius: 4px;
      padding: 2px 5px;
      font-size: 11px;
      flex-shrink: 0;
    }
    #mo-syllabus .syl-name-in {
      flex: 1;
      background: rgba(0,0,0,0.25);
      border: 1px solid var(--navy-b);
      border-radius: 4px;
      padding: 4px 7px;
      color: #e8e4db;
      font-size: 12px;
      font-family: 'Inter', sans-serif;
      min-width: 130px;
    }
    #mo-syllabus .syl-name-in:focus {
      border-color: var(--gold);
      outline: none;
    }
    #mo-syllabus .syl-badge {
      font-size: 10.5px;
      padding: 2px 7px;
      border-radius: 4px;
      white-space: nowrap;
      font-weight: 500;
      flex-shrink: 0;
      max-width: 215px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #mo-syllabus .syl-badge.existing {
      background: rgba(74, 222, 128, 0.14);
      color: #4ade80;
      border: 1px solid rgba(74, 222, 128, 0.3);
    }
    #mo-syllabus .syl-badge.drive {
      background: rgba(59, 130, 246, 0.16);
      color: #93c5fd;
      border: 1px solid rgba(59, 130, 246, 0.35);
      cursor: pointer;
    }
    #mo-syllabus .syl-badge.library {
      background: rgba(6, 182, 212, 0.16);
      color: #67e8f9;
      border: 1px solid rgba(6, 182, 212, 0.35);
    }
    #mo-syllabus .syl-badge.shared {
      background: rgba(168, 85, 247, 0.16);
      color: #d8b4fe;
      border: 1px solid rgba(168, 85, 247, 0.35);
    }
    #mo-syllabus .syl-badge.local {
      background: rgba(201, 168, 76, 0.18);
      color: var(--gold-l);
      border: 1px solid rgba(201, 168, 76, 0.35);
    }
    #mo-syllabus .syl-badge.missing, #mo-syllabus .syl-badge.failed {
      background: rgba(248, 113, 113, 0.16);
      color: #fca5a5;
      border: 1px solid rgba(248, 113, 113, 0.38);
      cursor: pointer;
    }
    #mo-syllabus .syl-row-del {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      font-size: 13px;
      padding: 2px 5px;
      border-radius: 4px;
    }
    #mo-syllabus .syl-row-del:hover {
      color: var(--red);
      background: rgba(248,113,113,0.1);
    }
    #mo-syllabus .syl-diag-panel {
      background: rgba(127, 29, 29, 0.22);
      border: 1px solid rgba(248, 113, 113, 0.35);
      border-radius: 7px;
      padding: 8px 10px;
      font-size: 11px;
      color: #fecaca;
      max-height: 135px;
      overflow-y: auto;
      font-family: Consolas, monospace;
      white-space: pre-wrap;
      line-height: 1.45;
    }
  `;
  document.head.appendChild(style);

  const modal = document.createElement('div');
  modal.className = 'modal-ov';
  modal.id = 'mo-syllabus';
  modal.innerHTML = `
    <div class="modal-box" style="width:740px; max-width:95vw; max-height:92vh; display:flex; flex-direction:column; padding:18px 22px; gap:9px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0; font-family:'Libre Baskerville',serif; font-size:16px; color:var(--gold); display:flex; align-items:center; gap:8px;">
          <span>📋</span> <span>Import & Auto-Order from Syllabus</span>
        </h3>
        <button class="btn-sec" id="syl-close-top" style="padding:3px 8px; border:none; font-size:16px; line-height:1; cursor:pointer; background:transparent;">✕</button>
      </div>

      <!-- Source Gmail Bar for Restricted Drive Links -->
      <div id="syl-auth-bar" style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; background:rgba(59,130,246,0.08); border:1px solid rgba(59,130,246,0.25); border-radius:7px; padding:7px 10px; font-size:11.5px;">
        <div id="syl-auth-status" style="flex:1; min-width:200px;">Checking Google Drive access…</div>
        <button class="btn-gold" id="syl-auth-btn" style="padding:5px 11px; font-size:11.5px; white-space:nowrap;">🔑 Sign in Gmail for Restricted Links</button>
      </div>

      <div style="font-size:12px; color:var(--muted); display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
        <div>Target Folder: <strong id="syl-target-folder-lbl" style="color:#e8e4db;">—</strong></div>
        <div style="display:flex; gap:6px; align-items:center;">
          <button class="btn-sec" id="syl-clear-btn" style="padding:3px 9px; font-size:11px;">🧹 Clear</button>
        </div>
      </div>

      <!-- Step 1: Paste Box -->
      <div>
        <div style="font-size:11.5px; color:#cbd5e1; margin-bottom:4px; font-weight:500;">
          1. Copy rows from your Google Sheet / Syllabus table and press <strong>Ctrl+V</strong> below:
        </div>
        <div id="syl-paste-box" class="syl-paste-zone" contenteditable="true"
          data-placeholder="Paste syllabus rows here (e.g. 123.5 | G.R. No. L-53373 | Crespo v. Mogul)… Links inside copied cells are detected automatically!"></div>
      </div>

      <!-- Step 2: Optional Shared Drive Folder URL or Local PDFs -->
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; background:rgba(255,255,255,0.03); padding:7px 10px; border-radius:7px; border:1px solid rgba(255,255,255,0.06);">
        <div style="flex:1; min-width:220px; display:flex; gap:6px; align-items:center;">
          <input type="text" id="syl-folder-url" placeholder="📁 Optional: Paste Shared Google Drive Folder link (to scan folder files)…"
            style="flex:1; background:var(--navy); border:1px solid var(--navy-b); border-radius:5px; padding:5px 9px; color:#e8e4db; font-size:11.5px; outline:none;">
          <button class="btn-sec" id="syl-scan-folder-btn" style="padding:5px 10px; font-size:11.5px; white-space:nowrap;">🔍 Scan Folder</button>
        </div>
        <div style="display:flex; align-items:center; gap:6px;">
          <button class="btn-sec" id="syl-local-btn" style="padding:5px 10px; font-size:11.5px; white-space:nowrap;" title="Match against PDF files on your computer">📂 Attach Local PDFs</button>
          <input type="file" id="syl-local-in" accept="application/pdf" multiple style="display:none">
        </div>
      </div>

      <!-- Step 3: Naming Format & Options -->
      <div style="display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; font-size:11.5px;">
        <div style="display:flex; align-items:center; gap:6px;">
          <span style="color:var(--muted);">PDF Name Format:</span>
          <select id="syl-name-fmt" style="background:var(--navy); border:1px solid var(--navy-b); color:#e8e4db; border-radius:5px; padding:4px 8px; font-size:11.5px; outline:none;">
            <option value="num_title">124. People v. Dimaano (Number + Title)</option>
            <option value="title_only">People v. Dimaano (Title Only)</option>
            <option value="num_title_gr">124. People v. Dimaano (G.R. No. 168168)</option>
            <option value="gr_title">G.R. No. 168168 - People v. Dimaano</option>
          </select>
        </div>
        <label style="display:flex; align-items:center; gap:5px; color:#cbd5e1; cursor:pointer; user-select:none;">
          <input type="checkbox" id="syl-rename-existing" checked>
          <span>Rename existing folder PDFs to match format</span>
        </label>
      </div>

      <!-- Preview List -->
      <div style="display:flex; justify-content:space-between; align-items:center; font-size:11.5px; color:var(--muted);">
        <span id="syl-summary-lbl">Paste syllabus rows above to preview cases…</span>
        <span id="syl-shared-count-lbl" style="color:var(--gold);"></span>
      </div>
      <div id="syl-preview-list" class="syl-row-list">
        <div style="text-align:center; color:var(--muted); padding:32px 16px; font-size:12px;">
          No syllabus rows parsed yet. Highlight rows in your syllabus table, press <strong>Ctrl+C</strong>, and press <strong>Ctrl+V</strong> in the box above.
        </div>
      </div>

      <!-- Diagnostic Report Box (auto-shown if any row fails) -->
      <div id="syl-diag-wrap" style="display:none; flex-direction:column; gap:4px;">
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:11.5px;">
          <strong style="color:#fca5a5;">🔍 Diagnostic Report (Why rows failed):</strong>
          <div style="display:flex; gap:6px;">
            <button class="btn-sec" id="syl-copy-diag-btn" style="padding:2px 8px; font-size:10.5px;">📋 Copy Log</button>
            <button class="btn-sec" id="syl-hide-diag-btn" style="padding:2px 8px; font-size:10.5px;">Hide</button>
          </div>
        </div>
        <div id="syl-diag-log" class="syl-diag-panel"></div>
      </div>

      <!-- Progress bar -->
      <div id="syl-progress-wrap" style="display:none; flex-direction:column; gap:4px;">
        <div style="display:flex; justify-content:space-between; font-size:11.5px; color:var(--gold-l);">
          <span id="syl-progress-txt">Importing…</span>
          <span id="syl-progress-pct">0%</span>
        </div>
        <div style="height:6px; background:var(--navy); border-radius:3px; overflow:hidden; border:1px solid var(--navy-b);">
          <div id="syl-progress-bar" style="height:100%; width:0%; background:var(--gold); transition:width .2s;"></div>
        </div>
      </div>

      <!-- Footer Actions -->
      <div class="modal-acts" style="margin-top:2px; margin-bottom:0; display:flex; justify-content:space-between; align-items:center;">
        <div style="font-size:11px; color:var(--muted);">Tip: If links are restricted to a school/class email, click <strong>🔑 Sign in Gmail</strong> at the top first.</div>
        <div style="display:flex; gap:8px;">
          <button class="btn-sec" id="syl-cancel-btn">Cancel</button>
          <button class="btn-gold" id="syl-run-btn" disabled style="opacity:0.45; cursor:not-allowed;">⚡ Import & Auto-Order</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Wire listeners
  const closeFn = () => {
    if (_isRunning) return;
    closeModal('mo-syllabus');
  };
  document.getElementById('syl-close-top').addEventListener('click', closeFn);
  document.getElementById('syl-cancel-btn').addEventListener('click', closeFn);

  document.getElementById('syl-auth-btn').addEventListener('click', () => {
    signInSyllabusGmail();
  });

  document.getElementById('syl-copy-diag-btn').addEventListener('click', () => {
    const txt = document.getElementById('syl-diag-log')?.textContent || '';
    navigator.clipboard?.writeText(txt);
    toast('📋 Copied diagnostic report to clipboard');
  });

  document.getElementById('syl-hide-diag-btn').addEventListener('click', () => {
    document.getElementById('syl-diag-wrap').style.display = 'none';
  });

  const pasteBox = document.getElementById('syl-paste-box');
  pasteBox.addEventListener('paste', e => {
    e.preventDefault();
    const html = e.clipboardData?.getData('text/html') || '';
    const text = e.clipboardData?.getData('text/plain') || '';
    if (html) {
      pasteBox.innerHTML = html;
    } else {
      pasteBox.textContent = text;
    }
    handleParsePaste(html, text);
  });

  pasteBox.addEventListener('input', () => {
    handleParsePaste(pasteBox.innerHTML, pasteBox.innerText);
  });

  document.getElementById('syl-clear-btn').addEventListener('click', () => {
    pasteBox.innerHTML = '';
    _parsedRows = [];
    _diagnosticLogs = [];
    document.getElementById('syl-diag-wrap').style.display = 'none';
    renderPreviewList();
  });

  document.getElementById('syl-name-fmt').addEventListener('change', () => {
    for (const r of _parsedRows) {
      r.customName = formatRowName(r);
    }
    renderPreviewList();
  });

  document.getElementById('syl-scan-folder-btn').addEventListener('click', () => {
    scanSharedDriveFolder();
  });

  document.getElementById('syl-folder-url').addEventListener('paste', () => {
    setTimeout(() => scanSharedDriveFolder(), 80);
  });

  document.getElementById('syl-local-btn').addEventListener('click', () => {
    document.getElementById('syl-local-in').click();
  });

  document.getElementById('syl-local-in').addEventListener('change', e => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    _localFiles = [..._localFiles, ...files];
    e.target.value = '';
    matchAllRows();
    renderPreviewList();
    toast(`📂 Attached ${files.length} local PDF${files.length === 1 ? '' : 's'} for matching`);
  });

  document.getElementById('syl-run-btn').addEventListener('click', () => {
    executeSyllabusImport();
  });
}

export function openSyllabusModal(folderId) {
  ensureSyllabusModal();
  _targetFolderId = folderId;
  const folder = S.folders.find(f => f.id === folderId);
  const subj = folder ? S.subjects.find(s => s.id === folder.subject_id) : null;
  const pathLbl = folder ? (subj ? `${subj.name} › ${folder.name}` : folder.name) : 'Selected Folder';
  document.getElementById('syl-target-folder-lbl').textContent = pathLbl;

  verifySourceTokenStatus();

  if (_parsedRows.length) {
    matchAllRows();
    renderPreviewList();
  }
  openModal('mo-syllabus');
  setTimeout(() => document.getElementById('syl-paste-box')?.focus(), 60);
}

// ── Extract Google Drive File ID or Folder ID from any URL ──
function unwrapGoogleRedirect(urlStr) {
  if (!urlStr) return '';
  let s = urlStr.trim();
  try {
    const u = new URL(s);
    if ((u.hostname.includes('google.com') || u.hostname.includes('youtube.com')) && u.pathname === '/url') {
      const q = u.searchParams.get('q') || u.searchParams.get('url');
      if (q) s = q;
    }
  } catch {}
  return s;
}

export function extractDriveFileId(urlStr) {
  const s = unwrapGoogleRedirect(urlStr);
  if (!s) return null;
  if (/\/folders\/[a-zA-Z0-9_-]{15,}/.test(s)) return null;
  const m1 = s.match(/\/(?:file|document)\/d\/([a-zA-Z0-9_-]{18,})/);
  if (m1) return m1[1];
  const m2 = s.match(/[?&]id=([a-zA-Z0-9_-]{18,})/);
  if (m2) return m2[1];
  if (/^[a-zA-Z0-9_-]{25,48}$/.test(s)) return s;
  return null;
}

export function extractDriveFolderId(urlStr) {
  const s = unwrapGoogleRedirect(urlStr);
  if (!s) return null;
  const m1 = s.match(/\/folders\/([a-zA-Z0-9_-]{15,})/);
  if (m1) return m1[1];
  const m2 = s.match(/[?&]id=([a-zA-Z0-9_-]{15,})/);
  if (m2) return m2[1];
  if (/^[a-zA-Z0-9_-]{25,48}$/.test(s)) return s;
  return null;
}

// Extract URL from element (supports <a href>, Google Sheets data-sheets-hyperlink & data-sheets-formula)
function extractUrlFromElement(el) {
  if (!el) return null;
  const a = el.querySelector?.('a[href]');
  if (a && a.getAttribute('href')) return unwrapGoogleRedirect(a.getAttribute('href'));

  const directHref = el.getAttribute?.('data-sheets-hyperlink');
  if (directHref) return unwrapGoogleRedirect(directHref);

  const subHrefEl = el.querySelector?.('[data-sheets-hyperlink]');
  if (subHrefEl) return unwrapGoogleRedirect(subHrefEl.getAttribute('data-sheets-hyperlink'));

  const formulaEl = el.hasAttribute?.('data-sheets-formula') ? el : el.querySelector?.('[data-sheets-formula]');
  if (formulaEl) {
    const f = formulaEl.getAttribute('data-sheets-formula') || '';
    const m = f.match(/https?:\/\/[^\s"')]*/i);
    if (m) return unwrapGoogleRedirect(m[0]);
  }
  return null;
}

// ── Parse pasted HTML table or plain text lines ──
function cleanText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function isOrderNumberCell(txt) {
  return /^(?:#|No\.?\s*|Item\s*)?(\d{1,4}(?:\.\d{1,3})?[a-zA-Z]?)\s*[.)]?\s*$/i.test(txt.trim());
}

function extractOrderNumber(txt) {
  const m = txt.trim().match(/^(?:#|No\.?\s*|Item\s*)?(\d{1,4}(?:\.\d{1,3})?[a-zA-Z]?)\s*[.)]?\s*$/i);
  return m ? m[1] : '';
}

function isGrCell(txt) {
  const t = txt.trim();
  if (!t) return false;
  if (/\b(?:G\.?\s*R\.?|A\.?\s*M\.?|A\.?\s*C\.?|B\.?\s*M\.?|U\.?\s*DK\.?|C\.?\s*A\.?-?G\.?\s*R\.?)\b/i.test(t) && t.length < 48) {
    return true;
  }
  if (/^(?:L-\d{4,7}|\d{5,7})(?:-\d+)?$/i.test(t)) return true;
  return false;
}

function handleParsePaste(html, plainText) {
  const rows = [];

  if (html && (html.includes('<tr') || html.includes('<a ') || html.includes('data-sheets-'))) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const trs = Array.from(doc.querySelectorAll('tr'));

    if (trs.length > 0) {
      for (const tr of trs) {
        const cells = Array.from(tr.querySelectorAll('td, th'));
        if (!cells.length) continue;

        let num = '';
        let gr = '';
        let title = '';
        let driveFileId = null;
        let driveFolderId = null;
        let rawUrl = null;

        for (const cell of cells) {
          const url = extractUrlFromElement(cell);
          if (url && !rawUrl) {
            rawUrl = url;
            const fid = extractDriveFileId(url);
            if (fid) {
              driveFileId = fid;
            } else {
              const foldId = extractDriveFolderId(url);
              if (foldId) driveFolderId = foldId;
            }
            if (!title) title = cleanText(cell.textContent);
          }
        }

        const cellTexts = cells.map(c => cleanText(c.textContent)).filter(Boolean);
        if (!cellTexts.length) continue;

        // Skip header rows
        if (cellTexts.every(t => /^(?:no\.?|item|g\.?r\.?\s*no\.?|case\s*(?:name|title)|title|topic|date)$/i.test(t))) {
          continue;
        }

        const remaining = [];
        for (const ct of cellTexts) {
          if (!num && isOrderNumberCell(ct)) {
            num = extractOrderNumber(ct);
          } else if (!gr && isGrCell(ct)) {
            gr = ct;
          } else {
            remaining.push(ct);
          }
        }

        if (!title) {
          title = remaining.join(' — ') || gr || '';
        }

        if (!gr) {
          const grMatch = title.match(/\b((?:G\.?\s*R\.?|A\.?\s*M\.?|A\.?\s*C\.?)\s*(?:No\.?|Nos\.?)?\s*(?:L-)?\d[\d\s,-]*)/i);
          if (grMatch) gr = cleanText(grMatch[1]);
        }

        if (title || driveFileId || driveFolderId || gr) {
          rows.push({
            id: 'syl_' + rows.length + '_' + Date.now(),
            num,
            gr,
            title: title || gr || `Case ${rows.length + 1}`,
            driveFileId,
            driveFolderId,
            rawUrl,
          });
        }
      }
    } else {
      const links = Array.from(doc.querySelectorAll('a[href]'));
      for (const a of links) {
        const rawUrl = unwrapGoogleRedirect(a.getAttribute('href'));
        const fid = extractDriveFileId(rawUrl);
        const foldId = fid ? null : extractDriveFolderId(rawUrl);
        const txt = cleanText(a.textContent);
        if (fid || foldId || txt) {
          const r = parseSingleLine(txt, fid, rows.length);
          if (r) {
            r.driveFolderId = foldId;
            r.rawUrl = rawUrl;
            rows.push(r);
          }
        }
      }
    }
  }

  // Fallback: plain-text line-by-line parser
  if (!rows.length && plainText) {
    const lines = plainText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.includes('\t')) {
        const parts = line.split('\t').map(p => cleanText(p)).filter(Boolean);
        let num = '', gr = '', title = '', driveFileId = null, driveFolderId = null, rawUrl = null;
        const rem = [];
        for (const p of parts) {
          const fid = extractDriveFileId(p);
          if (fid && !driveFileId) {
            driveFileId = fid;
            rawUrl = p;
            continue;
          }
          const foldId = extractDriveFolderId(p);
          if (foldId && !driveFolderId && p.includes('http')) {
            driveFolderId = foldId;
            rawUrl = p;
            continue;
          }
          if (!num && isOrderNumberCell(p)) num = extractOrderNumber(p);
          else if (!gr && isGrCell(p)) gr = p;
          else rem.push(p);
        }
        title = rem.join(' — ') || gr;
        if (title || driveFileId || driveFolderId) {
          rows.push({
            id: 'syl_' + rows.length + '_' + Date.now(),
            num,
            gr,
            title: title || `Case ${rows.length + 1}`,
            driveFileId,
            driveFolderId,
            rawUrl,
          });
        }
      } else {
        const parsed = parseSingleLine(line, null, rows.length);
        if (parsed) rows.push(parsed);
      }
    }
  }

  _parsedRows = rows.map(r => ({
    ...r,
    matchedExisting: null,
    matchedLibraryPdf: null,
    matchedSharedFile: null,
    matchedLocalFile: null,
    lastError: null,
    diagnostics: [],
    customName: formatRowName(r),
  }));

  matchAllRows();
  renderPreviewList();
}

function parseSingleLine(line, knownDriveId, idx) {
  let s = line.trim();
  if (!s) return null;
  let driveFileId = knownDriveId || extractDriveFileId(s);
  let driveFolderId = driveFileId ? null : extractDriveFolderId(s);
  s = s.replace(/https?:\/\/\S+/g, '').trim();

  let num = '';
  const numM = s.match(/^(\d{1,4}(?:\.\d{1,3})?)\s*[.)|-]\s*(.+)$/);
  if (numM) {
    num = numM[1];
    s = numM[2].trim();
  }

  let gr = '';
  const grM = s.match(/\b((?:G\.?\s*R\.?|A\.?\s*M\.?|A\.?\s*C\.?)\s*(?:No\.?|Nos\.?)?\s*(?:L-)?\d[\d,-]*)\b/i);
  if (grM) {
    gr = cleanText(grM[1]);
    s = cleanText(s.replace(grM[0], '').replace(/^[\s,–—-]+|[\s,–—-]+$/g, ''));
  }

  const title = s || gr || (driveFileId ? `Case ${idx + 1}` : '');
  if (!title && !driveFileId && !driveFolderId) return null;
  return {
    id: 'syl_' + idx + '_' + Date.now(),
    num,
    gr,
    title,
    driveFileId,
    driveFolderId,
  };
}

function formatRowName(row) {
  const fmt = document.getElementById('syl-name-fmt')?.value || 'num_title';
  const numPart = row.num ? `${row.num}. ` : '';
  const titlePart = (row.title || row.gr || 'Case').replace(/\.pdf$/i, '').trim();
  const grPart = row.gr ? row.gr.trim() : '';

  if (fmt === 'title_only') return titlePart;
  if (fmt === 'num_title_gr') {
    return grPart && !titlePart.includes(grPart)
      ? `${numPart}${titlePart} (${grPart})`
      : `${numPart}${titlePart}`;
  }
  if (fmt === 'gr_title') {
    return grPart && !titlePart.includes(grPart)
      ? `${grPart} - ${titlePart}`
      : titlePart;
  }
  return `${numPart}${titlePart}`;
}

// ── Fuzzy Matching Engine (G.R. Digits + Distinctive Party Surnames) ──
function extractGrDigits(str) {
  if (!str) return [];
  const matches = str.match(/\b(?:L-)?(\d{5,7})\b/gi) || [];
  return matches.map(m => m.replace(/\D/g, '')).filter(d => d.length >= 5);
}

function extractDistinctiveTokens(title) {
  if (!title) return [];
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map(t => t.replace(/^-+|-+$/g, ''))
    .filter(t => t.length >= 3 && !LEGAL_STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function scoreCandidateMatch(row, candidateName) {
  if (!candidateName) return 0;
  const candLower = candidateName.toLowerCase().replace(/\.pdf$/i, '');
  let score = 0;

  const grDigits = [
    ...extractGrDigits(row.gr),
    ...extractGrDigits(row.title),
  ];
  for (const digits of grDigits) {
    if (candLower.includes(digits)) {
      score += 100;
    }
  }

  const tokens = extractDistinctiveTokens(row.title);
  if (tokens.length > 0) {
    let matchedTokens = 0;
    for (const tok of tokens) {
      if (candLower.includes(tok)) {
        matchedTokens++;
        score += 35;
      }
    }
    if (matchedTokens === tokens.length && tokens.length >= 1) {
      score += 30;
    }
  }

  return score;
}

function matchAllRows() {
  const folderPdfs = _targetFolderId
    ? S.pdfs.filter(p => p.folder_id === _targetFolderId)
    : [];
  const targetFolder = _targetFolderId ? S.folders.find(f => f.id === _targetFolderId) : null;
  const targetSubjectId = targetFolder?.subject_id || null;
  const otherLibraryPdfs = S.pdfs.filter(p => p.folder_id !== _targetFolderId);

  const usedExistingIds = new Set();
  const usedSharedIds = new Set();
  const usedLocalIndices = new Set();

  for (const row of _parsedRows) {
    row.matchedExisting = null;
    row.matchedLibraryPdf = null;
    row.matchedSharedFile = null;
    row.matchedLocalFile = null;

    // 1. Match against existing PDFs in the target folder
    if (row.driveFileId) {
      const exactDrive = folderPdfs.find(
        p => !usedExistingIds.has(p.id) && p.drive_file_id === row.driveFileId
      );
      if (exactDrive) {
        row.matchedExisting = exactDrive;
        usedExistingIds.add(exactDrive.id);
        continue;
      }
    }

    let bestExisting = null;
    let bestExistingScore = 0;
    for (const p of folderPdfs) {
      if (usedExistingIds.has(p.id)) continue;
      const sc = scoreCandidateMatch(row, p.name);
      if (sc > bestExistingScore) {
        bestExistingScore = sc;
        bestExisting = p;
      }
    }
    if (bestExisting && bestExistingScore >= 35) {
      row.matchedExisting = bestExisting;
      usedExistingIds.add(bestExisting.id);
      continue;
    }

    // 2. Auto-scan existing PDFs in other folders in the database (for unlinked rows or fallback)
    if (!row.driveFileId && otherLibraryPdfs.length > 0) {
      let bestLibPdf = null;
      let bestLibScore = 0;
      let bestLibDriveId = null;
      let bestLibFolder = null;

      for (const p of otherLibraryPdfs) {
        const baseScore = scoreCandidateMatch(row, p.name);
        if (baseScore < 35) continue;

        const srcDriveId =
          p.drive_file_id ||
          (p.linked_pdf_id ? S.pdfs.find(x => x.id === p.linked_pdf_id)?.drive_file_id : null);
        if (!srcDriveId) continue;

        const pFolder = S.folders.find(f => f.id === p.folder_id);
        const sameSubjectBonus =
          targetSubjectId && pFolder?.subject_id === targetSubjectId ? 25 : 0;
        const originalBonus = !p.linked_pdf_id ? 5 : 0;
        const totalScore = baseScore + sameSubjectBonus + originalBonus;

        if (totalScore > bestLibScore) {
          bestLibScore = totalScore;
          bestLibPdf = p;
          bestLibDriveId = srcDriveId;
          bestLibFolder = pFolder;
        }
      }

      if (bestLibPdf && bestLibDriveId) {
        row.matchedLibraryPdf = {
          pdf: bestLibPdf,
          driveFileId: bestLibDriveId,
          folderName: bestLibFolder?.name || 'Other Folder',
        };
        continue;
      }
    }

    // 3. Match against Shared Drive Folder files
    if (!row.driveFileId && _sharedFolderFiles.length > 0) {
      let bestShared = null;
      let bestSharedScore = 0;
      for (const sf of _sharedFolderFiles) {
        if (usedSharedIds.has(sf.id)) continue;
        const sc = scoreCandidateMatch(row, sf.name);
        if (sc > bestSharedScore) {
          bestSharedScore = sc;
          bestShared = sf;
        }
      }
      if (bestShared && bestSharedScore >= 35) {
        row.matchedSharedFile = bestShared;
        usedSharedIds.add(bestShared.id);
      }
    }

    // 4. Match against attached local PDFs
    if (!row.driveFileId && !row.matchedSharedFile && _localFiles.length > 0) {
      let bestLocalIdx = -1;
      let bestLocalScore = 0;
      for (let i = 0; i < _localFiles.length; i++) {
        if (usedLocalIndices.has(i)) continue;
        const sc = scoreCandidateMatch(row, _localFiles[i].name);
        if (sc > bestLocalScore) {
          bestLocalScore = sc;
          bestLocalIdx = i;
        }
      }
      if (bestLocalIdx >= 0 && bestLocalScore >= 35) {
        row.matchedLocalFile = _localFiles[bestLocalIdx];
        usedLocalIndices.add(bestLocalIdx);
      }
    }
  }
}

// ── Render Live Preview List ──
function renderPreviewList() {
  const listEl = document.getElementById('syl-preview-list');
  const sumEl = document.getElementById('syl-summary-lbl');
  const runBtn = document.getElementById('syl-run-btn');
  if (!listEl) return;

  if (!_parsedRows.length) {
    listEl.innerHTML = `
      <div style="text-align:center; color:var(--muted); padding:32px 16px; font-size:12px;">
        No syllabus rows parsed yet. Highlight rows in your syllabus table, press <strong>Ctrl+C</strong>, and press <strong>Ctrl+V</strong> in the box above.
      </div>`;
    if (sumEl) sumEl.textContent = 'Paste syllabus rows above to preview cases…';
    if (runBtn) {
      runBtn.disabled = true;
      runBtn.style.opacity = '0.45';
      runBtn.style.cursor = 'not-allowed';
    }
    return;
  }

  let existingCount = 0;
  let libraryCopyCount = 0;
  let driveCount = 0;
  let localCount = 0;
  let missingCount = 0;

  listEl.innerHTML = '';
  _parsedRows.forEach((row, idx) => {
    const item = document.createElement('div');
    item.className = 'syl-item';

    let badgeClass = 'missing';
    let badgeText = '⚠️ Missing Link (Click to set)';
    let badgeTitle = 'Click to paste a Google Drive link for this case';

    if (row.lastError) {
      badgeClass = 'failed';
      badgeText = `❌ ${row.lastError}`;
      badgeTitle = (row.diagnostics || [row.lastError]).join('\n');
      driveCount++;
    } else if (row.matchedExisting) {
      badgeClass = 'existing';
      badgeText = `🟢 In Folder (${row.matchedExisting.name})`;
      badgeTitle = `Already in folder as "${row.matchedExisting.name}" — will reorder & rename`;
      existingCount++;
    } else if (row.driveFileId) {
      badgeClass = 'drive';
      badgeText = `🔗 Drive Link (${row.driveFileId.slice(0, 8)}…)`;
      badgeTitle = `Google Drive File ID: ${row.driveFileId}\nClick to view/change link`;
      driveCount++;
    } else if (row.driveFolderId) {
      badgeClass = 'drive';
      badgeText = `📁 Drive Folder Link (${row.driveFolderId.slice(0, 8)}…)`;
      badgeTitle = `Google Drive Folder ID: ${row.driveFolderId} — will scan folder & match PDF`;
      driveCount++;
    } else if (row.matchedLibraryPdf) {
      badgeClass = 'library';
      badgeText = `📚 Copy from "${row.matchedLibraryPdf.folderName}"`;
      badgeTitle = `Found "${row.matchedLibraryPdf.pdf.name}" in folder "${row.matchedLibraryPdf.folderName}" — will create an independent copy here`;
      libraryCopyCount++;
    } else if (row.matchedSharedFile) {
      badgeClass = 'shared';
      badgeText = `📁 Shared Drive (${row.matchedSharedFile.name})`;
      badgeTitle = `Matched from Shared Drive Folder: ${row.matchedSharedFile.name}`;
      driveCount++;
    } else if (row.matchedLocalFile) {
      badgeClass = 'local';
      badgeText = `📄 Local (${row.matchedLocalFile.name})`;
      badgeTitle = `Matched local file: ${row.matchedLocalFile.name}`;
      localCount++;
    } else {
      missingCount++;
    }

    item.innerHTML = `
      <span class="syl-num" title="Syllabus Order #${idx + 1}">${row.num || '#' + (idx + 1)}</span>
      <input type="text" class="syl-name-in" value="${(row.customName || '').replace(/"/g, '&quot;')}" title="Final PDF Name in Folder">
      <span class="syl-badge ${badgeClass}" title="${badgeTitle.replace(/"/g, '&quot;')}">${badgeText}</span>
      <button class="syl-row-del" title="Remove row">✕</button>
    `;

    const nameIn = item.querySelector('.syl-name-in');
    nameIn.addEventListener('input', () => {
      row.customName = nameIn.value.trim();
    });

    const badgeEl = item.querySelector('.syl-badge');
    badgeEl.addEventListener('click', () => {
      const input = prompt(
        `Google Drive link (or File ID) for "${row.customName}":`,
        row.rawUrl || row.driveFileId || row.driveFolderId || ''
      );
      if (input !== null) {
        row.lastError = null;
        const fid = extractDriveFileId(input);
        const foldId = fid ? null : extractDriveFolderId(input);
        if (fid) {
          row.driveFileId = fid;
          row.driveFolderId = null;
          row.rawUrl = input.trim();
          matchAllRows();
          renderPreviewList();
        } else if (foldId) {
          row.driveFolderId = foldId;
          row.driveFileId = null;
          row.rawUrl = input.trim();
          matchAllRows();
          renderPreviewList();
        } else if (input.trim() === '') {
          row.driveFileId = null;
          row.driveFolderId = null;
          row.rawUrl = null;
          matchAllRows();
          renderPreviewList();
        } else {
          toast('⚠️ Could not find a valid Google Drive ID in that link.');
        }
      }
    });

    item.querySelector('.syl-row-del').addEventListener('click', () => {
      _parsedRows.splice(idx, 1);
      renderPreviewList();
    });

    listEl.appendChild(item);
  });

  const actionable = existingCount + libraryCopyCount + driveCount + localCount;
  if (sumEl) {
    sumEl.textContent = `${_parsedRows.length} case${_parsedRows.length === 1 ? '' : 's'} in syllabus order • ${driveCount} from Drive${libraryCopyCount ? ` • ${libraryCopyCount} from Library` : ''} • ${existingCount} in folder${localCount ? ` • ${localCount} local` : ''}${missingCount ? ` • ${missingCount} missing link` : ''}`;
  }
  if (runBtn) {
    runBtn.disabled = actionable === 0;
    runBtn.style.opacity = actionable > 0 ? '1' : '0.45';
    runBtn.style.cursor = actionable > 0 ? 'pointer' : 'not-allowed';
    runBtn.textContent = `⚡ Import & Auto-Order (${actionable})`;
  }
}

async function listFilesInDriveFolderId(folderId) {
  const activeTok = getActiveSourceToken();
  let files = null;

  if (window.__DESKTOP_PDFIUM__?.listGDriveFolder) {
    files = await window.__DESKTOP_PDFIUM__.listGDriveFolder(folderId, activeTok);
  }

  const tokensToTry = [activeTok, S.driveToken].filter(Boolean);
  for (const tok of tokensToTry) {
    if (files && files.length) break;
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)&pageSize=500&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.files) && data.files.length) files = data.files;
    }
  }
  return files || [];
}

// ── Scan Shared Google Drive Folder to auto-match unlinked rows ──
async function scanSharedDriveFolder() {
  const inp = document.getElementById('syl-folder-url');
  const btn = document.getElementById('syl-scan-folder-btn');
  const lbl = document.getElementById('syl-shared-count-lbl');
  const rawUrl = inp?.value?.trim() || '';
  if (!rawUrl) {
    toast('Paste a Google Drive Folder link first.');
    return;
  }

  const folderId = extractDriveFolderId(rawUrl);
  if (!folderId) {
    toast('⚠️ Could not detect a Google Drive Folder ID from that link.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Scanning…';
  }

  try {
    const files = await listFilesInDriveFolderId(folderId);
    if (files.length > 0) {
      _sharedFolderFiles = files.filter(f => f.id && f.name);
      if (lbl) lbl.textContent = `📁 ${_sharedFolderFiles.length} files found in shared folder`;
      matchAllRows();
      renderPreviewList();
      toast(`✅ Found ${_sharedFolderFiles.length} files in shared Drive folder!`);
    } else {
      toast('⚠️ Could not list files in that folder. Click "🔑 Sign in Gmail for Restricted Links" at the top if the folder is restricted.');
    }
  } catch (err) {
    console.warn('[Syllabus] scanSharedDriveFolder error:', err);
    toast('⚠️ Error scanning Drive folder: ' + (err.message || err));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔍 Scan Folder';
    }
  }
}

// ── Download an external Google Drive PDF file as a Blob (with full diagnostics) ──
async function fetchExternalDrivePDFWithDiag(fileId, row) {
  const primaryTok = getActiveSourceToken();
  const fallbackTok = S.driveToken && S.driveToken !== primaryTok ? S.driveToken : null;
  const diag = [];

  // 1. Desktop Native Downloader (returns { ok, blob, error, diagnostics })
  if (window.__DESKTOP_PDFIUM__?.downloadGDriveFile) {
    const res = await window.__DESKTOP_PDFIUM__.downloadGDriveFile(fileId, primaryTok, fallbackTok);
    if (Array.isArray(res?.diagnostics)) diag.push(...res.diagnostics);
    if (res?.ok && res?.blob && res.blob.size > 100) {
      return { blob: res.blob, diagnostics: diag };
    }
  }

  // 2. Web / OAuth Drive API v3 download (checks metadata + handles Google Docs export)
  const tokens = [primaryTok, fallbackTok].filter(Boolean);
  for (const tok of tokens) {
    let targetId = fileId;
    let mimeType = '';
    try {
      const metaRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(targetId)}?fields=id,name,mimeType,shortcutDetails&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${tok}` } }
      );
      if (metaRes.ok) {
        const meta = await metaRes.json();
        mimeType = meta.mimeType || '';
        if (mimeType === 'application/vnd.google-apps.shortcut' && meta.shortcutDetails?.targetId) {
          targetId = meta.shortcutDetails.targetId;
        }
      } else {
        const errJson = await metaRes.json().catch(() => ({}));
        diag.push(`Browser Drive API metadata: HTTP ${metaRes.status} — ${errJson?.error?.message || metaRes.statusText}`);
      }
    } catch (e) {
      diag.push(`Browser Drive API metadata error: ${e.message || e}`);
    }

    const dlUrl = mimeType === 'application/vnd.google-apps.document'
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(targetId)}/export?mimeType=application/pdf`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(targetId)}?alt=media&supportsAllDrives=true`;

    const res = await fetch(dlUrl, { headers: { Authorization: `Bearer ${tok}` } });
    if (res.ok) {
      const blob = await res.blob();
      if (blob.size > 100) return { blob, diagnostics: diag };
    } else {
      const errJson = await res.json().catch(() => ({}));
      diag.push(`Browser Drive API download: HTTP ${res.status} — ${errJson?.error?.message || res.statusText}`);
    }
  }

  // Determine concise human-readable reason for badge
  const joined = diag.join(' | ');
  let shortReason = 'Download Failed';
  if (joined.includes('RESTRICTED') || joined.includes('HTTP 404') || joined.includes('HTTP 403')) {
    shortReason = _syllabusHasReadonly
      ? 'Restricted (Wrong Email?)'
      : 'Restricted (Click 🔑 Sign in Gmail)';
  } else if (joined.includes('DOCX') || joined.includes('.docx')) {
    shortReason = 'Word .docx (Not PDF)';
  }

  row.lastError = shortReason;
  row.diagnostics = diag;
  throw new Error(`${shortReason}\n${diag.map(d => '  • ' + d).join('\n')}`);
}

// ── Create an independent Google Drive copy of an existing library PDF ──
async function copyLibraryPdfIndependently(sourceDriveId, finalName, targetDriveFolderId) {
  let newDriveId = null;
  let blob = await getCachedPDF(sourceDriveId).catch(() => null);

  if (S.driveToken && sourceDriveId && !sourceDriveId.startsWith('local_')) {
    try {
      const body = { name: `${finalName}.pdf` };
      if (targetDriveFolderId) body.parents = [targetDriveFolderId];
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(sourceDriveId)}/copy?supportsAllDrives=true&fields=id,name`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${S.driveToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }
      );
      if (res.ok) {
        const data = await res.json();
        if (data?.id) newDriveId = data.id;
      }
    } catch (e) {
      console.warn('[Syllabus] Server-side Drive copy fallback:', e);
    }
  }

  if (newDriveId) {
    if (!blob) {
      try {
        blob = await driveFetchPDF(sourceDriveId, null, finalName);
      } catch {}
    }
    if (blob) {
      await setCachedPDF(newDriveId, blob, finalName);
    }
    return newDriveId;
  }

  if (!blob) {
    try {
      blob = await driveFetchPDF(sourceDriveId, null, finalName);
    } catch {
      const r = await fetchExternalDrivePDFWithDiag(sourceDriveId, {});
      blob = r.blob;
    }
  }
  if (!blob) {
    throw new Error(`Could not read existing library PDF (${finalName})`);
  }

  const fileObj = new File([blob], `${finalName}.pdf`, { type: 'application/pdf' });
  newDriveId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  if (S.driveToken) {
    const uploaded = await driveUploadPDF(fileObj, targetDriveFolderId);
    if (uploaded?.id) newDriveId = uploaded.id;
  }
  await setCachedPDF(newDriveId, blob, finalName);
  return newDriveId;
}

// ── Execute Import, Renaming, and Auto-Ordering ──
async function executeSyllabusImport() {
  if (_isRunning || !_targetFolderId || !_parsedRows.length) return;
  _isRunning = true;

  const runBtn = document.getElementById('syl-run-btn');
  const progWrap = document.getElementById('syl-progress-wrap');
  const progTxt = document.getElementById('syl-progress-txt');
  const progPct = document.getElementById('syl-progress-pct');
  const progBar = document.getElementById('syl-progress-bar');
  const diagWrap = document.getElementById('syl-diag-wrap');
  const diagLog = document.getElementById('syl-diag-log');
  const renameExisting = document.getElementById('syl-rename-existing')?.checked ?? true;

  _diagnosticLogs = [];
  if (diagWrap) diagWrap.style.display = 'none';
  for (const r of _parsedRows) {
    r.lastError = null;
    r.diagnostics = [];
  }

  if (runBtn) runBtn.disabled = true;
  if (progWrap) progWrap.style.display = 'flex';

  const actionableRows = _parsedRows.filter(
    r => r.matchedExisting || r.matchedLibraryPdf || r.driveFileId || r.driveFolderId || r.matchedSharedFile || r.matchedLocalFile
  );

  let targetDriveFolderId = null;
  const needsUpload = actionableRows.some(
    r => !r.matchedExisting && (r.matchedLibraryPdf || r.driveFileId || r.driveFolderId || r.matchedSharedFile || r.matchedLocalFile)
  );

  try {
    if (needsUpload && S.driveToken) {
      if (progTxt) progTxt.textContent = 'Preparing Google Drive folder…';
      targetDriveFolderId = await driveResolveFolderPath(_targetFolderId);
    }

    const orderedPdfRecords = [];
    let completed = 0;
    let importedCount = 0;
    let reorderedCount = 0;
    let failedCount = 0;

    for (const row of actionableRows) {
      const finalName = (row.customName || formatRowName(row)).replace(/\.pdf$/i, '').trim();
      const pct = Math.round((completed / actionableRows.length) * 100);
      if (progTxt) progTxt.textContent = `Processing (${completed + 1}/${actionableRows.length}): ${finalName}…`;
      if (progPct) progPct.textContent = `${pct}%`;
      if (progBar) progBar.style.width = `${pct}%`;

      try {
        if (row.matchedExisting) {
          const pdfRec = row.matchedExisting;
          if (renameExisting && finalName && pdfRec.name !== finalName) {
            await dbRenamePDF(pdfRec.id, finalName);
          }
          orderedPdfRecords.push({ pdf: pdfRec, syllabusNum: parseFloat(row.num) });
          reorderedCount++;
        } else if (row.matchedLibraryPdf && !row.driveFileId && !row.driveFolderId) {
          const newDriveId = await copyLibraryPdfIndependently(
            row.matchedLibraryPdf.driveFileId,
            finalName,
            targetDriveFolderId
          );
          const rec = await dbRegisterPDF(_targetFolderId, finalName, newDriveId, null);
          orderedPdfRecords.push({ pdf: rec, syllabusNum: parseFloat(row.num) });
          importedCount++;
        } else {
          let blob = null;
          let extDriveId = row.driveFileId || row.matchedSharedFile?.id || null;

          // If the row linked to a Google Drive Folder instead of a file, scan that folder and pick the matching/first PDF!
          if (!extDriveId && row.driveFolderId) {
            const folderFiles = await listFilesInDriveFolderId(row.driveFolderId);
            if (!folderFiles.length) {
              row.lastError = 'Folder Empty / Restricted';
              throw new Error(`Row linked to Drive Folder (${row.driveFolderId}), but folder could not be listed or is restricted. Click '🔑 Sign in Gmail' above.`);
            }
            let bestFile = folderFiles[0];
            let bestSc = -1;
            for (const ff of folderFiles) {
              const sc = scoreCandidateMatch(row, ff.name);
              if (sc > bestSc) {
                bestSc = sc;
                bestFile = ff;
              }
            }
            extDriveId = bestFile.id;
          }

          if (extDriveId) {
            const dlRes = await fetchExternalDrivePDFWithDiag(extDriveId, row);
            blob = dlRes.blob;
          } else if (row.matchedLocalFile) {
            blob = row.matchedLocalFile;
          }

          if (blob) {
            const fileObj = new File([blob], `${finalName}.pdf`, { type: 'application/pdf' });
            let savedDriveId = extDriveId || ('local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));

            if (S.driveToken) {
              const uploaded = await driveUploadPDF(fileObj, targetDriveFolderId);
              if (uploaded?.id) savedDriveId = uploaded.id;
            }

            await setCachedPDF(savedDriveId, blob, finalName);
            const rec = await dbRegisterPDF(_targetFolderId, finalName, savedDriveId, null);
            orderedPdfRecords.push({ pdf: rec, syllabusNum: parseFloat(row.num) });
            importedCount++;
          }
        }
      } catch (rowErr) {
        console.warn(`[Syllabus] Failed row "${finalName}":`, rowErr);
        if (!row.lastError) row.lastError = 'Failed';
        _diagnosticLogs.push(
          `❌ [${row.num || '#'}] ${finalName} (URL/ID: ${row.rawUrl || row.driveFileId || row.driveFolderId || 'none'}):\n${rowErr.message || rowErr}`
        );
        failedCount++;
      }

      completed++;
    }

    // ── Final Step: Auto-Order all PDFs in the target folder ──
    if (progTxt) progTxt.textContent = 'Applying syllabus order…';
    if (progPct) progPct.textContent = '100%';
    if (progBar) progBar.style.width = '100%';

    const syllabusIds = new Set(orderedPdfRecords.map(x => x.pdf.id));
    const otherPdfs = S.pdfs
      .filter(p => p.folder_id === _targetFolderId && !syllabusIds.has(p.id))
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

    const extractLeadingNum = name => {
      const m = (name || '').trim().match(/^(\d{1,4}(?:\.\d{1,3})?)\s*[.)|-]/);
      return m ? parseFloat(m[1]) : NaN;
    };

    const allHaveNumbers =
      otherPdfs.length > 0 &&
      orderedPdfRecords.some(x => Number.isFinite(x.syllabusNum)) &&
      otherPdfs.filter(p => Number.isFinite(extractLeadingNum(p.name))).length >= Math.ceil(otherPdfs.length * 0.5);

    let finalFolderOrder = [];
    if (allHaveNumbers) {
      const combined = [
        ...otherPdfs.map((p, i) => ({
          pdf: p,
          num: extractLeadingNum(p.name),
          origIdx: i,
        })),
        ...orderedPdfRecords.map((x, i) => ({
          pdf: x.pdf,
          num: Number.isFinite(x.syllabusNum) ? x.syllabusNum : extractLeadingNum(x.pdf.name),
          origIdx: 10000 + i,
        })),
      ];
      combined.sort((a, b) => {
        const na = Number.isFinite(a.num) ? a.num : Infinity;
        const nb = Number.isFinite(b.num) ? b.num : Infinity;
        if (na !== nb) return na - nb;
        return a.origIdx - b.origIdx;
      });
      finalFolderOrder = combined.map(c => c.pdf);
    } else {
      finalFolderOrder = [
        ...otherPdfs,
        ...orderedPdfRecords.map(x => x.pdf),
      ];
    }

    for (let i = 0; i < finalFolderOrder.length; i++) {
      const p = finalFolderOrder[i];
      if (p.sort_order !== i) {
        await dbReorderPDF(p.id, i);
      }
    }

    S.expandedFold[_targetFolderId] = true;
    const { renderLibrary } = await import('./library.js');
    renderLibrary();

    const summaryParts = [];
    if (importedCount > 0) summaryParts.push(`${importedCount} imported`);
    if (reorderedCount > 0) summaryParts.push(`${reorderedCount} ordered`);
    if (failedCount > 0) summaryParts.push(`${failedCount} failed`);
    toast(`✅ Syllabus complete: ${summaryParts.join(', ')}!`);

    if (failedCount === 0) {
      _parsedRows = [];
      const pasteBox = document.getElementById('syl-paste-box');
      if (pasteBox) pasteBox.innerHTML = '';
      closeModal('mo-syllabus');
    } else {
      if (diagWrap && diagLog && _diagnosticLogs.length) {
        diagLog.textContent = _diagnosticLogs.join('\n\n');
        diagWrap.style.display = 'flex';
      }
      matchAllRows();
      renderPreviewList();
    }
  } catch (err) {
    console.error('[Syllabus] Import failed:', err);
    toast('❌ Syllabus import error: ' + (err.message || err));
  } finally {
    _isRunning = false;
    if (progWrap) progWrap.style.display = 'none';
    if (runBtn) runBtn.disabled = false;
  }
}
