import { openModal, toast } from './ui.js';
import { S } from './state.js';
import { normalizeHexColor, getColorCategoryForHex } from './colors.js';

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
  let html = `<br><table class="note-table" style="width:100%; max-width:100%; border-collapse:collapse; margin:10px 0; table-layout:auto; word-break:normal; overflow-wrap:break-word;"><tbody>`;
  for (let r = 0; r < rows; r++) {
    html += `<tr>`;
    for (let c = 0; c < cols; c++) {
      html += `<td style="border:1px solid var(--navy-b); padding:6px 10px; word-break:normal; overflow-wrap:break-word;"><br></td>`;
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
function _isEmptyCellText(val) {
  return !String(val || '').replace(/&nbsp;|&#160;|\u00a0/gi, '').trim();
}

function _hasMeaningfulTableRowHtml(inner) {
  if (/<(?:img|svg|input|hr)\b/i.test(inner)) return true;
  const plain = String(inner || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;|\u00a0/gi, '')
    .trim();
  return plain.length > 0;
}

function parseTextToTable(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.length > 0);
  if (lines.length < 2) return null;

  let rows = [];
  let isMarkdownTable = false;
  const hasTabs = lines.some(l => l.includes('\t'));

  if (hasTabs) {
    rows = lines.map(l => l.split('\t').map(c => c.trim()));
  } else {
    // Check if lines have markdown | separators (all non-empty lines must be pipe-delimited)
    isMarkdownTable = lines.every(l => l.includes('|'));
    if (isMarkdownTable) {
      // Only skip true divider lines containing at least one '-' so empty header rows like `| | |` are tracked
      const mdDividerRe = /^[\s|:-]*-[\s|:-]*$/;
      rows = lines
        .filter(l => !mdDividerRe.test(l))
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

  const hadEmptyHeader = rows.length > 0 && rows[0].every(c => _isEmptyCellText(c));
  rows = rows.filter(r => r.some(c => !_isEmptyCellText(c)));

  // Must have at least 2 rows (or 1 data row for explicit markdown tables) and 2 columns
  const minRows = isMarkdownTable ? 1 : 2;
  if (rows.length >= minRows && rows[0].length >= 2) {
    const useHeaderRow = !hadEmptyHeader;
    let html = `<br><table class="note-table" style="width:100%; max-width:100%; border-collapse:collapse; margin:10px 0; table-layout:auto; word-break:normal; overflow-wrap:break-word;"><tbody>`;
    for (let r = 0; r < rows.length; r++) {
      html += `<tr>`;
      for (let c = 0; c < rows[r].length; c++) {
        const cellText = rows[r][c] || '';
        const isHeaderCell = r === 0 && useHeaderRow;
        const tag = isHeaderCell ? 'th' : 'td';
        const style = isHeaderCell
          ? 'border:1px solid var(--navy-b); padding:6px 10px; background:rgba(255,255,255,0.06); font-weight:bold; word-break:normal; overflow-wrap:break-word;'
          : 'border:1px solid var(--navy-b); padding:6px 10px; word-break:normal; overflow-wrap:break-word;';
        const rendered = cellText
          ? (isMarkdownTable ? renderInlineMarkdown(cellText).replace(/\n/g, '<br>') : cellText.replace(/\n/g, '<br>'))
          : '<br>';
        html += `<${tag} style="${style}">${rendered}</${tag}>`;
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

const _IGNORE_WS_CONTAINERS = new Set(['ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr']);
const _BLOCK_ELEMENTS = new Set([
  'p', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'blockquote', 'hr',
  'section', 'article', 'header', 'footer'
]);

function escapeHtmlText(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderInlineMarkdown(str) {
  let s = escapeHtmlText(str);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
  return s;
}

function parseMixedMarkdownToHtml(text) {
  if (!text) return null;
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  const hasMarkdownSyntax = rawLines.some(l =>
    /^\s*(?:#{1,6}\s+|[•\-\*]\s+|\d+[\.\)]\s+|>\s+|\|.*\|)/.test(l)
  );
  if (!hasMarkdownSyntax) return null;

  const bulletRe = /^(\s*)[•\-\*]\s+(.*)$/;
  const orderedRe = /^(\s*)\d+[\.\)]\s+(.*)$/;
  const headingRe = /^(#{1,6})\s+(.*)$/;
  const quoteRe = /^>\s?(.*)$/;
  const tableDividerRe = /^\|?(?=[\s:|-]*-)[\s:|-]+\|[\s:|-]*$/;

  const out = [];
  const listStack = [];
  let prevBlockType = null; // 'text' | 'block' | 'blank'

  const closeListsTo = (targetLen = 0) => {
    while (listStack.length > targetLen) {
      const top = listStack.pop();
      if (top.liOpen) out.push('</li>');
      out.push(`</${top.tag}>`);
      prevBlockType = 'block';
    }
  };

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      // Look ahead: if inside a list and the next non-blank line is also a list item,
      // stay in the list without emitting <br> between <li> elements.
      let nextIdx = i + 1;
      while (nextIdx < rawLines.length && !rawLines[nextIdx].trim()) nextIdx++;
      if (listStack.length > 0 && nextIdx < rawLines.length) {
        const nextLine = rawLines[nextIdx];
        if (bulletRe.test(nextLine) || orderedRe.test(nextLine)) {
          continue;
        }
      }
      closeListsTo(0);
      if (prevBlockType === 'text') {
        out.push('<br>');
        prevBlockType = 'blank';
      }
      continue;
    }

    // Markdown pipe table block
    if (trimmed.includes('|') && i + 1 < rawLines.length && tableDividerRe.test(rawLines[i + 1].trim())) {
      closeListsTo(0);
      const tableLines = [];
      while (i < rawLines.length && rawLines[i].includes('|')) {
        tableLines.push(rawLines[i]);
        i++;
      }
      i--; // compensate for loop increment
      const mdDividerRe = /^[\s|:-]*-[\s|:-]*$/;
      let tableRows = tableLines
        .filter(l => !mdDividerRe.test(l))
        .map(l => l.split('|').map(c => c.trim()).filter((c, idx, arr) =>
          (idx > 0 && idx < arr.length - 1) || (idx === 0 && c !== '') || (idx === arr.length - 1 && c !== '')
        ))
        .filter(r => r.length >= 2);
      const hadEmptyHeader = tableRows.length > 0 && tableRows[0].every(c => _isEmptyCellText(c));
      tableRows = tableRows.filter(r => r.some(c => !_isEmptyCellText(c)));
      if (tableRows.length >= 1) {
        const useHeaderRow = !hadEmptyHeader;
        let tbl = '<table class="note-table" style="width:100%; max-width:100%; border-collapse:collapse; margin:10px 0; table-layout:auto; word-break:normal; overflow-wrap:break-word;"><tbody>';
        for (let r = 0; r < tableRows.length; r++) {
          tbl += '<tr>';
          for (let c = 0; c < tableRows[r].length; c++) {
            const isHeaderCell = r === 0 && useHeaderRow;
            const cellTag = isHeaderCell ? 'th' : 'td';
            const style = isHeaderCell
              ? 'border:1px solid var(--navy-b); padding:6px 10px; background:rgba(255,255,255,0.06); font-weight:bold; word-break:normal; overflow-wrap:break-word;'
              : 'border:1px solid var(--navy-b); padding:6px 10px; word-break:normal; overflow-wrap:break-word;';
            const content = tableRows[r][c] ? renderInlineMarkdown(tableRows[r][c]) : '<br>';
            tbl += `<${cellTag} style="${style}">${content}</${cellTag}>`;
          }
          tbl += '</tr>';
        }
        tbl += '</tbody></table>';
        out.push(tbl);
        prevBlockType = 'block';
        continue;
      }
    }

    // Headings
    const hMatch = trimmed.match(headingRe);
    if (hMatch) {
      closeListsTo(0);
      const lvl = hMatch[1].length;
      out.push(`<h${lvl} style="margin:8px 0 4px;">${renderInlineMarkdown(hMatch[2])}</h${lvl}>`);
      prevBlockType = 'block';
      continue;
    }

    // Blockquotes
    const qMatch = trimmed.match(quoteRe);
    if (qMatch) {
      closeListsTo(0);
      out.push(`<blockquote style="border-left:3px solid var(--gold); margin:8px 0; padding-left:10px; color:var(--text-d);">${renderInlineMarkdown(qMatch[1])}</blockquote>`);
      prevBlockType = 'block';
      continue;
    }

    // Bullet or ordered list items (supports nested indentation)
    const bMatch = line.match(bulletRe);
    const oMatch = bMatch ? null : line.match(orderedRe);
    if (bMatch || oMatch) {
      const m = bMatch || oMatch;
      const indent = m[1].replace(/\t/g, '  ').length;
      const listTag = bMatch ? 'ul' : 'ol';

      while (listStack.length > 0 && indent < listStack[listStack.length - 1].indent) {
        const top = listStack.pop();
        if (top.liOpen) out.push('</li>');
        out.push(`</${top.tag}>`);
      }

      if (listStack.length === 0 || indent > listStack[listStack.length - 1].indent) {
        out.push(`<${listTag} style="margin:6px 0; padding-left:24px;">`);
        listStack.push({ tag: listTag, indent, liOpen: false });
      } else {
        const top = listStack[listStack.length - 1];
        if (top.tag !== listTag) {
          if (top.liOpen) out.push('</li>');
          out.push(`</${top.tag}>`);
          listStack.pop();
          out.push(`<${listTag} style="margin:6px 0; padding-left:24px;">`);
          listStack.push({ tag: listTag, indent, liOpen: false });
        } else if (top.liOpen) {
          out.push('</li>');
          top.liOpen = false;
        }
      }

      out.push(`<li>${renderInlineMarkdown(m[2]) || '<br>'}`);
      listStack[listStack.length - 1].liOpen = true;
      prevBlockType = 'block';
      continue;
    }

    // Plain line
    closeListsTo(0);
    if (prevBlockType === 'text' || prevBlockType === 'blank') {
      out.push('<br>');
    }
    out.push(renderInlineMarkdown(trimmed));
    prevBlockType = 'text';
  }

  closeListsTo(0);
  return out.join('').replace(/(?:<br\s*\/?>\s*)+$/i, '');
}

function cleanListItemInner(html) {
  let s = html
    // Strip leading <br>s and whitespace
    .replace(/^(?:\s|<br\s*\/?>)+/i, '')
    // Strip trailing <br>s and whitespace
    .replace(/(?:\s|<br\s*\/?>)+$/i, '')
    // Strip <br>s and whitespace immediately preceding a nested <ul> or <ol>
    .replace(/(?:\s|<br\s*\/?>)+(?=<(?:ul|ol)\b)/gi, '')
    // Strip <br>s and whitespace immediately following a nested </ul> or </ol>
    .replace(/(<\/(?:ul|ol)>)(?:\s|<br\s*\/?>)+/gi, '$1')
    // Collapse consecutive <br>s inside <li> caused by <p> wrappers
    .replace(/(?:<br\s*\/?>\s*){2,}/gi, '<br>');
  // Strip trailing <br> trapped inside closing inline tags (e.g. <b><p>Text</p></b> -> <b>Text<br></b>)
  s = s.replace(/(?:\s|<br\s*\/?>)+(?=(?:<\/(?:b|strong|i|em|u|s|strike|span|a)>)+$)/gi, '');
  // Drop empty inline wrappers if nothing remains inside
  s = s.replace(/^<(b|strong|i|em|u|s|strike|span)>\s*<\/\1>$/i, '').trim();
  return s;
}

function cleanClipboardHtmlDoc(doc, stripSelector) {
  doc.querySelectorAll(stripSelector).forEach(el => el.remove());

  function siblingElementOrNull(node, dir) {
    let cur = dir === 'prev' ? node.previousSibling : node.nextSibling;
    while (cur && cur.nodeType === 8 /* COMMENT_NODE */) {
      cur = dir === 'prev' ? cur.previousSibling : cur.nextSibling;
    }
    return cur;
  }

  function cleanNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.matches && node.matches(stripSelector)) return '';

    const tag = node.tagName.toLowerCase();
    let inner = '';
    node.childNodes.forEach(c => {
      if (c.nodeType === Node.TEXT_NODE && !/\S/.test(c.textContent)) {
        // Ignore pure-whitespace text nodes inside list/table structural containers
        // so formatting \n indentation never becomes blank lines under white-space: pre-wrap.
        if (_IGNORE_WS_CONTAINERS.has(tag)) return;
        if (tag !== 'pre' && tag !== 'code' && /[\r\n]/.test(c.textContent)) {
          const prev = siblingElementOrNull(c, 'prev');
          const next = siblingElementOrNull(c, 'next');
          const prevIsBlock = !prev || (prev.nodeType === Node.ELEMENT_NODE && _BLOCK_ELEMENTS.has(prev.tagName.toLowerCase()));
          const nextIsBlock = !next || (next.nodeType === Node.ELEMENT_NODE && _BLOCK_ELEMENTS.has(next.tagName.toLowerCase()));
          if (prevIsBlock || nextIsBlock) return;
          inner += ' ';
          return;
        }
      }
      inner += cleanNode(c);
    });

    if (tag === 'li') {
      inner = cleanListItemInner(inner);
    }

    if (!inner && !['br', 'hr', 'td', 'th', 'li'].includes(tag)) return '';

    const style = node.style || {};
    const fontWeight = (style.fontWeight || '').toLowerCase();
    const fontStyle = (style.fontStyle || '').toLowerCase();
    const textDeco = (style.textDecoration || '').toLowerCase();
    const isGoogleDocsWrapper = node.id?.startsWith('docs-internal-guid') || (tag === 'b' && (fontWeight === 'normal' || fontWeight === '400' || fontWeight === 'lighter'));

    const isBold = (['b', 'strong'].includes(tag) && !isGoogleDocsWrapper && fontWeight !== 'normal' && fontWeight !== '400' && fontWeight !== 'lighter') ||
                   (fontWeight === 'bold' || fontWeight === '700' || fontWeight === '800' || fontWeight === '900' || parseInt(fontWeight) >= 600);
    const isItalic = (['i', 'em'].includes(tag) && fontStyle !== 'normal') || fontStyle === 'italic';
    const isUnderline = (tag === 'u' && !textDeco.includes('none')) || textDeco.includes('underline');
    const isStrike = ['s', 'strike'].includes(tag) || textDeco.includes('line-through');

    if (inner) {
      if (isStrike) inner = `<s>${inner}</s>`;
      if (isUnderline) inner = `<u>${inner}</u>`;
      if (isItalic) inner = `<i>${inner}</i>`;
      if (isBold) inner = `<b>${inner}</b>`;
    }

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
      if (node.classList?.contains('dim-text')) {
        return `<span class="dim-text" style="opacity: 0.45; color: #94a3b8; display: inline; transition: opacity .15s;">${inner}</span>`;
      }
      return inner;
    }
    if (['ul', 'ol'].includes(tag)) {
      return `<${tag} style="margin:6px 0; padding-left:24px;">${inner}</${tag}>`;
    }
    if (tag === 'li') return `<li>${inner || '<br>'}</li>`;
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
      return `<${tag} style="margin:8px 0 4px;">${inner}</${tag}>`;
    }
    if (tag === 'blockquote') {
      return `<blockquote style="border-left:3px solid var(--gold); margin:8px 0; padding-left:10px; color:var(--text-d);">${inner}</blockquote>`;
    }
    if (tag === 'table') {
      if (!inner.trim()) return '';
      return `<table class="note-table" style="width:100%; max-width:100%; border-collapse:collapse; margin:10px 0; table-layout:auto; word-break:normal; overflow-wrap:break-word;">${inner}</table>`;
    }
    if (['tbody', 'thead', 'tfoot'].includes(tag)) {
      if (!inner.trim()) return '';
      return `<${tag}>${inner}</${tag}>`;
    }
    if (tag === 'tr') {
      if (!_hasMeaningfulTableRowHtml(inner)) return '';
      return `<tr>${inner}</tr>`;
    }
    if (tag === 'th') {
      const colspan = node.getAttribute('colspan') ? ` colspan="${node.getAttribute('colspan')}"` : '';
      const rowspan = node.getAttribute('rowspan') ? ` rowspan="${node.getAttribute('rowspan')}"` : '';
      return `<th style="border:1px solid var(--navy-b); padding:6px 10px; background:rgba(255,255,255,0.06); font-weight:bold; word-break:normal; overflow-wrap:break-word;"${colspan}${rowspan}>${inner || '<br>'}</th>`;
    }
    if (tag === 'td') {
      const colspan = node.getAttribute('colspan') ? ` colspan="${node.getAttribute('colspan')}"` : '';
      const rowspan = node.getAttribute('rowspan') ? ` rowspan="${node.getAttribute('rowspan')}"` : '';
      return `<td style="border:1px solid var(--navy-b); padding:6px 10px; word-break:normal; overflow-wrap:break-word;"${colspan}${rowspan}>${inner || '<br>'}</td>`;
    }
    if (['p', 'div'].includes(tag)) {
      if (!inner || /^(?:<br\s*\/?>\s*)+$/i.test(inner)) return '<br>';
      if (/(?:<br\s*\/?>|<\/(?:ul|ol|table|h[1-6]|blockquote)>)\s*$/i.test(inner)) return inner;
      return `${inner}<br>`;
    }
    if (tag === 'br') return '<br>';
    return inner;
  }

  let cleanHtml = cleanNode(doc.body);
  // Remove stray <br>s immediately between adjacent lists (</ul><br><ul>)
  cleanHtml = cleanHtml.replace(/(<\/(?:ul|ol)>)\s*(?:<br\s*\/?>\s*)+(?=<(?:ul|ol)\b)/gi, '$1');
  // Remove a single stray <br> immediately before <ul>/<ol> (e.g. from <p>Intro:</p><ul>...</ul>)
  // while keeping any intentional blank line (<br><br> -> <br>).
  cleanHtml = cleanHtml.replace(/<br\s*\/?>\s*(?=<(?:ul|ol)\b)/gi, '');
  cleanHtml = cleanHtml.replace(/(?:<br\s*\/?>\s*)+$/i, '');
  return cleanHtml;
}

export function sanitizeRichPasteHtml(html, text = '') {
  if (!html && text) {
    const tableHtml = parseTextToTable(text);
    if (tableHtml) return tableHtml;
    const mdHtml = parseMixedMarkdownToHtml(text);
    if (mdHtml) return mdHtml;
    const listHtml = parseTextToList(text);
    if (listHtml) return listHtml;
    return escapeHtmlText(text).replace(/\r?\n/g, '<br>');
  }
  if (!html) return '';

  const stripSelector = '.ann-ov, .hi-grp, .hr, .draw-canvas, canvas, .srch-ov, #sel-menu, #drag-ghost, .pg-placeholder, button, svg';
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const hasHtmlTable = doc.querySelector('table');
  if (!hasHtmlTable && text) {
    const tableFromText = parseTextToTable(text);
    if (tableFromText) return tableFromText;
  }

  const cleanHtml = cleanClipboardHtmlDoc(doc, stripSelector);
  return cleanHtml || text.replace(/\n/g, '<br>');
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
  
  const stripSelector = '.ann-ov, .hi-grp, .hr, .draw-canvas, canvas, .srch-ov, #sel-menu, #drag-ghost, .pg-placeholder';
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const hasHtmlTable = doc.querySelector('table');

  if (!hasHtmlTable && text) {
    const tableFromText = parseTextToTable(text);
    if (tableFromText) {
      document.execCommand('insertHTML', false, tableFromText);
      targetEl?.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
  }

  const cleanHtml = cleanClipboardHtmlDoc(doc, stripSelector);
  document.execCommand('insertHTML', false, cleanHtml || text.replace(/\n/g, '<br>'));
  targetEl?.dispatchEvent(new Event('input', { bubbles: true }));
}

function _escCopyHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _isIntentionalHighlightBg(rawBg) {
  if (!rawBg) return false;
  const val = String(rawBg).trim().toLowerCase();
  if (!val || val === 'transparent' || val === 'inherit' || val === 'initial' || val === 'none') return false;
  if (val.startsWith('var(')) return false;

  let r = 0, g = 0, b = 0, a = 1;
  const rgbMatch = val.match(/^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
  if (rgbMatch) {
    r = Number(rgbMatch[1]);
    g = Number(rgbMatch[2]);
    b = Number(rgbMatch[3]);
    a = rgbMatch[4] !== undefined ? Number(rgbMatch[4]) : 1;
  } else if (/^#[0-9a-f]{3,8}$/i.test(val)) {
    let hex = val.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.split('').map(ch => ch + ch).join('');
    }
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
    if (hex.length === 8) a = parseInt(hex.slice(6, 8), 16) / 255;
  } else {
    return true; // named highlight color (e.g. yellow, gold)
  }

  if (!Number.isFinite(a) || a <= 0.08) return false;
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  // Ignore dark UI surfaces (e.g. Casebook #141210 / #1d1a16), pure white, and subtle neutral tints
  if (maxC < 75) return false;
  if (minC > 246) return false;
  if ((maxC - minC) < 16 && (maxC < 200 || minC > 225)) return false;
  return true;
}

export function buildCleanCopyPayload(sourceRoot, fallbackPlainText = '') {
  if (!sourceRoot) {
    const plain = String(fallbackPlainText || '');
    return { html: _escCopyHtml(plain).replace(/\n/g, '<br>'), plain };
  }

  const clone = sourceRoot.cloneNode(true);
  if (clone.querySelectorAll) {
    clone.querySelectorAll('.np-drag-handle, .np-hi-bar, .np-hi-filter-bar, .ann-ov, .hi-grp, .hr, .draw-canvas, canvas, .srch-ov, #sel-menu, #drag-ghost, .pg-placeholder, button, svg').forEach(el => el.remove());
  }

  function serializeNode(node, inCellOrList = false) {
    if (node.nodeType === Node.TEXT_NODE) {
      return _escCopyHtml(node.textContent || '');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'button', 'svg', 'canvas'].includes(tag)) return '';
    if (node.classList?.contains('np-drag-handle')) return '';

    const childInBlock = inCellOrList || ['td', 'th', 'li', 'blockquote'].includes(tag);
    let inner = '';
    node.childNodes.forEach(c => { inner += serializeNode(c, childInBlock); });

    if (!inner && !['br', 'hr', 'td', 'th', 'li', 'img'].includes(tag)) return '';

    const style = node.style || {};
    const fontWeight = (style.fontWeight || '').toLowerCase();
    const fontStyle = (style.fontStyle || '').toLowerCase();
    const textDeco = (style.textDecoration || style.textDecorationLine || '').toLowerCase();

    const isBold = (['b', 'strong'].includes(tag) && fontWeight !== 'normal' && fontWeight !== '400' && fontWeight !== 'lighter') ||
                   (fontWeight === 'bold' || fontWeight === '700' || fontWeight === '800' || fontWeight === '900' || parseInt(fontWeight, 10) >= 600);
    const isItalic = (['i', 'em'].includes(tag) && fontStyle !== 'normal') || fontStyle === 'italic';
    const isUnderline = (tag === 'u' && !textDeco.includes('none')) || textDeco.includes('underline');
    const isStrike = ['s', 'strike', 'del'].includes(tag) || textDeco.includes('line-through');

    if (tag === 'br') return '<br>';
    if (tag === 'hr') return '<hr>';
    if (tag === 'img') {
      const src = node.getAttribute('src') || '';
      if (!src || src.startsWith('javascript:')) return '';
      const alt = _escCopyHtml(node.getAttribute('alt') || '');
      return `<img src="${_escCopyHtml(src)}" alt="${alt}" style="max-width:100%;height:auto;">`;
    }

    if (tag === 'sup') return `<sup>${inner}</sup>`;
    if (tag === 'sub') return `<sub>${inner}</sub>`;
    if (tag === 'code') return `<code>${inner}</code>`;
    if (tag === 'pre') return `<pre>${inner}</pre>`;
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      if (/^(https?:|mailto:|#)/i.test(href)) {
        return `<a href="${_escCopyHtml(href)}">${inner}</a>`;
      }
      return inner;
    }

    let formatted = inner;
    if (isStrike) formatted = `<s>${formatted}</s>`;
    if (isUnderline) formatted = `<u>${formatted}</u>`;
    if (isItalic) formatted = `<i>${formatted}</i>`;
    if (isBold) formatted = `<b>${formatted}</b>`;

    if (tag === 'mark' || (tag === 'span' && _isIntentionalHighlightBg(style.backgroundColor))) {
      const bg = tag === 'mark' && !_isIntentionalHighlightBg(style.backgroundColor)
        ? '#fef08a'
        : style.backgroundColor;
      return `<span style="background-color:${_escCopyHtml(bg)};">${formatted}</span>`;
    }
    if (['span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'font'].includes(tag)) {
      return formatted;
    }

    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
      return `<${tag}>${inner}</${tag}>`;
    }
    if (tag === 'ul' || tag === 'ol') {
      return `<${tag}>${inner}</${tag}>`;
    }
    if (tag === 'li') {
      return `<li>${inner || '<br>'}</li>`;
    }
    if (tag === 'blockquote') {
      return `<blockquote style="border-left:3px solid #cbd5e1; margin:6px 0; padding-left:10px;">${inner}</blockquote>`;
    }
    if (tag === 'table') {
      return `<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse; width:100%; margin:8px 0;">${inner}</table>`;
    }
    if (['thead', 'tbody', 'tfoot'].includes(tag)) {
      return `<${tag}>${inner}</${tag}>`;
    }
    if (tag === 'tr') {
      return `<tr>${inner}</tr>`;
    }
    if (tag === 'th' || tag === 'td') {
      const colspan = node.getAttribute('colspan') ? ` colspan="${_escCopyHtml(node.getAttribute('colspan'))}"` : '';
      const rowspan = node.getAttribute('rowspan') ? ` rowspan="${_escCopyHtml(node.getAttribute('rowspan'))}"` : '';
      const thWeight = tag === 'th' ? ' font-weight:bold;' : '';
      return `<${tag} style="border:1px solid #cbd5e1; padding:6px 10px; vertical-align:top;${thWeight}"${colspan}${rowspan}>${inner || '<br>'}</${tag}>`;
    }
    if (tag === 'p' || tag === 'div') {
      if (!inner) return inCellOrList ? '<br>' : '';
      return inCellOrList ? `${inner}<br>` : `<p style="margin:0 0 8px 0;">${inner}</p>`;
    }

    return formatted;
  }

  // Wrap orphaned partial-table fragments (when user selects across rows/cells inside a table)
  const topEls = Array.from(clone.childNodes).filter(n => n.nodeType === Node.ELEMENT_NODE);
  const hasOrphanTableRows = topEls.some(el => ['tr', 'thead', 'tbody', 'tfoot'].includes(el.tagName.toLowerCase()));
  const hasOrphanTableCells = topEls.some(el => ['td', 'th'].includes(el.tagName.toLowerCase()));

  let bodyHtml = '';
  if (hasOrphanTableCells) {
    let rowInner = '';
    clone.childNodes.forEach(c => { rowInner += serializeNode(c, true); });
    bodyHtml = `<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse; width:100%; margin:8px 0;"><tbody><tr>${rowInner}</tr></tbody></table>`;
  } else if (hasOrphanTableRows) {
    let tblInner = '';
    clone.childNodes.forEach(c => { tblInner += serializeNode(c, false); });
    bodyHtml = `<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse; width:100%; margin:8px 0;">${tblInner}</table>`;
  } else {
    clone.childNodes.forEach(c => { bodyHtml += serializeNode(c, false); });
  }

  bodyHtml = bodyHtml.replace(/(?:<br\s*\/?>\s*)+$/i, '');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><!--StartFragment-->${bodyHtml}<!--EndFragment--></body></html>`;
  const plain = String(fallbackPlainText || clone.textContent || '').trim();
  return { html, plain };
}

export function handleCopy(e) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;

  const targetEl = e.currentTarget;
  const range = sel.getRangeAt(0);
  if (targetEl && !targetEl.contains(range.commonAncestorContainer)) return;

  const plainText = sel.toString();
  if (!plainText && !range.cloneContents().querySelector('img, table')) return;

  const fragment = range.cloneContents();
  const { html, plain } = buildCleanCopyPayload(fragment, plainText);
  if (e.clipboardData) {
    e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', plain || plainText);
    e.preventDefault();
  }
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
        item.style.display = isEditable ? 'flex' : 'none';
      });
      ctxMenu.querySelectorAll('div[style*="height:1px"]').forEach(sep => {
        sep.style.display = isEditable ? 'block' : 'none';
      });
      
      ctxMenu.hidden = false;
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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ctxMenu.style.display !== 'none') {
      ctxMenu.style.display = 'none';
      activeTableCell = null;
    }
  });

  // Bind actions
  document.getElementById('ctx-copy-table')?.addEventListener('click', () => {
    if (activeTableCell) {
      const table = activeTableCell.closest('table');
      if (table) copyFormattedTable(table, 'Table copied with formatting!');
    }
  });
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

  initTableHoverCopyBtn();
}

let _hoveredTableEl = null;
let _hoverHideTimer = null;

function initTableHoverCopyBtn() {
  if (document.getElementById('table-hover-copy-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'table-hover-copy-btn';
  btn.type = 'button';
  btn.style.cssText = [
    'position:fixed',
    'z-index:2500',
    'display:none',
    'align-items:center',
    'gap:4px',
    'background:rgba(12, 19, 34, 0.94)',
    'border:1px solid var(--gold)',
    'color:var(--gold)',
    'border-radius:5px',
    'padding:3px 9px',
    'font-size:11px',
    'font-weight:600',
    'font-family:var(--font-ui)',
    'cursor:pointer',
    'box-shadow:0 4px 14px rgba(0,0,0,0.55)',
    'transition:background 0.15s, transform 0.12s',
    'white-space:nowrap',
  ].join(';');
  const setHoverBtnContent = (iconId, label) => {
    btn.innerHTML = `<svg class="icon icon-sm" aria-hidden="true"><use href="#${iconId}"/></svg><span>${label}</span>`;
  };
  setHoverBtnContent('i-copy', 'Copy Summary Table');
  btn.title = 'Instantly copy this table preserving its formatting';

  btn.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
  });

  btn.addEventListener('mouseenter', () => {
    if (_hoverHideTimer) {
      clearTimeout(_hoverHideTimer);
      _hoverHideTimer = null;
    }
    btn.style.background = 'rgba(201, 168, 76, 0.22)';
  });

  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'rgba(12, 19, 34, 0.94)';
    _hoverHideTimer = setTimeout(() => {
      btn.style.display = 'none';
      _hoveredTableEl = null;
    }, 180);
  });

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!_hoveredTableEl) return;
    const isFirst = isFirstTableInContainer(_hoveredTableEl);
    const ok = await copyFormattedTable(
      _hoveredTableEl,
      isFirst ? 'Summary table copied with formatting!' : 'Table copied with formatting!'
    );
    if (ok) {
      const idleLabel = isFirst ? 'Copy Summary Table' : 'Copy Table';
      btn.dataset.copied = '1';
      setHoverBtnContent('i-check', 'Copied!');
      setTimeout(() => {
        if (btn.dataset.copied === '1') {
          delete btn.dataset.copied;
          setHoverBtnContent('i-copy', idleLabel);
        }
      }, 1200);
    }
  });

  document.body.appendChild(btn);

  const TABLE_CONTAINERS = '#np-digest-editor, #np-editor, #folder-doc-editor, .note-body, #note-editor, #edit-note-ed';

  function isFirstTableInContainer(table) {
    const container = table.closest(TABLE_CONTAINERS);
    if (!container) return true;
    return container.querySelector('table') === table;
  }

  function positionHoverBtn(table) {
    const container = table.closest(TABLE_CONTAINERS);
    const tRect = table.getBoundingClientRect();
    if (tRect.width === 0 || tRect.height === 0) {
      btn.style.display = 'none';
      return;
    }
    if (container) {
      const cRect = container.getBoundingClientRect();
      if (tRect.bottom < cRect.top + 20 || tRect.top > cRect.bottom - 20) {
        btn.style.display = 'none';
        return;
      }
    }
    const isFirst = isFirstTableInContainer(table);
    if (btn.dataset.copied !== '1') {
      setHoverBtnContent('i-copy', isFirst ? 'Copy Summary Table' : 'Copy Table');
    }
    btn.style.display = 'inline-flex';
    const bw = btn.offsetWidth || 138;
    let top = Math.max(8, tRect.top + 5);
    if (container) {
      const cRect = container.getBoundingClientRect();
      top = Math.max(cRect.top + 4, Math.min(top, cRect.bottom - 28));
    }
    const left = Math.max(8, Math.min(window.innerWidth - bw - 10, tRect.right - bw - 6));
    btn.style.top = `${top}px`;
    btn.style.left = `${left}px`;
  }

  document.addEventListener('mouseover', (e) => {
    if (e.target === btn || btn.contains(e.target)) {
      if (_hoverHideTimer) {
        clearTimeout(_hoverHideTimer);
        _hoverHideTimer = null;
      }
      return;
    }
    const table = e.target.closest?.('table');
    if (table && table.closest(TABLE_CONTAINERS) && !table.closest('#table-lb-viewport')) {
      if (_hoverHideTimer) {
        clearTimeout(_hoverHideTimer);
        _hoverHideTimer = null;
      }
      _hoveredTableEl = table;
      positionHoverBtn(table);
    } else if (_hoveredTableEl) {
      if (!_hoverHideTimer) {
        _hoverHideTimer = setTimeout(() => {
          btn.style.display = 'none';
          _hoveredTableEl = null;
          _hoverHideTimer = null;
        }, 200);
      }
    }
  });

  window.addEventListener('scroll', () => {
    if (btn.style.display !== 'none') {
      btn.style.display = 'none';
      _hoveredTableEl = null;
    }
  }, true);
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
  toast('Table exported as CSV');
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
    toast('Table copied as Markdown');
  }).catch(() => {
    toast('Failed to copy to clipboard');
  });
}

export async function copyFormattedTable(tableEl, customToastMsg) {
  const target = tableEl || _currentLightboxTable;
  if (!target) {
    toast('No summary table found to copy');
    return false;
  }

  const cleanTable = target.cloneNode(true);
  cleanTable.removeAttribute('id');
  cleanTable.classList.remove('table-expandable');

  // Unwrap any lightbox search highlights
  cleanTable.querySelectorAll('.table-highlight').forEach(h => {
    const parent = h.parentNode;
    parent.replaceChild(document.createTextNode(h.textContent), h);
  });
  cleanTable.querySelectorAll('.table-row-hidden').forEach(r => r.classList.remove('table-row-hidden'));
  cleanTable.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));

  const { html: htmlPayload, plain: cleanPlain } = buildCleanCopyPayload(cleanTable);
  const rows = Array.from(cleanTable.querySelectorAll('tr'));
  const plainText = rows.map(tr => {
    const cells = Array.from(tr.querySelectorAll('th, td'));
    return cells.map(c => (c.innerText || c.textContent || '').trim().replace(/\r?\n+/g, ' ')).join('\t');
  }).join('\n') || cleanPlain;

  let copied = false;

  // 1. Primary: Rich Clipboard API (text/html + text/plain)
  if (navigator.clipboard && window.ClipboardItem) {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([htmlPayload], { type: 'text/html' }),
        'text/plain': new Blob([plainText], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      copied = true;
    } catch (err) {
      console.warn('ClipboardItem write fallback:', err);
    }
  }

  // 2. Fallback: Offscreen contenteditable selection + execCommand('copy')
  if (!copied) {
    try {
      const sel = window.getSelection();
      const savedRanges = [];
      if (sel) {
        for (let i = 0; i < sel.rangeCount; i++) {
          savedRanges.push(sel.getRangeAt(i).cloneRange());
        }
      }
      const holder = document.createElement('div');
      holder.contentEditable = 'true';
      holder.style.cssText = 'position:fixed; left:-9999px; top:0; opacity:0; pointer-events:none;';
      holder.innerHTML = htmlPayload;
      document.body.appendChild(holder);

      const range = document.createRange();
      range.selectNodeContents(holder);
      sel?.removeAllRanges();
      sel?.addRange(range);
      copied = document.execCommand('copy');
      document.body.removeChild(holder);

      if (sel) {
        sel.removeAllRanges();
        savedRanges.forEach(r => sel.addRange(r));
      }
    } catch (err) {
      console.warn('execCommand table copy fallback failed:', err);
    }
  }

  // 3. Final fallback: plain text
  if (!copied && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(plainText);
      copied = true;
    } catch {}
  }

  if (copied) {
    // Visual confirmation flash on the source table
    const prevOutline = target.style.outline;
    const prevShadow = target.style.boxShadow;
    target.style.outline = '2px solid var(--gold)';
    target.style.boxShadow = '0 0 18px rgba(201, 168, 76, 0.45)';
    setTimeout(() => {
      target.style.outline = prevOutline;
      target.style.boxShadow = prevShadow;
    }, 650);

    toast(customToastMsg || 'Summary table copied with formatting');
    return true;
  } else {
    toast('Failed to copy table to clipboard');
    return false;
  }
}

export async function copyFirstSummaryTable(containerEl, fallbackContainerEl = null) {
  const firstTable = containerEl?.querySelector?.('table') || fallbackContainerEl?.querySelector?.('table');
  if (!firstTable) {
    toast('No summary table found in this section');
    return false;
  }
  return copyFormattedTable(firstTable, 'Summary table copied with formatting');
}

export function copyTableHTML(tableEl) {
  return copyFormattedTable(tableEl, 'Table copied with formatting');
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

  const isTransparent = color === 'transparent' || color === 'rgba(0,0,0,0)';
  const normInput = isTransparent ? null : normalizeHexColor(color);
  const normActive = normalizeHexColor(S.activeColor);
  const c = isTransparent ? 'transparent' : (normInput || normActive || color || '#c9a84c');

  if (c === 'transparent' || c === 'rgba(0,0,0,0)') {
    const ok = document.execCommand('hiliteColor', false, 'rgba(0, 0, 0, 0)');
    if (!ok) document.execCommand('backColor', false, 'transparent');
  } else {
    const ok = document.execCommand('hiliteColor', false, c);
    if (!ok) document.execCommand('backColor', false, c);
  }

  // Also update activeColor so next highlight uses this normalized color
  if (c !== 'transparent' && c !== 'rgba(0,0,0,0)') {
    const targetNorm = normalizeHexColor(c) || c;
    S.activeColor = targetNorm;
    // Reflect in color dots & selection menu swatches if visible
    document.querySelectorAll('.cdot, #selmenuSwatches [data-color], #selmenuSwatches button, #selmenuSwatches .sel-swatch').forEach(x => {
      const xRaw = x.getAttribute('data-color') || x.style.backgroundColor || x.style.background;
      const xNorm = normalizeHexColor(xRaw);
      if (xNorm) x.setAttribute('data-color', xNorm);
      x.classList.toggle('sel', Boolean(targetNorm && xNorm === targetNorm));
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
  lbl.style.cssText = 'font-size:11px;color:var(--muted);font-family:var(--font-ui, sans-serif);font-weight:500;letter-spacing:.04em;text-transform:uppercase';
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
  const hasCats = Array.isArray(S.colorCats) && S.colorCats.length > 0;
  const cats = hasCats ? S.colorCats : DEFAULT_COLORS;
  const activeNorm = normalizeHexColor(S.activeColor);

  for (const cat of cats) {
    const norm = normalizeHexColor(cat.hex_color) || cat.hex_color;
    const catInfo = hasCats ? getColorCategoryForHex(norm) : { name: cat.name };
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.dataset.color = norm;
    dot.title = catInfo.name || cat.name;
    dot.setAttribute('aria-label', dot.title);
    const isCur = Boolean(activeNorm && normalizeHexColor(norm) === activeNorm);
    dot.style.cssText = [
      `background:${norm}`,
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
      applyEditorHighlight(editorEl, savedRange, norm);
      dropdown.remove();
    });
    row.appendChild(dot);
  }

  // Remove-highlight pill
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.innerHTML = '<svg class="icon" style="width:11px;height:11px;vertical-align:-1px;margin-right:4px" aria-hidden="true"><use href="#i-close"/></svg><span>Remove</span>';
  remove.title = 'Remove highlight from selection';
  remove.style.cssText = [
    'background:transparent',
    'border:1px solid var(--navy-b)',
    'color:var(--muted)',
    'border-radius:4px',
    'padding:2px 8px',
    'font-size:11px',
    'cursor:pointer',
    'font-family:var(--font-ui, sans-serif)',
    'display:inline-flex',
    'align-items:center',
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

