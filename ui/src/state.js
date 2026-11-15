// ═══════════════════════════════════════════════
// STATE — single source of truth for entire app
// ═══════════════════════════════════════════════
function _loadInitialArchivedSubjects() {
  try {
    if (typeof localStorage === 'undefined') return new Set();
    const raw = localStorage.getItem('archived_subjects_v1');
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string' && id) : []);
  } catch {
    return new Set();
  }
}

export const S = {
  // Library data (from Supabase)
  subjects:    [],
  folders:     [],
  pdfs:        [],
  bookmarks:   [],
  colorCats:   [],

  // Archived subject IDs (non-destructive visibility filter)
  archivedSubjects: _loadInitialArchivedSubjects(),

  // Multi-selection in library
  selectedIds: new Set(),
  lastSelectedId: null,

  // Current open PDF
  curPDF:      null,
  pdfDoc:      null,
  scale:       1.5,
  totalPages:  0,
  curPage:     1,

  // Rendered pages: pageNum → { wrap, pdfCanvas, drawCanvas, txtLayer, annOv, srchOv, textItems, viewport }
  pages: {},

  // Annotations for current PDF; each has .notes[]
  annotations: [],
  selAnn:      null,

  // Freehand drawing data: pageNum → [strokes]
  drawData:    {},
  isDrawing:   false,
  curPts:      [],

  // Interaction mode
  mode:        'text',   // 'text' | 'box' | 'draw'
  drawTool:    'pen',    // 'pen' | 'erase'
  activeColor: '#c9a84c',
  drawWidth:   2,

  // Pending text selection before confirm
  pendingSel:  null,
  pendingEditorSel: null,

  // Upload / folder target
  uploadFolderId:      null,
  newFolderSubjId:     null,
  newSubfolderParentId: null,  // for creating a subfolder inside a folder

  // Note editing
  editingNoteId: null,

  // PDF bytes cache: drive_file_id → ArrayBuffer
  pdfCache: {},

  // UI collapse state
  collapsedSubj: {},
  expandedFold: {},
  
  // Organization Undo Stack
  undoStack: [],

  // Search
  searchMode:    'pdf',  // 'pdf' | 'ann'
  searchResults: [],     // pdf text results
  searchIdx:     0,

  // Google Drive auth
  driveToken:    null,
  driveUser:     null,
  driveFolderId: null,   // ID of "Legal Annotator" folder in Drive

  // Recent PDFs: [{ id, name, drive_file_id }] last 5
  recentPDFs: [],

  // Annotation counts cache: pdf_id → count
  annCounts: {},

  // Case Digest presence cache: pdf_id → boolean
  digestMap: {},
  
  // Toolbar links
  links: [],
};

// ── Archived Subject Helpers (non-destructive visibility checks) ──
export function isSubjectArchived(subjId) {
  return Boolean(subjId && S.archivedSubjects?.has(subjId));
}

export function getSubjectIdForFolder(folderId) {
  if (!folderId) return null;
  const visited = new Set();
  let currId = folderId;
  while (currId) {
    if (visited.has(currId)) return null;
    visited.add(currId);
    const folder = (S.folders || []).find(f => f.id === currId);
    if (!folder) return null;
    if (folder.subject_id) return folder.subject_id;
    currId = folder.parent_folder_id || null;
  }
  return null;
}

export function isFolderArchived(folderId) {
  return isSubjectArchived(getSubjectIdForFolder(folderId));
}

export function isPdfArchived(pdfOrId) {
  if (!pdfOrId) return false;
  const pdf = typeof pdfOrId === 'string'
    ? (S.pdfs || []).find(p => p.id === pdfOrId)
    : pdfOrId;
  if (!pdf) return false;
  if (pdf.folder_id) {
    const subjId = getSubjectIdForFolder(pdf.folder_id);
    if (subjId) return isSubjectArchived(subjId);
  }
  if (pdf.subject_id) return isSubjectArchived(pdf.subject_id);
  return false;
}

export function getVisibleSubjects() {
  return (S.subjects || []).filter(s => !isSubjectArchived(s.id));
}

export function getArchivedSubjects() {
  return (S.subjects || []).filter(s => isSubjectArchived(s.id));
}
