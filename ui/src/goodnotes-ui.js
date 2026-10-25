// ═══════════════════════════════════════════════════════════════════════════
// GOODNOTES SCHOOL NOTEBOOK UI — Warm Paper Theme Switcher, Multi-Case Tabs,
// Color-Coded Subject Binders, Case Digest Tracker, & Study Desk Home
// ═══════════════════════════════════════════════════════════════════════════
import { S } from './state.js';
import { safeStorageGet, safeStorageSet } from './storage.js';
import { toast } from './ui.js';

const THEME_KEY = 'app_ui_theme';
const OPEN_TABS_KEY = 'gn_open_tabs_v1';
const RECENT_IDS_KEY = 'gn_recent_pdf_ids_v1';

// Curated GoodNotes academic binder palette
const BINDER_PALETTE = [
  '#2563EB', // Cobalt Blue
  '#DC2626', // Crimson Red
  '#059669', // Emerald Green
  '#D97706', // Warm Amber
  '#7C3AED', // Royal Purple
  '#0891B2', // Teal Cyan
  '#DB2777', // Berry Rose
  '#4F46E5', // Indigo
];

let _openTabs = []; // [{ tabId, type: 'pdf'|'folder', id, name }]
let _activeTabId = 'home';

// ── 1. Theme System (Default: GoodNotes Warm Paper) ─────────────────────────
export function getAppTheme() {
  return safeStorageGet(THEME_KEY) || 'paper';
}

export function applyAppTheme(theme) {
  const valid = ['paper', 'slate', 'classic'].includes(theme) ? theme : 'paper';
  document.body.classList.remove('theme-paper', 'theme-slate', 'theme-classic');
  document.body.classList.add(`theme-${valid}`);
  safeStorageSet(THEME_KEY, valid);

  const btn = document.getElementById('btn-theme-toggle');
  if (btn) {
    if (valid === 'paper') {
      btn.innerHTML = '<span>☀️</span><span>Paper</span>';
      btn.title = 'Current: GoodNotes Warm Paper (Click for Cozy Dark Mode)';
    } else if (valid === 'slate') {
      btn.innerHTML = '<span>🌙</span><span>Dark</span>';
      btn.title = 'Current: GoodNotes Cozy Dark (Click for Classic Navy)';
    } else {
      btn.innerHTML = '<span>⚖️</span><span>Classic</span>';
      btn.title = 'Current: Classic Navy (Click for GoodNotes Warm Paper)';
    }
  }
}

export function cycleAppTheme() {
  const cur = getAppTheme();
  const next = cur === 'paper' ? 'slate' : cur === 'slate' ? 'classic' : 'paper';
  applyAppTheme(next);
  const names = {
    paper: '☀️ GoodNotes Warm Paper theme active',
    slate: '🌙 GoodNotes Cozy Dark theme active',
    classic: '⚖️ Classic Legal Navy theme active',
  };
  toast(names[next]);
}

// ── 2. Subject Binder Color Helper ──────────────────────────────────────────
export function getSubjectBinderColor(subj, idx = 0) {
  if (!subj) return BINDER_PALETTE[0];
  const raw = (subj.hex_color || '').toLowerCase();
  const name = (subj.name || '').toLowerCase();
  if (!raw || raw === '#c9a84c') {
    if (name.includes('crim') || name.includes('124')) return '#DC2626';
    if (name.includes('sales') || name.includes('103')) return '#D97706';
    if (name.includes('torts') || name.includes('104')) return '#2563EB';
    if (name.includes('insur') || name.includes('139')) return '#7C3AED';
    if (name.includes('labor') || name.includes('113')) return '#0891B2';
    if (name.includes('prop') || name.includes('102')) return '#059669';
    return BINDER_PALETTE[idx % BINDER_PALETTE.length];
  }
  return subj.hex_color;
}

export function getSubjectForPdf(pdf) {
  if (!pdf) return null;
  let fold = S.folders.find(f => f.id === pdf.folder_id);
  let depth = 0;
  while (fold && !fold.subject_id && fold.parent_folder_id && depth < 10) {
    fold = S.folders.find(f => f.id === fold.parent_folder_id);
    depth++;
  }
  if (!fold?.subject_id) return null;
  return S.subjects.find(s => s.id === fold.subject_id) || null;
}

// ── 3. Case Digest Tracker (Cloud + Local Sync) ─────────────────────────────
export function hasMeaningfulDigestHtml(html) {
  if (!html || typeof html !== 'string') return false;
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  return stripped.length > 0 || /<img\b|<table\b/i.test(html);
}

export function hasCaseDigest(pdf) {
  if (!pdf) return false;
  const trueId = pdf.linked_pdf_id || pdf.id;
  // 1. Check live local storage if present on this device
  const localD = safeStorageGet('local_digest_' + trueId);
  if (localD !== null && localD !== undefined) {
    if (hasMeaningfulDigestHtml(localD)) return true;
  }
  if (trueId !== pdf.id) {
    const altD = safeStorageGet('local_digest_' + pdf.id);
    if (altD !== null && altD !== undefined && hasMeaningfulDigestHtml(altD)) {
      return true;
    }
  }
  // 2. Check cloud-synced digest map loaded from Supabase `pdf_notes`
  if (S.digestMap && (S.digestMap[trueId] || S.digestMap[pdf.id])) {
    return true;
  }
  return false;
}

export function getFolderDigestProgress(folderId) {
  const pdfs = S.pdfs.filter(p => p.folder_id === folderId);
  let digested = 0;
  for (const p of pdfs) {
    if (hasCaseDigest(p)) digested++;
  }
  return { total: pdfs.length, digested };
}

export async function openCaseDigestForPdf(pdf) {
  if (!pdf) return;
  const { openPDFFromLibrary } = await import('./viewer.js');
  if (!S.curPDF || S.curPDF.id !== pdf.id) {
    await openPDFFromLibrary(pdf);
  }
  const trueId = pdf.linked_pdf_id || pdf.id;
  const { openNotepad, switchNotepadTab } = await import('./notepad.js');
  await openNotepad(trueId);
  switchNotepadTab('digest');
}

// ── 4. Multi-Case Document Tabs at the Top (#gn-doc-tabs) ───────────────────
function loadSavedTabs() {
  try {
    const raw = safeStorageGet(OPEN_TABS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) _openTabs = parsed.slice(0, 8);
    }
  } catch {
    _openTabs = [];
  }
}

function saveTabs() {
  try {
    safeStorageSet(OPEN_TABS_KEY, JSON.stringify(_openTabs.slice(0, 8)));
  } catch {}
}

export function notifyTabOpened(item, type = 'pdf') {
  if (!item || !item.id) {
    _activeTabId = 'home';
    renderDocTabs();
    renderStudyDesk();
    return;
  }
  const tabId = `${type}:${item.id}`;
  _activeTabId = tabId;

  const existing = _openTabs.find(t => t.tabId === tabId);
  if (existing) {
    existing.name = item.name || existing.name;
  } else {
    _openTabs.push({
      tabId,
      type,
      id: item.id,
      name: item.name || 'Untitled',
    });
    if (_openTabs.length > 8) {
      _openTabs.shift();
    }
  }
  saveTabs();

  if (type === 'pdf') {
    pushRecentPdfId(item.id);
  }
  renderDocTabs();
}

export function notifyTabClosedToHome() {
  _activeTabId = 'home';
  renderDocTabs();
  renderStudyDesk();
}

export async function closeDocTab(tabId, e) {
  if (e) e.stopPropagation();
  const idx = _openTabs.findIndex(t => t.tabId === tabId);
  if (idx === -1) return;
  _openTabs.splice(idx, 1);
  saveTabs();

  if (_activeTabId === tabId) {
    const nextTab = _openTabs[idx] || _openTabs[idx - 1] || null;
    if (nextTab) {
      await activateDocTab(nextTab.tabId);
      return;
    } else {
      const { closeActivePDF } = await import('./viewer.js');
      await closeActivePDF();
      return;
    }
  }
  renderDocTabs();
  renderStudyDesk();
}

export async function activateDocTab(tabId) {
  if (tabId === 'home') {
    const { closeActivePDF } = await import('./viewer.js');
    await closeActivePDF();
    return;
  }

  const tab = _openTabs.find(t => t.tabId === tabId);
  if (!tab) return;

  if (tab.type === 'pdf') {
    const pdf = S.pdfs.find(p => p.id === tab.id);
    if (!pdf) {
      await closeDocTab(tabId);
      return;
    }
    const { openPDFFromLibrary } = await import('./viewer.js');
    await openPDFFromLibrary(pdf);
  } else if (tab.type === 'folder') {
    const fold = S.folders.find(f => f.id === tab.id);
    if (!fold) {
      await closeDocTab(tabId);
      return;
    }
    const { openFolderDoc } = await import('./viewer.js');
    await openFolderDoc(fold);
  }
}

export function renderDocTabs() {
  const bar = document.getElementById('gn-doc-tabs');
  if (!bar) return;

  // Prune tabs whose PDF/folder was deleted
  if (S.pdfs.length || S.folders.length) {
    _openTabs = _openTabs.filter(t =>
      t.type === 'pdf'
        ? S.pdfs.some(p => p.id === t.id)
        : S.folders.some(f => f.id === t.id)
    );
  }

  bar.innerHTML = '';

  // 1. Pinned "🏠 Study Desk" Tab
  const homeTab = document.createElement('div');
  homeTab.className = 'gn-tab gn-tab-home' + (_activeTabId === 'home' && !S.curPDF ? ' active' : '');
  homeTab.innerHTML = `<span class="gn-tab-icon">🏠</span><span class="gn-tab-title">Study Desk</span>`;
  homeTab.title = 'Return to Study Desk & Class Schedule';
  homeTab.addEventListener('click', () => activateDocTab('home'));
  bar.appendChild(homeTab);

  // 2. Open Case & Folder Notebook Tabs
  for (const t of _openTabs) {
    const el = document.createElement('div');
    const isActive = _activeTabId === t.tabId;
    el.className = 'gn-tab' + (isActive ? ' active' : '');

    let color = '#2563EB';
    let statusBadge = '';
    if (t.type === 'pdf') {
      const pdf = S.pdfs.find(p => p.id === t.id);
      if (pdf) {
        t.name = pdf.name;
        const subj = getSubjectForPdf(pdf);
        if (subj) color = getSubjectBinderColor(subj);
        if (hasCaseDigest(pdf)) {
          statusBadge = '<span class="gn-tab-status" title="Has Case Digest">⚖️</span>';
        }
      }
    } else {
      const fold = S.folders.find(f => f.id === t.id);
      if (fold) {
        t.name = fold.name;
        const subj = S.subjects.find(s => s.id === fold.subject_id);
        if (subj) color = getSubjectBinderColor(subj);
      }
    }

    const icon = t.type === 'pdf' ? '📄' : '📓';
    el.innerHTML = `
      <span class="gn-tab-dot" style="background:${color}"></span>
      <span class="gn-tab-icon">${icon}</span>
      <span class="gn-tab-title" title="${(t.name || '').replace(/"/g, '&quot;')}">${t.name}</span>
      ${statusBadge}
      <button class="gn-tab-close" title="Close tab">×</button>
    `;

    el.addEventListener('click', () => activateDocTab(t.tabId));
    el.querySelector('.gn-tab-close')?.addEventListener('click', e => closeDocTab(t.tabId, e));
    bar.appendChild(el);
  }
}

// ── 5. Recent Cases Persistence & Study Desk Home Screen ────────────────────
function pushRecentPdfId(pdfId) {
  if (!pdfId) return;
  try {
    const raw = JSON.parse(safeStorageGet(RECENT_IDS_KEY) || '[]');
    const next = [pdfId, ...raw.filter(id => id !== pdfId)].slice(0, 6);
    safeStorageSet(RECENT_IDS_KEY, JSON.stringify(next));
  } catch {}
}

function getRecentPdfsForShelf() {
  let ids = [];
  try {
    ids = JSON.parse(safeStorageGet(RECENT_IDS_KEY) || '[]');
  } catch {}
  const found = [];
  for (const id of ids) {
    const p = S.pdfs.find(x => x.id === id);
    if (p && !found.some(f => f.id === p.id)) found.push(p);
  }
  if (found.length < 4 && S.pdfs.length > 0) {
    for (const p of S.pdfs) {
      if (found.length >= 4) break;
      if (!found.some(f => f.id === p.id)) found.push(p);
    }
  }
  return found.slice(0, 4);
}

export function openSubjectBinderByTitle(rawTitle) {
  if (!rawTitle || !S.subjects.length) return false;
  const q = rawTitle.toLowerCase();
  const codeMatch = q.match(/\b(\d{3})\b/);
  const code = codeMatch ? codeMatch[1] : null;

  let matchedSubj = null;
  if (code) {
    matchedSubj = S.subjects.find(s => s.name.toLowerCase().includes(code));
  }
  if (!matchedSubj) {
    const keywords = q
      .replace(/^\d+\s*:\s*/, '')
      .split(/\s+/)
      .filter(w => w.length >= 4 && w !== 'and');
    matchedSubj = S.subjects.find(s => {
      const sn = s.name.toLowerCase();
      return keywords.some(kw => sn.includes(kw));
    });
  }

  if (!matchedSubj) {
    toast(`📚 Tip: Create or open "${rawTitle}" in the Library sidebar on the left.`);
    return false;
  }

  S.collapsedSubj[matchedSubj.id] = false;
  import('./library.js').then(m => {
    m.renderLibrary();
    setTimeout(() => {
      const side = document.getElementById('lib-side');
      if (side) side.classList.add('open', 'hover-open');
      const subjEl = document.querySelector(`.li-subj[data-id="${matchedSubj.id}"]`);
      if (subjEl) {
        subjEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        subjEl.classList.add('binder-pulse');
        setTimeout(() => subjEl.classList.remove('binder-pulse'), 1600);
      }
    }, 60);
  });
  toast(`📚 Opened "${matchedSubj.name}" binder`);
  return true;
}

export function renderStudyDesk() {
  const cal = document.getElementById('welcome-calendar');
  if (!cal) return;

  // 1. Calculate Semester Digest Stats (count unique canonical PDFs)
  let digestedCount = 0;
  const totalCases = S.pdfs.length;
  for (const p of S.pdfs) {
    if (hasCaseDigest(p)) digestedCount++;
  }

  // 2. Ensure Continue Studying Shelf exists above .cal-grid
  let shelf = document.getElementById('gn-study-shelf');
  if (!shelf) {
    shelf = document.createElement('div');
    shelf.id = 'gn-study-shelf';
    const header = cal.querySelector('.cal-header');
    if (header && header.nextSibling) {
      cal.insertBefore(shelf, header.nextSibling);
    } else {
      cal.prepend(shelf);
    }
  }

  // Update header subtitle with live Digest stats pill
  const headerP = cal.querySelector('.cal-header p');
  if (headerP) {
    headerP.innerHTML = `2ND YEAR, 1ST SEMESTER &nbsp;•&nbsp; <span class="gn-desk-stat">⚖️ ${digestedCount} / ${totalCases} Digested</span>`;
  }

  const recentPdfs = getRecentPdfsForShelf();
  if (recentPdfs.length > 0) {
    shelf.style.display = 'block';
    shelf.innerHTML = `
      <div class="gn-shelf-hd">
        <span>📖 Continue Studying</span>
        <span class="gn-shelf-sub">Click any notebook card to jump back in</span>
      </div>
      <div class="gn-shelf-grid"></div>
    `;
    const grid = shelf.querySelector('.gn-shelf-grid');
    recentPdfs.forEach((pdf, i) => {
      const subj = getSubjectForPdf(pdf);
      const fold = S.folders.find(f => f.id === pdf.folder_id);
      const spineColor = getSubjectBinderColor(subj, i);
      const digested = hasCaseDigest(pdf);
      const stClass = digested ? 'read' : '';
      const stLabel = digested ? '⚖️ Digest Ready' : '📝 No Digest Yet';

      const card = document.createElement('div');
      card.className = 'gn-notebook-card';
      card.style.setProperty('--spine-color', spineColor);
      card.innerHTML = `
        <div class="gn-nb-spine" style="background:${spineColor}"></div>
        <div class="gn-nb-body">
          <div class="gn-nb-meta">${subj ? subj.name : 'Library'}${fold ? ' › ' + fold.name : ''}</div>
          <div class="gn-nb-title" title="${pdf.name.replace(/"/g, '&quot;')}">${pdf.name}</div>
          <div class="gn-nb-footer">
            <span class="gn-nb-status ${stClass}">${stLabel}</span>
          </div>
        </div>
      `;
      card.addEventListener('click', async () => {
        const { openPDFFromLibrary } = await import('./viewer.js');
        openPDFFromLibrary(pdf);
      });
      grid.appendChild(card);
    });
  } else {
    shelf.style.display = 'none';
  }

  // 3. Enhance Class Schedule Cards (.cal-item) with Subject Spine Colors & Quick Actions
  cal.querySelectorAll('.cal-item').forEach(item => {
    const strong = item.querySelector('strong');
    if (!strong) return;
    const subjTitle = strong.textContent.trim();
    const color = getSubjectBinderColor({ name: subjTitle });
    item.style.borderLeft = `4px solid ${color}`;

    if (!item.querySelector('.gn-cal-actions')) {
      const bar = document.createElement('div');
      bar.className = 'gn-cal-actions';
      bar.innerHTML = `
        <span class="gn-cal-open-binder" title="Open ${subjTitle} binder in Library">📚 Open Binder ↗</span>
        <button class="gn-cal-note-btn" type="button" title="Open quick class notes for ${subjTitle}">📝 Note</button>
      `;
      item.appendChild(bar);
    }
  });
}

// ── 6. Initialize All GoodNotes UI Upgrades ─────────────────────────────────
export function initGoodNotesUI() {
  // Capture pristine #welcome HTML before any tab or PDF overwrites #canvas-scroll
  import('./viewer.js').then(m => m.getWelcomeHTML?.()).catch(() => {});

  applyAppTheme(getAppTheme());
  loadSavedTabs();
  renderDocTabs();
  renderStudyDesk();

  document.getElementById('btn-theme-toggle')?.addEventListener('click', cycleAppTheme);
}
