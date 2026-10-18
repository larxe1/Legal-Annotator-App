// ═══════════════════════════════════════════════
// STATE — single source of truth for entire app
// ═══════════════════════════════════════════════
export const S = {
  // Library data (from Supabase)
  subjects:    [],
  folders:     [],
  pdfs:        [],
  bookmarks:   [],
  colorCats:   [],

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
  
  // Toolbar links
  links: [],
};
