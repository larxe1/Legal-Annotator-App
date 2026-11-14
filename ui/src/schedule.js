// ═══════════════════════════════════════════════════════════════════════════
// EDITABLE CLASS SCHEDULE & SUBJECT SYLLABUS INTEGRATION
// Customizable weekly schedule (cloud-synced to Supabase app_settings) with
// Google Calendar sync (OAuth + iCal .ics), College-Only filtering,
// Weekly Docket vs. Calendar Grid views, and Subject Syllabus integration.
// ═══════════════════════════════════════════════════════════════════════════

import { S } from './state.js';
import { toast, openModal, closeModal } from './ui.js';
import { safeStorageGet, safeStorageSet } from './storage.js';
import { dbGetSetting, dbSetSetting } from './db.js';
import { getSubjectBinderColor, getSubjectForPdf } from './goodnotes-ui.js';
import { openPDFFromLibrary } from './viewer.js';

const SCHEDULE_STORAGE_KEY = 'custom_class_schedule_v1';
const SYLLABUS_STORAGE_KEY = 'subj_syllabus_v1';
const SCHEDULE_MIGRATED_V2_KEY = 'schedule_gcal_migrated_v2';
const GCAL_PREFS_KEY = 'gcal_sync_prefs_v1';
const GCAL_EVENTS_KEY = 'gcal_synced_events_v1';
const VIEW_MODE_KEY = 'schedule_view_mode_v1';
const GRID_SPAN_KEY = 'schedule_grid_span_v1';

const GCAL_LOGIN_HINT = 'ec.mataac@gmail.com';
const GCAL_OAUTH_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

const NON_COLLEGE_KEYWORDS = [
  'bday', 'birthday', 'bonifacio', 'holiday', 'anniversary',
  'christmas', 'new year', 'dinner', 'lunch', 'breakfast',
  'party', 'dentist', 'doctor', 'clinic', 'flight',
  'vacation', 'gym', 'payday', 'errand'
];

const COLLEGE_LAW_KEYWORDS = [
  'sales', 'crimpro', 'criminal', 'torts', 'damages',
  'insurance', 'property', 'civil', 'consti', 'obligations',
  'contracts', 'persons', 'labor', 'tax', 'remedial',
  'evidence', 'commercial', 'corp', 'ethics', 'law',
  'lec', 'recit', 'juris', 'statcon'
];

const DAY_ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const JS_DAY_TO_CODE = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const ICS_BYDAY_TO_JS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// Default initial schedule matching the MON–FRI law school curriculum
export const DEFAULT_SCHEDULE = [
  { id: 'sched_1', day: 'MON', subject: '103: Sales', time: '9:00 - 11:00 AM', prof: 'Atty. Ryan Anthony Malit · 321' },
  { id: 'sched_2', day: 'MON', subject: '124: CrimPro', time: '2:30 - 4:00 PM', prof: 'Atty. Noel Lazaro · 203-205' },
  { id: 'sched_3', day: 'TUE', subject: '104: Torts and Damages', time: '8:00 - 9:30 AM', prof: 'Atty. Ramon Quintin Allado · 321' },
  { id: 'sched_4', day: 'TUE', subject: '139: Insurance', time: '10:00 - 12:00 PM', prof: 'Atty. Jose Martin Loon · 127' },
  { id: 'sched_6', day: 'WED', subject: '102: Property', time: '3:00 - 5:00 PM', prof: 'Atty. John Noah Red · Online' },
  { id: 'sched_7', day: 'THU', subject: '104: Torts and Damages', time: '8:00 - 9:30 AM', prof: 'Atty. Ramon Quintin Allado · 321' },
  { id: 'sched_9', day: 'FRI', subject: '124: CrimPro', time: '1:00 - 2:30 PM', prof: 'Atty. Noel Lazaro · 203-205' },
  { id: 'sched_10', day: 'FRI', subject: '102: Property', time: '5:00 - 7:00 PM', prof: 'Atty. John Noah Red · 303-305' },
];

const DEFAULT_GCAL_PREFS = {
  collegeOnly: true,
  extraIgnore: '',
  icalUrl: '',
  oauthConnected: false,
  lastSyncedAt: null,
  lastSource: null,
  lastSyncRange: null,
  lastStats: null,
};

let _scheduleData = null;
let _syllabusMap = {};
let _gcalPrefs = null;
let _syncedEvents = null;
let _lastContextPdf = null;
let _observerActive = false;
let _modalsWired = false;
let _gridAnchorDate = new Date();
let _gcalAccessToken = null;
let _gcalTokenExpiry = 0;
let _lastRawCalendarEvents = null;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── 1. Data Hydration, Legacy Migration & Cloud Sync ────────────────────────

function isLegacyLaborEntry(item) {
  if (!item || (item.id !== 'sched_5' && item.id !== 'sched_8')) return false;
  return /113:\s*labor\s*1/i.test(item.subject || '') || /^labor\s*1$/i.test((item.subject || '').trim());
}

function applyLegacyLaborMigration(list, { forceCheck = false } = {}) {
  if (!Array.isArray(list)) return { list, migrated: false };
  const alreadyMigrated = safeStorageGet(SCHEDULE_MIGRATED_V2_KEY) === '1';
  if (alreadyMigrated && !forceCheck) {
    return { list, migrated: false };
  }
  const hasLegacy = list.some(isLegacyLaborEntry);
  if (!hasLegacy) {
    if (!alreadyMigrated) {
      safeStorageSet(SCHEDULE_MIGRATED_V2_KEY, '1');
    }
    return { list, migrated: false };
  }
  const filtered = list.filter(item => !isLegacyLaborEntry(item));
  safeStorageSet(SCHEDULE_MIGRATED_V2_KEY, '1');
  const json = JSON.stringify(filtered);
  safeStorageSet(SCHEDULE_STORAGE_KEY, json);
  dbSetSetting(SCHEDULE_STORAGE_KEY, json).catch(() => {});
  dbSetSetting(SCHEDULE_MIGRATED_V2_KEY, '1').catch(() => {});
  return { list: filtered, migrated: true };
}

export function loadScheduleData() {
  if (Array.isArray(_scheduleData) && _scheduleData.length > 0) {
    return _scheduleData;
  }
  const raw = safeStorageGet(SCHEDULE_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const { list } = applyLegacyLaborMigration(parsed);
        _scheduleData = list;
        return _scheduleData;
      }
    } catch {}
  }
  _scheduleData = JSON.parse(JSON.stringify(DEFAULT_SCHEDULE));
  if (safeStorageGet(SCHEDULE_MIGRATED_V2_KEY) !== '1') {
    safeStorageSet(SCHEDULE_MIGRATED_V2_KEY, '1');
  }
  return _scheduleData;
}

export function saveScheduleData(data) {
  _scheduleData = Array.isArray(data) ? data : [];
  const json = JSON.stringify(_scheduleData);
  safeStorageSet(SCHEDULE_STORAGE_KEY, json);
  dbSetSetting(SCHEDULE_STORAGE_KEY, json).catch(err => {
    console.warn('[Schedule] Cloud sync save failed:', err);
  });
  renderEditableSchedule();
}

export function loadSyllabusMap() {
  const raw = safeStorageGet(SYLLABUS_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        _syllabusMap = parsed;
        return _syllabusMap;
      }
    } catch {}
  }
  _syllabusMap = {};
  return _syllabusMap;
}

export function saveSyllabusMap() {
  const json = JSON.stringify(_syllabusMap);
  safeStorageSet(SYLLABUS_STORAGE_KEY, json);
  dbSetSetting(SYLLABUS_STORAGE_KEY, json).catch(err => {
    console.warn('[Schedule] Syllabus map cloud sync failed:', err);
  });
}

function loadGcalPrefs() {
  if (_gcalPrefs && typeof _gcalPrefs === 'object') return _gcalPrefs;
  const raw = safeStorageGet(GCAL_PREFS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        _gcalPrefs = { ...DEFAULT_GCAL_PREFS, ...parsed };
        return _gcalPrefs;
      }
    } catch {}
  }
  _gcalPrefs = { ...DEFAULT_GCAL_PREFS };
  return _gcalPrefs;
}

function saveGcalPrefs(patch = {}) {
  const cur = loadGcalPrefs();
  _gcalPrefs = { ...cur, ...patch };
  const json = JSON.stringify(_gcalPrefs);
  safeStorageSet(GCAL_PREFS_KEY, json);
  dbSetSetting(GCAL_PREFS_KEY, json).catch(err => {
    console.warn('[Schedule] GCal prefs cloud sync failed:', err);
  });
  return _gcalPrefs;
}

function loadSyncedEvents() {
  if (Array.isArray(_syncedEvents)) return _syncedEvents;
  const raw = safeStorageGet(GCAL_EVENTS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        _syncedEvents = parsed;
        return _syncedEvents;
      }
    } catch {}
  }
  _syncedEvents = [];
  return _syncedEvents;
}

function saveSyncedEvents(events) {
  _syncedEvents = Array.isArray(events) ? events : [];
  const json = JSON.stringify(_syncedEvents);
  safeStorageSet(GCAL_EVENTS_KEY, json);
  dbSetSetting(GCAL_EVENTS_KEY, json).catch(err => {
    console.warn('[Schedule] Synced events cloud sync failed:', err);
  });
  return _syncedEvents;
}

function getScheduleViewMode() {
  const v = safeStorageGet(VIEW_MODE_KEY, 'docket');
  return v === 'grid' ? 'grid' : 'docket';
}

function setScheduleViewMode(mode) {
  const next = mode === 'grid' ? 'grid' : 'docket';
  safeStorageSet(VIEW_MODE_KEY, next);
  renderEditableSchedule();
}

function getGridSpan() {
  const v = safeStorageGet(GRID_SPAN_KEY, '2week');
  return v === 'month' ? 'month' : '2week';
}

function setGridSpan(span) {
  const next = span === 'month' ? 'month' : '2week';
  safeStorageSet(GRID_SPAN_KEY, next);
  renderEditableSchedule();
}

// ── 2. Subject & Syllabus Resolution ────────────────────────────────────────

export function getPdfsForSubject(subj) {
  if (!subj || !S.folders) return [];
  const subjFolderIds = new Set(
    S.folders.filter(f => f.subject_id === subj.id).map(f => f.id)
  );
  let changed = true;
  let guard = 0;
  while (changed && guard < 10) {
    changed = false;
    guard++;
    for (const f of S.folders) {
      if (f.parent_folder_id && subjFolderIds.has(f.parent_folder_id) && !subjFolderIds.has(f.id)) {
        subjFolderIds.add(f.id);
        changed = true;
      }
    }
  }
  return S.pdfs.filter(p => subjFolderIds.has(p.folder_id));
}

export function findSubjectByNameOrId(query) {
  if (!query || !S.subjects || !S.subjects.length) return null;
  if (typeof query === 'object' && query.id) return query;
  const q = String(query).trim().toLowerCase();

  // 1. Direct ID match
  let found = S.subjects.find(s => String(s.id).toLowerCase() === q);
  if (found) return found;

  // 2. Exact name match
  found = S.subjects.find(s => s.name.trim().toLowerCase() === q);
  if (found) return found;

  // 3. Match numeric course code (e.g. "103" in "103: Sales" or "Sales (103)")
  const numMatch = q.match(/\b\d{3}\b/);
  if (numMatch) {
    const code = numMatch[0];
    found = S.subjects.find(s => s.name.toLowerCase().includes(code));
    if (found) return found;
  }

  // 4. Case-insensitive keyword match (filter small stopwords)
  const words = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && w !== 'class');
  if (words.length > 0) {
    found = S.subjects.find(s => {
      const sn = s.name.toLowerCase();
      return words.some(w => sn.includes(w));
    });
    if (found) return found;
  }

  // 5. Broad substring match
  found = S.subjects.find(s => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase()));
  return found || null;
}

export function getSyllabusPdfForSubject(subjectNameOrId) {
  const subj = findSubjectByNameOrId(subjectNameOrId);
  const rawKey = typeof subjectNameOrId === 'string' ? subjectNameOrId.trim().toLowerCase() : '';

  let mappedVal = null;
  if (subj) {
    mappedVal = _syllabusMap[subj.id] ||
                _syllabusMap[subj.name.trim().toLowerCase()] ||
                safeStorageGet('subj_syllabus_' + subj.id);
  }
  if (!mappedVal && rawKey) {
    mappedVal = _syllabusMap[rawKey];
  }

  let pdfId = null;
  if (mappedVal) {
    pdfId = typeof mappedVal === 'object' && mappedVal.pdfId ? mappedVal.pdfId : mappedVal;
  }

  if (pdfId) {
    const foundPdf = S.pdfs.find(p => p.id === pdfId || p.linked_pdf_id === pdfId || String(p.id) === String(pdfId));
    if (foundPdf) return foundPdf;
  }

  // Smart Auto-Fallback: If no explicit syllabus mapping exists yet,
  // find if any PDF inside this subject folder has "syllabus" in its name!
  if (subj) {
    const subjectPdfs = getPdfsForSubject(subj);
    const autoPdf = subjectPdfs.find(p => p.name.toLowerCase().includes('syllabus'));
    if (autoPdf) {
      _syllabusMap[subj.id] = { pdfId: autoPdf.id, pdfName: autoPdf.name, updatedAt: Date.now() };
      _syllabusMap[subj.name.trim().toLowerCase()] = { pdfId: autoPdf.id, pdfName: autoPdf.name, updatedAt: Date.now() };
      saveSyllabusMap();
      return autoPdf;
    }
  }

  return null;
}

// ── 3. Set as Subject Syllabus & Open Syllabus ──────────────────────────────

export function setSubjectSyllabusPdf(pdf, subjOverride = null, showFeedback = true) {
  if (!pdf) return;
  let subj = subjOverride || getSubjectForPdf(pdf);
  if (!subj && S.subjects.length === 1) {
    subj = S.subjects[0];
  }

  if (!subj) {
    openAssignSubjectModal(pdf);
    return;
  }

  const payload = {
    pdfId: pdf.id,
    pdfName: pdf.name,
    updatedAt: Date.now()
  };

  _syllabusMap[subj.id] = payload;
  _syllabusMap[subj.name.trim().toLowerCase()] = payload;
  safeStorageSet('subj_syllabus_' + subj.id, pdf.id);
  saveSyllabusMap();

  if (showFeedback) {
    toast(`📌 Set "${pdf.name}" as Syllabus for ${subj.name}`);
  }

  renderEditableSchedule();
}

export async function openSubjectSyllabus(subjectNameOrId) {
  const subj = findSubjectByNameOrId(subjectNameOrId);
  const pdf = getSyllabusPdfForSubject(subj || subjectNameOrId);

  if (pdf) {
    toast(`Opening Syllabus: ${pdf.name}`);
    await openPDFFromLibrary(pdf);
    return;
  }

  // If no syllabus PDF has been chosen yet, open modal to let user choose one
  openChooseSyllabusModal(subj, subjectNameOrId);
}

// ── 4. Choose Syllabus Modal (#mo-choose-syllabus) ──────────────────────────

export function openChooseSyllabusModal(subj, subjectNameOrId) {
  const titleEl = document.getElementById('mo-choose-syl-title');
  const subEl = document.getElementById('mo-choose-syl-sub');
  const listEl = document.getElementById('choose-syl-list');
  const searchInp = document.getElementById('choose-syl-search');
  if (!listEl) return;

  const subjName = subj ? subj.name : (subjectNameOrId || 'Subject');
  if (titleEl) titleEl.textContent = `📌 Choose Syllabus for ${subjName}`;
  if (subEl) {
    subEl.textContent = `Select a PDF from your library to set as the Syllabus for "${subjName}". It will automatically open from your schedule where you last left off.`;
  }
  if (searchInp) searchInp.value = '';

  const subjPdfs = subj ? getPdfsForSubject(subj) : [];
  const otherPdfs = S.pdfs.filter(p => !subjPdfs.some(sp => sp.id === p.id));

  const renderList = (filter = '') => {
    listEl.innerHTML = '';
    const q = filter.trim().toLowerCase();

    const matchesFilter = (p) => {
      if (!q) return true;
      return p.name.toLowerCase().includes(q);
    };

    const filteredSubj = subjPdfs.filter(matchesFilter);
    const filteredOther = otherPdfs.filter(matchesFilter);

    if (filteredSubj.length === 0 && filteredOther.length === 0) {
      listEl.innerHTML = `<div style="text-align:center; padding:24px 12px; color:var(--muted); font-size:12px;">No matching PDFs found in your library.</div>`;
      return;
    }

    if (filteredSubj.length > 0) {
      const header = document.createElement('div');
      header.style.cssText = 'font-size:11px; font-weight:700; color:var(--gold); text-transform:uppercase; letter-spacing:0.5px; padding:4px 6px;';
      header.textContent = `📁 ${subjName} PDFs (${filteredSubj.length})`;
      listEl.appendChild(header);

      filteredSubj.forEach(pdf => {
        listEl.appendChild(buildSyllabusPickItem(pdf, subj));
      });
    }

    if (filteredOther.length > 0) {
      const header = document.createElement('div');
      header.style.cssText = 'font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; padding:6px 6px 4px; margin-top:6px; border-top:1px solid var(--navy-b);';
      header.textContent = `📚 Other Library PDFs (${filteredOther.length})`;
      listEl.appendChild(header);

      filteredOther.forEach(pdf => {
        listEl.appendChild(buildSyllabusPickItem(pdf, subj));
      });
    }
  };

  if (searchInp) {
    searchInp.oninput = () => renderList(searchInp.value);
  }

  renderList();
  openModal('mo-choose-syllabus');
}

function buildSyllabusPickItem(pdf, subj) {
  const item = document.createElement('div');
  item.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:8px 10px; background:var(--navy); border:1px solid var(--navy-b); border-radius:6px; cursor:pointer; transition:background .15s, border-color .15s;';
  item.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px; overflow:hidden; flex:1; min-width:0;">
      <span style="font-size:16px;">📄</span>
      <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; font-weight:500; color:#e8e4db;">
        ${escapeHtml(pdf.name)}
      </div>
    </div>
    <button type="button" class="btn-gold" style="font-size:11px; padding:4px 9px; flex-shrink:0;">Set &amp; Open</button>
  `;
  item.addEventListener('mouseenter', () => {
    item.style.borderColor = 'var(--gold)';
    item.style.background = 'rgba(201,168,76,0.12)';
  });
  item.addEventListener('mouseleave', () => {
    item.style.borderColor = 'var(--navy-b)';
    item.style.background = 'var(--navy)';
  });
  item.addEventListener('click', async () => {
    closeModal('mo-choose-syllabus');
    setSubjectSyllabusPdf(pdf, subj, true);
    await openPDFFromLibrary(pdf);
  });
  return item;
}

function openAssignSubjectModal(pdf) {
  if (!S.subjects || S.subjects.length === 0) {
    toast(`Please create a Subject in the Library before assigning a Syllabus.`);
    return;
  }
  const titleEl = document.getElementById('mo-choose-syl-title');
  const subEl = document.getElementById('mo-choose-syl-sub');
  const listEl = document.getElementById('choose-syl-list');
  if (!listEl) return;

  if (titleEl) titleEl.textContent = `📌 Set "${pdf.name}" as Syllabus for:`;
  if (subEl) subEl.textContent = `Click the subject that this syllabus document belongs to:`;
  listEl.innerHTML = '';

  S.subjects.forEach(subj => {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:10px 12px; background:var(--navy); border:1px solid var(--navy-b); border-radius:6px; cursor:pointer; margin-bottom:4px;';
    item.innerHTML = `
      <span style="font-weight:600; font-size:13px; color:#e8e4db;">📚 ${escapeHtml(subj.name)}</span>
      <span class="btn-gold" style="font-size:11px; padding:3px 9px;">Select</span>
    `;
    item.addEventListener('click', () => {
      closeModal('mo-choose-syllabus');
      setSubjectSyllabusPdf(pdf, subj, true);
    });
    listEl.appendChild(item);
  });

  openModal('mo-choose-syllabus');
}

// ── 5. Edit Class Schedule Modal (#mo-edit-schedule) ────────────────────────

export function openEditScheduleModal(targetEntryId = null, isNew = false) {
  const schedule = loadScheduleData();
  const formEntryId = document.getElementById('sched-entry-id');
  const daySelect = document.getElementById('sched-input-day');
  const timeInput = document.getElementById('sched-input-time');
  const subjectInput = document.getElementById('sched-input-subject');
  const profInput = document.getElementById('sched-input-prof');
  const quickSubjSelect = document.getElementById('sched-select-subject-quick');
  const syllabusSelect = document.getElementById('sched-select-syllabus');
  const delBtn = document.getElementById('sched-btn-delete');
  const listContainer = document.getElementById('sched-list-container');
  const countEl = document.getElementById('sched-count');

  if (!formEntryId || !subjectInput) return;

  // 1. Populate Subject Quick-Pick dropdown
  if (quickSubjSelect) {
    quickSubjSelect.innerHTML = '<option value="">Pick Subject…</option>';
    S.subjects.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.name;
      quickSubjSelect.appendChild(opt);
    });
    quickSubjSelect.onchange = () => {
      if (quickSubjSelect.value) {
        subjectInput.value = quickSubjSelect.value;
        refreshSyllabusOptions(quickSubjSelect.value);
      }
    };
  }

  // 2. Helper to populate Syllabus PDF dropdown
  function refreshSyllabusOptions(subjectName, preselectedPdfId = null) {
    if (!syllabusSelect) return;
    syllabusSelect.innerHTML = '<option value="">(No Syllabus Linked)</option>';
    const subj = findSubjectByNameOrId(subjectName);
    const currentSylPdf = getSyllabusPdfForSubject(subj || subjectName);
    const activeSylId = preselectedPdfId || (currentSylPdf ? currentSylPdf.id : '');

    const subjPdfs = subj ? getPdfsForSubject(subj) : [];
    const otherPdfs = S.pdfs.filter(p => !subjPdfs.some(sp => sp.id === p.id));

    if (subjPdfs.length > 0) {
      const optGroup = document.createElement('optgroup');
      optGroup.label = `${subj.name} PDFs`;
      subjPdfs.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === activeSylId) opt.selected = true;
        optGroup.appendChild(opt);
      });
      syllabusSelect.appendChild(optGroup);
    }

    if (otherPdfs.length > 0) {
      const optGroup = document.createElement('optgroup');
      optGroup.label = 'Other Library PDFs';
      otherPdfs.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === activeSylId) opt.selected = true;
        optGroup.appendChild(opt);
      });
      syllabusSelect.appendChild(optGroup);
    }
  }

  subjectInput.oninput = () => {
    refreshSyllabusOptions(subjectInput.value);
  };

  // 3. Load entry into form
  function loadFormEntry(entry) {
    if (entry) {
      formEntryId.value = entry.id;
      if (daySelect) daySelect.value = entry.day || 'MON';
      if (timeInput) timeInput.value = entry.time || '';
      subjectInput.value = entry.subject || '';
      if (profInput) profInput.value = entry.prof || '';
      refreshSyllabusOptions(entry.subject);
      if (delBtn) delBtn.style.display = 'block';
    } else {
      formEntryId.value = '';
      if (daySelect) daySelect.value = 'MON';
      if (timeInput) timeInput.value = '';
      subjectInput.value = '';
      if (profInput) profInput.value = '';
      refreshSyllabusOptions('');
      if (delBtn) delBtn.style.display = 'none';
    }
  }

  // 4. Render schedule items in modal
  function renderModalList() {
    if (!listContainer) return;
    listContainer.innerHTML = '';
    const items = loadScheduleData();
    if (countEl) countEl.textContent = items.length;

    if (items.length === 0) {
      listContainer.innerHTML = '<div style="text-align:center; padding:16px; color:var(--muted); font-size:12px;">No classes scheduled yet. Add your first class above!</div>';
      return;
    }

    items.forEach(item => {
      const row = document.createElement('div');
      const isSelected = formEntryId.value === item.id;
      const color = getSubjectBinderColor({ name: item.subject });
      const sylPdf = getSyllabusPdfForSubject(item.subject);

      row.style.cssText = `
        display:flex; align-items:center; justify-content:space-between;
        padding:7px 10px; background:${isSelected ? 'rgba(201,168,76,0.15)' : 'var(--navy)'};
        border:1px solid ${isSelected ? 'var(--gold)' : 'var(--navy-b)'};
        border-left:4px solid ${color};
        border-radius:6px; cursor:pointer; transition:background .15s;
      `;
      row.innerHTML = `
        <div style="flex:1; min-width:0; overflow:hidden;">
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="font-size:11px; font-weight:700; color:var(--gold);">${escapeHtml(item.day)}</span>
            <span style="font-size:12px; font-weight:600; color:#e8e4db;">${escapeHtml(item.subject)}</span>
            ${sylPdf ? '<span title="Syllabus Linked" style="display:inline-flex;align-items:center;color:var(--gold);"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-book"/></svg></span>' : ''}
          </div>
          <div style="font-size:11px; color:var(--muted); margin-top:2px;">
            ${escapeHtml(item.time || '')}${item.prof ? ' · ' + escapeHtml(item.prof) : ''}
          </div>
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          <button type="button" class="btn-sec sched-row-edit" style="font-size:11px; padding:3px 7px;">Edit</button>
          <button type="button" class="btn-sec sched-row-del" style="font-size:11px; padding:3px 7px; color:var(--red); display:inline-flex; align-items:center;" title="Delete class" aria-label="Delete class"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-close"/></svg></button>
        </div>
      `;

      row.querySelector('.sched-row-edit')?.addEventListener('click', (e) => {
        e.stopPropagation();
        loadFormEntry(item);
        renderModalList();
      });

      row.querySelector('.sched-row-del')?.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteClassEntry(item.id);
      });

      row.addEventListener('click', () => {
        loadFormEntry(item);
        renderModalList();
      });

      listContainer.appendChild(row);
    });
  }

  function deleteClassEntry(id) {
    if (!id) return;
    const cur = loadScheduleData();
    const next = cur.filter(x => x.id !== id);
    saveScheduleData(next);
    if (formEntryId.value === id) {
      loadFormEntry(null);
    }
    renderModalList();
    toast('Class removed from schedule');
  }

  // Pre-load target entry or first entry or empty
  if (isNew) {
    loadFormEntry(null);
  } else if (targetEntryId) {
    const match = schedule.find(x => x.id === targetEntryId);
    loadFormEntry(match || null);
  } else if (schedule.length > 0) {
    loadFormEntry(schedule[0]);
  } else {
    loadFormEntry(null);
  }

  renderModalList();
  openModal('mo-edit-schedule');
}

// ── 6. Smart College-Only Filter & Google Calendar Sync Engine ──────────────

function toLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseLocalYmd(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

function formatShortTime(d) {
  if (!d || isNaN(d.getTime())) return '';
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

function formatShortTimeFromStr(timeStr) {
  const s = String(timeStr || '').trim();
  if (!s) return '';
  if (/all\s*day/i.test(s)) return 'All day';
  const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return s;
  const h = Number(m[1]);
  const mins = Number(m[2] || 0);
  let ampm = (m[3] || '').toLowerCase();
  if (!ampm) {
    const tail = s.match(/\b(AM|PM)\b/i);
    ampm = tail ? tail[1].toLowerCase() : '';
  }
  return mins === 0 ? `${h}${ampm}` : `${h}:${String(mins).padStart(2, '0')}${ampm}`;
}

function parseStartMinutesFromStr(timeStr) {
  const s = String(timeStr || '').trim();
  if (!s || /all\s*day/i.test(s)) return 0;
  const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return 9999;
  let h = Number(m[1]);
  const mins = Number(m[2] || 0);
  let ampm = (m[3] || '').toUpperCase();
  if (!ampm) {
    const tail = s.match(/\b(AM|PM)\b/i);
    if (tail) ampm = tail[1].toUpperCase();
  }
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + mins;
}

function formatTimeRange(startDate, endDate) {
  if (!startDate || isNaN(startDate.getTime())) return '';
  const fmt = (d, includeAmPm) => {
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return includeAmPm ? `${h}:${m} ${ampm}` : `${h}:${m}`;
  };
  if (!endDate || isNaN(endDate.getTime()) || endDate.getTime() <= startDate.getTime()) {
    return fmt(startDate, true);
  }
  const startAmPm = startDate.getHours() >= 12 ? 'PM' : 'AM';
  const endAmPm = endDate.getHours() >= 12 ? 'PM' : 'AM';
  if (startAmPm === endAmPm) {
    return `${fmt(startDate, false)} - ${fmt(endDate, true)}`;
  }
  return `${fmt(startDate, true)} - ${fmt(endDate, true)}`;
}

function subjectTokensMatch(a, b) {
  const sa = String(a || '').trim().toLowerCase();
  const sb = String(b || '').trim().toLowerCase();
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  const codeA = sa.match(/\b(\d{3})\b/)?.[1];
  const codeB = sb.match(/\b(\d{3})\b/)?.[1];
  if (codeA && codeB && codeA === codeB) return true;
  if (sa.length >= 4 && sb.includes(sa)) return true;
  if (sb.length >= 4 && sa.includes(sb)) return true;
  return false;
}

function enrichCourseMetadata(day, subject, rawLocation = '', rawDescription = '') {
  const loc = String(rawLocation || '').trim();
  if (loc) return loc;

  const desc = String(rawDescription || '').trim();
  if (desc && !/^-::~:~|meet\.google\.com|zoom\.us\/j\//i.test(desc)) {
    const firstLine = desc.split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
    if (firstLine && firstLine.length <= 80 && !/^https?:\/\//i.test(firstLine)) {
      return firstLine;
    }
  }

  // Fallback to known prof/room metadata from DEFAULT_SCHEDULE (day+subject first, then subject/code)
  const dayCode = String(day || '').toUpperCase();
  const exactDayMatch = DEFAULT_SCHEDULE.find(
    ds => ds.day === dayCode && subjectTokensMatch(ds.subject, subject)
  );
  if (exactDayMatch?.prof) return exactDayMatch.prof;

  const subjMatch = DEFAULT_SCHEDULE.find(ds => subjectTokensMatch(ds.subject, subject));
  if (subjMatch?.prof) return subjMatch.prof;

  return '';
}

export function isCollegeClassEvent(ev, prefsOverride = null) {
  if (!ev) return false;
  if (String(ev.status || '').toUpperCase() === 'CANCELLED') return false;

  const prefs = prefsOverride || loadGcalPrefs();
  const collegeOnly = prefs.collegeOnly !== false;
  const isAllDay = Boolean(ev.isAllDay || (ev.start && ev.start.date && !ev.start.dateTime));

  if (!collegeOnly) {
    return true;
  }

  // 1. Ignore all-day events (e.g. Bonifacio Day, Mom bday)
  if (isAllDay) return false;

  const summary = String(ev.summary || ev.title || ev.subject || '').trim();
  if (!summary) return false;
  const summaryLower = summary.toLowerCase();
  const locationLower = String(ev.location || '').trim().toLowerCase();
  const combinedForIgnore = `${summaryLower} ${locationLower}`.trim();

  // 2. Ignore non-college keywords & user's comma-separated extraIgnore terms
  if (NON_COLLEGE_KEYWORDS.some(kw => summaryLower.includes(kw))) {
    return false;
  }

  const extraTerms = String(prefs.extraIgnore || '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
  if (extraTerms.some(term => combinedForIgnore.includes(term))) {
    return false;
  }

  // 3. Keep events matching a 3-digit course code (e.g. 103, 124, 139)
  if (/\b\d{3}\b/.test(summary)) {
    return true;
  }

  // 4. Keep events matching any subject name in S.subjects
  if (Array.isArray(S.subjects)) {
    const matchedSubject = S.subjects.some(s => {
      const sn = String(s?.name || '').trim().toLowerCase();
      if (!sn) return false;
      if (summaryLower === sn || summaryLower.includes(sn) || (summaryLower.length >= 4 && sn.includes(summaryLower))) {
        return true;
      }
      const code = sn.match(/\b(\d{3})\b/)?.[1];
      if (code && summaryLower.includes(code)) return true;
      const words = sn.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && w !== 'class');
      return words.some(w => summaryLower.includes(w));
    });
    if (matchedSubject) return true;
  }

  // 5. Keep events matching college/law keywords
  if (COLLEGE_LAW_KEYWORDS.some(kw => summaryLower.includes(kw))) {
    return true;
  }

  return false;
}

function getSyncDateWindow() {
  const now = new Date();
  const minDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30, 0, 0, 0, 0);
  const maxDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 60, 23, 59, 59, 999);
  return {
    minDate,
    maxDate,
    minDateStr: toLocalDateStr(minDate),
    maxDateStr: toLocalDateStr(maxDate),
  };
}

function buildScheduleFromRawEvents(rawEvents, { source, icalUrl } = {}) {
  const prefs = loadGcalPrefs();
  const windowRange = getSyncDateWindow();
  const existingSchedule = loadScheduleData();

  const instances = [];
  const keptMap = new Map();
  const ignoredMap = new Map();
  let totalFetched = 0;

  rawEvents.forEach((rawEv, idx) => {
    if (!rawEv || String(rawEv.status || '').toUpperCase() === 'CANCELLED') return;
    totalFetched++;

    const summary = String(rawEv.summary || rawEv.title || 'Untitled Event').trim();
    const isAllDay = Boolean(rawEv.isAllDay || (rawEv.start && rawEv.start.date && !rawEv.start.dateTime));
    const startDt = rawEv.startDt instanceof Date
      ? rawEv.startDt
      : (rawEv.start?.dateTime ? new Date(rawEv.start.dateTime) : (rawEv.start?.date ? parseLocalYmd(rawEv.start.date) : null));
    const endDt = rawEv.endDt instanceof Date
      ? rawEv.endDt
      : (rawEv.end?.dateTime ? new Date(rawEv.end.dateTime) : (rawEv.end?.date ? parseLocalYmd(rawEv.end.date) : null));

    if (!startDt || isNaN(startDt.getTime())) return;

    if (!isCollegeClassEvent({ ...rawEv, summary, isAllDay }, prefs)) {
      const reason = isAllDay ? 'All-day event' : 'Non-college filter';
      if (!ignoredMap.has(summary)) {
        ignoredMap.set(summary, `${summary} (${reason})`);
      }
      return;
    }

    const dateStr = toLocalDateStr(startDt);
    const day = JS_DAY_TO_CODE[startDt.getDay()];
    const shortTime = isAllDay ? 'All day' : formatShortTime(startDt);
    const time = isAllDay ? 'All day' : formatTimeRange(startDt, endDt);
    const prof = enrichCourseMetadata(day, summary, rawEv.location, rawEv.description);
    const startMinutes = isAllDay ? 0 : (startDt.getHours() * 60 + startDt.getMinutes());

    instances.push({
      id: rawEv.id || `gcal_${dateStr}_${idx}`,
      dateStr,
      day,
      subject: summary,
      shortTime,
      time,
      prof,
      isAllDay,
      startMinutes,
      source: source || 'gcal',
    });

    const keptKey = `${day}|${summary.toLowerCase()}|${time.toLowerCase()}`;
    if (!keptMap.has(keptKey)) {
      keptMap.set(keptKey, { day, subject: summary, time, prof, startMinutes });
    }
  });

  instances.sort((a, b) => a.dateStr.localeCompare(b.dateStr) || (a.startMinutes - b.startMinutes));

  // Derive recurring weekly schedule (deduplicated by day + subject + time)
  const weeklySchedule = Array.from(keptMap.values())
    .sort((a, b) => {
      const da = DAY_ORDER.indexOf(a.day);
      const db = DAY_ORDER.indexOf(b.day);
      if (da !== db) return da - db;
      return a.startMinutes - b.startMinutes;
    })
    .map((entry, idx) => {
      const matchedExisting = existingSchedule.find(
        ex => ex.day === entry.day && subjectTokensMatch(ex.subject, entry.subject) && (ex.time || '').toLowerCase() === entry.time.toLowerCase()
      ) || DEFAULT_SCHEDULE.find(
        ds => ds.day === entry.day && subjectTokensMatch(ds.subject, entry.subject)
      );
      const id = matchedExisting?.id || `gcal_${entry.day.toLowerCase()}_${idx}_${entry.subject.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20)}`;
      return {
        id,
        day: entry.day,
        subject: entry.subject,
        time: entry.time,
        prof: entry.prof,
      };
    });

  saveSyncedEvents(instances);

  const stats = {
    totalFetched,
    collegeCount: instances.length,
    ignoredCount: Math.max(0, totalFetched - instances.length),
    weeklyClasses: weeklySchedule.length,
    keptSamples: Array.from(keptMap.values()).map(k => `${k.day} · ${k.subject} (${k.time})`).slice(0, 24),
    ignoredSamples: Array.from(ignoredMap.values()).slice(0, 24),
  };

  const prefsPatch = {
    lastSyncedAt: Date.now(),
    lastSource: source || prefs.lastSource || 'gcal',
    lastSyncRange: { minDateStr: windowRange.minDateStr, maxDateStr: windowRange.maxDateStr },
    lastStats: stats,
  };
  if (source === 'oauth') prefsPatch.oauthConnected = true;
  if (typeof icalUrl === 'string' && icalUrl) prefsPatch.icalUrl = icalUrl;

  saveGcalPrefs(prefsPatch);

  if (weeklySchedule.length > 0) {
    saveScheduleData(weeklySchedule);
  } else {
    renderEditableSchedule();
  }

  updateGcalModalUI();
  return { instances, weeklySchedule, stats };
}

async function ensureDesktopBridgeLoaded() {
  if (typeof window === 'undefined') return;
  if (typeof window.__DESKTOP_GOOGLE_CALENDAR_OAUTH__ !== 'function' && window.__TAURI_INTERNALS__?.invoke) {
    try {
      await import('./desktop-bridge.js');
    } catch {}
  }
}

async function requestGoogleCalendarAccessToken(silent = false) {
  if (_gcalAccessToken && Date.now() < _gcalTokenExpiry - 60_000) {
    return _gcalAccessToken;
  }

  await ensureDesktopBridgeLoaded();

  if (typeof window.__DESKTOP_GOOGLE_CALENDAR_OAUTH__ === 'function') {
    const resp = await window.__DESKTOP_GOOGLE_CALENDAR_OAUTH__(!!silent, GCAL_LOGIN_HINT, false);
    if (!resp || !resp.access_token) {
      throw new Error(resp?.error || 'Google Calendar sign-in cancelled');
    }
    _gcalAccessToken = resp.access_token;
    _gcalTokenExpiry = Date.now() + 3300_000;
    return _gcalAccessToken;
  }

  const clientId = window.APP_CONFIG?.GOOGLE_CLIENT_ID || '';
  if (!clientId) {
    throw new Error('Missing Google Client ID in APP_CONFIG');
  }
  if (typeof google === 'undefined' || !google.accounts?.oauth2?.initTokenClient) {
    throw new Error('Google OAuth client not ready');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = silent
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error('Silent Google Calendar token refresh timed out'));
          }
        }, 10000)
      : null;

    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GCAL_OAUTH_SCOPE,
      hint: GCAL_LOGIN_HINT,
      prompt: silent ? 'none' : 'select_account',
      callback: (resp) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (!resp || resp.error || !resp.access_token) {
          reject(new Error(resp?.error_description || resp?.error || 'Google Calendar OAuth failed'));
          return;
        }
        _gcalAccessToken = resp.access_token;
        _gcalTokenExpiry = Date.now() + ((Number(resp.expires_in) || 3500) * 1000);
        resolve(_gcalAccessToken);
      },
    });

    client.requestAccessToken({
      prompt: silent ? 'none' : 'select_account',
      hint: GCAL_LOGIN_HINT,
    });
  });
}

export async function syncFromGoogleCalendarOAuth({ silent = false } = {}) {
  let token = await requestGoogleCalendarAccessToken(silent);
  const { minDate, maxDate } = getSyncDateWindow();

  const fetchCalendarPage = async (accessToken, pageToken = '') => {
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      timeMin: minDate.toISOString(),
      timeMax: maxDate.toISOString(),
      maxResults: '250',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`;
    return fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  };

  let res = await fetchCalendarPage(token);
  if (res.status === 401) {
    _gcalAccessToken = null;
    _gcalTokenExpiry = 0;
    token = await requestGoogleCalendarAccessToken(silent);
    res = await fetchCalendarPage(token);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Google Calendar API error (${res.status})${errText ? ': ' + errText.slice(0, 140) : ''}`);
  }

  let data = await res.json();
  const allItems = Array.isArray(data.items) ? [...data.items] : [];
  let pageToken = data.nextPageToken || '';
  let pageGuard = 0;
  while (pageToken && pageGuard < 5) {
    pageGuard++;
    const nextRes = await fetchCalendarPage(token, pageToken);
    if (!nextRes.ok) break;
    const nextData = await nextRes.json();
    if (Array.isArray(nextData.items)) allItems.push(...nextData.items);
    pageToken = nextData.nextPageToken || '';
  }

  _lastRawCalendarEvents = allItems;
  const result = buildScheduleFromRawEvents(allItems, { source: 'oauth' });
  if (!silent) {
    toast(`✓ Synced ${result.stats.weeklyClasses} college classes (${result.stats.collegeCount} sessions) from Google Calendar`);
  }
  return result;
}

// ── iCal (.ics) RFC 5545 Parser & Sync ──────────────────────────────────────

function unescapeIcsText(val) {
  return String(val || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function parseIcsDateTime(rawVal, params = {}) {
  const val = String(rawVal || '').trim();
  if (!val) return null;

  const isDateOnly = String(params.VALUE || '').toUpperCase() === 'DATE' || /^\d{8}$/.test(val);
  const mDate = val.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (isDateOnly && mDate) {
    const y = Number(mDate[1]);
    const mo = Number(mDate[2]) - 1;
    const d = Number(mDate[3]);
    const dt = new Date(y, mo, d, 0, 0, 0, 0);
    return { isAllDay: true, date: dt, dateStr: toLocalDateStr(dt) };
  }

  const mDt = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i);
  if (!mDt) return null;
  const y = Number(mDt[1]);
  const mo = Number(mDt[2]) - 1;
  const d = Number(mDt[3]);
  const hh = Number(mDt[4]);
  const mm = Number(mDt[5]);
  const ss = Number(mDt[6]);
  const isUtc = Boolean(mDt[7]);

  const dt = isUtc
    ? new Date(Date.UTC(y, mo, d, hh, mm, ss, 0))
    : new Date(y, mo, d, hh, mm, ss, 0);

  return { isAllDay: false, date: dt, dateStr: toLocalDateStr(dt) };
}

function parseIcsRule(rruleStr) {
  const out = {};
  String(rruleStr || '')
    .split(';')
    .forEach(part => {
      const idx = part.indexOf('=');
      if (idx === -1) return;
      const k = part.slice(0, idx).trim().toUpperCase();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = v;
    });
  return out;
}

function expandRruleOccurrences(ev, windowStart, windowEnd, overriddenDates) {
  const rule = parseIcsRule(ev.rrule);
  const freq = String(rule.FREQ || '').toUpperCase();
  if (!freq) return [];

  const dtStart = ev.startDt;
  const durMs = (ev.endDt && ev.startDt) ? Math.max(0, ev.endDt.getTime() - ev.startDt.getTime()) : 0;
  const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10) || 1);
  const countLimit = rule.COUNT ? Math.max(1, parseInt(rule.COUNT, 10) || 0) : Infinity;

  let untilDate = null;
  if (rule.UNTIL) {
    const parsedUntil = parseIcsDateTime(rule.UNTIL, {});
    if (parsedUntil?.date) {
      untilDate = parsedUntil.isAllDay
        ? new Date(parsedUntil.date.getFullYear(), parsedUntil.date.getMonth(), parsedUntil.date.getDate(), 23, 59, 59, 999)
        : parsedUntil.date;
    }
  }

  const effectiveEnd = untilDate && untilDate < windowEnd ? untilDate : windowEnd;
  if (dtStart > effectiveEnd) return [];

  const results = [];
  let emittedCount = 0;

  if (freq === 'WEEKLY') {
    const rawByDays = rule.BYDAY
      ? rule.BYDAY.split(',').map(x => x.trim().toUpperCase().replace(/^[+-]?\d+/, '')).filter(x => x in ICS_BYDAY_TO_JS)
      : [];
    const targetDays = rawByDays.length > 0
      ? Array.from(new Set(rawByDays.map(d => ICS_BYDAY_TO_JS[d]))).sort((a, b) => a - b)
      : [dtStart.getDay()];

    // Start from Sunday of dtStart's week
    const weekCursor = new Date(
      dtStart.getFullYear(),
      dtStart.getMonth(),
      dtStart.getDate() - dtStart.getDay(),
      dtStart.getHours(),
      dtStart.getMinutes(),
      dtStart.getSeconds(),
      0
    );

    let weekGuard = 0;
    while (weekCursor <= effectiveEnd && weekGuard < 1000) {
      weekGuard++;
      for (const jsDay of targetDays) {
        const cand = new Date(
          weekCursor.getFullYear(),
          weekCursor.getMonth(),
          weekCursor.getDate() + jsDay,
          dtStart.getHours(),
          dtStart.getMinutes(),
          dtStart.getSeconds(),
          0
        );
        if (cand < dtStart) continue;
        if (cand > effectiveEnd) return results;
        emittedCount++;
        if (emittedCount > countLimit) return results;

        const candDateStr = toLocalDateStr(cand);
        if (ev.exdates.has(candDateStr) || overriddenDates?.has(candDateStr)) continue;

        if (cand >= windowStart && cand <= windowEnd) {
          results.push({
            ...ev,
            id: `${ev.id || 'ics'}_${candDateStr}`,
            startDt: cand,
            endDt: durMs ? new Date(cand.getTime() + durMs) : null,
          });
        }
      }
      weekCursor.setDate(weekCursor.getDate() + interval * 7);
    }
    return results;
  }

  if (freq === 'DAILY' || freq === 'MONTHLY' || freq === 'YEARLY') {
    let cursor = new Date(dtStart.getTime());
    let guard = 0;
    while (cursor <= effectiveEnd && guard < 2000) {
      guard++;
      emittedCount++;
      if (emittedCount > countLimit) break;

      const candDateStr = toLocalDateStr(cursor);
      if (!ev.exdates.has(candDateStr) && !overriddenDates?.has(candDateStr)) {
        if (cursor >= windowStart && cursor <= windowEnd) {
          results.push({
            ...ev,
            id: `${ev.id || 'ics'}_${candDateStr}`,
            startDt: new Date(cursor.getTime()),
            endDt: durMs ? new Date(cursor.getTime() + durMs) : null,
          });
        }
      }

      if (freq === 'DAILY') cursor.setDate(cursor.getDate() + interval);
      else if (freq === 'MONTHLY') cursor.setMonth(cursor.getMonth() + interval);
      else cursor.setFullYear(cursor.getFullYear() + interval);
    }
  }

  return results;
}

export function parseIcsCalendar(icsText, rangeOverride = null) {
  const normalized = String(icsText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const unfolded = normalized.replace(/\n[ \t]/g, '');
  const lines = unfolded.split('\n');

  const rawEvents = [];
  let cur = null;
  let inAlarm = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const upper = line.toUpperCase();

    if (upper === 'BEGIN:VEVENT') {
      cur = { exdates: new Set() };
      inAlarm = false;
      continue;
    }
    if (upper === 'END:VEVENT') {
      if (cur && cur.startDt) rawEvents.push(cur);
      cur = null;
      inAlarm = false;
      continue;
    }
    if (!cur) continue;

    if (upper === 'BEGIN:VALARM') {
      inAlarm = true;
      continue;
    }
    if (upper === 'END:VALARM') {
      inAlarm = false;
      continue;
    }
    if (inAlarm) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const propHead = line.slice(0, colonIdx);
    const propVal = line.slice(colonIdx + 1);

    const headParts = propHead.split(';');
    const propName = headParts[0].trim().toUpperCase();
    const params = {};
    for (let i = 1; i < headParts.length; i++) {
      const eq = headParts[i].indexOf('=');
      if (eq !== -1) {
        params[headParts[i].slice(0, eq).trim().toUpperCase()] = headParts[i].slice(eq + 1).trim();
      }
    }

    if (propName === 'SUMMARY') cur.summary = unescapeIcsText(propVal).trim();
    else if (propName === 'LOCATION') cur.location = unescapeIcsText(propVal).trim();
    else if (propName === 'DESCRIPTION') cur.description = unescapeIcsText(propVal).trim();
    else if (propName === 'STATUS') cur.status = propVal.trim().toUpperCase();
    else if (propName === 'UID') cur.uid = propVal.trim();
    else if (propName === 'RRULE') cur.rrule = propVal.trim();
    else if (propName === 'DTSTART') {
      const parsed = parseIcsDateTime(propVal, params);
      if (parsed) {
        cur.startDt = parsed.date;
        cur.isAllDay = parsed.isAllDay;
      }
    } else if (propName === 'DTEND') {
      const parsed = parseIcsDateTime(propVal, params);
      if (parsed) cur.endDt = parsed.date;
    } else if (propName === 'RECURRENCE-ID') {
      const parsed = parseIcsDateTime(propVal, params);
      if (parsed) cur.recurrenceIdDateStr = parsed.dateStr;
    } else if (propName === 'EXDATE') {
      propVal.split(',').forEach(part => {
        const parsed = parseIcsDateTime(part.trim(), params);
        if (parsed?.dateStr) cur.exdates.add(parsed.dateStr);
      });
    }
  }

  const { minDate, maxDate } = rangeOverride || getSyncDateWindow();
  const overridesByUid = new Map();
  for (const ev of rawEvents) {
    if (ev.uid && ev.recurrenceIdDateStr) {
      if (!overridesByUid.has(ev.uid)) overridesByUid.set(ev.uid, new Set());
      overridesByUid.get(ev.uid).add(ev.recurrenceIdDateStr);
    }
  }

  const expanded = [];
  rawEvents.forEach((ev, idx) => {
    if (String(ev.status || '').toUpperCase() === 'CANCELLED') return;
    const base = {
      id: ev.uid || `ics_${idx}`,
      summary: ev.summary || 'Untitled Event',
      location: ev.location || '',
      description: ev.description || '',
      status: ev.status || 'CONFIRMED',
      isAllDay: Boolean(ev.isAllDay),
      startDt: ev.startDt,
      endDt: ev.endDt || null,
      rrule: ev.rrule || '',
      exdates: ev.exdates,
    };

    if (base.rrule) {
      const overridden = ev.uid ? overridesByUid.get(ev.uid) : null;
      expanded.push(...expandRruleOccurrences(base, minDate, maxDate, overridden));
    } else {
      const dateStr = toLocalDateStr(base.startDt);
      if (!base.exdates.has(dateStr) && base.startDt >= minDate && base.startDt <= maxDate) {
        expanded.push(base);
      }
    }
  });

  return expanded;
}

export function syncFromIcalText(icsText, { source = 'ics-file', icalUrl = '', silent = false } = {}) {
  const expanded = parseIcsCalendar(icsText);
  _lastRawCalendarEvents = expanded;
  const result = buildScheduleFromRawEvents(expanded, { source, icalUrl });
  if (!silent) {
    toast(`✓ Imported ${result.stats.weeklyClasses} college classes (${result.stats.collegeCount} sessions) from iCal`);
  }
  return result;
}

export async function syncFromIcalUrl(rawUrl, { silent = false } = {}) {
  let url = String(rawUrl || '').trim();
  if (!url) throw new Error('Please enter an iCal (.ics) URL');
  if (url.startsWith('webcal://')) url = 'https://' + url.slice('webcal://'.length);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('iCal URL must start with https:// or http://');
  }

  await ensureDesktopBridgeLoaded();

  let icsText = '';
  if (typeof window.desktopFetchIcalUrl === 'function') {
    icsText = await window.desktopFetchIcalUrl(url);
  } else {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch iCal URL (${res.status})`);
    }
    icsText = await res.text();
  }

  if (!icsText || !icsText.includes('BEGIN:VCALENDAR')) {
    throw new Error('The URL did not return a valid iCal (.ics) calendar feed.');
  }

  return syncFromIcalText(icsText, { source: 'ical-url', icalUrl: url, silent });
}

// ── Sync Google Calendar Modal UI & Wiring ──────────────────────────────────

function updateGcalModalUI() {
  const prefs = loadGcalPrefs();
  const banner = document.getElementById('gcal-sync-status-banner');
  const preview = document.getElementById('gcal-sync-preview');
  const syncNowBtn = document.getElementById('gcal-btn-sync-now');
  const discBtn = document.getElementById('gcal-btn-disconnect');

  const isConnected = Boolean(prefs.oauthConnected || prefs.icalUrl || prefs.lastSyncedAt);

  if (banner) {
    if (prefs.lastSyncedAt) {
      const when = new Date(prefs.lastSyncedAt).toLocaleString();
      const srcLabel = prefs.lastSource === 'oauth'
        ? 'Google Calendar OAuth'
        : (prefs.lastSource === 'ical-url' ? 'Secret iCal (.ics) URL' : 'Imported .ics file');
      banner.innerHTML = `<strong style="color:var(--green, #4ade80);">● Connected</strong> via ${escapeHtml(srcLabel)} · Last synced ${escapeHtml(when)}`;
    } else if (prefs.oauthConnected) {
      banner.innerHTML = `<strong style="color:var(--green, #4ade80);">● Google Account Linked</strong> · Ready to sync`;
    } else if (prefs.icalUrl) {
      banner.innerHTML = `<strong style="color:var(--gold);">● iCal URL Saved</strong> · Ready to sync`;
    } else {
      banner.textContent = 'Not connected to Google Calendar yet. Sign in with Google or link a private iCal (.ics) feed below.';
    }
  }

  if (syncNowBtn) {
    syncNowBtn.disabled = !(prefs.oauthConnected || prefs.icalUrl);
  }
  if (discBtn) {
    discBtn.style.display = isConnected ? 'inline-flex' : 'none';
  }

  if (preview) {
    const stats = prefs.lastStats;
    if (!stats) {
      preview.innerHTML = '<div style="color:var(--ink-muted, var(--muted)); font-style:italic;">No sync run yet. Connect Google Calendar or import a .ics feed to preview matched college classes and filtered personal events.</div>';
    } else {
      const keptHtml = stats.keptSamples?.length
        ? stats.keptSamples.map(s => `<div style="color:var(--ink);">✓ ${escapeHtml(s)}</div>`).join('')
        : '<div style="color:var(--ink-muted, var(--muted));">None</div>';
      const ignHtml = stats.ignoredSamples?.length
        ? stats.ignoredSamples.map(s => `<div style="color:var(--ink-muted, var(--muted));">× ${escapeHtml(s)}</div>`).join('')
        : '<div style="color:var(--ink-muted, var(--muted));">None</div>';

      preview.innerHTML = `
        <div style="margin-bottom:6px; font-weight:600; color:var(--ink);">
          Fetched ${stats.totalFetched} events · Kept ${stats.collegeCount} college sessions (${stats.weeklyClasses} weekly classes) · Ignored ${stats.ignoredCount}
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
          <div>
            <div style="font-size:10px; font-weight:700; text-transform:uppercase; color:var(--green, #4ade80); margin-bottom:3px;">College Classes</div>
            ${keptHtml}
          </div>
          <div>
            <div style="font-size:10px; font-weight:700; text-transform:uppercase; color:var(--ink-muted, var(--muted)); margin-bottom:3px;">Filtered / Ignored</div>
            ${ignHtml}
          </div>
        </div>
      `;
    }
  }
}

export function openSyncGcalModal() {
  const prefs = loadGcalPrefs();
  const icalInput = document.getElementById('gcal-input-ical-url');
  const chkCollege = document.getElementById('gcal-chk-college-only');
  const extraInput = document.getElementById('gcal-input-extra-ignore');

  if (icalInput) icalInput.value = prefs.icalUrl || '';
  if (chkCollege) chkCollege.checked = prefs.collegeOnly !== false;
  if (extraInput) extraInput.value = prefs.extraIgnore || '';

  updateGcalModalUI();
  openModal('mo-sync-gcal');
}

function reapplyFilterFromCacheOrSync() {
  const prefs = loadGcalPrefs();
  if (Array.isArray(_lastRawCalendarEvents) && _lastRawCalendarEvents.length > 0) {
    buildScheduleFromRawEvents(_lastRawCalendarEvents, {
      source: prefs.lastSource || 'gcal',
      icalUrl: prefs.icalUrl || '',
    });
    return;
  }
  if (prefs.oauthConnected) {
    syncFromGoogleCalendarOAuth({ silent: true }).catch(() => {});
  } else if (prefs.icalUrl) {
    syncFromIcalUrl(prefs.icalUrl, { silent: true }).catch(() => {});
  } else {
    renderEditableSchedule();
  }
}

function wireScheduleModals() {
  if (_modalsWired) return;
  _modalsWired = true;

  const saveEntryBtn = document.getElementById('sched-btn-save-entry');
  const cancelFormBtn = document.getElementById('sched-btn-cancel-form');
  const delBtn = document.getElementById('sched-btn-delete');
  const newClassBtn = document.getElementById('sched-btn-new-class');
  const resetDefBtn = document.getElementById('sched-btn-reset-default');
  const clearSylBtn = document.getElementById('sched-btn-clear-syllabus');

  saveEntryBtn?.addEventListener('click', () => {
    const formEntryId = document.getElementById('sched-entry-id')?.value;
    const day = document.getElementById('sched-input-day')?.value || 'MON';
    const time = document.getElementById('sched-input-time')?.value.trim() || '';
    const subject = document.getElementById('sched-input-subject')?.value.trim() || '';
    const prof = document.getElementById('sched-input-prof')?.value.trim() || '';
    const syllabusPdfId = document.getElementById('sched-select-syllabus')?.value || '';

    if (!subject) {
      toast('Please enter a Subject Name');
      return;
    }

    const cur = loadScheduleData();
    let updated;
    if (formEntryId) {
      updated = cur.map(item => {
        if (item.id === formEntryId) {
          return { ...item, day, time, subject, prof };
        }
        return item;
      });
    } else {
      const newId = 'sched_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      updated = [...cur, { id: newId, day, time, subject, prof }];
    }

    // If a syllabus PDF was chosen in the dropdown, link it to this subject!
    if (syllabusPdfId) {
      const pdf = S.pdfs.find(p => p.id === syllabusPdfId);
      if (pdf) {
        const subj = findSubjectByNameOrId(subject);
        setSubjectSyllabusPdf(pdf, subj, false);
      }
    }

    saveScheduleData(updated);
    toast(formEntryId ? '✓ Class updated' : '✓ Class added to schedule');
    openEditScheduleModal(formEntryId || null);
  });

  cancelFormBtn?.addEventListener('click', () => {
    openEditScheduleModal(null, true);
  });

  newClassBtn?.addEventListener('click', () => {
    openEditScheduleModal(null, true);
  });

  delBtn?.addEventListener('click', () => {
    const formEntryId = document.getElementById('sched-entry-id')?.value;
    if (!formEntryId) return;
    const cur = loadScheduleData();
    const next = cur.filter(x => x.id !== formEntryId);
    saveScheduleData(next);
    openEditScheduleModal(null, true);
    toast('Class deleted');
  });

  resetDefBtn?.addEventListener('click', () => {
    if (confirm('Reset your class schedule back to the default 2nd Year, 1st Semester schedule?')) {
      const pristine = JSON.parse(JSON.stringify(DEFAULT_SCHEDULE));
      saveScheduleData(pristine);
      openEditScheduleModal(pristine[0]?.id || null);
      toast('✓ Class schedule reset to default');
    }
  });

  clearSylBtn?.addEventListener('click', () => {
    const sylSelect = document.getElementById('sched-select-syllabus');
    if (sylSelect) sylSelect.value = '';
    const subject = document.getElementById('sched-input-subject')?.value.trim();
    if (subject) {
      const subj = findSubjectByNameOrId(subject);
      if (subj) {
        delete _syllabusMap[subj.id];
        delete _syllabusMap[subj.name.trim().toLowerCase()];
      }
      delete _syllabusMap[subject.toLowerCase()];
      saveSyllabusMap();
      toast('Unlinked syllabus for ' + subject);
      renderEditableSchedule();
    }
  });

  // Wire #mo-sync-gcal controls
  const oauthBtn = document.getElementById('gcal-btn-oauth-sync');
  const syncNowBtn = document.getElementById('gcal-btn-sync-now');
  const discBtn = document.getElementById('gcal-btn-disconnect');
  const saveIcalBtn = document.getElementById('gcal-btn-save-ical');
  const importIcsBtn = document.getElementById('gcal-btn-import-ics');
  const icsFileInput = document.getElementById('gcal-input-ics-file');
  const chkCollege = document.getElementById('gcal-chk-college-only');
  const extraInput = document.getElementById('gcal-input-extra-ignore');

  oauthBtn?.addEventListener('click', async () => {
    const origHtml = oauthBtn.innerHTML;
    oauthBtn.disabled = true;
    oauthBtn.textContent = 'Syncing Google Calendar…';
    try {
      await syncFromGoogleCalendarOAuth({ silent: false });
    } catch (err) {
      toast('Google Calendar sync failed: ' + (err?.message || err));
    } finally {
      oauthBtn.disabled = false;
      oauthBtn.innerHTML = origHtml;
      updateGcalModalUI();
    }
  });

  syncNowBtn?.addEventListener('click', async () => {
    const prefs = loadGcalPrefs();
    const typedUrl = document.getElementById('gcal-input-ical-url')?.value.trim() || '';
    syncNowBtn.disabled = true;
    try {
      if (prefs.oauthConnected) {
        await syncFromGoogleCalendarOAuth({ silent: false });
      } else if (prefs.icalUrl || typedUrl) {
        await syncFromIcalUrl(prefs.icalUrl || typedUrl, { silent: false });
      } else {
        toast('Please sign in with Google or enter an iCal (.ics) URL first.');
      }
    } catch (err) {
      toast('Sync failed: ' + (err?.message || err));
    } finally {
      updateGcalModalUI();
    }
  });

  discBtn?.addEventListener('click', async () => {
    _gcalAccessToken = null;
    _gcalTokenExpiry = 0;
    _lastRawCalendarEvents = null;
    try {
      if (typeof window.__DESKTOP_GOOGLE_CALENDAR_SIGNOUT__ === 'function') {
        await window.__DESKTOP_GOOGLE_CALENDAR_SIGNOUT__();
      }
    } catch {}
    saveSyncedEvents([]);
    saveGcalPrefs({
      oauthConnected: false,
      icalUrl: '',
      lastSyncedAt: null,
      lastSource: null,
      lastSyncRange: null,
      lastStats: null,
    });
    const icalInput = document.getElementById('gcal-input-ical-url');
    if (icalInput) icalInput.value = '';
    updateGcalModalUI();
    renderEditableSchedule();
    toast('Disconnected Google Calendar sync');
  });

  saveIcalBtn?.addEventListener('click', async () => {
    const url = document.getElementById('gcal-input-ical-url')?.value.trim() || '';
    if (!url) {
      toast('Please paste your Google Calendar secret iCal (.ics) URL');
      return;
    }
    saveIcalBtn.disabled = true;
    const origText = saveIcalBtn.textContent;
    saveIcalBtn.textContent = 'Syncing…';
    try {
      await syncFromIcalUrl(url, { silent: false });
    } catch (err) {
      toast('iCal sync failed: ' + (err?.message || err));
    } finally {
      saveIcalBtn.disabled = false;
      saveIcalBtn.textContent = origText;
      updateGcalModalUI();
    }
  });

  importIcsBtn?.addEventListener('click', () => {
    icsFileInput?.click();
  });

  icsFileInput?.addEventListener('change', async (e) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      syncFromIcalText(text, { source: 'ics-file', silent: false });
    } catch (err) {
      toast('Failed to read .ics file: ' + (err?.message || err));
    } finally {
      e.target.value = '';
      updateGcalModalUI();
    }
  });

  chkCollege?.addEventListener('change', () => {
    saveGcalPrefs({ collegeOnly: !!chkCollege.checked });
    reapplyFilterFromCacheOrSync();
    updateGcalModalUI();
  });

  extraInput?.addEventListener('change', () => {
    saveGcalPrefs({ extraIgnore: extraInput.value.trim() });
    reapplyFilterFromCacheOrSync();
    updateGcalModalUI();
  });
}

// ── 7. Render Editable Schedule (Weekly Docket & Google Calendar Grid) ──────

function resolveScheduleSpineColor(subjectTitle, sylPdf) {
  if (sylPdf) {
    const linkedSubj = getSubjectForPdf(sylPdf);
    if (linkedSubj) return getSubjectBinderColor(linkedSubj);
  }
  const q = (subjectTitle || '').trim().toLowerCase();
  if (q && Array.isArray(S.subjects) && S.subjects.length) {
    const codeMatch = q.match(/\b(\d{3})\b/);
    const code = codeMatch ? codeMatch[1] : null;
    const matched = (code && S.subjects.find(s => (s.name || '').toLowerCase().includes(code)))
      || S.subjects.find(s => {
        const sn = (s.name || '').toLowerCase();
        return sn === q || sn.includes(q) || q.includes(sn);
      });
    if (matched) return getSubjectBinderColor(matched);
  }
  return subjectTitle ? getSubjectBinderColor({ name: subjectTitle }) : 'var(--accent)';
}

function getMondayOfWeek(d) {
  const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const dow = dt.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  dt.setDate(dt.getDate() + diff);
  return dt;
}

function formatRangeTitle(startDt, endDt, span) {
  if (span === 'month') {
    return `${MONTH_LONG[_gridAnchorDate.getMonth()]} ${_gridAnchorDate.getFullYear()}`;
  }
  const sy = startDt.getFullYear();
  const ey = endDt.getFullYear();
  const sm = MONTH_SHORT[startDt.getMonth()];
  const em = MONTH_SHORT[endDt.getMonth()];
  if (sy === ey && sm === em) {
    return `${sm} ${startDt.getDate()} – ${endDt.getDate()}, ${sy}`;
  }
  if (sy === ey) {
    return `${sm} ${startDt.getDate()} – ${em} ${endDt.getDate()}, ${sy}`;
  }
  return `${sm} ${startDt.getDate()}, ${sy} – ${em} ${endDt.getDate()}, ${ey}`;
}

function renderWeeklyDocketView(grid, schedule, activeDays) {
  grid.className = 'cal-grid';
  grid.style.removeProperty('--gcal-cols');
  grid.style.removeProperty('grid-template-columns');
  grid.style.setProperty('--cal-cols', String(activeDays.length));
  grid.innerHTML = '';

  activeDays.forEach(day => {
    const col = document.createElement('div');
    col.className = 'cal-day';

    const dayTitle = document.createElement('div');
    dayTitle.className = 'cal-day-title';
    dayTitle.textContent = day;
    col.appendChild(dayTitle);

    const dayEntries = schedule
      .filter(x => (x.day || '').toUpperCase() === day)
      .sort((a, b) => parseStartMinutesFromStr(a.time) - parseStartMinutesFromStr(b.time));

    if (dayEntries.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center; font-size:11px; color:var(--ink-muted, var(--muted)); padding:16px 0; font-style:italic;';
      empty.textContent = 'No classes';
      col.appendChild(empty);
    } else {
      dayEntries.forEach(entry => {
        const sylPdf = getSyllabusPdfForSubject(entry.subject);
        const color = resolveScheduleSpineColor(entry.subject, sylPdf);
        const sylTooltip = sylPdf
          ? `Open ${sylPdf.name} where you last left off`
          : `Open Syllabus for ${entry.subject} (click to choose)`;

        const card = document.createElement('div');
        card.className = 'cal-item';
        card.dataset.id = entry.id;
        card.dataset.subject = entry.subject;
        card.style.setProperty('--spine', color);

        card.innerHTML = `
          <div class="cal-item-head">
            <strong>${escapeHtml(entry.subject)}</strong>
            <button type="button" class="cal-edit-btn" data-id="${escapeHtml(entry.id)}" title="Edit this class" aria-label="Edit this class"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-pen"/></svg></button>
          </div>
          <div class="cal-time">${escapeHtml(entry.time || '')}</div>
          ${entry.prof ? `<div class="cal-prof">${escapeHtml(entry.prof)}</div>` : ''}
          <div class="gn-cal-actions">
            <span class="gn-cal-open-binder gn-cal-open-syllabus" title="${escapeHtml(sylTooltip)}"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-book"/></svg><span>Open Syllabus</span><svg class="icon icon-sm" aria-hidden="true"><use href="#i-arrow-right"/></svg></span>
            <button class="gn-cal-note-btn" type="button" title="Open quick class notes for ${escapeHtml(entry.subject)}"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-note"/></svg><span>Note</span></button>
          </div>
        `;

        card.querySelector('.cal-edit-btn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          openEditScheduleModal(entry.id);
        });

        col.appendChild(card);
      });
    }

    grid.appendChild(col);
  });
}

function renderCalendarGridView(docket, grid, schedule) {
  const prefs = loadGcalPrefs();
  const syncedEvents = loadSyncedEvents();
  const span = getGridSpan();
  const todayStr = toLocalDateStr(new Date());

  const hasWeekendScheduled = schedule.some(x => {
    const d = (x.day || '').toUpperCase();
    return d === 'SAT' || d === 'SUN';
  });
  const hasWeekendSynced = syncedEvents.some(e => e.day === 'SAT' || e.day === 'SUN');
  const showWeekend = hasWeekendScheduled || hasWeekendSynced;
  const visibleDayCodes = showWeekend
    ? ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
    : ['MON', 'TUE', 'WED', 'THU', 'FRI'];

  // Build list of date cells to render
  const cells = [];
  const anchorMonth = _gridAnchorDate.getMonth();
  const anchorYear = _gridAnchorDate.getFullYear();

  if (span === '2week') {
    const startMon = getMondayOfWeek(_gridAnchorDate);
    for (let w = 0; w < 2; w++) {
      for (let di = 0; di < visibleDayCodes.length; di++) {
        const dt = new Date(startMon.getFullYear(), startMon.getMonth(), startMon.getDate() + w * 7 + di);
        cells.push({ date: dt, outside: false });
      }
    }
  } else {
    const firstOfMonth = new Date(anchorYear, anchorMonth, 1);
    const lastOfMonth = new Date(anchorYear, anchorMonth + 1, 0);
    let weekMon = getMondayOfWeek(firstOfMonth);
    if (!showWeekend && (firstOfMonth.getDay() === 0 || firstOfMonth.getDay() === 6)) {
      weekMon = new Date(weekMon.getFullYear(), weekMon.getMonth(), weekMon.getDate() + 7);
    }

    let weekGuard = 0;
    while (weekMon <= lastOfMonth && weekGuard < 6) {
      weekGuard++;
      const weekCells = [];
      let hasInMonth = false;
      for (let di = 0; di < visibleDayCodes.length; di++) {
        const dt = new Date(weekMon.getFullYear(), weekMon.getMonth(), weekMon.getDate() + di);
        const outside = dt.getMonth() !== anchorMonth;
        if (!outside) hasInMonth = true;
        weekCells.push({ date: dt, outside });
      }
      if (hasInMonth) {
        cells.push(...weekCells);
      }
      weekMon = new Date(weekMon.getFullYear(), weekMon.getMonth(), weekMon.getDate() + 7);
    }
  }

  const rangeStart = cells[0]?.date || _gridAnchorDate;
  const rangeEnd = cells[cells.length - 1]?.date || _gridAnchorDate;
  const rangeTitleText = formatRangeTitle(rangeStart, rangeEnd, span);
  const collegeOnly = prefs.collegeOnly !== false;

  // Ensure .gcal-toolbar sits right before #cal-grid
  let toolbar = docket.querySelector('.gcal-toolbar');
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.className = 'gcal-toolbar';
    grid.insertAdjacentElement('beforebegin', toolbar);
  }

  toolbar.innerHTML = `
    <div class="gcal-nav-group">
      <button type="button" id="gcal-nav-prev" class="gcal-nav-btn" title="Previous" aria-label="Previous">&#8249;</button>
      <button type="button" id="gcal-nav-today" class="gcal-nav-btn">Today</button>
      <button type="button" id="gcal-nav-next" class="gcal-nav-btn" title="Next" aria-label="Next">&#8250;</button>
      <span class="gcal-range-title">${escapeHtml(rangeTitleText)}</span>
    </div>
    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
      <div class="gcal-span-toggle" role="group" aria-label="Calendar span">
        <button type="button" id="gcal-span-2w" class="gcal-span-btn${span === '2week' ? ' is-active' : ''}">2 Weeks</button>
        <button type="button" id="gcal-span-month" class="gcal-span-btn${span === 'month' ? ' is-active' : ''}">Month</button>
      </div>
      <button type="button" class="gcal-filter-pill" title="Toggle College-Only filter or configure Google Calendar sync">${collegeOnly ? 'College Only ✓' : 'All Events'}</button>
    </div>
  `;

  toolbar.querySelector('#gcal-nav-prev')?.addEventListener('click', () => {
    if (span === '2week') {
      _gridAnchorDate = new Date(_gridAnchorDate.getFullYear(), _gridAnchorDate.getMonth(), _gridAnchorDate.getDate() - 14);
    } else {
      _gridAnchorDate = new Date(_gridAnchorDate.getFullYear(), _gridAnchorDate.getMonth() - 1, 1);
    }
    renderEditableSchedule();
  });

  toolbar.querySelector('#gcal-nav-next')?.addEventListener('click', () => {
    if (span === '2week') {
      _gridAnchorDate = new Date(_gridAnchorDate.getFullYear(), _gridAnchorDate.getMonth(), _gridAnchorDate.getDate() + 14);
    } else {
      _gridAnchorDate = new Date(_gridAnchorDate.getFullYear(), _gridAnchorDate.getMonth() + 1, 1);
    }
    renderEditableSchedule();
  });

  toolbar.querySelector('#gcal-nav-today')?.addEventListener('click', () => {
    _gridAnchorDate = new Date();
    renderEditableSchedule();
  });

  toolbar.querySelector('#gcal-span-2w')?.addEventListener('click', () => setGridSpan('2week'));
  toolbar.querySelector('#gcal-span-month')?.addEventListener('click', () => setGridSpan('month'));
  toolbar.querySelector('.gcal-filter-pill')?.addEventListener('click', () => {
    if (prefs.lastSyncedAt || prefs.oauthConnected || prefs.icalUrl) {
      saveGcalPrefs({ collegeOnly: !collegeOnly });
      reapplyFilterFromCacheOrSync();
    } else {
      openSyncGcalModal();
    }
  });

  // Render Google Calendar Grid
  grid.className = 'cal-grid gcal-grid';
  grid.style.removeProperty('--cal-cols');
  grid.style.removeProperty('grid-template-columns');
  grid.style.setProperty('--gcal-cols', String(visibleDayCodes.length));
  grid.innerHTML = '';

  visibleDayCodes.forEach(code => {
    const hdr = document.createElement('div');
    hdr.className = 'gcal-day-hdr';
    hdr.textContent = code;
    grid.appendChild(hdr);
  });

  // Determine synced coverage range
  let syncMinStr = prefs.lastSyncRange?.minDateStr || null;
  let syncMaxStr = prefs.lastSyncRange?.maxDateStr || null;
  if (prefs.lastSyncedAt && (!syncMinStr || !syncMaxStr)) {
    const base = new Date(prefs.lastSyncedAt);
    syncMinStr = toLocalDateStr(new Date(base.getFullYear(), base.getMonth(), base.getDate() - 30));
    syncMaxStr = toLocalDateStr(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 60));
  }
  const hasLiveSyncedData = Boolean(prefs.lastSyncedAt && syncMinStr && syncMaxStr && syncedEvents.length > 0);

  cells.forEach((cellInfo, cellIdx) => {
    const dt = cellInfo.date;
    const dateStr = toLocalDateStr(dt);
    const dayCode = JS_DAY_TO_CODE[dt.getDay()];

    const cell = document.createElement('div');
    cell.className = 'gcal-cell';
    if (cellInfo.outside) cell.classList.add('gcal-cell--outside');
    if (dateStr === todayStr) cell.classList.add('gcal-cell--today');

    const dateNum = document.createElement('div');
    dateNum.className = 'gcal-date-num';
    dateNum.textContent = (dt.getDate() === 1 || cellIdx === 0)
      ? `${MONTH_SHORT[dt.getMonth()]} ${dt.getDate()}`
      : String(dt.getDate());
    cell.appendChild(dateNum);

    const eventsWrap = document.createElement('div');
    eventsWrap.className = 'gcal-cell-events';

    const inSyncedRange = hasLiveSyncedData && dateStr >= syncMinStr && dateStr <= syncMaxStr;
    let dayItems;
    if (inSyncedRange) {
      dayItems = syncedEvents
        .filter(ev => ev.dateStr === dateStr)
        .sort((a, b) => (a.startMinutes ?? parseStartMinutesFromStr(a.time)) - (b.startMinutes ?? parseStartMinutesFromStr(b.time)));
    } else {
      dayItems = schedule
        .filter(x => (x.day || '').toUpperCase() === dayCode)
        .map(x => ({
          ...x,
          shortTime: formatShortTimeFromStr(x.time),
          startMinutes: parseStartMinutesFromStr(x.time),
        }))
        .sort((a, b) => a.startMinutes - b.startMinutes);
    }

    dayItems.forEach(entry => {
      const sylPdf = getSyllabusPdfForSubject(entry.subject);
      const color = resolveScheduleSpineColor(entry.subject, sylPdf);
      const shortTime = entry.shortTime || formatShortTimeFromStr(entry.time);
      const matchedSched = schedule.find(s => s.id === entry.id)
        || schedule.find(s => s.day === dayCode && subjectTokensMatch(s.subject, entry.subject));
      const editId = matchedSched ? matchedSched.id : (entry.id || '');
      const sylTooltip = sylPdf
        ? `Open ${sylPdf.name} where you last left off`
        : `Open Syllabus for ${entry.subject} (click to choose)`;

      const chip = document.createElement('div');
      chip.className = 'cal-item gcal-chip';
      chip.dataset.id = editId || entry.id;
      chip.dataset.subject = entry.subject;
      chip.style.setProperty('--spine', color);
      chip.title = `${entry.subject}${entry.time ? ' · ' + entry.time : ''}${entry.prof ? ' · ' + entry.prof : ''}`;

      chip.innerHTML = `
        <span class="gcal-chip-dot"></span>
        ${shortTime ? `<span class="gcal-chip-time">${escapeHtml(shortTime)}</span>` : ''}
        <strong class="gcal-chip-title">${escapeHtml(entry.subject)}</strong>
        <div class="gn-cal-actions gcal-chip-acts">
          <span class="gn-cal-open-binder gn-cal-open-syllabus" title="${escapeHtml(sylTooltip)}"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-book"/></svg><span>Open Syllabus</span></span>
          <button class="gn-cal-note-btn" type="button" title="Open quick class notes for ${escapeHtml(entry.subject)}"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-note"/></svg><span>Note</span></button>
          <button type="button" class="cal-edit-btn" data-id="${escapeHtml(editId)}" title="Edit this class" aria-label="Edit this class"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-pen"/></svg></button>
        </div>
      `;

      chip.querySelector('.cal-edit-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditScheduleModal(editId || null);
      });

      eventsWrap.appendChild(chip);
    });

    cell.appendChild(eventsWrap);
    grid.appendChild(cell);
  });
}

export function renderEditableSchedule(options = {}) {
  const cal = document.getElementById('welcome-calendar');
  if (!cal) return;

  cal.dataset.schedRendered = 'true';
  const schedule = loadScheduleData();
  const viewMode = getScheduleViewMode();
  const prefs = loadGcalPrefs();

  // 1. Ensure Study Desk header (.cal-header.desk__header) with stats slot, view toggle & sync controls
  let header = cal.querySelector('.cal-header');
  if (!header) {
    header = document.createElement('div');
    cal.prepend(header);
  }
  header.className = 'cal-header desk__header';

  if (!header.querySelector('.desk__heading') || !header.querySelector('#cal-view-toggle-docket')) {
    header.innerHTML = `
      <div class="desk__heading">
        <h1 class="desk__title">Study Desk</h1>
        <p class="desk__subtitle">Midterm Case Syllabus · Class Docket &amp; Active Folios</p>
      </div>
      <div class="desk__controls cal-header-acts">
        <div class="desk__stats" id="gn-desk-stats-slot"></div>
        <div class="cal-view-toggle" role="group" aria-label="Calendar view">
          <button type="button" id="cal-view-toggle-docket" class="cal-view-btn" data-cal-view="docket">Weekly Docket</button>
          <button type="button" id="cal-view-toggle-grid" class="cal-view-btn" data-cal-view="grid">Calendar Grid</button>
        </div>
        <button type="button" id="btn-sync-gcal" class="btn-sec" title="Sync schedule with Google Calendar"><span class="gcal-sync-dot"></span><span>Sync Google Cal</span></button>
        <button type="button" id="btn-edit-schedule" class="btn-sec" title="Customize your class schedule"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-pen"/></svg><span>Edit Schedule</span></button>
        <button type="button" id="btn-add-class" class="btn-gold" title="Add a new class"><svg class="icon icon-sm" aria-hidden="true"><use href="#i-plus"/></svg><span>Add Class</span></button>
      </div>
    `;

    header.querySelector('#cal-view-toggle-docket')?.addEventListener('click', () => setScheduleViewMode('docket'));
    header.querySelector('#cal-view-toggle-grid')?.addEventListener('click', () => setScheduleViewMode('grid'));
    header.querySelector('#btn-sync-gcal')?.addEventListener('click', () => openSyncGcalModal());
    header.querySelector('#btn-edit-schedule')?.addEventListener('click', () => openEditScheduleModal());
    header.querySelector('#btn-add-class')?.addEventListener('click', () => openEditScheduleModal(null, true));
  }

  // Update active view toggle & sync indicator dot on every render
  const docketToggleBtn = header.querySelector('#cal-view-toggle-docket');
  const gridToggleBtn = header.querySelector('#cal-view-toggle-grid');
  if (docketToggleBtn) {
    docketToggleBtn.classList.toggle('is-active', viewMode === 'docket');
    docketToggleBtn.setAttribute('aria-pressed', viewMode === 'docket' ? 'true' : 'false');
  }
  if (gridToggleBtn) {
    gridToggleBtn.classList.toggle('is-active', viewMode === 'grid');
    gridToggleBtn.setAttribute('aria-pressed', viewMode === 'grid' ? 'true' : 'false');
  }

  const syncDot = header.querySelector('#btn-sync-gcal .gcal-sync-dot');
  const syncBtn = header.querySelector('#btn-sync-gcal');
  const isConnected = Boolean(prefs.oauthConnected || prefs.icalUrl || prefs.lastSyncedAt);
  if (syncDot) {
    syncDot.classList.toggle('is-connected', isConnected);
  }
  if (syncBtn) {
    syncBtn.title = prefs.lastSyncedAt
      ? `Sync schedule with Google Calendar (Last synced ${new Date(prefs.lastSyncedAt).toLocaleString()})`
      : 'Sync schedule with Google Calendar';
  }

  // 2. Determine active day columns
  const standardDays = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
  const hasSat = schedule.some(x => (x.day || '').toUpperCase() === 'SAT');
  const hasSun = schedule.some(x => (x.day || '').toUpperCase() === 'SUN');
  const activeDays = [...standardDays];
  if (hasSat) activeDays.push('SAT');
  if (hasSun) activeDays.push('SUN');

  // 3. Wrap #cal-grid inside <section class="docket"> and populate it
  let docket = cal.querySelector('section.docket');
  let grid = cal.querySelector('#cal-grid') || cal.querySelector('.cal-grid');
  if (!docket) {
    docket = document.createElement('section');
    docket.className = 'docket';
    docket.innerHTML = `<div class="desk__section-head"><h2 class="desk__section-label">TODAY'S DOCKET · CLASS SCHEDULE</h2></div>`;
    if (grid && grid.parentNode) {
      grid.parentNode.insertBefore(docket, grid);
      docket.appendChild(grid);
    } else {
      header.insertAdjacentElement('afterend', docket);
    }
  }
  if (!grid) {
    grid = document.createElement('div');
    grid.className = 'cal-grid';
    docket.appendChild(grid);
  }
  if (!grid.id) grid.id = 'cal-grid';

  if (viewMode === 'grid') {
    renderCalendarGridView(docket, grid, schedule);
  } else {
    docket.querySelector('.gcal-toolbar')?.remove();
    renderWeeklyDocketView(grid, schedule, activeDays);
  }

  // Keep Study Desk stats slot & Active Folios shelf position synced without circular calls
  import('./goodnotes-ui.js').then(m => {
    if (typeof m.renderStudyDesk === 'function') {
      m.renderStudyDesk({ skipSchedule: true });
    }
  }).catch(() => {});
}

// ── 8. Context Menu Integration & Reactive Observers ────────────────────────

function wireContextMenuListener() {
  document.addEventListener('contextmenu', e => {
    const pdfEl = e.target.closest('.li-pdf');
    if (pdfEl && pdfEl.dataset && pdfEl.dataset.id) {
      _lastContextPdf = S.pdfs.find(p => p.id === pdfEl.dataset.id) || null;
      const sylItem = document.getElementById('ctx-set-syllabus');
      if (sylItem) sylItem.style.display = 'flex';
    } else {
      const sylItem = document.getElementById('ctx-set-syllabus');
      if (sylItem) sylItem.style.display = 'none';
    }
  }, true);

  const sylBtn = document.getElementById('ctx-set-syllabus');
  sylBtn?.addEventListener('click', () => {
    if (sylBtn.dataset.libCtxHandled === '1') return;
    document.getElementById('lib-ctx-menu')?.classList.remove('open');
    const pdf = _lastContextPdf || S.curPDF;
    if (pdf) {
      setSubjectSyllabusPdf(pdf);
    } else {
      toast('Please right-click on a PDF to set it as a syllabus.');
    }
  });
}

function setupCanvasObserver() {
  if (_observerActive) return;
  const container = document.getElementById('canvas-scroll');
  if (!container) return;
  _observerActive = true;
  const obs = new MutationObserver(() => {
    const cal = document.getElementById('welcome-calendar');
    if (cal && !cal.dataset.schedRendered) {
      renderEditableSchedule();
    }
  });
  obs.observe(container, { childList: true, subtree: true });
}

// ── 9. Initialization ───────────────────────────────────────────────────────

export async function initEditableSchedule() {
  loadScheduleData();
  loadSyllabusMap();
  loadGcalPrefs();
  loadSyncedEvents();

  if (typeof window !== 'undefined') {
    window.__setSubjectSyllabusPdf = setSubjectSyllabusPdf;
  }

  // Cloud sync hydration from Supabase app_settings
  try {
    const [cloudSched, cloudSyl, cloudMigratedV2, cloudGcalPrefs, cloudGcalEvents] = await Promise.all([
      dbGetSetting(SCHEDULE_STORAGE_KEY).catch(() => null),
      dbGetSetting(SYLLABUS_STORAGE_KEY).catch(() => null),
      dbGetSetting(SCHEDULE_MIGRATED_V2_KEY).catch(() => null),
      dbGetSetting(GCAL_PREFS_KEY).catch(() => null),
      dbGetSetting(GCAL_EVENTS_KEY).catch(() => null),
    ]);
    let changed = false;

    if (cloudSched) {
      try {
        const parsed = JSON.parse(cloudSched);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const { list, migrated } = applyLegacyLaborMigration(parsed, {
            forceCheck: cloudMigratedV2 !== '1',
          });
          _scheduleData = list;
          if (!migrated) {
            safeStorageSet(SCHEDULE_STORAGE_KEY, cloudSched);
          }
          changed = true;
        }
      } catch {}
    }

    if (cloudSyl) {
      try {
        const parsed = JSON.parse(cloudSyl);
        if (parsed && typeof parsed === 'object') {
          _syllabusMap = Object.assign({}, _syllabusMap, parsed);
          safeStorageSet(SYLLABUS_STORAGE_KEY, JSON.stringify(_syllabusMap));
          changed = true;
        }
      } catch {}
    }

    let cloudPrefsNewer = false;
    if (cloudGcalPrefs) {
      try {
        const parsed = JSON.parse(cloudGcalPrefs);
        if (parsed && typeof parsed === 'object') {
          const localPrefs = loadGcalPrefs();
          const cloudTs = Number(parsed.lastSyncedAt || 0);
          const localTs = Number(localPrefs.lastSyncedAt || 0);
          if (!localTs || cloudTs > localTs) {
            _gcalPrefs = { ...DEFAULT_GCAL_PREFS, ...parsed };
            safeStorageSet(GCAL_PREFS_KEY, JSON.stringify(_gcalPrefs));
            cloudPrefsNewer = true;
            changed = true;
          }
        }
      } catch {}
    }

    if (cloudGcalEvents) {
      try {
        const parsed = JSON.parse(cloudGcalEvents);
        if (Array.isArray(parsed) && (cloudPrefsNewer || loadSyncedEvents().length === 0)) {
          _syncedEvents = parsed;
          safeStorageSet(GCAL_EVENTS_KEY, JSON.stringify(_syncedEvents));
          changed = true;
        }
      } catch {}
    }

    if (changed) {
      renderEditableSchedule();
    }
  } catch (err) {
    console.warn('[Schedule] Cloud sync fetch warning:', err);
  }

  wireScheduleModals();
  wireContextMenuListener();
  setupCanvasObserver();
  renderEditableSchedule();

  // Auto-sync Google Calendar in background on startup (non-blocking)
  const activePrefs = loadGcalPrefs();
  if (activePrefs.oauthConnected) {
    syncFromGoogleCalendarOAuth({ silent: true }).catch(() => {});
  } else if (activePrefs.icalUrl) {
    syncFromIcalUrl(activePrefs.icalUrl, { silent: true }).catch(() => {});
  }
}

// Expose setSubjectSyllabusPdf on window immediately at load time
if (typeof window !== 'undefined') {
  window.__setSubjectSyllabusPdf = setSubjectSyllabusPdf;
}
