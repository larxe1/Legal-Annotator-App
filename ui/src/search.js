// ═══════════════════════════════════════════════
// SEARCH — PDF text search + annotation search
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { closeOtherPanels } from './ui.js';

let searchMode = 'pdf'; // 'pdf' | 'ann'

export function openSearch() {
  closeOtherPanels('search-panel');
  document.getElementById('search-panel').classList.add('open');
  document.getElementById('search-input').focus();
  document.getElementById('search-ann-results').style.display = searchMode === 'ann' ? 'block' : 'none';
}

export function closeSearch() {
  document.getElementById('search-panel').classList.remove('open');
  clearSearchHighlights();
  document.getElementById('search-count').textContent = '';
  document.getElementById('search-input').value = '';
}

export function clearSearchHighlights() {
  document.querySelectorAll('.srch-hi').forEach(el => el.remove());
  S.searchResults = [];
  S.searchIdx = 0;
}

export function initSearch() {
  // Tab toggle
  document.querySelectorAll('.stab').forEach(btn => {
    btn.addEventListener('click', () => {
      searchMode = btn.dataset.stab;
      document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('search-ann-results').style.display = searchMode === 'ann' ? 'block' : 'none';
      runSearch();
    });
  });

  document.getElementById('btn-search').addEventListener('click', openSearch);
  document.getElementById('search-close-btn').addEventListener('click', closeSearch);

  let debounce = null;
  document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 200);
  });
  document.getElementById('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') nextSearchResult(e.shiftKey ? -1 : 1);
    if (e.key === 'Escape') closeSearch();
  });
  document.getElementById('snext').addEventListener('click', () => nextSearchResult(1));
  document.getElementById('sprev').addEventListener('click', () => nextSearchResult(-1));

  // Native Desktop Ctrl+F shortcut -> opens PDF & Annotation Search panel
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && S.curPDF) {
      e.preventDefault();
      openSearch();
      document.getElementById('search-input')?.select();
    }
  });
}

function runSearch() {
  clearSearchHighlights();
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  if (!q) {
    document.getElementById('search-count').textContent = '';
    document.getElementById('search-ann-results').innerHTML = '';
    return;
  }
  if (searchMode === 'pdf') runPDFSearch(q);
  else                      runAnnSearch(q);
}

let _searchQueryId = 0;

export async function extractPageText(doc, pageNum) {
  if (S.pages[pageNum]?.textItems?.length) return S.pages[pageNum].textItems;

  const trueId = S.curPDF?.linked_pdf_id || S.curPDF?.id || null;
  const scaleKey = String(Math.round((S.scale || 1.5) * 100));

  // 1. Check Disk Page Vault on D: drive first (instant lock-free JSON read)
  if (trueId && window.__DESKTOP_PDFIUM__?.getPageText) {
    const cached = await window.__DESKTOP_PDFIUM__.getPageText(trueId, pageNum, scaleKey);
    if (cached && Array.isArray(cached.textItems) && cached.textItems.length) {
      if (S.pages[pageNum]) S.pages[pageNum].textItems = cached.textItems;
      return cached.textItems;
    }
  }

  try {
    const page = await doc.getPage(pageNum);
    const vp = page.getViewport({ scale: S.scale });
    const tc = await page.getTextContent();
    const textItems = [];
    const spansToVault = [];
    for (const item of tc.items) {
      if (!item.str || !item.transform) continue;
      const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
      const fh = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
      const angle = Math.atan2(tx[1], tx[0]);
      const leftPx = tx[4];
      const topPx = tx[5] - fh * 0.8;
      const fontFam = item.fontName || 'sans-serif';
      spansToVault.push({
        s: item.str,
        l: Math.round(leftPx * 100) / 100,
        t: Math.round(topPx * 100) / 100,
        fs: Math.round(fh * 100) / 100,
        ff: fontFam,
        a: angle ? Math.round(angle * 10000) / 10000 : 0,
      });
      textItems.push({
        str: item.str,
        x: item.transform[4] * S.scale,
        y: vp.height - item.transform[5] * S.scale,
        w: (item.width || 0) * S.scale,
        h: (item.height || fh) * S.scale,
      });
    }
    if (S.pages[pageNum]) S.pages[pageNum].textItems = textItems;
    if (trueId && window.__DESKTOP_PDFIUM__?.savePageText) {
      window.__DESKTOP_PDFIUM__.savePageText(trueId, pageNum, scaleKey, {
        w: vp.width,
        h: vp.height,
        spans: spansToVault,
        textItems,
      });
    }
    return textItems;
  } catch (err) {
    return [];
  }
}

// Background indexer for all pages when PDF opens (polite idle batching for desktop)
export async function indexAllPagesText(doc) {
  if (!doc || !S.totalPages) return;
  const total = S.totalPages;
  const BATCH_SIZE = 4;
  for (let i = 1; i <= total; i += BATCH_SIZE) {
    if (doc !== S.pdfDoc) return; // switched PDF
    const batch = [];
    for (let p = i; p < i + BATCH_SIZE && p <= total; p++) {
      if (!S.pages[p]?.textItems?.length) {
        batch.push(extractPageText(doc, p));
      }
    }
    if (batch.length) {
      await Promise.all(batch);
    }
    // Polite idle yield so scrolling and PDFium canvas rendering always get priority
    await new Promise(r => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(() => r(), { timeout: 180 });
      } else {
        setTimeout(r, 45);
      }
    });
  }
}

// ── PDF text search — searches full PDF document concurrently across all pages ──
async function runPDFSearch(q) {
  const currentQueryId = ++_searchQueryId;
  S.searchResults = [];
  const countEl = document.getElementById('search-count');
  countEl.textContent = 'Searching…';

  if (!S.pdfDoc || !S.totalPages) return;

  const doc = S.pdfDoc;
  const total = S.totalPages;
  const BATCH_SIZE = 35;

  for (let i = 1; i <= total; i += BATCH_SIZE) {
    if (currentQueryId !== _searchQueryId) return; // Cancelled if new search started

    const batchPages = [];
    for (let p = i; p < i + BATCH_SIZE && p <= total; p++) {
      batchPages.push(p);
    }

    // Extract text concurrently for all pages in this batch
    const textItemsResults = await Promise.all(
      batchPages.map(p => extractPageText(doc, p))
    );

    if (currentQueryId !== _searchQueryId) return;

    // Search matches within this batch
    for (let b = 0; b < batchPages.length; b++) {
      const pn = batchPages[b];
      const textItems = textItemsResults[b] || [];

      for (const item of textItems) {
        const lower = item.str.toLowerCase();
        let start = 0;
        while (true) {
          const idx = lower.indexOf(q, start);
          if (idx < 0) break;

          // Calculate sub-rect for the matched portion only
          const charW  = item.w / (item.str.length || 1);
          const matchX = item.x + idx * charW;
          const matchW = q.length * charW;

          S.searchResults.push({
            page: pn,
            item,
            matchX,
            matchW,
            matchY: item.y,
            matchH: item.h,
            q,
          });
          start = idx + q.length;
        }
      }
    }

    // Show live progress on large PDFs
    if (total > 50 && i + BATCH_SIZE <= total) {
      const progress = Math.min(100, Math.round(((i + BATCH_SIZE) / total) * 100));
      countEl.textContent = `Searching… ${progress}% (${S.searchResults.length} found)`;
    }
  }

  if (currentQueryId !== _searchQueryId) return;

  for (const res of S.searchResults) drawSearchHL(res, false);
  S.searchIdx = 0;

  if (S.searchResults.length) {
    highlightCurrentResult();
  } else {
    countEl.textContent = 'No results';
  }
}

export function drawSearchHL(res, isCurrent) {
  const pg = S.pages[res.page];
  if (!pg || !pg.rendered || !pg.srchOv) return;
  // Prevent duplicate highlights
  const existing = pg.srchOv.querySelector(`.srch-hi[data-sridx="${S.searchResults.indexOf(res)}"]`);
  if (existing) {
    existing.classList.toggle('current', isCurrent);
    return;
  }
  const d  = document.createElement('div');
  d.className = 'srch-hi' + (isCurrent ? ' current' : '');
  d.style.cssText = `left:${res.matchX}px;top:${res.matchY - res.matchH * .1}px;width:${res.matchW}px;height:${res.matchH * 1.2}px`;
  d.dataset.sridx = S.searchResults.indexOf(res);
  pg.srchOv.appendChild(d);
}

async function highlightCurrentResult() {
  document.querySelectorAll('.srch-hi').forEach(el => el.classList.remove('current'));
  const res = S.searchResults[S.searchIdx]; if (!res) return;
  
  const { jumpToPage } = await import('./ui.js');
  await jumpToPage(res.page);

  drawSearchHL(res, true);
  const el = document.querySelector(`.srch-hi[data-sridx="${S.searchIdx}"]`);
  if (el) el.classList.add('current');
  document.getElementById('search-count').textContent = `${S.searchIdx + 1} / ${S.searchResults.length}`;
}

function nextSearchResult(dir) {
  if (!S.searchResults.length) return;
  S.searchIdx = (S.searchIdx + dir + S.searchResults.length) % S.searchResults.length;
  highlightCurrentResult();
}

// ── Annotation search ──
function runAnnSearch(q) {
  const results = document.getElementById('search-ann-results');
  results.style.display = 'block';
  const stripHTML = html => html.replace(/<[^>]*>/g, '');
  const matches = S.annotations.filter(a =>
    a.highlighted_text?.toLowerCase().includes(q) ||
    a.notes.some(n => stripHTML(n.note_html).toLowerCase().includes(q))
  );
  document.getElementById('search-count').textContent =
    matches.length ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : 'No matches';
  if (!matches.length) {
    results.innerHTML = '<div class="sar-empty">No matching annotations.</div>';
    return;
  }
  results.innerHTML = '';
  const sorted = [...matches].sort((a, b) => a.page - b.page);
  for (const ann of sorted) {
    const noteMatch = ann.notes.find(n => stripHTML(n.note_html).toLowerCase().includes(q));
    const isCase = noteMatch?.note_html?.includes('data-note-type="case"');
    const item = document.createElement('div');
    item.className = 'sar-item';
    const tag = noteMatch ? (isCase ? '<span style="color:var(--gold);font-size:10px;font-weight:600">⚖️ Case: </span>' : '<span style="color:var(--muted);font-size:10px">📝 Note: </span>') : '';
    item.innerHTML =
      `<div class="sar-ex">"${ann.highlighted_text.slice(0, 60)}${ann.highlighted_text.length > 60 ? '…' : ''}"</div>` +
      (noteMatch ? `<div class="sar-note">${tag}${stripHTML(noteMatch.note_html).slice(0, 70)}</div>` : '') +
      `<div class="sar-page">Page ${ann.page}</div>`;
    item.addEventListener('click', async () => {
      const { jumpToPage } = await import('./ui.js');
      await jumpToPage(ann.page);
      import('./annotate.js').then(({ openAnnPanel }) => setTimeout(() => openAnnPanel(ann), 300));
    });
    results.appendChild(item);
  }
}
