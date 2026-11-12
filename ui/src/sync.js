// ═══════════════════════════════════════════════
// SYNC — Real-time synchronization across tabs & devices
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { db, dbLoad, dbLoadAnnCounts, dbLoadAnnotations, dbLoadDrawings } from './db.js';
import { safeStorageGet, safeStorageSet } from './storage.js';

let _channel = null;
let _refreshTimer = null;
let _annTimer = null;
let _notepadTimer = null;
let _colorCatTimer = null;

export function broadcastSync(msg) {
  try {
    if (!_channel && typeof BroadcastChannel !== 'undefined') {
      _channel = new BroadcastChannel('legal_annotator_realtime');
    }
    if (_channel) {
      _channel.postMessage({ ...msg, timestamp: Date.now() });
    }
  } catch (e) {
    console.warn('[Sync] broadcast failed', e);
  }
}

async function handleLibraryRefresh() {
  clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(async () => {
    try {
      await dbLoad();
      await dbLoadAnnCounts();
      const { renderLibrary } = await import('./library.js');
      renderLibrary();
      import('./colors.js').then(m => m.refreshColorCategoryUI?.()).catch(() => {});
    } catch (err) {
      console.error('[Sync] Library refresh error', err);
    }
  }, 100);
}

async function handleColorCategoriesRefresh(payload) {
  clearTimeout(_colorCatTimer);
  _colorCatTimer = setTimeout(async () => {
    try {
      let nextCats = null;
      if (db && db.from) {
        const { data, error } = await db.from('color_categories').select('*').order('created_at');
        if (!error && Array.isArray(data)) nextCats = data;
      }

      if (nextCats) {
        S.colorCats = nextCats;
      } else if (payload) {
        const ev = payload.eventType;
        const row = payload.new || payload.old;
        if (ev === 'DELETE' && row?.id) {
          S.colorCats = (S.colorCats || []).filter(c => c.id !== row.id);
        } else if ((ev === 'INSERT' || ev === 'UPDATE') && row?.id) {
          const list = [...(S.colorCats || [])];
          const idx = list.findIndex(c => c.id === row.id);
          if (idx >= 0) list[idx] = { ...list[idx], ...row };
          else list.push(row);
          S.colorCats = list;
        }
      }

      try {
        const raw = safeStorageGet('local_lib_snapshot');
        const snap = raw ? JSON.parse(raw) : {};
        snap.colorCats = S.colorCats || [];
        snap.saved_at = Date.now();
        safeStorageSet('local_lib_snapshot', JSON.stringify(snap));
      } catch {}

      const { refreshColorCategoryUI } = await import('./colors.js');
      refreshColorCategoryUI?.();
    } catch (err) {
      console.error('[Sync] Color categories refresh error', err);
    }
  }, 100);
}

async function handleAnnotationsRefresh(pdfId) {
  if (!S.curPDF) return;
  const trueId = S.curPDF.linked_pdf_id || S.curPDF.id;
  if (pdfId && pdfId !== trueId) return;

  clearTimeout(_annTimer);
  _annTimer = setTimeout(async () => {
    try {
      await dbLoadAnnotations(trueId);
      await dbLoadDrawings(trueId);
      const { redrawAllAnnotations } = await import('./annotate.js');
      const { redrawAllDrawings }    = await import('./draw.js');
      redrawAllAnnotations();
      redrawAllDrawings();
    } catch (err) {
      console.error('[Sync] Annotations refresh error', err);
    }
  }, 150);
}

async function handleNotepadRefresh(pdfId) {
  if (!S.curPDF) return;
  const trueId = S.curPDF.linked_pdf_id || S.curPDF.id;
  if (pdfId && pdfId !== trueId) return;

  // Don't overwrite if notepad panel is not open
  const panel = document.getElementById('notepad-panel');
  if (!panel || !panel.classList.contains('open')) return;

  clearTimeout(_notepadTimer);
  _notepadTimer = setTimeout(async () => {
    try {
      const { dbLoadNotepad } = await import('./db.js');
      const { updateNotepadCacheFromRemote } = await import('./notepad.js');
      const { content, digest } = await dbLoadNotepad(trueId);
      const editor = document.getElementById('np-editor');
      const digestEditor = document.getElementById('np-digest-editor');
      // ANTI-WIPE GUARD: Don't overwrite non-empty editor content with empty remote data.
      const hasLocalContent = (editor && editor.innerHTML) || (digestEditor && digestEditor.innerHTML);
      if (!content && !digest && hasLocalContent) return;
      // Don't overwrite if user is actively typing in the editor
      if (editor && document.activeElement !== editor && content !== undefined) {
        editor.innerHTML = content || '';
      }
      if (digestEditor && document.activeElement !== digestEditor && digest !== undefined) {
        digestEditor.innerHTML = digest || '';
      }
      // Keep in-memory notepad cache fresh so PDF switching doesn't restore stale data
      updateNotepadCacheFromRemote(trueId, content, digest);
    } catch (err) {
      console.error('[Sync] Notepad refresh error', err);
    }
  }, 200);
}

export function initRealtimeSync() {
  // 1. Cross-Tab Broadcast Channel (instant 0ms sync on same browser)
  if (typeof BroadcastChannel !== 'undefined') {
    _channel = new BroadcastChannel('legal_annotator_realtime');
    _channel.onmessage = (event) => {
      const data = event.data;
      if (!data || !data.type) return;

      if (data.type === 'LIBRARY_CHANGED') {
        handleLibraryRefresh();
      } else if (data.type === 'ANNOTATIONS_CHANGED') {
        handleAnnotationsRefresh(data.pdfId);
      } else if (data.type === 'NOTEPAD_CHANGED') {
        if (S.curPDF) {
          const trueId = S.curPDF.linked_pdf_id || S.curPDF.id;
          if (data.pdfId === trueId) {
            const editor = document.getElementById('np-editor');
            const digestEditor = document.getElementById('np-digest-editor');
            if (editor && document.activeElement !== editor && data.content !== undefined) {
              editor.innerHTML = data.content;
            }
            if (digestEditor && document.activeElement !== digestEditor && data.digest !== undefined) {
              digestEditor.innerHTML = data.digest;
            }
          }
        }
      }
    };
  }

  // 2. Supabase Postgres Realtime (cross-device live sync)
  try {
    if (db && db.channel) {
      db.channel('public:realtime_library')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'subjects' }, () => handleLibraryRefresh())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'folders' }, () => handleLibraryRefresh())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pdf_files' }, () => handleLibraryRefresh())
        .on('postgres_changes', { event: '*', schema: 'public', table: 'color_categories' }, (payload) => handleColorCategoriesRefresh(payload))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'annotations' }, (payload) => {
          const pdfId = payload.new?.pdf_file_id || payload.old?.pdf_file_id;
          handleAnnotationsRefresh(pdfId);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'drawings' }, (payload) => {
          const pdfId = payload.new?.pdf_file_id || payload.old?.pdf_file_id;
          handleAnnotationsRefresh(pdfId);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pdf_notes' }, (payload) => {
          const pdfId = payload.new?.pdf_id || payload.old?.pdf_id;
          handleNotepadRefresh(pdfId);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings' }, async (payload) => {
          const key = payload.new?.key || payload.old?.key;
          if (!key) return;
          if (!S.curPDF) {
            if (key === 'gn_open_tabs_v1') {
              import('./goodnotes-ui.js').then(m => m.renderDocTabs?.()).catch(() => {});
            }
            return;
          }
          const trueId = S.curPDF.linked_pdf_id || S.curPDF.id;
          if (key === 'read_pos_' + trueId && payload.new?.value) {
            try {
              const { parseReadPosPayload, scrollToPageAndRatio } = await import('./ui.js');
              const { safeStorageGet, safeStorageSet } = await import('./storage.js');
              const localRaw = safeStorageGet('read_pos_meta_' + trueId) || safeStorageGet('bookmark_' + trueId);
              const localPos = parseReadPosPayload(localRaw);
              const cloudPos = parseReadPosPayload(payload.new.value);
              if (cloudPos && cloudPos.page >= 1 && cloudPos.page <= S.totalPages) {
                if (cloudPos.updatedAt > localPos.updatedAt && (cloudPos.page !== S.curPage || Math.abs(cloudPos.ratio - (localPos.ratio || 0)) > 0.05)) {
                  safeStorageSet('bookmark_' + trueId, cloudPos.page);
                  if (S.curPDF.linked_pdf_id) safeStorageSet('bookmark_' + S.curPDF.id, cloudPos.page);
                  const metaStr = JSON.stringify(cloudPos);
                  safeStorageSet('read_pos_meta_' + trueId, metaStr);
                  safeStorageSet('read_pos_meta_' + S.curPDF.id, metaStr);
                  S.curPage = cloudPos.page;
                  document.getElementById('pg-input').value = cloudPos.page;
                  await scrollToPageAndRatio(cloudPos.page, cloudPos.ratio, true);
                }
              }
            } catch (err) {
              console.warn('[Sync] Realtime read_pos update error', err);
            }
          } else if (key === 'pdf_tags_v1_' + trueId) {
            import('./tags.js').then(m => m.loadTagsForPdf?.(trueId)).catch(() => {});
          } else if (key === 'gn_open_tabs_v1') {
            import('./goodnotes-ui.js').then(m => m.renderDocTabs?.()).catch(() => {});
          }
        })
        .subscribe();
    }
  } catch (err) {
    console.warn('[Sync] Supabase realtime subscription unavailable', err);
  }
}
