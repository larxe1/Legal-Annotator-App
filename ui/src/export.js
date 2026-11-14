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

// Build HTML section for a single PDF and register its entry in caseRegistry
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
      const tocId = 'toc-' + (Array.isArray(opts.tocCollector) ? opts.tocCollector.length : caseRegistry.length);
      caseRegistry.push({ pageId, tocId, pdfName, folderPath });
      if (Array.isArray(opts.tocCollector)) {
        opts.tocCollector.push({ tocId, label: pdfName, kind: 'case' });
      }

      return `
        <div class="case-section" data-toc-id="${tocId}" data-case-name="${escapeHtml(pdfName)}" data-folder-path="${escapeHtml(folderPath)}" style="margin: 4pt 0; padding: 5pt 8pt; border: 0.75pt solid #cbd5e1; border-radius: 4pt; background: #ffffff;">
          <div class="case-title" style="font-size: 10pt; font-weight: 700; color: #0f172a; margin-bottom: 3pt; border-bottom: 0.75pt solid #e2e8f0; padding-bottom: 2pt;">
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
  const tocId = 'toc-' + (Array.isArray(opts.tocCollector) ? opts.tocCollector.length : caseRegistry.length);
  caseRegistry.push({ pageId, tocId, pdfName, folderPath });
  if (Array.isArray(opts.tocCollector)) {
    opts.tocCollector.push({ tocId, label: pdfName, kind: 'case' });
  }

  let html = `
    <div class="case-section" data-toc-id="${tocId}" data-case-name="${escapeHtml(pdfName)}" data-folder-path="${escapeHtml(folderPath)}" style="margin: 4pt 0; padding: 5pt 8pt; border: 0.75pt solid #cbd5e1; border-radius: 4pt; background: #ffffff;">
      <div class="case-title" style="font-size: 10pt; font-weight: 700; color: #0f172a; margin-bottom: 3pt; border-bottom: 0.75pt solid #e2e8f0; padding-bottom: 2pt;">
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
  const startTocIdx = Array.isArray(opts.tocCollector) ? opts.tocCollector.length : -1;
  const folderName = stripEmojis(folder.name) || 'Folder';
  const folderPathStr = getFolderPathString(folder);

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
    if (pdfHtml && hasMeaningfulContent(pdfHtml)) {
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
      if (subHtml && hasMeaningfulContent(subHtml)) {
        subfoldersHtml += subHtml;
        hasAnyContent = true;
      }
    }
  }

  // 3. Folder Notes
  let folderNotesHtml = '';
  if (includeFolderDocs) {
    const folderNotes = opts.folderNotesCache?.has(folder.id)
      ? opts.folderNotesCache.get(folder.id)
      : await fetchFolderNotes(folder);

    if (!tablesOnly && hasMeaningfulContent(folderNotes)) {
      hasAnyContent = true;
      const tocId = 'toc-' + (Array.isArray(opts.tocCollector) ? opts.tocCollector.length : caseRegistry.length);
      if (Array.isArray(opts.tocCollector)) {
        const entry = {
          tocId,
          label: `${folderName} (Notes)`,
          kind: 'folder',
        };
        if (startTocIdx >= 0) opts.tocCollector.splice(startTocIdx, 0, entry);
        else opts.tocCollector.push(entry);
      }
      folderNotesHtml += `
        <div class="folder-notes-section" data-toc-id="${tocId}" data-case-name="${escapeHtml(folderName)}" data-folder-path="${escapeHtml(folderPathStr)}" style="margin: 4pt 0 6pt 0; padding: 5pt 8pt; background: #f8fafc; border: 0.75pt solid #e2e8f0; border-radius: 4pt; color: #1e293b; line-height: 1.25;">
          <div class="section-badge" style="font-size: 7pt; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3pt;">Folder Notes</div>
          <div class="note-content" style="color: #1e293b;">${cleanAndSanitizeHtml(folderNotes)}</div>
        </div>
      `;
    } else if (tablesOnly && !casesHtml && hasMeaningfulContent(folderNotes)) {
      // Fallback if a folder has summary tables stored inside Folder Notes rather than per-PDF digests
      const folderTables = extractAllTablesFromHtml(folderNotes);
      if (folderTables && hasMeaningfulContent(folderTables)) {
        hasAnyContent = true;
        const tocId = 'toc-' + (Array.isArray(opts.tocCollector) ? opts.tocCollector.length : caseRegistry.length);
        if (Array.isArray(opts.tocCollector)) {
          const entry = {
            tocId,
            label: `${folderName} (Notes)`,
            kind: 'folder',
          };
          if (startTocIdx >= 0) opts.tocCollector.splice(startTocIdx, 0, entry);
          else opts.tocCollector.push(entry);
        }
        folderNotesHtml += `
          <div class="folder-notes-section" data-toc-id="${tocId}" data-case-name="${escapeHtml(folderName)}" data-folder-path="${escapeHtml(folderPathStr)}" style="margin: 4pt 0 6pt 0; padding: 5pt 8pt; background: #ffffff; border: 0.75pt solid #cbd5e1; border-radius: 4pt; color: #1e293b; line-height: 1.25;">
            <div class="note-content" style="color: #1e293b;">${cleanAndSanitizeHtml(folderTables)}</div>
          </div>
        `;
      }
    }
  }

  const hasNotes = Boolean(folderNotesHtml && hasMeaningfulContent(folderNotesHtml));
  const hasCases = Boolean(casesHtml && hasMeaningfulContent(casesHtml));
  const hasSubs = Boolean(subfoldersHtml && hasMeaningfulContent(subfoldersHtml));

  if (!hasAnyContent || (!hasNotes && !hasCases && !hasSubs)) return '';

  // 4. Folder Header:
  // Depth=1 is the top-level exported folder — its name is already in the running header,
  // so we skip the h1 to avoid duplicate titles.
  // Subfolders (depth >= 2) get an hN section divider ONLY if this folder has direct notes or cases.
  let headerHtml = '';
  if (depth >= 2 && (hasNotes || hasCases)) {
    const safeFolderName = escapeHtml(folderName);
    const hSize = depth === 2 ? '11.5pt' : '10.5pt';
    const hTag = depth === 2 ? 'h2' : 'h3';
    headerHtml = `
      <div class="folder-header-wrap" style="margin-top: 8pt; margin-bottom: 4pt; page-break-after: avoid; break-after: avoid;">
        <${hTag} style="margin: 0 0 3pt 0; font-size: ${hSize}; color: #0f172a; font-weight: 700; border-bottom: 1.5pt solid #334155; padding-bottom: 2pt;">
          ${safeFolderName}
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
  const paper = ['letter', 'a4', 'legal'].includes(paperSize) ? paperSize : 'a4';
  const orient = orientation === 'landscape' ? 'landscape' : 'portrait';
  const margin = ['normal', 'narrow', 'wide'].includes(marginPreset) ? marginPreset : 'narrow';

  const dims = {
    letter: { w: '8.5in', h: '11in' },
    a4: { w: '210mm', h: '297mm' },
    legal: { w: '8.5in', h: '14in' },
  }[paper];

  const width = orient === 'landscape' ? dims.h : dims.w;
  const minHeight = orient === 'landscape' ? dims.w : dims.h;

  const margins = {
    narrow: { page: '0.32in', preview: '0.32in' },
    normal: { page: '0.55in', preview: '0.55in' },
    wide: { page: '0.8in', preview: '0.8in' },
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

function buildTocBlockHtml({ tocEntries, caseRegistry }) {
  const entries = (Array.isArray(tocEntries) && tocEntries.length > 0)
    ? tocEntries
    : (caseRegistry || []).map((c, idx) => ({
        tocId: c.tocId || ('toc-' + idx),
        label: c.pdfName || 'Case Document',
        kind: 'case',
      }));

  const rowsHtml = entries.length > 0
    ? entries.map((item, idx) => `
        <div class="ps-toc-row" data-toc-target="${escapeHtml(item.tocId || ('toc-' + idx))}">
          <span class="ps-toc-title-text">${escapeHtml(item.label || 'Untitled')}</span>
          <span class="ps-toc-leader" aria-hidden="true"></span>
          <span class="ps-toc-page">1</span>
        </div>
      `).join('')
    : `<div class="ps-toc-empty">No indexed sections in this packet.</div>`;

  return `
    <div class="print-toc-block" id="ps-toc-block">
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
    previewPadding,
  } = resolvePrintPageMetrics(opts.paperSize, opts.orientation, opts.marginPreset);

  const layoutMode = opts.layout === 'standard'
    ? 'standard'
    : (opts.layout === 'compact' ? 'compact' : 'tight');
  const isStandard = layoutMode === 'standard';
  const isTight = layoutMode === 'tight';
  const isTwoCol = Number(opts.columns) === 2;
  const includeToc = Boolean(opts.includeToc);
  const runningHeaders = opts.runningHeaders !== false;
  const embeddedPreview = Boolean(opts.embeddedPreview);
  const autoPrint = opts.autoPrint !== undefined ? Boolean(opts.autoPrint) : !embeddedPreview;
  const rawZoom = Number(opts.previewZoom);
  const previewZoom = Number.isFinite(rawZoom) && rawZoom >= 0.5 && rawZoom <= 2 ? rawZoom : 1;

  const tocHtml = includeToc
    ? buildTocBlockHtml({
        tocEntries: opts.tocEntries,
        caseRegistry,
      })
    : '';

  const bodyClassList = [
    isTight ? 'tight-mode' : '',
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
        <button id="btn-mode-tight" class="btn-toggle${isTight ? ' active' : ''}" onclick="setLayoutMode('tight')" title="Ultra-dense layout for maximum content per page">⚡ Tight</button>
        <button id="btn-mode-compact" class="btn-toggle${layoutMode === 'compact' ? ' active' : ''}" onclick="setLayoutMode('compact')" title="Save pages with compact margins and tight spacing">Compact</button>
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

  const standaloneControlsScript = embeddedPreview
    ? ''
    : `
    function setLayoutMode(mode) {
      var container = document.getElementById('document-body');
      var btnTight = document.getElementById('btn-mode-tight');
      var btnCompact = document.getElementById('btn-mode-compact');
      var btnStandard = document.getElementById('btn-mode-standard');
      if (!container) return;
      container.classList.remove('tight-mode', 'standard-mode');
      if (btnTight) btnTight.classList.remove('active');
      if (btnCompact) btnCompact.classList.remove('active');
      if (btnStandard) btnStandard.classList.remove('active');
      if (mode === 'standard') {
        container.classList.add('standard-mode');
        if (btnStandard) btnStandard.classList.add('active');
      } else if (mode === 'compact') {
        if (btnCompact) btnCompact.classList.add('active');
      } else {
        container.classList.add('tight-mode');
        if (btnTight) btnTight.classList.add('active');
      }
      if (typeof window.paginateDocumentIntoPages === 'function') {
        window.paginateDocumentIntoPages();
      }
    }

    function setColumns(cols) {
      var container = document.getElementById('document-body');
      var btn1 = document.getElementById('btn-col-1');
      var btn2 = document.getElementById('btn-col-2');
      if (!container) return;
      if (cols === 2) {
        container.classList.add('two-column-layout');
        if (btn2) btn2.classList.add('active');
        if (btn1) btn1.classList.remove('active');
      } else {
        container.classList.remove('two-column-layout');
        if (btn1) btn1.classList.add('active');
        if (btn2) btn2.classList.remove('active');
      }
      if (typeof window.paginateDocumentIntoPages === 'function') {
        window.paginateDocumentIntoPages();
      }
    }
    `;

  const scriptHtml = `
  <script>
    (function() {
      var runningHeaders = ${runningHeaders ? 'true' : 'false'};
      var SHOW_TOC = ${includeToc ? 'true' : 'false'};
      var fallbackPath = ${JSON.stringify(fallbackPath || 'Library')};
      var docTitle = ${JSON.stringify(pageTitle || 'Legal Print Studio')};

      function renumberPagesAndToc() {
        var pagesRoot = document.getElementById('ps-pages-root');
        if (!pagesRoot) return;
        var sheets = Array.from(pagesRoot.querySelectorAll('.ps-page-sheet'));
        var total = sheets.length;
        var activePath = fallbackPath;
        var activeName = docTitle;
        var lastSec = docTitle;

        for (var i = 0; i < total; i++) {
          var sheet = sheets[i];
          var pageNum = i + 1;
          sheet.setAttribute('data-page-num', String(pageNum));

          var namedNodes = sheet.querySelectorAll('[data-case-name]');
          var firstNamed = namedNodes.length > 0 ? namedNodes[0] : null;
          var lastNamed = namedNodes.length > 0 ? namedNodes[namedNodes.length - 1] : null;
          var hdrPath = firstNamed ? (firstNamed.getAttribute('data-folder-path') || activePath) : activePath;
          var hdrName = firstNamed ? (firstNamed.getAttribute('data-case-name') || activeName) : activeName;

          var secNodes = sheet.querySelectorAll('[data-section-title]');
          var firstSec = secNodes.length > 0 ? secNodes[0] : null;
          var lastSecNode = secNodes.length > 0 ? secNodes[secNodes.length - 1] : null;
          var hdrSecText = firstSec ? (firstSec.getAttribute('data-section-title') || lastSec) : lastSec;

          if (runningHeaders) {
            var hdrLeft = sheet.querySelector('.ps-page-hdr-left');
            var hdrRight = sheet.querySelector('.ps-page-hdr-right');
            var hdrSec = sheet.querySelector('.ps-hdr-sec');
            var ftr = sheet.querySelector('.ps-page-ftr');
            if (hdrLeft) hdrLeft.textContent = hdrPath;
            if (hdrRight) hdrRight.textContent = hdrName;
            if (hdrSec) hdrSec.textContent = hdrSecText;
            if (ftr) ftr.textContent = 'Page ' + pageNum + ' of ' + total;
          }

          if (lastNamed) {
            activePath = lastNamed.getAttribute('data-folder-path') || activePath;
            activeName = lastNamed.getAttribute('data-case-name') || activeName;
          }
          if (lastSecNode) {
            lastSec = lastSecNode.getAttribute('data-section-title') || lastSec;
          }

          var toolsLabel = sheet.querySelector('.ps-page-tools-label');
          if (toolsLabel) {
            toolsLabel.textContent = 'Page ' + pageNum + ' of ' + total + ' • Click text to edit';
          }
        }

        if (SHOW_TOC) {
          var tocRows = pagesRoot.querySelectorAll('.ps-toc-row[data-toc-target]');
          var visibleCount = 0;
          for (var tIdx = 0; tIdx < tocRows.length; tIdx++) {
            var row = tocRows[tIdx];
            var targetId = row.getAttribute('data-toc-target');
            if (!targetId) continue;
            var escapedId = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(targetId) : targetId;
            var targetEl = pagesRoot.querySelector('[data-toc-id="' + escapedId + '"]');
            var targetSheet = targetEl ? targetEl.closest('.ps-page-sheet') : null;
            if (targetSheet) {
              visibleCount++;
              row.style.display = '';
              var numSpan = row.querySelector('.ps-toc-num');
              if (numSpan) numSpan.textContent = visibleCount + '.';
              var pageSpan = row.querySelector('.ps-toc-page');
              var targetPageNum = targetSheet.getAttribute('data-page-num');
              if (pageSpan && targetPageNum) {
                pageSpan.textContent = targetPageNum;
              }
            } else {
              row.style.display = 'none';
            }
          }
        }

        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'ps-pagination-done', pageCount: total }, '*');
        }
      }
      window.renumberPagesAndToc = renumberPagesAndToc;

      function isHeadingEl(el) {
        if (!el || el.nodeType !== 1) return false;
        var tag = el.tagName;
        if (/^H[1-6]$/.test(tag)) return true;
        var cls = el.classList;
        return cls.contains('case-title') ||
          cls.contains('section-badge') ||
          cls.contains('np-banner-hdr') ||
          cls.contains('folder-header-wrap') ||
          cls.contains('ps-toc-heading');
      }

      function hasMeaningfulDom(node) {
        if (!node) return false;
        if (node.nodeType === 3) return node.nodeValue.trim().length > 0;
        if (node.nodeType !== 1) return false;
        var tag = node.tagName;
        if (tag === 'IMG' || tag === 'TABLE' || tag === 'HR') return true;
        if (node.querySelector && node.querySelector('img, table, hr')) return true;
        return (node.textContent || '').trim().length > 0;
      }

      function isSplittableContainer(el) {
        if (!el || el.nodeType !== 1) return false;
        var cls = el.classList;
        if (cls.contains('case-section') ||
            cls.contains('folder-notes-section') ||
            cls.contains('case-digest-body') ||
            cls.contains('case-notes-body') ||
            cls.contains('note-content') ||
            cls.contains('print-toc-block') ||
            cls.contains('ps-toc-list')) {
          return true;
        }
        var tag = el.tagName;
        if (tag === 'BLOCKQUOTE') return true;
        if (tag === 'DIV' && !isHeadingEl(el) && !cls.contains('ps-toc-row')) {
          return el.children.length > 0;
        }
        return false;
      }

      function splitTextNodeWords(textNode, targetParent, colEl, maxH) {
        var text = textNode.nodeValue || '';
        if (!text.trim()) {
          var ws = document.createTextNode(text);
          targetParent.appendChild(ws);
          return { topNode: ws, restText: '' };
        }
        var tokens = text.match(/\\S+\\s*|\\s+/g) || [text];
        var tn = document.createTextNode('');
        targetParent.appendChild(tn);

        tn.nodeValue = text;
        if (colEl.scrollHeight <= maxH) {
          return { topNode: tn, restText: '' };
        }

        var lo = 1;
        var hi = tokens.length - 1;
        var best = 0;
        while (lo <= hi) {
          var mid = (lo + hi) >> 1;
          tn.nodeValue = tokens.slice(0, mid).join('').replace(/\\s+$/, '');
          if (colEl.scrollHeight <= maxH) {
            best = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }

        if (best === 0) {
          targetParent.removeChild(tn);
          return { topNode: null, restText: text };
        }

        var fitStr = tokens.slice(0, best).join('').replace(/\\s+$/, '');
        if (!fitStr.trim()) {
          targetParent.removeChild(tn);
          return { topNode: null, restText: text };
        }
        tn.nodeValue = fitStr;
        var restText = tokens.slice(best).join('').replace(/^\\s+/, '');
        return { topNode: tn, restText: restText };
      }

      function splitInlineChildrenInto(origParent, topParent, restParent, colEl, maxH) {
        var nodes = Array.from(origParent.childNodes);
        for (var i = 0; i < nodes.length; i++) {
          var child = nodes[i];
          if (child.nodeType === 3 && !(child.nodeValue || '').trim()) {
            topParent.appendChild(child.cloneNode(true));
            continue;
          }
          var cClone = child.cloneNode(true);
          topParent.appendChild(cClone);
          if (colEl.scrollHeight <= maxH) {
            continue;
          }
          topParent.removeChild(cClone);

          if (child.nodeType === 3) {
            var res = splitTextNodeWords(child, topParent, colEl, maxH);
            if (res.restText) {
              restParent.appendChild(document.createTextNode(res.restText));
            }
            for (var j = i + 1; j < nodes.length; j++) {
              restParent.appendChild(nodes[j].cloneNode(true));
            }
            return;
          }

          if (child.nodeType === 1 && child.tagName !== 'IMG' && child.tagName !== 'BR' && child.tagName !== 'HR') {
            var subTop = child.cloneNode(false);
            var subRest = child.cloneNode(false);
            topParent.appendChild(subTop);
            splitInlineChildrenInto(child, subTop, subRest, colEl, maxH);
            if (!hasMeaningfulDom(subTop)) {
              topParent.removeChild(subTop);
            }
            if (hasMeaningfulDom(subRest)) {
              restParent.appendChild(subRest);
            } else if (!hasMeaningfulDom(subTop)) {
              restParent.appendChild(child.cloneNode(true));
            }
            for (var k = i + 1; k < nodes.length; k++) {
              restParent.appendChild(nodes[k].cloneNode(true));
            }
            return;
          }

          for (var m = i; m < nodes.length; m++) {
            restParent.appendChild(nodes[m].cloneNode(true));
          }
          return;
        }
      }

      function splitInlineBlock(el, parentTarget, colEl, maxH, colWasEmpty) {
        var remPx = maxH - colEl.scrollHeight;
        if (!colWasEmpty && remPx < 32) {
          return { top: null, rest: el };
        }
        var topEl = el.cloneNode(false);
        var restEl = el.cloneNode(false);
        parentTarget.appendChild(topEl);

        splitInlineChildrenInto(el, topEl, restEl, colEl, maxH);

        if (!hasMeaningfulDom(topEl)) {
          parentTarget.removeChild(topEl);
          if (colWasEmpty) {
            var forced = el.cloneNode(true);
            parentTarget.appendChild(forced);
            return { top: forced, rest: null };
          }
          return { top: null, rest: el };
        }
        if (!hasMeaningfulDom(restEl)) {
          return { top: topEl, rest: null };
        }
        if (el.tagName === 'LI') {
          restEl.style.listStyleType = 'none';
        }
        return { top: topEl, rest: restEl };
      }

      function splitCellContentInto(origCell, topCell, restCell, colEl, maxH) {
        var nodes = Array.from(origCell.childNodes);
        for (var i = 0; i < nodes.length; i++) {
          var child = nodes[i];
          if (child.nodeType === 3 && !(child.nodeValue || '').trim()) {
            topCell.appendChild(child.cloneNode(true));
            continue;
          }
          var cClone = child.cloneNode(true);
          topCell.appendChild(cClone);
          if (colEl.scrollHeight <= maxH) {
            continue;
          }
          topCell.removeChild(cClone);

          if (child.nodeType === 3) {
            var tRes = splitTextNodeWords(child, topCell, colEl, maxH);
            if (tRes.restText) {
              restCell.appendChild(document.createTextNode(tRes.restText));
            }
            for (var j = i + 1; j < nodes.length; j++) {
              restCell.appendChild(nodes[j].cloneNode(true));
            }
            return;
          }

          if (child.nodeType === 1) {
            var subRes = trySplitElement(child, topCell, colEl, maxH, false);
            if (subRes.top) {
              if (subRes.rest) restCell.appendChild(subRes.rest);
              for (var k = i + 1; k < nodes.length; k++) {
                restCell.appendChild(nodes[k].cloneNode(true));
              }
              return;
            }
            if (child.tagName !== 'IMG' && child.tagName !== 'TABLE' && child.tagName !== 'BR' && child.tagName !== 'HR') {
              var subTop = child.cloneNode(false);
              var subRest = child.cloneNode(false);
              topCell.appendChild(subTop);
              splitInlineChildrenInto(child, subTop, subRest, colEl, maxH);
              if (hasMeaningfulDom(subTop)) {
                if (hasMeaningfulDom(subRest)) restCell.appendChild(subRest);
                for (var m = i + 1; m < nodes.length; m++) {
                  restCell.appendChild(nodes[m].cloneNode(true));
                }
                return;
              }
              topCell.removeChild(subTop);
            }
          }

          for (var n = i; n < nodes.length; n++) {
            restCell.appendChild(nodes[n].cloneNode(true));
          }
          return;
        }
      }

      function splitTableRow(tr, topTbody, colEl, maxH, forceFirstRow) {
        var cells = Array.from(tr.children);
        if (cells.length === 0) return { trTop: null, trRest: tr };
        if (cells.some(function(c) { return (c.rowSpan || 1) > 1; })) {
          return { trTop: null, trRest: tr };
        }

        var trTop = tr.cloneNode(false);
        var trRest = tr.cloneNode(false);
        topTbody.appendChild(trTop);

        var topCells = [];
        var restCells = [];
        for (var ci = 0; ci < cells.length; ci++) {
          var tc = cells[ci].cloneNode(false);
          var rc = cells[ci].cloneNode(false);
          trTop.appendChild(tc);
          trRest.appendChild(rc);
          topCells.push(tc);
          restCells.push(rc);
        }

        var anyCellSplitFailed = false;
        for (var cIdx = 0; cIdx < cells.length; cIdx++) {
          var origCell = cells[cIdx];
          var topCell = topCells[cIdx];
          var restCell = restCells[cIdx];

          for (var k = 0; k < origCell.childNodes.length; k++) {
            topCell.appendChild(origCell.childNodes[k].cloneNode(true));
          }
          if (colEl.scrollHeight <= maxH) {
            continue;
          }

          topCell.innerHTML = '';
          splitCellContentInto(origCell, topCell, restCell, colEl, maxH);
          if (hasMeaningfulDom(origCell) && !hasMeaningfulDom(topCell)) {
            anyCellSplitFailed = true;
          }
        }

        if (anyCellSplitFailed && !forceFirstRow) {
          topTbody.removeChild(trTop);
          return { trTop: null, trRest: tr };
        }

        var topHasAny = topCells.some(hasMeaningfulDom);
        var restHasAny = restCells.some(hasMeaningfulDom);

        if (!topHasAny) {
          topTbody.removeChild(trTop);
          return { trTop: null, trRest: tr };
        }
        if (!restHasAny) {
          return { trTop: trTop, trRest: null };
        }
        return { trTop: trTop, trRest: trRest };
      }

      function splitTable(table, parentTarget, colEl, maxH, colWasEmpty) {
        var colgroup = table.querySelector(':scope > colgroup');
        var thead = table.querySelector(':scope > thead');
        var tfoot = table.querySelector(':scope > tfoot');

        var rows = [];
        var tableChildren = Array.from(table.children);
        for (var tc = 0; tc < tableChildren.length; tc++) {
          var ch = tableChildren[tc];
          if (ch.tagName === 'TBODY') {
            var bodyRows = Array.from(ch.children);
            for (var br = 0; br < bodyRows.length; br++) {
              if (bodyRows[br].tagName === 'TR') rows.push(bodyRows[br]);
            }
          } else if (ch.tagName === 'TR') {
            rows.push(ch);
          }
        }

        if (rows.length === 0) {
          if (colWasEmpty) {
            var forcedTable = table.cloneNode(true);
            parentTarget.appendChild(forcedTable);
            return { top: forcedTable, rest: null };
          }
          return { top: null, rest: table };
        }

        var topTable = table.cloneNode(false);
        var restTable = table.cloneNode(false);
        if (colgroup) {
          topTable.appendChild(colgroup.cloneNode(true));
          restTable.appendChild(colgroup.cloneNode(true));
        }
        if (thead) {
          topTable.appendChild(thead.cloneNode(true));
          restTable.appendChild(thead.cloneNode(true));
        }
        var topTbody = document.createElement('tbody');
        var restTbody = document.createElement('tbody');
        topTable.appendChild(topTbody);
        restTable.appendChild(restTbody);
        parentTarget.appendChild(topTable);

        if (!colWasEmpty && colEl.scrollHeight > maxH) {
          parentTarget.removeChild(topTable);
          return { top: null, rest: table };
        }

        var rowsPlaced = 0;
        for (var r = 0; r < rows.length; r++) {
          var tr = rows[r];
          var trClone = tr.cloneNode(true);
          topTbody.appendChild(trClone);
          if (colEl.scrollHeight <= maxH) {
            rowsPlaced++;
            continue;
          }
          topTbody.removeChild(trClone);

          var remPx = maxH - colEl.scrollHeight;
          if (remPx >= 38 || (colWasEmpty && rowsPlaced === 0)) {
            var rowRes = splitTableRow(tr, topTbody, colEl, maxH, colWasEmpty && rowsPlaced === 0);
            if (rowRes.trTop) {
              rowsPlaced++;
              if (rowRes.trRest) restTbody.appendChild(rowRes.trRest);
              for (var r2 = r + 1; r2 < rows.length; r2++) {
                restTbody.appendChild(rows[r2].cloneNode(true));
              }
              break;
            }
          }

          if (colWasEmpty && rowsPlaced === 0) {
            topTbody.appendChild(tr.cloneNode(true));
            rowsPlaced++;
            for (var r3 = r + 1; r3 < rows.length; r3++) {
              restTbody.appendChild(rows[r3].cloneNode(true));
            }
            break;
          }

          for (var r4 = r; r4 < rows.length; r4++) {
            restTbody.appendChild(rows[r4].cloneNode(true));
          }
          break;
        }

        if (rowsPlaced === 0) {
          parentTarget.removeChild(topTable);
          return { top: null, rest: table };
        }

        if (restTbody.children.length === 0) {
          if (tfoot) {
            var tf = tfoot.cloneNode(true);
            topTable.appendChild(tf);
            if (!colWasEmpty && colEl.scrollHeight > maxH) {
              topTable.removeChild(tf);
              restTable.appendChild(tfoot.cloneNode(true));
              return { top: topTable, rest: restTable };
            }
          }
          return { top: topTable, rest: null };
        }

        if (tfoot) {
          restTable.appendChild(tfoot.cloneNode(true));
        }
        return { top: topTable, rest: restTable };
      }

      function splitList(listEl, parentTarget, colEl, maxH, colWasEmpty) {
        var isOl = listEl.tagName === 'OL';
        var startNum = isOl ? (parseInt(listEl.getAttribute('start'), 10) || 1) : 1;
        var topList = listEl.cloneNode(false);
        var restList = listEl.cloneNode(false);
        parentTarget.appendChild(topList);

        var items = Array.from(listEl.children);
        var placedItems = 0;
        var splitCurrent = false;

        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var clone = item.cloneNode(true);
          topList.appendChild(clone);
          if (colEl.scrollHeight <= maxH) {
            placedItems++;
            continue;
          }
          topList.removeChild(clone);

          var res = trySplitElement(item, topList, colEl, maxH, colWasEmpty && placedItems === 0);
          if (res.top) {
            placedItems++;
            splitCurrent = Boolean(res.rest);
            if (res.rest) restList.appendChild(res.rest);
            for (var j = i + 1; j < items.length; j++) {
              restList.appendChild(items[j].cloneNode(true));
            }
            break;
          }

          if (colWasEmpty && placedItems === 0) {
            topList.appendChild(item.cloneNode(true));
            placedItems++;
            for (var k = i + 1; k < items.length; k++) {
              restList.appendChild(items[k].cloneNode(true));
            }
            break;
          }

          for (var m = i; m < items.length; m++) {
            restList.appendChild(items[m].cloneNode(true));
          }
          break;
        }

        if (placedItems === 0) {
          parentTarget.removeChild(topList);
          return { top: null, rest: listEl };
        }
        if (restList.children.length === 0) {
          return { top: topList, rest: null };
        }
        if (isOl) {
          var nextStart = startNum + placedItems - (splitCurrent ? 1 : 0);
          restList.setAttribute('start', String(Math.max(1, nextStart)));
        }
        return { top: topList, rest: restList };
      }

      function splitContainer(containerEl, parentTarget, colEl, maxH, colWasEmpty) {
        var topC = containerEl.cloneNode(false);
        var restC = containerEl.cloneNode(false);
        if (containerEl.classList.contains('case-section') || containerEl.classList.contains('folder-notes-section')) {
          restC.classList.add('is-continuation');
          restC.removeAttribute('data-toc-id');
        }
        parentTarget.appendChild(topC);

        if (!colWasEmpty && colEl.scrollHeight > maxH) {
          parentTarget.removeChild(topC);
          return { top: null, rest: containerEl };
        }

        var nodes = Array.from(containerEl.childNodes);
        for (var i = 0; i < nodes.length; i++) {
          var child = nodes[i];
          if (child.nodeType === 3 && !(child.nodeValue || '').trim()) {
            topC.appendChild(child.cloneNode(true));
            continue;
          }
          var cClone = child.cloneNode(true);
          topC.appendChild(cClone);
          if (colEl.scrollHeight <= maxH) {
            continue;
          }
          topC.removeChild(cClone);

          if (child.nodeType === 3) {
            var tRes = splitTextNodeWords(child, topC, colEl, maxH);
            if (tRes.restText) {
              restC.appendChild(document.createTextNode(tRes.restText));
            }
            for (var j = i + 1; j < nodes.length; j++) {
              restC.appendChild(nodes[j].cloneNode(true));
            }
            break;
          }

          if (child.nodeType === 1) {
            var topStillEmpty = !hasMeaningfulDom(topC);
            var subRes = trySplitElement(child, topC, colEl, maxH, colWasEmpty && topStillEmpty);
            if (subRes.top) {
              if (subRes.rest) restC.appendChild(subRes.rest);
              for (var k = i + 1; k < nodes.length; k++) {
                restC.appendChild(nodes[k].cloneNode(true));
              }
              break;
            }
            if (colWasEmpty && topStillEmpty) {
              topC.appendChild(child.cloneNode(true));
              for (var m = i + 1; m < nodes.length; m++) {
                restC.appendChild(nodes[m].cloneNode(true));
              }
              break;
            }
          }

          for (var n = i; n < nodes.length; n++) {
            restC.appendChild(nodes[n].cloneNode(true));
          }
          break;
        }

        if (hasMeaningfulDom(restC)) {
          while (topC.lastElementChild && isHeadingEl(topC.lastElementChild)) {
            var nonHeadingExists = Array.from(topC.children).some(function(el) {
              return !isHeadingEl(el) && hasMeaningfulDom(el);
            });
            if (colWasEmpty && !nonHeadingExists) {
              break;
            }
            var moved = topC.lastElementChild;
            topC.removeChild(moved);
            restC.insertBefore(moved, restC.firstChild);
          }
        }

        if (!hasMeaningfulDom(topC)) {
          parentTarget.removeChild(topC);
          if (colWasEmpty) {
            var forced = containerEl.cloneNode(true);
            parentTarget.appendChild(forced);
            return { top: forced, rest: null };
          }
          return { top: null, rest: containerEl };
        }
        if (!hasMeaningfulDom(restC)) {
          return { top: topC, rest: null };
        }
        return { top: topC, rest: restC };
      }

      function trySplitElement(el, parentTarget, colEl, maxH, colWasEmpty) {
        if (!el || el.nodeType !== 1) return { top: null, rest: el };
        var tag = el.tagName;
        if (tag === 'TABLE') {
          return splitTable(el, parentTarget, colEl, maxH, colWasEmpty);
        }
        if (tag === 'UL' || tag === 'OL') {
          return splitList(el, parentTarget, colEl, maxH, colWasEmpty);
        }
        if (tag === 'P' || tag === 'LI') {
          var hasNestedBlocks = el.querySelector && el.querySelector('ul, ol, table, div, p, blockquote');
          if (hasNestedBlocks) {
            return splitContainer(el, parentTarget, colEl, maxH, colWasEmpty);
          }
          return splitInlineBlock(el, parentTarget, colEl, maxH, colWasEmpty);
        }
        if (isSplittableContainer(el)) {
          return splitContainer(el, parentTarget, colEl, maxH, colWasEmpty);
        }
        if ((tag === 'DIV' || tag === 'BLOCKQUOTE') && hasMeaningfulDom(el)) {
          return splitInlineBlock(el, parentTarget, colEl, maxH, colWasEmpty);
        }
        return { top: null, rest: el };
      }

      window.paginateDocumentIntoPages = function paginateDocumentIntoPages() {
        var bodyEl = document.getElementById('document-body');
        var pagesRoot = document.getElementById('ps-pages-root');
        var flowSource = document.getElementById('ps-flow-source');
        if (!bodyEl || !pagesRoot || !flowSource) return;

        var prevZoom = bodyEl.style.zoom;
        bodyEl.style.zoom = '1';

        try {
          var isTwoCol = bodyEl.classList.contains('two-column-layout');
          pagesRoot.innerHTML = '';
          flowSource.style.display = 'none';

          var pages = [];
          function createPageSheet(pageNum) {
            var sheet = document.createElement('div');
            sheet.className = 'ps-page-sheet';
            sheet.setAttribute('data-page-num', String(pageNum));

            var hdrLeft = null;
            var hdrRight = null;
            if (runningHeaders) {
              var hdr = document.createElement('div');
              hdr.className = 'ps-page-hdr';
              hdrLeft = document.createElement('span');
              hdrLeft.className = 'ps-page-hdr-left';
              hdrRight = document.createElement('span');
              hdrRight.className = 'ps-page-hdr-right';
              hdr.appendChild(hdrLeft);
              hdr.appendChild(hdrRight);
              sheet.appendChild(hdr);
            }

            var body = document.createElement('div');
            body.className = 'ps-page-body' + (isTwoCol ? ' is-two-col' : '');
            var cols = [];
            var colCount = isTwoCol ? 2 : 1;
            for (var c = 0; c < colCount; c++) {
              var col = document.createElement('div');
              col.className = 'ps-page-col';
              col.setAttribute('contenteditable', 'true');
              col.setAttribute('spellcheck', 'false');
              body.appendChild(col);
              cols.push(col);
            }
            sheet.appendChild(body);

            var ftr = null;
            if (runningHeaders) {
              ftr = document.createElement('div');
              ftr.className = 'ps-page-ftr';
              sheet.appendChild(ftr);
            }

            var tools = document.createElement('div');
            tools.className = 'ps-page-tools no-print';
            tools.setAttribute('contenteditable', 'false');

            var toolsLabel = document.createElement('span');
            toolsLabel.className = 'ps-page-tools-label';
            toolsLabel.textContent = 'Page ' + pageNum + ' • Click text to edit';

            var delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'ps-page-del-btn';
            delBtn.title = 'Delete this page';
            delBtn.textContent = '\\u2715 Delete Page';
            delBtn.addEventListener('click', function(ev) {
              ev.preventDefault();
              ev.stopPropagation();
              var allSheets = pagesRoot.querySelectorAll('.ps-page-sheet');
              if (allSheets.length > 1) {
                sheet.remove();
              } else {
                for (var ci = 0; ci < cols.length; ci++) {
                  cols[ci].innerHTML = '';
                }
              }
              renumberPagesAndToc();
            });

            tools.appendChild(toolsLabel);
            tools.appendChild(delBtn);
            sheet.appendChild(tools);

            pagesRoot.appendChild(sheet);
            var maxColHeight = cols[0].clientHeight - 2;
            var pageObj = {
              pageNum: pageNum,
              sheet: sheet,
              cols: cols,
              hdrLeft: hdrLeft,
              hdrRight: hdrRight,
              ftr: ftr,
              maxColHeight: maxColHeight
            };
            pages.push(pageObj);
            return pageObj;
          }

          var curPage = createPageSheet(1);
          var curColIdx = 0;

          function currentSlot() {
            return {
              page: curPage,
              colEl: curPage.cols[curColIdx],
              maxColHeight: curPage.maxColHeight
            };
          }

          function isColEmptyOrBlank(colEl) {
            if (!colEl) return true;
            return colEl.children.length === 0 || !hasMeaningfulDom(colEl);
          }

          function advanceColumn(queue) {
            var prevCol = curPage.cols[curColIdx];
            var trailingHeadings = [];
            if (queue) {
              while (prevCol.lastElementChild && isHeadingEl(prevCol.lastElementChild)) {
                var trailing = prevCol.lastElementChild;
                prevCol.removeChild(trailing);
                trailingHeadings.unshift(trailing);
              }
            }
            var prevPage = curPage;
            if (isTwoCol && curColIdx === 0) {
              curColIdx = 1;
            } else {
              curPage = createPageSheet(pages.length + 1);
              curColIdx = 0;
              var prevPageEmpty = prevPage.cols.every(isColEmptyOrBlank);
              if (prevPageEmpty) {
                var prevIdx = pages.indexOf(prevPage);
                if (prevIdx !== -1) pages.splice(prevIdx, 1);
                if (prevPage.sheet && prevPage.sheet.parentNode) {
                  prevPage.sheet.parentNode.removeChild(prevPage.sheet);
                }
              }
            }
            var next = currentSlot();
            for (var th = 0; th < trailingHeadings.length; th++) {
              next.colEl.appendChild(trailingHeadings[th]);
            }
            return next;
          }

          var rawChildren = Array.from(flowSource.childNodes).map(function(n) {
            return n.cloneNode(true);
          });

          if (curPage.cols[0].clientHeight <= 20) {
            for (var fIdx = 0; fIdx < rawChildren.length; fIdx++) {
              curPage.cols[0].appendChild(rawChildren[fIdx]);
            }
          } else {
            var queue = rawChildren;
            var cur = currentSlot();
            var safety = 0;

            while (queue.length > 0 && safety++ < 20000) {
              var node = queue.shift();
              if (node.nodeType === 3 && !(node.nodeValue || '').trim()) continue;
              if (node.nodeType === 3) {
                var textWrap = document.createElement('div');
                textWrap.textContent = node.nodeValue;
                node = textWrap;
              }

              var colWasEmpty = cur.colEl.children.length === 0;
              var clone = node.cloneNode(true);
              cur.colEl.appendChild(clone);

              if (cur.colEl.scrollHeight <= cur.maxColHeight) {
                if (!colWasEmpty && queue.length > 0 && isHeadingEl(clone)) {
                  var remAfter = cur.maxColHeight - cur.colEl.scrollHeight;
                  if (remAfter < 44) {
                    cur.colEl.removeChild(clone);
                    cur = advanceColumn(queue);
                    queue.unshift(node);
                  }
                }
                continue;
              }

              cur.colEl.removeChild(clone);

              var colEffectivelyEmpty = colWasEmpty || (cur.colEl.children.length > 0 && Array.from(cur.colEl.children).every(isHeadingEl));
              var splitRes = trySplitElement(node, cur.colEl, cur.colEl, cur.maxColHeight, colEffectivelyEmpty);
              if (splitRes.top) {
                if (splitRes.rest) {
                  queue.unshift(splitRes.rest);
                }
                if (queue.length > 0) {
                  cur = advanceColumn(queue);
                }
                continue;
              }

              if (colWasEmpty || colEffectivelyEmpty) {
                cur.colEl.appendChild(clone);
                if (queue.length > 0) {
                  cur = advanceColumn(queue);
                }
              } else {
                cur = advanceColumn(queue);
                queue.unshift(node);
              }
            }
          }

          function pageHasMeaningfulNonHeading(pageObj) {
            if (!pageObj || !pageObj.cols) return false;
            return pageObj.cols.some(function(col) {
              return Array.from(col.childNodes).some(function(child) {
                if (child.nodeType === 3) return (child.nodeValue || '').trim().length > 0;
                if (child.nodeType === 1) return !isHeadingEl(child) && hasMeaningfulDom(child);
                return false;
              });
            });
          }

          var cleanIdx = 0;
          while (cleanIdx < pages.length) {
            if (pages.length <= 1) break;
            var checkPage = pages[cleanIdx];
            if (!pageHasMeaningfulNonHeading(checkPage)) {
              if (cleanIdx + 1 < pages.length) {
                var nextFirstCol = pages[cleanIdx + 1].cols[0];
                if (nextFirstCol) {
                  var headingsToMove = [];
                  for (var hc = 0; hc < checkPage.cols.length; hc++) {
                    var colKids = Array.from(checkPage.cols[hc].children);
                    for (var hk = 0; hk < colKids.length; hk++) {
                      if (isHeadingEl(colKids[hk])) {
                        headingsToMove.push(colKids[hk]);
                      }
                    }
                  }
                  var insertAnchor = nextFirstCol.firstChild;
                  for (var hm = 0; hm < headingsToMove.length; hm++) {
                    if (headingsToMove[hm].parentNode) {
                      headingsToMove[hm].parentNode.removeChild(headingsToMove[hm]);
                    }
                    nextFirstCol.insertBefore(headingsToMove[hm], insertAnchor);
                  }
                }
              }
              if (checkPage.sheet && checkPage.sheet.parentNode) {
                checkPage.sheet.parentNode.removeChild(checkPage.sheet);
              }
              pages.splice(cleanIdx, 1);
              continue;
            }
            cleanIdx++;
          }

          renumberPagesAndToc();
        } finally {
          bodyEl.style.zoom = prevZoom;
        }
      };

      var editDebounceTimer = null;
      var pagesRootForEdit = document.getElementById('ps-pages-root');
      if (pagesRootForEdit) {
        pagesRootForEdit.addEventListener('input', function() {
          clearTimeout(editDebounceTimer);
          editDebounceTimer = setTimeout(function() {
            renumberPagesAndToc();
          }, 250);
        });
      }

      ${standaloneControlsScript}
      window.paginateDocumentIntoPages();
      ${(!embeddedPreview && autoPrint) ? `
      var runPrint = function() {
        setTimeout(function() {
          window.focus();
          window.print();
        }, 300);
      };
      if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', runPrint);
      } else {
        runPrint();
      }` : ''}
    })();
  </script>`;

  const deskBg = embeddedPreview ? '#334155' : '#e2e8f0';

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
      margin: 0;
    }
    * {
      box-sizing: border-box;
    }
    html, body {
      color-scheme: only light;
      background: ${deskBg};
      color: #0f172a;
    }
    body {
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
      background: transparent;
      box-shadow: none;
      margin: 0 auto;
      padding: 16px 0 32px 0;
      width: auto;
      min-height: 0;
      zoom: ${previewZoom};
    }
    .ps-pages-root {
      display: block;
    }
    .ps-flow-source {
      display: none;
    }
    .ps-page-sheet {
      width: ${width};
      height: ${minHeight};
      padding: ${previewPadding};
      margin: 0 auto 20px auto;
      background: #ffffff;
      color: #0f172a;
      box-shadow: 0 3px 16px rgba(15, 23, 42, 0.22), 0 0 0 1px rgba(15, 23, 42, 0.08);
      border-radius: 2px;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      overflow: hidden;
      position: relative;
    }
    .ps-page-hdr {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 12pt;
      font-size: 7pt;
      color: #475569;
      border-bottom: 0.5pt solid #cbd5e1;
      padding-bottom: 3pt;
      margin-bottom: 5pt;
      flex-shrink: 0;
      line-height: 1.1;
    }
    .ps-page-hdr-left {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ps-page-hdr-right {
      font-weight: 700;
      color: #0f172a;
      text-align: right;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ps-page-body {
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .ps-page-body.is-two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      grid-template-rows: minmax(0, 1fr);
      column-gap: 12pt;
      align-items: stretch;
    }
    .ps-page-col {
      flex: 1;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }
    .ps-page-col[contenteditable="true"] {
      outline: none;
      cursor: text;
    }
    .ps-page-col[contenteditable="true"]:focus {
      box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.25);
      border-radius: 2px;
    }
    .ps-page-tools {
      position: absolute;
      top: 6px;
      right: 8px;
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 7px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.88);
      color: #e2e8f0;
      font-size: 10px;
      font-weight: 500;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.25);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s ease;
      user-select: none;
    }
    .ps-page-sheet:hover .ps-page-tools,
    .ps-page-sheet:focus-within .ps-page-tools {
      opacity: 1;
      pointer-events: auto;
    }
    .ps-page-tools-label {
      color: #cbd5e1;
      white-space: nowrap;
      padding: 0 2px;
    }
    .ps-page-del-btn {
      appearance: none;
      border: 1px solid rgba(248, 113, 113, 0.45);
      background: rgba(220, 38, 38, 0.18);
      color: #fecaca;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 600;
      cursor: pointer;
      line-height: 1.3;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    }
    .ps-page-del-btn:hover {
      background: #dc2626;
      border-color: #ef4444;
      color: #ffffff;
    }
    .ps-page-ftr {
      display: flex;
      justify-content: center;
      align-items: center;
      font-size: 7.5pt;
      color: #64748b;
      border-top: 0.5pt solid #cbd5e1;
      padding-top: 3pt;
      margin-top: 5pt;
      flex-shrink: 0;
      line-height: 1.1;
    }
    .case-section.is-continuation,
    .folder-notes-section.is-continuation {
      margin-top: 0 !important;
      border-top-left-radius: 0 !important;
      border-top-right-radius: 0 !important;
    }

    /* Book/Thesis-Style Table of Contents */
    .print-toc-block {
      margin: 0 0 8pt 0;
      padding: 0 0 6pt 0;
      border-bottom: 0.75pt solid #0f172a;
    }
    .ps-toc-heading {
      font-size: 9.5pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #0f172a;
      margin: 0 0 5pt 0;
      text-align: center;
    }
    .ps-toc-list {
      display: flex;
      flex-direction: column;
    }
    .ps-toc-row {
      display: flex;
      align-items: baseline;
      gap: 4pt;
      padding: 1.5pt 0;
      font-size: 8.5pt;
      color: #0f172a;
    }
    .ps-toc-title-text {
      font-weight: 500;
      color: #0f172a;
    }
    .ps-toc-leader {
      flex: 1;
      border-bottom: 1px dotted #64748b;
      margin: 0 4pt;
      position: relative;
      top: -2px;
      min-width: 18pt;
    }
    .ps-toc-page {
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: #0f172a;
      min-width: 14pt;
      text-align: right;
      flex-shrink: 0;
    }
    .ps-toc-empty {
      font-size: 8.5pt;
      color: #64748b;
      font-style: italic;
      text-align: center;
    }

    /* Compact Layout Styling */
    p {
      margin: 3pt 0 !important;
    }
    table {
      width: 100% !important;
      border-collapse: collapse !important;
      margin: 6pt 0 !important;
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
    ol {
      list-style-type: decimal !important;
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

    /* Tight Mode Override */
    .tight-mode .case-section {
      margin: 2pt 0 !important;
      padding: 4pt 6pt !important;
    }
    .tight-mode .folder-notes-section {
      margin: 2pt 0 4pt 0 !important;
      padding: 4pt 6pt !important;
    }
    .tight-mode .folder-header-wrap {
      margin-top: 5pt !important;
      margin-bottom: 2pt !important;
    }
    .tight-mode p {
      margin: 2pt 0 !important;
    }
    .tight-mode table {
      margin: 3pt 0 !important;
    }
    .tight-mode th, .tight-mode td {
      padding: 2.5pt 4.5pt !important;
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
      .no-print,
      .ps-page-tools {
        display: none !important;
      }
      .ps-page-col[contenteditable="true"]:focus {
        box-shadow: none !important;
      }
      html, body {
        background: #ffffff !important;
        color: #000000 !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      .paper-container, #document-body, #ps-pages-root {
        display: block !important;
        margin: 0 !important;
        padding: 0 !important;
        zoom: 1 !important;
        background: transparent !important;
        box-shadow: none !important;
      }
      #ps-flow-source {
        display: none !important;
      }
      .ps-page-sheet {
        width: ${width} !important;
        height: ${minHeight} !important;
        padding: ${previewPadding} !important;
        margin: 0 !important;
        box-shadow: none !important;
        border: none !important;
        border-radius: 0 !important;
        page-break-after: always !important;
        break-after: page !important;
        page-break-inside: avoid !important;
        break-inside: avoid !important;
        overflow: hidden !important;
      }
      .ps-page-sheet:last-child {
        page-break-after: auto !important;
        break-after: auto !important;
      }
    }
  </style>
</head>
<body>
  ${topBarHtml}
  <div id="document-body" class="paper-container${bodyClassList ? ` ${bodyClassList}` : ''}">
    <div id="ps-pages-root" class="ps-pages-root"></div>
    <div id="ps-flow-source" class="ps-flow-source">${tocHtml}${sectionsHtml || ''}</div>
  </div>
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
    paperSize: 'a4',
    layout: 'tight',
    columns: 1,
    includeToc: false,
    marginPreset: 'narrow',
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
