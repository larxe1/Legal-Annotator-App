// ═══════════════════════════════════════════════════════════════════════════
// TAGS & TOPIC COVERAGE WORKSPACE — Tags, Quick Step Scroll, & Outside Laws
// ═══════════════════════════════════════════════════════════════════════════
import { S } from './state.js';
import { rectToPx, compareAnnotationsReadingOrder, getAnnotationsForPage, getAnnotationById } from './annotate.js';
import { toast, autosave, closeOtherPanels } from './ui.js';
import { dbGetSetting, dbSetSetting } from './db.js';
import { safeStorageSet, safeStorageGet, scheduleDebouncedLocalAnnsSave } from './storage.js';
import { exportTagNotesToPDF } from './export.js';
import {
  handlePaste, handleCopy, showTablePicker, insertBannerHeader,
  outdentLine, indentLine, copyFirstSummaryTable
} from './tablepicker.js';

// ── Color Palette for Topics ──
export const TOPIC_PALETTE = [
  '#F59E0B', // Amber / Gold
  '#10B981', // Emerald Green
  '#0EA5E9', // Sky Blue
  '#8B5CF6', // Purple
  '#F43F5E', // Rose
  '#14B8A6', // Teal
  '#F97316', // Orange
  '#6366F1', // Indigo
  '#EC4899', // Pink
  '#84CC16', // Lime
  '#06B6D4', // Cyan
  '#EAB308', // Yellow
];

export function pickTopicColor(name) {
  if (!name) return TOPIC_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return TOPIC_PALETTE[Math.abs(hash) % TOPIC_PALETTE.length];
}

// ── In-Memory Active Tag State ──
let currentPdfTrueId = null;
let currentTagData = {
  updatedAt: Date.now(),
  annTags: {}, // ann_id -> ["Week 1", "Topic 1"]
  topics: {},  // topic_name -> { name, color, notesHtml, createdAt, updatedAt }
};

let _activeQuickTag = null;
let _cloudSaveTimer = null;
let _topicNotesSaveTimer = null;
let selectedFilterTag = 'ALL';
let activeNotesTopic = null;
let _tagJumpIndices = {};
let _singleTopicRenderGen = 0;

// ── Lazily-Invalidated Tag Index: Map<tagName, Ann[]> ──
let _tagIndexMap = new Map();
let _tagIndexTaggedCount = 0;
let _tagIndexVersion = 0;
let _tagIndexBuiltVersion = -1;
let _tagIndexAnnsRef = null;
let _tagIndexAnnsLen = -1;

function _invalidateTagIndex() {
  _tagIndexVersion++;
}

function _ensureTagIndex() {
  const anns = Array.isArray(S.annotations) ? S.annotations : [];
  if (
    _tagIndexBuiltVersion !== _tagIndexVersion ||
    _tagIndexAnnsRef !== anns ||
    _tagIndexAnnsLen !== anns.length
  ) {
    const nextMap = new Map();
    let taggedCount = 0;
    for (const ann of anns) {
      if (!ann) continue;
      const tags = getAnnTags(ann);
      if (!tags || tags.length === 0) continue;
      taggedCount++;
      const seenForAnn = tags.length > 1 ? new Set() : null;
      for (const t of tags) {
        if (seenForAnn) {
          if (seenForAnn.has(t)) continue;
          seenForAnn.add(t);
        }
        let arr = nextMap.get(t);
        if (!arr) {
          arr = [];
          nextMap.set(t, arr);
        }
        arr.push(ann);
      }
    }
    _tagIndexMap = nextMap;
    _tagIndexTaggedCount = taggedCount;
    _tagIndexBuiltVersion = _tagIndexVersion;
    _tagIndexAnnsRef = anns;
    _tagIndexAnnsLen = anns.length;
  }
  return _tagIndexMap;
}

function _getAnnsForTag(tagName) {
  if (!tagName) return [];
  return _ensureTagIndex().get(tagName) || [];
}

function getCurTrueId() {
  if (currentPdfTrueId) return currentPdfTrueId;
  if (S.curPDF) return S.curPDF.linked_pdf_id || S.curPDF.id;
  return null;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Sync in-memory ann.tags with currentTagData ──
function syncAnnTagsWithState() {
  if (!S.annotations || !Array.isArray(S.annotations)) return;
  let changed = false;
  for (const ann of S.annotations) {
    const fromMap = currentTagData.annTags[ann.id];
    if (fromMap && Array.isArray(fromMap)) {
      ann.tags = [...fromMap];
    } else if (ann.tags && Array.isArray(ann.tags) && ann.tags.length > 0) {
      currentTagData.annTags[ann.id] = [...ann.tags];
      for (const t of ann.tags) {
        if (!currentTagData.topics[t]) {
          currentTagData.topics[t] = {
            name: t,
            color: pickTopicColor(t),
            notesHtml: '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        }
      }
      changed = true;
    } else {
      ann.tags = [];
    }
  }
  if (changed && currentPdfTrueId) {
    currentTagData.updatedAt = Date.now();
    safeStorageSet('local_pdf_tags_v1_' + currentPdfTrueId, JSON.stringify(currentTagData));
  }
  _invalidateTagIndex();
}

// ── Schedule Debounced Cloud Save to Supabase app_settings ──
function scheduleCloudSave(trueId) {
  if (!trueId) return;
  clearTimeout(_cloudSaveTimer);
  _cloudSaveTimer = setTimeout(async () => {
    try {
      if (currentPdfTrueId === trueId && currentTagData) {
        await dbSetSetting('pdf_tags_v1_' + trueId, JSON.stringify(currentTagData));
      }
    } catch (e) {
      console.warn('[Tags] Cloud save error', e);
    }
  }, 450);
}

// ── 1. Load Tags for PDF ──
export async function loadTagsForPdf(trueId) {
  if (!trueId) return null;
  const isSwitchingPdf = currentPdfTrueId !== trueId;
  currentPdfTrueId = trueId;

  // 1) Instant restore from localStorage (0ms)
  let localData = null;
  try {
    const raw = safeStorageGet('local_pdf_tags_v1_' + trueId);
    if (raw) localData = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn('[Tags] Parse local tags cache error', e);
  }

  if (!localData || typeof localData !== 'object' || !localData.annTags) {
    localData = {
      updatedAt: Date.now(),
      annTags: {},
      topics: {},
    };
  }

  currentTagData = localData;
  syncAnnTagsWithState();
  redrawAllTagBadges();

  if (isSwitchingPdf) {
    selectedFilterTag = 'ALL';
    _activeQuickTag = safeStorageGet('active_quick_tag_' + trueId, '') || null;
    updateQuickTagUI();
  }

  if (isTagsPanelOpen()) {
    renderTagsPanel();
  }

  // 2) Background cloud sync via Supabase app_settings
  try {
    const cloudRaw = await dbGetSetting('pdf_tags_v1_' + trueId);
    if (cloudRaw) {
      const cloudData = typeof cloudRaw === 'string' ? JSON.parse(cloudRaw) : cloudRaw;
      if (cloudData && typeof cloudData === 'object' && cloudData.annTags) {
        const cloudTime = cloudData.updatedAt || 0;
        const localTime = currentTagData.updatedAt || 0;

        if (cloudTime > localTime) {
          currentTagData = cloudData;
          safeStorageSet('local_pdf_tags_v1_' + trueId, JSON.stringify(currentTagData));
          syncAnnTagsWithState();
          redrawAllTagBadges();
          if (isTagsPanelOpen()) renderTagsPanel();
        } else if (localTime > cloudTime) {
          dbSetSetting('pdf_tags_v1_' + trueId, JSON.stringify(currentTagData)).catch(() => {});
        }
      }
    } else if (Object.keys(currentTagData.annTags).length > 0 || Object.keys(currentTagData.topics).length > 0) {
      dbSetSetting('pdf_tags_v1_' + trueId, JSON.stringify(currentTagData)).catch(() => {});
    }
  } catch (err) {
    console.warn('[Tags] Background cloud sync error', err);
  }

  return currentTagData;
}

// ── 2. Tag Queries & Mutators ──
export function getAnnTags(ann) {
  if (!ann) return [];
  if (Array.isArray(ann.tags) && ann.tags.length > 0) {
    return ann.tags;
  }
  if (currentTagData?.annTags?.[ann.id]) {
    const list = currentTagData.annTags[ann.id];
    if (Array.isArray(list)) return list;
  }
  return [];
}

export async function addTagToAnn(ann, tagName, options = {}) {
  if (!ann || !tagName) return;
  const tag = tagName.trim();
  if (!tag) return;

  const trueId = ann.pdf_file_id || getCurTrueId();
  if (!trueId) return;

  if (!currentTagData || currentPdfTrueId !== trueId) {
    await loadTagsForPdf(trueId);
  }

  if (!Array.isArray(ann.tags)) ann.tags = [];
  if (!ann.tags.includes(tag)) {
    ann.tags.push(tag);
  }

  if (!currentTagData.annTags) currentTagData.annTags = {};
  if (!currentTagData.annTags[ann.id]) currentTagData.annTags[ann.id] = [];
  if (!currentTagData.annTags[ann.id].includes(tag)) {
    currentTagData.annTags[ann.id].push(tag);
  }

  if (!currentTagData.topics) currentTagData.topics = {};
  if (!currentTagData.topics[tag]) {
    currentTagData.topics[tag] = {
      name: tag,
      color: pickTopicColor(tag),
      notesHtml: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  } else {
    currentTagData.topics[tag].updatedAt = Date.now();
  }

  currentTagData.updatedAt = Date.now();
  _invalidateTagIndex();

  safeStorageSet('local_pdf_tags_v1_' + trueId, JSON.stringify(currentTagData));
  if (!options.skipSaveAnn && trueId) {
    scheduleDebouncedLocalAnnsSave(trueId, () => S.annotations);
  }

  scheduleCloudSave(trueId);

  if (!options.skipRedraw) {
    redrawTagBadgeForAnn(ann);
  }

  if (S.selAnn?.id === ann.id) {
    renderAnnPanelTagsSection(ann);
  }

  if (isTagsPanelOpen()) {
    renderTagsPanel();
  }
}

export async function removeTagFromAnn(ann, tagName, options = {}) {
  if (!ann || !tagName) return;
  const tag = tagName.trim();
  const trueId = ann.pdf_file_id || getCurTrueId();
  if (!trueId) return;

  if (Array.isArray(ann.tags)) {
    ann.tags = ann.tags.filter(t => t !== tag);
  }
  if (currentTagData?.annTags?.[ann.id]) {
    currentTagData.annTags[ann.id] = currentTagData.annTags[ann.id].filter(t => t !== tag);
    if (currentTagData.annTags[ann.id].length === 0) {
      delete currentTagData.annTags[ann.id];
    }
  }

  if (currentTagData) {
    currentTagData.updatedAt = Date.now();
    safeStorageSet('local_pdf_tags_v1_' + trueId, JSON.stringify(currentTagData));
  }
  _invalidateTagIndex();

  if (!options.skipSaveAnn && trueId) {
    scheduleDebouncedLocalAnnsSave(trueId, () => S.annotations);
  }

  scheduleCloudSave(trueId);

  redrawTagBadgeForAnn(ann);

  if (S.selAnn?.id === ann.id) {
    renderAnnPanelTagsSection(ann);
  }

  if (isTagsPanelOpen()) {
    renderTagsPanel();
  }
}

export async function addTagToAnnsBatch(anns, tagName) {
  if (!Array.isArray(anns) || anns.length === 0 || !tagName) return 0;
  const tag = String(tagName).trim();
  if (!tag) return 0;

  const validAnns = anns.filter(a => a && a.id);
  if (validAnns.length === 0) return 0;

  const trueId = validAnns[0].pdf_file_id || getCurTrueId();
  if (!trueId) return 0;

  if (!currentTagData || currentPdfTrueId !== trueId) {
    await loadTagsForPdf(trueId);
  }

  if (!currentTagData.annTags) currentTagData.annTags = {};
  if (!currentTagData.topics) currentTagData.topics = {};

  const now = Date.now();
  if (!currentTagData.topics[tag]) {
    currentTagData.topics[tag] = {
      name: tag,
      color: pickTopicColor(tag),
      notesHtml: '',
      createdAt: now,
      updatedAt: now,
    };
  } else {
    currentTagData.topics[tag].updatedAt = now;
  }

  const modifiedAnns = [];
  for (const ann of validAnns) {
    let changed = false;
    if (!Array.isArray(ann.tags)) ann.tags = [];
    if (!ann.tags.includes(tag)) {
      ann.tags.push(tag);
      changed = true;
    }
    if (!Array.isArray(currentTagData.annTags[ann.id])) {
      currentTagData.annTags[ann.id] = [...ann.tags];
    }
    if (!currentTagData.annTags[ann.id].includes(tag)) {
      currentTagData.annTags[ann.id].push(tag);
      changed = true;
    }
    if (changed) {
      modifiedAnns.push(ann);
    }
  }

  currentTagData.updatedAt = now;
  _invalidateTagIndex();
  safeStorageSet('local_pdf_tags_v1_' + trueId, JSON.stringify(currentTagData));
  scheduleDebouncedLocalAnnsSave(trueId, () => S.annotations);
  scheduleCloudSave(trueId);

  for (const ann of modifiedAnns) {
    const pg = S.pages?.[ann.page];
    if (pg && pg.rendered && pg.annOv) {
      redrawTagBadgeForAnn(ann, pg.viewport || pg.wrap);
    }
  }

  const annPanelOpen = document.getElementById('ann-panel')?.classList.contains('open');
  if (annPanelOpen && S.selAnn && validAnns.some(a => a.id === S.selAnn.id)) {
    renderAnnPanelTagsSection(S.selAnn);
  }

  if (isTagsPanelOpen()) {
    renderTagsPanel();
  }

  return modifiedAnns.length;
}

export async function removeTagFromAnnsBatch(anns, tagName) {
  if (!Array.isArray(anns) || anns.length === 0 || !tagName) return 0;
  const tag = String(tagName).trim();
  if (!tag) return 0;

  const validAnns = anns.filter(a => a && a.id);
  if (validAnns.length === 0) return 0;

  const trueId = validAnns[0].pdf_file_id || getCurTrueId();
  if (!trueId) return 0;

  if (!currentTagData || currentPdfTrueId !== trueId) {
    await loadTagsForPdf(trueId);
  }

  const modifiedAnns = [];
  for (const ann of validAnns) {
    let changed = false;
    if (Array.isArray(ann.tags) && ann.tags.includes(tag)) {
      ann.tags = ann.tags.filter(t => t !== tag);
      changed = true;
    }
    if (currentTagData?.annTags?.[ann.id] && currentTagData.annTags[ann.id].includes(tag)) {
      currentTagData.annTags[ann.id] = currentTagData.annTags[ann.id].filter(t => t !== tag);
      if (currentTagData.annTags[ann.id].length === 0) {
        delete currentTagData.annTags[ann.id];
      }
      changed = true;
    }
    if (changed) {
      modifiedAnns.push(ann);
    }
  }

  if (modifiedAnns.length === 0) return 0;

  if (currentTagData) {
    currentTagData.updatedAt = Date.now();
    safeStorageSet('local_pdf_tags_v1_' + trueId, JSON.stringify(currentTagData));
  }
  _invalidateTagIndex();
  scheduleDebouncedLocalAnnsSave(trueId, () => S.annotations);
  scheduleCloudSave(trueId);

  for (const ann of modifiedAnns) {
    const pg = S.pages?.[ann.page];
    if (pg && pg.rendered && pg.annOv) {
      redrawTagBadgeForAnn(ann, pg.viewport || pg.wrap);
    }
  }

  const annPanelOpen = document.getElementById('ann-panel')?.classList.contains('open');
  if (annPanelOpen && S.selAnn && modifiedAnns.some(a => a.id === S.selAnn.id)) {
    renderAnnPanelTagsSection(S.selAnn);
  }

  if (isTagsPanelOpen()) {
    renderTagsPanel();
  }

  return modifiedAnns.length;
}

export function getAllTopicsForCurrentPdf() {
  if (!currentTagData || !currentTagData.topics) return [];
  const map = _ensureTagIndex();
  const list = Object.values(currentTagData.topics);
  return list.map(t => {
    const count = map.get(t.name)?.length || 0;
    return { ...t, count };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function onAnnDeleted(annId) {
  if (!annId || !currentTagData) return;
  _invalidateTagIndex();
  if (currentTagData.annTags && currentTagData.annTags[annId]) {
    delete currentTagData.annTags[annId];
    currentTagData.updatedAt = Date.now();
    const trueId = getCurTrueId();
    if (trueId) {
      safeStorageSet('local_pdf_tags_v1_' + trueId, JSON.stringify(currentTagData));
      scheduleCloudSave(trueId);
    }
    if (isTagsPanelOpen()) renderTagsPanel();
  }
}

// ── Active Quick-Tag for Instant Tagging ──
export function getActiveQuickTag() {
  const trueId = getCurTrueId();
  if (!trueId) return null;
  if (_activeQuickTag !== null) return _activeQuickTag;
  const saved = safeStorageGet('active_quick_tag_' + trueId, '');
  _activeQuickTag = saved || null;
  return _activeQuickTag;
}

export function setActiveQuickTag(tagName) {
  const trueId = getCurTrueId();
  const val = tagName ? tagName.trim() : null;
  _activeQuickTag = val || null;
  if (trueId) {
    if (val) safeStorageSet('active_quick_tag_' + trueId, val);
    else safeStorageSet('active_quick_tag_' + trueId, '');
  }
  updateQuickTagUI();
}

function updateQuickTagUI() {
  const active = getActiveQuickTag();
  const selBtnText = document.getElementById('sel-tag-text');
  if (selBtnText) {
    selBtnText.textContent = active ? `🏷️ ${active}` : '🏷️ Tag';
  }
  const quickSelect = document.getElementById('ap-quick-tag-select');
  if (quickSelect) {
    quickSelect.value = active || '';
  }
  const tpQuickChip = document.getElementById('tp-active-quick-tag-lbl');
  if (tpQuickChip) {
    tpQuickChip.textContent = active ? `⚡ Active: ${active}` : '⚡ Quick-Tag: Off';
  }
}

// ── 3. Render Tags Section in #ann-panel ──
export function renderAnnPanelTagsSection(ann) {
  if (!ann) return;
  let container = document.getElementById('ap-tags-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'ap-tags-container';
    container.className = 'ap-tags-container';
    const colorsEl = document.getElementById('ap-colors');
    if (colorsEl && colorsEl.parentNode) {
      colorsEl.parentNode.insertBefore(container, colorsEl.nextSibling);
    } else {
      document.getElementById('ann-panel')?.prepend(container);
    }
  }

  const assignedTags = getAnnTags(ann);
  const allTopics = getAllTopicsForCurrentPdf();
  const activeQuick = getActiveQuickTag();
  const unassignedTopics = allTopics.filter(t => !assignedTags.includes(t.name));

  let pillsHtml = '';
  if (assignedTags.length > 0) {
    pillsHtml = assignedTags.map(tagName => {
      const topic = currentTagData?.topics?.[tagName];
      const color = topic?.color || pickTopicColor(tagName);
      return `
        <span class="ap-tag-pill" style="border-color:${color}; background:${color}18; color:${color};" data-tag="${escapeHtml(tagName)}">
          <span class="ap-tag-pill-name" title="Click to view all provisions in Tags panel">🏷️ ${escapeHtml(tagName)}</span>
          <button class="ap-tag-pill-del" title="Remove tag">✕</button>
        </span>
      `;
    }).join('');
  } else {
    pillsHtml = '<span class="ap-tags-empty">No tags assigned yet.</span>';
  }

  let quickAddHtml = '';
  if (unassignedTopics.length > 0) {
    const buttons = unassignedTopics.slice(0, 5).map(t => {
      const color = t.color || pickTopicColor(t.name);
      return `
        <button class="ap-quick-add-btn" style="border-color:${color}50; color:${color};" data-add-tag="${escapeHtml(t.name)}" title="Add '${escapeHtml(t.name)}' in 1 click">
          + ${escapeHtml(t.name)}
        </button>
      `;
    }).join('');
    quickAddHtml = `
      <div class="ap-tags-quick-row">
        <span class="ap-quick-lbl">Quick Add:</span>
        <div class="ap-quick-btns">${buttons}</div>
      </div>
    `;
  }

  const optionsHtml = `
    <option value="" ${!activeQuick ? 'selected' : ''}>None (No auto-tag)</option>
    ${allTopics.map(t => `<option value="${escapeHtml(t.name)}" ${activeQuick === t.name ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
  `;

  container.innerHTML = `
    <div class="ap-tags-hd">
      <span class="ap-tags-hd-lbl">🏷️ Coverage Tags & Topics</span>
      <button class="ap-tags-open-menu-btn" id="ap-tags-open-menu" title="Open Tags & Topics Workspace">Workspace ↗</button>
    </div>
    <div class="ap-tags-pills-list">${pillsHtml}</div>
    ${quickAddHtml}
    <div class="ap-tags-input-row">
      <input type="text" id="ap-tag-input" class="ap-tag-input" placeholder='Add tag (e.g. "Week 1", "Topic 1")...' />
      <button id="ap-btn-add-tag" class="ap-btn-add-tag">+ Add</button>
    </div>
    <div class="ap-tags-quick-tag-row">
      <span class="ap-quick-tag-lbl" title="When set, all newly highlighted provisions automatically get this tag">⚡ Auto-tag new:</span>
      <select id="ap-quick-tag-select" class="ap-quick-tag-select">${optionsHtml}</select>
    </div>
  `;

  // Wire events
  container.querySelectorAll('.ap-tag-pill-name').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const tag = el.closest('.ap-tag-pill').dataset.tag;
      toggleTagsPanel(tag);
    });
  });

  container.querySelectorAll('.ap-tag-pill-del').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tag = el.closest('.ap-tag-pill').dataset.tag;
      await removeTagFromAnn(ann, tag);
    });
  });

  container.querySelectorAll('[data-add-tag]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tag = btn.dataset.addTag;
      await addTagToAnn(ann, tag);
    });
  });

  const input = container.querySelector('#ap-tag-input');
  const addBtn = container.querySelector('#ap-btn-add-tag');
  const doAdd = async () => {
    const val = input.value.trim();
    if (val) {
      input.value = '';
      await addTagToAnn(ann, val);
    }
  };
  addBtn.addEventListener('click', doAdd);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doAdd();
    }
  });

  container.querySelector('#ap-tags-open-menu')?.addEventListener('click', () => {
    toggleTagsPanel(assignedTags[0] || null);
  });

  const qSelect = container.querySelector('#ap-quick-tag-select');
  qSelect?.addEventListener('change', () => {
    setActiveQuickTag(qSelect.value || null);
  });
}

// ── 4. Floating Tag Pill Badge on PDF Highlights ──
export function redrawTagBadgeForAnn(ann, pageDims = null, skipRemove = false) {
  if (!ann) return;
  const pg = S.pages?.[ann.page];
  if (!pg || !pg.rendered || !pg.annOv) return;

  if (!skipRemove) {
    pg.annOv.querySelectorAll(`.ann-tag-pill-badge[data-id="${ann.id}"]`).forEach(el => el.remove());
  }

  const tags = getAnnTags(ann);
  if (!tags || tags.length === 0) return;

  const firstRect = ann.rects && ann.rects[0];
  if (!firstRect) return;
  const pxRect = rectToPx(firstRect, pageDims || pg.viewport || pg.wrap);

  const badge = document.createElement('div');
  badge.className = 'ann-tag-pill-badge';
  badge.dataset.id = ann.id;
  badge.style.left = `${Math.max(2, pxRect.x + pxRect.w - 6)}px`;
  badge.style.top = `${Math.max(2, pxRect.y - 12)}px`;

  const tagLabel = tags.length === 1 ? tags[0] : `${tags[0]} +${tags.length - 1}`;
  const topic = currentTagData?.topics?.[tags[0]];
  const color = topic?.color || pickTopicColor(tags[0]);

  badge.style.borderColor = `${color}99`;
  badge.style.color = color;
  badge.innerHTML = `<span style="font-size:10px">🏷️</span> <span class="tag-txt">${escapeHtml(tagLabel)}</span>`;
  badge.title = tags.join(', ') + ' (Click to open Tags Menu)';

  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTagsPanel(tags[0]);
  });

  pg.annOv.appendChild(badge);
}

export function redrawAllTagBadges() {
  if (!S.pages) return;
  for (const [pageKey, pg] of Object.entries(S.pages)) {
    if (!pg || !pg.rendered || !pg.annOv) continue;
    pg.annOv.querySelectorAll('.ann-tag-pill-badge').forEach(el => el.remove());
    const dims = pg.viewport || pg.wrap;
    const pageAnns = getAnnotationsForPage(Number(pageKey));
    for (const ann of pageAnns) {
      redrawTagBadgeForAnn(ann, dims, true);
    }
  }
}

// ── 5. Quick-Scroll & Flash Provision ──
export async function jumpToAnn(ann) {
  if (!ann) return;
  const { jumpToPage } = await import('./ui.js');
  await jumpToPage(ann.page);
  setTimeout(() => {
    const grp = document.querySelector(`.hi-grp[data-id="${ann.id}"]`);
    if (grp) {
      grp.scrollIntoView({ behavior: 'smooth', block: 'center' });
      grp.classList.remove('ann-tag-flash');
      void grp.offsetWidth;
      grp.classList.add('ann-tag-flash');
      setTimeout(() => grp.classList.remove('ann-tag-flash'), 2400);
    }
  }, 280);
}

export async function jumpThroughTag(tagName, direction = 1) {
  if (!tagName) return;
  const matching = [..._getAnnsForTag(tagName)];
  if (!matching.length) {
    toast(`No highlights tagged with "${tagName}"`);
    return;
  }
  matching.sort(compareAnnotationsReadingOrder);

  let curIdx = _tagJumpIndices[tagName] ?? -1;
  curIdx = (curIdx + direction + matching.length) % matching.length;
  _tagJumpIndices[tagName] = curIdx;

  const targetAnn = matching[curIdx];
  await jumpToAnn(targetAnn);

  const counter = document.getElementById('tp-jump-counter');
  if (counter) {
    counter.textContent = `${curIdx + 1} of ${matching.length}`;
  }
  toast(`Provision ${curIdx + 1} of ${matching.length} (Page ${targetAnn.page})`);
}

// ── 6. #tags-panel Slide-Out Menu ──
export function isTagsPanelOpen() {
  const panel = document.getElementById('tags-panel');
  return panel && panel.classList.contains('open');
}

export function toggleTagsPanel(initialTag = null) {
  const panel = document.getElementById('tags-panel');
  if (!panel) return;
  const isOpen = panel.classList.contains('open');

  if (isOpen && initialTag === null) {
    panel.classList.remove('open');
    return;
  }

  closeOtherPanels('tags-panel');
  panel.classList.add('open');

  if (initialTag) {
    selectedFilterTag = initialTag;
  }
  renderTagsPanel();
}

export function renderTagsPanel() {
  const panel = document.getElementById('tags-panel');
  if (!panel) return;

  const allTopics = getAllTopicsForCurrentPdf();
  _ensureTagIndex();
  const totalTaggedAnns = _tagIndexTaggedCount;

  // Header
  const hd = panel.querySelector('.tp-hd');
  if (hd) {
    hd.innerHTML = `
      <div class="tp-hd-title">
        <span class="tp-icon">🏷️</span>
        <span style="font-weight:700">Topic Coverage & Tags</span>
      </div>
      <button class="tp-close" id="tp-close-btn" title="Close Panel">✕</button>
    `;
    hd.querySelector('#tp-close-btn')?.addEventListener('click', () => panel.classList.remove('open'));
  }

  // Create Row
  const createBox = panel.querySelector('.tp-create-box');
  if (createBox) {
    createBox.innerHTML = `
      <div class="tp-create-row">
        <input type="text" id="tp-new-topic-input" class="tp-input" placeholder='New topic / week (e.g. "Week 1", "Topic 2")...' />
        <button id="tp-btn-create-topic" class="tp-btn-gold">+ Create</button>
      </div>
    `;
    const inp = createBox.querySelector('#tp-new-topic-input');
    const btn = createBox.querySelector('#tp-btn-create-topic');
    const handleCreate = async () => {
      const val = inp.value.trim();
      if (!val) return;
      inp.value = '';
      const trueId = getCurTrueId();
      if (!trueId) return toast('Please open a PDF first');
      if (!currentTagData.topics[val]) {
        currentTagData.topics[val] = {
          name: val,
          color: pickTopicColor(val),
          notesHtml: '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        currentTagData.updatedAt = Date.now();
        safeStorageSet('local_pdf_tags_v1_' + trueId, JSON.stringify(currentTagData));
        scheduleCloudSave(trueId);
      }
      selectedFilterTag = val;
      renderTagsPanel();
      toast(`Topic "${val}" created`);
    };
    btn.addEventListener('click', handleCreate);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCreate();
      }
    });
  }

  // Filter Chips Bar
  const chipsBar = panel.querySelector('.tp-filter-bar');
  if (chipsBar) {
    const isAll = selectedFilterTag === 'ALL';
    let chipsHtml = `
      <button class="tp-chip ${isAll ? 'active' : ''}" data-filter="ALL">
        <span>All Tags</span>
        <span class="tp-chip-cnt">${totalTaggedAnns}</span>
      </button>
    `;
    chipsHtml += allTopics.map(t => {
      const active = selectedFilterTag === t.name;
      const color = t.color || pickTopicColor(t.name);
      return `
        <button class="tp-chip ${active ? 'active' : ''}" data-filter="${escapeHtml(t.name)}" style="--chip-color:${color}">
          <span class="tp-chip-dot" style="background:${color}"></span>
          <span>${escapeHtml(t.name)}</span>
          <span class="tp-chip-cnt">${t.count}</span>
        </button>
      `;
    }).join('');
    chipsBar.innerHTML = chipsHtml;

    chipsBar.querySelectorAll('.tp-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedFilterTag = btn.dataset.filter;
        renderTagsPanel();
      });
    });
  }

  // Main Content Area
  const content = panel.querySelector('.tp-content');
  if (!content) return;

  if (selectedFilterTag !== 'ALL') {
    renderSingleTopicView(content, selectedFilterTag);
  } else {
    renderAllTopicsView(content, allTopics);
  }
}

function _buildTopicAnnCardHtml(ann) {
  const notes = Array.isArray(ann.notes) ? ann.notes : [];
  const hasCase = notes.some(n => n.note_html?.includes('data-note-type="case"'));
  const noteCount = notes.length;
  return `
    <div class="tp-ann-card" data-ann-id="${ann.id}">
      <div class="tp-ann-hd">
        <span class="tp-ann-page">Page ${ann.page}</span>
        <div class="tp-ann-badges">
          ${hasCase ? '<span class="tp-mini-badge case">⚖️ Case</span>' : ''}
          ${noteCount > 0 ? `<span class="tp-mini-badge note">📝 ${noteCount}</span>` : ''}
        </div>
        <button class="tp-ann-untag-btn" title="Remove tag from this provision" data-untag="${ann.id}">✕</button>
      </div>
      <div class="tp-ann-quote">"${escapeHtml(ann.highlighted_text || '(Box Highlight)')}"</div>
      <div class="tp-ann-ft">
        <button class="tp-ann-jump-btn" data-jump="${ann.id}">Jump to Provision ↗</button>
      </div>
    </div>
  `;
}

function renderSingleTopicView(container, tagName) {
  const myGen = ++_singleTopicRenderGen;
  const topic = currentTagData?.topics?.[tagName] || {
    name: tagName,
    color: pickTopicColor(tagName),
    notesHtml: '',
  };
  const color = topic.color || pickTopicColor(tagName);
  const matching = [..._getAnnsForTag(tagName)];
  matching.sort(compareAnnotationsReadingOrder);

  const curIdx = (_tagJumpIndices[tagName] ?? -1) + 1;
  const posLabel = matching.length > 0 ? (curIdx > 0 ? `${curIdx} of ${matching.length}` : `1 of ${matching.length}`) : '0 of 0';

  const shouldChunk = matching.length > 60;
  let initialListHtml = '';
  if (matching.length === 0) {
    initialListHtml = `
      <div class="tp-empty">
        <div style="font-size:32px;margin-bottom:8px">🏷️</div>
        <div style="font-weight:600;color:#e8e4db;margin-bottom:4px">No highlights tagged "${escapeHtml(tagName)}" yet.</div>
        <div style="font-size:12px;color:var(--muted);line-height:1.5">Highlight provisions in the codal and click <strong>+ ${escapeHtml(tagName)}</strong> in the Notes Panel to link them to this topic!</div>
      </div>
    `;
  } else if (!shouldChunk) {
    initialListHtml = matching.map(_buildTopicAnnCardHtml).join('');
  }

  container.innerHTML = `
    <div class="tp-topic-card" style="border-left: 4px solid ${color};">
      <div class="tp-tc-header">
        <div class="tp-tc-title-row">
          <span class="tp-tc-dot" style="background:${color}"></span>
          <span class="tp-tc-title">${escapeHtml(tagName)}</span>
        </div>
        <span class="tp-tc-cnt">${matching.length} highlighted provision${matching.length === 1 ? '' : 's'}</span>
      </div>

      <div class="tp-tc-actions">
        <button class="tp-btn-open-notes" id="tp-btn-open-workspace" style="border-color:${color};">
          📖 Open Topic Notes / Outside Laws
        </button>
        <button class="tp-btn-print-tag" id="tp-btn-print-tag" title="Print or Save Tag Notes & Highlights as PDF">
          🖨️ Print Tag
        </button>
      </div>

      ${matching.length > 0 ? `
        <div class="tp-stepper-row">
          <span class="tp-stepper-lbl">Step Through:</span>
          <button class="tp-step-btn" id="tp-step-prev" title="Previous provision in this topic">◀ Prev</button>
          <span class="tp-step-counter" id="tp-jump-counter">${posLabel}</span>
          <button class="tp-step-btn" id="tp-step-next" title="Next provision in this topic">Next ▶</button>
        </div>
      ` : ''}
    </div>

    <div class="tp-provisions-sec-title">Tagged Codal Provisions:</div>
    <div class="tp-anns-list">${initialListHtml}</div>
  `;

  // Wire header/stepper buttons
  container.querySelector('#tp-btn-open-workspace')?.addEventListener('click', () => {
    openTopicNotesModal(tagName);
  });
  container.querySelector('#tp-btn-print-tag')?.addEventListener('click', () => {
    printTagNotes(tagName);
  });

  container.querySelector('#tp-step-prev')?.addEventListener('click', () => jumpThroughTag(tagName, -1));
  container.querySelector('#tp-step-next')?.addEventListener('click', () => jumpThroughTag(tagName, 1));

  // Event delegation on .tp-anns-list supports both synchronous and chunked rAF cards
  const listEl = container.querySelector('.tp-anns-list');
  listEl?.addEventListener('click', async (e) => {
    const jumpBtn = e.target.closest('[data-jump]');
    if (jumpBtn) {
      const target = getAnnotationById(jumpBtn.dataset.jump);
      if (target) jumpToAnn(target);
      return;
    }
    const untagBtn = e.target.closest('[data-untag]');
    if (untagBtn) {
      e.stopPropagation();
      const target = getAnnotationById(untagBtn.dataset.untag);
      if (target) {
        await removeTagFromAnn(target, tagName);
      }
    }
  });

  if (shouldChunk && listEl) {
    const CHUNK_SIZE = 50;
    let offset = 0;
    const appendBatch = (isFirst) => {
      if (!isFirst && (myGen !== _singleTopicRenderGen || !listEl.isConnected)) return;
      const end = Math.min(offset + CHUNK_SIZE, matching.length);
      let chunkHtml = '';
      for (; offset < end; offset++) {
        chunkHtml += _buildTopicAnnCardHtml(matching[offset]);
      }
      if (chunkHtml) {
        listEl.insertAdjacentHTML('beforeend', chunkHtml);
      }
      if (offset < matching.length) {
        requestAnimationFrame(() => appendBatch(false));
      }
    };
    appendBatch(true);
  }
}

function renderAllTopicsView(container, allTopics) {
  _singleTopicRenderGen++;
  if (allTopics.length === 0) {
    container.innerHTML = `
      <div class="tp-empty">
        <div style="font-size:36px;margin-bottom:10px">🏷️</div>
        <div style="font-weight:700;color:#e8e4db;font-size:15px;margin-bottom:6px">No tags or topics created yet</div>
        <div style="font-size:13px;color:var(--muted);line-height:1.6;max-width:300px;margin:0 auto">
          Organize your syllabus coverage! Type a topic name above (like <strong>"Week 1"</strong> or <strong>"Topic 1: Legal Redemption"</strong>) or tag provisions directly from the Notes Panel.
        </div>
      </div>
    `;
    return;
  }

  const cardsHtml = allTopics.map(t => {
    const color = t.color || pickTopicColor(t.name);
    return `
      <div class="tp-overview-card" style="border-left: 3px solid ${color};" data-open-topic="${escapeHtml(t.name)}">
        <div class="tp-oc-top">
          <div class="tp-oc-title" style="color:${color}">🏷️ ${escapeHtml(t.name)}</div>
          <span class="tp-oc-cnt">${t.count} provisions</span>
        </div>
        <div class="tp-oc-actions">
          <button class="tp-btn-sm" data-btn-notes="${escapeHtml(t.name)}">📖 Notes</button>
          <button class="tp-btn-sm" data-btn-print="${escapeHtml(t.name)}" title="Print or Save Tag Notes & Highlights as PDF">🖨️ Print</button>
          <button class="tp-btn-sm" data-btn-view="${escapeHtml(t.name)}">View Highlights (${t.count}) →</button>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="tp-provisions-sec-title">All Topics (${allTopics.length}):</div>
    <div class="tp-overview-list">${cardsHtml}</div>
  `;

  container.querySelectorAll('[data-btn-notes]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTopicNotesModal(btn.dataset.btnNotes);
    });
  });

  container.querySelectorAll('[data-btn-print]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      printTagNotes(btn.dataset.btnPrint);
    });
  });

  container.querySelectorAll('[data-btn-view], [data-open-topic]').forEach(el => {
    el.addEventListener('click', () => {
      const topicName = el.dataset.btnView || el.dataset.openTopic;
      selectedFilterTag = topicName;
      renderTagsPanel();
    });
  });
}

// ── 7. Openable Topic Notes Workspace ("📖 Open Topic Notes / Outside Laws") ──
export function openTopicNotesModal(tagName) {
  const trueId = getCurTrueId();
  if (!trueId) {
    toast('Please open a PDF first');
    return;
  }

  const modal = document.getElementById('topic-notes-modal');
  if (!modal) return;

  activeNotesTopic = tagName;
  const topic = currentTagData?.topics?.[tagName] || {
    name: tagName,
    color: pickTopicColor(tagName),
    notesHtml: '',
  };

  const color = topic.color || pickTopicColor(tagName);
  const matching = [..._getAnnsForTag(tagName)];
  matching.sort(compareAnnotationsReadingOrder);

  // Title and badge
  const titleEl = document.getElementById('tnm-topic-name');
  if (titleEl) {
    titleEl.textContent = topic.name;
    titleEl.style.color = color;
  }
  const badgeEl = document.getElementById('tnm-topic-badge');
  if (badgeEl) {
    badgeEl.style.background = `${color}22`;
    badgeEl.style.borderColor = `${color}80`;
    badgeEl.style.color = color;
    badgeEl.textContent = `${matching.length} Codal Provisions`;
  }

  // Load editor content
  const editor = document.getElementById('topic-notes-editor');
  if (editor) {
    editor.innerHTML = topic.notesHtml || '';
  }

  // Render right sidebar of linked codal provisions
  renderTopicModalProvisions(matching);

  // Status
  const statusEl = document.getElementById('tnm-save-status');
  if (statusEl) statusEl.textContent = '✓ Saved to Cloud';

  modal.classList.add('open');
}

export function closeTopicNotesModal() {
  const modal = document.getElementById('topic-notes-modal');
  if (modal) modal.classList.remove('open');
  activeNotesTopic = null;
}

function renderTopicModalProvisions(matchingAnns) {
  const listEl = document.getElementById('tnm-provisions-list');
  if (!listEl) return;

  if (matchingAnns.length === 0) {
    listEl.innerHTML = `
      <div style="font-size:12.5px;color:var(--muted);text-align:center;padding:24px 10px;font-style:italic">
        No codal provisions highlighted for this topic yet.<br>Highlight provisions in your PDF to view and quote them side-by-side here!
      </div>
    `;
    return;
  }

  listEl.innerHTML = matchingAnns.map(ann => {
    return `
      <div class="tnm-prov-card">
        <div class="tnm-prov-hd">
          <span class="tnm-prov-page">Page ${ann.page}</span>
          <button class="tnm-btn-quote" data-quote-ann="${ann.id}" title="Insert provision quote into notes editor">📋 Quote in Notes</button>
          <button class="tnm-btn-jump" data-jump-ann="${ann.id}" title="Scroll PDF to this provision">Jump ↗</button>
        </div>
        <div class="tnm-prov-quote">"${escapeHtml(ann.highlighted_text || '(Box Highlight)')}"</div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('[data-jump-ann]').forEach(btn => {
    btn.addEventListener('click', () => {
      const annId = btn.dataset.jumpAnn;
      const target = S.annotations?.find(a => a.id === annId);
      if (target) jumpToAnn(target);
    });
  });

  listEl.querySelectorAll('[data-quote-ann]').forEach(btn => {
    btn.addEventListener('click', () => {
      const annId = btn.dataset.quoteAnn;
      const target = S.annotations?.find(a => a.id === annId);
      if (!target) return;
      const editor = document.getElementById('topic-notes-editor');
      if (!editor) return;

      const quoteHtml = `
        <blockquote style="border-left: 3px solid var(--gold); margin: 12px 0; padding: 6px 12px; background: rgba(201,168,76,0.08); font-style: italic; color: #f3efe6;">
          <strong>Codal Provision (Page ${target.page}):</strong> "${escapeHtml(target.highlighted_text)}"
        </blockquote>
        <p></p>
      `;
      editor.focus();
      document.execCommand('insertHTML', false, quoteHtml);
      saveTopicEditorContent();
      toast('Provision quoted in notes');
    });
  });
}

function saveTopicEditorContent() {
  if (!activeNotesTopic || !currentTagData) return;
  const editor = document.getElementById('topic-notes-editor');
  if (!editor) return;

  const html = editor.innerHTML;
  if (!currentTagData.topics[activeNotesTopic]) {
    currentTagData.topics[activeNotesTopic] = {
      name: activeNotesTopic,
      color: pickTopicColor(activeNotesTopic),
      notesHtml: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  currentTagData.topics[activeNotesTopic].notesHtml = html;
  currentTagData.topics[activeNotesTopic].updatedAt = Date.now();
  currentTagData.updatedAt = Date.now();

  const trueId = getCurTrueId();
  if (trueId) {
    safeStorageSet('local_pdf_tags_v1_' + trueId, JSON.stringify(currentTagData));
  }

  const statusEl = document.getElementById('tnm-save-status');
  if (statusEl) statusEl.textContent = 'Saving…';

  clearTimeout(_topicNotesSaveTimer);
  _topicNotesSaveTimer = setTimeout(async () => {
    if (trueId) {
      await dbSetSetting('pdf_tags_v1_' + trueId, JSON.stringify(currentTagData));
    }
    if (statusEl) statusEl.textContent = '✓ Saved to Cloud';
  }, 450);
}

export function printTagNotes(tagName) {
  if (!tagName) return;
  const topic = currentTagData?.topics?.[tagName] || {
    name: tagName,
    color: pickTopicColor(tagName),
    notesHtml: '',
  };
  const matching = _getAnnsForTag(tagName);
  exportTagNotesToPDF({
    tagName,
    tagColor: topic?.color || pickTopicColor(tagName),
    topicNotesHtml: topic?.notesHtml || '',
    pdfTitle: S.curPDF?.name || 'Document',
    annotations: matching,
  });
}

// ── 8. Injection & Initialization ──
export function initTagsPanel() {
  injectTagsCSS();
  injectToolbarButton();
  injectTagsPanelDOM();
  injectTopicNotesModalDOM();
  injectSelMenuTagPicker();
  injectMassTagPopoverDOM();
}

function injectTagsCSS() {
  if (document.getElementById('tags-dynamic-styles')) return;
  const style = document.createElement('style');
  style.id = 'tags-dynamic-styles';
  style.textContent = `
    /* Floating Tag Badge on PDF Highlight */
    .ann-tag-pill-badge {
      position: absolute;
      z-index: 15;
      background: rgba(15, 23, 42, 0.94);
      border: 1px solid rgba(245, 158, 11, 0.7);
      color: #fbbf24;
      font-size: 10px;
      font-weight: 600;
      font-family: var(--font-ui, 'Public Sans', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif);
      padding: 2px 7px;
      border-radius: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.5);
      cursor: pointer;
      white-space: nowrap;
      pointer-events: auto;
      user-select: none;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      transform: translateY(-50%);
      transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
    }
    .ann-tag-pill-badge:hover {
      transform: translateY(-50%) scale(1.08);
      border-color: #f59e0b;
      background: #0f172a;
      box-shadow: 0 4px 14px rgba(245, 158, 11, 0.45);
    }

    /* Provision Luminous Pulse Flash */
    @keyframes annTagFlashPulse {
      0% { filter: brightness(1.8) drop-shadow(0 0 14px #f59e0b); outline: 3px solid #f59e0b; }
      50% { filter: brightness(2.3) drop-shadow(0 0 24px #f59e0b); outline: 4px solid #fbbf24; }
      100% { filter: none; outline: none; }
    }
    .hi-grp.ann-tag-flash {
      animation: annTagFlashPulse 2.2s ease-out;
      border-radius: 4px;
    }

    /* Annotation Panel Tags Section */
    .ap-tags-container {
      padding: 9px 12px;
      border-bottom: 1px solid var(--navy-b);
      background: rgba(0,0,0,0.12);
      display: flex;
      flex-direction: column;
      gap: 7px;
      flex-shrink: 0;
    }
    .ap-tags-hd {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .ap-tags-hd-lbl {
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--muted);
      font-weight: 600;
    }
    .ap-tags-open-menu-btn {
      background: none;
      border: 1px solid var(--navy-b);
      color: var(--gold);
      border-radius: 4px;
      font-size: 10.5px;
      padding: 2px 7px;
      cursor: pointer;
      font-family: inherit;
    }
    .ap-tags-open-menu-btn:hover {
      background: rgba(201,168,76,0.15);
      border-color: var(--gold);
    }
    .ap-tags-pills-list {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      min-height: 22px;
      align-items: center;
    }
    .ap-tags-empty {
      font-size: 11px;
      color: var(--muted);
      font-style: italic;
    }
    .ap-tag-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: 12px;
      border: 1px solid;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      user-select: none;
    }
    .ap-tag-pill:hover {
      filter: brightness(1.15);
    }
    .ap-tag-pill-del {
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      font-size: 10px;
      padding: 0 1px;
      line-height: 1;
      opacity: 0.7;
    }
    .ap-tag-pill-del:hover {
      opacity: 1;
    }
    .ap-tags-quick-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      overflow-x: auto;
      padding-bottom: 2px;
    }
    .ap-quick-lbl {
      color: var(--muted);
      font-size: 10px;
      flex-shrink: 0;
    }
    .ap-quick-btns {
      display: flex;
      gap: 4px;
      overflow-x: auto;
    }
    .ap-quick-add-btn {
      background: rgba(255,255,255,0.04);
      border: 1px dashed;
      border-radius: 10px;
      padding: 1px 7px;
      font-size: 10.5px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
    }
    .ap-quick-add-btn:hover {
      background: rgba(255,255,255,0.12);
      transform: scale(1.04);
    }
    .ap-tags-input-row {
      display: flex;
      gap: 6px;
    }
    .ap-tag-input {
      flex: 1;
      background: var(--navy);
      border: 1px solid var(--navy-b);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 11.5px;
      color: #e8e4db;
      outline: none;
    }
    .ap-tag-input:focus {
      border-color: var(--gold);
    }
    .ap-btn-add-tag {
      background: rgba(201,168,76,0.15);
      border: 1px solid var(--gold);
      color: var(--gold);
      border-radius: 4px;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .ap-btn-add-tag:hover {
      background: var(--gold);
      color: var(--navy);
    }
    .ap-tags-quick-tag-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 11px;
      border-top: 1px dashed rgba(255,255,255,0.08);
      padding-top: 5px;
    }
    .ap-quick-tag-lbl {
      color: var(--muted);
      font-size: 10.5px;
      white-space: nowrap;
    }
    .ap-quick-tag-select {
      background: var(--navy);
      border: 1px solid var(--navy-b);
      color: #e8e4db;
      font-size: 11px;
      border-radius: 4px;
      padding: 2px 6px;
      outline: none;
      max-width: 170px;
    }

    /* Slide-out #tags-panel */
    #tags-panel {
      position: absolute;
      top: 0; right: 0; bottom: 0;
      width: 410px;
      min-width: 300px;
      max-width: 92vw;
      height: 100%;
      max-height: 100%;
      background: var(--navy-l);
      border-left: 1px solid var(--navy-b);
      z-index: 32;
      display: flex;
      flex-direction: column;
      transform: translateX(100%);
      transition: transform .25s ease, visibility .25s ease;
      box-shadow: -4px 0 24px rgba(0,0,0,.5);
      overflow: hidden;
      visibility: hidden;
      pointer-events: none;
    }
    #tags-panel.open {
      transform: translateX(0);
      visibility: visible;
      pointer-events: auto;
    }
    .tp-hd {
      padding: 10px 14px;
      border-bottom: 1px solid var(--navy-b);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .tp-hd-title {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 14px;
      color: var(--gold);
    }
    .tp-close {
      background: none;
      border: none;
      color: var(--muted);
      font-size: 18px;
      cursor: pointer;
      line-height: 1;
    }
    .tp-create-box {
      padding: 10px 14px;
      border-bottom: 1px solid var(--navy-b);
      background: rgba(0,0,0,0.1);
      flex-shrink: 0;
    }
    .tp-create-row {
      display: flex;
      gap: 6px;
    }
    .tp-input {
      flex: 1;
      background: var(--navy);
      border: 1px solid var(--navy-b);
      color: #e8e4db;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12.5px;
      outline: none;
    }
    .tp-input:focus {
      border-color: var(--gold);
    }
    .tp-btn-gold {
      background: var(--gold);
      color: var(--navy);
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }
    .tp-btn-gold:hover {
      opacity: 0.9;
    }
    .tp-filter-bar {
      display: flex;
      gap: 6px;
      padding: 8px 14px;
      overflow-x: auto;
      border-bottom: 1px solid var(--navy-b);
      background: rgba(0,0,0,0.15);
      flex-shrink: 0;
    }
    .tp-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--navy-b);
      color: var(--muted);
      padding: 4px 9px;
      border-radius: 14px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
    }
    .tp-chip:hover {
      color: #e8e4db;
      background: rgba(255,255,255,0.1);
    }
    .tp-chip.active {
      background: rgba(201,168,76,0.15);
      border-color: var(--gold);
      color: var(--gold);
      font-weight: 700;
    }
    .tp-chip-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .tp-chip-cnt {
      background: rgba(255,255,255,0.08);
      padding: 1px 5px;
      border-radius: 8px;
      font-size: 10px;
    }
    .tp-content {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .tp-topic-card {
      background: var(--navy);
      border: 1px solid var(--navy-b);
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 9px;
    }
    .tp-tc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .tp-tc-title-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tp-tc-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
    }
    .tp-tc-title {
      font-size: 14px;
      font-weight: 700;
      color: #e8e4db;
    }
    .tp-tc-cnt {
      font-size: 11px;
      color: var(--muted);
    }
    .tp-tc-actions {
      display: flex;
      gap: 6px;
      align-items: stretch;
    }
    .tp-btn-open-notes {
      flex: 1;
      background: rgba(201,168,76,0.12);
      border: 1px solid var(--gold);
      color: var(--gold);
      border-radius: 6px;
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s;
    }
    .tp-btn-open-notes:hover {
      background: var(--gold);
      color: var(--navy);
    }
    .tp-btn-print-tag {
      background: rgba(255,255,255,0.06);
      border: 1px solid var(--navy-b);
      color: #e8e4db;
      border-radius: 6px;
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s;
    }
    .tp-btn-print-tag:hover {
      border-color: var(--gold);
      color: var(--gold);
      background: rgba(201,168,76,0.12);
    }
    .tp-stepper-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      background: rgba(0,0,0,0.18);
      border-radius: 6px;
      padding: 4px 8px;
    }
    .tp-stepper-lbl {
      font-size: 11px;
      color: var(--muted);
    }
    .tp-step-btn {
      background: rgba(255,255,255,0.06);
      border: 1px solid var(--navy-b);
      color: #e8e4db;
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
    }
    .tp-step-btn:hover {
      background: rgba(255,255,255,0.15);
      border-color: var(--gold);
    }
    .tp-step-counter {
      font-size: 11px;
      font-weight: 600;
      color: var(--gold);
    }
    .tp-provisions-sec-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .06em;
      color: var(--muted);
      font-weight: 600;
      margin-top: 4px;
    }
    .tp-anns-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .tp-ann-card {
      background: var(--navy);
      border: 1px solid var(--navy-b);
      border-radius: 6px;
      padding: 9px 11px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .tp-ann-hd {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .tp-ann-page {
      font-size: 11px;
      font-weight: 700;
      color: var(--gold);
    }
    .tp-ann-badges {
      display: flex;
      gap: 4px;
      margin-left: auto;
      margin-right: 8px;
    }
    .tp-mini-badge {
      font-size: 9.5px;
      padding: 1px 5px;
      border-radius: 4px;
      font-weight: 600;
    }
    .tp-mini-badge.case {
      background: rgba(201,168,76,0.18);
      color: var(--gold);
      border: 1px solid rgba(201,168,76,0.4);
    }
    .tp-mini-badge.note {
      background: rgba(255,255,255,0.08);
      color: #e8e4db;
    }
    .tp-ann-untag-btn {
      background: none;
      border: none;
      color: var(--muted);
      font-size: 11px;
      cursor: pointer;
    }
    .tp-ann-untag-btn:hover {
      color: #ef4444;
    }
    .tp-ann-quote {
      font-family: var(--font-display, 'Literata', Georgia, 'Palatino Linotype', 'Book Antiqua', serif);
      font-style: italic;
      font-size: 12px;
      line-height: 1.45;
      color: #e0dbd2;
      max-height: 52px;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
    }
    .tp-ann-ft {
      display: flex;
      justify-content: flex-end;
    }
    .tp-ann-jump-btn {
      background: none;
      border: 1px solid var(--navy-b);
      color: var(--gold);
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .tp-ann-jump-btn:hover {
      background: rgba(201,168,76,0.15);
      border-color: var(--gold);
    }
    .tp-overview-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .tp-overview-card {
      background: var(--navy);
      border: 1px solid var(--navy-b);
      border-radius: 6px;
      padding: 10px 12px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 7px;
      transition: background 0.15s;
    }
    .tp-overview-card:hover {
      background: rgba(255,255,255,0.04);
    }
    .tp-oc-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .tp-oc-title {
      font-size: 13px;
      font-weight: 700;
    }
    .tp-oc-cnt {
      font-size: 11px;
      color: var(--muted);
    }
    .tp-oc-actions {
      display: flex;
      gap: 6px;
    }
    .tp-btn-sm {
      background: rgba(255,255,255,0.06);
      border: 1px solid var(--navy-b);
      color: #e8e4db;
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 11px;
      cursor: pointer;
    }
    .tp-btn-sm:hover {
      border-color: var(--gold);
      color: var(--gold);
    }
    .tp-empty {
      text-align: center;
      padding: 36px 14px;
      color: var(--muted);
    }

    /* Modal: #topic-notes-modal */
    .topic-notes-box {
      width: min(1160px, 94vw);
      height: min(840px, 90vh);
      max-width: 95vw;
      max-height: 92vh;
      display: flex;
      flex-direction: column;
      background: var(--navy-l);
      border: 1px solid var(--navy-b);
      border-radius: 12px;
      padding: 18px 22px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.65);
      overflow: hidden;
    }
    .tnm-hd {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      border-bottom: 1px solid var(--navy-b);
      padding-bottom: 12px;
      flex-shrink: 0;
    }
    .tnm-hd-title-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .tnm-hd-title {
      font-size: 17px;
      font-weight: 700;
    }
    .tnm-hd-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      border: 1px solid;
    }
    .tnm-hd-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 3px;
    }
    .tnm-hd-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .tnm-status-pill {
      font-size: 11px;
      color: #10B981;
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.3);
      border-radius: 10px;
      padding: 2px 8px;
    }
    .tnm-close-btn {
      background: none;
      border: none;
      color: var(--muted);
      font-size: 20px;
      cursor: pointer;
      line-height: 1;
    }
    .tnm-body {
      display: flex;
      flex: 1;
      min-height: 0;
      gap: 16px;
      margin-top: 12px;
    }
    .tnm-main-col {
      flex: 1.6;
      display: flex;
      flex-direction: column;
      min-width: 0;
      border-right: 1px solid var(--navy-b);
      padding-right: 16px;
    }
    .tnm-side-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .tnm-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      padding: 6px 8px;
      background: rgba(0,0,0,0.18);
      border: 1px solid var(--navy-b);
      border-radius: 6px;
      margin-bottom: 10px;
      flex-shrink: 0;
    }
    .tnm-tbtn {
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--navy-b);
      color: #e8e4db;
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 11.5px;
      cursor: pointer;
      font-family: inherit;
    }
    .tnm-tbtn:hover {
      background: rgba(255,255,255,0.15);
      border-color: var(--gold);
      color: var(--gold);
    }
    .tnm-tsep {
      width: 1px;
      height: 16px;
      background: var(--navy-b);
      margin: 0 3px;
    }
    .tnm-editor {
      flex: 1;
      overflow-y: auto;
      background: var(--navy);
      border: 1px solid var(--navy-b);
      border-radius: 8px;
      padding: 16px 18px;
      font-size: 14px;
      line-height: 1.65;
      color: #e8e4db;
      outline: none;
      word-break: break-word;
    }
    .tnm-editor:focus {
      border-color: var(--gold);
    }
    .tnm-editor[data-ph]:empty:before {
      content: attr(data-ph);
      color: var(--muted);
      font-style: italic;
    }
    .tnm-side-title {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .06em;
      color: var(--gold);
      margin-bottom: 2px;
    }
    .tnm-side-sub {
      font-size: 11.5px;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .tnm-prov-list {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 9px;
      padding-right: 4px;
    }
    .tnm-prov-card {
      background: var(--navy);
      border: 1px solid var(--navy-b);
      border-radius: 6px;
      padding: 9px 11px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .tnm-prov-hd {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tnm-prov-page {
      font-size: 11px;
      font-weight: 700;
      color: var(--gold);
      margin-right: auto;
    }
    .tnm-btn-quote, .tnm-btn-jump {
      background: rgba(255,255,255,0.06);
      border: 1px solid var(--navy-b);
      color: #e8e4db;
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 10.5px;
      cursor: pointer;
    }
    .tnm-btn-quote:hover, .tnm-btn-jump:hover {
      border-color: var(--gold);
      color: var(--gold);
    }
    .tnm-prov-quote {
      font-family: var(--font-display, 'Literata', Georgia, 'Palatino Linotype', 'Book Antiqua', serif);
      font-style: italic;
      font-size: 11.5px;
      line-height: 1.45;
      color: #ddd8cf;
      max-height: 60px;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
    }
    .tnm-ft {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid var(--navy-b);
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      flex-shrink: 0;
    }
    .tnm-done-btn {
      background: var(--gold);
      color: var(--navy);
      border: none;
      border-radius: 6px;
      padding: 7px 18px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
    .tnm-done-btn:hover {
      opacity: 0.9;
    }
    .tnm-print-btn {
      background: rgba(201,168,76,0.14);
      border: 1px solid var(--gold);
      color: var(--gold);
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.15s;
    }
    .tnm-print-btn:hover {
      background: var(--gold);
      color: var(--navy);
    }

    /* Selection Menu Mass-Tag Button & Popover */
    .sel-btn.sel-mass-tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(201,168,76,0.16);
      color: var(--gold, #c9a84c);
      border: 1px solid rgba(201,168,76,0.45);
    }
    .sel-btn.sel-mass-tag:hover {
      background: rgba(201,168,76,0.28);
    }
    #mass-tag-popover {
      position: fixed;
      z-index: 950;
      width: 290px;
      max-width: calc(100vw - 16px);
      max-height: 360px;
      background: var(--navy-l, #141c2d);
      border: 1px solid var(--navy-b, #2a3752);
      border-radius: 8px;
      box-shadow: 0 14px 36px rgba(0,0,0,0.55);
      display: none;
      flex-direction: column;
      overflow: hidden;
      color: #e8e4db;
      font-family: var(--font-ui, 'Public Sans', 'Segoe UI', sans-serif);
    }
    #mass-tag-popover.open {
      display: flex;
    }
    .mtp-hd {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-bottom: 1px solid var(--navy-b, #2a3752);
      background: rgba(0,0,0,0.18);
      font-size: 12px;
      font-weight: 700;
      color: var(--gold, #c9a84c);
    }
    .mtp-close-btn {
      background: none;
      border: none;
      color: var(--muted, #94a3b8);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 2px;
    }
    .mtp-close-btn:hover {
      color: #e8e4db;
    }
    .mtp-input-row {
      display: flex;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--navy-b, #2a3752);
    }
    .mtp-input {
      flex: 1;
      min-width: 0;
      background: var(--navy, #0c1322);
      border: 1px solid var(--navy-b, #2a3752);
      border-radius: 5px;
      padding: 5px 8px;
      font-size: 12px;
      color: #e8e4db;
      outline: none;
    }
    .mtp-input:focus {
      border-color: var(--gold, #c9a84c);
    }
    .mtp-apply-btn {
      background: var(--gold, #c9a84c);
      color: var(--navy, #0c1322);
      border: none;
      border-radius: 5px;
      padding: 5px 10px;
      font-size: 11.5px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }
    .mtp-apply-btn:hover {
      opacity: 0.92;
    }
    .mtp-list {
      flex: 1;
      overflow-y: auto;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .mtp-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      border-radius: 5px;
      background: rgba(255,255,255,0.03);
      border: 1px solid transparent;
      cursor: pointer;
      transition: background 0.12s, border-color 0.12s;
    }
    .mtp-row:hover {
      background: rgba(255,255,255,0.08);
      border-color: var(--navy-b, #2a3752);
    }
    .mtp-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .mtp-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 600;
    }
    .mtp-cnt {
      font-size: 10.5px;
      color: var(--muted, #94a3b8);
      background: rgba(255,255,255,0.06);
      padding: 1px 6px;
      border-radius: 10px;
      flex-shrink: 0;
    }
    .mtp-cnt.all {
      color: #10B981;
      background: rgba(16,185,129,0.14);
    }
    .mtp-remove-btn {
      background: rgba(239,68,68,0.14);
      border: 1px solid rgba(239,68,68,0.4);
      color: #fca5a5;
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
    }
    .mtp-remove-btn:hover {
      background: #ef4444;
      color: #fff;
    }
    .mtp-empty {
      font-size: 11.5px;
      color: var(--muted, #94a3b8);
      text-align: center;
      padding: 14px 8px;
      font-style: italic;
    }
  `;
  document.head.appendChild(style);
}

function injectToolbarButton() {
  if (document.getElementById('btn-tags')) return;
  const toolbar = document.getElementById('toolbar');
  if (!toolbar) return;

  const btn = document.createElement('button');
  btn.className = 'tb-btn';
  btn.id = 'btn-tags';
  btn.title = 'Highlight Tags & Syllabus Topic Notes';
  btn.innerHTML = `
    <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z"/>
    </svg>
    <span>Tags</span>
  `;
  btn.addEventListener('click', () => toggleTagsPanel());

  const target = document.getElementById('btn-diagram') || document.getElementById('btn-links') || document.getElementById('btn-search');
  if (target && target.nextSibling) {
    toolbar.insertBefore(btn, target.nextSibling);
  } else {
    toolbar.appendChild(btn);
  }
}

function injectTagsPanelDOM() {
  if (document.getElementById('tags-panel')) return;
  const panel = document.createElement('div');
  panel.id = 'tags-panel';
  panel.className = 'slide-panel';
  panel.innerHTML = `
    <div class="tp-hd"></div>
    <div class="tp-create-box"></div>
    <div class="tp-filter-bar"></div>
    <div class="tp-content"></div>
  `;

  const wrap = document.getElementById('viewer-wrap') || document.getElementById('app') || document.body;
  wrap.appendChild(panel);
}

function injectTopicNotesModalDOM() {
  if (document.getElementById('topic-notes-modal')) return;
  const modal = document.createElement('div');
  modal.className = 'modal-ov';
  modal.id = 'topic-notes-modal';
  modal.innerHTML = `
    <div class="modal-box topic-notes-box">
      <div class="tnm-hd">
        <div>
          <div class="tnm-hd-title-row">
            <span style="font-size:18px">📖</span>
            <span class="tnm-hd-title" id="tnm-topic-name">Topic Notes</span>
            <span class="tnm-hd-badge" id="tnm-topic-badge">0 Codal Provisions</span>
          </div>
          <div class="tnm-hd-sub">Outside Laws, Special Statutes (R.A. / P.D.), Jurisprudence, & Syllabus Coverage</div>
        </div>
        <div class="tnm-hd-right">
          <button class="tnm-print-btn" id="tnm-print-btn" title="Print or Save Tag Notes & Highlights as PDF">🖨️ Print Tag</button>
          <span class="tnm-status-pill" id="tnm-save-status">✓ Saved to Cloud</span>
          <button class="tnm-close-btn" id="tnm-close-btn" title="Close Workspace">✕</button>
        </div>
      </div>

      <div class="tnm-body">
        <!-- Left: Outside Laws & Topic Notes Editor -->
        <div class="tnm-main-col">
          <div class="tnm-toolbar">
            <button class="tnm-tbtn" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
            <button class="tnm-tbtn" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
            <button class="tnm-tbtn" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
            <button class="tnm-tbtn" data-cmd="hilite" title="Highlight text">🖍️ Mark</button>
            <div class="tnm-tsep"></div>
            <button class="tnm-tbtn" data-cmd="h1" title="Heading 1"><b>H1</b></button>
            <button class="tnm-tbtn" data-cmd="h2" title="Heading 2"><b>H2</b></button>
            <button class="tnm-tbtn" data-cmd="p" title="Paragraph">P</button>
            <div class="tnm-tsep"></div>
            <button class="tnm-tbtn" data-cmd="insertUnorderedList" title="Bulleted List">• List</button>
            <button class="tnm-tbtn" data-cmd="insertOrderedList" title="Numbered List">1. List</button>
            <button class="tnm-tbtn" data-cmd="banner" title="Section Banner Header">🏷️ Banner</button>
            <button class="tnm-tbtn" data-cmd="table" title="Insert Summary Table">Table</button>
            <div class="tnm-tsep"></div>
            <button class="tnm-tbtn" data-cmd="outdent" title="Outdent">⇤</button>
            <button class="tnm-tbtn" data-cmd="indent" title="Indent">⇥</button>
            <button class="tnm-tbtn" data-cmd="copyTable" title="Copy 1st Table">📋 Copy Table</button>
            <button class="tnm-tbtn" data-cmd="clean" title="Clean Formatting">Clear Format</button>
          </div>
          <div id="topic-notes-editor" class="tnm-editor" contenteditable="true" spellcheck="true" data-ph="Write or paste outside laws, special statutes, jurisprudence rulings, or professor lecture commentary for this topic…"></div>
        </div>

        <!-- Right: Linked Codal Provisions Sidebar -->
        <div class="tnm-side-col">
          <div class="tnm-side-title">Linked Codal Provisions</div>
          <div class="tnm-side-sub">Provisions in your codal PDF tagged with this topic. Click to quote or jump:</div>
          <div class="tnm-prov-list" id="tnm-provisions-list"></div>
        </div>
      </div>

      <div class="tnm-ft">
        <button class="tnm-done-btn" id="tnm-done-btn">Done / Close</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Wire close buttons
  modal.querySelector('#tnm-close-btn')?.addEventListener('click', closeTopicNotesModal);
  modal.querySelector('#tnm-done-btn')?.addEventListener('click', closeTopicNotesModal);
  modal.querySelector('#tnm-print-btn')?.addEventListener('click', () => {
    if (activeNotesTopic) {
      saveTopicEditorContent();
      printTagNotes(activeNotesTopic);
    }
  });

  // Wire editor input
  const ed = modal.querySelector('#topic-notes-editor');
  ed?.addEventListener('input', () => saveTopicEditorContent());
  ed?.addEventListener('paste', handlePaste);
  ed?.addEventListener('copy', handleCopy);

  // Wire toolbar buttons
  modal.querySelectorAll('.tnm-tbtn').forEach(b => {
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => {
      if (!ed) return;
      const cmd = b.dataset.cmd;
      if (cmd === 'bold' || cmd === 'italic' || cmd === 'underline') {
        document.execCommand(cmd, false, null);
      } else if (cmd === 'hilite') {
        document.execCommand('hiliteColor', false, '#fef08a');
      } else if (cmd === 'h1') {
        document.execCommand('formatBlock', false, '<h1>');
      } else if (cmd === 'h2') {
        document.execCommand('formatBlock', false, '<h2>');
      } else if (cmd === 'p') {
        document.execCommand('formatBlock', false, '<p>');
      } else if (cmd === 'insertUnorderedList' || cmd === 'insertOrderedList') {
        document.execCommand(cmd, false, null);
      } else if (cmd === 'banner') {
        insertBannerHeader(ed);
      } else if (cmd === 'table') {
        showTablePicker(b, ed);
      } else if (cmd === 'outdent') {
        outdentLine(ed);
      } else if (cmd === 'indent') {
        indentLine(ed);
      } else if (cmd === 'copyTable') {
        copyFirstSummaryTable(ed);
      } else if (cmd === 'clean') {
        document.execCommand('removeFormat', false, null);
      }
      saveTopicEditorContent();
    });
  });
}

let _massTagAnnIds = [];
let _massTagListenersBound = false;

function _getMassTagTargetAnns() {
  if (!_massTagAnnIds.length || !Array.isArray(S.annotations)) return [];
  const idSet = new Set(_massTagAnnIds);
  return S.annotations.filter(a => a && idSet.has(a.id));
}

function closeMassTagPopover() {
  const popover = document.getElementById('mass-tag-popover');
  if (popover) popover.classList.remove('open');
}

function injectMassTagPopoverDOM() {
  let popover = document.getElementById('mass-tag-popover');
  if (!popover) {
    popover = document.createElement('div');
    popover.id = 'mass-tag-popover';
    popover.innerHTML = `
      <div class="mtp-hd">
        <span id="mtp-title">Tag Highlights</span>
        <button type="button" class="mtp-close-btn" id="mtp-close-btn" title="Close">✕</button>
      </div>
      <div class="mtp-input-row">
        <input type="text" id="mtp-input" class="mtp-input" placeholder="Filter or type new tag..." />
        <button type="button" id="mtp-apply-btn" class="mtp-apply-btn">Tag All</button>
      </div>
      <div class="mtp-list" id="mtp-list"></div>
    `;
    document.body.appendChild(popover);

    popover.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    popover.querySelector('#mtp-close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMassTagPopover();
    });

    const input = popover.querySelector('#mtp-input');
    const applyBtn = popover.querySelector('#mtp-apply-btn');

    const submitInputTag = async () => {
      const val = input?.value.trim();
      if (!val) {
        input?.focus();
        return;
      }
      await applyMassTagSelection(val);
    };

    input?.addEventListener('input', () => {
      renderMassTagPopoverList(input.value);
    });
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitInputTag();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeMassTagPopover();
      }
    });
    applyBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      submitInputTag();
    });
  }

  if (!_massTagListenersBound) {
    _massTagListenersBound = true;
    document.addEventListener('mousedown', (e) => {
      const pop = document.getElementById('mass-tag-popover');
      if (!pop || !pop.classList.contains('open')) return;
      const massBtn = document.getElementById('sel-mass-tag-btn');
      if (pop.contains(e.target) || massBtn?.contains(e.target)) return;
      closeMassTagPopover();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMassTagPopover();
      }
    });
  }

  return popover;
}

async function applyMassTagSelection(tagName) {
  const tag = String(tagName || '').trim();
  if (!tag) return;
  const targets = _getMassTagTargetAnns();
  if (targets.length === 0) {
    closeMassTagPopover();
    updateSelMenuMassTagButton([]);
    return;
  }

  await addTagToAnnsBatch(targets, tag);
  closeMassTagPopover();
  document.getElementById('sel-menu')?.classList.remove('open');
  S.pendingSel = null;
  S.pendingEditorSel = null;
  window.getSelection()?.removeAllRanges();
  updateSelMenuMassTagButton([]);
  toast(`Tagged ${targets.length} highlight${targets.length === 1 ? '' : 's'} with "${tag}"`);
}

function renderMassTagPopoverList(filterText = '') {
  const listEl = document.getElementById('mtp-list');
  const titleEl = document.getElementById('mtp-title');
  if (!listEl) return;

  const targets = _getMassTagTargetAnns();
  const total = targets.length;
  if (titleEl) {
    titleEl.textContent = `🏷️ Tag ${total} ${total === 1 ? 'Highlight' : 'Highlights'}`;
  }

  const query = String(filterText || '').trim().toLowerCase();
  const allTopics = getAllTopicsForCurrentPdf();
  const seenNames = new Set(allTopics.map(t => t.name));

  // Include any tag present on selected highlights even if missing from topic map
  for (const ann of targets) {
    for (const tag of getAnnTags(ann)) {
      if (!seenNames.has(tag)) {
        seenNames.add(tag);
        allTopics.push({ name: tag, color: pickTopicColor(tag), count: 0 });
      }
    }
  }

  const filtered = query
    ? allTopics.filter(t => t.name.toLowerCase().includes(query))
    : allTopics;

  if (filtered.length === 0) {
    listEl.innerHTML = query
      ? `<div class="mtp-empty">No matching tags. Press Enter or click <strong>Tag All</strong> to create "${escapeHtml(filterText.trim())}".</div>`
      : `<div class="mtp-empty">No tags yet. Type a tag name above and click <strong>Tag All</strong>.</div>`;
    return;
  }

  listEl.innerHTML = filtered.map(t => {
    const color = t.color || pickTopicColor(t.name);
    const taggedCount = targets.filter(a => getAnnTags(a).includes(t.name)).length;
    const isAll = total > 0 && taggedCount === total;
    const badgeText = isAll ? `(all ${total})` : `(${taggedCount}/${total})`;
    return `
      <div class="mtp-row" data-mtp-tag="${escapeHtml(t.name)}">
        <span class="mtp-dot" style="background:${color}"></span>
        <span class="mtp-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
        <span class="mtp-cnt ${isAll ? 'all' : ''}">${badgeText}</span>
        ${taggedCount >= 1 ? `<button type="button" class="mtp-remove-btn" data-mtp-remove="${escapeHtml(t.name)}" title="Remove this tag from selected highlights">Remove</button>` : ''}
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.mtp-row').forEach(row => {
    row.addEventListener('click', async (e) => {
      if (e.target.closest('[data-mtp-remove]')) return;
      e.stopPropagation();
      const tag = row.dataset.mtpTag;
      if (tag) await applyMassTagSelection(tag);
    });
  });

  listEl.querySelectorAll('[data-mtp-remove]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tag = btn.dataset.mtpRemove;
      if (!tag) return;
      const curTargets = _getMassTagTargetAnns();
      const removedFrom = await removeTagFromAnnsBatch(curTargets, tag);
      const inputEl = document.getElementById('mtp-input');
      renderMassTagPopoverList(inputEl?.value || '');
      if (removedFrom > 0) {
        toast(`Removed "${tag}" from ${removedFrom} highlight${removedFrom === 1 ? '' : 's'}`);
      }
    });
  });
}

function openMassTagPopover() {
  const targets = _getMassTagTargetAnns();
  if (targets.length === 0) {
    closeMassTagPopover();
    return;
  }

  const popover = injectMassTagPopoverDOM();
  const input = popover.querySelector('#mtp-input');
  if (input) input.value = '';
  renderMassTagPopoverList('');
  popover.classList.add('open');

  // Anchor next to #sel-menu, clamped inside viewport
  const selMenu = document.getElementById('sel-menu');
  const menuRect = selMenu?.getBoundingClientRect();
  const popW = popover.offsetWidth || 290;
  const popH = popover.offsetHeight || 240;

  let left = menuRect ? menuRect.left : 16;
  let top = menuRect ? menuRect.bottom + 6 : 16;

  if (menuRect && top + popH > window.innerHeight - 8) {
    top = menuRect.top - popH - 6;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - popW - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - popH - 8));

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

  setTimeout(() => input?.focus(), 0);
}

export function updateSelMenuMassTagButton(overlappingAnnIds = []) {
  const ids = Array.isArray(overlappingAnnIds)
    ? Array.from(new Set(overlappingAnnIds.filter(Boolean)))
    : [];
  _massTagAnnIds = ids;

  if (!document.getElementById('sel-mass-tag-btn') && document.getElementById('sel-menu')) {
    injectSelMenuTagPicker();
  }

  const massBtn = document.getElementById('sel-mass-tag-btn');
  if (ids.length > 0) {
    if (massBtn) {
      massBtn.textContent = `🏷️ Tag ${ids.length} ${ids.length === 1 ? 'Highlight' : 'Highlights'}`;
      massBtn.style.display = 'inline-flex';
    }
    const popover = document.getElementById('mass-tag-popover');
    if (popover?.classList.contains('open')) {
      const inputEl = document.getElementById('mtp-input');
      renderMassTagPopoverList(inputEl?.value || '');
    }
  } else {
    if (massBtn) {
      massBtn.style.display = 'none';
    }
    closeMassTagPopover();
  }
}

function injectSelMenuTagPicker() {
  const selMenu = document.getElementById('sel-menu');
  if (!selMenu) return;

  const cancelBtn = document.getElementById('sel-cancel');

  if (!document.getElementById('sel-tag-btn')) {
    const btn = document.createElement('button');
    btn.className = 'sel-btn sel-tag';
    btn.id = 'sel-tag-btn';
    btn.title = 'Active Quick-Tag (Click to cycle or select)';
    btn.innerHTML = `<span id="sel-tag-text">🏷️ Tag</span>`;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const allTopics = getAllTopicsForCurrentPdf();
      if (allTopics.length === 0) {
        toggleTagsPanel();
        return;
      }
      const current = getActiveQuickTag();
      const names = allTopics.map(t => t.name);
      let next = null;
      if (!current) {
        next = names[0];
      } else {
        const idx = names.indexOf(current);
        if (idx >= 0 && idx < names.length - 1) {
          next = names[idx + 1];
        } else {
          next = null; // wraps back to None
        }
      }
      setActiveQuickTag(next);
      toast(next ? `Quick-Tag: ${next}` : 'Quick-Tag cleared');
    });

    if (cancelBtn) {
      selMenu.insertBefore(btn, cancelBtn);
    } else {
      selMenu.appendChild(btn);
    }
  }

  if (!document.getElementById('sel-mass-tag-btn')) {
    const massBtn = document.createElement('button');
    massBtn.type = 'button';
    massBtn.className = 'sel-btn sel-mass-tag';
    massBtn.id = 'sel-mass-tag-btn';
    massBtn.title = 'Tag or untag all selected highlights at once';
    massBtn.style.display = 'none';
    massBtn.textContent = '🏷️ Tag Highlights';

    massBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    massBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const popover = document.getElementById('mass-tag-popover');
      if (popover?.classList.contains('open')) {
        closeMassTagPopover();
      } else {
        openMassTagPopover();
      }
    });

    if (cancelBtn) {
      selMenu.insertBefore(massBtn, cancelBtn);
    } else {
      selMenu.appendChild(massBtn);
    }
  }
}
