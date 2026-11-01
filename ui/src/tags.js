// ═══════════════════════════════════════════════════════════════════════════
// TAGS & TOPIC COVERAGE WORKSPACE — Tags, Quick Step Scroll, & Outside Laws
// ═══════════════════════════════════════════════════════════════════════════
import { S } from './state.js';
import { toast, autosave, closeOtherPanels } from './ui.js';
import { dbGetSetting, dbSetSetting } from './db.js';
import { safeStorageSet, safeStorageGet } from './storage.js';
import {
  handlePaste, showTablePicker, insertBannerHeader,
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

  safeStorageSet('local_pdf_tags_v1_' + trueId, JSON.stringify(currentTagData));
  if (!options.skipSaveAnn && trueId) {
    safeStorageSet('local_anns_' + trueId, JSON.stringify(S.annotations));
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

  if (!options.skipSaveAnn && trueId) {
    safeStorageSet('local_anns_' + trueId, JSON.stringify(S.annotations));
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

export function getAllTopicsForCurrentPdf() {
  if (!currentTagData || !currentTagData.topics) return [];
  const list = Object.values(currentTagData.topics);
  return list.map(t => {
    const count = (S.annotations || []).filter(a => getAnnTags(a).includes(t.name)).length;
    return { ...t, count };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function onAnnDeleted(annId) {
  if (!annId || !currentTagData) return;
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
export function redrawTagBadgeForAnn(ann) {
  if (!ann) return;
  document.querySelectorAll(`.ann-tag-pill-badge[data-id="${ann.id}"]`).forEach(el => el.remove());

  const tags = getAnnTags(ann);
  if (!tags || tags.length === 0) return;

  const pg = S.pages[ann.page];
  if (!pg || !pg.rendered || !pg.annOv) return;

  const firstRect = ann.rects && ann.rects[0];
  if (!firstRect) return;

  const badge = document.createElement('div');
  badge.className = 'ann-tag-pill-badge';
  badge.dataset.id = ann.id;
  badge.style.left = `${Math.max(2, firstRect.x + firstRect.w - 6)}px`;
  badge.style.top = `${Math.max(2, firstRect.y - 12)}px`;

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
  document.querySelectorAll('.ann-tag-pill-badge').forEach(el => el.remove());
  if (!S.annotations || !Array.isArray(S.annotations)) return;
  for (const ann of S.annotations) {
    redrawTagBadgeForAnn(ann);
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
  const matching = (S.annotations || []).filter(a => getAnnTags(a).includes(tagName));
  if (!matching.length) {
    toast(`No highlights tagged with "${tagName}"`);
    return;
  }
  matching.sort((a, b) => (a.page - b.page) || ((a.rects?.[0]?.y || 0) - (b.rects?.[0]?.y || 0)));

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
  const totalTaggedAnns = (S.annotations || []).filter(a => getAnnTags(a).length > 0).length;

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

function renderSingleTopicView(container, tagName) {
  const topic = currentTagData?.topics?.[tagName] || {
    name: tagName,
    color: pickTopicColor(tagName),
    notesHtml: '',
  };
  const color = topic.color || pickTopicColor(tagName);
  const matching = (S.annotations || []).filter(a => getAnnTags(a).includes(tagName));
  matching.sort((a, b) => (a.page - b.page) || ((a.rects?.[0]?.y || 0) - (b.rects?.[0]?.y || 0)));

  const curIdx = (_tagJumpIndices[tagName] ?? -1) + 1;
  const posLabel = matching.length > 0 ? (curIdx > 0 ? `${curIdx} of ${matching.length}` : `1 of ${matching.length}`) : '0 of 0';

  let listHtml = '';
  if (matching.length === 0) {
    listHtml = `
      <div class="tp-empty">
        <div style="font-size:32px;margin-bottom:8px">🏷️</div>
        <div style="font-weight:600;color:#e8e4db;margin-bottom:4px">No highlights tagged "${escapeHtml(tagName)}" yet.</div>
        <div style="font-size:12px;color:var(--muted);line-height:1.5">Highlight provisions in the codal and click <strong>+ ${escapeHtml(tagName)}</strong> in the Notes Panel to link them to this topic!</div>
      </div>
    `;
  } else {
    listHtml = matching.map(ann => {
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
    }).join('');
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
    <div class="tp-anns-list">${listHtml}</div>
  `;

  // Wire buttons
  container.querySelector('#tp-btn-open-workspace')?.addEventListener('click', () => {
    openTopicNotesModal(tagName);
  });

  container.querySelector('#tp-step-prev')?.addEventListener('click', () => jumpThroughTag(tagName, -1));
  container.querySelector('#tp-step-next')?.addEventListener('click', () => jumpThroughTag(tagName, 1));

  container.querySelectorAll('[data-jump]').forEach(btn => {
    btn.addEventListener('click', () => {
      const annId = btn.dataset.jump;
      const target = S.annotations?.find(a => a.id === annId);
      if (target) jumpToAnn(target);
    });
  });

  container.querySelectorAll('[data-untag]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const annId = btn.dataset.untag;
      const target = S.annotations?.find(a => a.id === annId);
      if (target) {
        await removeTagFromAnn(target, tagName);
      }
    });
  });
}

function renderAllTopicsView(container, allTopics) {
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
  const matching = (S.annotations || []).filter(a => getAnnTags(a).includes(tagName));
  matching.sort((a, b) => (a.page - b.page) || ((a.rects?.[0]?.y || 0) - (b.rects?.[0]?.y || 0)));

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

// ── 8. Injection & Initialization ──
export function initTagsPanel() {
  injectTagsCSS();
  injectToolbarButton();
  injectTagsPanelDOM();
  injectTopicNotesModalDOM();
  injectSelMenuTagPicker();
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
      font-family: 'Inter', -apple-system, sans-serif;
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
    .tp-btn-open-notes {
      width: 100%;
      background: rgba(201,168,76,0.12);
      border: 1px solid var(--gold);
      color: var(--gold);
      border-radius: 6px;
      padding: 7px 12px;
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
      font-family: 'Libre Baskerville', serif;
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
      font-family: 'Libre Baskerville', serif;
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

  // Wire editor input
  const ed = modal.querySelector('#topic-notes-editor');
  ed?.addEventListener('input', () => saveTopicEditorContent());
  ed?.addEventListener('paste', handlePaste);

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

function injectSelMenuTagPicker() {
  const selMenu = document.getElementById('sel-menu');
  if (!selMenu || document.getElementById('sel-tag-btn')) return;

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

  const cancelBtn = document.getElementById('sel-cancel');
  if (cancelBtn) {
    selMenu.insertBefore(btn, cancelBtn);
  } else {
    selMenu.appendChild(btn);
  }
}
