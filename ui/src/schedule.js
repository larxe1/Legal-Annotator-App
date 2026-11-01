// ═══════════════════════════════════════════════════════════════════════════
// EDITABLE CLASS SCHEDULE & SUBJECT SYLLABUS INTEGRATION
// Customizable weekly schedule (cloud-synced to Supabase app_settings) with
// "Set as Subject Syllabus" and "Open Syllabus" (jumps where user left off).
// ═══════════════════════════════════════════════════════════════════════════

import { S } from './state.js';
import { toast, openModal, closeModal } from './ui.js';
import { safeStorageGet, safeStorageSet } from './storage.js';
import { dbGetSetting, dbSetSetting } from './db.js';
import { getSubjectBinderColor, getSubjectForPdf } from './goodnotes-ui.js';
import { openPDFFromLibrary } from './viewer.js';

const SCHEDULE_STORAGE_KEY = 'custom_class_schedule_v1';
const SYLLABUS_STORAGE_KEY = 'subj_syllabus_v1';

// Default initial schedule preserving the MON–FRI law school curriculum
export const DEFAULT_SCHEDULE = [
  { id: 'sched_1', day: 'MON', subject: '103: Sales', time: '9:00 - 11:00 AM', prof: 'Atty. Ryan Anthony Malit · 321' },
  { id: 'sched_2', day: 'MON', subject: '124: CrimPro', time: '2:30 - 4:00 PM', prof: 'Atty. Noel Lazaro · 203-205' },
  { id: 'sched_3', day: 'TUE', subject: '104: Torts and Damages', time: '8:00 - 9:30 AM', prof: 'Atty. Ramon Quintin Allado · 321' },
  { id: 'sched_4', day: 'TUE', subject: '139: Insurance', time: '10:00 - 12:00 PM', prof: 'Atty. Jose Martin Loon · 127' },
  { id: 'sched_5', day: 'TUE', subject: '113: Labor 1', time: '3:00 - 4:30 PM', prof: 'Atty. E. Leo Battad · 221' },
  { id: 'sched_6', day: 'WED', subject: '102: Property', time: '3:00 - 5:00 PM', prof: 'Atty. John Noah Red · Online' },
  { id: 'sched_7', day: 'THU', subject: '104: Torts and Damages', time: '8:00 - 9:30 AM', prof: 'Atty. Ramon Quintin Allado · 321' },
  { id: 'sched_8', day: 'THU', subject: '113: Labor 1', time: '3:00 - 4:30 PM', prof: 'Atty. E. Leo Battad · 221' },
  { id: 'sched_9', day: 'FRI', subject: '124: CrimPro', time: '1:00 - 2:30 PM', prof: 'Atty. Noel Lazaro · 203-205' },
  { id: 'sched_10', day: 'FRI', subject: '102: Property', time: '5:00 - 7:00 PM', prof: 'Atty. John Noah Red · 303-305' },
];

let _scheduleData = null;
let _syllabusMap = {};
let _lastContextPdf = null;
let _observerActive = false;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── 1. Data Hydration & Cloud Sync ──────────────────────────────────────────

export function loadScheduleData() {
  if (Array.isArray(_scheduleData) && _scheduleData.length > 0) {
    return _scheduleData;
  }
  const raw = safeStorageGet(SCHEDULE_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        _scheduleData = parsed;
        return _scheduleData;
      }
    } catch {}
  }
  _scheduleData = JSON.parse(JSON.stringify(DEFAULT_SCHEDULE));
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
    toast(`📖 Opening Syllabus: ${pdf.name}`);
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
            ${sylPdf ? '<span title="Syllabus Linked" style="font-size:11px;">📖</span>' : ''}
          </div>
          <div style="font-size:11px; color:var(--muted); margin-top:2px;">
            ${escapeHtml(item.time || '')}${item.prof ? ' · ' + escapeHtml(item.prof) : ''}
          </div>
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          <button type="button" class="btn-sec sched-row-edit" style="font-size:11px; padding:3px 7px;">Edit</button>
          <button type="button" class="btn-sec sched-row-del" style="font-size:11px; padding:3px 7px; color:var(--red);" title="Delete class">✕</button>
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

function wireScheduleModals() {
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
}

// ── 6. Render Editable Schedule into #welcome-calendar ──────────────────────

export function renderEditableSchedule(options = {}) {
  const cal = document.getElementById('welcome-calendar');
  if (!cal) return;

  cal.dataset.schedRendered = 'true';
  const schedule = loadScheduleData();

  // 1. Ensure header contains Edit / Add Class toolbar
  let header = cal.querySelector('.cal-header');
  if (!header) {
    header = document.createElement('div');
    header.className = 'cal-header';
    header.innerHTML = `<h2>Class Schedule</h2><p>2nd Year, 1st Semester</p>`;
    cal.prepend(header);
  }

  let actBar = header.querySelector('.cal-header-acts');
  if (!actBar) {
    actBar = document.createElement('div');
    actBar.className = 'cal-header-acts';
    actBar.style.cssText = 'display:flex; justify-content:flex-end; gap:8px; margin-bottom:10px;';
    actBar.innerHTML = `
      <button type="button" id="btn-edit-schedule" class="btn-sec" style="font-size:12px; padding:5px 12px; border-radius:6px; cursor:pointer;" title="Customize your class schedule">✏️ Edit Schedule</button>
      <button type="button" id="btn-add-class" class="btn-gold" style="font-size:12px; padding:5px 12px; border-radius:6px; cursor:pointer;" title="Add a new class">➕ Add Class</button>
    `;
    header.prepend(actBar);

    actBar.querySelector('#btn-edit-schedule')?.addEventListener('click', () => {
      openEditScheduleModal();
    });
    actBar.querySelector('#btn-add-class')?.addEventListener('click', () => {
      openEditScheduleModal(null, true);
    });
  }

  // 2. Determine active day columns
  const standardDays = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
  const hasSat = schedule.some(x => (x.day || '').toUpperCase() === 'SAT');
  const hasSun = schedule.some(x => (x.day || '').toUpperCase() === 'SUN');
  const activeDays = [...standardDays];
  if (hasSat) activeDays.push('SAT');
  if (hasSun) activeDays.push('SUN');

  // 3. Populate .cal-grid
  let grid = cal.querySelector('.cal-grid');
  if (!grid) {
    grid = document.createElement('div');
    grid.className = 'cal-grid';
    cal.appendChild(grid);
  }

  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = `repeat(${activeDays.length}, 1fr)`;
  grid.style.gap = '14px';
  grid.innerHTML = '';

  activeDays.forEach(day => {
    const col = document.createElement('div');
    col.className = 'cal-day';

    const dayTitle = document.createElement('div');
    dayTitle.className = 'cal-day-title';
    dayTitle.textContent = day;
    col.appendChild(dayTitle);

    const dayEntries = schedule.filter(x => (x.day || '').toUpperCase() === day);

    if (dayEntries.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center; font-size:11px; color:var(--muted); padding:16px 0; font-style:italic;';
      empty.textContent = 'No classes';
      col.appendChild(empty);
    } else {
      dayEntries.forEach(entry => {
        const color = getSubjectBinderColor({ name: entry.subject });
        const sylPdf = getSyllabusPdfForSubject(entry.subject);
        const sylTooltip = sylPdf
          ? `Open ${sylPdf.name} where you last left off`
          : `Open Syllabus for ${entry.subject} (click to choose)`;

        const card = document.createElement('div');
        card.className = 'cal-item';
        card.dataset.id = entry.id;
        card.dataset.subject = entry.subject;
        card.style.cssText = `position:relative; cursor:pointer; border-left:4px solid ${color};`;

        card.innerHTML = `
          <button type="button" class="cal-edit-btn" data-id="${entry.id}" title="Edit this class" style="position:absolute; top:6px; right:6px; background:rgba(0,0,0,0.2); border:none; color:var(--muted); font-size:11px; cursor:pointer; padding:2px 5px; border-radius:4px; opacity:0.8; transition:opacity .15s, color .15s;">✏️</button>
          <strong>${escapeHtml(entry.subject)}</strong>
          <div class="cal-time">${escapeHtml(entry.time || '')}</div>
          ${entry.prof ? `<div class="cal-prof" style="font-size:11px; color:var(--muted); margin-bottom:4px; line-height:1.3;">${escapeHtml(entry.prof)}</div>` : ''}
          <div class="gn-cal-actions">
            <span class="gn-cal-open-binder gn-cal-open-syllabus" title="${escapeHtml(sylTooltip)}" style="cursor:pointer;">📖 Open Syllabus ↗</span>
            <button class="gn-cal-note-btn" type="button" title="Open quick class notes for ${escapeHtml(entry.subject)}">📝 Note</button>
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

  // Keep GoodNotes Study Desk shelf & digest stat counters in sync (only when not already called from renderStudyDesk)
  if (!options?.fromStudyDesk) {
    import('./goodnotes-ui.js').then(m => {
      if (typeof m.renderStudyDesk === 'function') {
        m.renderStudyDesk({ skipSchedule: true });
      }
    }).catch(() => {});
  }
}

// ── 7. Context Menu Integration & Reactive Observers ────────────────────────

function wireContextMenuListener() {
  document.addEventListener('contextmenu', e => {
    const pdfEl = e.target.closest('.li-pdf');
    if (pdfEl && pdfEl.dataset && pdfEl.dataset.id) {
      _lastContextPdf = S.pdfs.find(p => p.id === pdfEl.dataset.id) || null;
      const sylItem = document.getElementById('lib-ctx-set-syllabus');
      if (sylItem) sylItem.style.display = 'block';
    } else {
      const sylItem = document.getElementById('lib-ctx-set-syllabus');
      if (sylItem) sylItem.style.display = 'none';
    }
  }, true);

  document.getElementById('lib-ctx-set-syllabus')?.addEventListener('click', () => {
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

// ── 8. Initialization ───────────────────────────────────────────────────────

export async function initEditableSchedule() {
  loadScheduleData();
  loadSyllabusMap();

  if (typeof window !== 'undefined') {
    window.__setSubjectSyllabusPdf = setSubjectSyllabusPdf;
  }

  // Cloud sync hydration from Supabase app_settings
  try {
    const [cloudSched, cloudSyl] = await Promise.all([
      dbGetSetting(SCHEDULE_STORAGE_KEY).catch(() => null),
      dbGetSetting(SYLLABUS_STORAGE_KEY).catch(() => null)
    ]);
    let changed = false;
    if (cloudSched) {
      try {
        const parsed = JSON.parse(cloudSched);
        if (Array.isArray(parsed) && parsed.length > 0) {
          _scheduleData = parsed;
          safeStorageSet(SCHEDULE_STORAGE_KEY, cloudSched);
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
}

// Expose setSubjectSyllabusPdf on window immediately at load time
if (typeof window !== 'undefined') {
  window.__setSubjectSyllabusPdf = setSubjectSyllabusPdf;
}
