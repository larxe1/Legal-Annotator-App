// ═══════════════════════════════════════════════
// ANNOTATE — highlights, annotation panel, notes
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { toast, autosave, openModal, closeModal, closeOtherPanels } from './ui.js';
import {
  dbCreateAnnotation, dbUpdateAnnColor, dbDelAnnotation,
  dbCreateNote, dbUpdateNote, dbDelNote,
} from './db.js';
import { handlePaste, showTablePicker, insertBannerHeader, toggleGrayOut, handleEditorKeyDown, outdentLine, indentLine, applyEditorHighlight } from './tablepicker.js';
import { openPdfLinkModal, insertWebLink } from './pdflink.js';
import { safeStorageSet, safeStorageGet } from './storage.js';

// ── Create annotation (text or box) ──
export async function createAnnotation(pageNum, rects, text, mode_) {
  if (!S.curPDF) return;
  const trueId = S.curPDF.linked_pdf_id || S.curPDF.id;
  const ann = {
    id: 'ann_' + Date.now(),
    pdf_file_id: trueId,
    page: pageNum,
    rects,
    highlighted_text: text,
    hex_color: S.activeColor,
    highlight_mode: mode_,
    notes: [],
  };
  try {
    autosave('saving');
    await dbCreateAnnotation(ann);
    S.annotations.push(ann);
    // Update badge count
    S.annCounts[trueId] = (S.annCounts[trueId] || 0) + 1;
    updateAnnBadge(trueId);
    drawAnnotation(ann);
    autosave('saved');
    toast('Highlight saved');
  } catch (e) {
    autosave('err');
    toast('Save failed — check connection');
  }
}

let activeNoteTab = 'general'; // 'general' | 'case'

export function getNoteType(note) {
  if (!note || !note.note_html) return 'general';
  if (note.note_html.includes('data-note-type="case"') || note.note_html.includes("data-note-type='case'")) {
    return 'case';
  }
  return 'general';
}

export function getNoteBody(note) {
  if (!note || !note.note_html) return '';
  let html = note.note_html;
  const match = html.match(/^<div\s+data-note-type=["'](?:case|general)["'][^>]*>([\s\S]*)<\/div>$/i);
  if (match) html = match[1];

  // Auto-clean any legacy corrupted markup (e.g. copied PDF highlight rects / canvas / hi-grp / absolute elements)
  if (html.includes('class="hr"') || html.includes('class="hi-grp"') || html.includes('class="ann-ov"') || html.includes('class="txt-layer"') || html.includes('position: absolute') || html.includes('position:absolute')) {
    const d = new DOMParser().parseFromString(html, 'text/html');
    d.querySelectorAll('.hi-grp, .hr, .ann-ov, .txt-layer, .draw-canvas, canvas, .srch-ov, #sel-menu, #drag-ghost').forEach(el => el.remove());
    d.querySelectorAll('*').forEach(el => {
      if (el.style.position === 'absolute' || el.style.position === 'fixed') el.remove();
    });
    html = d.body.innerHTML;
  }

  // Ensure tables have containment styling
  if (html.includes('<table') && !html.includes('note-table')) {
    html = html.replace(/<table(?:\s+[^>]*)?>/gi, '<table class="note-table" style="width:100%; max-width:100%; border-collapse:collapse; margin:10px 0; table-layout:auto; word-break:break-word;">');
  }

  return html;
}

export function wrapNoteHtml(html, type) {
  if (type === 'case') {
    return `<div data-note-type="case">${html}</div>`;
  }
  return html;
}

// ── Draw annotation overlay ──
export function drawAnnotation(ann) {
  const pg = S.pages[ann.page]; if (!pg || !pg.rendered || !pg.annOv) return;
  pg.annOv.querySelector(`[data-id="${ann.id}"]`)?.remove();

  const grp = document.createElement('div');
  grp.className  = 'hi-grp';
  grp.dataset.id = ann.id;
  grp.style.opacity = '0.4';
  grp.style.mixBlendMode = 'multiply';

  for (const r of ann.rects) {
    const d = document.createElement('div');
    d.className = 'hr';
    d.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${ann.hex_color};`;
    grp.appendChild(d);
  }
  grp.addEventListener('click', e => { e.stopPropagation(); openAnnPanel(ann); });
  grp.addEventListener('mouseenter', e => {
    const genNotes = ann.notes.filter(n => getNoteType(n) === 'general');
    if (!genNotes.length) return;
    
    let html = '';
    const toShow = Math.min(genNotes.length, 3);
    for (let i = 0; i < toShow; i++) {
      if (i > 0) html += '<div style="border-top: 1px solid rgba(255,255,255,0.15); margin: 6px 0; padding-top: 6px;"></div>';
      html += getNoteBody(genNotes[i]);
    }
    
    if (genNotes.length > 3) {
      html += `<div style="border-top: 1px solid rgba(255,255,255,0.15); margin: 6px 0; padding-top: 6px; font-size: 0.9em; color: #b0aaa0; text-align: center; font-style: italic;">...and ${genNotes.length - 3} more notes (click to view)</div>`;
    } else if (genNotes.length > 1) {
      html += `<div style="border-top: 1px solid rgba(255,255,255,0.15); margin: 6px 0; padding-top: 6px; font-size: 0.9em; color: #b0aaa0; text-align: center; font-style: italic;">(click to manage notes)</div>`;
    }
    
    showTip(e, html);
  });
  grp.addEventListener('mouseleave', hideTip);
  grp.addEventListener('mousemove', moveTip);
  pg.annOv.appendChild(grp);
}

export function redrawAllAnnotations() {
  document.querySelectorAll('.ann-ov .hi-grp').forEach(el => el.remove());
  for (const a of S.annotations) drawAnnotation(a);
}

export function clearAnnMark(id) {
  document.querySelectorAll(`[data-id="${id}"]`).forEach(el => el.remove());
}

// ── Annotation badge helper ──
export function updateAnnBadge(pdfId) {
  document.querySelectorAll(`.li-pdf[data-id="${pdfId}"] .ann-badge`).forEach(b => {
    const count = S.annCounts[pdfId] || 0;
    if (count > 0) { b.textContent = count; b.style.display = ''; }
    else b.style.display = 'none';
  });
}

// ── Tooltip ──
let tip = null;
function showTip(e, html) {
  if (navigator.maxTouchPoints > 0) return;
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'ann-hover-tip note-body';
    tip.style.cssText = 'position:fixed;background:#1a2540;border:1px solid #c9a84c;border-radius:10px;padding:14px 18px;font-size:13.5px;min-width:260px;width:max-content;max-width:min(520px,85vw);max-height:80vh;overflow-y:auto;line-height:1.6;z-index:700;pointer-events:none;color:#e8e4db;box-shadow:0 8px 28px rgba(0,0,0,.5);word-break:break-word;';
    document.body.appendChild(tip);
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  moveTip(e);
}
function moveTip(e) {
  if (!tip) return;
  const pad = 12;
  const w = tip.offsetWidth || 420;
  const h = tip.offsetHeight || 160;
  let x = e.clientX + 14;
  let y = e.clientY - 10;
  if (x + w + pad > window.innerWidth) {
    x = Math.max(pad, e.clientX - w - 14);
  }
  if (y + h + pad > window.innerHeight) {
    y = Math.max(pad, window.innerHeight - h - pad);
  }
  if (y < pad) y = pad;
  tip.style.left = x + 'px';
  tip.style.top  = y + 'px';
}
function hideTip() { if (tip) tip.style.display = 'none'; }

// ── Annotation Panel ──
export function openAnnPanel(ann) {
  S.selAnn = ann;
  document.querySelectorAll('.hi-grp').forEach(g => g.classList.remove('selected'));
  document.querySelector(`[data-id="${ann.id}"]`)?.classList.add('selected');
  document.getElementById('ap-ex').textContent =
    ann.highlighted_text.length > 90 ? ann.highlighted_text.slice(0, 90) + '…' : ann.highlighted_text;
  renderAnnColors();
  renderNotes(ann);
  document.getElementById('note-editor').innerHTML = '';
  closeOtherPanels('ann-panel');
  document.getElementById('ann-panel').classList.add('open');
}

export function closeAnnPanel() {
  document.getElementById('ann-panel').classList.remove('open');
  document.querySelectorAll('.hi-grp').forEach(g => g.classList.remove('selected'));
  S.selAnn = null;
}

function renderAnnColors() {
  const c = document.getElementById('ap-colors');
  c.innerHTML = '<div class="ap-colors-lbl">Highlight Color</div>';
  for (const cat of S.colorCats) {
    const d = document.createElement('div');
    d.className = 'apc-dot' + (S.selAnn?.hex_color === cat.hex_color ? ' sel' : '');
    d.style.background = cat.hex_color;
    d.title = cat.name;
    d.addEventListener('click', async () => {
      const targetAnn = S.selAnn;
      if (!targetAnn) return;
      autosave('saving');
      try {
        targetAnn.hex_color = cat.hex_color;
        clearAnnMark(targetAnn.id);
        drawAnnotation(targetAnn);
        renderAnnColors();
        await dbUpdateAnnColor(targetAnn.id, cat.hex_color);
        autosave('saved');
        toast('Color updated');
      } catch (e) {
        console.error(e);
        autosave('err');
      }
    });
    c.appendChild(d);
  }
}

function updateTabBadges(ann) {
  if (!ann) return;
  const genCount = ann.notes.filter(n => getNoteType(n) === 'general').length;
  const caseCount = ann.notes.filter(n => getNoteType(n) === 'case').length;
  const bgGen = document.getElementById('badge-general');
  const bgCase = document.getElementById('badge-case');
  if (bgGen) bgGen.textContent = genCount;
  if (bgCase) bgCase.textContent = caseCount;
}

function updateEditorState() {
  const ed = document.getElementById('note-editor');
  const addBtn = document.getElementById('btn-add-note');
  if (activeNoteTab === 'case') {
    if (ed) ed.setAttribute('data-ph', 'Case Title / G.R. No. (e.g. Laurel v. Garcia), Ruling, Ratio…');
    if (addBtn) addBtn.textContent = 'Add Case Summary';
  } else {
    if (ed) ed.setAttribute('data-ph', 'Add a note, doctrine, citation…');
    if (addBtn) addBtn.textContent = 'Add Note';
  }
}

function renderNotes(ann) {
  if (!ann) return;
  const list = document.getElementById('ann-notes');
  if (!list) return;
  list.innerHTML = '';
  updateTabBadges(ann);
  updateEditorState();

  const filtered = ann.notes.filter(n => getNoteType(n) === activeNoteTab);

  if (!filtered.length) {
    const emptyMsg = activeNoteTab === 'case'
      ? 'No case summaries yet — add a case digest or ruling below.'
      : 'No notes yet — add one below.';
    list.innerHTML = `<div class="note-empty">${emptyMsg}</div>`;
    return;
  }

  filtered.forEach((note, i) => {
    const card = document.createElement('div');
    const isCase = activeNoteTab === 'case';
    card.className = 'note-card' + (isCase ? ' case-card' : '');
    
    const cardTitle = isCase ? `⚖️ Case Summary ${i + 1}` : `📝 Note ${i + 1}`;
    const cleanBody = getNoteBody(note);

    card.innerHTML = `
      <div class="note-card-header">
        <div class="note-num">${cardTitle}</div>
        <div class="note-actions">
          <button class="note-act-btn edit-btn" title="Edit Note">✏ Edit</button>
          <button class="note-act-btn del" title="Delete Note">🗑 Delete</button>
        </div>
      </div>
      <div class="note-body">${cleanBody}</div>
    `;
    
    // Intercept PDF links
    card.querySelectorAll('[data-pdf-link]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const pdfId = link.getAttribute('data-pdf-link');
        const pdf = S.pdfs.find(p => p.id === pdfId);
        if (pdf) {
          import('./viewer.js').then(m => m.openPDFFromLibrary(pdf));
        } else {
          import('./ui.js').then(m => m.toast('PDF not found or deleted'));
        }
      });
    });

    card.querySelector('.note-act-btn.edit-btn').addEventListener('click', () => {
      S.editingNoteId = note.id;
      const modalTitle = document.getElementById('mo-edit-note-title');
      if (modalTitle) modalTitle.textContent = isCase ? 'Edit Case Summary' : 'Edit Note';
      document.getElementById('edit-note-ed').innerHTML = cleanBody;
      import('./ui.js').then(m => m.openModal('mo-edit-note'));
    });

    card.querySelector('.note-act-btn.del').addEventListener('click', async () => {
      autosave('saving');
      try {
        ann.notes = ann.notes.filter(n => n.id !== note.id);
        const trueId = ann.pdf_file_id;
        if (trueId) safeStorageSet('local_anns_' + trueId, JSON.stringify(S.annotations));
        renderNotes(ann);
        await dbDelNote(note.id);
        autosave('saved');
        import('./ui.js').then(m => m.toast(isCase ? 'Case summary deleted' : 'Note deleted'));
      } catch (e) {
        console.error(e);
        autosave('err');
      }
    });

    list.appendChild(card);
  });
}

// ── Wire annotation panel buttons ──
export function initAnnPanel() {
  document.getElementById('ap-close').addEventListener('click', closeAnnPanel);

  // Tab switching
  document.querySelectorAll('.ap-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeNoteTab = btn.dataset.aptab;
      document.querySelectorAll('.ap-tab').forEach(b => b.classList.toggle('active', b === btn));
      if (S.selAnn) renderNotes(S.selAnn);
      else updateEditorState();
    });
  });

  document.getElementById('btn-del-hi').addEventListener('click', async () => {
    const targetAnn = S.selAnn;
    if (!targetAnn) return;
    autosave('saving');
    try {
      S.annotations = S.annotations.filter(x => x.id !== targetAnn.id);
      const trueId = targetAnn.pdf_file_id;
      if (trueId) {
        S.annCounts[trueId] = Math.max(0, (S.annCounts[trueId] || 1) - 1);
        updateAnnBadge(trueId);
      }
      clearAnnMark(targetAnn.id);
      closeAnnPanel();
      await dbDelAnnotation(targetAnn.id);
      autosave('saved');
      toast('Highlight deleted');
    } catch (e) {
      console.error(e);
      autosave('err');
    }
  });

  // Add note / Case summary — with empty-editor shake (fixes bug #5)
  document.getElementById('btn-add-note').addEventListener('click', async () => {
    const ed = document.getElementById('note-editor');
    const rawHtml = ed.innerHTML.trim();
    const targetAnn = S.selAnn;
    if (!rawHtml || rawHtml === '<br>' || !targetAnn) {
      ed.classList.remove('shake');
      void ed.offsetWidth; // reflow to restart animation
      ed.classList.add('shake');
      return;
    }
    const savedTab = activeNoteTab;
    const htmlToSave = wrapNoteHtml(rawHtml, savedTab);
    autosave('saving');
    try {
      const note = await dbCreateNote(targetAnn.id, htmlToSave, targetAnn.notes.length);
      targetAnn.notes.push(note);
      const trueId = targetAnn.pdf_file_id;
      if (trueId) {
        safeStorageSet('local_anns_' + trueId, JSON.stringify(S.annotations));
      }
      ed.innerHTML = '';
      if (S.selAnn?.id === targetAnn.id) renderNotes(targetAnn);
      autosave('saved');
      toast(savedTab === 'case' ? 'Case summary added' : 'Note added');
    } catch (e) {
      console.error(e);
      autosave('err');
    }
  });

  // Save edited note / Case summary
  document.getElementById('save-edit-note').addEventListener('click', async () => {
    const rawHtml = document.getElementById('edit-note-ed').innerHTML.trim();
    if (!rawHtml) return;
    let targetAnn = S.selAnn;
    let note = targetAnn?.notes.find(n => n.id === S.editingNoteId);
    if (!note && S.editingNoteId) {
      for (const a of (S.annotations || [])) {
        const found = a.notes?.find(n => n.id === S.editingNoteId);
        if (found) { targetAnn = a; note = found; break; }
      }
    }
    const noteType = getNoteType(note);
    const htmlToSave = wrapNoteHtml(rawHtml, noteType);
    autosave('saving');
    try {
      if (note) {
        note.note_html = htmlToSave;
        const trueId = targetAnn?.pdf_file_id;
        if (trueId) {
          safeStorageSet('local_anns_' + trueId, JSON.stringify(S.annotations));
        }
        if (S.selAnn?.id === targetAnn?.id) renderNotes(targetAnn);
      }
      closeModal('mo-edit-note');
      await dbUpdateNote(S.editingNoteId, htmlToSave);
      autosave('saved');
      toast(noteType === 'case' ? 'Case summary updated' : 'Note updated');
    } catch (e) {
      console.error(e);
      autosave('err');
    }
  });

  // Format buttons (add-note editor)
  document.querySelectorAll('#add-note-area .fmt-btn').forEach(b => {
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => {
      const ed = document.getElementById('note-editor');
      if (!ed) return;

      const cmd = b.dataset.cmd;
      let val = b.dataset.val || null;
      if (cmd === 'formatBlock' && val && !val.startsWith('<')) {
        val = `<${val}>`;
      }

      if (cmd === 'insertTable') {
        showTablePicker(b, ed);
      } else if (cmd === 'insertBanner') {
        insertBannerHeader(ed);
      } else if (cmd === 'grayOut') {
        toggleGrayOut(ed);
      } else if (cmd === 'outdent') {
        outdentLine(ed);
      } else if (cmd === 'indent') {
        indentLine(ed);
      } else if (b.id === 'btn-add-pdflink') {
        openPdfLinkModal(ed);
      } else if (b.id === 'btn-add-weblink') {
        insertWebLink(ed);
      } else if (cmd) {
        ed.focus();
        document.execCommand(cmd, false, val);
      }
    });
  });

  // Format buttons (edit-note editor)
  document.querySelectorAll('#mo-edit-note .fmt-btn').forEach(b => {
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => {
      const ed = document.getElementById('edit-note-ed');
      if (!ed) return;

      const cmd = b.dataset.cmd2;
      let val = b.dataset.val2 || null;
      if (cmd === 'formatBlock' && val && !val.startsWith('<')) {
        val = `<${val}>`;
      }

      if (cmd === 'insertTable') {
        showTablePicker(b, ed);
      } else if (cmd === 'insertBanner') {
        insertBannerHeader(ed);
      } else if (cmd === 'grayOut') {
        toggleGrayOut(ed);
      } else if (cmd === 'outdent') {
        outdentLine(ed);
      } else if (cmd === 'indent') {
        indentLine(ed);
      } else if (b.id === 'btn-edit-pdflink') {
        openPdfLinkModal(ed);
      } else if (b.id === 'btn-edit-weblink') {
        insertWebLink(ed);
      } else if (cmd) {
        ed.focus();
        document.execCommand(cmd, false, val);
      }
    });
  });

  // Attach sanitized paste handling to note editors
  document.getElementById('note-editor')?.addEventListener('paste', handlePaste);
  document.getElementById('edit-note-ed')?.addEventListener('paste', handlePaste);

  document.getElementById('edit-note-ed')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      document.getElementById('save-edit-note')?.click();
      return;
    }
    handleEditorKeyDown(e, document.getElementById('edit-note-ed'));
  });

  // Selection confirm/cancel (works for both PDF text and folder/notepad editors)
  document.getElementById('sel-confirm').addEventListener('mousedown', e => e.preventDefault());
  document.getElementById('sel-confirm').addEventListener('click', () => {
    if (S.pendingEditorSel) {
      const { editor, range } = S.pendingEditorSel;
      document.getElementById('sel-menu').classList.remove('open');
      applyEditorHighlight(editor, range, S.activeColor || '#c9a84c');
      S.pendingEditorSel = null;
      window.getSelection()?.removeAllRanges();
      return;
    }
    if (!S.pendingSel) return;
    window.getSelection()?.removeAllRanges();
    document.getElementById('sel-menu').classList.remove('open');
    createAnnotation(S.pendingSel.pageNum, S.pendingSel.rects, S.pendingSel.text, 'text');
    S.pendingSel = null;
  });
  document.getElementById('sel-cancel').addEventListener('click', () => {
    window.getSelection()?.removeAllRanges();
    document.getElementById('sel-menu').classList.remove('open');
    S.pendingSel = null;
    S.pendingEditorSel = null;
  });

  // Auto-close selection menu when clicking outside
  document.addEventListener('mousedown', e => {
    const selMenu = document.getElementById('sel-menu');
    if ((S.pendingSel || S.pendingEditorSel) && selMenu.classList.contains('open')) {
      if (!selMenu.contains(e.target)) {
        selMenu.classList.remove('open');
        S.pendingSel = null;
        S.pendingEditorSel = null;
      }
    }
  });

  initAnnPanelResizer();
}

function initAnnPanelResizer() {
  const panel = document.getElementById('ann-panel');
  const handle = document.getElementById('ap-resize-handle');
  if (!handle || !panel) return;

  // Restore saved width from localStorage
  const savedWidth = safeStorageGet('ann_panel_width');
  if (savedWidth) {
    const w = parseInt(savedWidth);
    if (w >= 260 && w <= window.innerWidth * 0.85) {
      panel.style.width = w + 'px';
    }
  }

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('resizing');
    panel.style.transition = 'none'; // disable CSS transition while dragging for instant responsiveness
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  });

  handle.addEventListener('pointermove', (e) => {
    if (!isResizing) return;
    const deltaX = startX - e.clientX; // dragging left increases width
    const minW = 260;
    const maxW = Math.floor(window.innerWidth * 0.85);
    const newWidth = Math.max(minW, Math.min(maxW, startWidth + deltaX));
    panel.style.width = newWidth + 'px';
  });

  const stopResize = (e) => {
    if (!isResizing) return;
    isResizing = false;
    handle.classList.remove('resizing');
    panel.style.transition = '';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {}
    safeStorageSet('ann_panel_width', panel.offsetWidth);
  };

  handle.addEventListener('pointerup', stopResize);
  handle.addEventListener('pointercancel', stopResize);
}
