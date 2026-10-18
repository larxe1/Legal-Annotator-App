// ═══════════════════════════════════════════════
// THUMBNAILS — page thumbnail strip
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { jumpToPage } from './ui.js';

export async function renderThumbnails(expectedId) {
  const strip = document.getElementById('thumb-strip');
  strip.innerHTML = '';
  if (!S.pdfDoc) return;

  const THUMB_W = 78; // px width for thumbnail canvas

  for (let p = 1; p <= S.totalPages; p++) {
    const page = await S.pdfDoc.getPage(p);
    if (expectedId && S.curPDF?.id !== expectedId) return;
    const vp   = page.getViewport({ scale: 1 });
    const scale = THUMB_W / vp.width;
    const tvp   = page.getViewport({ scale });

    const canvas    = document.createElement('canvas');
    canvas.width    = tvp.width;
    canvas.height   = tvp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: tvp }).promise;

    const item = document.createElement('div');
    item.className    = 'thumb-item' + (p === 1 ? ' active' : '');
    item.dataset.page = p;
    item.title        = `Page ${p}`;

    const pgNum = document.createElement('div');
    pgNum.className   = 'thumb-pg-num';
    pgNum.textContent = p;

    item.appendChild(canvas);
    item.appendChild(pgNum);
    item.addEventListener('click', () => jumpToPage(p));
    strip.appendChild(item);
  }
}
