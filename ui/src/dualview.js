// ==============================================
// DUALVIEW -- dual-pane PDF viewing logic
// ==============================================
import { S } from './state.js';
import { driveFetchPDF } from './drive.js';
import { renderPageInto } from './viewer.js';
import { syncOK, toast } from './ui.js';

// -- Pane B state (independent from global S) --
export const PB = {
  pdfFile:    null,
  pdfDoc:     null,
  totalPages: 0,
  scale:      1.5,
  pages:      {},
};

let _isDualView = false;

// Open a PDF in Pane B (reference/read-only)
export async function openPDFInPaneB(pdfFile) {
  if (PB.pdfFile?.id === pdfFile.id) { toast('Already open as reference.'); return; }

  PB.pdfFile = pdfFile;
  PB.pages   = {};

  const scroll = document.getElementById('canvas-scroll-b');
  scroll.innerHTML = '<div class=spin-w><div class=spinner></div>Loading reference...</div>';

  _enterDualView(pdfFile.name);

  const targetDriveId = pdfFile.drive_file_id || S.pdfs.find(p => p.id === pdfFile.linked_pdf_id)?.drive_file_id;
  if (!targetDriveId) {
    scroll.innerHTML = '<div style=color:var(--red);padding:20px;font-size:13px>Could not find Google Drive file for this PDF.<br><br><button onclick=document.getElementById(\'btn-close-pane-b\').click() style=padding:6px 12px;background:var(--navy-l);border:1px solid var(--navy-b);color:var(--text);border-radius:6px;cursor:pointer>Close</button></div>';
    return;
  }

  try {
    const blob = await driveFetchPDF(targetDriveId, (pct, loadedMB, totalMB) => {
      if (scroll) {
        if (pct !== null) {
          scroll.innerHTML = `<div class=spin-w><div class=spinner></div>Loading reference: ${pct}% (${loadedMB}/${totalMB} MB)</div>`;
        } else {
          scroll.innerHTML = `<div class=spin-w><div class=spinner></div>Loading reference: ${loadedMB} MB…</div>`;
        }
      }
    }, pdfFile.name);
    const buf = await blob.arrayBuffer();
    PB.pdfDoc     = await pdfjsLib.getDocument({ data: buf }).promise;
    PB.totalPages = PB.pdfDoc.numPages;
    PB.scale      = S.scale;

    scroll.innerHTML = '';
    for (let p = 1; p <= PB.totalPages; p++) {
      await renderPageInto(p, scroll, PB.pdfDoc, PB);
    }
    syncOK('Reference loaded');
  } catch (e) {
    console.error('[DualView] Failed to load reference PDF:', e);
    scroll.innerHTML = '<div style=color:var(--red);padding:20px;font-size:13px>Could not load reference PDF.<br><br><button onclick=document.getElementById(\'btn-close-pane-b\').click() style=padding:6px 12px;background:var(--navy-l);border:1px solid var(--navy-b);color:var(--text);border-radius:6px;cursor:pointer>Close</button></div>';
  }
}

// Swap panes (A <-> B)
export async function swapPanes() {
  if (!_isDualView || !S.curPDF || !PB.pdfFile) return;
  toast('Swapping panes...');

  const oldA_pdf    = S.curPDF;
  const oldA_pdfDoc = S.pdfDoc;
  const oldA_total  = S.totalPages;
  const oldB_pdf    = PB.pdfFile;
  const oldB_pdfDoc = PB.pdfDoc;
  const oldB_total  = PB.totalPages;

  try {
    const { flushNotepadSave } = await import('./notepad.js');
    await flushNotepadSave();
  } catch {}

  // -- Reload pane A with former pane B content --
  S.curPDF     = oldB_pdf;
  S.pdfDoc     = oldB_pdfDoc;
  S.totalPages = oldB_total;
  S.pages      = {};

  const { updateActivePDF }      = await import('./viewer.js');
  const { renderPage }           = await import('./viewer.js');
  const { notepadOnPDFChange }   = await import('./notepad.js');
  const { dbLoadAnnotations, dbLoadDrawings, dbLoadBookmarks } = await import('./db.js');
  const { redrawAllAnnotations } = await import('./annotate.js');
  const { redrawAllDrawings }    = await import('./draw.js');

  updateActivePDF();
  const trueId = oldB_pdf.linked_pdf_id || oldB_pdf.id;
  await notepadOnPDFChange(trueId);

  document.getElementById('pg-total').textContent = oldB_total;
  document.getElementById('pg-input').value = 1;
  document.getElementById('pg-input').max   = oldB_total;

  const scrollA = document.getElementById('canvas-scroll');
  scrollA.innerHTML = '<div class=spin-w><div class=spinner></div>Swapping...</div>';
  scrollA.innerHTML = '';

  for (let p = 1; p <= S.totalPages; p++) {
    await renderPage(p, scrollA, oldB_pdf.id);
  }
  await dbLoadBookmarks(trueId);
  await dbLoadAnnotations(trueId);
  await dbLoadDrawings(trueId);
  redrawAllAnnotations();
  redrawAllDrawings();

  // -- Reload pane B with former pane A content --
  PB.pdfFile    = oldA_pdf;
  PB.pdfDoc     = oldA_pdfDoc;
  PB.totalPages = oldA_total;
  PB.pages      = {};

  const scrollB = document.getElementById('canvas-scroll-b');
  scrollB.innerHTML = '';
  for (let p = 1; p <= PB.totalPages; p++) {
    await renderPageInto(p, scrollB, PB.pdfDoc, PB);
  }

  document.getElementById('pane-a-name').textContent = oldB_pdf.name;
  document.getElementById('pane-b-name').textContent = oldA_pdf.name;

  syncOK('Swapped');
  toast('Panes swapped');
}

// Enter dual view UI state
function _enterDualView(refPdfName) {
  _isDualView = true;
  document.getElementById('pane-b').style.display         = 'flex';
  document.getElementById('dual-divider').classList.add('active');
  document.getElementById('pane-a-header').style.display  = 'flex';
  document.getElementById('pane-a-name').textContent      = S.curPDF?.name || '';
  document.getElementById('pane-b-name').textContent      = refPdfName;
  document.getElementById('btn-swap-panes').style.display = '';
}

// Exit dual view
export function exitDualView() {
  _isDualView       = false;
  PB.pdfFile        = null;
  PB.pdfDoc         = null;
  PB.totalPages     = 0;
  PB.pages          = {};
  document.getElementById('canvas-scroll-b').innerHTML            = '';
  document.getElementById('pane-b').style.display                 = 'none';
  document.getElementById('dual-divider').classList.remove('active');
  document.getElementById('pane-a-header').style.display          = 'none';
  document.getElementById('btn-swap-panes').style.display         = 'none';
}

export function isDualView() { return _isDualView; }

// Draggable divider
function initDividerDrag() {
  const divider = document.getElementById('dual-divider');
  const paneA   = document.getElementById('pane-a');
  const paneB   = document.getElementById('pane-b');
  const content = document.getElementById('content-area');

  let dragging = false, startX = 0, startAW = 0;

  divider.addEventListener('mousedown', e => {
    if (!_isDualView) return;
    dragging = true;
    startX   = e.clientX;
    startAW  = paneA.getBoundingClientRect().width;
    divider.classList.add('dragging');
    document.body.style.cssText += ';cursor:col-resize;user-select:none;';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const totalW = content.getBoundingClientRect().width - 4;
    const delta  = e.clientX - startX;
    const newAW  = Math.min(Math.max(startAW + delta, 200), totalW - 200);
    paneA.style.flex  = 'none';
    paneA.style.width = newAW + 'px';
    paneB.style.flex  = 'none';
    paneB.style.width = (totalW - newAW) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });
}

// Init -- called from main.js
export function initDualView() {
  initDividerDrag();
  document.getElementById('btn-swap-panes').addEventListener('click', swapPanes);
  document.getElementById('btn-close-pane-b').addEventListener('click', exitDualView);
}
