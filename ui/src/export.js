import { S } from './state.js';
import { dbLoadNotepad } from './db.js';
import { toast } from './ui.js';
import { safeStorageGet } from './storage.js';
import { getCachedNotepad } from './notepad.js';

// Strip emojis using Unicode property escapes and common icon sets
export const stripEmojis = (str) => {
  if (!str) return '';
  return str
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D\u20E3]/gu, '')
    .replace(/[📖📑💾📥☁️⚙️📲📁📂📜⚖️📋📄✏️✕▶️◀️▲▼🕐🔍💡✨🔴🟠🟡🟢🔵🟣⚫⚪🟤]/g, '')
    .trim();
};

// Clean HTML to ensure dark text and strip light colors
export function cleanAndSanitizeHtml(html) {
  if (!html) return '';
  let clean = stripEmojis(html);
  // Replace inline light colors (white, off-white, light gray) with dark slate
  clean = clean
    .replace(/color:\s*(#[d-fD-F0-9]{3,6}|rgb\(\s*2[0-5][0-9]\s*,\s*2[0-5][0-9]\s*,\s*2[0-5][0-9]\s*\)|white|#fff|#f1f5f9|#e8e4db|#e0dbd2)/gi, 'color: #0f172a')
    .replace(/background:\s*(var\(--navy[^)]*\)|#0c1322|#141c2d|#1e293b|#101827)/gi, 'background: transparent');
  return clean;
}

// Clean HTML check to verify if a section contains actual text, tables, or images
export function hasMeaningfulContent(html) {
  if (!html) return false;
  const stripped = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  const hasImg = /<img\b/i.test(html);
  const hasTable = /<table\b/i.test(html);
  return stripped.length > 0 || hasImg || hasTable;
}

// Fetch notes and digest for a specific PDF (checking active memory, DB, and local cache)
export async function fetchPdfNotesAndDigest(pdf) {
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

  // 3. Fallbacks from local storage + Native SQLite Mirror
  if (!content) content = safeStorageGet('local_notepad_' + trueId, '') || '';
  if (!digest) digest = safeStorageGet('local_digest_' + trueId, '') || '';
  if ((!content || !digest) && window.__DESKTOP_SQLITE__?.loadPdfNote) {
    try {
      const sq = await window.__DESKTOP_SQLITE__.loadPdfNote(trueId);
      if (sq) {
        if (!content && sq.content) content = sq.content;
        if (!digest && sq.digest) digest = sq.digest;
      }
    } catch {}
  }

  return { content, digest };
}

// Fetch folder doc notes (checking in-memory folder record, local storage, and native SQLite mirror)
export async function fetchFolderNotes(folder) {
  if (!folder) return '';
  let folderNotes = folder.notes || safeStorageGet('local_folder_notes_' + folder.id, '') || '';
  if (!folderNotes && typeof window !== 'undefined' && window.__DESKTOP_SQLITE__?.loadFolderNote) {
    try {
      folderNotes = (await window.__DESKTOP_SQLITE__.loadFolderNote(folder.id)) || '';
    } catch {}
  }
  return folderNotes || '';
}

// Extract only the 1st summary <table> from an HTML string (ignoring untabled Facts/text below)
export function extractFirstTableFromHtml(html) {
  if (!html || !/<table\b/i.test(html)) return '';
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const firstTable = doc.querySelector('table');
    if (!firstTable) return '';
    firstTable.removeAttribute('id');
    firstTable.classList.remove('table-expandable');
    firstTable.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
    return firstTable.outerHTML;
  } catch {
    const m = html.match(/<table\b[\s\S]*?<\/table>/i);
    return m ? m[0] : '';
  }
}

// Extract all <table> elements from an HTML string (fallback for folder-level summary tables)
export function extractAllTablesFromHtml(html) {
  if (!html || !/<table\b/i.test(html)) return '';
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tables = Array.from(doc.querySelectorAll('table'));
    if (!tables.length) return '';
    return tables.map(t => {
      t.removeAttribute('id');
      t.classList.remove('table-expandable');
      t.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
      return t.outerHTML;
    }).join('<div style="height:6pt;"></div>');
  } catch {
    return '';
  }
}

// Fallback: check if the PDF has a summary table inside its Annotation Case Summary cards
export async function fetchFirstAnnotationTable(pdf) {
  const trueId = pdf.linked_pdf_id || pdf.id;
  try {
    const raw = safeStorageGet('local_anns_' + trueId, '');
    let anns = raw ? JSON.parse(raw) : (S.annotations || []).filter(a => a.pdf_file_id === trueId);
    if (!anns || !anns.length) {
      const { getOfflineRecord } = await import('./offline.js').catch(() => ({}));
      const rec = getOfflineRecord ? await getOfflineRecord(trueId) : null;
      if (rec && Array.isArray(rec.annotations)) anns = rec.annotations;
    }
    for (const ann of (anns || [])) {
      for (const n of (ann.notes || [])) {
        const tbl = extractFirstTableFromHtml(n.note_html || '');
        if (tbl) return tbl;
      }
    }
  } catch {}
  return '';
}

export function getFolderPathString(folder) {
  const parts = [];
  let currFolder = folder;
  const seen = new Set();
  while (currFolder && !seen.has(currFolder.id)) {
    seen.add(currFolder.id);
    const rawName = stripEmojis(currFolder.name) || 'Folder';
    parts.unshift(rawName);
    if (currFolder.parent_folder_id) {
      currFolder = S.folders.find(f => f.id === currFolder.parent_folder_id);
    } else {
      break;
    }
  }
  if (folder?.subject_id) {
    const subj = S.subjects.find(s => s.id === folder.subject_id);
    if (subj) {
      const subjName = stripEmojis(subj.name) || 'Subject';
      parts.unshift(subjName);
    }
  }
  return parts.join(' > ');
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getCleanPdfTitle(pdf) {
  return (stripEmojis(pdf?.name) || 'Case Document').replace(/\.pdf$/i, '').trim() || 'Case Document';
}

export function resolvePdfFolderPath(pdf) {
  const folderId = pdf?.folder_id ?? pdf?.folderId ?? null;
  const folder = folderId ? S.folders.find(f => f.id === folderId) : null;
  return folder ? getFolderPathString(folder) : 'Library';
}

// Build HTML section for a single PDF and register its named @page entry in caseRegistry
export async function buildPdfCaseHTML(pdf, caseRegistry = [], opts = {}) {
  if (!pdf) return '';
  if (opts.excludedPdfIds?.has(pdf.id)) return '';
  if (opts.seenPdfIds) {
    if (opts.seenPdfIds.has(pdf.id)) return '';
    opts.seenPdfIds.add(pdf.id);
  }

  const tablesOnly = Boolean(opts.tablesOnly);
  const includeDigest = opts.includeDigest !== false;
  const includeNotes = opts.includeNotes !== false;
  if (!tablesOnly && !includeDigest && !includeNotes) return '';

  const folderPath = opts.folder
    ? getFolderPathString(opts.folder)
    : resolvePdfFolderPath(pdf);

  const prefetched = opts.prefetched;
  const { content, digest } = prefetched
    ? { content: prefetched.content || '', digest: prefetched.digest || '' }
    : await fetchPdfNotesAndDigest(pdf);

  if (tablesOnly) {
    // Extract ONLY the 1st summary table (check Case Digest first, then Notes, then Annotation Case Summaries)
    const digestTable = includeDigest ? extractFirstTableFromHtml(digest) : '';
    const notesTable = includeNotes ? extractFirstTableFromHtml(content) : '';
    const annTable = (!digestTable && !notesTable)
      ? (prefetched && Object.prototype.hasOwnProperty.call(prefetched, 'annotationTable')
          ? (prefetched.annotationTable || '')
          : await fetchFirstAnnotationTable(pdf))
      : '';
    const firstTable = digestTable || notesTable || annTable;

    if (firstTable && hasMeaningfulContent(firstTable)) {
      const pdfName = getCleanPdfTitle(pdf);
      const pageId = `cp${caseRegistry.length}`;
      caseRegistry.push({ pageId, pdfName, folderPath });
      if (Array.isArray(opts.tocCollector)) {
        opts.tocCollector.push({ label: pdfName, sublabel: folderPath, badge: 'Summary Table' });
      }

      return `
        <div class="case-section" style="page: ${pageId}; margin: 8pt 0; padding: 8pt 10pt; border: 0.75pt solid #cbd5e1; border-radius: 4pt; background: #ffffff;">
          <div class="case-title" style="font-size: 10pt; font-weight: 700; color: #0f172a; margin-bottom: 5pt; border-bottom: 0.75pt solid #e2e8f0; padding-bottom: 2pt;">
            ${escapeHtml(pdfName)}
          </div>
          <div class="case-digest-body" style="color: #1e293b; line-height: 1.25;">
            ${cleanAndSanitizeHtml(firstTable)}
          </div>
        </div>
      `;
    }
    return '';
  }

  const hasDigest = includeDigest && hasMeaningfulContent(digest);
  const hasContent = includeNotes && hasMeaningfulContent(content);
  if (!hasDigest && !hasContent) return '';

  const pdfName = getCleanPdfTitle(pdf);
  const pageId = `cp${caseRegistry.length}`;
  caseRegistry.push({ pageId, pdfName, folderPath });
  if (Array.isArray(opts.tocCollector)) {
    const badges = [];
    if (hasDigest) badges.push('Case Digest');
    if (hasContent) badges.push('Notes');
    opts.tocCollector.push({ label: pdfName, sublabel: folderPath, badge: badges.join(' + ') });
  }

  let html = `
    <div class="case-section" style="page: ${pageId}; margin: 8pt 0; padding: 8pt 10pt; border: 0.75pt solid #cbd5e1; border-radius: 4pt; background: #ffffff;">
      <div class="case-title" style="font-size: 10pt; font-weight: 700; color: #0f172a; margin-bottom: 5pt; border-bottom: 0.75pt solid #e2e8f0; padding-bottom: 2pt;">
        ${escapeHtml(pdfName)}
      </div>
  `;

  // 1a. Case Digest
  if (hasDigest) {
    html += `
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
    html += `
      <div style="margin-top: 5pt;">
        <div class="section-badge" style="font-size: 7pt; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 2pt;">Appendix / Notes</div>
        <div class="case-notes-body" style="padding-left: 8pt; border-left: 2pt solid #64748b; color: #1e293b; line-height: 1.25;">
          ${cleanAndSanitizeHtml(content)}
        </div>
      </div>
    `;
  }

  html += `</div>`;
  return html;
}

// Build HTML tree for folder export. Only registers cases that actually have notes/digest (or a summary table in tablesOnly mode).
export async function buildFolderHTML(folderId, depth = 1, caseRegistry = [], opts = {}) {
  const visitedFolders = opts.visitedFolders || (opts.visitedFolders = new Set());
  if (!folderId || visitedFolders.has(folderId)) return '';
  if (opts.excludedFolderIds?.has(folderId)) return '';
  visitedFolders.add(folderId);
  const folder = S.folders.find(f => f.id === folderId);
  if (!folder) return '';

  const tablesOnly = Boolean(opts.tablesOnly);
  const includeFolderDocs = opts.includeFolderDocs !== false;
  const includeDigest = opts.includeDigest !== false;
  const includeNotes = opts.includeNotes !== false;
  const includeSubfolders = opts.includeSubfolders !== false;
  const startCaseIdx = caseRegistry.length;
  const startTocIdx = Array.isArray(opts.tocCollector) ? opts.tocCollector.length : -1;

  let casesHtml = '';
  let subfoldersHtml = '';
  let hasAnyContent = false;

  // 1. Cases / PDFs directly inside this folder
  const pdfs = S.pdfs
    .filter(p => p.folder_id === folderId)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  for (const pdf of pdfs) {
    const trueId = pdf.linked_pdf_id || pdf.id;
    const prefetched = opts.notesCache?.get(trueId);
    const pdfHtml = await buildPdfCaseHTML(pdf, caseRegistry, {
      tablesOnly,
      includeDigest,
      includeNotes,
      folder,
      prefetched,
      excludedPdfIds: opts.excludedPdfIds,
      seenPdfIds: opts.seenPdfIds,
      tocCollector: opts.tocCollector,
    });
    if (pdfHtml) {
      hasAnyContent = true;
      casesHtml += pdfHtml;
    }
  }

  // 2. Subfolders recursively
  if (includeSubfolders) {
    const subfolders = S.folders
      .filter(f => f.parent_folder_id === folderId)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

    for (const sf of subfolders) {
      const subHtml = await buildFolderHTML(sf.id, depth + 1, caseRegistry, opts);
      if (subHtml) {
        subfoldersHtml += subHtml;
        hasAnyContent = true;
      }
    }
  }

  // Determine the named page of the first case under this folder branch
  const firstCase = caseRegistry.length > startCaseIdx ? caseRegistry[startCaseIdx] : null;
  const firstPageStyle = firstCase ? `page: ${firstCase.pageId};` : '';

  // 3. Folder Notes
  let folderNotesHtml = '';
  if (includeFolderDocs) {
    const folderNotes = opts.folderNotesCache?.has(folder.id)
      ? opts.folderNotesCache.get(folder.id)
      : await fetchFolderNotes(folder);

    if (!tablesOnly && hasMeaningfulContent(folderNotes)) {
      hasAnyContent = true;
      if (Array.isArray(opts.tocCollector)) {
        const entry = {
          label: `${stripEmojis(folder.name) || 'Folder'} — Folder Notes`,
          sublabel: getFolderPathString(folder),
          badge: 'Folder Doc',
        };
        if (startTocIdx >= 0) opts.tocCollector.splice(startTocIdx, 0, entry);
        else opts.tocCollector.push(entry);
      }
      folderNotesHtml += `
        <div class="folder-notes-section" style="${firstPageStyle} margin-bottom: 10pt; padding: 6pt 10pt; background: #f8fafc; border: 0.75pt solid #e2e8f0; border-radius: 4pt; color: #1e293b; line-height: 1.25;">
          <div class="section-badge" style="font-size: 7pt; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3pt;">Folder Notes</div>
          <div class="note-content" style="color: #1e293b;">${cleanAndSanitizeHtml(folderNotes)}</div>
        </div>
      `;
    } else if (tablesOnly && !casesHtml && hasMeaningfulContent(folderNotes)) {
      // Fallback if a folder has summary tables stored inside Folder Notes rather than per-PDF digests
      const folderTables = extractAllTablesFromHtml(folderNotes);
      if (folderTables && hasMeaningfulContent(folderTables)) {
        hasAnyContent = true;
        if (Array.isArray(opts.tocCollector)) {
          const entry = {
            label: `${stripEmojis(folder.name) || 'Folder'} — Summary Tables`,
            sublabel: getFolderPathString(folder),
            badge: 'Folder Table',
          };
          if (startTocIdx >= 0) opts.tocCollector.splice(startTocIdx, 0, entry);
          else opts.tocCollector.push(entry);
        }
        folderNotesHtml += `
          <div class="folder-notes-section" style="${firstPageStyle} margin-bottom: 10pt; padding: 6pt 10pt; background: #ffffff; border: 0.75pt solid #cbd5e1; border-radius: 4pt; color: #1e293b; line-height: 1.25;">
            <div class="note-content" style="color: #1e293b;">${cleanAndSanitizeHtml(folderTables)}</div>
          </div>
        `;
      }
    }
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
    const folderName = escapeHtml(stripEmojis(folder.name) || 'Folder');
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

export async function flushPendingNotesForExport() {
  // Flush any pending active editor notes from memory to state
  try {
    const { flushFolderDoc } = await import('./viewer.js');
    await flushFolderDoc();
  } catch {}
  try {
    const { flushNotepadSave } = await import('./notepad.js');
    await flushNotepadSave();
  } catch {}
}

export async function exportFolderToPDF(foldersOrFolder, opts = {}) {
  const rawFolders = (Array.isArray(foldersOrFolder) ? foldersOrFolder : [foldersOrFolder]).filter(Boolean);
  // If a folder AND one of its subfolders are both selected, the subfolder is
  // already printed as part of its parent — drop it (and any duplicates) so it
  // is not printed twice. Selection order of the remaining folders is kept.
  const selectedIds = new Set(rawFolders.map(f => f.id));
  const seenIds = new Set();
  const folders = rawFolders.filter(f => {
    if (seenIds.has(f.id)) return false;
    seenIds.add(f.id);
    const guard = new Set();
    let parentId = f.parent_folder_id;
    while (parentId && !guard.has(parentId)) {
      if (selectedIds.has(parentId)) return false;
      guard.add(parentId);
      const parent = S.folders.find(x => x.id === parentId);
      parentId = parent ? parent.parent_folder_id : null;
    }
    return true;
  });
  if (!folders.length) return;
  const orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
  const tablesOnly = Boolean(opts.tablesOnly);

  await flushPendingNotesForExport();

  toast(tablesOnly ? 'Gathering summary tables for export...' : 'Gathering notes for export...');

  const caseRegistry = [];
  const visitedFolders = new Set();
  const htmlParts = [];
  for (const f of folders) {
    const depth = folders.length > 1 ? 2 : 1;
    const fHtml = await buildFolderHTML(f.id, depth, caseRegistry, { tablesOnly, visitedFolders });
    if (fHtml && hasMeaningfulContent(fHtml)) {
      htmlParts.push(fHtml);
    }
  }
  const htmlContent = htmlParts.join('\n');

  if (!htmlContent || !hasMeaningfulContent(htmlContent)) {
    toast(tablesOnly
      ? 'No summary tables found in the selected folder(s).'
      : 'No notes or digests found in the selected folder(s).');
    return;
  }

  toast(tablesOnly ? 'Preparing Summary Tables PDF...' : 'Preparing PDF export document...');

  const titleParts = folders.map(f => stripEmojis(f.name) || 'Folder');
  const titleSuffix = tablesOnly ? 'Summary Tables Only' : 'Notes & Case Digests';
  const pageTitle = folders.length > 1
    ? `${titleParts.join(', ')} — ${titleSuffix}`
    : `${titleParts[0]} — ${titleSuffix}`;
  const subtitleHtml = folders.length > 1
    ? `${folders.length} Folders: ${titleParts.map(escapeHtml).join(' &bull; ')}`
    : escapeHtml(getFolderPathString(folders[0]));
  const fallbackPath = folders.length > 1
    ? `${folders.length} Folders: ${titleParts.join(' / ')}`
    : getFolderPathString(folders[0]);

  renderExportPrintDocument({
    htmlContent,
    caseRegistry,
    orientation,
    pageTitle,
    subtitleHtml,
    fallbackPath,
  });
}

export async function exportPdfsToPDF(pdfsOrPdf, opts = {}) {
  const rawPdfs = (Array.isArray(pdfsOrPdf) ? pdfsOrPdf : [pdfsOrPdf]).filter(Boolean);
  const seenIds = new Set();
  const pdfs = rawPdfs.filter(p => {
    if (p.id) {
      if (seenIds.has(p.id)) return false;
      seenIds.add(p.id);
    }
    return true;
  });
  if (!pdfs.length) return;

  const orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
  const tablesOnly = Boolean(opts.tablesOnly);

  await flushPendingNotesForExport();

  toast(tablesOnly ? 'Gathering summary tables for export...' : 'Gathering notes for export...');

  const caseRegistry = [];
  const htmlParts = [];
  for (const pdf of pdfs) {
    const pdfHtml = await buildPdfCaseHTML(pdf, caseRegistry, { tablesOnly });
    if (pdfHtml && hasMeaningfulContent(pdfHtml)) {
      htmlParts.push(pdfHtml);
    }
  }
  const htmlContent = htmlParts.join('\n');

  if (!htmlContent || !hasMeaningfulContent(htmlContent)) {
    const singleLabel = getCleanPdfTitle(pdfs[0]);
    toast(tablesOnly
      ? (pdfs.length > 1
          ? 'No summary tables found in the selected PDFs.'
          : `No summary table found for "${singleLabel}".`)
      : (pdfs.length > 1
          ? 'No notes or digests found in the selected PDFs.'
          : `No notes or case digest found for "${singleLabel}".`));
    return;
  }

  toast(tablesOnly ? 'Preparing Summary Tables PDF...' : 'Preparing PDF export document...');

  const titleSuffix = tablesOnly ? 'Summary Tables Only' : 'Notes & Case Digests';
  let pageTitle;
  let subtitleHtml;
  let fallbackPath;

  if (pdfs.length === 1) {
    const pdfTitle = getCleanPdfTitle(pdfs[0]);
    const folderPath = resolvePdfFolderPath(pdfs[0]);
    pageTitle = `${pdfTitle} — ${titleSuffix}`;
    subtitleHtml = escapeHtml(folderPath);
    fallbackPath = folderPath;
  } else {
    pageTitle = `Selected PDFs (${pdfs.length}) — ${titleSuffix}`;
    const exportedNames = caseRegistry.map(c => c.pdfName);
    const previewNames = exportedNames.slice(0, 4).map(escapeHtml).join(' &bull; ');
    const moreSuffix = exportedNames.length > 4 ? ` &bull; +${exportedNames.length - 4} more` : '';
    const countLabel = exportedNames.length === pdfs.length
      ? `${pdfs.length} PDFs`
      : `${exportedNames.length} of ${pdfs.length} PDFs`;
    subtitleHtml = previewNames
      ? `${countLabel}: ${previewNames}${moreSuffix}`
      : countLabel;
    fallbackPath = 'Library';
  }

  renderExportPrintDocument({
    htmlContent,
    caseRegistry,
    orientation,
    pageTitle,
    subtitleHtml,
    fallbackPath,
  });
}

function resolvePrintPageMetrics(paperSize, orientation, marginPreset) {
  const paper = ['letter', 'a4', 'legal'].includes(paperSize) ? paperSize : 'letter';
  const orient = orientation === 'landscape' ? 'landscape' : 'portrait';
  const margin = ['normal', 'narrow', 'wide'].includes(marginPreset) ? marginPreset : 'normal';

  const dims = {
    letter: { w: '8.5in', h: '11in' },
    a4: { w: '210mm', h: '297mm' },
    legal: { w: '8.5in', h: '14in' },
  }[paper];

  const width = orient === 'landscape' ? dims.h : dims.w;
  const minHeight = orient === 'landscape' ? dims.w : dims.h;

  const margins = {
    narrow: { page: '0.45in 0.35in 0.45in 0.35in', preview: '0.35in' },
    normal: { page: '0.75in 0.5in 0.65in 0.5in', preview: '0.5in' },
    wide: { page: '1.0in 0.85in 0.9in 0.85in', preview: '0.85in' },
  }[margin];

  return {
    paper,
    orient,
    margin,
    width,
    minHeight,
    pageMargin: margins.page,
    previewPadding: margins.preview,
  };
}

function buildTocBlockHtml({ safeTitleHtml, subtitleHtml, tocEntries, caseRegistry, tablesOnly, hasBody }) {
  const entries = (Array.isArray(tocEntries) && tocEntries.length > 0)
    ? tocEntries
    : (caseRegistry || []).map(c => ({
        label: c.pdfName || 'Case Document',
        sublabel: c.folderPath || '',
        badge: tablesOnly ? 'Summary Table' : 'Case',
      }));

  const dateStr = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const rowsHtml = entries.length > 0
    ? entries.map((item, idx) => `
        <div class="ps-toc-row">
          <div class="ps-toc-num">${idx + 1}.</div>
          <div class="ps-toc-main">
            <div class="ps-toc-label">${escapeHtml(item.label || 'Untitled')}</div>
            ${item.sublabel ? `<div class="ps-toc-sub">${escapeHtml(item.sublabel)}</div>` : ''}
          </div>
          ${item.badge ? `<div class="ps-toc-badge">${escapeHtml(item.badge)}</div>` : ''}
        </div>
      `).join('')
    : `<div class="ps-toc-empty">No indexed sections in this packet.</div>`;

  return `
    <div class="print-cover-toc${hasBody ? ' has-page-break' : ''}">
      <div class="ps-cover-kicker">LEGAL ANNOTATOR &bull; PRINT PACKET</div>
      <h1 class="ps-cover-title">${safeTitleHtml}</h1>
      ${subtitleHtml ? `<div class="ps-cover-sub">${subtitleHtml}</div>` : ''}
      <div class="ps-cover-meta">
        <span>Generated ${escapeHtml(dateStr)}</span>
        <span>&bull;</span>
        <span>${entries.length} ${entries.length === 1 ? 'Section' : 'Sections'}</span>
        ${tablesOnly ? '<span>&bull;</span><span>Summary Tables Only</span>' : ''}
      </div>
      <div class="ps-toc-heading">Table of Contents</div>
      <div class="ps-toc-list">${rowsHtml}</div>
    </div>
  `;
}

export function buildPrintDocumentHTML(sectionsHtml, caseRegistry = [], opts = {}) {
  const pageTitle = opts.title || opts.pageTitle || 'Legal Print Studio';
  const safeTitleHtml = escapeHtml(pageTitle);
  const subtitleHtml = opts.subtitleHtml !== undefined
    ? String(opts.subtitleHtml || '')
    : escapeHtml(opts.subtitle || '');
  const fallbackPath = opts.fallbackPath || 'Library';

  const {
    paper,
    orient,
    width,
    minHeight,
    pageMargin,
    previewPadding,
  } = resolvePrintPageMetrics(opts.paperSize, opts.orientation, opts.marginPreset);

  const isStandard = opts.layout === 'standard';
  const isTwoCol = Number(opts.columns) === 2;
  const includeToc = Boolean(opts.includeToc);
  const tablesOnly = Boolean(opts.tablesOnly);
  const runningHeaders = opts.runningHeaders !== false;
  const embeddedPreview = Boolean(opts.embeddedPreview);
  const autoPrint = opts.autoPrint !== undefined ? Boolean(opts.autoPrint) : !embeddedPreview;
  const rawZoom = Number(opts.previewZoom);
  const previewZoom = Number.isFinite(rawZoom) && rawZoom >= 0.5 && rawZoom <= 2 ? rawZoom : 1;

  const firstPageStyle = runningHeaders && caseRegistry.length > 0
    ? `page: ${caseRegistry[0].pageId};`
    : '';

  // Build one @page rule per case with the case name and its own folder path hardcoded as CSS string literals
  const casePageCss = runningHeaders
    ? (caseRegistry || []).map(({ pageId, pdfName, folderPath: casePath }) => {
        const safeName = (pdfName || 'Case Document').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const safePath = (casePath || fallbackPath || 'Library').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
      }).join('\n')
    : '';

  const pageFooterCss = runningHeaders
    ? `
      @bottom-center {
        content: "Page " counter(page) " of " counter(pages);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, Arial, sans-serif;
        font-size: 7.5pt;
        color: #64748b;
        border-top: 0.5pt solid #cbd5e1;
        padding-top: 4pt;
        width: 100%;
        text-align: center;
      }`
    : `
      @top-left { content: none; }
      @top-right { content: none; }
      @bottom-center { content: none; }`;

  const hasBody = hasMeaningfulContent(sectionsHtml);
  const tocHtml = includeToc
    ? buildTocBlockHtml({
        safeTitleHtml,
        subtitleHtml,
        tocEntries: opts.tocEntries,
        caseRegistry,
        tablesOnly,
        hasBody,
      })
    : '';

  const bodyClassList = [
    isStandard ? 'standard-mode' : '',
    isTwoCol ? 'two-column-layout' : '',
  ].filter(Boolean).join(' ');

  const topBarHtml = embeddedPreview
    ? ''
    : `
  <div class="top-bar no-print">
    <div class="top-bar-left">
      <div class="top-bar-title">${safeTitleHtml}</div>
      <div class="top-bar-sub">${subtitleHtml} &bull; <span style="color:#fcd34d;">Tip: In print settings, uncheck "Headers and footers" for a clean look without browser URLs.</span></div>
    </div>
    <div class="top-bar-actions">
      <div class="btn-group">
        <button id="btn-mode-compact" class="btn-toggle${isStandard ? '' : ' active'}" onclick="setLayoutMode('compact')" title="Save pages with compact margins and tight spacing">⚡ Compact (Save Pages)</button>
        <button id="btn-mode-standard" class="btn-toggle${isStandard ? ' active' : ''}" onclick="setLayoutMode('standard')" title="Standard spacious layout">📐 Standard</button>
      </div>
      <div class="btn-group">
        <button id="btn-col-1" class="btn-toggle${isTwoCol ? '' : ' active'}" onclick="setColumns(1)" title="Single column width">📄 1 Col</button>
        <button id="btn-col-2" class="btn-toggle${isTwoCol ? ' active' : ''}" onclick="setColumns(2)" title="2-column newspaper style for text-heavy summaries">📰 2 Col</button>
      </div>
      <button class="btn-print" onclick="window.print()">
        <span>Print / Save as PDF</span>
      </button>
      <button class="btn-close" onclick="window.close()">Close</button>
    </div>
  </div>`;

  const scriptHtml = embeddedPreview
    ? ''
    : `
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
    ${autoPrint ? `
    window.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        window.focus();
        window.print();
      }, 400);
    });` : ''}
  </script>`;

  const deskBg = embeddedPreview ? '#e2e8f0' : '#f1f5f9';
  const paperWidthRule = embeddedPreview
    ? `width: ${width}; min-height: ${minHeight}; margin: 20px auto; padding: ${previewPadding};`
    : `max-width: ${width}; margin: 18px auto; padding: ${previewPadding};`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${safeTitleHtml}</title>
  <style>
    :root {
      color-scheme: only light;
    }
    @page {
      size: ${paper} ${orient};
      margin: ${pageMargin};
      ${pageFooterCss}
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
    html, body {
      color-scheme: only light;
      background: ${deskBg};
      color: #0f172a;
    }
    body {
      ${firstPageStyle}
      margin: 0;
      padding: 0;
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
      ${paperWidthRule}
      background: #ffffff;
      color: #0f172a;
      box-shadow: 0 4px 24px rgba(15, 23, 42, 0.14);
      border-radius: 4px;
      zoom: ${previewZoom};
    }

    /* Cover & Table of Contents */
    .print-cover-toc {
      margin: 0 0 12pt 0;
      padding: 12pt 14pt;
      border: 1pt solid #cbd5e1;
      border-top: 3pt solid #0f172a;
      border-radius: 4pt;
      background: #ffffff;
      color: #0f172a;
    }
    .print-cover-toc.has-page-break {
      page-break-after: always;
      break-after: page;
    }
    .ps-cover-kicker {
      font-size: 7pt;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #0369a1;
      margin-bottom: 4pt;
    }
    .ps-cover-title {
      margin: 0 0 4pt 0;
      font-size: 16pt;
      font-weight: 700;
      color: #0f172a;
      line-height: 1.2;
    }
    .ps-cover-sub {
      font-size: 9pt;
      color: #475569;
      margin-bottom: 6pt;
    }
    .ps-cover-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6pt;
      font-size: 8pt;
      color: #64748b;
      padding-bottom: 8pt;
      margin-bottom: 8pt;
      border-bottom: 0.75pt solid #e2e8f0;
    }
    .ps-toc-heading {
      font-size: 8pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #334155;
      margin-bottom: 6pt;
    }
    .ps-toc-list {
      display: flex;
      flex-direction: column;
      gap: 4pt;
    }
    .ps-toc-row {
      display: flex;
      align-items: baseline;
      gap: 8pt;
      padding: 3pt 0;
      border-bottom: 0.5pt dotted #e2e8f0;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .ps-toc-num {
      width: 20pt;
      flex-shrink: 0;
      font-size: 8.5pt;
      font-weight: 700;
      color: #475569;
    }
    .ps-toc-main {
      flex: 1;
      min-width: 0;
    }
    .ps-toc-label {
      font-size: 9pt;
      font-weight: 600;
      color: #0f172a;
    }
    .ps-toc-sub {
      font-size: 7.5pt;
      color: #64748b;
    }
    .ps-toc-badge {
      font-size: 7pt;
      font-weight: 600;
      color: #0369a1;
      background: #f0f9ff;
      border: 0.5pt solid #bae6fd;
      border-radius: 3pt;
      padding: 1pt 5pt;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .ps-toc-empty {
      font-size: 8.5pt;
      color: #64748b;
      font-style: italic;
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
    .two-column-layout .folder-header-wrap,
    .two-column-layout .print-cover-toc {
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
      html, body {
        ${firstPageStyle}
        background: #ffffff !important;
        color: #000000 !important;
        margin: 0 !important;
        padding: 0 !important;
        zoom: 1 !important;
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
        min-height: 0 !important;
        zoom: 1 !important;
      }
      .print-cover-toc {
        border: 0.75pt solid #cbd5e1 !important;
        border-top: 2.5pt solid #0f172a !important;
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
  ${topBarHtml}
  <div class="paper-container"><div id="document-body"${bodyClassList ? ` class="${bodyClassList}"` : ''}>${tocHtml}${sectionsHtml || ''}</div></div>
  ${scriptHtml}
</body>
</html>`;
}

function renderExportPrintDocument({ htmlContent, caseRegistry, orientation, pageTitle, subtitleHtml, fallbackPath }) {
  const fullDocumentHtml = buildPrintDocumentHTML(htmlContent, caseRegistry, {
    title: pageTitle,
    subtitleHtml,
    fallbackPath,
    orientation,
    paperSize: 'letter',
    layout: 'compact',
    columns: 1,
    includeToc: false,
    marginPreset: 'normal',
    runningHeaders: true,
    embeddedPreview: false,
    autoPrint: true,
  });

  // 1. In Tauri Desktop (or when popups are blocked), open interactive full-screen Export Preview Studio modal
  const isTauriDesktop = !!window.__TAURI_INTERNALS__;
  let printWin = !isTauriDesktop ? window.open('', '_blank') : null;
  if (printWin) {
    printWin.document.open();
    printWin.document.write(fullDocumentHtml);
    printWin.document.close();
    toast('PDF export window opened — select "Save as PDF" to save.');
  } else {
    let overlay = document.getElementById('desktop-export-preview-modal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'desktop-export-preview-modal';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(12,19,34,0.92);display:flex;flex-direction:column;';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = '';
    overlay.style.display = 'flex';

    const iframe = document.createElement('iframe');
    iframe.id = 'export-print-frame';
    iframe.style.cssText = 'width:100%;height:100%;border:0;background:#f1f5f9;';
    overlay.appendChild(iframe);

    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(fullDocumentHtml);
    doc.close();

    // Wire window.close() inside the preview iframe to dismiss the overlay
    iframe.contentWindow.close = () => {
      overlay.style.display = 'none';
      overlay.innerHTML = '';
    };
    toast('📄 PDF Export Preview opened — choose Compact/Standard or 1/2 Columns, then Save as PDF.');
  }
}
