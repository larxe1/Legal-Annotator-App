// ═══════════════════════════════════════════════
// DRAW — freehand drawing on canvas
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { autosave, toast } from './ui.js';
import { dbSaveDrawings } from './db.js';

const ERASE_COLOR = '__erase__';

export function setupDrawListeners(canvas, pageNum) {
  function getPt(e) {
    const r  = canvas.getBoundingClientRect();
    const sx = canvas.width  / r.width;
    const sy = canvas.height / r.height;
    return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
  }

  // ── Pen mode helpers (inactive unless S.penMode is on; see pen.js) ──
  let activePid = null;
  let pSum = 0, pN = 0;
  const samplePressure = e => {
    if (S.penMode && e.pointerType === 'pen' && e.pressure > 0) { pSum += e.pressure; pN++; }
  };
  // Light press ≈ 0.6× the chosen size, firm press ≈ 1.5× (average over the stroke)
  const pressureMul = () => (S.penMode && pN) ? 0.5 + (pSum / pN) : 1;
  const penWidth = () => Math.max(1, Math.round(S.drawWidth * pressureMul() * 10) / 10);

  canvas.addEventListener('pointerdown', e => {
    if (S.mode !== 'draw') return;
    // Pen mode: only the Pencil draws. Fingers/palms are ignored so they can scroll/zoom.
    if (S.penMode && e.pointerType === 'touch') return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    activePid = e.pointerId;
    pSum = 0; pN = 0;
    samplePressure(e);
    const [x, y] = getPt(e);
    S.curPts = [[x / canvas.width, y / canvas.height]];
    S.isDrawing = true;
  });

  canvas.addEventListener('pointermove', e => {
    if (!S.isDrawing || S.mode !== 'draw') return;
    if (activePid !== null && e.pointerId !== activePid) return;
    e.preventDefault();
    samplePressure(e);
    const [x, y] = getPt(e);
    S.curPts.push([x / canvas.width, y / canvas.height]);
    const previewColor = S.drawTool === 'erase' ? ERASE_COLOR : S.activeColor;
    const previewWidth = S.drawTool === 'erase' ? S.eraseWidth : penWidth();
    renderCanvas(canvas, [
      ...(S.drawData[pageNum] || []),
      { points: S.curPts, color: previewColor, width: previewWidth },
    ]);
  });

  const onEnd = async e => {
    if (e && activePid !== null && e.pointerId !== activePid) return;
    if (!S.isDrawing) return;
    S.isDrawing = false;
    activePid = null;
    if (S.curPts.length >= 2) {
      if (!S.drawData[pageNum]) S.drawData[pageNum] = [];
      const color = S.drawTool === 'erase' ? ERASE_COLOR : S.activeColor;
      const width = S.drawTool === 'erase' ? S.eraseWidth : penWidth();
      S.drawData[pageNum].push({ points: S.curPts, color, width });
      if (S.curPDF) {
        const trueId = S.curPDF.linked_pdf_id || S.curPDF.id;
        autosave('saving');
        try {
          await dbSaveDrawings(trueId, pageNum, S.drawData[pageNum]);
          autosave('saved');
        } catch { autosave('err'); }
      }
    }
    S.curPts = [];
  };

  canvas.addEventListener('pointerup',     onEnd);
  canvas.addEventListener('pointercancel', onEnd);
}

// ── Render strokes — handles erase strokes via destination-out ──
export function renderCanvas(canvas, strokes) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const s of strokes) {
    if (!s.points || s.points.length < 2) continue;
    const pts = s.points.map(([px, py]) => [px * canvas.width, py * canvas.height]);

    const isErase = s.color === ERASE_COLOR;
    ctx.globalCompositeOperation = isErase ? 'destination-out' : 'source-over';

    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    ctx.strokeStyle = isErase ? 'rgba(0,0,0,1)' : (s.color || '#c9a84c');
    ctx.lineWidth   = s.width || 2;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over'; // always reset
}

export function redrawAllDrawings() {
  for (const [pn, pg] of Object.entries(S.pages)) {
    if (pg?.drawCanvas && pg.rendered) {
      renderCanvas(pg.drawCanvas, S.drawData[parseInt(pn)] || []);
    }
  }
}

export function initDrawControls() {
  // ── Eraser toggle ──
  S.eraseWidth = 20; // default eraser size

  document.getElementById('btn-erase').addEventListener('click', () => {
    S.drawTool = S.drawTool === 'erase' ? 'pen' : 'erase';
    updateDrawToolUI();
    toast(S.drawTool === 'erase' ? 'Eraser on' : 'Back to pen');
  });

  // Eraser size buttons
  document.querySelectorAll('.er-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      S.eraseWidth = parseInt(btn.dataset.ew);
      document.querySelectorAll('.er-btn').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
      // Make sure eraser is active when picking size
      if (S.drawTool !== 'erase') {
        S.drawTool = 'erase';
        updateDrawToolUI();
      }
    });
  });

  // ── Undo (removes last stroke of any type) ──
  document.getElementById('btn-undo').addEventListener('click', async () => {
    if (!S.curPDF) return;
    const trueId = S.curPDF.linked_pdf_id || S.curPDF.id;
    const pg = S.curPage;
    if (!S.drawData[pg]?.length) return;
    S.drawData[pg].pop();
    const c = S.pages[pg]?.drawCanvas;
    if (c) renderCanvas(c, S.drawData[pg]);
    autosave('saving');
    try {
      await dbSaveDrawings(trueId, pg, S.drawData[pg]);
      autosave('saved');
      toast('Undone');
    } catch {
      autosave('err');
    }
  });

  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (!S.curPDF) return;
    const trueId = S.curPDF.linked_pdf_id || S.curPDF.id;
    const pg = S.curPage;
    S.drawData[pg] = [];
    const c = S.pages[pg]?.drawCanvas;
    if (c) renderCanvas(c, []);
    autosave('saving');
    try {
      await dbSaveDrawings(trueId, pg, []);
      autosave('saved');
      toast('Drawing cleared');
    } catch {
      autosave('err');
    }
  });

  document.querySelectorAll('.dw-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      S.drawWidth = parseInt(btn.dataset.w);
      document.querySelectorAll('.dw-btn').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
      // Switch back to pen when picking pen size
      if (S.drawTool !== 'pen') {
        S.drawTool = 'pen';
        updateDrawToolUI();
      }
    });
  });
}

function updateDrawToolUI() {
  const btn = document.getElementById('btn-erase');
  btn.classList.toggle('active', S.drawTool === 'erase');
  btn.textContent = S.drawTool === 'erase' ? '✏ Pen' : '⊘ Erase';

  // Show/hide eraser size buttons
  document.getElementById('erase-sizes').style.display = S.drawTool === 'erase' ? 'flex' : 'none';
  document.getElementById('pen-sizes').style.display   = S.drawTool === 'erase' ? 'none'  : 'flex';
}

// ── Pinch zoom ──
export function initPinchZoom() {
  let pinchD = null, pinchS = null;
  const sc = document.getElementById('canvas-scroll');
  sc.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      pinchD = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      pinchS = S.scale;
    }
  }, { passive: true });

  sc.addEventListener('touchmove', e => {
    if (e.touches.length === 2 && pinchD) {
      e.preventDefault();
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      S.scale = Math.max(0.5, Math.min(3, Math.round(pinchS * dist / pinchD * 4) / 4));
      document.getElementById('zoom-lbl').textContent = Math.round(S.scale / 1.5 * 100) + '%';
    }
  }, { passive: false });

  sc.addEventListener('touchend', async e => {
    if (pinchD && e.touches.length < 2) {
      pinchD = null;
      if (S.pdfDoc) {
        const { reRenderAll } = await import('./viewer.js');
        reRenderAll();
      }
    }
  }, { passive: true });
}
