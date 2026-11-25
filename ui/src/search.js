// ═══════════════════════════════════════════════
// SEARCH — PDF text search + tag-filtered highlight & note search
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { closeOtherPanels, isUserScrolling, onScrollIdle } from './ui.js';
import { normalizeHexColor, getColorCategoryForHex } from './colors.js';
import { safeStorageGet } from './storage.js';
import { getOfflineRecord } from './offline.js';
import {
  getAllTagsWithCounts,
  getAnnsForTag,
  getTopicNotesEntry,
  getAnnTags,
  jumpToAnn,
  openTopicNotesModal,
  loadTagsForPdf,
  pickTopicColor,
} from './tags.js';

let searchMode = 'pdf'; // 'pdf' | 'ann' (kept in sync with S.searchMode)
let selectedColorFilter = ''; // '' | '#rrggbb'
let selectedTagFilter = '';   // '' | canonical tag display name
let selectedTagFilterKey = ''; // '' | lowercased trimmed tag key
let docScope = 'current';     // 'current' | 'all'
let annScope = 'all';         // 'all' | 'highlights' | 'notes'

const ANN_PAGE_SIZE = 50;
const CROSS_PDF_CHUNK_SIZE = 10;

const _HTML_ENTITY_MAP = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&lsquo;': '‘',
  '&rsquo;': '’',
};

function _normTagKey(tagName) {
  return String(tagName || '').trim().toLowerCase();
}

function _escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function _getCurTrueId() {
  return S.curPDF ? (S.curPDF.linked_pdf_id || S.curPDF.id || '') : '';
}

function _getNoteTypeFast(noteHtml) {
  if (!noteHtml || typeof noteHtml !== 'string') return 'general';
  if (noteHtml.includes('data-note-type="case"') || noteHtml.includes("data-note-type='case'")) {
    return 'case';
  }
  return 'general';
}

// Fast regex plaintext extraction (strips <style>, <script>, <img>/base64, tags; never uses DOMParser)
function _htmlToPlainText(html) {
  if (!html || typeof html !== 'string') return '';
  if (html.indexOf('<') === -1 && html.indexOf('&') === -1) {
    return html.replace(/\s+/g, ' ').trim();
  }
  let s = html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  if (s.indexOf('&') !== -1) {
    s = s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g, (m, hex, dec, named) => {
      if (hex) {
        const cp = parseInt(hex, 16);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
      }
      if (dec) {
        const cp = parseInt(dec, 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
      }
      const key = `&${named.toLowerCase()};`;
      return Object.prototype.hasOwnProperty.call(_HTML_ENTITY_MAP, key) ? _HTML_ENTITY_MAP[key] : m;
    });
  }
  return s.replace(/\s+/g, ' ').trim();
}

// Strictly escapes all literal text BEFORE wrapping hits in <mark class="sar-mark"> (zero XSS)
function _buildMarkedExcerpt(plain, queryLower, maxLen = 150) {
  const text = String(plain || '');
  if (!text) return '';
  if (!queryLower) {
    const sliced = text.length > maxLen ? text.slice(0, maxLen).trimEnd() + '…' : text;
    return _escHtml(sliced);
  }
  const lower = text.toLowerCase();
  const hitIdx = lower.indexOf(queryLower);
  if (hitIdx < 0) {
    const sliced = text.length > maxLen ? text.slice(0, maxLen).trimEnd() + '…' : text;
    return _escHtml(sliced);
  }
  const qLen = queryLower.length;
  const ctxBefore = Math.min(44, Math.floor((maxLen - qLen) / 3));
  let start = Math.max(0, hitIdx - ctxBefore);
  let end = Math.min(text.length, start + maxLen);
  if (end - start < maxLen && start > 0) {
    start = Math.max(0, end - maxLen);
  }
  if (start > 0) {
    const sp = text.indexOf(' ', start);
    if (sp > start && sp < hitIdx && sp - start < 14) start = sp + 1;
  }
  const slice = text.slice(start, end);
  const sliceLower = slice.toLowerCase();
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';

  let out = prefix;
  let pos = 0;
  let marks = 0;
  while (pos < slice.length && marks < 12) {
    const idx = sliceLower.indexOf(queryLower, pos);
    if (idx < 0) {
      out += _escHtml(slice.slice(pos));
      pos = slice.length;
      break;
    }
    if (idx > pos) out += _escHtml(slice.slice(pos, idx));
    out += `<mark class="sar-mark">${_escHtml(slice.slice(idx, idx + qLen))}</mark>`;
    pos = idx + qLen;
    marks++;
  }
  if (pos < slice.length) out += _escHtml(slice.slice(pos));
  return out + suffix;
}

// ── Versioned Lightweight Plaintext Index (Current PDF) ──
let _annIndexVersion = 0;
let _currentIndexPdfId = '';
const _currentPdfIndexMap = new Map(); // ann.id -> IndexedAnnRecord

// ── Lazy Async Chunked Cross-PDF Index (built ONLY when docScope === 'all', evicted on close/switch) ──
let _crossPdfIndex = null;
let _crossPdfBuildGen = 0;
let _crossPdfBuildingPromise = null;
let _crossPdfBuiltVersion = -1;

// ── Paginated Results State ──
let _renderedMatches = [];
let _renderedOffset = 0;
let _activeRenderQueryId = 0;
let _activeRenderQueryLower = '';
let _activeRenderQueryRaw = '';
let _annSearchRefreshTimer = null;

export function invalidateAnnSearchIndex() {
  _annIndexVersion++;
  _currentPdfIndexMap.clear();
  _currentIndexPdfId = '';
  // Mark cross-PDF index stale (evict immediately if not actively in 'all' mode)
  if (docScope !== 'all') {
    _evictCrossPdfIndex();
  } else {
    _crossPdfIndex = null;
    _crossPdfBuildingPromise = null;
    _crossPdfBuildGen++;
  }
}

function _evictCrossPdfIndex() {
  _crossPdfBuildGen++;
  _crossPdfIndex = null;
  _crossPdfBuildingPromise = null;
  _crossPdfBuiltVersion = -1;
}

function _computeAnnFingerprint(ann, tags) {
  const hiLen = (ann.highlighted_text || '').length;
  const notes = Array.isArray(ann.notes) ? ann.notes : [];
  let noteSig = String(notes.length);
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    noteSig += `:${n?.id || i}:${(n?.note_html || '').length}`;
  }
  const tagSig = tags.length ? tags.join('\u0001') : '';
  return `${ann.page || 0}|${ann.hex_color || ''}|${hiLen}|${tagSig}|${noteSig}`;
}

function _buildIndexedAnnRecord(ann, pdfId, pdfName, pdfObj, tags) {
  const tagKeys = new Set();
  const cleanTags = [];
  for (let i = 0; i < tags.length; i++) {
    const t = String(tags[i] || '').trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (!tagKeys.has(k)) {
      tagKeys.add(k);
      cleanTags.push(t);
    }
  }

  const textPlain = String(ann.highlighted_text || '').replace(/\s+/g, ' ').trim();
  const textLower = textPlain.toLowerCase();
  const rawNotes = Array.isArray(ann.notes) ? ann.notes : [];
  const notes = [];
  for (let i = 0; i < rawNotes.length; i++) {
    const n = rawNotes[i];
    if (!n || !n.note_html) continue;
    const plain = _htmlToPlainText(n.note_html);
    if (!plain) continue;
    notes.push({
      id: n.id || String(i),
      type: _getNoteTypeFast(n.note_html),
      plain,
      lower: plain.toLowerCase(),
    });
  }

  return {
    ann,
    annId: ann.id,
    pdfId,
    pdfName,
    pdfObj,
    page: ann.page || 1,
    hex: normalizeHexColor(ann.hex_color) || '',
    tags: cleanTags,
    tagKeys,
    textPlain,
    textLower,
    notes,
    fp: _computeAnnFingerprint(ann, cleanTags),
  };
}

function _getOrBuildCurrentAnnRecord(ann, pdfId, pdfName) {
  const tags = getAnnTags(ann);
  const fp = _computeAnnFingerprint(ann, tags);
  const existing = _currentPdfIndexMap.get(ann.id);
  if (existing && existing.fp === fp && existing.ann === ann) {
    return existing;
  }
  const rec = _buildIndexedAnnRecord(ann, pdfId, pdfName, S.curPDF, tags);
  _currentPdfIndexMap.set(ann.id, rec);
  return rec;
}

function _ensureCurrentPdfIndex(candidateAnns = null) {
  const trueId = _getCurTrueId();
  const pdfName = S.curPDF?.name || 'Document';
  if (trueId !== _currentIndexPdfId) {
    _currentPdfIndexMap.clear();
    _currentIndexPdfId = trueId;
  }

  const source = Array.isArray(candidateAnns)
    ? candidateAnns
    : (Array.isArray(S.annotations) ? S.annotations : []);

  const records = new Array(source.length);
  let outLen = 0;
  for (let i = 0; i < source.length; i++) {
    const ann = source[i];
    if (!ann || !ann.id) continue;
    records[outLen++] = _getOrBuildCurrentAnnRecord(ann, trueId, pdfName);
  }
  records.length = outLen;

  // Prune stale IDs if we scanned full S.annotations and map grew larger
  if (!candidateAnns && _currentPdfIndexMap.size > outLen + 32) {
    const liveIds = new Set();
    for (let i = 0; i < outLen; i++) liveIds.add(records[i].annId);
    for (const k of _currentPdfIndexMap.keys()) {
      if (!liveIds.has(k)) _currentPdfIndexMap.delete(k);
    }
  }

  return records;
}

function _setIndexStatus(msg) {
  const el = document.getElementById('search-index-status');
  if (el) el.textContent = msg || '';
}

function _syncSearchMode(nextMode) {
  searchMode = nextMode === 'ann' ? 'ann' : 'pdf';
  S.searchMode = searchMode;
}

// ── Color Filter & Tag Filter Bar Injection ──
let _lastColorFilterSig = '';

function _computeColorFilterSig() {
  const cats = S.colorCats || [];
  let catKey = '';
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i];
    if (c) catKey += `${c.hex_color || ''}:${c.name || ''}|`;
  }
  return `${S.searchMode}|${selectedColorFilter}|${S.annotations?.length || 0}|${catKey}`;
}

function _ensureColorFilterEl() {
  const panel = document.getElementById('search-panel');
  const annResults = document.getElementById('search-ann-results');
  if (!panel || !annResults) return null;

  let bar = document.getElementById('search-color-filter');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'search-color-filter';
    bar.style.cssText = 'display:none;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 12px;border-bottom:1px solid var(--navy-b,rgba(255,255,255,0.08));font-size:11px;';
    panel.insertBefore(bar, annResults);
  }
  return bar;
}

function _ensureTagBarDOM() {
  const panel = document.getElementById('search-panel');
  const annResults = document.getElementById('search-ann-results');
  if (!panel || !annResults) return null;

  const colorBar = _ensureColorFilterEl();
  let tagBar = document.getElementById('search-tag-bar');
  if (!tagBar) {
    tagBar = document.createElement('div');
    tagBar.id = 'search-tag-bar';
    tagBar.className = 'search-tag-bar';
    tagBar.style.display = 'none';
    tagBar.innerHTML = `
      <div class="search-filter-row">
        <select id="search-tag-select" class="search-tag-select" aria-label="Filter by tag">
          <option value="">All Tags</option>
        </select>
        <button type="button" id="search-tag-clear" class="search-tag-clear" title="Clear tag filter" hidden>✕</button>
        <div class="search-scope-group" id="search-doc-scope">
          <button type="button" class="search-scope-btn active" data-doc-scope="current">Current PDF</button>
          <button type="button" class="search-scope-btn" data-doc-scope="all">All PDFs</button>
        </div>
      </div>
      <div class="search-filter-row">
        <div class="search-scope-group" id="search-ann-scope">
          <button type="button" class="search-scope-btn active" data-ann-scope="all">All</button>
          <button type="button" class="search-scope-btn" data-ann-scope="highlights">Highlights</button>
          <button type="button" class="search-scope-btn" data-ann-scope="notes">Notes</button>
        </div>
        <span id="search-index-status" class="search-index-status"></span>
      </div>
    `;
    if (colorBar && colorBar.nextSibling) {
      panel.insertBefore(tagBar, colorBar.nextSibling);
    } else {
      panel.insertBefore(tagBar, annResults);
    }

    // Wire tag select
    const select = tagBar.querySelector('#search-tag-select');
    const clearBtn = tagBar.querySelector('#search-tag-clear');
    select?.addEventListener('change', () => {
      selectedTagFilter = select.value || '';
      selectedTagFilterKey = _normTagKey(selectedTagFilter);
      if (clearBtn) clearBtn.hidden = !selectedTagFilterKey;
      runSearch();
    });

    clearBtn?.addEventListener('click', () => {
      selectedTagFilter = '';
      selectedTagFilterKey = '';
      if (select) select.value = '';
      clearBtn.hidden = true;
      runSearch();
    });

    // Wire doc scope buttons
    tagBar.querySelectorAll('#search-doc-scope .search-scope-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const nextScope = btn.dataset.docScope === 'all' ? 'all' : 'current';
        if (nextScope === docScope) return;
        docScope = nextScope;
        _updateScopeButtonsUI();
        if (docScope === 'current') {
          _evictCrossPdfIndex();
          _setIndexStatus('');
          refreshSearchTagOptions();
        }
        runSearch();
      });
    });

    // Wire ann scope buttons
    tagBar.querySelectorAll('#search-ann-scope .search-scope-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const nextScope = btn.dataset.annScope || 'all';
        if (nextScope === annScope) return;
        annScope = nextScope;
        _updateScopeButtonsUI();
        runSearch();
      });
    });
  }
  return tagBar;
}

function _updateScopeButtonsUI() {
  document.querySelectorAll('#search-doc-scope .search-scope-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.docScope === docScope);
  });
  document.querySelectorAll('#search-ann-scope .search-scope-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.annScope === annScope);
  });
}

function _syncTagBarVisibility() {
  const tagBar = _ensureTagBarDOM();
  if (!tagBar) return;
  const isAnn = S.searchMode === 'ann';
  tagBar.style.display = isAnn ? 'flex' : 'none';
  if (isAnn) {
    _updateScopeButtonsUI();
    refreshSearchTagOptions();
  }
}

function refreshSearchTagOptions() {
  const select = document.getElementById('search-tag-select');
  const clearBtn = document.getElementById('search-tag-clear');
  if (!select) return;

  let tags = [];
  if (docScope === 'all' && _crossPdfIndex && _crossPdfIndex.tags) {
    tags = Array.from(_crossPdfIndex.tags.values())
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  } else {
    tags = getAllTagsWithCounts();
  }

  let matchedCanonical = '';
  if (selectedTagFilterKey) {
    const found = tags.find(t => t.key === selectedTagFilterKey);
    if (found) {
      matchedCanonical = found.name;
      selectedTagFilter = found.name;
    } else if (selectedTagFilter) {
      // Preserve explicit selection (e.g. from openSearchWithTag) if tag has 0 items or not yet loaded
      matchedCanonical = selectedTagFilter;
    }
  }

  const frag = document.createDocumentFragment();
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = docScope === 'all' ? 'All Tags (Library)' : 'All Tags';
  frag.appendChild(allOpt);

  let foundInOptions = false;
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const opt = document.createElement('option');
    opt.value = t.name;
    opt.textContent = `${t.name} (${t.count})`;
    if (matchedCanonical && t.key === selectedTagFilterKey) {
      opt.selected = true;
      foundInOptions = true;
    }
    frag.appendChild(opt);
  }

  if (selectedTagFilterKey && !foundInOptions && selectedTagFilter) {
    const extra = document.createElement('option');
    extra.value = selectedTagFilter;
    extra.textContent = `${selectedTagFilter} (0)`;
    extra.selected = true;
    frag.appendChild(extra);
  }

  select.innerHTML = '';
  select.appendChild(frag);
  select.value = selectedTagFilterKey ? (matchedCanonical || selectedTagFilter) : '';
  if (clearBtn) clearBtn.hidden = !selectedTagFilterKey;
}

function renderSearchColorFilter(force = false) {
  const bar = _ensureColorFilterEl();
  if (!bar) return;

  const isAnn = S.searchMode === 'ann';
  bar.style.display = isAnn ? 'flex' : 'none';
  if (!isAnn) {
    _lastColorFilterSig = '';
    return;
  }

  const sig = _computeColorFilterSig();
  if (!force && sig === _lastColorFilterSig && bar.childElementCount > 0) {
    return;
  }
  _lastColorFilterSig = sig;
  bar.innerHTML = '';

  const seen = new Set();
  const options = [];
  for (const cat of S.colorCats || []) {
    const norm = normalizeHexColor(cat.hex_color);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    options.push(getColorCategoryForHex(norm));
  }
  for (const ann of S.annotations || []) {
    const norm = normalizeHexColor(ann.hex_color);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    options.push(getColorCategoryForHex(norm));
  }

  if (selectedColorFilter && !seen.has(selectedColorFilter) && docScope !== 'all') {
    selectedColorFilter = '';
    _lastColorFilterSig = _computeColorFilterSig();
  }

  const makeChip = (hex, label) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sar-filter-chip' + (selectedColorFilter === hex ? ' active' : '');
    if (hex) btn.dataset.color = hex;
    btn.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:5px',
      'padding:3px 8px',
      'border-radius:999px',
      `border:1px solid ${selectedColorFilter === hex ? 'var(--gold, #c9a84c)' : 'var(--navy-b, rgba(255,255,255,0.16))'}`,
      `background:${selectedColorFilter === hex ? 'rgba(201,168,76,0.16)' : 'transparent'}`,
      'color:inherit',
      'font-size:11px',
      'cursor:pointer',
    ].join(';');
    if (hex) {
      const dot = document.createElement('span');
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${hex};display:inline-block;flex-shrink:0;`;
      btn.appendChild(dot);
    }
    const txt = document.createElement('span');
    txt.textContent = label;
    btn.appendChild(txt);
    btn.addEventListener('click', () => {
      selectedColorFilter = (selectedColorFilter === hex) ? '' : hex;
      renderSearchColorFilter(true);
      runSearch();
    });
    return btn;
  };

  const frag = document.createDocumentFragment();
  frag.appendChild(makeChip('', 'All colors'));
  for (const opt of options) {
    frag.appendChild(makeChip(opt.hex_color, opt.name));
  }
  bar.appendChild(frag);
}

export function openSearch() {
  closeOtherPanels('search-panel');
  document.getElementById('search-panel')?.classList.add('open');
  _ensureTagBarDOM();
  renderSearchColorFilter();
  _syncTagBarVisibility();
  const annResults = document.getElementById('search-ann-results');
  if (annResults) annResults.style.display = S.searchMode === 'ann' ? 'block' : 'none';
  document.getElementById('search-input')?.focus();
}

export function openSearchWithTag(tagName, initialQuery = '') {
  closeOtherPanels('search-panel');
  const panel = document.getElementById('search-panel');
  if (panel) panel.classList.add('open');

  _syncSearchMode('ann');
  document.querySelectorAll('.stab').forEach(b => {
    b.classList.toggle('active', b.dataset.stab === 'ann');
  });

  // Resolve canonical tag name case-insensitively if available
  const cleanTag = String(tagName || '').trim();
  const tagKey = _normTagKey(cleanTag);
  const allTags = getAllTagsWithCounts();
  const matched = tagKey ? allTags.find(t => t.key === tagKey) : null;
  selectedTagFilter = matched ? matched.name : cleanTag;
  selectedTagFilterKey = tagKey;
  docScope = 'current';
  _evictCrossPdfIndex();
  _setIndexStatus('');

  _ensureTagBarDOM();
  renderSearchColorFilter(true);
  _syncTagBarVisibility();

  const annResults = document.getElementById('search-ann-results');
  if (annResults) annResults.style.display = 'block';

  const input = document.getElementById('search-input');
  if (input) {
    input.value = String(initialQuery || '');
    input.focus();
  }
  runSearch();
}

export function closeSearch() {
  document.getElementById('search-panel')?.classList.remove('open');
  clearSearchHighlights();
  _searchQueryId++;
  _activeRenderQueryId++;
  _renderedMatches = [];
  _renderedOffset = 0;

  // Evict cross-PDF index and reset doc scope so memory returns to baseline
  _evictCrossPdfIndex();
  docScope = 'current';
  selectedTagFilter = '';
  selectedTagFilterKey = '';
  _updateScopeButtonsUI();
  _setIndexStatus('');

  const select = document.getElementById('search-tag-select');
  if (select) select.value = '';
  const clearBtn = document.getElementById('search-tag-clear');
  if (clearBtn) clearBtn.hidden = true;

  const countEl = document.getElementById('search-count');
  if (countEl) countEl.textContent = '';
  const inputEl = document.getElementById('search-input');
  if (inputEl) inputEl.value = '';
  const annResults = document.getElementById('search-ann-results');
  if (annResults) annResults.innerHTML = '';
}

export function clearSearchHighlights() {
  document.querySelectorAll('.srch-hi').forEach(el => el.remove());
  S.searchResults = [];
  S.searchIdx = 0;
  // Detect PDF switches and invalidate active PDF index immediately
  const curId = _getCurTrueId();
  if (_currentIndexPdfId && curId !== _currentIndexPdfId) {
    invalidateAnnSearchIndex();
  }
}

export function initSearch() {
  _syncSearchMode(S.searchMode === 'ann' ? 'ann' : 'pdf');

  // Rename Annotations tab label to "Highlights & Notes" without editing index.html
  const annTabBtn = document.querySelector('.stab[data-stab="ann"]');
  if (annTabBtn) {
    const labelSpan = annTabBtn.querySelector('span');
    if (labelSpan) labelSpan.textContent = 'Highlights & Notes';
    else annTabBtn.textContent = 'Highlights & Notes';
  }

  // Idempotently inject #search-color-filter and #search-tag-bar
  _ensureColorFilterEl();
  _ensureTagBarDOM();

  // Tab toggle
  document.querySelectorAll('.stab').forEach(btn => {
    btn.addEventListener('click', () => {
      _syncSearchMode(btn.dataset.stab);
      document.querySelectorAll('.stab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderSearchColorFilter();
      _syncTagBarVisibility();
      const annResults = document.getElementById('search-ann-results');
      if (annResults) annResults.style.display = S.searchMode === 'ann' ? 'block' : 'none';
      if (S.searchMode !== 'ann') {
        _evictCrossPdfIndex();
        _setIndexStatus('');
      }
      runSearch();
    });
  });

  // Delegated click + scroll pagination on #search-ann-results
  const annResults = document.getElementById('search-ann-results');
  if (annResults && annResults.dataset.searchWired !== '1') {
    annResults.dataset.searchWired = '1';
    annResults.addEventListener('scroll', () => {
      if (_renderedOffset >= _renderedMatches.length) return;
      if (annResults.scrollTop + annResults.clientHeight >= annResults.scrollHeight - 140) {
        _appendNextAnnResultsPage(annResults, _activeRenderQueryId);
      }
    }, { passive: true });

    annResults.addEventListener('click', async (e) => {
      const moreBtn = e.target.closest('.sar-load-more');
      if (moreBtn) {
        _appendNextAnnResultsPage(annResults, _activeRenderQueryId);
        return;
      }

      const tagPill = e.target.closest('.sar-tag-pill[data-filter-tag]');
      if (tagPill) {
        e.stopPropagation();
        const tag = tagPill.dataset.filterTag || '';
        const key = _normTagKey(tag);
        if (selectedTagFilterKey === key) {
          selectedTagFilter = '';
          selectedTagFilterKey = '';
        } else {
          selectedTagFilter = tag;
          selectedTagFilterKey = key;
        }
        refreshSearchTagOptions();
        runSearch();
        return;
      }

      const card = e.target.closest('.sar-item[data-match-idx]');
      if (!card) return;
      const idx = parseInt(card.dataset.matchIdx, 10);
      const match = Number.isInteger(idx) ? _renderedMatches[idx] : null;
      if (match) {
        await _handleAnnMatchClick(match, _activeRenderQueryRaw);
      }
    });
  }

  if (typeof window !== 'undefined') {
    const scheduleLiveAnnRefresh = () => {
      invalidateAnnSearchIndex();
      renderSearchColorFilter(true);
      refreshSearchTagOptions();
      if (S.searchMode === 'ann' && document.getElementById('search-panel')?.classList.contains('open')) {
        clearTimeout(_annSearchRefreshTimer);
        _annSearchRefreshTimer = setTimeout(() => {
          if (S.searchMode === 'ann' && document.getElementById('search-panel')?.classList.contains('open')) {
            runSearch();
          }
        }, 180);
      }
    };

    window.addEventListener('la:color-cats-changed', () => {
      renderSearchColorFilter(true);
      if (S.searchMode === 'ann' && document.getElementById('search-panel')?.classList.contains('open')) {
        runSearch();
      }
    });
    window.addEventListener('la:tags-changed', scheduleLiveAnnRefresh);
    window.addEventListener('la:annotations-changed', scheduleLiveAnnRefresh);
  }

  document.getElementById('btn-search')?.addEventListener('click', openSearch);
  document.getElementById('search-close-btn')?.addEventListener('click', closeSearch);

  let debounce = null;
  document.getElementById('search-input')?.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 180);
  });
  document.getElementById('search-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && S.searchMode === 'pdf') nextSearchResult(e.shiftKey ? -1 : 1);
    if (e.key === 'Escape') closeSearch();
  });
  document.getElementById('snext')?.addEventListener('click', () => nextSearchResult(1));
  document.getElementById('sprev')?.addEventListener('click', () => nextSearchResult(-1));

  // Ctrl+F shortcut -> opens PDF & Annotation Search panel
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
  const input = document.getElementById('search-input');
  const rawQ = input ? input.value.trim() : '';
  const q = rawQ.toLowerCase();
  const hasAnnFilter = Boolean(selectedColorFilter || selectedTagFilterKey);

  if (S.searchMode === 'pdf') {
    if (!q) {
      const countEl = document.getElementById('search-count');
      if (countEl) countEl.textContent = '';
      return;
    }
    runPDFSearch(q);
    return;
  }

  // Highlights & Notes mode
  if (!q && !hasAnnFilter && docScope !== 'all') {
    _activeRenderQueryId++;
    _renderedMatches = [];
    _renderedOffset = 0;
    const countEl = document.getElementById('search-count');
    if (countEl) countEl.textContent = '';
    const results = document.getElementById('search-ann-results');
    if (results) results.innerHTML = '';
    _setIndexStatus('');
    return;
  }
  runAnnSearch(q, rawQ);
}

let _searchQueryId = 0;

export async function extractPageText(doc, pageNum) {
  if (S.pages[pageNum]?.textItems?.length) return S.pages[pageNum].textItems;

  const trueId = S.curPDF?.linked_pdf_id || S.curPDF?.id || null;
  const scaleKey = String(Math.round((S.scale || 1.5) * 100));

  // 1. Check Disk Page Vault on D: drive if running in Desktop App
  if (trueId && typeof window !== 'undefined' && window.__DESKTOP_PDFIUM__?.getPageText) {
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

    // 2. Fallback to OCR cache if page is scanned or has more OCR lines than native tokens
    try {
      const { getOcrPageData } = await import('./ocr.js');
      const ocrData = getOcrPageData(trueId, pageNum);
      if (ocrData && Array.isArray(ocrData.lines) && ocrData.lines.length > 0 && textItems.length < ocrData.lines.length) {
        const scale = S.scale || 1.5;
        const ocrItems = ocrData.lines
          .filter(l => l && l.str && l.str.trim())
          .map(l => ({
            str: l.str,
            x: (l.x || 0) * scale,
            y: (l.y || 0) * scale,
            w: (l.w || 60) * scale,
            h: (l.h || 14) * scale,
            ocr: true,
          }));
        if (ocrItems.length > 0) {
          if (S.pages[pageNum]) S.pages[pageNum].textItems = ocrItems;
          return ocrItems;
        }
      }
    } catch {}

    if (S.pages[pageNum]) S.pages[pageNum].textItems = textItems;
    if (trueId && textItems.length > 0 && typeof window !== 'undefined' && window.__DESKTOP_PDFIUM__?.savePageText) {
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

// Background indexer for all pages when PDF opens (polite idle batching)
export async function indexAllPagesText(doc) {
  if (!doc || !S.totalPages) return;
  const total = S.totalPages;
  const BATCH_SIZE = total > 80 ? 2 : 4;
  for (let i = 1; i <= total; i += BATCH_SIZE) {
    if (doc !== S.pdfDoc) return; // switched PDF
    if (isUserScrolling()) {
      await new Promise(resolve => {
        const unsub = onScrollIdle(() => {
          unsub();
          resolve();
        });
      });
      if (doc !== S.pdfDoc) return;
    }
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
        window.requestIdleCallback(() => r(), { timeout: 400 });
      } else {
        setTimeout(r, 80);
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

  for (let i = 0; i < S.searchResults.length; i++) {
    drawSearchHL(S.searchResults[i], false, i);
  }
  S.searchIdx = 0;

  if (S.searchResults.length) {
    highlightCurrentResult();
  } else {
    countEl.textContent = 'No results';
  }
}

export function drawSearchHL(res, isCurrent, srIdx = -1) {
  const pg = S.pages[res.page];
  if (!pg || !pg.rendered || !pg.srchOv) return;
  const idx = srIdx >= 0 ? srIdx : S.searchResults.indexOf(res);
  // Prevent duplicate highlights
  const existing = pg.srchOv.querySelector(`.srch-hi[data-sridx="${idx}"]`);
  if (existing) {
    existing.classList.toggle('current', isCurrent);
    return;
  }
  const d  = document.createElement('div');
  d.className = 'srch-hi' + (isCurrent ? ' current' : '');
  d.style.cssText = `left:${res.matchX}px;top:${res.matchY - res.matchH * .1}px;width:${res.matchW}px;height:${res.matchH * 1.2}px`;
  d.dataset.sridx = idx;
  pg.srchOv.appendChild(d);
}

let _highlightGen = 0;

async function highlightCurrentResult() {
  const myGen = ++_highlightGen;
  document.querySelectorAll('.srch-hi').forEach(el => el.classList.remove('current'));
  const res = S.searchResults[S.searchIdx]; if (!res) return;

  // Scroll to the match itself (a little above it), not just the page top.
  const pageH = S.pages?.[res.page]?.viewport?.height || 0;
  const ratio = pageH ? Math.min(0.95, Math.max(0, (res.matchY - 150) / pageH)) : 0;

  const { jumpToPage } = await import('./ui.js');
  await jumpToPage(res.page, false, ratio);
  if (myGen !== _highlightGen) return; // user already moved to another result

  drawSearchHL(res, true, S.searchIdx);
  const el = document.querySelector(`.srch-hi[data-sridx="${S.searchIdx}"]`);
  if (el) el.classList.add('current');
  document.getElementById('search-count').textContent = `${S.searchIdx + 1} / ${S.searchResults.length}`;
}

function nextSearchResult(dir) {
  if (!S.searchResults.length) return;
  S.searchIdx = (S.searchIdx + dir + S.searchResults.length) % S.searchResults.length;
  highlightCurrentResult();
}

// ── Lazy Async Chunked Cross-PDF Indexer (All PDFs) ──
async function _loadRawAnnsForPdf(trueId) {
  // 1. localStorage cache (instant)
  try {
    const raw = safeStorageGet('local_anns_' + trueId);
    if (raw) {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}

  // 2. IndexedDB offline_records (for large >1.5MB sets or offline-synced PDFs)
  try {
    const rec = await getOfflineRecord(trueId);
    if (rec && Array.isArray(rec.annotations)) {
      return rec.annotations;
    }
  } catch {}

  // 3. Desktop SQLite fallback (if running inside Legal Annotator Desktop)
  if (typeof window !== 'undefined' && window.__DESKTOP_SQLITE__?.loadAnnotations) {
    try {
      const sqlAnns = await window.__DESKTOP_SQLITE__.loadAnnotations(trueId);
      if (Array.isArray(sqlAnns)) return sqlAnns;
    } catch {}
  }

  return [];
}

function _loadRawTagDataForPdf(trueId) {
  try {
    const raw = safeStorageGet('local_pdf_tags_v1_' + trueId);
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function _ensureCrossPdfIndex() {
  if (_crossPdfIndex && _crossPdfBuiltVersion === _annIndexVersion) {
    return _crossPdfIndex;
  }
  if (_crossPdfBuildingPromise) {
    return _crossPdfBuildingPromise;
  }

  const myBuildGen = ++_crossPdfBuildGen;
  const targetVersion = _annIndexVersion;

  const buildPromise = (async () => {
    const curTrueId = _getCurTrueId();
    const seenPdfIds = new Set();
    const uniquePdfs = [];

    if (S.curPDF) {
      const cid = S.curPDF.linked_pdf_id || S.curPDF.id;
      if (cid) {
        seenPdfIds.add(cid);
        uniquePdfs.push({ trueId: cid, pdf: S.curPDF });
      }
    }
    for (const pdf of S.pdfs || []) {
      if (!pdf) continue;
      const tid = pdf.linked_pdf_id || pdf.id;
      if (!tid || seenPdfIds.has(tid)) continue;
      seenPdfIds.add(tid);
      uniquePdfs.push({ trueId: tid, pdf });
    }

    const total = uniquePdfs.length;
    const entries = [];
    const topics = [];
    const tagsMap = new Map(); // lowerKey -> { name, key, color, count }

    const registerTag = (name, color, increment) => {
      const clean = String(name || '').trim();
      const key = _normTagKey(clean);
      if (!key) return;
      let rec = tagsMap.get(key);
      if (!rec) {
        rec = { name: clean, key, color: color || pickTopicColor(clean), count: 0 };
        tagsMap.set(key, rec);
      }
      rec.count += increment;
    };

    for (let i = 0; i < total; i += CROSS_PDF_CHUNK_SIZE) {
      if (myBuildGen !== _crossPdfBuildGen || docScope !== 'all') return null;

      const end = Math.min(i + CROSS_PDF_CHUNK_SIZE, total);
      _setIndexStatus(`Indexing ${i} / ${total} PDFs…`);

      for (let j = i; j < end; j++) {
        if (myBuildGen !== _crossPdfBuildGen || docScope !== 'all') return null;
        const { trueId, pdf } = uniquePdfs[j];
        const pdfName = pdf.name || 'Document';

        if (trueId === curTrueId) {
          // Active PDF: reuse already-built compact plaintext records
          const curRecs = _ensureCurrentPdfIndex();
          for (let r = 0; r < curRecs.length; r++) {
            const rec = curRecs[r];
            entries.push(rec);
            for (const t of rec.tags) registerTag(t, null, 1);
          }
          const activeTags = getAllTagsWithCounts();
          for (const t of activeTags) {
            registerTag(t.name, t.color, 0);
            const tEntry = getTopicNotesEntry(t.name);
            if (tEntry && tEntry.notesPlain) {
              topics.push({
                pdfId: trueId,
                pdfName,
                pdfObj: pdf,
                tagName: tEntry.name,
                tagKey: tEntry.key,
                color: tEntry.color,
                notesPlain: tEntry.notesPlain,
                notesLower: tEntry.notesPlainLower,
              });
            }
          }
        } else {
          // Other PDF: load raw data, extract ONLY compact plaintext strings, release raw HTML/base64 immediately
          const rawAnns = await _loadRawAnnsForPdf(trueId);
          if (myBuildGen !== _crossPdfBuildGen || docScope !== 'all') return null;
          const rawTagData = _loadRawTagDataForPdf(trueId);
          const annTagsMap = rawTagData?.annTags || null;

          if (Array.isArray(rawAnns) && rawAnns.length > 0) {
            for (let a = 0; a < rawAnns.length; a++) {
              const ann = rawAnns[a];
              if (!ann || !ann.id) continue;
              const mergedTags = [];
              const seenLower = new Set();
              const addT = (list) => {
                if (!Array.isArray(list)) return;
                for (let t = 0; t < list.length; t++) {
                  const s = String(list[t] || '').trim();
                  if (!s) continue;
                  const k = s.toLowerCase();
                  if (!seenLower.has(k)) {
                    seenLower.add(k);
                    mergedTags.push(s);
                  }
                }
              };
              addT(ann.tags);
              if (annTagsMap && annTagsMap[ann.id]) addT(annTagsMap[ann.id]);

              // Build compact record WITHOUT holding reference to raw ann/note_html/rects
              const textPlain = String(ann.highlighted_text || '').replace(/\s+/g, ' ').trim();
              const rawNotes = Array.isArray(ann.notes) ? ann.notes : [];
              const notes = [];
              for (let nIdx = 0; nIdx < rawNotes.length; nIdx++) {
                const n = rawNotes[nIdx];
                if (!n || !n.note_html) continue;
                const plain = _htmlToPlainText(n.note_html);
                if (!plain) continue;
                notes.push({
                  id: n.id || String(nIdx),
                  type: _getNoteTypeFast(n.note_html),
                  plain,
                  lower: plain.toLowerCase(),
                });
              }

              entries.push({
                ann: null,
                annId: ann.id,
                pdfId: trueId,
                pdfName,
                pdfObj: pdf,
                page: ann.page || 1,
                hex: normalizeHexColor(ann.hex_color) || '',
                tags: mergedTags,
                tagKeys: seenLower,
                textPlain,
                textLower: textPlain.toLowerCase(),
                notes,
              });

              for (const t of mergedTags) registerTag(t, null, 1);
            }
          }

          if (rawTagData?.topics && typeof rawTagData.topics === 'object') {
            for (const [k, topic] of Object.entries(rawTagData.topics)) {
              const tName = String(topic?.name || k || '').trim();
              const tKey = _normTagKey(tName);
              if (!tKey) continue;
              const tColor = topic?.color || pickTopicColor(tName);
              registerTag(tName, tColor, 0);
              const plain = _htmlToPlainText(topic?.notesHtml || '');
              if (plain) {
                topics.push({
                  pdfId: trueId,
                  pdfName,
                  pdfObj: pdf,
                  tagName: tName,
                  tagKey: tKey,
                  color: tColor,
                  notesPlain: plain,
                  notesLower: plain.toLowerCase(),
                });
              }
            }
          }
        }
      }

      // Yield to event loop between chunks so UI stays 100% responsive
      await new Promise(r => setTimeout(r, 0));
    }

    if (myBuildGen !== _crossPdfBuildGen || docScope !== 'all') return null;

    const built = { entries, topics, tags: tagsMap, pdfCount: total };
    _crossPdfIndex = built;
    _crossPdfBuiltVersion = targetVersion;
    _setIndexStatus(`${total} PDF${total === 1 ? '' : 's'} indexed`);
    refreshSearchTagOptions();
    return built;
  })();

  _crossPdfBuildingPromise = buildPromise;
  try {
    return await buildPromise;
  } finally {
    if (_crossPdfBuildingPromise === buildPromise) {
      _crossPdfBuildingPromise = null;
    }
  }
}

// ── Annotation / Highlight / Note / Topic Notes Search ──
function _collectMatchesFromIndex(entries, topics, qLower, activeTagKey, activeColor, scope) {
  const matches = [];

  // 1. Topic Notes (included when scope is 'all' or 'notes' and no specific highlight color chip is active)
  if ((scope === 'all' || scope === 'notes') && !activeColor && Array.isArray(topics)) {
    for (let i = 0; i < topics.length; i++) {
      const t = topics[i];
      if (!t || !t.notesPlain) continue;
      if (activeTagKey && t.tagKey !== activeTagKey) continue;
      if (qLower && !t.notesLower.includes(qLower)) continue;
      matches.push({
        kind: 'topic',
        pdfId: t.pdfId,
        pdfName: t.pdfName,
        pdfObj: t.pdfObj,
        page: 0,
        tagName: t.tagName,
        tags: [t.tagName],
        color: t.color,
        excerptPlain: t.notesPlain,
        quotePlain: '',
        noteType: null,
        ann: null,
        annId: null,
      });
    }
  }

  // 2. Highlights & EVERY Attached Annotation Note (fixes the old `break` bug)
  for (let i = 0; i < entries.length; i++) {
    const rec = entries[i];
    if (!rec) continue;
    if (activeTagKey && !rec.tagKeys.has(activeTagKey)) continue;
    if (activeColor && rec.hex !== activeColor) continue;

    const notes = rec.notes;

    if (scope === 'highlights') {
      if (!qLower || rec.textLower.includes(qLower)) {
        matches.push({
          kind: 'highlight',
          pdfId: rec.pdfId,
          pdfName: rec.pdfName,
          pdfObj: rec.pdfObj,
          page: rec.page,
          tags: rec.tags,
          color: rec.hex,
          excerptPlain: rec.textPlain || '(Box Highlight)',
          quotePlain: '',
          noteType: null,
          ann: rec.ann,
          annId: rec.annId,
        });
      }
      continue;
    }

    if (scope === 'notes') {
      for (let j = 0; j < notes.length; j++) {
        const n = notes[j];
        if (!qLower || n.lower.includes(qLower)) {
          matches.push({
            kind: n.type === 'case' ? 'case' : 'note',
            pdfId: rec.pdfId,
            pdfName: rec.pdfName,
            pdfObj: rec.pdfObj,
            page: rec.page,
            tags: rec.tags,
            color: rec.hex,
            excerptPlain: n.plain,
            quotePlain: rec.textPlain,
            noteType: n.type,
            ann: rec.ann,
            annId: rec.annId,
          });
        }
      }
      continue;
    }

    // scope === 'all'
    if (!qLower) {
      // Browse mode (e.g. Tag "A" selected with empty query): 1 clean card per highlight with first note context
      const firstNote = notes[0] || null;
      matches.push({
        kind: firstNote ? (firstNote.type === 'case' ? 'case' : 'note') : 'highlight',
        pdfId: rec.pdfId,
        pdfName: rec.pdfName,
        pdfObj: rec.pdfObj,
        page: rec.page,
        tags: rec.tags,
        color: rec.hex,
        excerptPlain: firstNote ? firstNote.plain : (rec.textPlain || '(Box Highlight)'),
        quotePlain: firstNote ? rec.textPlain : '',
        noteType: firstNote ? firstNote.type : null,
        extraNotesCount: notes.length > 1 ? notes.length - 1 : 0,
        ann: rec.ann,
        annId: rec.annId,
      });
      continue;
    }

    // Text query in scope === 'all': check highlight text AND EVERY note in ann.notes[]!
    const textHit = rec.textLower.includes(qLower);
    let matchedAnyNote = false;
    for (let j = 0; j < notes.length; j++) {
      const n = notes[j];
      if (n.lower.includes(qLower)) {
        matchedAnyNote = true;
        matches.push({
          kind: n.type === 'case' ? 'case' : 'note',
          pdfId: rec.pdfId,
          pdfName: rec.pdfName,
          pdfObj: rec.pdfObj,
          page: rec.page,
          tags: rec.tags,
          color: rec.hex,
          excerptPlain: n.plain,
          quotePlain: rec.textPlain,
          noteType: n.type,
          ann: rec.ann,
          annId: rec.annId,
        });
      }
    }
    if (textHit) {
      matches.push({
        kind: 'highlight',
        pdfId: rec.pdfId,
        pdfName: rec.pdfName,
        pdfObj: rec.pdfObj,
        page: rec.page,
        tags: rec.tags,
        color: rec.hex,
        excerptPlain: rec.textPlain || '(Box Highlight)',
        quotePlain: '',
        noteType: null,
        ann: rec.ann,
        annId: rec.annId,
      });
    } else if (!matchedAnyNote) {
      // No hit
    }
  }

  return matches;
}

function _buildAnnMatchCardEl(m, idx, qLower, showPdfName) {
  const item = document.createElement('div');
  item.className = 'sar-item';
  item.dataset.matchIdx = String(idx);

  let badgeClass = 'sar-type-highlight';
  let badgeLabel = 'Highlight';
  if (m.kind === 'case') {
    badgeClass = 'sar-type-case';
    badgeLabel = 'Case';
  } else if (m.kind === 'note') {
    badgeClass = 'sar-type-note';
    badgeLabel = 'Note';
  } else if (m.kind === 'topic') {
    badgeClass = 'sar-type-topic';
    badgeLabel = 'Topic Note';
  }

  const catInfo = m.kind !== 'topic' ? getColorCategoryForHex(m.color) : null;
  const dotColor = m.kind === 'topic'
    ? (m.color || '#c9a84c')
    : (catInfo?.hex_color || m.color || '#c9a84c');

  const pageText = m.kind === 'topic'
    ? `Topic: ${m.tagName || ''}`
    : `Page ${m.page}${m.extraNotesCount ? ` · +${m.extraNotesCount} note${m.extraNotesCount === 1 ? '' : 's'}` : ''}`;

  const pdfSpan = showPdfName && m.pdfName
    ? `<span class="sar-pdf-name" title="${_escHtml(m.pdfName)}">${_escHtml(m.pdfName)}</span>`
    : '';

  const excerptHtml = _buildMarkedExcerpt(m.excerptPlain, qLower, 160);
  const quoteLine = m.quotePlain
    ? `<div class="sar-ex">"${_buildMarkedExcerpt(m.quotePlain, qLower, 85)}"</div>`
    : '';

  let tagsHtml = '';
  if (Array.isArray(m.tags) && m.tags.length > 0) {
    const pills = m.tags.map(t => {
      const isAct = Boolean(selectedTagFilterKey && _normTagKey(t) === selectedTagFilterKey);
      return `<span class="sar-tag-pill${isAct ? ' active' : ''}" data-filter-tag="${_escHtml(t)}" title="Filter by ${_escHtml(t)}">${_escHtml(t)}</span>`;
    }).join('');
    tagsHtml = `<div class="sar-tags">${pills}</div>`;
  }

  item.innerHTML =
    `<div class="sar-meta">` +
      `<span class="sar-type-badge ${badgeClass}"><span style="width:6px;height:6px;border-radius:50%;background:${_escHtml(dotColor)};display:inline-block;margin-right:4px;vertical-align:middle;"></span>${badgeLabel}</span>` +
      `<span class="sar-page">${_escHtml(pageText)}</span>` +
      pdfSpan +
    `</div>` +
    quoteLine +
    `<div class="sar-text">${excerptHtml}</div>` +
    tagsHtml;

  return item;
}

function _appendNextAnnResultsPage(resultsEl, expectedQueryId) {
  if (!resultsEl || expectedQueryId !== _activeRenderQueryId) return;
  if (_renderedOffset >= _renderedMatches.length) return;

  resultsEl.querySelector('.sar-load-more')?.remove();

  const end = Math.min(_renderedOffset + ANN_PAGE_SIZE, _renderedMatches.length);
  const showPdfName = docScope === 'all';
  const frag = document.createDocumentFragment();
  for (; _renderedOffset < end; _renderedOffset++) {
    frag.appendChild(_buildAnnMatchCardEl(_renderedMatches[_renderedOffset], _renderedOffset, _activeRenderQueryLower, showPdfName));
  }

  const remaining = _renderedMatches.length - _renderedOffset;
  if (remaining > 0) {
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'sar-load-more';
    moreBtn.textContent = `Show more (${remaining} remaining)`;
    frag.appendChild(moreBtn);
  }
  resultsEl.appendChild(frag);
}

async function _handleAnnMatchClick(match, rawQuery) {
  const curTrueId = _getCurTrueId();

  // 1. Topic Notes hit
  if (match.kind === 'topic') {
    if (match.pdfId && match.pdfId !== curTrueId && match.pdfObj) {
      const { openPDFFromLibrary } = await import('./viewer.js');
      await openPDFFromLibrary(match.pdfObj);
      await loadTagsForPdf(match.pdfId);
    }
    openTopicNotesModal(match.tagName, rawQuery || '');
    return;
  }

  // 2. Other PDF highlight/note hit (All PDFs scope)
  let targetAnn = match.ann;
  if (match.pdfId && match.pdfId !== curTrueId && match.pdfObj) {
    const { openPDFFromLibrary } = await import('./viewer.js');
    await openPDFFromLibrary(match.pdfObj);
    targetAnn = (S.annotations || []).find(a => String(a.id) === String(match.annId)) || null;
  } else if (!targetAnn && match.annId) {
    targetAnn = (S.annotations || []).find(a => String(a.id) === String(match.annId)) || null;
  }

  if (!targetAnn) return;

  const { jumpToPage } = await import('./ui.js');
  await jumpToPage(targetAnn.page);
  await jumpToAnn(targetAnn);
  const { openAnnPanel } = await import('./annotate.js');
  openAnnPanel(targetAnn);

  if (match.noteType === 'case' || match.noteType === 'general') {
    document.querySelector(`.ap-tab[data-aptab="${match.noteType}"]`)?.click();
  }
}

async function runAnnSearch(q, rawQ = q) {
  const myQueryId = ++_searchQueryId;
  _activeRenderQueryId = myQueryId;
  _activeRenderQueryLower = q;
  _activeRenderQueryRaw = rawQ;

  const results = document.getElementById('search-ann-results');
  const countEl = document.getElementById('search-count');
  if (!results) return;
  results.style.display = 'block';
  renderSearchColorFilter();
  _syncTagBarVisibility();

  const curTrueId = _getCurTrueId();
  let entries = [];
  let topics = [];

  if (docScope === 'all') {
    const cross = await _ensureCrossPdfIndex();
    if (myQueryId !== _searchQueryId || S.searchMode !== 'ann' || docScope !== 'all') return;
    if (!cross) return;

    // If user toggled "All PDFs" with no query/tag/color yet, prompt cleanly without dumping everything
    if (!q && !selectedTagFilterKey && !selectedColorFilter) {
      _renderedMatches = [];
      _renderedOffset = 0;
      if (countEl) countEl.textContent = '';
      results.innerHTML = `<div class="sar-empty">Indexed ${cross.pdfCount} PDF${cross.pdfCount === 1 ? '' : 's'} — type a query or choose a tag to search.</div>`;
      return;
    }

    entries = cross.entries;
    topics = cross.topics;
  } else {
    // Current PDF: O(1) tag pre-filter via tags.js case-insensitive index when tag selected
    const candidates = selectedTagFilterKey
      ? getAnnsForTag(selectedTagFilter)
      : (S.annotations || []);
    entries = _ensureCurrentPdfIndex(candidates);

    const curPdfName = S.curPDF?.name || 'Document';
    if (selectedTagFilterKey) {
      const tEntry = getTopicNotesEntry(selectedTagFilter);
      if (tEntry && tEntry.notesPlain) {
        topics = [{
          pdfId: curTrueId,
          pdfName: curPdfName,
          pdfObj: S.curPDF,
          tagName: tEntry.name,
          tagKey: tEntry.key,
          color: tEntry.color,
          notesPlain: tEntry.notesPlain,
          notesLower: tEntry.notesPlainLower,
        }];
      }
    } else {
      const allTags = getAllTagsWithCounts();
      for (let i = 0; i < allTags.length; i++) {
        const tEntry = getTopicNotesEntry(allTags[i].name);
        if (tEntry && tEntry.notesPlain) {
          topics.push({
            pdfId: curTrueId,
            pdfName: curPdfName,
            pdfObj: S.curPDF,
            tagName: tEntry.name,
            tagKey: tEntry.key,
            color: tEntry.color,
            notesPlain: tEntry.notesPlain,
            notesLower: tEntry.notesPlainLower,
          });
        }
      }
    }
    _setIndexStatus(`${entries.length} item${entries.length === 1 ? '' : 's'}`);
  }

  if (myQueryId !== _searchQueryId) return;

  const matched = _collectMatchesFromIndex(entries, topics, q, selectedTagFilterKey, selectedColorFilter, annScope);

  // Sort: Current PDF first (in All PDFs mode), then PDF name, then Topic Notes first, then Page ascending
  matched.sort((a, b) => {
    if (docScope === 'all' && a.pdfId !== b.pdfId) {
      if (a.pdfId === curTrueId) return -1;
      if (b.pdfId === curTrueId) return 1;
      const cmp = (a.pdfName || '').localeCompare(b.pdfName || '');
      if (cmp !== 0) return cmp;
    }
    if (a.kind === 'topic' && b.kind !== 'topic') return -1;
    if (b.kind === 'topic' && a.kind !== 'topic') return 1;
    return (a.page || 0) - (b.page || 0);
  });

  if (countEl) {
    countEl.textContent = matched.length
      ? `${matched.length} match${matched.length === 1 ? '' : 'es'}`
      : 'No matches';
  }

  _renderedMatches = matched;
  _renderedOffset = 0;
  results.innerHTML = '';
  results.scrollTop = 0;

  if (!matched.length) {
    results.innerHTML = '<div class="sar-empty">No matching highlights or notes.</div>';
    return;
  }

  _appendNextAnnResultsPage(results, myQueryId);
}
