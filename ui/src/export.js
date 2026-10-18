import { S } from './state.js';
import { dbLoadNotepad } from './db.js';
import { toast } from './ui.js';
import { safeStorageGet } from './storage.js';
import { getCachedNotepad } from './notepad.js';

// Strip emojis using Unicode property escapes and common icon sets
const stripEmojis = (str) => {
  if (!str) return '';
  return str
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D\u20E3]/gu, '')
    .replace(/[📖📑💾📥☁️⚙️📲📁📂📜⚖️📋📄✏️✕▶️◀️▲▼🕐🔍💡✨🔴🟠🟡🟢🔵🟣⚫⚪🟤]/g, '')
    .trim();
};

// Clean HTML to ensure dark text and strip light colors
function cleanAndSanitizeHtml(html) {
  if (!html) return '';
  let clean = stripEmojis(html);
  // Replace inline light colors (white, off-white, light gray) with dark slate
  clean = clean
    .replace(/color:\s*(#[d-fD-F0-9]{3,6}|rgb\(\s*2[0-5][0-9]\s*,\s*2[0-5][0-9]\s*,\s*2[0-5][0-9]\s*\)|white|#fff|#f1f5f9|#e8e4db|#e0dbd2)/gi, 'color: #0f172a')
    .replace(/background:\s*(var\(--navy[^)]*\)|#0c1322|#141c2d|#1e293b|#101827)/gi, 'background: transparent');
  return clean;
}

// Clean HTML check to verify if a section contains actual text, tables, or images
function hasMeaningfulContent(html) {
  if (!html) return false;
  const stripped = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  const hasImg = /<img\b/i.test(html);
  const hasTable = /<table\b/i.test(html);
  return stripped.length > 0 || hasImg || hasTable;
}

// Fetch notes and digest for a specific PDF (checking active memory, DB, and local cache)
async function fetchPdfNotesAndDigest(pdf) {
  const trueId = pdf.linked_pdf_id || pdf.id;
  let content = '';
  let digest = '';

  // 1. Check in-memory active cache
  try {
    const mem = getCachedNotepad(trueId);
    if (mem) {
      content = mem.content || '';
      digest = mem.digest || '';
    }
  } catch {}

  // 2. Query Database / Local Storage if either content or digest is missing
  if (!content || !digest) {
    try {
      const res = await dbLoadNotepad(trueId);
      if (res) {
        if (!content) content = res.content || '';
        if (!digest) digest = res.digest || '';
      }
    } catch (err) {
      console.warn('[PDF Export] dbLoadNotepad failed:', err);
    }
  }

  // 3. Fallbacks from local storage
  if (!content) content = safeStorageGet('local_notepad_' + trueId, '') || '';
  if (!digest) digest = safeStorageGet('local_digest_' + trueId, '') || '';

  return { content, digest };
}

function getFolderPathString(folder) {
  const parts = [];
  let currFolder = folder;
  while (currFolder) {
    const rawName = stripEmojis(currFolder.name) || 'Folder';
    parts.unshift(rawName);
    if (currFolder.parent_folder_id) {
      currFolder = S.folders.find(f => f.id === currFolder.parent_folder_id);
    } else {
      break;
    }
  }
  if (folder.subject_id) {
    const subj = S.subjects.find(s => s.id === folder.subject_id);
    if (subj) {
      const subjName = stripEmojis(subj.name) || 'Subject';
      parts.unshift(subjName);
    }
  }
  return parts.join(' > ');
}

// Build HTML tree for folder export. Only registers cases that actually have notes/digest.
async function buildFolderHTML(folderId, depth = 1, caseRegistry = []) {
  const folder = S.folders.find(f => f.id === folderId);
  if (!folder) return '';

  const startCaseIdx = caseRegistry.length;

  let casesHtml = '';
  let subfoldersHtml = '';
  let hasAnyContent = false;

  // 1. Cases / PDFs directly inside this folder
  const pdfs = S.pdfs
    .filter(p => p.folder_id === folderId)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  for (const pdf of pdfs) {
    const { content, digest } = await fetchPdfNotesAndDigest(pdf);
    const hasDigest = hasMeaningfulContent(digest);
    const hasContent = hasMeaningfulContent(content);

    if (hasDigest || hasContent) {
      hasAnyContent = true;
      const pdfName = (stripEmojis(pdf.name) || 'Case Document').replace(/\.pdf$/i, '').trim() || 'Case Document';
      const pageId = `cp${caseRegistry.length}`;
      caseRegistry.push({ pageId, pdfName, folderPath: getFolderPathString(folder) });

      casesHtml += `
        <div class="case-section" style="page: ${pageId}; margin: 8pt 0; padding: 8pt 10pt; border: 0.75pt solid #cbd5e1; border-radius: 4pt; background: #ffffff;">
          <div class="case-title" style="font-size: 10pt; font-weight: 700; color: #0f172a; margin-bottom: 5pt; border-bottom: 0.75pt solid #e2e8f0; padding-bottom: 2pt;">
            ${pdfName}
          </div>
      `;

      // 1a. Case Digest
      if (hasDigest) {
        casesHtml += `
          <div style="margin-bottom: 6pt;">
            <div class="section-badge" style="font-size: 7pt; font-weight: 700; color: #0369a1; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2pt;">Case Digest</div>
            <div class="case-digest-body" style="padding-left: 8pt; border-left: 2pt solid #0284c7; color: #1e293b; line-height: 1.25;">
              ${cleanAndSanitizeHtml(digest)}
            </div>
          </div>
        `;
      }

      // 1b. Appendix / Notes
      if (hasContent) {
        casesHtml += `
          <div style="margin-top: 5pt;">
            <div class="section-badge" style="font-size: 7pt; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2pt;">Appendix / Notes</div>
            <div class="case-notes-body" style="padding-left: 8pt; border-left: 2pt solid #64748b; color: #1e293b; line-height: 1.25;">
              ${cleanAndSanitizeHtml(content)}
            </div>
          </div>
        `;
      }

      casesHtml += `</div>`;
    }
  }

  // 2. Subfolders recursively
  const subfolders = S.folders
    .filter(f => f.parent_folder_id === folderId)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  for (const sf of subfolders) {
    const subHtml = await buildFolderHTML(sf.id, depth + 1, caseRegistry);
    if (subHtml) {
      subfoldersHtml += subHtml;
      hasAnyContent = true;
    }
  }

  // Determine the named page of the first case under this folder branch
  const firstCase = caseRegistry.length > startCaseIdx ? caseRegistry[startCaseIdx] : null;
  const firstPageStyle = firstCase ? `page: ${firstCase.pageId};` : '';

  // 3. Folder Notes
  let folderNotesHtml = '';
  const folderNotes = folder.notes || safeStorageGet('local_folder_notes_' + folder.id, '') || '';
  if (hasMeaningfulContent(folderNotes)) {
    hasAnyContent = true;
    folderNotesHtml += `
      <div class="folder-notes-section" style="${firstPageStyle} margin-bottom: 10pt; padding: 6pt 10pt; background: #f8fafc; border: 0.75pt solid #e2e8f0; border-radius: 4pt; color: #1e293b; line-height: 1.25;">
        <div class="section-badge" style="font-size: 7pt; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3pt;">Folder Notes</div>
        <div class="note-content" style="color: #1e293b;">${cleanAndSanitizeHtml(folderNotes)}</div>
      </div>
    `;
  }

  if (!hasAnyContent) return '';

  // 4. Folder Header:
  // Depth=1 is the top-level exported folder — its name is already in the running @top-left header,
  // so we skip the h1 to avoid duplicate titles.
  // Subfolders (depth >= 2) get an hN section divider.
  // Assigning firstPageStyle ensures Chrome keeps the header on the same named page as its first case,
  // preventing an empty intermediate page with only the folder header!
  let headerHtml = '';
  if (depth >= 2) {
    const folderName = stripEmojis(folder.name) || 'Folder';
    const hSize = depth === 2 ? '11.5pt' : '10.5pt';
    const hTag = depth === 2 ? 'h2' : 'h3';
    headerHtml = `
      <div class="folder-header-wrap" style="${firstPageStyle} margin-top: 14pt; margin-bottom: 8pt; page-break-after: avoid; break-after: avoid;">
        <${hTag} style="margin: 0 0 3pt 0; font-size: ${hSize}; color: #0f172a; font-weight: 700; border-bottom: 1.5pt solid #334155; padding-bottom: 2pt;">
          ${folderName}
        </${hTag}>
      </div>
    `;
  }

  return headerHtml + folderNotesHtml + casesHtml + subfoldersHtml;
}

export async function exportFolderToPDF(foldersOrFolder, opts = {}) {
  const folders = Array.isArray(foldersOrFolder) ? foldersOrFolder : [foldersOrFolder];
  const orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
  // 1. Flush any pending active editor notes from memory to state
  try {
    const { flushFolderDoc } = await import('./viewer.js');
    await flushFolderDoc();
  } catch {}
  try {
    const { flushNotepadSave } = await import('./notepad.js');
    await flushNotepadSave();
  } catch {}

  toast('Gathering notes for export...');

  const caseRegistry = [];
  const htmlParts = [];
  for (const f of folders) {
    const depth = folders.length > 1 ? 2 : 1;
    const fHtml = await buildFolderHTML(f.id, depth, caseRegistry);
    if (fHtml && hasMeaningfulContent(fHtml)) {
      htmlParts.push(fHtml);
    }
  }
  const htmlContent = htmlParts.join('\n');

  if (!htmlContent || !hasMeaningfulContent(htmlContent)) {
    toast('No notes or digests found in the selected folder(s).');
    return;
  }

  toast('Preparing PDF export document...');

  const titleParts = folders.map(f => stripEmojis(f.name) || 'Folder');
  const pageTitle = folders.length > 1
    ? `${titleParts.join(', ')} — Notes & Case Digests`
    : `${titleParts[0]} — Notes & Case Digests`;
  const folderPath = folders.length > 1
    ? `${folders.length} Folders: ${titleParts.join(' &bull; ')}`
    : getFolderPathString(folders[0]);
  const firstPageStyle = caseRegistry.length > 0 ? `page: ${caseRegistry[0].pageId};` : '';

  // Build one @page rule per case with the case name and its own folder path hardcoded as CSS string literals
  const casePageCss = caseRegistry.map(({ pageId, pdfName, folderPath: casePath }) => {
    const safeName = (pdfName || 'Case Document').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const safePath = (casePath || folderPath).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `
    @page ${pageId} {
      @top-left {
        content: "${safePath}";
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, Arial, sans-serif;
        font-size: 7pt;
        color: #475569;
        border-bottom: 0.5pt solid #cbd5e1;
        padding-bottom: 4pt;
        text-align: left;
        vertical-align: bottom;
      }
      @top-right {
        content: "${safeName}";
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, Arial, sans-serif;
        font-size: 7pt;
        font-weight: 700;
        color: #0f172a;
        border-bottom: 0.5pt solid #cbd5e1;
        padding-bottom: 4pt;
        text-align: right;
        vertical-align: bottom;
      }
      @bottom-center {
        content: "Page " counter(page) " of " counter(pages);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, Arial, sans-serif;
        font-size: 7.5pt;
        color: #64748b;
        border-top: 0.5pt solid #cbd5e1;
        padding-top: 4pt;
        width: 100%;
        text-align: center;
      }
    }`;
  }).join('\n');

  const fullDocumentHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${pageTitle}</title>
  <style>
    @page {
      size: letter ${orientation};
      margin: 0.75in 0.5in 0.65in 0.5in;
      @bottom-center {
        content: "Page " counter(page) " of " counter(pages);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, Arial, sans-serif;
        font-size: 7.5pt;
        color: #64748b;
        border-top: 0.5pt solid #cbd5e1;
        padding-top: 4pt;
        width: 100%;
        text-align: center;
      }
    }
    @page :blank {
      @top-left { content: none; }
      @top-right { content: none; }
      @bottom-center { content: none; }
    }
    ${casePageCss}
    * {
      box-sizing: border-box;
    }
    body {
      ${firstPageStyle}
      margin: 0;
      padding: 0;
      background: #f1f5f9;
      color: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, Aptos, Arial, Helvetica, sans-serif;
      font-size: 9pt;
      line-height: 1.25;
    }
    .top-bar {
      position: sticky;
      top: 0;
      background: #0c1322;
      color: #ffffff;
      padding: 10px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      z-index: 10000;
      flex-wrap: wrap;
      gap: 10px;
    }
    .top-bar-left {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .top-bar-title {
      font-weight: 700;
      font-size: 14px;
      color: #c9a84c;
    }
    .top-bar-sub {
      font-size: 11px;
      color: #94a3b8;
      font-weight: 500;
    }
    .top-bar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .btn-group {
      display: flex;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 6px;
      padding: 2px;
    }
    .btn-toggle {
      background: none;
      border: none;
      color: #94a3b8;
      padding: 5px 10px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-toggle.active {
      background: #334155;
      color: #f1f5f9;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    .btn-print {
      background: #c9a84c;
      color: #0c1322;
      border: none;
      padding: 7px 16px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: background .15s;
    }
    .btn-print:hover {
      background: #dfbe65;
    }
    .btn-close {
      background: #1e293b;
      color: #e2e8f0;
      border: 1px solid #475569;
      padding: 7px 12px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      transition: background .15s;
    }
    .btn-close:hover {
      background: #334155;
    }
    .paper-container {
      max-width: 8.5in;
      margin: 18px auto;
      background: #ffffff;
      padding: 0.5in;
      box-shadow: 0 4px 24px rgba(0,0,0,0.1);
      border-radius: 4px;
    }

    /* Compact Layout Styling */
    p {
      margin: 3pt 0 !important;
    }
    table {
      width: 100% !important;
      border-collapse: collapse !important;
      margin: 6pt 0 !important;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    th, td {
      border: 1pt solid #cbd5e1 !important;
      padding: 4pt 6pt !important;
      text-align: left !important;
      vertical-align: top !important;
      font-size: 8.5pt !important;
      color: #1e293b !important;
      line-height: 1.25 !important;
    }
    th {
      background-color: #f1f5f9 !important;
      font-weight: 700 !important;
      color: #0f172a !important;
    }
    img {
      max-width: 100% !important;
      height: auto !important;
      display: block !important;
      margin: 6pt 0 !important;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    blockquote {
      margin: 4pt 0 !important;
      padding: 3pt 8pt !important;
      border-left: 2.5pt solid #94a3b8 !important;
      background: #f8fafc !important;
      color: #334155 !important;
    }
    pre, code {
      background: #f1f5f9 !important;
      color: #0f172a !important;
      padding: 2px 4px !important;
      border-radius: 3px !important;
      font-size: 8pt !important;
    }
    .np-banner-hdr {
      background: #e0f2fe !important;
      border-bottom: 2pt solid #0284c7 !important;
      color: #0369a1 !important;
      padding: 5pt 10pt !important;
      margin: 8pt 0 4pt !important;
      font-weight: 800 !important;
      font-size: 10pt !important;
      border-radius: 3pt 3pt 0 0 !important;
      display: block !important;
      letter-spacing: 0.02em !important;
      page-break-after: avoid;
      break-after: avoid;
    }
    ul, ol {
      margin: 3pt 0 !important;
      padding-left: 18pt !important;
      list-style-type: disc !important;
    }
    ul ul, ol ol, ul ol, ol ul {
      margin: 1.5pt 0 !important;
      padding-left: 16pt !important;
      list-style-type: circle !important;
    }
    ul ul ul, ol ol ol {
      list-style-type: square !important;
    }
    li {
      margin-bottom: 1.5pt !important;
    }
    .dim-text {
      opacity: 0.45 !important;
      color: #64748b !important;
      display: inline !important;
    }

    /* 2-Column Mode */
    .two-column-layout {
      column-count: 2;
      column-gap: 16pt;
    }
    .two-column-layout .case-section,
    .two-column-layout .folder-notes-section {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .two-column-layout .folder-header-wrap {
      column-span: all;
    }

    /* Standard Mode Override */
    .standard-mode {
      font-size: 10pt !important;
      line-height: 1.5 !important;
    }
    .standard-mode p {
      margin: 6pt 0 !important;
    }
    .standard-mode th, .standard-mode td {
      font-size: 9pt !important;
      padding: 6pt 8pt !important;
    }
    .standard-mode .case-title {
      font-size: 11pt !important;
    }
    .standard-mode .section-badge {
      font-size: 8pt !important;
    }
    .standard-mode .folder-header-wrap h1 {
      font-size: 14pt !important;
    }
    .standard-mode .folder-header-wrap h2 {
      font-size: 12.5pt !important;
    }
    .standard-mode .folder-header-wrap h3 {
      font-size: 11.5pt !important;
    }
    .standard-mode .np-banner-hdr {
      font-size: 11pt !important;
    }
    .standard-mode pre, .standard-mode code {
      font-size: 9pt !important;
    }

    @media print {
      .no-print {
        display: none !important;
      }
      body {
        ${firstPageStyle}
        background: #ffffff !important;
        color: #000000 !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      .paper-container,
      #document-body {
        display: contents !important;
        margin: 0 !important;
        padding: 0 !important;
        box-shadow: none !important;
        border: none !important;
        max-width: none !important;
        width: 100% !important;
      }
      .case-section {
        page-break-inside: auto !important;
        break-inside: auto !important;
        margin: 8pt 0 !important;
      }
      .case-section:last-child {
        margin-bottom: 0 !important;
      }
      .case-section:last-child > *:last-child {
        margin-bottom: 0 !important;
      }
      .folder-notes-section:last-child {
        margin-bottom: 0 !important;
      }
      .folder-header-wrap:last-child {
        margin-bottom: 0 !important;
      }
      .case-title {
        page-break-after: avoid !important;
        break-after: avoid !important;
      }
      .section-badge {
        page-break-after: avoid !important;
        break-after: avoid !important;
      }
      h1, h2, h3, h4 {
        page-break-after: avoid !important;
        break-after: avoid !important;
      }
      .folder-header-wrap {
        page-break-after: avoid !important;
        break-after: avoid !important;
        page-break-inside: avoid !important;
        break-inside: avoid !important;
      }
    }
  </style>
</head>
<body>
  <div class="top-bar no-print">
    <div class="top-bar-left">
      <div class="top-bar-title">${pageTitle}</div>
      <div class="top-bar-sub">${folderPath} &bull; <span style="color:#fcd34d;">Tip: In print settings, uncheck "Headers and footers" for a clean look without browser URLs.</span></div>
    </div>
    <div class="top-bar-actions">
      <div class="btn-group">
        <button id="btn-mode-compact" class="btn-toggle active" onclick="setLayoutMode('compact')" title="Save pages with compact margins and tight spacing">⚡ Compact (Save Pages)</button>
        <button id="btn-mode-standard" class="btn-toggle" onclick="setLayoutMode('standard')" title="Standard spacious layout">📐 Standard</button>
      </div>
      <div class="btn-group">
        <button id="btn-col-1" class="btn-toggle active" onclick="setColumns(1)" title="Single column width">📄 1 Col</button>
        <button id="btn-col-2" class="btn-toggle" onclick="setColumns(2)" title="2-column newspaper style for text-heavy summaries">📰 2 Col</button>
      </div>
      <button class="btn-print" onclick="window.print()">
        <span>Print / Save as PDF</span>
      </button>
      <button class="btn-close" onclick="window.close()">Close</button>
    </div>
  </div>

  <div class="paper-container"><div id="document-body">${htmlContent}</div></div>

  <script>
    function setLayoutMode(mode) {
      const container = document.getElementById('document-body');
      const btnCompact = document.getElementById('btn-mode-compact');
      const btnStandard = document.getElementById('btn-mode-standard');
      if (mode === 'compact') {
        container.classList.remove('standard-mode');
        btnCompact.classList.add('active');
        btnStandard.classList.remove('active');
      } else {
        container.classList.add('standard-mode');
        btnStandard.classList.add('active');
        btnCompact.classList.remove('active');
      }
    }

    function setColumns(cols) {
      const container = document.getElementById('document-body');
      const btn1 = document.getElementById('btn-col-1');
      const btn2 = document.getElementById('btn-col-2');
      if (cols === 2) {
        container.classList.add('two-column-layout');
        btn2.classList.add('active');
        btn1.classList.remove('active');
      } else {
        container.classList.remove('two-column-layout');
        btn1.classList.add('active');
        btn2.classList.remove('active');
      }
    }

    window.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        window.focus();
        window.print();
      }, 400);
    });
  </script>
</body>
</html>`;

  // 1. Try opening dedicated print preview tab
  const printWin = window.open('', '_blank');
  if (printWin) {
    printWin.document.open();
    printWin.document.write(fullDocumentHtml);
    printWin.document.close();
    toast('PDF export window opened — select "Save as PDF" to save.');
  } else {
    // 2. Fallback to hidden print iframe if popups are blocked
    let iframe = document.getElementById('export-print-frame');
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.id = 'export-print-frame';
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      document.body.appendChild(iframe);
    }
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(fullDocumentHtml);
    doc.close();
    setTimeout(() => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      toast('Print prompt opened — choose "Save as PDF"');
    }, 400);
  }
}
