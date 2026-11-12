// ═══════════════════════════════════════════════
// BACKUP — 100% self-contained, zero imports from other modules
// Creates its own DB client, reads Drive tokens from localStorage.
// Even if this file crashes entirely, the rest of the app is unaffected.
// ═══════════════════════════════════════════════

// ── Own Supabase client (independent of db.js) ──
const _db = window.supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_KEY
);

const BACKUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let _autoTimer = null;

// ── Tiny self-contained toast (reuses the existing #toast element) ──
let _toastTimer = null;
function _toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ── Read Drive auth from localStorage (no dependency on state.js) ──
function _driveToken()    { return localStorage.getItem('driveToken'); }
function _driveFolderId() { return localStorage.getItem('driveFolderId'); }

// ── Authenticated Drive GET ──
async function _driveGet(url) {
  const token = _driveToken();
  if (!token) throw new Error('No Drive token');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive GET ${r.status}`);
  return r.json();
}

// ── Ensure _backups subfolder exists ──
async function _ensureBackupFolder() {
  const token = _driveToken();
  const parentId = _driveFolderId();
  if (!token || !parentId) throw new Error('Drive not connected');

  const q = `name='_backups' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const resp = await _driveGet(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`
  );
  if (resp.files && resp.files.length > 0) return resp.files[0].id;

  // Create it
  const meta = { name: '_backups', mimeType: 'application/vnd.google-apps.folder', parents: [parentId] };
  const r = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(meta),
  });
  if (!r.ok) throw new Error(`Create backup folder failed: ${r.status}`);
  const data = await r.json();
  return data.id;
}

// ── Collect ALL data from Supabase ──
async function _collectData() {
  const [
    { data: subjects },
    { data: folders },
    { data: pdfs },
    { data: colors },
    { data: annotations },
    { data: annNotes },
    { data: drawings },
    { data: bookmarks },
    { data: pdfNotes },
    { data: dictionary },
    appSettingsRes,
  ] = await Promise.all([
    _db.from('subjects').select('*').order('created_at'),
    _db.from('folders').select('*').order('created_at'),
    _db.from('pdf_files').select('*').order('created_at'),
    _db.from('color_categories').select('*').order('created_at'),
    _db.from('annotations').select('*').order('created_at'),
    _db.from('annotation_notes').select('*').order('order_index'),
    _db.from('drawings').select('*'),
    _db.from('pdf_bookmarks').select('*').order('page'),
    _db.from('pdf_notes').select('*'),
    _db.from('dictionary').select('*').order('word'),
    _db.from('app_settings').select('*').then(r => r, () => ({ data: [] })),
  ]);

  const appSettings = Array.isArray(appSettingsRes?.data) ? [...appSettingsRes.data] : [];
  try {
    const localTheme = localStorage.getItem('app_ui_theme');
    if (localTheme && !appSettings.some(row => row && row.key === 'app_ui_theme')) {
      appSettings.push({ key: 'app_ui_theme', value: localTheme });
    }
  } catch {}

  return {
    _version: 1,
    _exported_at: new Date().toISOString(),
    subjects:         subjects         || [],
    folders:          folders          || [],
    pdf_files:        pdfs             || [],
    color_categories: colors           || [],
    annotations:      annotations      || [],
    annotation_notes: annNotes         || [],
    drawings:         drawings         || [],
    pdf_bookmarks:    bookmarks        || [],
    pdf_notes:        pdfNotes         || [],
    dictionary:       dictionary       || [],
    app_settings:     appSettings,
  };
}

/**
 * Safely restore color_categories and app_settings (and core library rows)
 * from a backup JSON payload, preserving backward compatibility with older backups
 * that omit app_settings or color_categories.
 */
export async function restoreBackupData(rawBackup) {
  const data = typeof rawBackup === 'string' ? JSON.parse(rawBackup) : rawBackup;
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid backup payload');
  }

  const upsertTable = async (table, rows, options) => {
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const { error } = options
      ? await _db.from(table).upsert(rows, options)
      : await _db.from(table).upsert(rows);
    if (error) throw error;
    return rows.length;
  };

  await upsertTable('subjects', data.subjects);
  await upsertTable('folders', data.folders);
  await upsertTable('pdf_files', data.pdf_files);
  await upsertTable('color_categories', data.color_categories);
  await upsertTable('annotations', data.annotations);
  await upsertTable('annotation_notes', data.annotation_notes);
  await upsertTable('drawings', data.drawings);
  await upsertTable('pdf_bookmarks', data.pdf_bookmarks);
  await upsertTable('pdf_notes', data.pdf_notes, { onConflict: 'pdf_id' });
  await upsertTable('dictionary', data.dictionary, { onConflict: 'word' });

  if (Array.isArray(data.app_settings) && data.app_settings.length > 0) {
    const validSettings = data.app_settings.filter(r => r && typeof r.key === 'string');
    if (validSettings.length > 0) {
      await upsertTable('app_settings', validSettings, { onConflict: 'key' }).catch(() => 0);
      const themeEntry = validSettings.find(r => r.key === 'app_ui_theme' && typeof r.value === 'string');
      if (themeEntry) {
        try { localStorage.setItem('app_ui_theme', themeEntry.value); } catch {}
      }
    }
  }

  return true;
}

// ── Option 1: Download backup as JSON file ──
async function downloadBackup() {
  const btn = document.getElementById('backup-dl-btn');
  if (btn) { btn.textContent = 'Exporting…'; btn.disabled = true; }
  try {
    const data = await _collectData();
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `legal-annotator-backup-${dateStr}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    _toast('Backup downloaded');
  } catch (e) {
    console.error('[Backup] Download failed:', e);
    _toast('Backup failed — check console');
  } finally {
    if (btn) { btn.textContent = 'Download Backup'; btn.disabled = false; }
  }
}

// ── Option 2: Upload backup JSON to Google Drive ──
async function driveBackup({ silent = false } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (!silent) _toast('Offline — connect to the internet to back up to Google Drive');
    return;
  }
  const token = _driveToken();
  if (!token) return; // not signed in — skip silently

  const btn = document.getElementById('backup-drive-btn');
  if (btn && !silent) { btn.textContent = 'Backing up…'; btn.disabled = true; }

  try {
    const data = await _collectData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });

    const backupFolderId = await _ensureBackupFolder();

    // Check if backup file already exists
    const searchResp = await _driveGet(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
        `name='backup_latest.json' and '${backupFolderId}' in parents and trashed=false`
      )}&fields=files(id)`
    );
    const existingId = searchResp.files?.[0]?.id || null;

    if (existingId) {
      // PATCH — overwrite (Drive keeps version history automatically)
      const r = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: blob,
        }
      );
      if (!r.ok) throw new Error('Drive backup update failed: ' + r.status);
    } else {
      // POST — create new
      const meta = { name: 'backup_latest.json', parents: [backupFolderId] };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
      form.append('file', blob);
      const r = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }
      );
      if (!r.ok) throw new Error('Drive backup create failed: ' + r.status);
    }

    // Update timestamp label
    const lbl = document.getElementById('backup-last-lbl');
    if (lbl) lbl.textContent = `Last: ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    if (!silent) _toast('Backed up to Google Drive');
    console.log('[Backup] Drive backup completed at', new Date().toLocaleTimeString());
  } catch (e) {
    console.error('[Backup] Drive backup failed:', e);
    if (!silent) _toast('Drive backup failed — check console');
  } finally {
    if (btn && !silent) { btn.textContent = 'Drive Backup'; btn.disabled = false; }
  }
}

// ── Auto-backup scheduler ──
function startAutoBackup() {
  if (_autoTimer) clearInterval(_autoTimer);
  setTimeout(() => driveBackup({ silent: true }), 15000); // first run 15s after load
  _autoTimer = setInterval(() => driveBackup({ silent: true }), BACKUP_INTERVAL_MS);
}

// ═══════════════════════════════════════════════
// SELF-INIT — runs when this module script loads
// (module scripts are deferred, so DOM is ready)
// ═══════════════════════════════════════════════
document.getElementById('backup-dl-btn')?.addEventListener('click', downloadBackup);
document.getElementById('backup-drive-btn')?.addEventListener('click', () => driveBackup({ silent: false }));
startAutoBackup();
