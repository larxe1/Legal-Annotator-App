// ═══════════════════════════════════════════════
// LIBRARY — sidebar rendering with all upgrades:
//   - Annotation count badges
//   - Rename (subject, folder, PDF)
//   - Drag-to-reorder folders
//   - Recent PDFs
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { toast, openModal, closeModal, syncSpin, syncOK, syncErr } from './ui.js';
import {
  dbLoad,
  dbCreateSubject, dbRenameSubject, dbDelSubject,
  dbCreateFolder,  dbRenameFolder,  dbDelFolder, dbReorderFolder, dbMoveFolder,
  dbRegisterPDF,   dbRenamePDF,     dbDelPDF,    dbMovePDF, dbReorderPDF,
  dbLoadAnnCounts, dbUpdateFolderNotes, dbSetSetting, dbGetSetting
} from './db.js';
import { safeStorageGet, safeStorageSet, safeStorageRemove } from './storage.js';
import { driveUploadPDF, driveDeleteFile, driveEnsureSubFolder, driveResolveFolderPath, scheduleDriveOrganize } from './drive.js';
import { openPDFFromLibrary, updateActivePDF, openFolderDoc } from './viewer.js';
import { closeSidebar } from './ui.js';

let _pdfToLink = null;
let _folderNotesId = null;

// ── Library Right-Click Context Menu ──
let _ctxTarget = null;
let _ctxIsFolder = false;

function showLibCtxMenu(item, x, y, isFolder = false) {
  let target = item;
  _ctxIsFolder = isFolder;

  const exportBtn = document.getElementById('lib-ctx-export-pdf');
  const forceSyncBtn = document.getElementById('lib-ctx-force-sync');
  let isMultiFolder = false;

  // Check if multiple folders are currently selected and the clicked item is among them
  if (isFolder && S.selectedIds && S.selectedIds.size > 1 && S.selectedIds.has(item.id)) {
    const selectedFolders = [...S.selectedIds]
      .map(id => S.folders.find(f => f.id === id))
      .filter(Boolean);
    if (selectedFolders.length > 1) {
      target = selectedFolders; // Retains exact insertion/selection order
      isMultiFolder = true;
      if (exportBtn) exportBtn.textContent = `📥 Export ${selectedFolders.length} Folders to PDF`;
      if (forceSyncBtn) forceSyncBtn.textContent = `☁️ Force Sync ${selectedFolders.length} Folders & PDFs`;
    } else {
      if (exportBtn) exportBtn.textContent = '📥 Export Notes to PDF';
      if (forceSyncBtn) forceSyncBtn.textContent = '☁️ Force Sync Folder & PDFs';
    }
  } else {
    if (exportBtn) exportBtn.textContent = '📥 Export Notes to PDF';
    if (forceSyncBtn) {
      forceSyncBtn.textContent = isFolder
        ? '☁️ Force Sync Folder & PDFs'
        : '☁️ Force Sync PDF to Cloud';
    }
  }

  _ctxTarget = target;
  const menu = document.getElementById('lib-ctx-menu');
  if (!menu) return;

  // Toggle visibility of context items
  document.getElementById('lib-ctx-open').style.display = (isFolder || isMultiFolder) ? 'none' : 'block';
  document.getElementById('lib-ctx-reference').style.display = (isFolder || isMultiFolder) ? 'none' : 'block';
  const setPageBtn = document.getElementById('lib-ctx-set-page');
  if (setPageBtn) setPageBtn.style.display = (isFolder || isMultiFolder) ? 'none' : 'block';
  document.getElementById('lib-ctx-link').style.display = (isFolder || isMultiFolder) ? 'none' : 'block';
  document.getElementById('lib-ctx-offline').style.display = (isFolder || isMultiFolder) ? 'none' : 'block';
  document.getElementById('lib-ctx-download').style.display = (isFolder || isMultiFolder) ? 'none' : 'block';
  document.getElementById('lib-ctx-gdrive').style.display = (isFolder || isMultiFolder) ? 'none' : 'block';
  document.getElementById('lib-ctx-export-pdf').style.display = (isFolder || isMultiFolder) ? 'block' : 'none';
  if (forceSyncBtn) forceSyncBtn.style.display = 'block';

  // Position off-screen first so we can measure actual rendered dimensions
  menu.style.left = '-9999px';
  menu.style.top  = '-9999px';
  menu.classList.add('open');

  // Measure actual size after it's visible
  const mw = menu.offsetWidth  || 200;
  const mh = menu.offsetHeight || 200;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const GAP = 4;

  // Flip left if it would overflow the right edge
  const left = (x + mw + GAP > vw) ? Math.max(0, x - mw) : x;
  // Flip up if it would overflow the bottom edge
  const top  = (y + mh + GAP > vh) ? Math.max(0, y - mh) : y;

  menu.style.left = left + 'px';
  menu.style.top  = top  + 'px';
}

function hideLibCtxMenu() {
  document.getElementById('lib-ctx-menu')?.classList.remove('open');
  _ctxTarget = null;
}

// ── Export options modal: lets user pick portrait / landscape before exporting ──
function showExportOptsModal(foldersOrFolder) {
  const folders = Array.isArray(foldersOrFolder) ? foldersOrFolder : [foldersOrFolder];
  const modal = document.getElementById('export-opts-modal');
  if (!modal) {
    // Fallback: export directly without modal
    import('./export.js').then(m => m.exportFolderToPDF(folders));
    return;
  }

  const titleEl = document.getElementById('export-opts-title');
  const descEl  = document.getElementById('export-opts-desc');
  if (titleEl) {
    titleEl.textContent = folders.length > 1
      ? `📄 Export ${folders.length} Folders to PDF`
      : `📄 Export Notes to PDF`;
  }
  if (descEl) {
    descEl.textContent = folders.length > 1
      ? `Export order: ${folders.map((f, i) => `${i + 1}. ${f.name || 'Folder'}`).join(' → ')}`
      : `Choose page orientation before exporting.`;
  }

  // Reset to portrait selection each time
  const portraitRadio   = document.getElementById('export-opt-portrait');
  const landscapeRadio  = document.getElementById('export-opt-landscape');
  const portraitLbl     = document.getElementById('export-opt-portrait-lbl');
  const landscapeLbl    = document.getElementById('export-opt-landscape-lbl');

  if (portraitRadio)  portraitRadio.checked = true;
  if (landscapeRadio) landscapeRadio.checked = false;
  if (portraitLbl)  { portraitLbl.style.border = '2px solid #2e6bd6'; portraitLbl.style.background = 'rgba(46,107,214,0.12)'; }
  if (landscapeLbl) { landscapeLbl.style.border = '2px solid #2e3f5c'; landscapeLbl.style.background = 'transparent'; }

  // Wire up click-to-select visuals
  function selectOrientation(val) {
    if (portraitRadio)  portraitRadio.checked  = val === 'portrait';
    if (landscapeRadio) landscapeRadio.checked = val === 'landscape';
    if (portraitLbl)  { portraitLbl.style.border  = val === 'portrait'  ? '2px solid #2e6bd6' : '2px solid #2e3f5c'; portraitLbl.style.background  = val === 'portrait'  ? 'rgba(46,107,214,0.12)' : 'transparent'; }
    if (landscapeLbl) { landscapeLbl.style.border = val === 'landscape' ? '2px solid #2e6bd6' : '2px solid #2e3f5c'; landscapeLbl.style.background = val === 'landscape' ? 'rgba(46,107,214,0.12)' : 'transparent'; }
  }

  if (portraitLbl)  portraitLbl.onclick  = () => selectOrientation('portrait');
  if (landscapeLbl) landscapeLbl.onclick = () => selectOrientation('landscape');

  // Show modal
  modal.style.display = 'flex';

  // Cancel
  const cancelBtn = document.getElementById('export-opts-cancel');
  const goBtn     = document.getElementById('export-opts-go');

  const cleanup = () => { modal.style.display = 'none'; };

  if (cancelBtn) cancelBtn.onclick = cleanup;

  if (goBtn) {
    goBtn.onclick = async () => {
      const orientation = landscapeRadio?.checked ? 'landscape' : 'portrait';
      cleanup();
      const { exportFolderToPDF } = await import('./export.js');
      await exportFolderToPDF(folders, { orientation });
    };
  }

  // Also close on backdrop click
  modal.onclick = (e) => { if (e.target === modal) cleanup(); };
}

export function initContextMenu() {
  const menu = document.getElementById('lib-ctx-menu');
  if (!menu) return;

  // "Open" — normal open in primary pane
  document.getElementById('lib-ctx-open').addEventListener('click', () => {
    if (!_ctxTarget || _ctxIsFolder) return;
    hideLibCtxMenu();
    openPDFFromLibrary(_ctxTarget);
    closeSidebar();
  });

  // "Open as Reference" — open in pane B
  document.getElementById('lib-ctx-reference').addEventListener('click', async () => {
    if (!_ctxTarget || _ctxIsFolder) return;
    const pdf = _ctxTarget;
    hideLibCtxMenu();

    if (!S.curPDF) {
      // No primary PDF open yet — open it normally first
      openPDFFromLibrary(pdf);
      closeSidebar();
      return;
    }
    if (pdf.id === (S.curPDF?.id)) {
      toast('This PDF is already open as the primary.');
      return;
    }
    const { openPDFInPaneB } = await import('./dualview.js');
    openPDFInPaneB(pdf);
    closeSidebar();
  });

  // "Set Default Opening Page"
  document.getElementById('lib-ctx-set-page')?.addEventListener('click', () => {
    if (!_ctxTarget || _ctxIsFolder) return;
    const pdf = _ctxTarget;
    hideLibCtxMenu();
    openDefaultPageModal(pdf);
  });

  // "Create Shortcut"
  document.getElementById('lib-ctx-link')?.addEventListener('click', () => {
    if (!_ctxTarget || _ctxIsFolder) return;
    const pdf = _ctxTarget;
    hideLibCtxMenu();
    openLinkPdfModal(pdf);
  });

  // "Open in Google Drive" — opens file directly in Google Drive in new tab
  document.getElementById('lib-ctx-gdrive')?.addEventListener('click', () => {
    if (!_ctxTarget || _ctxIsFolder) return;
    const pdf = _ctxTarget;
    hideLibCtxMenu();

    const driveId = pdf.drive_file_id || S.pdfs.find(p => p.id === pdf.linked_pdf_id)?.drive_file_id;
    if (!driveId) {
      toast('No Google Drive file linked to this PDF.');
      return;
    }

    const driveUrl = `https://drive.google.com/file/d/${encodeURIComponent(driveId)}/view`;
    window.open(driveUrl, '_blank', 'noopener,noreferrer');
  });

  // "Save for Offline" — pre-cache PDF to IndexedDB
  document.getElementById('lib-ctx-offline')?.addEventListener('click', async () => {
    if (!_ctxTarget || _ctxIsFolder) return;
    const pdf = _ctxTarget;
    hideLibCtxMenu();
    const { preCachePDF } = await import('./pdfcache.js');
    await preCachePDF(pdf);
  });

  // "Download to PC" — save PDF file to local PC folder or browser Downloads
  document.getElementById('lib-ctx-download')?.addEventListener('click', async () => {
    if (!_ctxTarget || _ctxIsFolder) return;
    const pdf = _ctxTarget;
    hideLibCtxMenu();

    const { S } = await import('./state.js');
    const { toast } = await import('./ui.js');
    const { downloadPDFToPC } = await import('./pdfcache.js');

    const driveId = pdf.drive_file_id || S.pdfs.find(p => p.id === pdf.linked_pdf_id)?.drive_file_id;
    if (!driveId) {
      toast('❌ No Google Drive file linked to this PDF.');
      return;
    }

    if (!S.driveToken) {
      // Fallback: open Drive download URL directly
      const dlUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveId)}`;
      window.open(dlUrl, '_blank', 'noopener,noreferrer');
      toast('Opening Google Drive download link…');
      return;
    }

    toast(`⬇ Downloading "${pdf.name}"…`);
    try {
      // Fetch PDF bytes via Drive API (reuses cached blob if already in IndexedDB)
      const { driveFetchPDF } = await import('./drive.js');
      const blob = await driveFetchPDF(driveId, (pct, loadedMB, totalMB) => {
        if (pct !== null) toast(`⬇ Downloading: ${pct}% (${loadedMB}/${totalMB} MB)`);
        else toast(`⬇ Downloading: ${loadedMB} MB…`);
      }, pdf.name);

      const result = await downloadPDFToPC(blob, pdf.name);
      if (result.folder) {
        toast(`✅ Saved "${pdf.name}" to folder: ${result.folder}`);
      } else {
        toast(`✅ "${pdf.name}" downloading to your Downloads folder.`);
      }
    } catch (err) {
      console.error('[Download to PC] Failed:', err);
      toast(`❌ Download failed: ${err.message || 'Unknown error'}`);
    }
  });

  // "Export Notes to PDF"
  document.getElementById('lib-ctx-export-pdf')?.addEventListener('click', () => {
    if (!_ctxTarget || !_ctxIsFolder) return;
    const folder = _ctxTarget;
    hideLibCtxMenu();
    showExportOptsModal(folder);
  });

  // "Force Sync to Cloud" (Folder + all child PDFs/Notes/Digests, or Single PDF)
  document.getElementById('lib-ctx-force-sync')?.addEventListener('click', async () => {
    if (!_ctxTarget) return;
    const target = _ctxTarget;
    const isFolder = _ctxIsFolder;
    hideLibCtxMenu();
    const { forceSyncFolders, forceSyncPdf } = await import('./notepad.js');
    if (isFolder) {
      await forceSyncFolders(target);
    } else {
      await forceSyncPdf(target);
    }
  });

  // Dismiss on outside click
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#lib-ctx-menu')) hideLibCtxMenu();
  });

  // Dismiss on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') hideLibCtxMenu();
  });
}

// ── Selection Logic ──
function getFlatLibraryItems() {
  const items = [];
  S.subjects.forEach(subj => {
    // We don't select subjects, but we iterate their contents
    const rootFolds = S.folders.filter(f => f.subject_id === subj.id && !f.parent_folder_id)
      .sort((a,b) => (a.sort_order??0)-(b.sort_order??0));
    
    function traverseFolder(fold) {
      items.push({ type: 'folder', id: fold.id, obj: fold });
      const children = [
        ...S.folders.filter(f => f.parent_folder_id === fold.id).map(f => ({ type: 'folder', id: f.id, obj: f, sort: f.sort_order??0 })),
        ...S.pdfs.filter(p => p.folder_id === fold.id).map(p => ({ type: 'pdf', id: p.id, obj: p, sort: p.sort_order??0 }))
      ].sort((a, b) => a.sort - b.sort);
      
      children.forEach(c => {
        if (c.type === 'folder') traverseFolder(c.obj);
        else items.push(c);
      });
    }
    rootFolds.forEach(traverseFolder);
  });
  return items;
}

export function handleSelection(id, e) {
  if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
    S.selectedIds.clear();
    S.selectedIds.add(id);
    S.lastSelectedId = id;
  } else if (e.ctrlKey || e.metaKey) {
    if (S.selectedIds.has(id)) S.selectedIds.delete(id);
    else S.selectedIds.add(id);
    S.lastSelectedId = id;
  } else if (e.shiftKey && S.lastSelectedId) {
    const items = getFlatLibraryItems();
    const idx1 = items.findIndex(i => i.id === S.lastSelectedId);
    const idx2 = items.findIndex(i => i.id === id);
    if (idx1 !== -1 && idx2 !== -1) {
      const start = Math.min(idx1, idx2);
      const end = Math.max(idx1, idx2);
      for (let i = start; i <= end; i++) {
        S.selectedIds.add(items[i].id);
      }
    }
    // DO NOT update lastSelectedId on shift-click
  }
  updateSelectionUI();
}

export function updateSelectionUI() {
  document.querySelectorAll('.li-fold, .li-pdf').forEach(el => {
    if (S.selectedIds.has(el.dataset.id)) {
      el.classList.add('li-selected');
    } else {
      el.classList.remove('li-selected');
    }
  });
}

// ── Unified Drag & Drop Logic ──
async function handleReorder(targetId, targetType, draggedIds, insertAfter = false) {
  const pdfIds = draggedIds.filter(id => id.startsWith('pdf:')).map(id => id.replace('pdf:', ''));
  const foldIds = draggedIds.filter(id => !id.startsWith('pdf:'));
  
  let parentId = null;
  let subjectId = null;

  if (targetType === 'folder') {
    const f = S.folders.find(x => x.id === targetId);
    if (!f) return;
    parentId = f.parent_folder_id;
    subjectId = f.subject_id;
  } else {
    const p = S.pdfs.find(x => x.id === targetId);
    if (!p) return;
    parentId = p.folder_id;
    const f = S.folders.find(x => x.id === parentId);
    if (f) subjectId = f.subject_id;
  }

  let sibFolds = S.folders.filter(f => f.parent_folder_id === parentId && f.subject_id === subjectId);
  let sibPdfs = parentId ? S.pdfs.filter(p => p.folder_id === parentId) : [];

  sibFolds = sibFolds.filter(f => !foldIds.includes(f.id));
  sibPdfs = sibPdfs.filter(p => !pdfIds.includes(p.id));

  let siblings = [
    ...sibFolds.map(f => ({ id: f.id, type: 'folder', obj: f })),
    ...sibPdfs.map(p => ({ id: p.id, type: 'pdf', obj: p }))
  ].sort((a, b) => (a.obj.sort_order ?? 0) - (b.obj.sort_order ?? 0));

  let dropIdx = siblings.findIndex(s => s.id === targetId && s.type === targetType);
  if (dropIdx === -1) dropIdx = siblings.length;
  if (insertAfter) dropIdx++;

  const draggedObjects = [
    ...foldIds.map(id => {
      const f = S.folders.find(x => x.id === id);
      if (f) return { id: f.id, type: 'folder', obj: f };
      return null;
    }),
    ...pdfIds.map(id => {
      const p = S.pdfs.find(x => x.id === id);
      if (p) return { id: p.id, type: 'pdf', obj: p };
      return null;
    })
  ].filter(Boolean);

  if (draggedObjects.length === 0) return;

  snapshotMove();

  siblings.splice(dropIdx, 0, ...draggedObjects);

  siblings.forEach((s, i) => {
    s.obj.sort_order = i;
    if (s.type === 'folder') {
      // Prevent circular cycles
      let isCircular = false;
      let curr = parentId;
      while (curr) {
        if (curr === s.id) { isCircular = true; break; }
        const par = S.folders.find(x => x.id === curr);
        curr = par ? par.parent_folder_id : null;
      }
      
      if (!isCircular && (s.obj.parent_folder_id !== parentId || s.obj.subject_id !== subjectId)) {
        dbMoveFolder(s.id, parentId, subjectId).catch(()=>{});
        s.obj.parent_folder_id = parentId;
        s.obj.subject_id = subjectId;
      }
      dbReorderFolder(s.id, i).catch(()=>{});
    } else {
      if (s.obj.folder_id !== parentId) {
        dbMovePDF(s.id, parentId).catch(()=>{});
        s.obj.folder_id = parentId;
      }
      dbReorderPDF(s.id, i).catch(()=>{});
    }
  });
  renderLibrary();
}

async function handleMoveInto(targetFolderId, draggedIds) {
  const pdfIds = draggedIds.filter(id => id.startsWith('pdf:')).map(id => id.replace('pdf:', ''));
  const foldIds = draggedIds.filter(id => !id.startsWith('pdf:'));
  
  snapshotMove();
  
  let changed = false;
  for (const pdfId of pdfIds) {
    const pdf = S.pdfs.find(p => p.id === pdfId);
    if (pdf && pdf.folder_id !== targetFolderId) {
      dbMovePDF(pdfId, targetFolderId).catch(()=>{});
      pdf.folder_id = targetFolderId;
      changed = true;
    }
  }

  const targetFolder = S.folders.find(f => f.id === targetFolderId);
  if (targetFolder) {
    for (const foldId of foldIds) {
      const folder = S.folders.find(f => f.id === foldId);
      
      // Prevent circular cycles
      let isCircular = false;
      let curr = targetFolderId;
      while (curr) {
        if (curr === foldId) { isCircular = true; break; }
        const par = S.folders.find(x => x.id === curr);
        curr = par ? par.parent_folder_id : null;
      }

      if (!isCircular && folder && folder.parent_folder_id !== targetFolderId) {
        dbMoveFolder(foldId, targetFolderId, targetFolder.subject_id).catch(()=>{});
        folder.parent_folder_id = targetFolderId;
        folder.subject_id = targetFolder.subject_id;
        changed = true;
      }
    }
  }

  if (changed) renderLibrary();
}


// ── Render full library tree ──
export function renderLibrary() {
  const tree = document.getElementById('lib-tree');
  if (!S.subjects.length) {
    tree.innerHTML = '<div class="lib-empty">No subjects yet.<br>Click "+ New Subject" to start.</div>';
    return;
  }
  tree.innerHTML = '';
  for (const subj of S.subjects) tree.appendChild(buildSubjectEl(subj));
  updateSelectionUI();
}

// ── Subject node ──
function buildSubjectEl(subj) {
  const w   = document.createElement('div');
  w.className   = 'li-subj';
  w.dataset.id  = subj.id;
  const exp = !S.collapsedSubj[subj.id];

  w.innerHTML = `
    <div class="li-subj-hd">
      <span class="li-chev ${exp ? '' : 'closed'}">▼</span>
      <span class="li-dot" style="background:${subj.hex_color || '#c9a84c'}"></span>
      <span class="li-subj-name" title="${subj.name.replace(/"/g, '&quot;')}">${subj.name}</span>
      <div class="li-acts">
        <button class="li-act-btn" title="Add folder" data-act="add-fold">📁+</button>
        <button class="li-act-btn" title="Rename" data-act="rename">✏</button>
        <button class="li-act-btn del" title="Delete" data-act="del">✕</button>
      </div>
    </div>
    <div class="li-subj-ch" style="display:${exp ? 'flex' : 'none'}"></div>`;

  const hd   = w.querySelector('.li-subj-hd');
  const ch   = w.querySelector('.li-subj-ch');
  const chev = w.querySelector('.li-chev');

  hd.addEventListener('click', e => {
    if (e.target.closest('.li-acts')) return;
    S.collapsedSubj[subj.id] = !S.collapsedSubj[subj.id];
    chev.classList.toggle('closed');
    ch.style.display = S.collapsedSubj[subj.id] ? 'none' : 'flex';
  });

  w.querySelector('[data-act="add-fold"]').addEventListener('click', e => {
    e.stopPropagation();
    openNewFolderModal(subj.id);
  });

  w.querySelector('[data-act="rename"]').addEventListener('click', e => {
    e.stopPropagation();
    startInlineRename(w.querySelector('.li-subj-name'), async newName => {
      await dbRenameSubject(subj.id, newName);
      toast('Renamed');
    });
  });

  w.querySelector('[data-act="del"]').addEventListener('click', e => {
    e.stopPropagation();
    if (!confirm(`Delete subject "${subj.name}" and all its content?`)) return;
    dbDelSubject(subj.id).then(() => { renderLibrary(); toast('Deleted'); });
  });

  hd.addEventListener('dragover', e => {
    e.preventDefault();
    hd.classList.add('drag-over');
  });
  hd.addEventListener('dragleave', () => hd.classList.remove('drag-over'));
  hd.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    hd.classList.remove('drag-over');
    const rawData = e.dataTransfer.getData('text/plain');
    if (!rawData) return;
    let payload;
    try { payload = JSON.parse(rawData); } catch { payload = { type: 'single', id: rawData }; }
    const draggedIds = payload.type === 'multi' ? payload.ids : [payload.id];
    const foldIds = draggedIds.filter(id => !id.startsWith('pdf:'));
    
    snapshotMove();
    
    let changed = false;
    for (const foldId of foldIds) {
      const folder = S.folders.find(f => f.id === foldId);
      if (folder && (folder.parent_folder_id !== null || folder.subject_id !== subj.id)) {
        dbMoveFolder(foldId, null, subj.id).catch(()=>{});
        folder.parent_folder_id = null;
        folder.subject_id = subj.id;
        changed = true;
      }
    }
    if (changed) renderLibrary();
  });

  const folds = S.folders
    .filter(f => f.subject_id === subj.id && !f.parent_folder_id) // root folders only
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const f of folds) ch.appendChild(buildFolderEl(f));
  return w;
}

// ── Folder node ──
function buildFolderEl(fold) {
  const w  = document.createElement('div');
  w.className  = 'li-fold';
  w.dataset.id = fold.id;
  w.draggable  = true;
  const exp  = !!S.expandedFold[fold.id];
  const icons = { codal: '📜', cases: '⚖', laws: '📋', others: '📁', custom: '📂' };

  w.innerHTML = `
    <div class="li-fold-hd">
      <span class="li-chev ${exp ? '' : 'closed'}" style="font-size:9px">▼</span>
      <span>${icons[fold.folder_type] || '📁'}</span>
      <span class="li-fold-name" title="${fold.name.replace(/"/g, '&quot;')}">${fold.name}</span>
      <div class="li-acts">
        <button class="li-act-btn" title="Add subfolder" data-act="subfolder">📁+</button>
        <button class="li-act-btn" title="Add PDF" data-act="upload">📄+</button>
        <button class="li-act-btn" title="Rename" data-act="rename">✏</button>
        <button class="li-act-btn del" title="Delete" data-act="del">✕</button>
      </div>
    </div>
    <div class="li-fold-ch" style="display:${exp ? 'flex' : 'none'}"></div>`;

  const hd   = w.querySelector('.li-fold-hd');
  const ch   = w.querySelector('.li-fold-ch');
  const chev = w.querySelector('.li-chev');

  // Handle selection on pointerdown
  hd.addEventListener('pointerdown', e => {
    if (e.target.closest('.li-acts')) return;
    
    // If holding modifier, handle selection
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      handleSelection(fold.id, e);
      return;
    }
  });

  // Right-click context menu for folder
  hd.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    showLibCtxMenu(fold, e.clientX, e.clientY, true);
  });

  // Handle expand/collapse on chevron OR open general notes on folder click
  hd.addEventListener('click', e => {
    if (e.target.closest('.li-acts')) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    
    if (e.target.closest('.li-chev')) {
      S.expandedFold[fold.id] = !S.expandedFold[fold.id];
      chev.classList.toggle('closed');
      ch.style.display = S.expandedFold[fold.id] ? 'flex' : 'none';
    } else {
      // Clicking the folder immediately opens the folder's general notes
      openFolderDoc(fold);
      closeSidebar();
    }
  });

  w.querySelector('[data-act="subfolder"]').addEventListener('click', e => {
    e.stopPropagation();
    const subjId = fold.subject_id || S.folders.find(f => f.id === fold.parent_folder_id)?.subject_id;
    openNewSubfolderModal(fold.id, subjId);
  });

  w.querySelector('[data-act="upload"]').addEventListener('click', e => {
    e.stopPropagation();
    triggerPDFUpload(fold.id);
  });

  w.querySelector('[data-act="rename"]').addEventListener('click', e => {
    e.stopPropagation();
    startInlineRename(w.querySelector('.li-fold-name'), async newName => {
      await dbRenameFolder(fold.id, newName);
      toast('Renamed');
    });
  });

  w.querySelector('[data-act="del"]').addEventListener('click', e => {
    e.stopPropagation();
    if (!confirm(`Delete folder "${fold.name}" and all its PDFs?`)) return;
    dbDelFolder(fold.id).then(() => { renderLibrary(); toast('Deleted'); });
  });

  // Unify and render children
  const childFolds = S.folders.filter(f => f.parent_folder_id === fold.id).map(f => ({ ...f, _type: 'folder' }));
  const childPdfs = S.pdfs.filter(p => p.folder_id === fold.id).map(p => ({ ...p, _type: 'pdf' }));
  
  const children = [...childFolds, ...childPdfs].sort((a, b) => {
    const sA = a.sort_order ?? 0;
    const sB = b.sort_order ?? 0;
    if (sA === sB) return a.name.localeCompare(b.name);
    return sA - sB;
  });

  for (const child of children) {
    if (child._type === 'folder') {
      const childEl = buildFolderEl(child);
      childEl.style.marginLeft = '12px';
      childEl.style.borderLeft = '2px solid rgba(201,168,76,0.2)';
      ch.appendChild(childEl);
    } else {
      ch.appendChild(buildPdfEl(child));
    }
  }

  // ── Drag-to-reorder/move ──
  w.addEventListener('dragstart', e => {
    e.stopPropagation();
    if (e.target.closest('.li-pdf')) return;
    if (!S.selectedIds.has(fold.id)) {
      S.selectedIds.clear();
      S.selectedIds.add(fold.id);
      updateSelectionUI();
    }
    const dragPayload = JSON.stringify({ type: 'multi', ids: Array.from(S.selectedIds) });
    e.dataTransfer.setData('text/plain', dragPayload);
    document.querySelectorAll('.li-selected').forEach(el => el.style.opacity = '0.5');
  });
  w.addEventListener('dragend', () => { 
    document.querySelectorAll('.li-selected').forEach(el => el.style.opacity = '');
  });

  hd.addEventListener('dragover', e => {
    if (!S.selectedIds.has(fold.id)) {
      e.preventDefault();
      hd.classList.add('drag-over');
    }
  });
  hd.addEventListener('dragleave', () => hd.classList.remove('drag-over'));
  hd.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    hd.classList.remove('drag-over');
    const rawData = e.dataTransfer.getData('text/plain');
    if (!rawData) return;
    
    let payload;
    try { payload = JSON.parse(rawData); } catch { payload = { type: 'single', id: rawData }; }
    const draggedIds = payload.type === 'multi' ? payload.ids : [payload.id];

    if (draggedIds.includes(fold.id)) return;

    // Check intent based on mouse Y coordinate
    const rect = hd.getBoundingClientRect();
    const y = e.clientY - rect.top;
    
    if (y < rect.height * 0.25) {
      await handleReorder(fold.id, 'folder', draggedIds, false);
    } else if (y > rect.height * 0.75) {
      await handleReorder(fold.id, 'folder', draggedIds, true);
    } else {
      await handleMoveInto(fold.id, draggedIds);
    }
  });

  return w;
}

function buildPdfEl(pdf) {
  const el = document.createElement('div');
  el.className  = 'li-pdf' + (S.curPDF?.id === pdf.id ? ' active' : '');
  el.dataset.id = pdf.id;
  el.draggable  = true;

  const count = S.annCounts[pdf.id] || 0;
  const trueId = pdf.linked_pdf_id || pdf.id;
  const defPage = safeStorageGet('default_page_' + pdf.id)
    || (pdf.folder_id ? safeStorageGet('default_page_f_' + pdf.folder_id + '_' + trueId) : null);
  const defBadgeHtml = defPage ? `<span class="def-page-badge" title="Opens at page ${defPage} by default (Click to change)">p.${defPage}</span>` : '';

  el.innerHTML = `
    <span>📄</span>
    <span class="li-pdf-name" title="${pdf.name.replace(/"/g, '&quot;')}">
      ${pdf.linked_pdf_id ? '<span style="color:var(--gold);margin-right:4px" title="Shortcut">🔗</span>' : ''}
      ${pdf.name}
    </span>
    ${defBadgeHtml}
    <span class="ann-badge" style="${count ? '' : 'display:none'}">${count}</span>
    <div class="li-acts">
      <button class="li-act-btn" title="Create Shortcut in another folder" data-act="link">🔗</button>
      <button class="li-act-btn" title="Rename" data-act="rename">✏</button>
      <button class="li-act-btn del" title="Delete" data-act="del">✕</button>
    </div>`;

  el.addEventListener('dragstart', e => {
    e.stopPropagation();
    
    if (!S.selectedIds.has(pdf.id)) {
      S.selectedIds.clear();
      S.selectedIds.add(pdf.id);
      updateSelectionUI();
    }
    
    const dragPayload = JSON.stringify({ type: 'multi', ids: Array.from(S.selectedIds).map(id => id.startsWith('pdf_') ? 'pdf:'+id : id) });
    e.dataTransfer.setData('text/plain', dragPayload);
    
    document.querySelectorAll('.li-selected').forEach(el => el.style.opacity = '0.5');
  });
  el.addEventListener('dragend', () => { 
    document.querySelectorAll('.li-selected').forEach(el => el.style.opacity = '');
  });

  el.addEventListener('dragover', e => {
    e.preventDefault();
    e.stopPropagation(); // prevent folder from also highlighting
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drag-over');

    const rawData = e.dataTransfer.getData('text/plain');
    if (!rawData) return;
    
    let payload;
    try { payload = JSON.parse(rawData); } catch { payload = { type: 'single', id: rawData }; }
    const draggedIds = payload.type === 'multi' ? payload.ids : [payload.id];
    
    if (draggedIds.includes(pdf.id) || draggedIds.includes(`pdf:${pdf.id}`)) return;

    const rect = el.getBoundingClientRect();
    const y = e.clientY - rect.top;
    await handleReorder(pdf.id, 'pdf', draggedIds, y > rect.height / 2);
  });

  el.addEventListener('pointerdown', e => {
    if (e.target.closest('.li-acts')) return;
    handleSelection(pdf.id, e);
  });
  
  el.addEventListener('click', e => {
    if (e.target.closest('.li-acts')) return;
    // Only open PDF if we are not multi-selecting
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      openPDFFromLibrary(pdf);
      closeSidebar();
    }
  });

  // Right-click context menu
  el.addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    showLibCtxMenu(pdf, e.clientX, e.clientY);
  });

  const defBadgeEl = el.querySelector('.def-page-badge');
  if (defBadgeEl) {
    defBadgeEl.addEventListener('click', e => {
      e.stopPropagation();
      openDefaultPageModal(pdf);
    });
  }

  el.querySelector('[data-act="link"]').addEventListener('click', e => {
    e.stopPropagation();
    openLinkPdfModal(pdf);
  });

  el.querySelector('[data-act="rename"]').addEventListener('click', e => {
    e.stopPropagation();
    startInlineRename(el.querySelector('.li-pdf-name'), async newName => {
      await dbRenamePDF(pdf.id, newName);
      toast('Renamed');
    });
  });

  el.querySelector('[data-act="del"]').addEventListener('click', e => {
    e.stopPropagation();
    
    const isMaster = S.pdfs.some(p => p.linked_pdf_id === pdf.id);
    let msg = `Delete "${pdf.name}"?`;
    if (isMaster) {
      msg = `WARNING: "${pdf.name}" has shortcuts linked to it! Deleting this Master PDF will also delete ALL its shortcuts across other folders. Proceed?`;
    }
    
    if (!confirm(msg)) return;
    
    dbDelPDF(pdf.id).then(async () => {
      // Also remove from Drive (only if this is the master PDF, not a shortcut)
      if (pdf.drive_file_id && !pdf.linked_pdf_id) await driveDeleteFile(pdf.drive_file_id);
      renderLibrary();
      if (S.curPDF?.id === pdf.id || S.curPDF?.linked_pdf_id === pdf.id) {
        S.curPDF = null;
        document.getElementById('canvas-scroll').innerHTML =
          '<div id="welcome" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center"><p style="color:var(--muted);font-size:13px">PDF removed. Select another from the library.</p></div>';
      }
      toast('PDF deleted');
    });
  });

  return el;
}

// ── Inline rename helper ──
function startInlineRename(nameEl, onSave) {
  const old = nameEl.textContent;
  const inp = document.createElement('input');
  inp.className = 'rename-input';
  inp.value = old;
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();

  const finish = async (save) => {
    const val = inp.value.trim();
    inp.replaceWith(nameEl);
    if (save && val && val !== old) {
      nameEl.textContent = val;
      nameEl.title = val;
      try { await onSave(val); }
      catch { 
        nameEl.textContent = old; 
        nameEl.title = old;
        toast('Rename failed'); 
      }
    } else {
      nameEl.textContent = old;
      nameEl.title = old;
    }
  };

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  finish(true);
    if (e.key === 'Escape') finish(false);
  });
  inp.addEventListener('blur', () => finish(true));
}

// ── Normalize PDF filename by stripping download duplicate suffixes like (1), (2), - Copy, etc. ──
export function normalizePdfName(filename) {
  if (!filename) return '';
  let base = filename.trim().replace(/\.pdf$/i, '').trim();
  let prev;
  do {
    prev = base;
    base = base
      // Match trailing (1), (2), [1], [2], up to 2 digits so 4-digit legal citation years like (2024) are preserved
      .replace(/\s*[\(\[]\s*\d{1,2}\s*[\)\]]$/, '')
      // Match Windows duplicate copy suffixes like " - Copy", " - Copy (1)", "_copy"
      .replace(/\s*-\s*copy(?:\s*[\(\[]\s*\d{1,2}\s*[\)\]])?$/i, '')
      .replace(/_copy(?:\s*[\(\[]\s*\d{1,2}\s*[\)\]])?$/i, '')
      .trim();
  } while (base !== prev && base.length > 0);

  return base.toLowerCase().trim();
}

// ── Prompt for Duplicate PDF Resolution (Shortcut vs Independent Copy vs Cancel) ──
function promptDuplicateResolution(duplicateItems) {
  return new Promise((resolve) => {
    const modal = document.getElementById('mo-dup-upload');
    const desc = document.getElementById('dup-upload-desc');
    const list = document.getElementById('dup-upload-list');
    const btnShortcut = document.getElementById('dup-btn-shortcut');
    const btnCopy = document.getElementById('dup-btn-copy');
    const btnCancel = document.getElementById('dup-btn-cancel');

    if (!modal || !btnShortcut || !btnCopy) {
      const ans = confirm('This file is already in your library.\n\nClick OK to create a linked shortcut, or Cancel to skip.');
      return resolve(ans ? 'SHORTCUT' : 'CANCEL');
    }

    const formatLoc = (folderId) => {
      const folder = S.folders.find(f => f.id === folderId);
      if (!folder) return 'Library';
      const parts = [folder.name];
      let curr = folder;
      let depth = 0;
      while (curr.parent_folder_id && depth < 10) {
        const parent = S.folders.find(f => f.id === curr.parent_folder_id);
        if (!parent) break;
        parts.unshift(parent.name);
        curr = parent;
        depth++;
      }
      const subject = S.subjects.find(s => s.id === folder.subject_id);
      if (subject) parts.unshift(subject.name);
      return parts.join(' > ');
    };

    if (duplicateItems.length === 1) {
      const item = duplicateItems[0];
      const loc = formatLoc(item.match.folder_id);
      const isExact = item.file.name.toLowerCase().trim() === item.match.name.toLowerCase().trim();
      const matchMsg = isExact
        ? `already exists in your library under <b>${loc}</b>.`
        : `substantially matches existing file <b>"${item.match.name}"</b> in <b>${loc}</b>.`;
      desc.innerHTML = `The file <b>"${item.file.name}"</b> ${matchMsg}`;
      list.style.display = 'none';
    } else {
      desc.textContent = `${duplicateItems.length} files you selected already exist or match files in your library:`;
      list.style.display = 'block';
      list.innerHTML = duplicateItems.map(d => {
        const isExact = d.file.name.toLowerCase().trim() === d.match.name.toLowerCase().trim();
        const loc = formatLoc(d.match.folder_id);
        const detail = isExact ? `in ${loc}` : `matches "${d.match.name}" in ${loc}`;
        return `• <b>${d.file.name}</b> (${detail})`;
      }).join('<br>');
    }

    openModal('mo-dup-upload');

    function cleanup() {
      btnShortcut.removeEventListener('click', onShortcut);
      btnCopy.removeEventListener('click', onCopy);
      btnCancel?.removeEventListener('click', onCancel);
    }

    function onShortcut() {
      cleanup();
      closeModal('mo-dup-upload');
      resolve('SHORTCUT');
    }

    function onCopy() {
      cleanup();
      closeModal('mo-dup-upload');
      resolve('COPY');
    }

    function onCancel() {
      cleanup();
      closeModal('mo-dup-upload');
      resolve('CANCEL');
    }

    btnShortcut.addEventListener('click', onShortcut, { once: true });
    btnCopy.addEventListener('click', onCopy, { once: true });
    btnCancel?.addEventListener('click', onCancel, { once: true });
  });
}

// ── Modal wiring (subjects, folders, upload) ──
export function initLibraryModals() {
  initRefreshButton();
  document.getElementById('new-subj-btn').addEventListener('click', () => {
    const inp = document.getElementById('subj-name');
    if (inp) {
      inp.value = '';
      setTimeout(() => inp.focus(), 50);
    }
    openModal('mo-subj');
  });

  document.getElementById('save-subj').addEventListener('click', async () => {
    const name = document.getElementById('subj-name').value.trim();
    if (!name) return;
    await dbCreateSubject(name, document.getElementById('subj-color').value);
    renderLibrary();
    closeModal('mo-subj');
    toast('Subject created');
  });

  document.getElementById('subj-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('save-subj')?.click();
    }
  });

  // Preset color clicks
  document.querySelectorAll('.subj-cpre').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('subj-color').value = btn.dataset.c;
    });
  });

  // Preset emoji clicks
  document.querySelectorAll('.subj-emo').forEach(btn => {
    btn.addEventListener('click', () => {
      const inp = document.getElementById('subj-name');
      inp.value = btn.textContent + ' ' + inp.value;
      inp.focus();
    });
  });

  document.querySelectorAll('.ftype-btn').forEach(b =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.ftype-btn').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
    })
  );
  
  // ── Link PDF Shortcut Modal ──
  document.getElementById('confirm-link-pdf')?.addEventListener('click', async () => {
    if (!_pdfToLink) return;
    const targetFolderId = document.getElementById('link-target-folder')?.value;
    if (!targetFolderId) {
      toast('Please select a target folder.');
      return;
    }

    if (targetFolderId === _pdfToLink.folder_id) {
      toast('This PDF is already in this folder.');
      return;
    }
    
    // The true master ID is the original linked_pdf_id (if it's already a shortcut) or the id itself
    const trueId = _pdfToLink.linked_pdf_id || _pdfToLink.id;
    const driveId = _pdfToLink.drive_file_id || (S.pdfs.find(p => p.id === trueId)?.drive_file_id) || '';

    // Check if target folder already contains this PDF or a shortcut to it
    const alreadyExists = S.pdfs.some(p => p.folder_id === targetFolderId && (p.id === trueId || p.linked_pdf_id === trueId));
    if (alreadyExists) {
      toast('A copy or shortcut of this PDF is already in the selected folder!');
      return;
    }
    
    try {
      import('./ui.js').then(m => m.autosave('saving'));
      const newRec = await dbRegisterPDF(targetFolderId, _pdfToLink.name, driveId, trueId);
      S.annCounts[newRec.id] = S.annCounts[trueId] || 0;

      // Auto-expand destination folder and ancestors so user immediately sees the new shortcut
      S.expandedFold[targetFolderId] = true;
      let currF = S.folders.find(f => f.id === targetFolderId);
      while (currF && currF.parent_folder_id) {
        S.expandedFold[currF.parent_folder_id] = true;
        currF = S.folders.find(f => f.id === currF.parent_folder_id);
      }
      if (currF?.subject_id) {
        S.collapsedSubj[currF.subject_id] = false;
      }

      renderLibrary();
      import('./ui.js').then(m => {
        m.closeModal('mo-link-pdf');
        m.toast('✓ Shortcut created!');
        m.autosave('saved');
      });
    } catch (e) {
      console.error(e);
      import('./ui.js').then(m => {
        m.toast('Failed to create shortcut');
        m.autosave('err');
      });
    }
  });
  
  // Removed mo-fold-notes listener

  document.getElementById('save-fold').addEventListener('click', async () => {
    const inp = document.getElementById('fold-name');
    const name = inp.value.trim();
    if (!name || !S.newFolderSubjId) return;
    const subjId = S.newFolderSubjId;
    const type = document.querySelector('.ftype-btn.sel')?.dataset.type || 'custom';
    inp.value = '';
    closeModal('mo-fold');
    try {
      const newId = await dbCreateFolder(subjId, name, type);
      S.collapsedSubj[subjId] = false;
      if (newId) S.expandedFold[newId] = true;
      renderLibrary();
      toast('Folder created');
    } catch (e) {
      const { toastError } = await import('./ui.js');
      toastError(e, 'Folder creation failed');
    }
  });

  document.getElementById('fold-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('save-fold')?.click();
    }
  });

  // Save subfolder (nested inside an existing folder)
  document.getElementById('save-subfold').addEventListener('click', async () => {
    const inp = document.getElementById('subfold-name');
    const name = inp.value.trim();
    if (!name || !S.newSubfolderParentId) return;
    const parentId = S.newSubfolderParentId;
    const subjId = S.newFolderSubjId || S.folders.find(f => f.id === parentId)?.subject_id;
    inp.value = '';
    closeModal('mo-subfold');
    try {
      const newId = await dbCreateFolder(subjId, name, 'custom', parentId);
      S.expandedFold[parentId] = true;
      if (newId) S.expandedFold[newId] = true;
      renderLibrary();
      toast('Subfolder created');
    } catch (e) {
      const { toastError } = await import('./ui.js');
      toastError(e, 'Subfolder creation failed');
    }
  });

  document.getElementById('subfold-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('save-subfold')?.click();
    }
  });

  // PDF upload via Drive
  document.getElementById('pdf-file-in').addEventListener('change', async function () {
    // Snapshot the target folder immediately — before any await — so a second upload
    // triggered while this one is in-flight cannot overwrite S.uploadFolderId on us.
    const targetFolderId = S.uploadFolderId;
    if (!this.files || this.files.length === 0 || !targetFolderId) return;
    try {
      const files = Array.from(this.files);

      // ── Duplicate detection (including re-downloads with (1), (2), etc.) ──
      const duplicatesInSameFolder = [];
      const duplicatesInOtherFolders = [];
      const newFiles = [];

      for (const f of files) {
        const cleanName = f.name.toLowerCase().trim();

        // 1. Exact match first
        let match = S.pdfs.find(p => p.name.toLowerCase().trim() === cleanName);

        // 2. If no exact match, detect substantial matches (e.g. re-downloads like "People v. Santos (1).pdf")
        if (!match) {
          const normUpload = normalizePdfName(f.name);
          if (normUpload) {
            const candidates = S.pdfs.filter(p => normalizePdfName(p.name) === normUpload);
            if (candidates.length > 0) {
              // Priority:
              // a) A match in the target folder if one exists
              // b) A master PDF (!linked_pdf_id)
              // c) First match found
              match = candidates.find(p => p.folder_id === targetFolderId)
                   || candidates.find(p => !p.linked_pdf_id)
                   || candidates[0];
            }
          }
        }

        if (!match) {
          newFiles.push(f);
        } else if (match.folder_id === targetFolderId) {
          duplicatesInSameFolder.push({ file: f, match });
        } else {
          duplicatesInOtherFolders.push({ file: f, match });
        }
      }

      // If all selected files are already in this exact folder
      if (duplicatesInSameFolder.length > 0 && duplicatesInOtherFolders.length === 0 && newFiles.length === 0) {
        const names = duplicatesInSameFolder.map(d => {
          const isExact = d.file.name.toLowerCase().trim() === d.match.name.toLowerCase().trim();
          return isExact ? `• ${d.file.name}` : `• ${d.file.name} (matches "${d.match.name}")`;
        }).join('\n');
        toast(`Already in this folder:\n${names}`);
        this.value = '';
        return;
      }

      const shortcutsToCreate = [];
      const filesToUpload = [...newFiles];

      // If files exist in another folder in the library
      if (duplicatesInOtherFolders.length > 0) {
        const choice = await promptDuplicateResolution(duplicatesInOtherFolders);
        if (choice === 'SHORTCUT') {
          shortcutsToCreate.push(...duplicatesInOtherFolders);
        } else if (choice === 'COPY') {
          for (const d of duplicatesInOtherFolders) {
            filesToUpload.push(d.file);
          }
        } else {
          // User chose Cancel
          if (newFiles.length === 0) {
            this.value = '';
            return;
          }
        }
      }

      let lastRec = null;
      let shortcutCount = 0;
      let uploadCount = 0;

      // 1. Create shortcuts (instant, 0 extra Google Drive storage used)
      for (const item of shortcutsToCreate) {
        const trueId = item.match.linked_pdf_id || item.match.id;
        const driveId = item.match.drive_file_id || (S.pdfs.find(p => p.id === trueId)?.drive_file_id);
        lastRec = await dbRegisterPDF(targetFolderId, item.match.name, driveId, trueId);
        S.annCounts[lastRec.id] = S.annCounts[trueId] || 0;
        shortcutCount++;
      }

      // 2. Upload any brand new files or independent duplicate copies
      if (filesToUpload.length > 0) {
        toast(`Uploading ${filesToUpload.length} PDF${filesToUpload.length > 1 ? 's' : ''}…`);

        // ── Resolve full Drive folder hierarchy (Legal Annotator / Subject / Folder / Subfolder / ...) ──
        let driveFolderId = null;
        try {
          driveFolderId = await driveResolveFolderPath(targetFolderId);
        } catch (e) {
          console.warn('Could not resolve Drive subfolder path, uploading to root:', e);
        }

        for (const file of filesToUpload) {
          // Upload to Drive (inside the resolved subject/folder/subfolder path)
          const driveFile = await driveUploadPDF(file, driveFolderId);
          // Register in Supabase
          lastRec = await dbRegisterPDF(targetFolderId, file.name, driveFile.id);
          S.annCounts[lastRec.id] = 0;
          uploadCount++;
        }
      }

      renderLibrary();

      // Feedback toast
      if (shortcutCount > 0 && uploadCount > 0) {
        toast(`✓ Uploaded ${uploadCount} PDF${uploadCount > 1 ? 's' : ''} and created ${shortcutCount} shortcut${shortcutCount > 1 ? 's' : ''}!`);
      } else if (shortcutCount > 0) {
        toast(`🔗 Created ${shortcutCount} shortcut${shortcutCount > 1 ? 's' : ''}!`);
      } else if (uploadCount > 0) {
        toast('Upload complete!');
      }

      // If user uploaded or shortcutted a single file, open it automatically
      if ((shortcutCount + uploadCount === 1) && lastRec) {
        await openPDFFromLibrary(lastRec);
      }
    } catch (e) {
      console.error('[Upload Error]', e);
      const { toastError, recordError } = await import('./ui.js');
      const msg = e.message || '';
      let tip = '';
      if (msg.includes('signed') || msg.includes('Drive') || msg.includes('token')) {
        tip = 'Sign in to Google Drive first (button is in the sidebar)!';
      } else if (msg.includes('401') || msg.includes('403')) {
        tip = 'Google auth expired [401] — sign out and sign in again.';
      } else if (msg.includes('quota')) {
        tip = 'Google Drive is full [403 quota exceeded]!';
      } else if (msg.includes('drive_file_id') || msg.includes('column')) {
        tip = 'DB error [Column Missing]: run the SQL migration in Supabase';
      }
      if (tip) {
        recordError(e, 'Upload');
        toast(`⚠️ ${tip}`);
      } else {
        toastError(e, 'Upload failed');
      }
    }
    this.value = '';
  });

  // Default Opening Page Modal wiring
  document.getElementById('btn-save-default-page')?.addEventListener('click', async () => {
    if (!_pdfForDefaultPage) return;
    const inp = document.getElementById('inp-default-page-num');
    const val = parseInt(inp?.value?.trim() || '');
    if (!val || isNaN(val) || val < 1) {
      toast('Please enter a valid page number (1 or greater)');
      return;
    }

    const pdf = _pdfForDefaultPage;
    const trueId = pdf.linked_pdf_id || pdf.id;

    safeStorageSet('default_page_' + pdf.id, val);
    if (pdf.folder_id) safeStorageSet('default_page_f_' + pdf.folder_id + '_' + trueId, val);

    dbSetSetting('default_page_' + pdf.id, String(val)).catch(() => {});
    if (pdf.folder_id) dbSetSetting('default_page_f_' + pdf.folder_id + '_' + trueId, String(val)).catch(() => {});

    closeModal('mo-default-page');
    renderLibrary();

    const folder = S.folders.find(f => f.id === pdf.folder_id);
    const folderName = folder ? folder.name : 'folder';
    toast(`Default opening page set to ${val} for "${folderName}"`);

    // If this PDF is already open in the viewer, jump to the newly set page immediately
    if (S.curPDF && (S.curPDF.id === pdf.id || S.curPDF.id === trueId || S.curPDF.linked_pdf_id === trueId)) {
      const { jumpToPage } = await import('./ui.js');
      jumpToPage(val);
    }
  });

  document.getElementById('btn-clear-default-page')?.addEventListener('click', async () => {
    if (!_pdfForDefaultPage) return;
    const pdf = _pdfForDefaultPage;
    const trueId = pdf.linked_pdf_id || pdf.id;

    safeStorageRemove('default_page_' + pdf.id);
    if (pdf.folder_id) safeStorageRemove('default_page_f_' + pdf.folder_id + '_' + trueId);

    dbSetSetting('default_page_' + pdf.id, '').catch(() => {});
    if (pdf.folder_id) dbSetSetting('default_page_f_' + pdf.folder_id + '_' + trueId, '').catch(() => {});

    closeModal('mo-default-page');
    renderLibrary();

    const folder = S.folders.find(f => f.id === pdf.folder_id);
    const folderName = folder ? folder.name : 'folder';
    toast(`Reset to automatic last-read resume for "${folderName}"`);
  });

  document.getElementById('inp-default-page-num')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('btn-save-default-page')?.click();
    }
  });
}

// ── Open Set Default Opening Page Modal ──
let _pdfForDefaultPage = null;

export function openDefaultPageModal(pdf) {
  if (!pdf) return;
  _pdfForDefaultPage = pdf;

  const trueId = pdf.linked_pdf_id || pdf.id;
  const folder = S.folders.find(f => f.id === pdf.folder_id);
  const folderName = folder ? folder.name : 'Root Library';

  const nameEl = document.getElementById('def-page-pdf-name');
  const folderEl = document.getElementById('def-page-folder-name');
  const statusEl = document.getElementById('def-page-current-status');
  const inputEl = document.getElementById('inp-default-page-num');
  const curPageBtn = document.getElementById('btn-use-cur-page');
  const clearBtn = document.getElementById('btn-clear-default-page');

  if (nameEl) nameEl.textContent = pdf.name;
  if (folderEl) folderEl.textContent = `📁 Folder: ${folderName}`;

  const currentVal = safeStorageGet('default_page_' + pdf.id)
    || (pdf.folder_id ? safeStorageGet('default_page_f_' + pdf.folder_id + '_' + trueId) : null);

  if (currentVal) {
    if (statusEl) statusEl.textContent = `Currently set to: Page ${currentVal} (Overrides last-read)`;
    if (inputEl) inputEl.value = currentVal;
    if (clearBtn) clearBtn.style.display = 'inline-block';
  } else {
    if (statusEl) statusEl.textContent = 'Currently: Automatic (resumes where you last left reading)';
    if (inputEl) inputEl.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
  }

  // Check if this PDF is currently open in the viewer
  const isThisOpen = S.curPDF && (S.curPDF.id === pdf.id || S.curPDF.id === trueId || S.curPDF.linked_pdf_id === trueId);
  if (curPageBtn) {
    if (isThisOpen && S.curPage) {
      curPageBtn.style.display = 'inline-block';
      curPageBtn.textContent = `Use Current Page (${S.curPage})`;
      curPageBtn.onclick = () => { if (inputEl) inputEl.value = S.curPage; };
    } else {
      curPageBtn.style.display = 'none';
    }
  }

  openModal('mo-default-page');
  setTimeout(() => { if (inputEl) { inputEl.focus(); inputEl.select(); } }, 50);
}

// ── Open Link PDF (Create Shortcut) Modal with structured folder tree ──
export function openLinkPdfModal(pdf) {
  if (!pdf) return;
  _pdfToLink = pdf;

  const modal = document.getElementById('mo-link-pdf');
  const srcNameEl = document.getElementById('link-pdf-source-name');
  const searchInput = document.getElementById('link-folder-search');
  const treeContainer = document.getElementById('link-folder-tree');
  const previewEl = document.getElementById('link-target-path-preview');
  const hiddenInput = document.getElementById('link-target-folder');
  const confirmBtn = document.getElementById('confirm-link-pdf');

  if (!modal || !treeContainer) return;

  // Display source PDF name
  if (srcNameEl) srcNameEl.textContent = pdf.name;

  // Reset selection and inputs
  if (searchInput) searchInput.value = '';
  if (hiddenInput) hiddenInput.value = '';
  if (previewEl) {
    previewEl.textContent = 'Select a folder above…';
    previewEl.style.color = 'var(--gold)';
  }
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.style.opacity = '0.45';
    confirmBtn.style.cursor = 'not-allowed';
  }

  const icons = { codal: '📜', cases: '⚖', laws: '📋', others: '📁', custom: '📂' };

  if (!S.folders.length) {
    treeContainer.innerHTML = '<div class="lft-empty">No folders found in your library.<br>Create a folder first before creating shortcuts.</div>';
    import('./ui.js').then(m => m.openModal('mo-link-pdf'));
    return;
  }

  treeContainer.innerHTML = '';

  // Breadcrumb path helper
  function getFolderPath(folder) {
    const parts = [folder.name];
    let curr = folder;
    let depth = 0;
    while (curr.parent_folder_id && depth < 10) {
      const parent = S.folders.find(f => f.id === curr.parent_folder_id);
      if (!parent) break;
      parts.unshift(parent.name);
      curr = parent;
      depth++;
    }
    const subject = S.subjects.find(s => s.id === folder.subject_id);
    if (subject) parts.unshift(subject.name);
    return parts.join(' > ');
  }

  let selectedRowEl = null;

  function selectFolder(folder, rowEl) {
    if (folder.id === pdf.folder_id) {
      import('./ui.js').then(m => m.toast('This file is already in this folder.'));
      return;
    }

    if (selectedRowEl) selectedRowEl.classList.remove('selected');
    selectedRowEl = rowEl;
    rowEl.classList.add('selected');

    if (hiddenInput) hiddenInput.value = folder.id;
    if (previewEl) {
      previewEl.textContent = getFolderPath(folder);
      previewEl.style.color = '#fff';
    }
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.style.opacity = '1';
      confirmBtn.style.cursor = 'pointer';
    }
  }

  let totalSelectable = 0;

  // Build tree matching left sidebar
  S.subjects.forEach(subj => {
    const subjFolders = S.folders.filter(f => f.subject_id === subj.id);
    if (!subjFolders.length) return;

    const subjEl = document.createElement('div');
    subjEl.className = 'lft-subj';

    const subjHd = document.createElement('div');
    subjHd.className = 'lft-subj-hd';
    subjHd.innerHTML = `
      <span class="lft-chev">▼</span>
      <span class="lft-dot" style="background:${subj.hex_color || '#c9a84c'}"></span>
      <span class="lft-subj-name" title="${subj.name.replace(/"/g, '&quot;')}">${subj.name}</span>
      <span class="lft-count">${subjFolders.length} folder${subjFolders.length === 1 ? '' : 's'}</span>
    `;

    const subjCh = document.createElement('div');
    subjCh.className = 'lft-subj-ch';

    subjHd.addEventListener('click', () => {
      const chev = subjHd.querySelector('.lft-chev');
      const isClosed = chev.classList.toggle('closed');
      subjCh.style.display = isClosed ? 'none' : 'flex';
    });

    subjEl.appendChild(subjHd);
    subjEl.appendChild(subjCh);

    // Root folders for this subject
    const rootFolds = subjFolders
      .filter(f => !f.parent_folder_id)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));

    function buildFolderNode(folder) {
      const foldEl = document.createElement('div');
      foldEl.className = 'lft-fold';
      foldEl.dataset.folderId = folder.id;
      foldEl.dataset.folderName = folder.name.toLowerCase();

      const childFolds = S.folders
        .filter(f => f.parent_folder_id === folder.id)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));

      const hasChildren = childFolds.length > 0;
      const isCurrent = folder.id === pdf.folder_id;
      if (!isCurrent) totalSelectable++;

      const row = document.createElement('div');
      row.className = 'lft-fold-row' + (isCurrent ? ' current' : '');
      row.title = isCurrent ? 'Current location of this PDF' : `Place shortcut in: ${getFolderPath(folder)}`;

      row.innerHTML = `
        <span class="lft-chev" style="${hasChildren ? '' : 'visibility:hidden; width:12px'}">▼</span>
        <span class="lft-fold-icon">${icons[folder.folder_type] || '📁'}</span>
        <span class="lft-fold-name">${folder.name}</span>
        ${isCurrent ? '<span class="lft-badge-current">Current</span>' : ''}
      `;

      let childContainer = null;
      if (hasChildren) {
        childContainer = document.createElement('div');
        childContainer.className = 'lft-fold-ch';

        childFolds.forEach(cf => {
          childContainer.appendChild(buildFolderNode(cf));
        });
      }

      // Chevron click toggles child subfolders
      const chevEl = row.querySelector('.lft-chev');
      if (hasChildren && chevEl) {
        chevEl.addEventListener('click', e => {
          e.stopPropagation();
          const closed = chevEl.classList.toggle('closed');
          childContainer.style.display = closed ? 'none' : 'flex';
        });
      }

      // Click selects folder
      row.addEventListener('click', e => {
        if (e.target === chevEl && hasChildren) return;
        selectFolder(folder, row);
      });

      // Double-click selects and immediately submits
      row.addEventListener('dblclick', e => {
        if (isCurrent) return;
        selectFolder(folder, row);
        confirmBtn?.click();
      });

      foldEl.appendChild(row);
      if (childContainer) foldEl.appendChild(childContainer);

      return foldEl;
    }

    rootFolds.forEach(rf => {
      subjCh.appendChild(buildFolderNode(rf));
    });

    treeContainer.appendChild(subjEl);
  });

  if (totalSelectable === 0) {
    treeContainer.innerHTML = '<div class="lft-empty">No other folders available to place a shortcut into.<br>Create another folder first.</div>';
  }

  // Filter search handling
  if (searchInput) {
    searchInput.oninput = () => {
      const q = searchInput.value.toLowerCase().trim();
      const allSubjs = treeContainer.querySelectorAll('.lft-subj');

      if (!q) {
        // Reset view
        allSubjs.forEach(s => {
          s.style.display = 'block';
          s.querySelector('.lft-subj-ch').style.display = 'flex';
          s.querySelector('.lft-chev')?.classList.remove('closed');
          s.querySelectorAll('.lft-fold').forEach(f => {
            f.style.display = 'flex';
            const ch = f.querySelector('.lft-fold-ch');
            if (ch) ch.style.display = 'flex';
            f.querySelector('.lft-chev')?.classList.remove('closed');
          });
        });
        return;
      }

      // Match folders against query
      allSubjs.forEach(s => {
        const foldNodes = s.querySelectorAll('.lft-fold');
        let subjHasMatch = false;

        foldNodes.forEach(fn => {
          const name = fn.dataset.folderName || '';
          const matches = name.includes(q);

          if (matches) {
            subjHasMatch = true;
            fn.style.display = 'flex';
            let parent = fn.parentElement;
            while (parent && parent !== s) {
              if (parent.classList.contains('lft-fold') || parent.classList.contains('lft-fold-ch') || parent.classList.contains('lft-subj-ch')) {
                parent.style.display = 'flex';
              }
              parent = parent.parentElement;
            }
          } else {
            const hasMatchingChild = Array.from(fn.querySelectorAll('.lft-fold')).some(child =>
              (child.dataset.folderName || '').includes(q)
            );
            if (hasMatchingChild) {
              subjHasMatch = true;
              fn.style.display = 'flex';
              const ch = fn.querySelector('.lft-fold-ch');
              if (ch) ch.style.display = 'flex';
            } else {
              fn.style.display = 'none';
            }
          }
        });

        s.style.display = subjHasMatch ? 'block' : 'none';
        if (subjHasMatch) {
          s.querySelector('.lft-subj-ch').style.display = 'flex';
          s.querySelector('.lft-chev')?.classList.remove('closed');
        }
      });
    };

    // Press Enter to submit if a folder is selected or single folder matches
    searchInput.onkeydown = e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (confirmBtn && !confirmBtn.disabled) {
          confirmBtn.click();
        } else {
          // If 1 visible non-current folder matches, auto-select it
          const visibleRows = Array.from(treeContainer.querySelectorAll('.lft-fold-row:not(.current)'))
            .filter(r => r.offsetParent !== null);
          if (visibleRows.length === 1) {
            visibleRows[0].click();
            confirmBtn?.click();
          }
        }
      }
    };
  }

  import('./ui.js').then(m => m.openModal('mo-link-pdf'));
  setTimeout(() => searchInput?.focus(), 80);
}

export function openNewFolderModal(id) {
  S.newFolderSubjId = id;
  const inp = document.getElementById('fold-name');
  if (inp) {
    inp.value = '';
    setTimeout(() => inp.focus(), 50);
  }
  openModal('mo-fold');
}

export function openNewSubfolderModal(folderId, subjId) {
  S.newSubfolderParentId = folderId;
  S.newFolderSubjId = subjId || S.folders.find(f => f.id === folderId)?.subject_id;
  const inp = document.getElementById('subfold-name');
  if (inp) {
    inp.value = '';
    setTimeout(() => inp.focus(), 50);
  }
  openModal('mo-subfold');
}

export function triggerPDFUpload(fid) {
  S.uploadFolderId = fid;
  document.getElementById('pdf-file-in').click();
}

// ── Marquee Selection ──
export function initLibrarySelection() {
  const tree = document.getElementById('lib-tree');
  let isDragging = false;
  let startX = 0, startY = 0;
  let marquee = null;

  tree.addEventListener('pointerdown', e => {
    // Only start marquee if clicking directly on the empty background, NOT on an item
    if (e.target.closest('.li-subj-hd') || e.target.closest('.li-fold-hd') || e.target.closest('.li-pdf') || e.target.closest('.li-acts')) return;
    
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      S.selectedIds.clear();
      updateSelectionUI();
    }

    marquee = document.createElement('div');
    marquee.className = 'selection-marquee';
    document.body.appendChild(marquee);
    updateMarquee(e.clientX, e.clientY);
  });

  document.addEventListener('pointermove', e => {
    if (!isDragging || !marquee) return;
    updateMarquee(e.clientX, e.clientY);
    
    // Calculate intersections
    const rect = marquee.getBoundingClientRect();
    const items = tree.querySelectorAll('.li-fold, .li-pdf');
    items.forEach(item => {
      const itemRect = item.getBoundingClientRect();
      const intersect = !(
        rect.right < itemRect.left || 
        rect.left > itemRect.right || 
        rect.bottom < itemRect.top || 
        rect.top > itemRect.bottom
      );
      
      const id = item.dataset.id;
      if (intersect) {
        S.selectedIds.add(id);
        S.lastSelectedId = id;
      } else if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
        S.selectedIds.delete(id);
      }
    });
    updateSelectionUI();
  });

  document.addEventListener('pointerup', () => {
    isDragging = false;
    if (marquee) {
      marquee.remove();
      marquee = null;
    }
  });

  function updateMarquee(endX, endY) {
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(startX - endX);
    const height = Math.abs(startY - endY);
    marquee.style.left = left + 'px';
    marquee.style.top = top + 'px';
    marquee.style.height = height + 'px';
  }
}

// ── Undo functionality ──
export function snapshotMove() {
  const snap = {
    folders: S.folders.map(f => ({ id: f.id, sort_order: f.sort_order, parent_folder_id: f.parent_folder_id, subject_id: f.subject_id })),
    pdfs: S.pdfs.map(p => ({ id: p.id, sort_order: p.sort_order, folder_id: p.folder_id }))
  };
  S.undoStack.push(snap);
}

window.undoLastMove = async function() {
  if (!S.undoStack || S.undoStack.length === 0) {
    toast('Nothing to undo');
    return;
  }
  const snap = S.undoStack.pop();
  let changed = false;
  
  for (const sf of snap.folders) {
    const f = S.folders.find(x => x.id === sf.id);
    if (f && (f.sort_order !== sf.sort_order || f.parent_folder_id !== sf.parent_folder_id || f.subject_id !== sf.subject_id)) {
      f.sort_order = sf.sort_order;
      f.parent_folder_id = sf.parent_folder_id;
      f.subject_id = sf.subject_id;
      // We don't need to await each to update DB fast
      import('./db.js').then(db => {
        db.db.from('folders').update({ sort_order: sf.sort_order, parent_folder_id: sf.parent_folder_id, subject_id: sf.subject_id }).eq('id', sf.id).catch(()=>{});
      });
      changed = true;
    }
  }
  
  for (const sp of snap.pdfs) {
    const p = S.pdfs.find(x => x.id === sp.id);
    if (p && (p.sort_order !== sp.sort_order || p.folder_id !== sp.folder_id)) {
      p.sort_order = sp.sort_order;
      p.folder_id = sp.folder_id;
      import('./db.js').then(db => {
        db.db.from('pdf_files').update({ sort_order: sp.sort_order, folder_id: sp.folder_id }).eq('id', sp.id).catch(()=>{});
      });
      changed = true;
    }
  }
  
  if (changed) {
    renderLibrary();
    scheduleDriveOrganize(1000);
    toast('Undo successful');
  } else {
    toast('Nothing to undo');
  }
};

window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    // Check if user is typing in an input/textarea
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    e.preventDefault();
    window.undoLastMove();
  }
});

// ── Smart Refresh & Hard Reload ──
export async function forceHardReload() {
  try {
    toast('Purging cache & reloading…');
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        await reg.unregister();
      }
    }
  } catch (err) {
    console.warn('[forceHardReload] cache purge notice:', err);
  }
  const url = new URL(window.location.href);
  url.searchParams.set('_reload', Date.now().toString());
  window.location.href = url.toString();
}

let _isRefreshing = false;
export async function smartRefresh(e, forceHard = false) {
  if (forceHard || (e && (e.shiftKey || e.altKey))) {
    return forceHardReload();
  }

  if (_isRefreshing) return;
  _isRefreshing = true;

  const btn = document.getElementById('refresh-btn');
  if (btn) {
    btn.classList.add('spinning');
    btn.setAttribute('aria-busy', 'true');
  }

  const startTime = Date.now();
  try {
    syncSpin('Syncing library…');

    // Trigger background Service Worker update check
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then(reg => {
        if (reg) reg.update().catch(() => {});
      }).catch(() => {});
    }

    // Re-fetch subjects, folders, PDFs, and categories from Supabase
    await dbLoad();
    await dbLoadAnnCounts();
    renderLibrary();

    // If an active PDF is currently open, quietly sync its annotations/drawings/bookmarks in background
    if (S.curPDF) {
      try {
        const trueId = S.curPDF.linked_pdf_id || S.curPDF.id;
        const { dbLoadAnnotations, dbLoadBookmarks, dbLoadDrawings } = await import('./db.js');
        await Promise.all([
          dbLoadAnnotations(trueId),
          dbLoadBookmarks(trueId),
          dbLoadDrawings(trueId)
        ]);
        if (typeof window.renderAnnotations === 'function') window.renderAnnotations();
        if (typeof window.renderBookmarks === 'function') window.renderBookmarks();
      } catch (pdfErr) {
        console.warn('[smartRefresh] active PDF sync skipped:', pdfErr);
      }
    }

    syncOK('Synced');
    toast('Library synced ✓');
  } catch (err) {
    console.error('[smartRefresh] Error syncing library:', err);
    syncErr('Sync failed');
    toast('Sync error: ' + (err.message || 'Check network connection'));
  } finally {
    // Keep spin animation visible for at least 450ms for positive visual confirmation
    const elapsed = Date.now() - startTime;
    const remainingDelay = Math.max(0, 450 - elapsed);
    setTimeout(() => {
      if (btn) {
        btn.classList.remove('spinning');
        btn.removeAttribute('aria-busy');
      }
      _isRefreshing = false;
    }, remainingDelay);
  }
}

export function initRefreshButton() {
  const btn = document.getElementById('refresh-btn');
  if (!btn) return;

  // Expose globally so external scripts or fallbacks can invoke it
  window.smartRefresh = smartRefresh;
  window.forceHardReload = forceHardReload;

  let pressTimer = null;
  let startX = 0, startY = 0;
  let didLongPress = false;

  btn.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    didLongPress = false;

    clearTimeout(pressTimer);
    // Long press on touch / trackpad (650ms) triggers hard reload prompt
    pressTimer = setTimeout(() => {
      didLongPress = true;
      if (confirm('Hard Reload App?\n\nThis will purge cached assets and reload the latest version from the server.')) {
        forceHardReload();
      }
    }, 650);
  });

  btn.addEventListener('pointermove', e => {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) {
      clearTimeout(pressTimer);
    }
  });

  btn.addEventListener('pointerup', () => {
    clearTimeout(pressTimer);
  });

  btn.addEventListener('pointercancel', () => {
    clearTimeout(pressTimer);
  });

  btn.addEventListener('click', e => {
    e.preventDefault();
    if (didLongPress) {
      didLongPress = false;
      return;
    }
    smartRefresh(e);
  });

  // Right-click: provide option to hard reload & purge cache
  btn.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (confirm('Hard Reload & Purge Shell Cache?\n\nUse this if updates from GitHub are not appearing.')) {
      forceHardReload();
    }
  });
}

