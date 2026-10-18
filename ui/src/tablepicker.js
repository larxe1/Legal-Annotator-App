import { openModal, toast } from './ui.js';
import { S } from './state.js';

export function showTablePicker(btn, editorElement) {
  let picker = document.getElementById('table-picker');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'table-picker';
    picker.style.cssText = 'position:absolute; z-index:1000; background:var(--navy-l); border:1px solid var(--navy-b); padding:12px; border-radius:6px; box-shadow:0 4px 16px rgba(0,0,0,0.6); display:flex; flex-direction:column; gap:8px;';
    
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid; grid-template-columns:repeat(10, 16px); gap:3px;';
    
    // Prevent focus loss on editor when clicking the picker
    picker.addEventListener('mousedown', e => e.preventDefault());
    
    const lbl = document.createElement('div');
    lbl.id = 'tp-label';
    lbl.style.cssText = 'text-align:center; font-size:13px; color:#e8e4db; font-family:monospace; margin-top:4px; font-weight:bold;';
    lbl.textContent = '0 x 0';

    // create 10x10 cells
    for (let r = 1; r <= 10; r++) {
      for (let c = 1; c <= 10; c++) {
        const cell = document.createElement('div');
        cell.className = 'tp-cell';
        cell.dataset.r = r;
        cell.dataset.c = c;
        cell.style.cssText = 'width:16px; height:16px; border:1px solid var(--navy-b); border-radius:2px; cursor:pointer; background:transparent; box-sizing:border-box; transition:none;';
        grid.appendChild(cell);
        
        cell.addEventListener('mouseenter', () => {
          lbl.textContent = `${c} x ${r}`;
          // highlight cells
          Array.from(grid.children).forEach(child => {
            const cr = parseInt(child.dataset.r);
            const cc = parseInt(child.dataset.c);
            if (cr <= r && cc <= c) {
              child.style.background = 'rgba(201, 168, 76, 0.3)';
              child.style.borderColor = 'var(--gold)';
            } else {
              child.style.background = 'transparent';
              child.style.borderColor = 'var(--navy-b)';
            }
          });
        });
        
        cell.addEventListener('click', (e) => {
          e.stopPropagation();
          picker.style.display = 'none';
          insertTable(r, c, editorElement);
        });
      }
    }
    
    picker.appendChild(grid);
    picker.appendChild(lbl);
    document.body.appendChild(picker);
    
    // Close on click outside
    document.addEventListener('click', (e) => {
      if (!picker.contains(e.target) && !e.target.closest('[data-cmd="insertTable"]')) {
        picker.style.display = 'none';
      }
    });
  }
  
  // If already open and clicking the same button, toggle off
  if (picker.style.display === 'flex' && picker.dataset.activeBtn === btn.id) {
    picker.style.display = 'none';
    return;
  }

  // Position picker
  const rect = btn.getBoundingClientRect();
  picker.style.left = rect.left + 'px';
  picker.style.top = (rect.bottom + 6) + 'px';
  picker.style.display = 'flex';
  picker.dataset.activeBtn = btn.id || 'btn-table';
  
  // reset styles
  picker.querySelectorAll('.tp-cell').forEach(c => {
    c.style.background = 'transparent';
    c.style.borderColor = 'var(--navy-b)';
  });
  document.getElementById('tp-label').textContent = '0 x 0';
}

function insertTable(rows, cols, editorElement) {
  // Construct the HTML for the table with strict bounds containment
  let html = `<br><table class="note-table" style="width:100%; max-width:100%; border-collapse:collapse; margin:10px 0; table-layout:auto; word-break:break-word;"><tbody>`;
  for (let r = 0; r < rows; r++) {
    html += `<tr>`;
    for (let c = 0; c < cols; c++) {
      html += `<td style="border:1px solid var(--navy-b); padding:6px 10px; word-break:break-word; overflow-wrap:anywhere;"><br></td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table><br>`;
  
  editorElement.focus();
  document.execCommand('insertHTML', false, html);
  editorElement.dispatchEvent(new Event('input', { bubbles: true }));
}

// ───────────────────────────────────────────────
// PASTE SANITIZER & TABLE IMPORTER
// ───────────────────────────────────────────────
function parseTextToTable(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.length > 0);
  if (lines.length < 2) return null;

  let rows = [];
  const hasTabs = lines.some(l => l.includes('\t'));

  if (hasTabs) {
    rows = lines.map(l => l.split('\t').map(c => c.trim()));
  } else {
    // Check if lines have markdown | separators
    const isMarkdownTable = lines.some(l => l.includes('|'));
    if (isMarkdownTable) {
      rows = lines
        .filter(l => !l.match(/^[\s|:-]+$/)) // Skip markdown divider like |---|---|
        .map(l => l.split('|').map(c => c.trim()).filter((c, idx, arr) => {
          return (idx > 0 && idx < arr.length - 1) || (idx === 0 && c !== '') || (idx === arr.length - 1 && c !== '');
        }));
    } else {
      // Check for 2+ consecutive spaces (standard PDF table column spacing)
      const candidateRows = lines.map(l => l.split(/\s{2,}/).map(c => c.trim()));
      const colCounts = candidateRows.map(r => r.length);
      const isMultiCol = colCounts.length >= 2 && colCounts[0] >= 2 && colCounts.every(c => c === colCounts[0] || c === colCounts[0] - 1);
      if (isMultiCol) {
        rows = candidateRows;
      }
    }
  }

  // Must have at least 2 rows and 2 columns
  if (rows.length >= 2 && rows[0].length >= 2) {
    let html = `<br><table class="note-table" style="width:100%; max-width:100%; border-collapse:collapse; margin:10px 0; table-layout:auto; word-break:break-word;"><tbody>`;
    for (let r = 0; r < rows.length; r++) {
      html += `<tr>`;
      for (let c = 0; c < rows[r].length; c++) {
        const cellText = rows[r][c] || '';
        const tag = r === 0 ? 'th' : 'td';
        const style = r === 0
          ? 'border:1px solid var(--navy-b); padding:6px 10px; background:rgba(255,255,255,0.06); font-weight:bold; word-break:break-word; overflow-wrap:anywhere;'
          : 'border:1px solid var(--navy-b); padding:6px 10px; word-break:break-word; overflow-wrap:anywhere;';
        html += `<${tag} style="${style}">${cellText ? cellText.replace(/\n/g, '<br>') : '<br>'}</${tag}>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table><br>`;
    return html;
  }
  return null;
}

function parseTextToList(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return null;
  
  const bulletPattern = /^[\s]*[•\-\*]\s+(.*)$/;
  const numberedPattern = /^[\s]*\d+[\.\)]\s+(.*)$/;

  const hasBullets = lines.length >= 2 && lines.every(l => bulletPattern.test(l));
  const hasNumbered = lines.length >= 2 && lines.every(l => numberedPattern.test(l));

  if (hasBullets) {
    return `<ul style="margin:6px 0; padding-left:24px;">` + lines.map(l => {
      const m = l.match(bulletPattern);
      return `<li>${m ? m[1] : l}</li>`;
    }).join('') + `</ul>`;
  }
  if (hasNumbered) {
    return `<ol style="margin:6px 0; padding-left:24px;">` + lines.map(l => {
      const m = l.match(numberedPattern);
      return `<li>${m ? m[1] : l}</li>`;
    }).join('') + `</ol>`;
  }
  return null;
}

export function handlePaste(e) {
  const html = e.clipboardData.getData('text/html');
  const text = e.clipboardData.getData('text/plain');
  const targetEl = e.currentTarget || document.activeElement;
  
  // If plain text represents a tabular copy or bullet list
  if (!html && text) {
    const tableHtml = parseTextToTable(text);
    if (tableHtml) {
      e.preventDefault();
      document.execCommand('insertHTML', false, tableHtml);
      targetEl?.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const listHtml = parseTextToList(text);
    if (listHtml) {
      e.preventDefault();
      document.execCommand('insertHTML', false, listHtml);
      targetEl?.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    return; // Allow native plain text paste
  }
  
  if (!html) return;
  
  e.preventDefault();
  
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Strip all PDF viewer overlay elements (highlights, text layer absolute positioning, canvas, etc.)
  doc.querySelectorAll('.ann-ov, .hi-grp, .hr, .draw-canvas, canvas, .srch-ov, #sel-menu, #drag-ghost, .pg-placeholder').forEach(el => el.remove());

  const hasHtmlTable = doc.querySelector('table');

  if (!hasHtmlTable && text) {
    const tableFromText = parseTextToTable(text);
    if (tableFromText) {
      document.execCommand('insertHTML', false, tableFromText);
      targetEl?.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
  }

  function cleanNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    
    // Skip any overlay or ghost element
    if (node.matches && node.matches('.ann-ov, .hi-grp, .hr, .draw-canvas, canvas, .srch-ov, #sel-menu, #drag-ghost, .pg-placeholder')) {
      return '';
    }

    let inner = '';
    node.childNodes.forEach(c => inner += cleanNode(c));
    if (!inner && !['br', 'hr', 'td', 'th', 'li'].includes(node.tagName.toLowerCase())) return '';

    const tag = node.tagName.toLowerCase();
    const style = node.style || {};
    const fontWeight = (style.fontWeight || '').toLowerCase();
    const fontStyle = (style.fontStyle || '').toLowerCase();
    const textDeco = (style.textDecoration || '').toLowerCase();
    
    // Google Docs wraps all clipboard HTML in <b style="font-weight:normal;" id="docs-internal-guid-...">
    const isGoogleDocsWrapper = node.id?.startsWith('docs-internal-guid') || (tag === 'b' && (fontWeight === 'normal' || fontWeight === '400' || fontWeight === 'lighter'));

    // Determine semantic formatting
    const isBold = (['b', 'strong'].includes(tag) && !isGoogleDocsWrapper && fontWeight !== 'normal' && fontWeight !== '400' && fontWeight !== 'lighter') ||
                   (fontWeight === 'bold' || fontWeight === '700' || fontWeight === '800' || fontWeight === '900' || parseInt(fontWeight) >= 600);
    const isItalic = (['i', 'em'].includes(tag) && fontStyle !== 'normal') || fontStyle === 'italic';
    const isUnderline = (tag === 'u' && !textDeco.includes('none')) || textDeco.includes('underline');
    const isStrike = ['s', 'strike'].includes(tag) || textDeco.includes('line-through');

    // Apply inline formats in clean order
    if (isStrike) inner = `<s>${inner}</s>`;
    if (isUnderline) inner = `<u>${inner}</u>`;
    if (isItalic) inner = `<i>${inner}</i>`;
    if (isBold) inner = `<b>${inner}</b>`;

    if (tag === 'sup') return `<sup>${inner}</sup>`;
    if (tag === 'sub') return `<sub>${inner}</sub>`;

    if (tag === 'a') {
      const href = node.getAttribute('href') || '#';
      if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:') || href.startsWith('#')) {
        return `<a href="${href}" target="_blank" rel="noopener">${inner}</a>`;
      }
      return inner;
    }

    if (tag === 'span') {
      return inner;
    }
    
    // Preserve lists
    if (['ul', 'ol'].includes(tag)) {
      return `<${tag} style="margin:6px 0; padding-left:24px;">${inner}</${tag}>`;
    }
    if (tag === 'li') {
      return `<li>${inner || '<br>'}</li>`;
    }

    // Preserve headings
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
      return `<${tag} style="margin:8px 0 4px;">${inner}</${tag}>`;
    }

    // Preserve blockquotes
    if (tag === 'blockquote') {
      return `<blockquote style="border-left:3px solid var(--gold); margin:8px 0; padding-left:10px; color:var(--text-d);">${inner}</blockquote>`;
    }

    // Preserve tables with strict containment
    if (tag === 'table') {
      return `<table class="note-table" style="width:100%; max-width:100%; border-collapse:collapse; margin:10px 0; table-layout:auto; word-break:break-word;">${inner}</table>`;
    }
    if (['tbody', 'thead', 'tfoot'].includes(tag)) {
      return `<${tag}>${inner}</${tag}>`;
    }
    if (tag === 'tr') {
      return `<tr>${inner}</tr>`;
    }
    if (tag === 'th') {
      const colspan = node.getAttribute('colspan') ? ` colspan="${node.getAttribute('colspan')}"` : '';
      const rowspan = node.getAttribute('rowspan') ? ` rowspan="${node.getAttribute('rowspan')}"` : '';
      return `<th style="border:1px solid var(--navy-b); padding:6px 10px; background:rgba(255,255,255,0.06); font-weight:bold; word-break:break-word; overflow-wrap:anywhere;"${colspan}${rowspan}>${inner || '<br>'}</th>`;
    }
    if (tag === 'td') {
      const colspan = node.getAttribute('colspan') ? ` colspan="${node.getAttribute('colspan')}"` : '';
      const rowspan = node.getAttribute('rowspan') ? ` rowspan="${node.getAttribute('rowspan')}"` : '';
      return `<td style="border:1px solid var(--navy-b); padding:6px 10px; word-break:break-word; overflow-wrap:anywhere;"${colspan}${rowspan}>${inner || '<br>'}</td>`;
    }
    
    // Convert block elements to line breaks
    if (['p', 'div'].includes(tag)) {
      return inner ? `${inner}<br>` : '<br>';
    }
    if (tag === 'br') {
      return '<br>';
    }
    
    return inner;
  }
  
  let cleanHtml = cleanNode(doc.body);
  cleanHtml = cleanHtml.replace(/(?:<br\s*\/?>\s*)+$/i, '');
  document.execCommand('insertHTML', false, cleanHtml || text.replace(/\n/g, '<br>'));
  targetEl?.dispatchEvent(new Event('input', { bubbles: true }));
}

// ───────────────────────────────────────────────
// TABLE CONTEXT MENU
// ───────────────────────────────────────────────
let activeTableCell = null;

export function initTableContextMenu() {
  const ctxMenu = document.getElementById('table-ctx-menu');
  if (!ctxMenu) return;

  // Listen for right-clicks anywhere in the document
  document.addEventListener('contextmenu', (e) => {
    const table = e.target.closest('table');
    const inLightbox = e.target.closest('#table-lb-viewport');
    
    if (table && !inLightbox) {
      e.preventDefault();
      const td = e.target.closest('td, th') || table.querySelector('td, th');
      activeTableCell = td;
      
      const isEditable = Boolean(table.closest('[contenteditable="true"]'));
      
      // If table is in a read-only note card, hide cell modification tools
      const editItems = ctxMenu.querySelectorAll('#ctx-row-above, #ctx-row-below, #ctx-col-left, #ctx-col-right, #ctx-del-row, #ctx-del-col, #ctx-del-table');
      editItems.forEach(item => {
        item.style.display = isEditable ? 'block' : 'none';
      });
      ctxMenu.querySelectorAll('div[style*="height:1px"]').forEach(sep => {
        sep.style.display = isEditable ? 'block' : 'none';
      });
      
      ctxMenu.style.display = 'flex';
      
      // Keep menu on screen
      let x = e.pageX;
      let y = e.pageY;
      
      requestAnimationFrame(() => {
        const mw = ctxMenu.offsetWidth;
        const mh = ctxMenu.offsetHeight;
        if (x + mw > window.innerWidth) x = window.innerWidth - mw - 10;
        if (y + mh > window.innerHeight) y = window.innerHeight - mh - 10;
        
        ctxMenu.style.left = x + 'px';
        ctxMenu.style.top = y + 'px';
      });
    } else {
      ctxMenu.style.display = 'none';
      activeTableCell = null;
    }
  });

  document.addEventListener('click', () => {
    ctxMenu.style.display = 'none';
  });

  // Bind actions
  document.getElementById('ctx-expand-table')?.addEventListener('click', () => {
    if (activeTableCell) {
      const table = activeTableCell.closest('table');
      if (table) openTableLightbox(table);
    }
  });
  document.getElementById('ctx-export-csv')?.addEventListener('click', () => {
    if (activeTableCell) {
      const table = activeTableCell.closest('table');
      if (table) exportTableCSV(table);
    }
  });
  document.getElementById('ctx-row-above')?.addEventListener('click', () => modifyTable('row-above'));
  document.getElementById('ctx-row-below')?.addEventListener('click', () => modifyTable('row-below'));
  document.getElementById('ctx-col-left')?.addEventListener('click', () => modifyTable('col-left'));
  document.getElementById('ctx-col-right')?.addEventListener('click', () => modifyTable('col-right'));
  document.getElementById('ctx-del-row')?.addEventListener('click', () => modifyTable('del-row'));
  document.getElementById('ctx-del-col')?.addEventListener('click', () => modifyTable('del-col'));
  document.getElementById('ctx-del-table')?.addEventListener('click', () => modifyTable('del-table'));
}

function modifyTable(action) {
  if (!activeTableCell) return;
  const tr = activeTableCell.closest('tr');
  const tbody = activeTableCell.closest('tbody') || activeTableCell.closest('table');
  const table = activeTableCell.closest('table');
  if (!tr || !tbody || !table) return;

  const cellIndex = activeTableCell.cellIndex;
  const rowIndex = Array.from(tbody.children).indexOf(tr);

  // Helper to trigger an input event so the editor saves
  const triggerSave = () => {
    const editor = table.closest('[contenteditable="true"]');
    if (editor) editor.dispatchEvent(new Event('input', { bubbles: true }));
  };

  if (action === 'row-above' || action === 'row-below') {
    const newRow = tbody.insertRow(action === 'row-above' ? rowIndex : rowIndex + 1);
    const cols = tr.children.length;
    for (let i = 0; i < cols; i++) {
      const td = newRow.insertCell(i);
      td.style.border = '1px solid var(--navy-b)';
      td.style.padding = '6px 10px';
      td.style.wordBreak = 'break-word';
      td.style.overflowWrap = 'anywhere';
      td.innerHTML = '<br>';
    }
    triggerSave();
  } 
  else if (action === 'col-left' || action === 'col-right') {
    const targetIdx = action === 'col-left' ? cellIndex : cellIndex + 1;
    Array.from(tbody.children).forEach(row => {
      const td = row.insertCell(targetIdx);
      td.style.border = '1px solid var(--navy-b)';
      td.style.padding = '6px 10px';
      td.style.wordBreak = 'break-word';
      td.style.overflowWrap = 'anywhere';
      td.innerHTML = '<br>';
    });
    triggerSave();
  }
  else if (action === 'del-row') {
    tbody.deleteRow(rowIndex);
    if (tbody.children.length === 0) table.remove();
    triggerSave();
  }
  else if (action === 'del-col') {
    Array.from(tbody.children).forEach(row => {
      if (row.children[cellIndex]) row.deleteCell(cellIndex);
    });
    // If table is empty
    if (tbody.children[0] && tbody.children[0].children.length === 0) table.remove();
    triggerSave();
  }
  else if (action === 'del-table') {
    table.remove();
    triggerSave();
  }
}

// ───────────────────────────────────────────────
// FULL-SCREEN EXPANDED TABLE VIEWER (LIGHTBOX)
// ───────────────────────────────────────────────
let _currentLightboxTable = null;

export function openTableLightbox(tableEl) {
  if (!tableEl) return;
  const container = document.getElementById('table-lb-container');
  const info = document.getElementById('table-lb-info');
  const searchInput = document.getElementById('table-lb-search');
  if (!container) return;

  // Clone table
  const clone = tableEl.cloneNode(true);
  clone.removeAttribute('id');
  clone.classList.remove('table-expandable');
  
  // Strip any contenteditable attributes from cells
  clone.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
  
  // Clean up table styles for wide, readable viewing
  clone.style.width = '100%';
  clone.style.maxWidth = '100%';
  clone.style.borderCollapse = 'collapse';

  container.innerHTML = '';
  container.appendChild(clone);
  _currentLightboxTable = clone;

  // Count rows and cols
  const rows = clone.querySelectorAll('tr').length;
  const maxCols = Array.from(clone.querySelectorAll('tr')).reduce((max, tr) => Math.max(max, tr.children.length), 0);
  if (info) {
    info.textContent = `(${rows} rows × ${maxCols} columns)`;
  }

  if (searchInput) searchInput.value = '';

  openModal('mo-table-lightbox');
}

export function exportTableCSV(tableEl) {
  const target = tableEl || _currentLightboxTable;
  if (!target) {
    toast('No table selected');
    return;
  }
  const rows = Array.from(target.querySelectorAll('tr'));
  if (!rows.length) return;

  const csvRows = [];
  rows.forEach(tr => {
    const cells = Array.from(tr.querySelectorAll('th, td'));
    const rowValues = cells.map(td => {
      let text = td.innerText.trim().replace(/\r?\n/g, ' ');
      // Escape double quotes
      if (text.includes('"') || text.includes(',') || text.includes(';')) {
        text = `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    });
    csvRows.push(rowValues.join(','));
  });

  const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + encodeURIComponent(csvRows.join('\r\n'));
  const link = document.createElement('a');
  link.setAttribute('href', csvContent);
  const prefix = S.curPDF ? S.curPDF.name.replace(/\.pdf$/i, '') : 'legal_table';
  link.setAttribute('download', `${prefix}_table.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  toast('✅ Table exported as CSV!');
}

export function copyTableMarkdown(tableEl) {
  const target = tableEl || _currentLightboxTable;
  if (!target) {
    toast('No table selected');
    return;
  }
  const rows = Array.from(target.querySelectorAll('tr'));
  if (!rows.length) return;

  let md = '';
  rows.forEach((tr, rowIdx) => {
    const cells = Array.from(tr.querySelectorAll('th, td'));
    const rowValues = cells.map(td => td.innerText.trim().replace(/\r?\n/g, ' ').replace(/\|/g, '\\|'));
    md += '| ' + rowValues.join(' | ') + ' |\n';

    // Insert separator after header or row 0
    if (rowIdx === 0) {
      const sep = cells.map(() => '---');
      md += '| ' + sep.join(' | ') + ' |\n';
    }
  });

  navigator.clipboard.writeText(md).then(() => {
    toast('📋 Table copied as Markdown!');
  }).catch(() => {
    toast('❌ Failed to copy to clipboard');
  });
}

export function copyTableHTML(tableEl) {
  const target = tableEl || _currentLightboxTable;
  if (!target) {
    toast('No table selected');
    return;
  }
  const cleanTable = target.cloneNode(true);
  cleanTable.querySelectorAll('.table-highlight').forEach(h => {
    const parent = h.parentNode;
    parent.replaceChild(document.createTextNode(h.textContent), h);
  });
  cleanTable.querySelectorAll('.table-row-hidden').forEach(r => r.classList.remove('table-row-hidden'));
  
  navigator.clipboard.writeText(cleanTable.outerHTML).then(() => {
    toast('📋 Table HTML copied!');
  }).catch(() => {
    toast('❌ Failed to copy to clipboard');
  });
}

function filterTableLightbox(query) {
  if (!_currentLightboxTable) return;
  const q = (query || '').toLowerCase().trim();
  const rows = Array.from(_currentLightboxTable.querySelectorAll('tbody tr, tr'));

  rows.forEach((tr, idx) => {
    // If it's a thead row or has <th>, always keep visible
    if (tr.querySelector('th') && idx === 0) {
      tr.classList.remove('table-row-hidden');
      return;
    }
    const text = tr.innerText.toLowerCase();
    if (!q || text.includes(q)) {
      tr.classList.remove('table-row-hidden');
    } else {
      tr.classList.add('table-row-hidden');
    }
  });
}

export function initTableLightbox() {
  const searchInput = document.getElementById('table-lb-search');
  const btnCopyMd = document.getElementById('btn-table-copy-md');
  const btnCopyHtml = document.getElementById('btn-table-copy-html');
  const btnExportCsv = document.getElementById('btn-table-export-csv');

  // Search input live filtering
  searchInput?.addEventListener('input', (e) => {
    filterTableLightbox(e.target.value);
  });

  btnCopyMd?.addEventListener('click', () => copyTableMarkdown());
  btnCopyHtml?.addEventListener('click', () => copyTableHTML());
  btnExportCsv?.addEventListener('click', () => exportTableCSV());
}

// ── Insert styled section banner header (box with underline) ──
export function insertBannerHeader(editorElement) {
  if (!editorElement) return;
  editorElement.focus();

  const sel = window.getSelection();
  let text = '';

  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const fragment = range.cloneContents();
    const tempDiv = document.createElement('div');
    tempDiv.appendChild(fragment);
    text = tempDiv.innerHTML.trim();
  }

  if (!text) text = 'Header Title';

  const bannerHtml = `<div class="np-banner-hdr" style="background:rgba(148,197,207,0.22);border-bottom:2px solid #7dd3fc;padding:8px 14px;margin:16px 0 10px;font-weight:800;font-size:18px;border-radius:4px 4px 0 0;display:block;color:#f1f5f9;letter-spacing:0.02em;">${text}</div><p><br></p>`;

  document.execCommand('insertHTML', false, bannerHtml);
  editorElement.dispatchEvent(new Event('input'));
}

// ── Toggle subtle grayed-out / dimmed styling on selected text ──
export function toggleGrayOut(editorElement) {
  if (!editorElement) return;
  editorElement.focus();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  if (sel.isCollapsed) return;

  const range = sel.getRangeAt(0);

  // Check if current selection is inside an existing .dim-text element
  let node = sel.anchorNode;
  if (node && node.nodeType === 3) node = node.parentElement;
  const existingDim = node ? node.closest('.dim-text') : null;

  if (existingDim && editorElement.contains(existingDim)) {
    // Unwrap the dimmed text (toggle off)
    const parent = existingDim.parentNode;
    while (existingDim.firstChild) {
      parent.insertBefore(existingDim.firstChild, existingDim);
    }
    parent.removeChild(existingDim);
    editorElement.dispatchEvent(new Event('input'));
    return;
  }

  // Extract selected contents and wrap in .dim-text
  const fragment = range.extractContents();
  const span = document.createElement('span');
  span.className = 'dim-text';
  span.style.cssText = 'opacity: 0.45; color: #94a3b8; display: inline; transition: opacity .15s;';
  span.appendChild(fragment);
  range.insertNode(span);

  // Re-select wrapped contents
  sel.removeAllRanges();
  const newRange = document.createRange();
  newRange.selectNodeContents(span);
  sel.addRange(newRange);

  editorElement.dispatchEvent(new Event('input'));
}

const INDENT_STEP = 28;

// ── Outdent single element or selected paragraph(s) ──
export function outdentLine(editorElement) {
  if (!editorElement) return;
  editorElement.focus();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  // If text is selected (full paragraph or multiple lines), outdent the whole selection
  if (!sel.isCollapsed) {
    document.execCommand('outdent');
    editorElement.dispatchEvent(new Event('input'));
    return;
  }

  let node = sel.anchorNode;
  if (!node) return;
  let elem = node.nodeType === 1 ? node : node.parentElement;

  // 1. List item outdent
  const li = elem?.closest('li');
  if (li && editorElement.contains(li)) {
    document.execCommand('outdent');
    editorElement.dispatchEvent(new Event('input'));
    return;
  }

  // 2. Check if inside a blockquote (split blockquote so only THIS line is outdented)
  const bq = elem?.closest('blockquote');
  if (bq && editorElement.contains(bq)) {
    let lineChild = node;
    while (lineChild && lineChild.parentElement !== bq && lineChild !== bq) {
      lineChild = lineChild.parentElement;
    }

    if (lineChild && lineChild !== bq) {
      const beforeNodes = [];
      const afterNodes = [];
      let found = false;

      Array.from(bq.childNodes).forEach(child => {
        if (child === lineChild) {
          found = true;
        } else if (!found) {
          beforeNodes.push(child);
        } else {
          afterNodes.push(child);
        }
      });

      const parent = bq.parentNode;
      const hasMeaningful = (nodes) => nodes.some(n => (n.textContent || '').trim().length > 0 || n.nodeName === 'IMG' || n.nodeName === 'TABLE');

      if (beforeNodes.length > 0 && hasMeaningful(beforeNodes)) {
        const bqBefore = document.createElement('blockquote');
        if (bq.getAttribute('style')) bqBefore.setAttribute('style', bq.getAttribute('style'));
        beforeNodes.forEach(n => bqBefore.appendChild(n));
        parent.insertBefore(bqBefore, bq);
      }

      parent.insertBefore(lineChild, bq);

      if (afterNodes.length > 0 && hasMeaningful(afterNodes)) {
        const bqAfter = document.createElement('blockquote');
        if (bq.getAttribute('style')) bqAfter.setAttribute('style', bq.getAttribute('style'));
        afterNodes.forEach(n => bqAfter.appendChild(n));
        parent.insertBefore(bqAfter, bq);
      }

      parent.removeChild(bq);

      try {
        const newRange = document.createRange();
        newRange.selectNodeContents(lineChild);
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
      } catch {}

      editorElement.dispatchEvent(new Event('input'));
      return;
    } else {
      const parent = bq.parentNode;
      while (bq.firstChild) {
        parent.insertBefore(bq.firstChild, bq);
      }
      parent.removeChild(bq);
      editorElement.dispatchEvent(new Event('input'));
      return;
    }
  }

  // 3. Check for custom margin-left on block element
  let block = elem;
  while (block && block !== editorElement && !/^(DIV|P|H1|H2|H3|H4|H5|H6)$/i.test(block.tagName) && !block.classList?.contains('np-banner-hdr')) {
    block = block.parentElement;
  }

  if (block && block !== editorElement) {
    const currentMargin = parseInt(block.style.marginLeft || '0', 10);
    if (currentMargin > 0) {
      const nextMargin = Math.max(0, currentMargin - INDENT_STEP);
      block.style.marginLeft = nextMargin > 0 ? `${nextMargin}px` : '';
      editorElement.dispatchEvent(new Event('input'));
      return;
    }
  }

  // 4. Check for leading whitespace / non-breaking spaces in text node
  if (node && node.nodeType === 3) {
    const val = node.textContent;
    const match = val.match(/^(\u00A0| ){1,4}/);
    if (match) {
      const removeLen = match[0].length;
      node.textContent = val.slice(removeLen);
      const newOffset = Math.max(0, sel.anchorOffset - removeLen);
      const newRange = document.createRange();
      newRange.setStart(node, newOffset);
      newRange.setEnd(node, newOffset);
      sel.removeAllRanges();
      sel.addRange(newRange);
      editorElement.dispatchEvent(new Event('input'));
      return;
    }
  }

  document.execCommand('outdent');
  editorElement.dispatchEvent(new Event('input'));
}

// ── Indent single line or entire highlighted paragraph(s) ──
export function indentLine(editorElement) {
  if (!editorElement) return;
  editorElement.focus();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  // When highlighting an entire paragraph or multiple lines, indent the whole selection together
  document.execCommand('indent');
  editorElement.dispatchEvent(new Event('input'));
}

// ── Unified keyboard handling: Indent on Tab, Outdent on Shift+Tab, and Smart Outdent on Backspace at start of line ──
export function handleEditorKeyDown(e, editorElement) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  // 1. Tab / Shift+Tab -> Indent / Outdent
  if (e.key === 'Tab') {
    e.preventDefault();
    if (e.shiftKey) {
      outdentLine(editorElement);
    } else {
      indentLine(editorElement);
    }
    return;
  }

  // 2. Backspace at start of indented block or line -> Outdent THIS single line
  if (e.key === 'Backspace' && sel.isCollapsed) {
    let node = sel.anchorNode;
    let offset = sel.anchorOffset;

    let isAtStart = (offset === 0);
    if (node && node.nodeType === 3 && offset > 0) {
      const preText = node.textContent.slice(0, offset);
      if (preText === '' || /^[\s\u00A0]+$/.test(preText)) {
        isAtStart = true;
      }
    }

    if (isAtStart) {
      let elem = node.nodeType === 1 ? node : node.parentElement;
      const bq = elem?.closest('blockquote');
      const li = elem?.closest('li');

      let block = elem;
      while (block && block !== editorElement && !/^(DIV|P|H1|H2|H3|H4|H5|H6)$/i.test(block.tagName) && !block.classList?.contains('np-banner-hdr')) {
        block = block.parentElement;
      }
      const hasMargin = block && parseInt(block.style.marginLeft || '0', 10) > 0;

      if ((bq && editorElement.contains(bq)) || (li && editorElement.contains(li)) || hasMargin) {
        e.preventDefault();
        outdentLine(editorElement);
        return;
      }
    }
  }
}

// ── Highlight colour dropdown for contenteditable editors ──
// Creates (or reuses) a floating colour picker anchored to `anchorBtn`.
// Clicking a colour calls execCommand('hiliteColor') on the active selection.
// ── Highlight colour applicator & dropdown for contenteditable editors ──

export function applyEditorHighlight(editorEl, range, color) {
  if (!editorEl) return;
  if (range) {
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }
  editorEl.focus();
  try {
    document.execCommand('styleWithCSS', false, true);
  } catch {}

  const c = color || S.activeColor || '#c9a84c';
  if (c === 'transparent' || c === 'rgba(0,0,0,0)') {
    const ok = document.execCommand('hiliteColor', false, 'rgba(0, 0, 0, 0)');
    if (!ok) document.execCommand('backColor', false, 'transparent');
  } else {
    const ok = document.execCommand('hiliteColor', false, c);
    if (!ok) document.execCommand('backColor', false, c);
  }

  // Also update activeColor so next highlight uses this color
  if (c !== 'transparent' && c !== 'rgba(0,0,0,0)') {
    S.activeColor = c;
    // Reflect in color dots if visible
    document.querySelectorAll('.cdot').forEach(x => {
      x.classList.toggle('sel', x.style.background === c || x.getAttribute('data-color') === c);
    });
  }

  editorEl.dispatchEvent(new Event('input', { bubbles: true }));
}

export function buildHighlightDropdown(anchorBtn, editorEl) {
  const DROPDOWN_ID = 'editor-hi-dropdown';
  let dropdown = document.getElementById(DROPDOWN_ID);

  // Toggle: close if already open
  if (dropdown) {
    dropdown.remove();
    return;
  }

  // Preserve current selection range before opening dropdown
  const sel = window.getSelection();
  let savedRange = null;
  if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
    savedRange = sel.getRangeAt(0).cloneRange();
  }

  dropdown = document.createElement('div');
  dropdown.id = DROPDOWN_ID;
  dropdown.style.cssText = [
    'position:fixed',
    'z-index:9999',
    'background:var(--navy-l)',
    'border:1px solid var(--navy-b)',
    'border-radius:6px',
    'padding:10px 12px',
    'box-shadow:0 4px 18px rgba(0,0,0,.6)',
    'display:flex',
    'flex-direction:column',
    'gap:8px',
    'min-width:160px',
  ].join(';');

  // Prevent focus loss on editor while picking
  dropdown.addEventListener('mousedown', e => e.preventDefault());

  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:11px;color:var(--muted);font-family:Inter,sans-serif;font-weight:500;letter-spacing:.04em;text-transform:uppercase';
  lbl.textContent = 'Highlight colour';
  dropdown.appendChild(lbl);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:7px;align-items:center';

  const DEFAULT_COLORS = [
    { name: 'Gold', hex_color: '#c9a84c' },
    { name: 'Yellow', hex_color: '#eab308' },
    { name: 'Green', hex_color: '#4ade80' },
    { name: 'Blue', hex_color: '#60a5fa' },
    { name: 'Pink', hex_color: '#f472b6' },
    { name: 'Orange', hex_color: '#fb923c' },
  ];
  const cats = (S.colorCats && S.colorCats.length) ? S.colorCats : DEFAULT_COLORS;

  for (const cat of cats) {
    const dot = document.createElement('button');
    dot.title = cat.name;
    const isCur = S.activeColor === cat.hex_color;
    dot.style.cssText = [
      `background:${cat.hex_color}`,
      'width:22px',
      'height:22px',
      'border-radius:50%',
      `border:2px solid ${isCur ? '#fff' : 'transparent'}`,
      'cursor:pointer',
      'transition:transform .12s,border-color .12s',
      'flex-shrink:0',
    ].join(';');
    dot.addEventListener('mouseenter', () => { dot.style.transform = 'scale(1.2)'; });
    dot.addEventListener('mouseleave', () => { dot.style.transform = ''; });
    dot.addEventListener('click', () => {
      applyEditorHighlight(editorEl, savedRange, cat.hex_color);
      dropdown.remove();
    });
    row.appendChild(dot);
  }

  // Remove-highlight pill
  const remove = document.createElement('button');
  remove.textContent = '✕ Remove';
  remove.title = 'Remove highlight from selection';
  remove.style.cssText = [
    'background:transparent',
    'border:1px solid var(--navy-b)',
    'color:var(--muted)',
    'border-radius:4px',
    'padding:2px 8px',
    'font-size:11px',
    'cursor:pointer',
    'font-family:Inter,sans-serif',
    'transition:all .12s',
  ].join(';');
  remove.addEventListener('mouseenter', () => { remove.style.borderColor = 'var(--red)'; remove.style.color = 'var(--red)'; });
  remove.addEventListener('mouseleave', () => { remove.style.borderColor = 'var(--navy-b)'; remove.style.color = 'var(--muted)'; });
  remove.addEventListener('click', () => {
    applyEditorHighlight(editorEl, savedRange, 'transparent');
    dropdown.remove();
  });
  row.appendChild(remove);
  dropdown.appendChild(row);
  document.body.appendChild(dropdown);

  // Position below anchor (flip up if near bottom of screen)
  const rect = anchorBtn.getBoundingClientRect();
  if (window.innerHeight - rect.bottom >= 90) {
    dropdown.style.top  = (rect.bottom + 4) + 'px';
    dropdown.style.left = rect.left + 'px';
  } else {
    dropdown.style.top       = (rect.top - 4) + 'px';
    dropdown.style.left      = rect.left + 'px';
    dropdown.style.transform = 'translateY(-100%)';
  }

  // Dismiss on outside click
  const close = (ev) => {
    if (!dropdown.contains(ev.target) && ev.target !== anchorBtn && !anchorBtn.contains(ev.target)) {
      dropdown.remove();
      document.removeEventListener('mousedown', close, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

