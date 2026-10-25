// ═══════════════════════════════════════════════
// DB — all Supabase interactions
// ═══════════════════════════════════════════════
import { S } from './state.js';
import {
  driveDeleteFile,
  driveResolveSubjectPath,
  driveResolveFolderPath,
  driveSyncPdfLocation,
  scheduleDriveOrganize,
} from './drive.js';
import { broadcastSync } from './sync.js';
import { safeDbWrite, enqueueAction } from './outbox.js';
import { safeStorageSet, safeStorageGet, safeStorageRemove } from './storage.js';
import { logNotepadDiagnostic } from './diag.js';

// Inline sync helpers (avoids circular dep with ui.js)
const _el = id => document.getElementById(id);
function syncSpin(m) { const d=_el('sdot'),t=_el('stxt'); if(d) d.className='sdot spin'; if(t) t.textContent=m||'Working…'; }
function syncOK(m)   { const d=_el('sdot'),t=_el('stxt'); if(d) d.className='sdot ok';   if(t) t.textContent=m||'Synced'; }
function syncErr(m)  { const d=_el('sdot'),t=_el('stxt'); if(d) d.className='sdot err';  if(t) t.textContent=m||'Error'; }

// Supabase client — loaded via CDN in index.html, available as window.supabase
const SURL = window.APP_CONFIG.SUPABASE_URL;
const SKEY = window.APP_CONFIG.SUPABASE_KEY;
export const db = supabase.createClient(SURL, SKEY);

// ── Load all library data (with offline local snapshot restore) ──
export async function dbLoad(retries = 3) {
  syncSpin(retries < 3 ? `Retrying load... (${3 - retries})` : 'Loading…');
  try {
    const [s, f, p, c] = await Promise.all([
      db.from('subjects').select('*').order('created_at'),
      db.from('folders').select('*').order('sort_order').order('created_at'),
      db.from('pdf_files').select('*').order('created_at'),
      db.from('color_categories').select('*').order('created_at'),
    ]);
    const firstErr = s.error || f.error || p.error || c.error;
    if (firstErr) {
      const errTable = s.error ? 'subjects' : (f.error ? 'folders' : (p.error ? 'pdf_files' : 'color_categories'));
      const dbErr = new Error(`Supabase query on "${errTable}" failed: ${firstErr.message}`);
      dbErr.code = firstErr.code || 'PGRST';
      dbErr.details = firstErr.details || firstErr.hint || '';
      throw dbErr;
    }
    const remoteFolders = f.data || [];
    const localPendingFolds = S.folders.filter(lf =>
      !remoteFolders.some(rf => rf.id === lf.id) &&
      (Date.now() - (lf._created_locally_at || 0) < 60000)
    );
    S.subjects   = s.data || [];
    S.folders    = [...remoteFolders, ...localPendingFolds];
    S.pdfs       = p.data || [];
    S.colorCats  = c.data || [];
    
    // Sanitize circular references caused by drag-and-drop bug
    for (const folder of S.folders) {
      if (!folder.parent_folder_id) continue;
      let curr = folder.parent_folder_id;
      let isCycle = false;
      const seen = new Set([folder.id]);
      while (curr) {
        if (seen.has(curr)) { isCycle = true; break; }
        seen.add(curr);
        const par = S.folders.find(x => x.id === curr);
        curr = par ? par.parent_folder_id : null;
      }
      if (isCycle) {
        console.warn('Fixed circular folder reference:', folder.name);
        folder.parent_folder_id = null;
        db.from('folders').update({ parent_folder_id: null }).eq('id', folder.id).then();
      }
    }

    // Save snapshot to local disk for offline startup
    safeStorageSet('local_lib_snapshot', JSON.stringify({
      subjects: S.subjects,
      folders: S.folders,
      pdfs: S.pdfs,
      colorCats: S.colorCats,
      saved_at: Date.now()
    }));

    // In background, sync cloud default pages into local cache
    db.from('app_settings').select('key, value').like('key', 'default_page_%').then(({ data }) => {
      if (data) {
        data.forEach(row => {
          if (row.value) safeStorageSet(row.key, row.value);
        });
      }
    }).catch(() => {});

    syncOK('DB Sync Active');
  } catch (e) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1500));
      return dbLoad(retries - 1);
    }

    import('./ui.js').then(m => m.recordError(e, 'Database Load'));

    // Fallback: Restore from local snapshot if device is offline
    const snapStr = safeStorageGet('local_lib_snapshot');
    if (snapStr) {
      try {
        const snap = JSON.parse(snapStr);
        S.subjects   = snap.subjects  || [];
        S.folders    = snap.folders   || [];
        S.pdfs       = snap.pdfs      || [];
        S.colorCats  = snap.colorCats || [];
        syncOK(navigator.onLine ? 'Local Cache (DB Sync Error)' : 'Offline Mode (Local Cache)');
        console.log('[DB] Restored library from local offline snapshot');
        return;
      } catch {}
    }

    const errCode = e?.code ? ` [${e.code}]` : '';
    syncErr(`Connection failed${errCode}`);
    throw e; // re-throw so init() can handle it (Bug #12 fix)
  }
}

// ── Annotation counts & Case Digest presence (for library badges) ──
function _hasMeaningfulDigest(html) {
  if (!html || typeof html !== 'string') return false;
  const stripped = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
  return stripped.length > 0 || /<img\b|<table\b/i.test(html);
}

export async function dbLoadAnnCounts() {
  try {
    const [annRes, notesRes] = await Promise.all([
      db.from('annotations').select('pdf_file_id'),
      db.from('pdf_notes').select('pdf_id, digest').not('digest', 'is', null).neq('digest', ''),
    ]);
    if (annRes.data) {
      S.annCounts = {};
      for (const row of annRes.data) {
        S.annCounts[row.pdf_file_id] = (S.annCounts[row.pdf_file_id] || 0) + 1;
      }
      safeStorageSet('local_ann_counts', JSON.stringify(S.annCounts));
    }
    if (notesRes.data) {
      S.digestMap = {};
      for (const row of notesRes.data) {
        if (row.pdf_id && _hasMeaningfulDigest(row.digest)) {
          S.digestMap[row.pdf_id] = true;
        }
      }
      safeStorageSet('local_digest_map', JSON.stringify(S.digestMap));
    }
  } catch {
    try {
      S.annCounts = JSON.parse(safeStorageGet('local_ann_counts', '{}') || '{}');
    } catch {}
    try {
      S.digestMap = JSON.parse(safeStorageGet('local_digest_map', '{}') || '{}');
    } catch {}
  }
}

// ── Subjects ──
export async function dbCreateSubject(name, hex_color) {
  const id = 'subj_' + Date.now();
  await safeDbWrite(db, 'subjects', 'upsert', { id, name, hex_color });
  S.subjects.push({ id, name, hex_color });
  broadcastSync({ type: 'LIBRARY_CHANGED' });
  driveResolveSubjectPath(id).catch(() => {});
  return id;
}

export async function dbRenameSubject(id, name) {
  await safeDbWrite(db, 'subjects', 'update', { name }, { id });
  const subj = S.subjects.find(s => s.id === id);
  if (subj) subj.name = name;
  broadcastSync({ type: 'LIBRARY_CHANGED' });
  scheduleDriveOrganize(600);
}

// ── Modular Helper: Safely purge a single PDF and its related records ──
export async function purgePdfData(pdfId, driveFileId = null) {
  if (!pdfId || typeof pdfId !== 'string' || !pdfId.trim()) {
    console.warn('[DB] purgePdfData: Skipped invalid or empty pdfId');
    return;
  }

  const cleanId = pdfId.trim();

  // 1. Delete annotation notes specifically attached to this PDF's annotations
  try {
    const { data: anns } = await db.from('annotations').select('id').eq('pdf_file_id', cleanId);
    const annIds = (anns || []).map(a => a.id).filter(Boolean);
    for (const aId of annIds) {
      await safeDbWrite(db, 'annotation_notes', 'delete', null, { annotation_id: aId });
    }
  } catch (err) {
    console.warn(`[DB] Error fetching annotations during purge for ${cleanId}:`, err);
  }

  // 2. Delete all records strictly matching this specific PDF ID
  await safeDbWrite(db, 'annotations', 'delete', null, { pdf_file_id: cleanId });
  await safeDbWrite(db, 'drawings', 'delete', null, { pdf_file_id: cleanId });
  await safeDbWrite(db, 'pdf_bookmarks', 'delete', null, { pdf_file_id: cleanId });
  await safeDbWrite(db, 'pdf_notes', 'delete', null, { pdf_id: cleanId });
  await safeDbWrite(db, 'pdf_files', 'delete', null, { id: cleanId });

  // 3. Clear local storage cache keys for this PDF
  safeStorageRemove('local_anns_' + cleanId);
  safeStorageRemove('local_bms_' + cleanId);
  safeStorageRemove('local_drawings_' + cleanId);
  safeStorageRemove('local_notepad_' + cleanId);
  safeStorageRemove('local_digest_' + cleanId);

  // 4. If Google Drive file ID is provided, clean up Drive & local PDF file cache
  if (driveFileId) {
    try {
      await driveDeleteFile(driveFileId);
    } catch (e) {
      console.error(`[DB] Drive deletion error for ${cleanId}:`, e);
    }
  }
}

export async function dbDelSubject(id) {
  if (!id || typeof id !== 'string') return;
  const cleanId = id.trim();

  // Get all folder IDs under this subject
  const fids = S.folders.filter(f => f.subject_id === cleanId).map(f => f.id);
  // Get all PDF IDs under those folders
  const pdfsToDelete = S.pdfs.filter(p => fids.includes(p.folder_id));
  const deletingIds = new Set(pdfsToDelete.map(p => p.id));

  // Purge each child PDF modularly (only delete Drive file if not a shortcut to a surviving PDF)
  for (const pdf of pdfsToDelete) {
    const stillUsedOutside = pdf.drive_file_id && S.pdfs.some(
      other => !deletingIds.has(other.id) && other.drive_file_id === pdf.drive_file_id
    );
    await purgePdfData(pdf.id, (!pdf.linked_pdf_id && !stillUsedOutside) ? pdf.drive_file_id : null);
  }

  // Delete child folders and the subject itself
  for (const fid of fids) {
    await safeDbWrite(db, 'folders', 'delete', null, { id: fid });
  }
  await safeDbWrite(db, 'subjects', 'delete', null, { id: cleanId });

  const pids = pdfsToDelete.map(p => p.id);
  S.pdfs     = S.pdfs.filter(p => !pids.includes(p.id));
  S.folders  = S.folders.filter(f => f.subject_id !== cleanId);
  S.subjects = S.subjects.filter(x => x.id !== cleanId);
  broadcastSync({ type: 'LIBRARY_CHANGED' });
  scheduleDriveOrganize(600);
}

// ── Folders ──
export async function dbCreateFolder(subject_id, name, folder_type = 'custom', parent_folder_id = null) {
  if (!subject_id && parent_folder_id) {
    const par = S.folders.find(f => f.id === parent_folder_id);
    if (par) subject_id = par.subject_id;
  }
  const id = 'fold_' + Date.now();
  
  const sibFolds = S.folders.filter(f => f.parent_folder_id === parent_folder_id && f.subject_id === subject_id);
  const sibPdfs = parent_folder_id ? S.pdfs.filter(p => p.folder_id === parent_folder_id) : [];
  const m1 = sibFolds.reduce((max, f) => Math.max(max, f.sort_order || 0), -1);
  const m2 = sibPdfs.reduce((max, p) => Math.max(max, p.sort_order || 0), -1);
  const sort_order = Math.max(m1, m2) + 1;

  const rec = { id, subject_id, name, folder_type, sort_order, parent_folder_id, _created_locally_at: Date.now() };
  S.folders.push(rec);

  // Save snapshot immediately so reload / dbLoad doesn't lose it
  try {
    const snap = JSON.parse(safeStorageGet('local_lib_snapshot', '{}') || '{}');
    snap.folders = S.folders;
    safeStorageSet('local_lib_snapshot', JSON.stringify(snap));
  } catch {}

  const dbPayload = { id, subject_id, name, folder_type, sort_order };
  if (parent_folder_id) dbPayload.parent_folder_id = parent_folder_id;

  try {
    await safeDbWrite(db, 'folders', 'upsert', dbPayload);
  } catch (err) {
    console.warn('[dbCreateFolder] safeDbWrite error:', err);
  }

  broadcastSync({ type: 'LIBRARY_CHANGED' });
  driveResolveFolderPath(id).catch(() => {});
  return id;
}

export async function dbRenameFolder(id, name) {
  await safeDbWrite(db, 'folders', 'update', { name }, { id });
  const fold = S.folders.find(f => f.id === id);
  if (fold) fold.name = name;
  broadcastSync({ type: 'LIBRARY_CHANGED' });
  scheduleDriveOrganize(600);
}

export async function dbReorderFolder(id, sort_order) {
  await safeDbWrite(db, 'folders', 'update', { sort_order }, { id });
  const fold = S.folders.find(f => f.id === id);
  if (fold) fold.sort_order = sort_order;
  broadcastSync({ type: 'LIBRARY_CHANGED' });
}

export async function dbUpdateFolderNotes(id, notes) {
  safeStorageSet('local_folder_notes_' + id, notes ?? '');
  await safeDbWrite(db, 'folders', 'update', { notes }, { id });
  const fold = S.folders.find(f => f.id === id);
  if (fold) fold.notes = notes;
  broadcastSync({ type: 'LIBRARY_CHANGED' });
}

export async function dbDelFolder(id) {
  if (!id || typeof id !== 'string') return;
  const cleanId = id.trim();

  // Recursively collect all descendant folder IDs
  function collectFolderIds(foldId) {
    const children = S.folders.filter(f => f.parent_folder_id === foldId).map(f => f.id);
    return [foldId, ...children.flatMap(collectFolderIds)];
  }
  const allFoldIds = collectFolderIds(cleanId);
  const pdfsToDelete = S.pdfs.filter(p => allFoldIds.includes(p.folder_id));
  const deletingIds = new Set(pdfsToDelete.map(p => p.id));

  // Purge each child PDF modularly
  for (const pdf of pdfsToDelete) {
    const stillUsedOutside = pdf.drive_file_id && S.pdfs.some(
      other => !deletingIds.has(other.id) && other.drive_file_id === pdf.drive_file_id
    );
    await purgePdfData(pdf.id, (!pdf.linked_pdf_id && !stillUsedOutside) ? pdf.drive_file_id : null);
  }

  // Delete all descendant folders (deepest first) + self
  for (const fid of allFoldIds) {
    await safeDbWrite(db, 'folders', 'delete', null, { id: fid });
  }

  S.pdfs    = S.pdfs.filter(p => !allFoldIds.includes(p.folder_id));
  S.folders = S.folders.filter(f => !allFoldIds.includes(f.id));
  broadcastSync({ type: 'LIBRARY_CHANGED' });
  scheduleDriveOrganize(600);
}

// ── PDFs (using Google Drive file ID instead of Supabase storage) ──
export async function dbRegisterPDF(folder_id, name, drive_file_id, linked_pdf_id = null) {
  const id = 'pdf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  
  const folder = S.folders.find(f => f.id === folder_id);
  const subject_id = folder ? folder.subject_id : null;
  const sibFolds = S.folders.filter(f => f.parent_folder_id === folder_id && f.subject_id === subject_id);
  const sibPdfs = S.pdfs.filter(p => p.folder_id === folder_id);
  const m1 = sibFolds.reduce((max, f) => Math.max(max, f.sort_order || 0), -1);
  const m2 = sibPdfs.reduce((max, p) => Math.max(max, p.sort_order || 0), -1);
  const sort_order = Math.max(m1, m2) + 1;

  const rec = { id, folder_id, name, drive_file_id, linked_pdf_id, storage_path: '', sort_order };
  await safeDbWrite(db, 'pdf_files', 'upsert', rec);
  S.pdfs.push(rec);
  broadcastSync({ type: 'LIBRARY_CHANGED' });
  if (linked_pdf_id) {
    driveSyncPdfLocation(rec).catch(() => {});
  }
  return rec;
}

export async function dbRenamePDF(id, name) {
  await safeDbWrite(db, 'pdf_files', 'update', { name }, { id });
  const pdf = S.pdfs.find(p => p.id === id);
  if (pdf) {
    pdf.name = name;
    driveSyncPdfLocation(pdf).catch(() => {});
  }
  broadcastSync({ type: 'LIBRARY_CHANGED' });
}

export async function dbMovePDF(id, folder_id) {
  await safeDbWrite(db, 'pdf_files', 'update', { folder_id }, { id });
  const p = S.pdfs.find(x => x.id === id);
  if (p) {
    p.folder_id = folder_id;
    driveSyncPdfLocation(p).catch(() => {});
    scheduleDriveOrganize(1200);
  }
  broadcastSync({ type: 'LIBRARY_CHANGED' });
}

export async function dbMoveFolder(id, parent_folder_id, subject_id) {
  await safeDbWrite(db, 'folders', 'update', { parent_folder_id, subject_id }, { id });
  const f = S.folders.find(x => x.id === id);
  if (f) {
    f.parent_folder_id = parent_folder_id;
    f.subject_id = subject_id;

    // Also propagate subject_id to any nested subfolders inside this folder
    const propagateSubj = (parentId) => {
      for (const child of S.folders) {
        if (child.parent_folder_id === parentId && child.subject_id !== subject_id) {
          child.subject_id = subject_id;
          safeDbWrite(db, 'folders', 'update', { subject_id }, { id: child.id }).catch(() => {});
          propagateSubj(child.id);
        }
      }
    };
    if (subject_id) propagateSubj(id);
  }
  broadcastSync({ type: 'LIBRARY_CHANGED' });
  scheduleDriveOrganize(800);
}

export async function dbReorderPDF(id, sort_order) {
  await safeDbWrite(db, 'pdf_files', 'update', { sort_order }, { id });
  const p = S.pdfs.find(x => x.id === id);
  if (p) p.sort_order = sort_order;
  broadcastSync({ type: 'LIBRARY_CHANGED' });
}

export async function dbDelPDF(id) {
  if (!id || typeof id !== 'string') return;
  const cleanId = id.trim();
  const target = S.pdfs.find(p => p.id === cleanId);

  // Also remove any shortcuts that point to this master PDF
  const linkedShortcuts = S.pdfs.filter(p => p.linked_pdf_id === cleanId);
  for (const sc of linkedShortcuts) {
    await purgePdfData(sc.id, null);
  }

  await purgePdfData(cleanId, (!target?.linked_pdf_id && target?.drive_file_id) ? target.drive_file_id : null);

  // Remove from memory
  S.pdfs = S.pdfs.filter(p => p.id !== cleanId && p.linked_pdf_id !== cleanId);
  broadcastSync({ type: 'LIBRARY_CHANGED' });
  scheduleDriveOrganize(800);
}

// ── Annotations ──
export async function dbLoadAnnotations(pfid) {
  try {
    const { data: anns } = await db
      .from('annotations').select('*')
      .eq('pdf_file_id', pfid).order('created_at');
    const ids = (anns || []).map(a => a.id);
    let notes = [];
    if (ids.length) {
      const { data: nd } = await db
        .from('annotation_notes').select('*')
        .in('annotation_id', ids).order('order_index');
      notes = nd || [];
    }
    S.annotations = (anns || []).map(a => ({
      ...a,
      notes: notes.filter(n => n.annotation_id === a.id),
    }));
    safeStorageSet('local_anns_' + pfid, JSON.stringify(S.annotations));
  } catch {
    try {
      S.annotations = JSON.parse(safeStorageGet('local_anns_' + pfid, '[]') || '[]');
      console.log(`[DB] Restored annotations for ${pfid} from local cache`);
    } catch {
      S.annotations = [];
    }
  }
}

export async function dbCreateAnnotation(ann) {
  const annRec = {
    id: ann.id,
    pdf_file_id: ann.pdf_file_id,
    page: ann.page,
    rects: ann.rects,
    highlighted_text: ann.highlighted_text,
    hex_color: ann.hex_color,
    highlight_mode: ann.highlight_mode,
  };
  await safeDbWrite(db, 'annotations', 'upsert', annRec);
  safeStorageSet('local_anns_' + ann.pdf_file_id, JSON.stringify(S.annotations));
  broadcastSync({ type: 'ANNOTATIONS_CHANGED', pdfId: ann.pdf_file_id });
}

export async function dbUpdateAnnColor(id, hex_color) {
  await safeDbWrite(db, 'annotations', 'update', { hex_color }, { id });
  broadcastSync({ type: 'ANNOTATIONS_CHANGED' });
}

export async function dbDelAnnotation(id) {
  await safeDbWrite(db, 'annotation_notes', 'delete', null, { annotation_id: id });
  await safeDbWrite(db, 'annotations', 'delete', null, { id });
  S.annotations = S.annotations.filter(a => a.id !== id);
  if (S.currentPdfId) {
    safeStorageSet('local_anns_' + S.currentPdfId, JSON.stringify(S.annotations));
  }
  broadcastSync({ type: 'ANNOTATIONS_CHANGED' });
}

// ── Custom Bookmarks (TOC) ──
export async function dbLoadBookmarks(pfid) {
  try {
    const { data } = await db.from('pdf_bookmarks').select('*').eq('pdf_file_id', pfid).order('page');
    S.bookmarks = data || [];
    safeStorageSet('local_bms_' + pfid, JSON.stringify(S.bookmarks));
  } catch {
    try {
      S.bookmarks = JSON.parse(safeStorageGet('local_bms_' + pfid, '[]') || '[]');
    } catch {
      S.bookmarks = [];
    }
  }
}

export async function dbCreateBookmark(pfid, page, title, level = 0) {
  const id = 'bm_' + Date.now();
  const bm = { id, pdf_file_id: pfid, page, title, level };
  await safeDbWrite(db, 'pdf_bookmarks', 'upsert', bm);
  S.bookmarks.push(bm);
  S.bookmarks.sort((a, b) => a.page - b.page);
  safeStorageSet('local_bms_' + pfid, JSON.stringify(S.bookmarks));
  broadcastSync({ type: 'ANNOTATIONS_CHANGED', pdfId: pfid });
  return bm;
}

export async function dbDelBookmark(id) {
  await safeDbWrite(db, 'pdf_bookmarks', 'delete', null, { id });
  S.bookmarks = S.bookmarks.filter(b => b.id !== id);
  if (S.currentPdfId) {
    safeStorageSet('local_bms_' + S.currentPdfId, JSON.stringify(S.bookmarks));
  }
  broadcastSync({ type: 'ANNOTATIONS_CHANGED' });
}

export async function dbClearAllBookmarks(pfid) {
  // Delete all bookmarks for this PDF one-by-one (safeDbWrite handles offline queuing)
  const toDelete = [...S.bookmarks];
  for (const bm of toDelete) {
    await safeDbWrite(db, 'pdf_bookmarks', 'delete', null, { id: bm.id });
  }
  S.bookmarks = [];
  safeStorageSet('local_bms_' + pfid, '[]');
  broadcastSync({ type: 'ANNOTATIONS_CHANGED', pdfId: pfid });
}

// ── Notes ──
export async function dbCreateNote(annotation_id, note_html, order_index) {
  const id = 'note_' + Date.now();
  const noteRec = { id, annotation_id, note_html, order_index };
  await safeDbWrite(db, 'annotation_notes', 'upsert', noteRec);
  broadcastSync({ type: 'ANNOTATIONS_CHANGED' });
  return noteRec;
}

export async function dbUpdateNote(id, note_html) {
  await safeDbWrite(db, 'annotation_notes', 'update', { note_html }, { id });
  broadcastSync({ type: 'ANNOTATIONS_CHANGED' });
}

export async function dbDelNote(id) {
  await safeDbWrite(db, 'annotation_notes', 'delete', null, { id });
  broadcastSync({ type: 'ANNOTATIONS_CHANGED' });
}

// ── Drawings ──
export async function dbLoadDrawings(pfid) {
  try {
    const { data } = await db.from('drawings').select('*').eq('pdf_file_id', pfid);
    S.drawData = {};
    for (const d of data || []) S.drawData[d.page] = d.strokes || [];
    safeStorageSet('local_draws_' + pfid, JSON.stringify(S.drawData));
  } catch {
    try {
      S.drawData = JSON.parse(safeStorageGet('local_draws_' + pfid, '{}') || '{}');
    } catch {
      S.drawData = {};
    }
  }
}

export async function dbSaveDrawings(pfid, page, strokes) {
  const id = `draw_${pfid}_${page}`;
  const drawObj = {
    id, pdf_file_id: pfid, page, strokes,
    updated_at: new Date().toISOString(),
  };
  await safeDbWrite(db, 'drawings', 'upsert', drawObj);
  safeStorageSet('local_draws_' + pfid, JSON.stringify(S.drawData));
  broadcastSync({ type: 'ANNOTATIONS_CHANGED', pdfId: pfid });
}

// ── Color Categories ──
export async function dbCreateColorCat(name, hex_color) {
  const id = 'cc_' + Date.now();
  const cat = { id, name, hex_color };
  await safeDbWrite(db, 'color_categories', 'upsert', cat);
  S.colorCats.push(cat);
  broadcastSync({ type: 'LIBRARY_CHANGED' });
  return cat;
}

export async function dbDelColorCat(id) {
  await safeDbWrite(db, 'color_categories', 'delete', null, { id });
  S.colorCats = S.colorCats.filter(c => c.id !== id);
  broadcastSync({ type: 'LIBRARY_CHANGED' });
}

// ── PDF Notepad & Case Digest ──
export async function dbLoadNotepad(pdf_id) {
  if (!pdf_id) {
    logNotepadDiagnostic(pdf_id, 'LOAD', 'ERR', 'ERR_NO_PDF_ID', 'Load aborted: missing pdf_id');
    return {
      content: '', digest: '',
      cloudContent: '', cloudDigest: '', cloudExists: false, cloudOk: false,
      code: 'ERR_NO_PDF_ID', status: 'ERR', source: 'none',
    };
  }
  const truePdfId = S.pdfs?.find(p => p.id === pdf_id)?.linked_pdf_id || pdf_id;
  let content = '';
  let digest = '';
  let cloudContent = '';
  let cloudDigest = '';
  let cloudExists = false;
  let cloudOk = false;
  let source = 'none';
  let diagCode = '200_OK';
  let diagStatus = 'OK';

  try {
    let { data, error } = await db.from('pdf_notes').select('content, digest').eq('pdf_id', truePdfId).maybeSingle();
    
    // If not found or empty on truePdfId, and truePdfId differs from pdf_id, check alias ID
    if (!error && (!data || (!data.content && !data.digest)) && truePdfId !== pdf_id) {
      try {
        const alt = await db.from('pdf_notes').select('content, digest').eq('pdf_id', pdf_id).maybeSingle();
        if (alt.data && (alt.data.content || alt.data.digest)) {
          data = alt.data;
        }
      } catch {}
    }

    if (error) {
      diagCode = error.code || 'ERR_SELECT';
      diagStatus = 'WARN';
      logNotepadDiagnostic(truePdfId, 'LOAD', 'WARN', diagCode, `Supabase select error: ${error.message} (${diagCode}). Retrying without digest column.`, { error });
      
      // Fallback in case 'digest' column is not created in Supabase yet
      let fallback = await db.from('pdf_notes').select('content').eq('pdf_id', truePdfId).maybeSingle();
      if (!fallback.error && (!fallback.data || !fallback.data.content) && truePdfId !== pdf_id) {
        const altFb = await db.from('pdf_notes').select('content').eq('pdf_id', pdf_id).maybeSingle();
        if (altFb.data?.content) fallback = altFb;
      }
      if (!fallback.error && fallback.data) {
        content = fallback.data.content || '';
        cloudContent = content;
        cloudExists = true;
        cloudOk = true;
        source = 'cloud';
        diagCode = 'WARN_NO_DIGEST_COL';
        logNotepadDiagnostic(truePdfId, 'LOAD', 'WARN', 'WARN_NO_DIGEST_COL', `Loaded content only (${content.length} chars) from Supabase. "digest" column does not exist in DB table.`, { contentLen: content.length });
      } else if (!fallback.error) {
        cloudOk = true;
        cloudExists = false;
      } else if (fallback.error) {
        diagCode = fallback.error.code || 'ERR_FALLBACK_FAIL';
        diagStatus = 'ERR';
        logNotepadDiagnostic(truePdfId, 'LOAD', 'ERR', diagCode, `Fallback select also failed: ${fallback.error.message}`, { error: fallback.error });
      }
    } else if (data) {
      content = data.content || '';
      digest = data.digest || '';
      cloudContent = content;
      cloudDigest = digest;
      cloudExists = true;
      cloudOk = true;
      source = 'cloud';
      logNotepadDiagnostic(truePdfId, 'LOAD', 'OK', '200_OK', `Successfully loaded from Supabase (Notes: ${content.length} chars, Digest: ${digest.length} chars) ← row ${truePdfId} "${S.pdfs?.find(p => p.id === pdf_id)?.name || ''}"`, { contentLen: content.length, digestLen: digest.length });
    } else {
      cloudOk = true;
      cloudExists = false;
      logNotepadDiagnostic(truePdfId, 'LOAD', 'OK', '200_EMPTY', `Supabase has no existing row for PDF ${truePdfId}. Checking local cache.`);
    }
  } catch (err) {
    diagCode = !navigator.onLine ? 'ERR_OFFLINE' : (err?.code || 'ERR_NETWORK');
    diagStatus = 'ERR';
    logNotepadDiagnostic(truePdfId, 'LOAD', 'ERR', diagCode, `Exception during Supabase load: ${err?.message || String(err)}`, { error: String(err) });
  }

  // Fallback to local storage if cloud returned empty or missing
  const localC = safeStorageGet('local_notepad_' + truePdfId, '') || (truePdfId !== pdf_id ? safeStorageGet('local_notepad_' + pdf_id, '') : '') || '';
  const localD = safeStorageGet('local_digest_'  + truePdfId, '') || (truePdfId !== pdf_id ? safeStorageGet('local_digest_'  + pdf_id, '') : '') || '';

  // If cloud returned empty or errored, check if local storage has valid notes
  if (!content && localC) {
    content = localC;
    source = (source === 'none' || source === 'cloud') ? 'local' : source;
    logNotepadDiagnostic(truePdfId, 'LOAD', 'INFO', 'INFO_LOCAL_NOTES', `Restored notes from local storage (${content.length} chars)`);
  }
  if (!digest && localD) {
    digest = localD;
    source = (source === 'none' || source === 'cloud') ? 'local' : source;
    logNotepadDiagnostic(truePdfId, 'LOAD', 'INFO', 'INFO_LOCAL_DIGEST', `Restored digest from local storage (${digest.length} chars)`);
  }

  // Fallback to history snapshot (both IndexedDB and localStorage) if still empty
  if (!content && !digest) {
    try {
      const { getNotepadHistoryIDB } = await import('./pdfcache.js');
      let hist = await getNotepadHistoryIDB(truePdfId);
      if ((!Array.isArray(hist) || hist.length === 0) && truePdfId !== pdf_id) {
        hist = await getNotepadHistoryIDB(pdf_id);
      }
      if (!Array.isArray(hist) || hist.length === 0) {
        hist = JSON.parse(safeStorageGet('notepad_history_' + truePdfId, '[]') || '[]');
        if ((!Array.isArray(hist) || hist.length === 0) && truePdfId !== pdf_id) {
          hist = JSON.parse(safeStorageGet('notepad_history_' + pdf_id, '[]') || '[]');
        }
      }
      if (Array.isArray(hist) && hist.length > 0) {
        // Find latest snapshot with actual content
        for (let i = hist.length - 1; i >= 0; i--) {
          const snap = hist[i];
          if (snap && (snap.content || snap.digest)) {
            content = snap.content || '';
            digest = snap.digest || '';
            source = 'snapshot';
            logNotepadDiagnostic(truePdfId, 'LOAD', 'INFO', 'INFO_SNAPSHOT_RESTORE', `Automatically recovered from snapshot history (Notes: ${content.length} chars, Digest: ${digest.length} chars)`);
            break;
          }
        }
      }
    } catch (e) {
      console.warn('[dbLoadNotepad] Snapshot recovery error:', e);
    }
  }

  // Only update local cache if we have content or if local was already empty
  if (content || digest || (!localC && !localD)) {
    safeStorageSet('local_notepad_' + truePdfId, content);
    safeStorageSet('local_digest_' + truePdfId, digest);
    if (truePdfId !== pdf_id) {
      safeStorageSet('local_notepad_' + pdf_id, content);
      safeStorageSet('local_digest_' + pdf_id, digest);
    }
  }

  return {
    content,
    digest,
    cloudContent,
    cloudDigest,
    cloudExists,
    cloudOk,
    code: diagCode,
    status: diagStatus,
    source,
  };
}

// ── Read the RAW cloud row for a notepad (no local fallback, no side effects) ──
// Used by sync verification to find out what Supabase ACTUALLY holds.
// Returns { ok:true, exists:boolean, content, digest, digestKnown } or { ok:false, error }.
export async function dbFetchCloudNotepadRaw(pdf_id) {
  if (!pdf_id) return { ok: false, error: 'Missing pdf_id' };
  const truePdfId = S.pdfs?.find(p => p.id === pdf_id)?.linked_pdf_id || pdf_id;
  try {
    let { data, error } = await db.from('pdf_notes').select('content, digest').eq('pdf_id', truePdfId).maybeSingle();
    if (!error && (!data || (!data.content && !data.digest)) && truePdfId !== pdf_id) {
      try {
        const alt = await db.from('pdf_notes').select('content, digest').eq('pdf_id', pdf_id).maybeSingle();
        if (alt.data && (alt.data.content || alt.data.digest)) {
          data = alt.data;
        }
      } catch {}
    }
    if (error) {
      // Maybe the digest column is missing — retry content only
      let fb = await db.from('pdf_notes').select('content').eq('pdf_id', truePdfId).maybeSingle();
      if (!fb.error && (!fb.data || !fb.data.content) && truePdfId !== pdf_id) {
        const altFb = await db.from('pdf_notes').select('content').eq('pdf_id', pdf_id).maybeSingle();
        if (altFb.data?.content) fb = altFb;
      }
      if (fb.error) return { ok: false, error: fb.error.message || String(fb.error) };
      return { ok: true, exists: !!fb.data, content: fb.data?.content || '', digest: '', digestKnown: false };
    }
    return { ok: true, exists: !!data, content: data?.content || '', digest: data?.digest || '', digestKnown: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ── Ensure parent subject, ancestor folders, and pdf_files row exist in Supabase ──
export async function ensurePdfExistsInCloud(pdfId) {
  if (!pdfId) return false;
  const pdf = S.pdfs?.find(p => p.id === pdfId);
  if (!pdf) return false;

  try {
    // 1. Collect ancestor folder chain from root to leaf
    const folderChain = [];
    let curFold = S.folders?.find(f => f.id === pdf.folder_id);
    const visited = new Set();
    while (curFold && !visited.has(curFold.id)) {
      visited.add(curFold.id);
      folderChain.unshift(curFold);
      curFold = curFold.parent_folder_id
        ? S.folders?.find(f => f.id === curFold.parent_folder_id)
        : null;
    }

    // This is a HEAL: it must only CREATE rows that are missing in Supabase. `ignoreDuplicates`
    // guarantees it never overwrites a subject/folder/PDF (name, folder notes, order…) that
    // another device has since changed with this device's possibly stale copy.
    const createOnly = { onConflict: 'id', ignoreDuplicates: true };
    const healFail = (what, id, err) => {
      logNotepadDiagnostic(pdfId, 'HEAL', 'ERR', 'ERR_HEAL_' + what,
        `Could not create missing ${what} "${id}" in Supabase: ${err?.message || String(err)} (${err?.code || 'no code'})`,
        { error: err });
    };

    // 2. Ensure Subject exists in Supabase  (subjects table columns: id, name, hex_color)
    const subjectIds = new Set(folderChain.map(f => f.subject_id).filter(Boolean));
    for (const sid of subjectIds) {
      const subj = S.subjects?.find(s => s.id === sid);
      if (subj) {
        const { error: subjErr } = await db.from('subjects').upsert({
          id: subj.id,
          name: subj.name,
          hex_color: subj.hex_color || '#6366f1',
        }, createOnly);
        if (subjErr) healFail('SUBJECT', subj.id, subjErr);
      }
    }

    // 3. Ensure Folder hierarchy exists in Supabase (root-first)
    for (const fold of folderChain) {
      const localFoldNotes = safeStorageGet('local_folder_notes_' + fold.id, '');
      const foldPayload = {
        id: fold.id,
        subject_id: fold.subject_id,
        name: fold.name,
        parent_folder_id: fold.parent_folder_id || null,
        sort_order: fold.sort_order ?? 0,
      };
      if (fold.notes || localFoldNotes) {
        foldPayload.notes = fold.notes || localFoldNotes;
      }
      const { error: foldErr } = await db.from('folders').upsert(foldPayload, createOnly);
      if (foldErr && foldPayload.notes !== undefined) {
        // Fallback if 'notes' column does not exist on folders
        delete foldPayload.notes;
        const { error: foldErr2 } = await db.from('folders').upsert(foldPayload, createOnly);
        if (foldErr2) healFail('FOLDER', fold.id, foldErr2);
      } else if (foldErr) {
        healFail('FOLDER', fold.id, foldErr);
      }
    }

    // 4. If this PDF links to a master PDF, ensure master PDF exists first
    if (pdf.linked_pdf_id && pdf.linked_pdf_id !== pdf.id) {
      await ensurePdfExistsInCloud(pdf.linked_pdf_id);
    }

    // 5. Upsert the PDF row itself
    const pdfPayload = {
      id: pdf.id,
      folder_id: pdf.folder_id,
      name: pdf.name,
      drive_file_id: pdf.drive_file_id || '',
      linked_pdf_id: pdf.linked_pdf_id || null,
      storage_path: pdf.storage_path || '',
      sort_order: pdf.sort_order ?? 0,
    };
    const { error: pdfErr } = await db.from('pdf_files').upsert(pdfPayload, createOnly);
    if (pdfErr) healFail('PDF', pdf.id, pdfErr);
    return !pdfErr;
  } catch (err) {
    console.warn('[DB] ensurePdfExistsInCloud failed:', err);
    return false;
  }
}

export async function dbSaveNotepad(pdf_id, content, digest) {
  if (!pdf_id) {
    logNotepadDiagnostic(pdf_id, 'SAVE', 'ERR', 'ERR_NO_PDF_ID', 'Save aborted: missing pdf_id');
    return { error: 'Missing pdf_id', code: 'ERR_NO_PDF_ID', saved: false };
  }
  const truePdfId = S.pdfs?.find(p => p.id === pdf_id)?.linked_pdf_id || pdf_id;
  const payload = { pdf_id: truePdfId };
  if (content !== undefined) {
    const safeC = content ?? '';
    payload.content = safeC;
    safeStorageSet('local_notepad_' + truePdfId, safeC);
    // Also keep the original-id key in sync so callers that read by pdf_id stay consistent
    if (truePdfId !== pdf_id) safeStorageSet('local_notepad_' + pdf_id, safeC);
  }
  if (digest !== undefined) {
    const safeD = digest ?? '';
    payload.digest = safeD;
    safeStorageSet('local_digest_' + truePdfId, safeD);
    if (truePdfId !== pdf_id) safeStorageSet('local_digest_' + pdf_id, safeD);

    // Keep S.digestMap & library digest counters updated immediately
    if (!S.digestMap) S.digestMap = {};
    if (_hasMeaningfulDigest(safeD)) {
      S.digestMap[truePdfId] = true;
      S.digestMap[pdf_id] = true;
    } else {
      delete S.digestMap[truePdfId];
      delete S.digestMap[pdf_id];
    }
    safeStorageSet('local_digest_map', JSON.stringify(S.digestMap));
    import('./library.js').then(m => m.renderLibrary?.()).catch(() => {});
  }

  const cLen = payload.content?.length || 0;
  const dLen = payload.digest?.length || 0;
  // Saves are field-level: a field that wasn't sent is "unchanged", not "0 chars"
  const cTxt = payload.content === undefined ? 'unchanged' : `${cLen} chars`;
  const dTxt = payload.digest  === undefined ? 'unchanged' : `${dLen} chars`;

  try {
    let { error } = await db.from('pdf_notes').upsert(payload, { onConflict: 'pdf_id' });

    // Auto-heal Foreign Key error (23503): ensure subject -> folder -> pdf_files exist in Supabase, then retry!
    if (error) {
      const initCode = error.code || 'ERR_UPSERT';
      const initMsg = error.message || JSON.stringify(error);
      if (initCode === '23503' || initMsg.includes('foreign key') || initMsg.includes('23503')) {
        logNotepadDiagnostic(truePdfId, 'SAVE', 'WARN', 'WARN_23503_HEAL', `Foreign key (23503) on "${truePdfId}". Auto-creating parent folder/PDF record in Supabase and retrying...`);
        const healed = await ensurePdfExistsInCloud(truePdfId);
        if (healed) {
          const retry = await db.from('pdf_notes').upsert(payload, { onConflict: 'pdf_id' });
          error = retry.error;
        }
      }
    }

    if (error) {
      const errCode = error.code || 'ERR_UPSERT';
      const errMsg = error.message || JSON.stringify(error);

      // 1. Foreign Key error (23503): PDF still does not exist in Supabase pdf_files
      if (errCode === '23503' || errMsg.includes('foreign key') || errMsg.includes('23503')) {
        logNotepadDiagnostic(truePdfId, 'SAVE', 'ERR', 'ERR_23503_FK', `Foreign key violation (23503): PDF "${truePdfId}" does not exist in Supabase "pdf_files" table. Saved locally.`, { error, payloadLength: { content: cLen, digest: dLen } });
        return { error: errMsg, code: 'ERR_23503_FK', localOnly: true, saved: false };
      }

      // 2. Missing 'digest' column error (PGRST204 / 42703)
      if (payload.digest !== undefined && (errMsg.includes('digest') || errCode === 'PGRST204' || errCode === '42703')) {
        logNotepadDiagnostic(truePdfId, 'SAVE', 'WARN', 'WARN_NO_DIGEST_COL', `Supabase table "pdf_notes" is missing column "digest". Falling back to saving content only.`, { error });
        const fallbackPayload = { pdf_id: truePdfId };
        if (content !== undefined) fallbackPayload.content = payload.content;
        const fallbackRes = await db.from('pdf_notes').upsert(fallbackPayload, { onConflict: 'pdf_id' });
        if (fallbackRes.error) {
          logNotepadDiagnostic(truePdfId, 'SAVE', 'ERR', fallbackRes.error.code || 'ERR_FALLBACK', `Fallback save failed: ${fallbackRes.error.message}`, { error: fallbackRes.error });
          return { error: fallbackRes.error.message, code: fallbackRes.error.code, saved: false };
        } else {
          logNotepadDiagnostic(truePdfId, 'SAVE', 'WARN', 'WARN_SAVED_WITHOUT_DIGEST', `Content saved to cloud (${cLen} chars), but digest (${dLen} chars) could not be saved to cloud because the "digest" column is missing in Supabase! Digest is safely saved locally.`, { payloadLength: { content: cLen, digest: dLen } });
          broadcastSync({ type: 'NOTEPAD_CHANGED', pdfId: truePdfId, content: payload.content, digest: payload.digest });
          return { saved: true, code: 'WARN_SAVED_WITHOUT_DIGEST', warning: 'Digest column missing in cloud database' };
        }
      }

      // 3. Other Supabase error: queue to outbox
      logNotepadDiagnostic(truePdfId, 'SAVE', 'ERR', errCode, `Supabase upsert failed: ${errMsg}. Queuing to offline outbox.`, { error, payloadLength: { content: cLen, digest: dLen } });
      enqueueAction('pdf_notes', 'upsert', payload);
      return { error: errMsg, code: errCode, queued: true, saved: false };
    }

    // Direct Success
    const pdfName = S.pdfs?.find(p => p.id === pdf_id)?.name || '';
    logNotepadDiagnostic(truePdfId, 'SAVE', 'OK', '200_OK', `Successfully saved to Supabase (Notes: ${cTxt}, Digest: ${dTxt}) → row ${truePdfId}${pdfName ? ` "${pdfName}"` : ''}`, { payloadLength: { content: cLen, digest: dLen } });
    broadcastSync({ type: 'NOTEPAD_CHANGED', pdfId: truePdfId, content: payload.content, digest: payload.digest });
    return { saved: true, code: '200_OK' };
  } catch (err) {
    const errCode = !navigator.onLine ? 'ERR_OFFLINE' : (err?.code || 'ERR_NETWORK');
    const errMsg = err?.message || String(err);
    logNotepadDiagnostic(truePdfId, 'SAVE', 'ERR', errCode, `Network/system exception during save: ${errMsg}. Queuing to outbox.`, { error: String(err), payloadLength: { content: cLen, digest: dLen } });
    enqueueAction('pdf_notes', 'upsert', payload);
    return { error: errMsg, code: errCode, queued: true, saved: false };
  }
}

// ───────────────────────────────────────────────
// IMPORTANT LINKS (Stored in DB)
// ───────────────────────────────────────────────
export async function dbLoadLinks() {
  try {
    const { data, error } = await db.from('dictionary').select('definition').eq('word', '__sys_links').maybeSingle();
    if (error || !data) return [];
    const links = JSON.parse(data.definition) || [];
    safeStorageSet('local_sys_links', JSON.stringify(links));
    return links;
  } catch {
    try {
      return JSON.parse(safeStorageGet('local_sys_links', '[]') || '[]');
    } catch {
      return [];
    }
  }
}

export async function dbSaveLinks(links) {
  await safeDbWrite(db, 'dictionary', 'upsert', { word: '__sys_links', definition: JSON.stringify(links) });
  safeStorageSet('local_sys_links', JSON.stringify(links));
}

// ── App Settings (cloud-synced key-value store) ──
// Used for Gemini API key and other cross-device settings.
export async function dbGetSetting(key) {
  try {
    const { data } = await db.from('app_settings').select('value').eq('key', key).maybeSingle();
    return data?.value || null;
  } catch { return null; }
}

export async function dbSetSetting(key, value) {
  try {
    await safeDbWrite(db, 'app_settings', 'upsert', { key, value });
  } catch { /* silently fail — localStorage is the fallback */ }
}
