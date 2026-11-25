// ═══════════════════════════════════════════════════════════════════════════
// GOODNOTES & DUAL-SKIN UI — Chancery & Folio (Day) / Darkroom Casebook (Night),
// Multi-Case Tabs, Color-Coded Subject Binders, & Study Desk Home
// ═══════════════════════════════════════════════════════════════════════════
import { S, isPdfArchived, isSubjectArchived } from './state.js';
import { safeStorageGet, safeStorageSet, safeStorageRemove, initStorageManager } from './storage.js';
import { dbSetSetting, dbGetSetting } from './db.js';
import { toast, toggleSidebar } from './ui.js';

const THEME_KEY = 'app_ui_theme';
const OPEN_TABS_KEY = 'gn_open_tabs_v1';
const LEGACY_RECENT_V1 = 'gn_recent_pdf_ids_v1';
const LEGACY_RECENT_V2 = 'gn_recent_reads_v2';
export const RECENT_READS_KEY = 'gn_recent_reads_v3';
const MAX_RECENT_STORED = 12;
const MAX_DISMISSED_TOMBSTONES = 50;

export const AUTO_CLOSE_TABS_KEY = 'auto_close_tabs_10m';
export const INACTIVE_TAB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Authoritative in-memory canonical recent reads state so opening/dismissing works 100% of the time
// even if localStorage is full: { items: [{ id, trueId, ts }], clearedAt, dismissed: { [trueId]: ts } }
let _recentState = null;

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

let _openTabs = []; // [{ tabId, type: 'pdf'|'folder', id, name, lastActiveAt }]
let _activeTabId = 'home';

export function isAutoCloseTabsEnabled() {
  const val = safeStorageGet(AUTO_CLOSE_TABS_KEY);
  if (val === null || val === undefined || val === '') return true;
  return val !== 'false';
}

export function setAutoCloseTabsEnabled(enabled) {
  const strVal = enabled ? 'true' : 'false';
  safeStorageSet(AUTO_CLOSE_TABS_KEY, strVal);
  dbSetSetting(AUTO_CLOSE_TABS_KEY, strVal).catch(() => {});
  if (enabled) {
    pruneInactiveTabs();
  }
}

export function pruneInactiveTabs() {
  if (!isAutoCloseTabsEnabled()) return;
  const now = Date.now();
  const beforeCount = _openTabs.length;
  _openTabs = _openTabs.filter(t => {
    if (t.tabId === _activeTabId) {
      t.lastActiveAt = now;
      return true;
    }
    const elapsed = now - (t.lastActiveAt || now);
    return elapsed < INACTIVE_TAB_TIMEOUT_MS;
  });
  if (_openTabs.length !== beforeCount) {
    saveTabs();
    renderDocTabs();
  }
}

// ── 1. Theme System (Default: Chancery & Folio Day Skin) ─────────────────────
function normalizeAppTheme(raw) {
  if (raw === 'paper' || raw === 'folio') return 'folio';
  if (raw === 'slate' || raw === 'casebook') return 'casebook';
  if (raw === 'classic') return 'classic';
  return 'folio';
}

function skinToLegacyBodyClass(skin) {
  if (skin === 'casebook') return 'theme-slate';
  if (skin === 'classic') return 'theme-classic';
  return 'theme-paper';
}

export function getAppTheme() {
  const raw = safeStorageGet(THEME_KEY);
  const normalized = normalizeAppTheme(raw);
  if (raw === 'paper' || raw === 'slate') {
    safeStorageSet(THEME_KEY, normalized);
  }
  return normalized;
}

function updateThemeToggleButton(skin) {
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) {
    if (skin === 'folio') {
      btn.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#i-sun"/></svg><span>Folio</span>';
      btn.title = 'Current: Chancery & Folio (Day) — Click to switch to Darkroom Casebook';
    } else if (skin === 'casebook') {
      btn.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#i-moon"/></svg><span>Casebook</span>';
      btn.title = 'Current: Darkroom Casebook (Night) — Click to switch to Chancery & Folio';
    } else {
      btn.innerHTML = '<svg class="icon icon-sm" aria-hidden="true"><use href="#i-scale"/></svg><span>Classic</span>';
      btn.title = 'Current: Classic Legal Navy — Click to switch to Chancery & Folio';
    }
  }

  const railSwitch = document.getElementById('skin-switch-rail');
  if (railSwitch) {
    const isCasebook = skin === 'casebook';
    const iconId = isCasebook ? 'i-sun' : 'i-moon';
    railSwitch.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${iconId}"/></svg><span class="skin-switch__label">Day folio / Night casebook</span>`;
    railSwitch.setAttribute('aria-pressed', String(isCasebook));
    railSwitch.title = isCasebook
      ? 'Current: Darkroom Casebook (Night) — Click to switch to Day Folio'
      : 'Current: Chancery & Folio (Day) — Click to switch to Night Casebook';
  }
}

export function applyAppTheme(theme) {
  const valid = normalizeAppTheme(theme);
  const root = document.documentElement;
  root.setAttribute('data-skin', valid);
  document.body.classList.remove('theme-paper', 'theme-slate', 'theme-classic');
  document.body.classList.add(skinToLegacyBodyClass(valid));
  safeStorageSet(THEME_KEY, valid);
  updateThemeToggleButton(valid);
}

export function cycleAppTheme(originEvent) {
  const cur = getAppTheme();
  const next = cur === 'folio' ? 'casebook' : 'folio';
  const root = document.documentElement;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const swap = () => applyAppTheme(next);

  const announce = () => {
    const names = {
      folio: 'Chancery & Folio (Day) active',
      casebook: 'Darkroom Casebook (Night) active',
      classic: 'Classic Legal Navy active',
    };
    toast(names[next]);
  };

  if (!document.startViewTransition || reduceMotion) {
    swap();
    announce();
    return;
  }

  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  const toggleBtn = document.getElementById('btn-theme-toggle');
  if (originEvent && typeof originEvent.clientX === 'number' && originEvent.clientX > 0) {
    x = originEvent.clientX;
    y = originEvent.clientY;
  } else if (toggleBtn) {
    const rect = toggleBtn.getBoundingClientRect();
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 2;
  }

  const endRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y)
  );

  root.setAttribute('data-transition', 'skin');
  try {
    const vt = document.startViewTransition(swap);
    vt.ready.then(() => {
      root.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${endRadius}px at ${x}px ${y}px)`,
          ],
        },
        {
          duration: 320,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          pseudoElement: '::view-transition-new(root)',
        }
      );
    }).catch(() => {});
    vt.finished.finally(() => {
      root.removeAttribute('data-transition');
    });
  } catch {
    root.removeAttribute('data-transition');
    swap();
  }
  announce();
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
  // Sync the user's auto-close preference from cloud in the background
  dbGetSetting(AUTO_CLOSE_TABS_KEY).then(cloudPref => {
    if (cloudPref !== null && cloudPref !== undefined && cloudPref !== '') {
      safeStorageSet(AUTO_CLOSE_TABS_KEY, cloudPref);
    }
  }).catch(() => {});

  try {
    const raw = safeStorageGet(OPEN_TABS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const now = Date.now();
        _openTabs = parsed.slice(0, 8);
        for (const t of _openTabs) {
          t.lastActiveAt = t.lastActiveAt || now;
        }
        return;
      }
    }
  } catch {
    _openTabs = [];
  }

  // Load from Supabase cloud if local tabs are empty so tabs sync across devices
  dbGetSetting('gn_open_tabs_v1').then(cloud => {
    if (cloud && (!_openTabs || _openTabs.length === 0)) {
      try {
        const parsed = JSON.parse(cloud);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const now = Date.now();
          _openTabs = parsed.slice(0, 8);
          for (const t of _openTabs) {
            t.lastActiveAt = t.lastActiveAt || now;
          }
          safeStorageSet(OPEN_TABS_KEY, JSON.stringify(_openTabs));
          renderDocTabs();
        }
      } catch {}
    }
  }).catch(() => {});
}

function saveTabs() {
  try {
    const payload = JSON.stringify(_openTabs.slice(0, 8));
    safeStorageSet(OPEN_TABS_KEY, payload);
    dbSetSetting('gn_open_tabs_v1', payload).catch(() => {});
  } catch {}
}

export function notifyTabOpened(item, type = 'pdf', opts = {}) {
  const now = Date.now();
  // Refresh lastActiveAt on previously active tab right as user switches away from it
  const prevTab = _openTabs.find(t => t.tabId === _activeTabId);
  if (prevTab) {
    prevTab.lastActiveAt = now;
  }

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
    existing.lastActiveAt = now;
  } else {
    _openTabs.push({
      tabId,
      type,
      id: item.id,
      name: item.name || 'Untitled',
      lastActiveAt: now,
    });
    if (_openTabs.length > 8) {
      _openTabs.shift();
    }
  }
  saveTabs();

  if (type === 'pdf' && !opts?.skipRecent) {
    pushRecentPdfId(item.id);
  }
  renderDocTabs();
  renderStudyDesk();
}

export function notifyTabClosedToHome() {
  _activeTabId = 'home';
  renderDocTabs();
  renderStudyDesk();
}

export async function closeDocTab(tabId, e) {
  if (e) e.stopPropagation();
  if (S.curPDF) {
    const { flushCurrentReadingPosition, setIsJumping } = await import('./ui.js');
    flushCurrentReadingPosition();
    setIsJumping(true);
  }
  const idx = _openTabs.findIndex(t => t.tabId === tabId);
  if (idx === -1) return;
  _openTabs.splice(idx, 1);
  saveTabs();

  if (_activeTabId === tabId) {
    const nextTab = _openTabs[idx] || _openTabs[idx - 1] || null;
    if (nextTab) {
      await activateDocTab(nextTab.tabId, { skipRecent: true });
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

export async function activateDocTab(tabId, opts = {}) {
  const now = Date.now();
  // Before switching away from previous tab, update departing tab's lastActiveAt
  const departingTab = _openTabs.find(t => t.tabId === _activeTabId);
  if (departingTab) {
    departingTab.lastActiveAt = now;
  }

  // Set newly activated tab's lastActiveAt
  const activatedTab = _openTabs.find(t => t.tabId === tabId);
  if (activatedTab) {
    activatedTab.lastActiveAt = now;
  }

  if (S.curPDF) {
    const { flushCurrentReadingPosition, setIsJumping } = await import('./ui.js');
    flushCurrentReadingPosition();
    setIsJumping(true);
  }

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
    await openPDFFromLibrary(pdf, 5, opts);
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

  // 0. Sidebar toggle button
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'tabs__menu-btn';
  menuBtn.id = 'btn-tabs-sidebar-toggle';
  menuBtn.title = 'Toggle Library Sidebar';
  menuBtn.setAttribute('aria-label', 'Toggle Library Sidebar');
  menuBtn.setAttribute('aria-expanded', String(!document.body.classList.contains('sidebar-collapsed')));
  menuBtn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-sidebar"/></svg>';
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSidebar();
  });
  bar.appendChild(menuBtn);

  // 1. Pinned "Study Desk" Tab
  const homeTab = document.createElement('div');
  homeTab.className = 'gn-tab gn-tab-home' + (_activeTabId === 'home' && !S.curPDF ? ' active' : '');
  homeTab.innerHTML = `<span class="gn-tab-icon"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-desk"/></svg></span><span class="gn-tab-title">Study Desk</span>`;
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
          statusBadge = '<span class="gn-tab-status" title="Has Case Digest"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-scale"/></svg></span>';
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

    const iconId = t.type === 'pdf' ? 'i-note' : 'i-book';
    el.style.setProperty('--spine', color);
    el.innerHTML = `
      <span class="gn-tab-dot" style="background:${color}"></span>
      <span class="gn-tab-icon"><svg class="icon icon-sm" aria-hidden="true"><use href="#${iconId}"/></svg></span>
      <span class="gn-tab-title" title="${(t.name || '').replace(/"/g, '&quot;')}">${t.name}</span>
      ${statusBadge}
      <button class="gn-tab-close" title="Close tab" aria-label="Close tab"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-close"/></svg></button>
    `;

    el.addEventListener('click', () => activateDocTab(t.tabId));
    el.querySelector('.gn-tab-close')?.addEventListener('click', e => closeDocTab(t.tabId, e));
    bar.appendChild(el);
  }
}

// ── 5. Recent Cases Persistence & Study Desk Home Screen ────────────────────
function resolveCanonicalTrueId(pdfIdOrObj, fallbackTrueId = null) {
  if (pdfIdOrObj && typeof pdfIdOrObj === 'object') {
    const id = pdfIdOrObj.linked_pdf_id || pdfIdOrObj.id;
    return id != null ? String(id) : '';
  }
  const sid = pdfIdOrObj != null ? String(pdfIdOrObj) : '';
  const pdfs = Array.isArray(S.pdfs) ? S.pdfs : [];
  if (sid) {
    const pdf = pdfs.find(x => String(x.id) === sid);
    if (pdf) return String(pdf.linked_pdf_id || pdf.id);
  }
  if (fallbackTrueId != null && String(fallbackTrueId) !== '') {
    const fsid = String(fallbackTrueId);
    const pdfByFallback = pdfs.find(x => String(x.id) === fsid);
    if (pdfByFallback) return String(pdfByFallback.linked_pdf_id || pdfByFallback.id);
    return fsid;
  }
  return sid;
}

function pruneDismissed(dismissedMap) {
  if (!dismissedMap || typeof dismissedMap !== 'object' || Array.isArray(dismissedMap)) return {};
  const canonical = new Map();
  for (const [k, rawTs] of Object.entries(dismissedMap)) {
    if (!k) continue;
    const ts = Number(rawTs);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const ck = resolveCanonicalTrueId(k);
    if (!ck) continue;
    const prev = canonical.get(ck) || 0;
    if (ts > prev) canonical.set(ck, ts);
  }
  const entries = [...canonical.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DISMISSED_TOMBSTONES);
  const out = {};
  for (const [k, ts] of entries) out[k] = ts;
  return out;
}

export function normalizeRecentState(raw) {
  let parsed = raw;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (!trimmed) return { items: [], clearedAt: 0, dismissed: {} };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { items: [], clearedAt: 0, dismissed: {} };
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { items: [], clearedAt: 0, dismissed: {} };
  }

  let rawItems = [];
  let clearedAt = 0;
  let dismissed = {};

  if (Array.isArray(parsed)) {
    rawItems = parsed;
  } else {
    rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const rawCleared = Number(parsed.clearedAt);
    clearedAt = Number.isFinite(rawCleared) && rawCleared > 0 ? rawCleared : 0;
    dismissed = pruneDismissed(parsed.dismissed);
  }

  const byTrueId = new Map();
  for (const entry of rawItems) {
    if (!entry || entry.id == null) continue;
    const sid = String(entry.id);
    if (!sid) continue;
    const rawTs = Number(entry.ts);
    const ts = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : (entry.ts == null ? 1 : 0);
    const trueId = resolveCanonicalTrueId(sid, entry.trueId);
    if (!trueId) continue;
    const prev = byTrueId.get(trueId);
    if (!prev || ts > prev.ts) {
      byTrueId.set(trueId, { id: sid, trueId, ts });
    }
  }

  const items = [...byTrueId.values()]
    .filter(item => item.ts > clearedAt && item.ts > (dismissed[item.trueId] || 0))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_RECENT_STORED);

  return { items, clearedAt, dismissed };
}

export function mergeRecentStates(localRaw, remoteRaw) {
  const local = normalizeRecentState(localRaw);
  const remote = normalizeRecentState(remoteRaw);

  const clearedAt = Math.max(local.clearedAt || 0, remote.clearedAt || 0);

  const combinedDismissed = {};
  for (const [k, ts] of Object.entries(remote.dismissed || {})) {
    const ck = resolveCanonicalTrueId(k);
    if (ck) combinedDismissed[ck] = Math.max(combinedDismissed[ck] || 0, ts);
  }
  for (const [k, ts] of Object.entries(local.dismissed || {})) {
    const ck = resolveCanonicalTrueId(k);
    if (ck) combinedDismissed[ck] = Math.max(combinedDismissed[ck] || 0, ts);
  }
  const dismissed = pruneDismissed(combinedDismissed);

  const byTrueId = new Map();
  for (const entry of [...local.items, ...remote.items]) {
    if (!entry || entry.id == null) continue;
    const sid = String(entry.id);
    const trueId = resolveCanonicalTrueId(sid, entry.trueId);
    const ts = Number(entry.ts) || 0;
    if (!trueId) continue;
    const prev = byTrueId.get(trueId);
    if (!prev || ts > prev.ts) {
      byTrueId.set(trueId, { id: sid, trueId, ts });
    }
  }

  const items = [...byTrueId.values()]
    .filter(item => item.ts > clearedAt && item.ts > (dismissed[item.trueId] || 0))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_RECENT_STORED);

  return { items, clearedAt, dismissed };
}

function areRecentStatesEqual(a, b) {
  if (!a || !b) return false;
  if ((a.clearedAt || 0) !== (b.clearedAt || 0)) return false;
  const aItems = Array.isArray(a.items) ? a.items : [];
  const bItems = Array.isArray(b.items) ? b.items : [];
  if (aItems.length !== bItems.length) return false;
  for (let i = 0; i < aItems.length; i++) {
    if (
      aItems[i].id !== bItems[i].id ||
      aItems[i].trueId !== bItems[i].trueId ||
      aItems[i].ts !== bItems[i].ts
    ) {
      return false;
    }
  }
  const aDis = a.dismissed || {};
  const bDis = b.dismissed || {};
  const aKeys = Object.keys(aDis);
  const bKeys = Object.keys(bDis);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (aDis[k] !== bDis[k]) return false;
  }
  return true;
}

function loadRecentState() {
  if (_recentState && typeof _recentState === 'object') {
    return _recentState;
  }
  try {
    // Purge legacy keys that contained old fallback PDFs
    safeStorageRemove(LEGACY_RECENT_V1);
    safeStorageRemove(LEGACY_RECENT_V2);

    const rawV3 = safeStorageGet(RECENT_READS_KEY);
    if (rawV3) {
      _recentState = normalizeRecentState(rawV3);
      return _recentState;
    }
  } catch {}
  _recentState = { items: [], clearedAt: 0, dismissed: {} };
  return _recentState;
}

function saveRecentState(state, { skipCloud = false } = {}) {
  const normalized = normalizeRecentState(state);
  _recentState = normalized;
  try {
    const payload = JSON.stringify(normalized);
    safeStorageSet(RECENT_READS_KEY, payload);
    if (!skipCloud) {
      dbSetSetting(RECENT_READS_KEY, payload).catch(() => {});
    }
  } catch {}
  return normalized;
}

function syncSidebarRecentPDFs() {
  const recent = getRecentPdfsForShelf(5).map(entry => entry.pdf);
  S.recentPDFs = recent;
  import('./viewer.js').then(m => m.renderRecentPDFs?.()).catch(() => {});
}

export function pushRecentPdfId(pdfId) {
  if (!pdfId) return;
  const sid = String(pdfId);
  const trueId = resolveCanonicalTrueId(sid);
  if (!trueId) return;
  const current = loadRecentState();
  const ts = Math.max(
    Date.now(),
    (current.clearedAt || 0) + 1,
    (current.dismissed?.[trueId] || 0) + 1
  );
  const remaining = current.items.filter(
    e => String(e.id) !== sid && resolveCanonicalTrueId(e.id, e.trueId) !== trueId
  );
  const nextItems = [{ id: sid, trueId, ts }, ...remaining]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_RECENT_STORED);
  saveRecentState({
    items: nextItems,
    clearedAt: current.clearedAt,
    dismissed: current.dismissed,
  });
  syncSidebarRecentPDFs();
  if (typeof document !== 'undefined' && document.getElementById('welcome-calendar')) {
    renderStudyDesk({ skipSchedule: true });
  }
}

export function removeRecentRead(pdfId, e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  if (pdfId == null) return;
  const sid = String(pdfId);
  const trueId = resolveCanonicalTrueId(sid);
  if (!trueId) return;
  const current = loadRecentState();
  let maxMatchingTs = 0;
  const nextItems = [];
  for (const item of current.items) {
    const itemTrueId = resolveCanonicalTrueId(item.id, item.trueId);
    if (String(item.id) === sid || itemTrueId === trueId) {
      if ((item.ts || 0) > maxMatchingTs) maxMatchingTs = item.ts || 0;
    } else {
      nextItems.push(item);
    }
  }
  const dismissTs = Math.max(Date.now(), current.dismissed?.[trueId] || 0, maxMatchingTs);
  const nextDismissed = pruneDismissed({
    ...(current.dismissed || {}),
    [trueId]: dismissTs,
  });
  saveRecentState({
    items: nextItems,
    clearedAt: current.clearedAt,
    dismissed: nextDismissed,
  });
  syncSidebarRecentPDFs();
  renderStudyDesk({ skipSchedule: true });
}

export function clearAllRecentReads(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  const current = loadRecentState();
  const maxItemTs = current.items.reduce((acc, item) => Math.max(acc, item.ts || 0), 0);
  const clearedAt = Math.max(Date.now(), current.clearedAt || 0, maxItemTs);
  saveRecentState({
    items: [],
    clearedAt,
    dismissed: current.dismissed,
  });
  syncSidebarRecentPDFs();
  renderStudyDesk({ skipSchedule: true });
}

export function applyRemoteRecentReads(rawVal) {
  if (rawVal === null || rawVal === undefined || rawVal === '') return;
  const currentLocal = loadRecentState();
  const remote = normalizeRecentState(rawVal);
  const merged = mergeRecentStates(currentLocal, remote);
  const localChanged = !areRecentStatesEqual(merged, currentLocal);
  _recentState = merged;
  if (localChanged) {
    try {
      safeStorageSet(RECENT_READS_KEY, JSON.stringify(merged));
    } catch {}
  }
  syncSidebarRecentPDFs();
  renderStudyDesk({ skipSchedule: true });
}

function hydrateRecentReadsFromCloud() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  dbGetSetting(RECENT_READS_KEY).then(cloudRaw => {
    if (cloudRaw === null || cloudRaw === undefined || cloudRaw === '') return;
    const currentLocal = loadRecentState();
    const remote = normalizeRecentState(cloudRaw);
    const merged = mergeRecentStates(currentLocal, remote);
    const localChanged = !areRecentStatesEqual(merged, currentLocal);
    const remoteMissingLocalData = !areRecentStatesEqual(merged, remote);
    _recentState = merged;
    if (localChanged) {
      try {
        safeStorageSet(RECENT_READS_KEY, JSON.stringify(merged));
      } catch {}
    }
    if (remoteMissingLocalData) {
      dbSetSetting(RECENT_READS_KEY, JSON.stringify(merged)).catch(() => {});
    }
    syncSidebarRecentPDFs();
    renderStudyDesk({ skipSchedule: true });
  }).catch(() => {});
}

function formatRelativeTime(ts) {
  if (!ts) return 'Recent';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return 'Recent';
  }
}

export function getRecentPdfsForShelf(limit = 6) {
  const state = loadRecentState();
  const pdfs = Array.isArray(S.pdfs) ? S.pdfs : [];
  const entries = [...state.items].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const found = [];
  const seenTrueIds = new Set();

  for (const entry of entries) {
    const sid = String(entry.id);
    const trueId = resolveCanonicalTrueId(sid, entry.trueId);
    if (!trueId || seenTrueIds.has(trueId)) continue;
    if (entry.ts <= (state.clearedAt || 0) || entry.ts <= (state.dismissed?.[trueId] || 0)) continue;

    const p =
      pdfs.find(x => String(x.id) === sid && !isPdfArchived(x)) ||
      pdfs.find(x => String(x.id) === trueId && !isPdfArchived(x)) ||
      pdfs.find(x => String(x.linked_pdf_id || x.id) === trueId && !isPdfArchived(x));

    if (p) {
      const resolvedTrueId = String(p.linked_pdf_id || p.id);
      if (!seenTrueIds.has(resolvedTrueId)) {
        seenTrueIds.add(trueId);
        seenTrueIds.add(resolvedTrueId);
        found.push({ pdf: p, ts: entry.ts });
      }
    }
    if (found.length >= limit) break;
  }

  return found;
}

export function openSubjectBinderByTitle(rawTitle) {
  const activeSubjects = (S.subjects || []).filter(s => !isSubjectArchived(s.id));
  if (!rawTitle || !activeSubjects.length) return false;
  const q = rawTitle.toLowerCase();
  const codeMatch = q.match(/\b(\d{3})\b/);
  const code = codeMatch ? codeMatch[1] : null;

  let matchedSubj = null;
  if (code) {
    matchedSubj = activeSubjects.find(s => s.name.toLowerCase().includes(code));
  }
  if (!matchedSubj) {
    const keywords = q
      .replace(/^\d+\s*:\s*/, '')
      .split(/\s+/)
      .filter(w => w.length >= 4 && w !== 'and');
    matchedSubj = activeSubjects.find(s => {
      const sn = s.name.toLowerCase();
      return keywords.some(kw => sn.includes(kw));
    });
  }

  if (!matchedSubj) {
    toast(`Tip: Create or open "${rawTitle}" in the Library sidebar on the left.`);
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
  toast(`Opened "${matchedSubj.name}" binder`);
  return true;
}

function escDeskHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderStudyDesk(options = {}) {
  const cal = document.getElementById('welcome-calendar');
  if (!cal) return;

  // 1. Calculate Semester Digest Stats (count unique canonical PDFs)
  const activePdfs = (Array.isArray(S.pdfs) ? S.pdfs : []).filter(p => !isPdfArchived(p));
  let digestedCount = 0;
  const totalCases = activePdfs.length;
  for (const p of activePdfs) {
    if (hasCaseDigest(p)) digestedCount++;
  }

  // Populate Study Desk header stats slot when mounted
  const statsSlot = document.getElementById('gn-desk-stats-slot');
  if (statsSlot) {
    statsSlot.innerHTML = `<span class="desk__stats-value">${digestedCount} / ${totalCases}</span><span class="desk__stats-label">digested</span>`;
  }

  // 2. Ensure Active Folios / Continue Studying Shelf sits AFTER .docket / .cal-grid
  const docketEl = cal.querySelector('section.docket') || cal.querySelector('.docket') || cal.querySelector('.cal-grid');
  const quoteEl = cal.querySelector('.desk-quote');
  let shelf = document.getElementById('gn-study-shelf');
  if (!shelf) {
    shelf = document.createElement('div');
    shelf.id = 'gn-study-shelf';
  }
  if (docketEl && docketEl.parentElement === cal) {
    if (docketEl.nextElementSibling !== shelf) {
      docketEl.insertAdjacentElement('afterend', shelf);
    }
  } else if (quoteEl && quoteEl.parentElement === cal) {
    if (shelf.nextElementSibling !== quoteEl) {
      cal.insertBefore(shelf, quoteEl);
    }
  } else if (shelf.parentElement !== cal) {
    cal.appendChild(shelf);
  }

  const recentItems = getRecentPdfsForShelf(6);
  if (recentItems.length > 0) {
    shelf.style.display = 'block';
    shelf.innerHTML = `
      <div class="gn-shelf-hd desk__section-head">
        <span class="desk__section-label" style="display:inline-flex;align-items:center;gap:6px;"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-book"/></svg><span>ACTIVE FOLIOS · CONTINUE STUDYING</span></span>
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="gn-shelf-sub">Your most recently opened cases</span>
          <button type="button" class="gn-shelf-clear" title="Clear Continue Studying list">Clear list</button>
        </div>
      </div>
      <div class="gn-shelf-grid folios" aria-label="Case folios"></div>
    `;
    shelf.querySelector('.gn-shelf-clear')?.addEventListener('click', e => clearAllRecentReads(e));
    const grid = shelf.querySelector('.gn-shelf-grid');
    recentItems.forEach(({ pdf, ts }, i) => {
      const subj = getSubjectForPdf(pdf);
      const fold = S.folders.find(f => f.id === pdf.folder_id);
      const spineColor = getSubjectBinderColor(subj, i);
      const digested = hasCaseDigest(pdf);
      const stClass = digested ? 'read' : '';
      const stLabel = digested ? 'Digest Ready' : 'No Digest Yet';
      const stIcon = digested ? 'i-scale' : 'i-note';
      const timeLabel = formatRelativeTime(ts);

      const card = document.createElement('div');
      card.className = 'gn-notebook-card gn-folio-card folio';
      card.dataset.caseId = String(pdf.id);
      card.style.setProperty('--spine-color', spineColor);
      card.style.setProperty('--spine', spineColor);
      card.innerHTML = `
        <div class="gn-nb-body" style="padding:0;gap:6px;">
          <div class="gn-nb-top-row folio__top">
            <div class="gn-nb-meta gn-folio-subj folio__subject">${escDeskHtml(subj ? subj.name : 'Library')}${fold ? ' › ' + escDeskHtml(fold.name) : ''}</div>
            <div style="display:inline-flex;align-items:center;gap:6px;">
              ${i === 0 ? '<span class="folio__badge">Continue reading</span>' : ''}
              <button type="button" class="gn-nb-dismiss" title="Remove from Continue Studying" aria-label="Remove from Continue Studying"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-close"/></svg></button>
            </div>
          </div>
          <div class="gn-nb-title gn-folio-title folio__title" style="font-family:var(--font-display);" title="${escDeskHtml(pdf.name)}">${escDeskHtml(pdf.name)}</div>
          <div class="gn-nb-footer gn-folio-meta folio__footer">
            <span class="gn-nb-status folio__status ${stClass}" data-digest="${digested ? 'ready' : 'none'}" style="display:inline-flex;align-items:center;gap:4px;"><svg class="icon icon-sm" aria-hidden="true"><use href="#${stIcon}"/></svg><span>${stLabel}</span></span>
            <span class="gn-nb-time folio__pages" style="font-family:var(--font-mono, var(--font-num));font-variant-numeric:tabular-nums;">${timeLabel}</span>
          </div>
        </div>
      `;
      const dismissBtn = card.querySelector('.gn-nb-dismiss');
      if (dismissBtn) {
        dismissBtn.addEventListener('pointerdown', e => e.stopPropagation());
        dismissBtn.addEventListener('click', e => removeRecentRead(pdf.id, e));
      }
      card.addEventListener('click', async (e) => {
        if (e.target.closest('.gn-nb-dismiss')) return;
        const { openPDFFromLibrary } = await import('./viewer.js');
        openPDFFromLibrary(pdf);
      });
      grid.appendChild(card);
    });
  } else {
    shelf.style.display = 'block';
    shelf.innerHTML = `
      <div class="gn-shelf-hd desk__section-head">
        <span class="desk__section-label" style="display:inline-flex;align-items:center;gap:6px;"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-book"/></svg><span>ACTIVE FOLIOS · CONTINUE STUDYING</span></span>
      </div>
      <div class="gn-shelf-empty" style="padding:18px 20px;border:1px dashed var(--hairline, var(--border, rgba(128,128,128,0.28)));border-radius:10px;color:var(--ink-muted, var(--muted));font-size:13px;display:flex;align-items:center;gap:10px;">
        <svg class="icon icon-sm" aria-hidden="true" style="opacity:0.7;flex-shrink:0;"><use href="#i-note"/></svg>
        <span>Open any PDF or case to resume studying here.</span>
      </div>
    `;
  }

  // 3. Connect Study Desk Schedule to schedule.js & Enhance Class Schedule Cards
  if (!options?.skipSchedule) {
    import('./schedule.js').then(m => m.renderEditableSchedule?.({ fromStudyDesk: true })).catch(() => {});
  }

  cal.querySelectorAll('.cal-item').forEach(item => {
    const strong = item.querySelector('strong');
    if (!strong) return;
    const subjTitle = strong.textContent.trim();
    if (!item.style.getPropertyValue('--spine')) {
      const color = getSubjectBinderColor({ name: subjTitle });
      item.style.setProperty('--spine', color || 'var(--accent)');
    }
    item.style.removeProperty('border-left');

    if (!item.querySelector('.gn-cal-actions')) {
      const bar = document.createElement('div');
      bar.className = 'gn-cal-actions';
      bar.innerHTML = `
        <span class="gn-cal-open-binder" style="display:inline-flex;align-items:center;gap:4px;" title="Open ${escDeskHtml(subjTitle)} binder in Library"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-book"/></svg><span>Open Syllabus</span><svg class="icon icon-sm" aria-hidden="true"><use href="#i-arrow-right"/></svg></span>
        <button class="gn-cal-note-btn" type="button" style="display:inline-flex;align-items:center;gap:4px;" title="Open quick class notes for ${escDeskHtml(subjTitle)}"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-note"/></svg><span>Note</span></button>
      `;
      item.appendChild(bar);
    }
  });

  if (!cal.querySelector('.desk-quote')) {
    const quote = document.createElement('blockquote');
    quote.className = 'desk-quote cal-quote';
    quote.style.fontFamily = 'var(--font-display)';
    quote.textContent = '“Lex scripta manet — the written law endures.”';
    cal.appendChild(quote);
  }
}

// ── 6. Initialize All GoodNotes UI Upgrades ─────────────────────────────────
export function initGoodNotesUI() {
  try { initStorageManager(); } catch {}
  // Capture pristine #welcome HTML before any tab or PDF overwrites #canvas-scroll
  import('./viewer.js').then(m => m.getWelcomeHTML?.()).catch(() => {});

  applyAppTheme(getAppTheme());
  loadSavedTabs();
  loadRecentState();
  syncSidebarRecentPDFs();
  renderDocTabs();
  renderStudyDesk();
  hydrateRecentReadsFromCloud();

  document.getElementById('btn-theme-toggle')?.addEventListener('click', (e) => cycleAppTheme(e));
  document.getElementById('skin-switch-rail')?.addEventListener('click', (e) => cycleAppTheme(e));

  // Background timer to prune inactive tabs every 20 seconds and on window focus/visibility change
  setInterval(pruneInactiveTabs, 20000);
  window.addEventListener('focus', () => {
    pruneInactiveTabs();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      pruneInactiveTabs();
    }
  });
}
