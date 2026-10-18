// ═══════════════════════════════════════════════
// PDF LINK — Universal PDF and Web Linking for All Editors
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { openModal, closeModal, toast } from './ui.js';
import { openPDFFromLibrary } from './viewer.js';

let _savedRange = null;
let _activeEditor = null;
let _onDoneCallback = null;

export function openPdfLinkModal(editorEl, onDone) {
  _activeEditor = typeof editorEl === 'string' ? document.getElementById(editorEl) : editorEl;
  _onDoneCallback = onDone;
  
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    _savedRange = sel.getRangeAt(0).cloneRange();
  } else {
    _savedRange = null;
  }
  
  openModal('mo-pdf-link');
  renderPdfLinkList();
  
  // Focus search input
  setTimeout(() => {
    const inp = document.getElementById('pdf-link-search');
    if (inp) {
      inp.value = '';
      inp.focus();
    }
  }, 50);
}

export function insertWebLink(editorEl, onDone) {
  const ed = typeof editorEl === 'string' ? document.getElementById(editorEl) : editorEl;
  if (!ed) return;

  const sel = window.getSelection();
  let range = null;
  let defaultText = '';
  if (sel && sel.rangeCount > 0) {
    range = sel.getRangeAt(0);
    defaultText = range.toString().trim();
  }

  const url = prompt('Enter Web URL (e.g. https://lawphil.net/...):', 'https://');
  if (!url || url.trim() === '' || url.trim() === 'https://') return;

  let cleanUrl = url.trim();
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    cleanUrl = 'https://' + cleanUrl;
  }

  const linkText = defaultText || prompt('Enter text for this link:', cleanUrl) || cleanUrl;

  ed.focus();
  if (range) {
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const html = `<a href="${cleanUrl}" target="_blank" rel="noopener" style="color:var(--gold);text-decoration:underline;cursor:pointer;font-weight:500;">${linkText}</a>&nbsp;`;
  document.execCommand('insertHTML', false, html);
  if (onDone) onDone();
}

export function renderPdfLinkList() {
  const list = document.getElementById('pdf-link-list');
  const search = document.getElementById('pdf-link-search')?.value.toLowerCase() || '';
  if (!list) return;

  list.innerHTML = '';
  const filtered = (S.pdfs || []).filter(p => p.name.toLowerCase().includes(search));

  if (filtered.length === 0) {
    list.innerHTML = '<div style="color:var(--muted);padding:14px;text-align:center;font-size:12px">No PDFs found.</div>';
    return;
  }

  filtered.forEach(pdf => {
    const div = document.createElement('div');
    div.style.cssText = 'padding:9px 12px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,0.05); transition:all .15s; border-radius:4px; font-size:13px; color:#e8e4db; display:flex; align-items:center; gap:8px;';
    div.innerHTML = `<span>📄</span><span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${pdf.name}">${pdf.name}</span>`;

    div.addEventListener('mouseover', () => {
      div.style.background = 'rgba(255,255,255,0.08)';
      div.style.color = 'var(--gold)';
    });
    div.addEventListener('mouseout', () => {
      div.style.background = '';
      div.style.color = '#e8e4db';
    });

    div.addEventListener('click', () => {
      closeModal('mo-pdf-link');
      if (_activeEditor) {
        _activeEditor.focus();
        const sel = window.getSelection();
        let linkText = '📄 ' + pdf.name;

        if (_savedRange) {
          try {
            sel.removeAllRanges();
            sel.addRange(_savedRange);
            const selectedText = _savedRange.toString().trim();
            if (selectedText.length > 0) {
              linkText = selectedText;
            }
          } catch {}
        }

        const html = `<a href="#" data-pdf-link="${pdf.id}" contenteditable="false" style="color:var(--gold);text-decoration:underline;cursor:pointer;font-weight:500;">${linkText}</a>&nbsp;`;
        document.execCommand('insertHTML', false, html);
        if (_onDoneCallback) _onDoneCallback();
      }
    });
    list.appendChild(div);
  });
}

// Global delegated handler for clicking any PDF link in any editor or panel
export function initGlobalPdfLinks() {
  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-pdf-link]');
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();

    const pdfId = link.getAttribute('data-pdf-link');
    const pdf = (S.pdfs || []).find(p => p.id === pdfId || p.linked_pdf_id === pdfId);
    if (pdf) {
      openPDFFromLibrary(pdf);
    } else {
      toast('Linked PDF not found or deleted from library');
    }
  });

  const searchInp = document.getElementById('pdf-link-search');
  if (searchInp) {
    searchInp.addEventListener('input', renderPdfLinkList);
  }
}
