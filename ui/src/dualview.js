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
let _paneBGen = 0;

// Open a PDF in Pane B (reference/read-only)
export async function openPDFInPaneB(pdfFile) {
  if (PB.pdfFile?.id === pdfFile.id && Object.keys(PB.pages).length > 0) {
    toast('Already open as reference.');
    return;
  }

  const myGen = ++_paneBGen;
  PB.pdfFile = pdfFile;
  PB.pages   = {};

  const scroll = document.getElementById('canvas-scroll-b');
  scroll.innerHTML = '<div class="spin-w"><div class="spinner"></div>Loading reference...</div>';

  _enterDualView(pdfFile.name);

  const trueId = pdfFile.linked_pdf_id || pdfFile.id;
  const targetDriveId = pdfFile.drive_file_id || S.pdfs.find(p => p.id === pdfFile.linked_pdf_id)?.drive_file_id;
  if (!targetDriveId && !pdfFile._localBlob) {
    scroll.innerHTML = '<div style="color:var(--red);padding:20px;font-size:13px">Could not find Google Drive file for this PDF.<br><br><button onclick="document.getElementById(\'btn-close-pane-b\').click()" style="padding:6px 12px;background:var(--navy-l);border:1px solid var(--navy-b);color:var(--text);border-radius:6px;cursor:pointer">Close</button></div>';
    return;
  }

  try {
    let blob;
    if (pdfFile._localBlob) {
      blob = pdfFile._localBlob;
    } else {
      blob = await driveFetchPDF(targetDriveId, (pct, loadedMB, totalMB) => {
        if (scroll && myGen === _paneBGen) {
          if (pct !== null) {
            scroll.innerHTML = `<div class="spin-w"><div class="spinner"></div>Loading reference: ${pct}% (${loadedMB}/${totalMB} MB)</div>`;
          } else {
            scroll.innerHTML = `<div class="spin-w"><div class="spinner"></div>Loading reference: ${loadedMB} MB…</div>`;
          }
        }
      }, pdfFile.name);
    }

    if (myGen !== _paneBGen) return;

    const buf = await blob.arrayBuffer();
    if (window.__DESKTOP_PDFIUM__ && trueId) {
      await window.__DESKTOP_PDFIUM__.openPdf(trueId, buf, pdfFile._localPath || null).catch(() => {});
    }

    const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
    PB.pdfDoc     = await pdfjsLib.getDocument({ url: blobUrl, disableAutoFetch: false, disableStream: false }).promise;
    PB.totalPages = PB.pdfDoc.numPages;
    PB.scale      = S.scale;

    if (myGen !== _paneBGen) return;

    // Sample page 1 & page 2 dimensions so placeholders never jump on scroll
    const firstPage = await PB.pdfDoc.getPage(1);
    const vp1 = firstPage.getViewport({ scale: PB.scale });
    let bodyVp = vp1;
    if (PB.totalPages >= 2) {
      try {
        const secondPage = await PB.pdfDoc.getPage(2);
        bodyVp = secondPage.getViewport({ scale: PB.scale });
      } catch {}
    }

    scroll.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let p = 1; p <= PB.totalPages; p++) {
      const defVp = p === 1 ? vp1 : bodyVp;
      const wrap = document.createElement('div');
      wrap.className = 'pg-wrap';
      wrap.dataset.page = p;
      wrap.style.width  = defVp.width  + 'px';
      wrap.style.height = defVp.height + 'px';
      wrap.innerHTML = `<div class="pg-placeholder" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;">Page ${p}</div>`;
      frag.appendChild(wrap);
      PB.pages[p] = { wrap, viewport: defVp, rendered: false, rendering: false };
    }
    scroll.appendChild(frag);

    // Render pages 1..3 immediately
    const initialBatch = [];
    for (let p = 1; p <= Math.min(3, PB.totalPages); p++) {
      initialBatch.push(renderPageInto(p, scroll, PB.pdfDoc, PB));
    }
    await Promise.all(initialBatch);
    syncOK('Reference loaded');

    // Render remaining pages in 4-page parallel batches in background
    (async () => {
      const BATCH = 4;
      for (let p = 4; p <= PB.totalPages; p += BATCH) {
        if (myGen !== _paneBGen || !_isDualView) return;
        const tasks = [];
        for (let k = p; k < p + BATCH && k <= PB.totalPages; k++) {
          if (!PB.pages[k]?.rendered && !PB.pages[k]?.rendering) {
            tasks.push(renderPageInto(k, scroll, PB.pdfDoc, PB));
          }
        }
        if (tasks.length) await Promise.all(tasks);
        await new Promise(r => setTimeout(r, 8));
      }
    })();
  } catch (e) {
    console.error('[DualView] Failed to load reference PDF:', e);
    scroll.innerHTML = '<div style="color:var(--red);padding:20px;font-size:13px">Could not load reference PDF.<br><br><button onclick="document.getElementById(\'btn-close-pane-b\').click()" style="padding:6px 12px;background:var(--navy-l);border:1px solid var(--navy-b);color:var(--text);border-radius:6px;cursor:pointer">Close</button></div>';
  }
}

// Swap panes (A <-> B)
export async function swapPanes() {
  if (!_isDualView || !S.curPDF || !PB.pdfFile) return;
  toast('Swapping panes...');

  const oldA_pdf = S.curPDF;
  const oldB_pdf = PB.pdfFile;

  try {
    const { flushNotepadSave } = await import('./notepad.js');
    await flushNotepadSave();
  } catch {}

  const { openPDFFromLibrary } = await import('./viewer.js');
  PB.pdfFile = null; // Reset so openPDFInPaneB doesn't early-return
  await Promise.all([
    openPDFFromLibrary(oldB_pdf, 0),
    openPDFInPaneB(oldA_pdf),
  ]);

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
