// ═══════════════════════════════════════════════════════════════
// SMART-COPY.JS — Intelligent legal text extraction & clipboard copy
// Retains provision structure, indentations & paragraph flow
// Strips commercial footers & stray page numbers
// ═══════════════════════════════════════════════════════════════

import { S } from './state.js';
import { toast } from './ui.js';
import { safeStorageGet, safeStorageSet } from './storage.js';
import { dbGetSetting, dbSetSetting } from './db.js';

const _cloudCheckedFolders = new Set();

/**
 * Resolves the subfolder / folder ID of the currently open PDF.
 */
export function getActiveSubfolderId() {
  if (S.curPDF?.folder_id) return S.curPDF.folder_id;
  if (S.curPDF?.id && Array.isArray(S.pdfs)) {
    const found = S.pdfs.find(p => p.id === S.curPDF.id);
    if (found?.folder_id) return found.folder_id;
  }
  return null;
}

/**
 * Builds a readable breadcrumb path (e.g. "Subject › Folder A › Subfolder A") for a folder ID.
 */
export function getFolderBreadcrumb(folderId) {
  if (!folderId || !Array.isArray(S.folders)) return 'Current Subfolder';
  const parts = [];
  let cur = S.folders.find(f => f.id === folderId);
  let subjId = cur?.subject_id || null;
  let guard = 0;
  while (cur && guard++ < 20) {
    parts.unshift(cur.name || 'Untitled Folder');
    if (cur.subject_id) subjId = cur.subject_id;
    cur = cur.parent_folder_id ? S.folders.find(f => f.id === cur.parent_folder_id) : null;
  }
  if (subjId && Array.isArray(S.subjects)) {
    const subj = S.subjects.find(s => s.id === subjId);
    if (subj?.name) parts.unshift(subj.name);
  }
  return parts.length ? parts.join(' › ') : 'Current Subfolder';
}

/**
 * Automatically builds the main digest instruction from the PDF's folder (Topic)
 * and subfolder chain (Subtopic), e.g.:
 * "Create a digest for this case. The topic is Sales, specifically Parties in a Sale (Sales > Parties in a Sale)."
 */
export function getDefaultDigestInstructionForFolder(folderId) {
  if (!folderId || !Array.isArray(S.folders)) {
    return 'Create a digest for this case.';
  }
  const folderChain = [];
  let cur = S.folders.find(f => f.id === folderId);
  let subjId = cur?.subject_id || null;
  let guard = 0;
  while (cur && guard++ < 20) {
    const cleanName = (cur.name || '').trim();
    if (cleanName) folderChain.unshift(cleanName);
    if (cur.subject_id) subjId = cur.subject_id;
    cur = cur.parent_folder_id ? S.folders.find(f => f.id === cur.parent_folder_id) : null;
  }

  let subjectName = '';
  if (subjId && Array.isArray(S.subjects)) {
    const subj = S.subjects.find(s => s.id === subjId);
    if (subj?.name) subjectName = subj.name.trim();
  }

  if (folderChain.length >= 2) {
    const topic = folderChain[0];
    const subtopic = folderChain.slice(1).join(' > ');
    return `Create a digest for this case. The topic is ${topic}, specifically ${subtopic}.`;
  }

  if (folderChain.length === 1) {
    const folderName = folderChain[0];
    if (subjectName && subjectName.toLowerCase() !== folderName.toLowerCase()) {
      return `Create a digest for this case. The topic is ${subjectName}, specifically ${folderName}.`;
    }
    return `Create a digest for this case. The topic is ${folderName}.`;
  }

  if (subjectName) {
    return `Create a digest for this case. The topic is ${subjectName}.`;
  }

  return 'Create a digest for this case.';
}

/**
 * Combines the automatic Topic/Subtopic Main Instruction with any optional extra
 * subfolder instruction added via "+ Add Instruction".
 */
export function buildFullCopyInstruction(folderId) {
  const mainInstruction = getDefaultDigestInstructionForFolder(folderId);
  const extraInstruction = folderId ? getSubfolderCopyInstruction(folderId).trim() : '';
  return extraInstruction ? `${mainInstruction}\n${extraInstruction}` : mainInstruction;
}

export function getSubfolderCopyInstruction(folderId) {
  if (!folderId) return '';
  return safeStorageGet('copy_instr_' + folderId, '') || '';
}

export function saveSubfolderCopyInstruction(folderId, instructionText) {
  if (!folderId) return;
  const clean = (instructionText || '').trim();
  safeStorageSet('copy_instr_' + folderId, clean);
  dbSetSetting('copy_instr_' + folderId, clean).catch(() => {});
  updateCopyInstructionButtonState();
}

export function updateCopyInstructionButtonState() {
  const btn = document.getElementById('btn-copy-pdf-instr');
  if (!btn) return;
  const folderId = getActiveSubfolderId();
  if (!folderId) {
    btn.classList.remove('has-instr');
    btn.innerHTML = '<span>+ Add Instruction</span>';
    btn.title = 'Open a PDF to add extra subfolder-specific instructions to Copy Text';
    return;
  }

  const breadcrumb = getFolderBreadcrumb(folderId);
  const autoMain = getDefaultDigestInstructionForFolder(folderId);
  const instr = getSubfolderCopyInstruction(folderId).trim();

  if (instr) {
    btn.classList.add('has-instr');
    btn.innerHTML = '<span>📝 Instruction ✓</span>';
    const preview = instr.length > 140 ? instr.slice(0, 140) + '…' : instr;
    btn.title = `Main Instruction: ${autoMain}\nExtra Subfolder Instruction for "${breadcrumb}" (click to edit):\n${preview}`;
  } else {
    btn.classList.remove('has-instr');
    btn.innerHTML = '<span>+ Add Instruction</span>';
    btn.title = `Main Instruction (auto-included): ${autoMain}\nClick to add extra instructions for "${breadcrumb}"`;
  }

  // Lazy one-time cloud sync check for this subfolder if local is empty
  if (!instr && !_cloudCheckedFolders.has(folderId)) {
    _cloudCheckedFolders.add(folderId);
    dbGetSetting('copy_instr_' + folderId)
      .then((cloudVal) => {
        if (cloudVal && typeof cloudVal === 'string' && cloudVal.trim()) {
          if (!getSubfolderCopyInstruction(folderId).trim()) {
            safeStorageSet('copy_instr_' + folderId, cloudVal.trim());
            updateCopyInstructionButtonState();
          }
        }
      })
      .catch(() => {});
  }
}

export function openCopyInstructionModal() {
  const folderId = getActiveSubfolderId();
  if (!folderId) {
    toast('⚠️ Open a PDF first to set copy instructions for its subfolder.');
    return;
  }
  const modal = document.getElementById('mo-copy-instructions');
  const lbl = document.getElementById('copy-instr-folder-lbl');
  const autoPreview = document.getElementById('copy-instr-auto-preview');
  const textarea = document.getElementById('copy-instr-textarea');
  if (!modal || !textarea) return;

  const breadcrumb = getFolderBreadcrumb(folderId);
  if (lbl) lbl.textContent = `Subfolder: ${breadcrumb}`;
  if (autoPreview) autoPreview.textContent = getDefaultDigestInstructionForFolder(folderId);
  textarea.value = getSubfolderCopyInstruction(folderId);
  modal.dataset.folderId = folderId;
  modal.classList.add('open');
  setTimeout(() => textarea.focus(), 40);
}

// Commercial publisher footers (e.g., CD Technologies Asia, Inc. & cdasiaonline.com)
const COMMERCIAL_FOOTER_PATTERNS = [
  /(?:(?:copyright|©|\(c\))\s+)?(?:\d{4}\s+)?CD\s+Technologies\s+Asia(?:,?\s*Inc\.?)?(?:\s*(?:copyright|©|\(c\))?\s*\(?\d{4}\)?\.?)?/gi,
  /(?:https?:\/\/)?(?:www\.)?cdasia(?:online)?\.com(?:\/[^\s]*)?/gi
];

// Standalone page numbers: e.g. "--- Page 1 ---", "Page 1", "Page 1 of 12", "- 1 -", "[ 1 ]", or bare "142"
const STANDALONE_PAGE_RE = /^\s*(?:---\s*Page\s+\d+\s*---|Page\s+\d+(?:\s+of\s+\d+)?|-\s*\d+\s*-|\[\s*\d+\s*\]|\d{1,4})\s*$/i;

// Legal provision headers that must NEVER be stripped or joined into previous lines:
// e.g. Art. 1620., Article 1, Sec. 2., Section 3., Rule 130, Chapter I, Title IV, Book II, (1), (a), 1., etc.
const PROVISION_HEADER_RE = /^(?:ART(?:ICLE)?\.?|SEC(?:TION)?\.?|RULE|CHAPTER|TITLE|BOOK|\(\w+\)|\d+\.|[a-z]\.|[IVXLCDM]+\.)\s/i;

// Known Philippine legal reporter & statute running headers
const KNOWN_REPORTER_RE = /^(?:SUPREME COURT REPORTS ANNOTATED|PHILIPPINE REPORTS|OFFICIAL GAZETTE|SCRA|CIVIL CODE OF THE PHILIPPINES|REVISED PENAL CODE|RULES OF COURT|CONSTITUTION OF THE PHILIPPINES)$/i;

/**
 * Checks if a string starts a legal provision or structural heading.
 */
function isProvisionHeader(str) {
  if (!str) return false;
  return PROVISION_HEADER_RE.test(str.trim());
}

/**
 * Checks if a string is a standalone bare page number line.
 */
function isBarePageNumber(str) {
  if (!str) return false;
  const t = str.trim();
  if (isProvisionHeader(t)) return false;
  return STANDALONE_PAGE_RE.test(t);
}

/**
 * Checks if a line is a running header / reporter banner (e.g. "CIVIL CODE OF THE PHILIPPINES 142" or "142 SCRA").
 */
function isRunningHeader(str) {
  if (!str) return false;
  const t = str.trim();
  if (isProvisionHeader(t)) return false;
  if (KNOWN_REPORTER_RE.test(t)) return true;
  // Isolated page number followed or preceded by capitalized title text
  if (/^\d{1,4}\s+[A-Z\s,.'–—\-]{4,}$/.test(t) || /^[A-Z\s,.'–—\-]{4,}\s+\d{1,4}$/.test(t)) {
    return true;
  }
  return false;
}

/**
 * Estimates the dominant body left margin (X coordinate) across lines using histogram binning.
 */
function estimateBodyLeftMargin(lines) {
  if (!lines || !lines.length) return 0;
  const substantial = lines.filter(l => l.text.length > 25);
  const pool = substantial.length >= 3 ? substantial : lines;

  const bins = new Map();
  for (const l of pool) {
    const b = Math.round(l.minX / 5) * 5;
    bins.set(b, (bins.get(b) || 0) + 1);
  }

  let maxCount = 0;
  let dominant = pool[0].minX;
  for (const [bin, count] of bins.entries()) {
    if (count > maxCount) {
      maxCount = count;
      dominant = bin;
    }
  }
  return dominant;
}

/**
 * Copies plain text to clipboard safely with execCommand fallback.
 */
async function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.warn('[smart-copy] navigator.clipboard.writeText failed, falling back:', e);
    }
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    console.error('[smart-copy] Clipboard fallback failed:', err);
    return false;
  }
}

/**
 * Strips commercial publisher footers and stray page numbers while protecting legal provisions.
 *
 * @param {string} rawText - Text to filter
 * @param {number|null} [pageNum=null] - Optional page number context
 * @returns {string} Cleaned text
 */
export function stripPageNumbersAndFooters(rawText, pageNum = null) {
  if (!rawText) return '';
  const lines = rawText.split('\n');
  const resultLines = [];

  // Identify first and last non-empty line indices
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      resultLines.push('');
      continue;
    }

    // 1. Strip commercial publisher footers (CD Technologies Asia / cdasiaonline.com)
    let hadCommercialFooter = false;
    for (const pat of COMMERCIAL_FOOTER_PATTERNS) {
      pat.lastIndex = 0;
      if (pat.test(line)) {
        hadCommercialFooter = true;
        line = line.replace(pat, '');
      }
    }
    if (hadCommercialFooter && /^[\s|•·\-/]*$/.test(line)) {
      continue;
    }
    line = line.replace(/[ \t]+/g, ' ').trim();
    if (!line) continue;

    // Never strip legal article or section numbers that are part of provisions
    if (isProvisionHeader(line)) {
      resultLines.push(lines[i]);
      continue;
    }

    // 2. Strip standalone page numbers
    if (isBarePageNumber(line)) {
      continue;
    }

    // 3. Header/footer running lines at top/bottom boundaries
    const isBoundary = (i === firstIdx || i === lastIdx);
    if (isBoundary) {
      if (isRunningHeader(line)) {
        // Strip isolated page number from running header
        let cleanedHeader = line.replace(/^\d{1,4}\s+/, '').replace(/\s+\d{1,4}$/, '').trim();
        if (!cleanedHeader || KNOWN_REPORTER_RE.test(cleanedHeader)) {
          continue;
        }
        line = cleanedHeader;
      } else {
        if (/^\d{1,4}\s+[A-Z]/.test(line)) {
          line = line.replace(/^\d{1,4}\s+/, '').trim();
        } else if (/[A-Z]\s+\d{1,4}$/.test(line)) {
          line = line.replace(/\s+\d{1,4}$/, '').trim();
        }
      }
    } else if (isRunningHeader(line)) {
      // Embedded running header between pages
      continue;
    }

    if (!line || /^[\s|•·\-/]*$/.test(line)) {
      continue;
    }

    resultLines.push(line);
  }

  return resultLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Reconstructs formatted page text from PDF.js getTextContent (tc),
 * preserving paragraphs, provisions, and indents while stripping headers & page numbers.
 *
 * @param {object} tc - PDF.js text content object with .items array
 * @param {object|null} [pageViewport=null] - Page viewport for height reference
 * @param {number|null} [pageNum=null] - Page number for context
 * @returns {string} Clean, formatted page text
 */
export function formatPageTextContent(tc, pageViewport = null, pageNum = null) {
  if (!tc || !tc.items || !tc.items.length) return '';

  const validItems = [];
  for (const item of tc.items) {
    if (!item || typeof item.str !== 'string') continue;
    if (!item.transform) continue;
    validItems.push(item);
  }
  if (!validItems.length) return '';

  // Determine page height in PDF coordinate units
  let pageHeight = 792;
  if (pageViewport) {
    if (typeof pageViewport.height === 'number' && pageViewport.height > 0) {
      pageHeight = pageViewport.height;
    } else if (pageViewport.viewBox && typeof pageViewport.viewBox[3] === 'number') {
      pageHeight = pageViewport.viewBox[3];
    }
  } else {
    let maxY = 0;
    for (const it of validItems) {
      if (it.transform[5] > maxY) maxY = it.transform[5];
    }
    if (maxY > 0) pageHeight = Math.max(maxY + 50, 792);
  }

  // Sort items: Y descending (top of page first), then X ascending (left to right)
  validItems.sort((a, b) => {
    const yA = a.transform[5];
    const yB = b.transform[5];
    if (Math.abs(yA - yB) > 4) {
      return yB - yA;
    }
    return a.transform[4] - b.transform[4];
  });

  // Group items into visual lines by baseline Y (tolerance ~4px)
  const lines = [];
  for (const item of validItems) {
    const y = item.transform[5];
    let matchedLine = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (Math.abs(lines[i].y - y) <= 4) {
        matchedLine = lines[i];
        break;
      }
    }
    if (matchedLine) {
      matchedLine.items.push(item);
    } else {
      lines.push({ y, items: [item] });
    }
  }

  // Sort lines top to bottom (descending Y)
  lines.sort((a, b) => b.y - a.y);

  // Assemble text for each visual line
  const assembledLines = [];
  for (const line of lines) {
    line.items.sort((a, b) => a.transform[4] - b.transform[4]);

    let lineText = '';
    let lastXEnd = null;
    let minX = Infinity;
    let totalHeight = 0;
    let countHeight = 0;

    for (const item of line.items) {
      const str = item.str;
      const x = item.transform[4];
      const itemW = typeof item.width === 'number' ? item.width : 0;
      const itemH = Math.abs(item.height || item.transform[3] || 12);

      if (x < minX) minX = x;
      if (itemH > 0) {
        totalHeight += itemH;
        countHeight++;
      }

      if (lastXEnd !== null) {
        if (x > lastXEnd + 2 && !lineText.endsWith(' ') && !str.startsWith(' ')) {
          lineText += ' ';
        }
      }
      lineText += str;
      lastXEnd = x + itemW;
    }

    const trimmed = lineText.trim();
    if (!trimmed) continue;

    const avgH = countHeight > 0 ? (totalHeight / countHeight) : 12;
    assembledLines.push({
      y: line.y,
      minX: minX === Infinity ? 0 : minX,
      height: avgH,
      text: trimmed
    });
  }

  if (!assembledLines.length) return '';

  // Exclude standalone header/footer page-number lines at the very top (y > pageHeight * 0.91)
  // or very bottom (y < pageHeight * 0.08)
  const filteredLines = [];
  for (const l of assembledLines) {
    const isTop = l.y > pageHeight * 0.91;
    const isBottom = l.y < pageHeight * 0.08;

    if (isTop || isBottom) {
      if (isBarePageNumber(l.text) || isRunningHeader(l.text)) {
        continue;
      }
      if (COMMERCIAL_FOOTER_PATTERNS.some(pat => pat.test(l.text))) {
        continue;
      }
    } else {
      if (isBarePageNumber(l.text)) {
        continue;
      }
    }
    filteredLines.push(l);
  }

  if (!filteredLines.length) return '';

  const bodyLeftMargin = estimateBodyLeftMargin(filteredLines);

  // Reconstruct clean paragraphs and legal formatting:
  // - Double line break (\n\n) if deltaY > 1.45 * lineHeight
  // - Single line break (\n) + indent if provision header or indent (x - bodyLeftMargin > 14)
  // - Soft-wrapped line joining with space and hyphenation repair ("redemp-\ntion" -> "redemption")
  let result = '';
  for (let i = 0; i < filteredLines.length; i++) {
    const curr = filteredLines[i];
    const isIndented = (curr.minX - bodyLeftMargin > 14);
    const isProvision = isProvisionHeader(curr.text);
    const indentPrefix = isIndented ? '    ' : '';

    if (i === 0) {
      result = indentPrefix + curr.text;
      continue;
    }

    const prev = filteredLines[i - 1];
    const deltaY = prev.y - curr.y;
    const lineHeight = (prev.height + curr.height) / 2;
    const isNewParagraph = deltaY > (1.45 * lineHeight);

    if (isNewParagraph) {
      result += '\n\n' + indentPrefix + curr.text;
    } else if (isProvision || isIndented) {
      result += '\n' + indentPrefix + curr.text;
    } else {
      if (/[a-zA-Z]-$/.test(result) && /^[a-z]/.test(curr.text)) {
        result = result.slice(0, -1) + curr.text;
      } else {
        result += (result.endsWith(' ') ? '' : ' ') + curr.text;
      }
    }
  }

  return stripPageNumbersAndFooters(result, pageNum);
}

/**
 * Cleans selected plain text by removing soft line-wraps within paragraphs,
 * repairing hyphenation, and stripping footers/page numbers while preserving provisions.
 *
 * @param {string} rawText - Selected raw text
 * @returns {string} Formatted clean text
 */
export function cleanSelectedText(rawText) {
  if (!rawText) return '';
  const stripped = stripPageNumbersAndFooters(rawText);
  if (!stripped) return '';

  const paragraphs = stripped.split(/\n\s*\n+/);
  const cleanedParagraphs = [];

  for (const para of paragraphs) {
    const lines = para.split('\n');
    if (!lines.length) continue;

    let paraText = '';
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      const isIndented = /^[\t ]{2,}/.test(rawLine);
      const isProvision = isProvisionHeader(trimmed);

      if (!paraText) {
        paraText = (isIndented ? '    ' : '') + trimmed;
        continue;
      }

      if (isProvision || isIndented) {
        paraText += '\n' + (isIndented ? '    ' : '') + trimmed;
      } else {
        if (/[a-zA-Z]-$/.test(paraText) && /^[a-z]/.test(trimmed)) {
          paraText = paraText.slice(0, -1) + trimmed;
        } else {
          paraText += (paraText.endsWith(' ') ? '' : ' ') + trimmed;
        }
      }
    }

    if (paraText.trim()) {
      cleanedParagraphs.push(paraText.trim());
    }
  }

  return cleanedParagraphs.join('\n\n');
}

/**
 * Copies the currently selected text cleanly (strips stray page numbers, preserves provisions & paragraphs).
 *
 * @returns {Promise<boolean>}
 */
export async function copySelectedTextClean() {
  const rawText = (S.pendingSel?.text || window.getSelection()?.toString() || '').trim();
  if (!rawText) {
    toast('⚠️ No text selected to copy');
    return false;
  }

  const clean = cleanSelectedText(rawText);
  if (!clean) {
    toast('⚠️ No text to copy after filtering');
    return false;
  }

  const ok = await copyToClipboard(clean);
  if (ok) {
    toast('✅ Copied formatted text (page numbers removed)');
    return true;
  } else {
    toast('❌ Failed to copy to clipboard');
    return false;
  }
}

let _isExtractingSmart = false;

/**
 * Extracts and copies entire PDF text across pages using formatPageTextContent,
 * falling back to OCR if a page lacks native text, stripping page numbers & headers,
 * and copying clean formatted text without injecting "--- Page X ---" headers.
 *
 * @returns {Promise<void>}
 */
export async function copyEntirePdfTextSmart() {
  if (_isExtractingSmart) return;

  if (!S.pdfDoc || !S.totalPages || S.totalPages <= 0) {
    toast('⚠️ No PDF is currently open');
    return;
  }

  const btn = document.getElementById('btn-copy-pdf-text');
  const originalHtml = btn ? btn.innerHTML : '';
  const originalTitle = btn ? btn.title : '';

  _isExtractingSmart = true;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('loading');
    btn.title = 'Extracting clean formatted text…';
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 14"/></svg> <span>Copying…</span>';
  }

  const total = S.totalPages;
  const doc = S.pdfDoc;
  const trueId = S.curPDF ? (S.curPDF.linked_pdf_id || S.curPDF.id) : null;
  const pageTexts = new Array(total);
  const BATCH_SIZE = 10;

  try {
    toast(`⏳ Extracting text from ${total} page${total === 1 ? '' : 's'}…`);

    for (let i = 1; i <= total; i += BATCH_SIZE) {
      if (doc !== S.pdfDoc) {
        throw new Error('PDF changed during extraction');
      }
      const batchPromises = [];
      for (let p = i; p < i + BATCH_SIZE && p <= total; p++) {
        const pageNum = p;
        batchPromises.push((async () => {
          try {
            const page = await doc.getPage(pageNum);
            const tc = await page.getTextContent();
            const viewport = page.getViewport({ scale: 1.0 });

            let pageText = '';
            if (tc && tc.items && tc.items.length > 0) {
              pageText = formatPageTextContent(tc, viewport, pageNum);
            }

            // Fallback to OCR if page has 0 native text items or empty output, but has OCR data
            if (!pageText || !pageText.trim()) {
              if (trueId) {
                try {
                  const ocrMod = await import('./ocr.js').catch(() => null);
                  if (ocrMod && typeof ocrMod.getOcrPageText === 'function') {
                    const ocrText = await ocrMod.getOcrPageText(trueId, pageNum);
                    if (ocrText && ocrText.trim()) {
                      pageText = stripPageNumbersAndFooters(ocrText, pageNum);
                    }
                  }
                } catch (ocrErr) {
                  console.warn(`[smart-copy] OCR fallback for page ${pageNum}:`, ocrErr);
                }
              }
            }

            pageTexts[pageNum - 1] = pageText ? pageText.trim() : '';
          } catch (err) {
            console.warn(`[smart-copy] Failed extracting page ${pageNum}:`, err);
            pageTexts[pageNum - 1] = '';
          }
        })());
      }
      await Promise.all(batchPromises);
      if (i + BATCH_SIZE <= total) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Combine non-empty pages without injecting '--- Page X ---' headers
    const validPages = pageTexts.filter(t => t && t.trim().length > 0);
    if (!validPages.length) {
      toast('⚠️ No selectable text found in this PDF (it may be a scanned document without OCR).');
      return;
    }

    let fullText = validPages.join('\n\n').trim();
    fullText = stripPageNumbersAndFooters(fullText);

    const activeFolderId = getActiveSubfolderId();
    const fullInstruction = buildFullCopyInstruction(activeFolderId);
    const extraInstr = activeFolderId ? getSubfolderCopyInstruction(activeFolderId).trim() : '';
    const finalCopyText = `${fullInstruction}\n\n${fullText}`;

    const ok = await copyToClipboard(finalCopyText);
    if (!ok) {
      toast('❌ Failed to copy to clipboard. Please check clipboard permissions.');
      return;
    }

    const wordCount = fullText.split(/\s+/).filter(Boolean).length;
    const pageLabel = total === 1 ? '1 page' : `${total} pages`;

    if (btn) {
      btn.classList.remove('loading');
      btn.classList.add('copied');
      btn.innerHTML = '<svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> <span>Copied!</span>';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = originalHtml;
        btn.title = originalTitle;
      }, 2200);
    }

    if (extraInstr) {
      toast(`✅ Copied PDF + Topic/Subtopic & Extra Instruction (${wordCount.toLocaleString()} words, ${pageLabel})!`);
    } else {
      toast(`✅ Copied PDF + Topic/Subtopic Digest Instruction (${wordCount.toLocaleString()} words, ${pageLabel})!`);
    }
  } catch (err) {
    console.error('[smart-copy] Error:', err);
    toast(`⚠️ Text extraction stopped: ${err.message || err}`);
  } finally {
    _isExtractingSmart = false;
    if (btn) {
      btn.disabled = false;
      if (!btn.classList.contains('copied')) {
        btn.classList.remove('loading');
        btn.innerHTML = originalHtml;
        btn.title = originalTitle;
      }
    }
  }
}

let _isDigestingPerplexity = false;
let _batchDigestState = {
  running: false,
  cancelled: false,
  currentPdfId: null,
  resolveCurrentPdf: null,
};

function updateBatchDigestBanner(text = '', showStop = true) {
  let banner = document.getElementById('la-batch-pplx-banner');
  if (!text) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'la-batch-pplx-banner';
    banner.style.cssText =
      'position:fixed;bottom:18px;left:18px;z-index:99999;background:linear-gradient(90deg,#0f172a 0%,#172542 100%);border:1.5px solid var(--gold,#c9a84c);border-radius:10px;padding:10px 14px;color:#e8e4db;font-family:Inter,system-ui,sans-serif;font-size:12.5px;display:flex;align-items:center;gap:12px;box-shadow:0 8px 28px rgba(0,0,0,0.6);max-width:540px;';
    document.body.appendChild(banner);
  }
  banner.innerHTML = `
    <span style="color:var(--gold,#c9a84c);font-weight:700;white-space:nowrap;">⚡ Batch Digest</span>
    <span id="la-batch-pplx-msg" style="flex:1;line-height:1.4;overflow:hidden;text-overflow:ellipsis;"></span>
    ${
      showStop
        ? '<button id="la-batch-pplx-stop" style="background:#7f1d1d;border:1px solid #ef4444;color:#fecaca;border-radius:6px;padding:4px 10px;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;">⏹ Stop Batch</button>'
        : ''
    }
  `;
  const msgEl = banner.querySelector('#la-batch-pplx-msg');
  if (msgEl) msgEl.textContent = text;
  const stopBtn = banner.querySelector('#la-batch-pplx-stop');
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      _batchDigestState.cancelled = true;
      if (typeof _batchDigestState.resolveCurrentPdf === 'function') {
        _batchDigestState.resolveCurrentPdf(false);
      }
      updateBatchDigestBanner('⏹ Batch Digest stopped by user.', false);
      setTimeout(() => updateBatchDigestBanner(''), 3000);
    });
  }
}

async function ensurePdfOpenedAndLoaded(pdfItem) {
  if (!pdfItem) return false;
  if (!S.curPDF || S.curPDF.id !== pdfItem.id || !S.pdfDoc) {
    const { openPDFFromLibrary } = await import('./viewer.js');
    await openPDFFromLibrary(pdfItem);
  }
  const started = Date.now();
  while (Date.now() - started < 45000) {
    if (S.curPDF && S.curPDF.id === pdfItem.id && S.pdfDoc && S.totalPages > 0) {
      return true;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return Boolean(S.curPDF && S.curPDF.id === pdfItem.id && S.pdfDoc);
}

/**
 * Right-click handler for a single PDF in the Library sidebar:
 * Opens the PDF if needed and launches Perplexity Digest Studio for it.
 */
export async function runPerplexityDigestForPdf(pdfItem) {
  if (!pdfItem) return;
  const ready = await ensurePdfOpenedAndLoaded(pdfItem);
  if (!ready) {
    toast(`⚠️ Could not load "${pdfItem.name}" for Perplexity Digest.`);
    return;
  }
  await openPerplexityDigestForCurrentPdf();
}

/**
 * Right-click handler for a Folder/Subfolder in the Library sidebar:
 * Automatically processes every PDF in the folder one-by-one in Perplexity "Law" Project
 * using Claude 5.5 Sonnet, waits for each digest to finish and save into Case Digest,
 * and moves to the next PDF automatically.
 */
export async function runBatchPerplexityDigestForFolders(foldersOrFolder) {
  if (_batchDigestState.running) {
    toast('⚠️ A Batch Perplexity Digest is already running.');
    return;
  }
  const folders = (Array.isArray(foldersOrFolder) ? foldersOrFolder : [foldersOrFolder]).filter(Boolean);
  if (!folders.length) return;

  const folderIds = new Set();
  const collectFolderIds = (fid) => {
    if (!fid || folderIds.has(fid)) return;
    folderIds.add(fid);
    if (Array.isArray(S.folders)) {
      S.folders
        .filter(sf => sf.parent_folder_id === fid)
        .forEach(sf => collectFolderIds(sf.id));
    }
  };
  folders.forEach(f => collectFolderIds(f.id));

  const pdfQueue = Array.isArray(S.pdfs)
    ? S.pdfs.filter(p => folderIds.has(p.folder_id))
    : [];

  if (!pdfQueue.length) {
    toast('⚠️ No PDFs found inside this folder/subfolder to digest.');
    return;
  }

  _batchDigestState.running = true;
  _batchDigestState.cancelled = false;
  _batchDigestState.currentPdfId = null;
  _batchDigestState.resolveCurrentPdf = null;

  let completedCount = 0;
  const folderTitle = folders.map(f => f.name).join(', ');
  toast(`⚡ Starting Batch Perplexity Digest for ${pdfQueue.length} PDF${pdfQueue.length === 1 ? '' : 's'} in "${folderTitle}"…`);

  try {
    for (let i = 0; i < pdfQueue.length; i++) {
      if (_batchDigestState.cancelled) break;
      const pdfItem = pdfQueue[i];
      const trueId = String(pdfItem.linked_pdf_id || pdfItem.id || '');
      const stepLabel = `(${i + 1} / ${pdfQueue.length})`;

      updateBatchDigestBanner(`${stepLabel} Loading "${pdfItem.name}"…`, true);
      const loaded = await ensurePdfOpenedAndLoaded(pdfItem);
      if (!loaded || _batchDigestState.cancelled) {
        toast(`⚠️ Skipping "${pdfItem.name}" (could not load PDF).`);
        continue;
      }

      // Prepare promise that resolves when window.__onPerplexityDigestReceived saves the digest for this PDF
      const digestSavedPromise = new Promise((resolve) => {
        _batchDigestState.currentPdfId = trueId;
        const timeoutId = setTimeout(() => {
          if (_batchDigestState.resolveCurrentPdf) {
            _batchDigestState.resolveCurrentPdf = null;
          }
          resolve(false);
        }, 6 * 60 * 1000); // 6-minute safety cap per case

        _batchDigestState.resolveCurrentPdf = (ok) => {
          clearTimeout(timeoutId);
          _batchDigestState.resolveCurrentPdf = null;
          _batchDigestState.currentPdfId = null;
          resolve(Boolean(ok));
        };
      });

      updateBatchDigestBanner(`${stepLabel} Submitting "${pdfItem.name}" to Perplexity "Law" (Claude Sonnet)…`, true);
      await openPerplexityDigestForCurrentPdf({ forceAutoSubmit: true, forceAutoSend: true });

      updateBatchDigestBanner(`${stepLabel} Waiting 1–2 mins for Perplexity to finish "${pdfItem.name}"…`, true);
      const savedOk = await digestSavedPromise;
      if (_batchDigestState.cancelled) break;

      if (savedOk) {
        completedCount++;
      }

      // Polite cooldown between cases while Perplexity Studio returns to the "Law" project homepage
      if (i + 1 < pdfQueue.length && !_batchDigestState.cancelled) {
        for (let cd = 5; cd >= 1; cd--) {
          if (_batchDigestState.cancelled) break;
          updateBatchDigestBanner(
            `✅ Saved "${pdfItem.name}"! Starting next case (${i + 2}/${pdfQueue.length}) in ${cd}s…`,
            true
          );
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    if (!_batchDigestState.cancelled) {
      updateBatchDigestBanner(
        `🎉 Batch Complete! Saved Case Digests for ${completedCount} of ${pdfQueue.length} PDFs.`,
        false
      );
      toast(`🎉 Batch Perplexity Digest complete! (${completedCount}/${pdfQueue.length} cases digested)`);
      setTimeout(() => updateBatchDigestBanner(''), 5000);
    }
  } finally {
    _batchDigestState.running = false;
    _batchDigestState.currentPdfId = null;
    _batchDigestState.resolveCurrentPdf = null;
  }
}

function getTauriInvoke() {
  if (typeof window === 'undefined') return null;
  if (typeof window.__TAURI_INTERNALS__?.invoke === 'function') {
    return (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  }
  if (typeof window.__TAURI__?.core?.invoke === 'function') {
    return (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
  }
  return null;
}

/**
 * Extracts entire PDF text + Subfolder Instruction, copies to clipboard, and opens
 * the Perplexity "Law" Project Digest Studio window (with auto-paste & auto-submit).
 */
export async function openPerplexityDigestForCurrentPdf(opts = {}) {
  if (_isDigestingPerplexity) return;
  if (!S.pdfDoc || !S.totalPages || S.totalPages <= 0 || !S.curPDF) {
    toast('⚠️ Open a PDF first to generate a Case Digest in Perplexity.');
    return;
  }

  const tauriInvoke = getTauriInvoke();
  const hasDesktopStudio =
    typeof window.desktopOpenPerplexityStudio === 'function' || !!tauriInvoke;
  let preOpenedWebWin = null;
  if (!hasDesktopStudio && typeof window !== 'undefined' && typeof window.open === 'function') {
    try {
      preOpenedWebWin = window.open('about:blank', '_blank');
    } catch {}
  }

  const btn = document.getElementById('btn-perplexity-digest');
  const origHtml = btn ? btn.innerHTML : '';
  _isDigestingPerplexity = true;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ Preparing…</span>';
  }

  const total = S.totalPages;
  const doc = S.pdfDoc;
  const pdfObj = S.curPDF;
  const trueId = pdfObj.linked_pdf_id || pdfObj.id;
  const pageTexts = new Array(total);
  const BATCH_SIZE = 10;

  try {
    toast(`⏳ Extracting PDF text (${total} page${total === 1 ? '' : 's'}) for Perplexity "Law" Project…`);

    for (let i = 1; i <= total; i += BATCH_SIZE) {
      if (doc !== S.pdfDoc) throw new Error('PDF changed during extraction');
      const batchPromises = [];
      for (let p = i; p < i + BATCH_SIZE && p <= total; p++) {
        const pageNum = p;
        batchPromises.push((async () => {
          try {
            const page = await doc.getPage(pageNum);
            const tc = await page.getTextContent();
            const viewport = page.getViewport({ scale: 1.0 });
            let pageText = '';
            if (tc && tc.items && tc.items.length > 0) {
              pageText = formatPageTextContent(tc, viewport, pageNum);
            }
            if (!pageText || !pageText.trim()) {
              if (trueId) {
                try {
                  const ocrMod = await import('./ocr.js').catch(() => null);
                  if (ocrMod && typeof ocrMod.getOcrPageText === 'function') {
                    const ocrText = await ocrMod.getOcrPageText(trueId, pageNum);
                    if (ocrText && ocrText.trim()) {
                      pageText = stripPageNumbersAndFooters(ocrText, pageNum);
                    }
                  }
                } catch {}
              }
            }
            pageTexts[pageNum - 1] = pageText ? pageText.trim() : '';
          } catch {
            pageTexts[pageNum - 1] = '';
          }
        })());
      }
      await Promise.all(batchPromises);
      if (i + BATCH_SIZE <= total) await new Promise(r => setTimeout(r, 0));
    }

    const validPages = pageTexts.filter(t => t && t.trim().length > 0);
    if (!validPages.length) {
      if (preOpenedWebWin && !preOpenedWebWin.closed) {
        try { preOpenedWebWin.close(); } catch {}
      }
      toast('⚠️ No selectable text found in this PDF (run Scan OCR first).');
      return;
    }

    let pdfText = validPages.join('\n\n').trim();
    pdfText = stripPageNumbersAndFooters(pdfText);

    const activeFolderId = getActiveSubfolderId();
    const subfolderName = activeFolderId ? getFolderBreadcrumb(activeFolderId) : '';
    const instructionText = buildFullCopyInstruction(activeFolderId);
    const fullPromptText = `${instructionText}\n\n${pdfText}`;

    await copyToClipboard(fullPromptText);

    let pinnedProjectUrl = safeStorageGet('pplx_pinned_project_url', '') || '';
    if (!pinnedProjectUrl) {
      try {
        const cloudUrl = await dbGetSetting('pplx_pinned_project_url');
        if (cloudUrl && typeof cloudUrl === 'string' && cloudUrl.trim()) {
          pinnedProjectUrl = cloudUrl.trim();
          safeStorageSet('pplx_pinned_project_url', pinnedProjectUrl);
        }
      } catch {}
    }

    const autoSubmitPref = opts?.forceAutoSubmit
      ? true
      : safeStorageGet('pplx_auto_submit', 'true') !== 'false';
    const digestModePref = safeStorageGet('pplx_digest_mode', 'append') === 'replace' ? 'replace' : 'append';
    const autoSendPref = opts?.forceAutoSend
      ? true
      : safeStorageGet('pplx_auto_send', 'true') !== 'false';

    const studioPayload = {
      pdfId: String(trueId || ''),
      pdfName: String(pdfObj.name || 'Case.pdf'),
      subfolderName: subfolderName ? String(subfolderName) : '',
      instructionText: instructionText ? String(instructionText) : '',
      pdfText: String(pdfText || ''),
      fullPromptText: String(fullPromptText || ''),
      pinnedProjectUrl: pinnedProjectUrl ? String(pinnedProjectUrl) : null,
      autoSubmit: Boolean(autoSubmitPref),
      digestMode: String(digestModePref),
      autoSendDigest: Boolean(autoSendPref),
    };

    if (typeof window.desktopOpenPerplexityStudio === 'function') {
      const opened = await window.desktopOpenPerplexityStudio(studioPayload);
      if (opened) {
        toast('⚡ Opened Perplexity "Law" Digest Studio!');
        return;
      }
    } else if (tauriInvoke) {
      try {
        const opened = await tauriInvoke('desktop_open_perplexity_studio', studioPayload);
        if (opened) {
          toast('⚡ Opened Perplexity "Law" Digest Studio!');
          return;
        }
      } catch (ipcErr) {
        console.warn('[perplexity-digest] direct Tauri invoke failed:', ipcErr);
      }
    }

    // Web / external browser fallback
    const fallbackUrl = pinnedProjectUrl || 'https://www.perplexity.ai/spaces';
    if (preOpenedWebWin && !preOpenedWebWin.closed) {
      preOpenedWebWin.location.href = fallbackUrl;
      preOpenedWebWin.focus?.();
    } else if (typeof window.desktopOpenUrl === 'function') {
      await window.desktopOpenUrl(fallbackUrl);
    } else if (tauriInvoke) {
      await tauriInvoke('desktop_open_url', { url: fallbackUrl }).catch(() => {});
    } else {
      window.open(fallbackUrl, '_blank', 'noopener,noreferrer');
    }
    toast('✅ Copied case + instructions! Paste (Ctrl+V) in your Perplexity "Law" Project.');
  } catch (err) {
    if (preOpenedWebWin && !preOpenedWebWin.closed) {
      try { preOpenedWebWin.close(); } catch {}
    }
    console.error('[perplexity-digest] Error:', err);
    toast(`⚠️ Could not start Perplexity Digest: ${err.message || err}`);
  } finally {
    _isDigestingPerplexity = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
}

let _smartCopyInitialized = false;

/**
 * Initializes Smart Copy UI integrations:
 * 1. Adds "📋 Copy Text" (#sel-copy) button to #sel-menu
 * 2. Intercepts Ctrl+C copy events on .txt-layer to format text automatically
 * 3. Wires #btn-copy-pdf-text to copyEntirePdfTextSmart
 */
export function initSmartCopy() {
  if (_smartCopyInitialized) return;
  _smartCopyInitialized = true;

  // 1. Inject "📋 Copy Text" button into #sel-menu
  function setupSelCopyBtn() {
    const selMenu = document.getElementById('sel-menu');
    if (!selMenu) return false;

    if (!document.getElementById('sel-copy')) {
      const copyBtn = document.createElement('button');
      copyBtn.id = 'sel-copy';
      copyBtn.className = 'sel-btn sel-copy';
      copyBtn.textContent = '📋 Copy Text';
      copyBtn.title = 'Copy selected text with clean legal formatting (page numbers removed)';
      copyBtn.addEventListener('mousedown', e => e.preventDefault());
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await copySelectedTextClean();
        selMenu.classList.remove('open');
        S.pendingSel = null;
        S.pendingEditorSel = null;
        window.getSelection()?.removeAllRanges();
      });

      const cancelBtn = document.getElementById('sel-cancel');
      if (cancelBtn) {
        selMenu.insertBefore(copyBtn, cancelBtn);
      } else {
        selMenu.appendChild(copyBtn);
      }
    }
    return true;
  }

  if (!setupSelCopyBtn()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setupSelCopyBtn);
    }
  }

  // 2. Intercept copy event (Ctrl+C / Cmd+C) when text is selected inside .txt-layer on PDF canvas
  document.addEventListener('copy', (e) => {
    const activeEl = document.activeElement;
    if (
      activeEl &&
      (activeEl.tagName === 'INPUT' ||
       activeEl.tagName === 'TEXTAREA' ||
       activeEl.isContentEditable ||
       activeEl.closest?.('#notepad-panel') ||
       activeEl.closest?.('.note-editor'))
    ) {
      return;
    }

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;

    const anchorNode = sel.anchorNode;
    const focusNode = sel.focusNode;
    const anchorEl = anchorNode?.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode?.parentElement;
    const focusEl = focusNode?.nodeType === Node.ELEMENT_NODE ? focusNode : focusNode?.parentElement;

    const isInTxtLayer = Boolean(
      anchorEl?.closest?.('.txt-layer') ||
      focusEl?.closest?.('.txt-layer') ||
      (S.pendingSel && S.mode === 'text')
    );

    if (isInTxtLayer) {
      const rawText = S.pendingSel?.text || sel.toString();
      if (rawText && rawText.trim()) {
        const clean = cleanSelectedText(rawText);
        if (clean && e.clipboardData) {
          e.clipboardData.setData('text/plain', clean);
          e.preventDefault();
          toast('✅ Copied formatted text (page numbers removed)');
        }
      }
    }
  });

  // 3. Attach smart copy handler to #btn-copy-pdf-text if available
  const btnCopyAll = document.getElementById('btn-copy-pdf-text');
  if (btnCopyAll) {
    btnCopyAll.addEventListener('click', (e) => {
      copyEntirePdfTextSmart();
    }, true);
  }

  // 4. Attach subfolder instruction modal handlers to #btn-copy-pdf-instr & #mo-copy-instructions
  const btnCopyInstr = document.getElementById('btn-copy-pdf-instr');
  if (btnCopyInstr) {
    btnCopyInstr.addEventListener('click', (e) => {
      e.stopPropagation();
      openCopyInstructionModal();
    });
  }

  const btnSaveInstr = document.getElementById('btn-copy-instr-save');
  if (btnSaveInstr) {
    btnSaveInstr.addEventListener('click', () => {
      const modal = document.getElementById('mo-copy-instructions');
      const textarea = document.getElementById('copy-instr-textarea');
      const folderId = modal?.dataset.folderId || getActiveSubfolderId();
      if (!folderId) return;
      const val = (textarea?.value || '').trim();
      saveSubfolderCopyInstruction(folderId, val);
      modal?.classList.remove('open');
      const breadcrumb = getFolderBreadcrumb(folderId);
      if (val) {
        toast(`✅ Saved copy instructions for "${breadcrumb}"`);
      } else {
        toast(`🗑 Cleared copy instructions for "${breadcrumb}"`);
      }
    });
  }

  const btnClearInstr = document.getElementById('btn-copy-instr-clear');
  if (btnClearInstr) {
    btnClearInstr.addEventListener('click', () => {
      const modal = document.getElementById('mo-copy-instructions');
      const textarea = document.getElementById('copy-instr-textarea');
      const folderId = modal?.dataset.folderId || getActiveSubfolderId();
      if (textarea) textarea.value = '';
      if (folderId) {
        saveSubfolderCopyInstruction(folderId, '');
        const breadcrumb = getFolderBreadcrumb(folderId);
        toast(`🗑 Cleared copy instructions for "${breadcrumb}"`);
      }
      modal?.classList.remove('open');
    });
  }

  const instrTextarea = document.getElementById('copy-instr-textarea');
  if (instrTextarea) {
    instrTextarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        btnSaveInstr?.click();
      }
    });
  }

  updateCopyInstructionButtonState();

  const btnPplx = document.getElementById('btn-perplexity-digest');
  if (btnPplx) {
    btnPplx.addEventListener('click', (e) => {
      e.stopPropagation();
      openPerplexityDigestForCurrentPdf();
    });
  }
}

if (typeof window !== 'undefined') {
  window.copySelectedTextClean = copySelectedTextClean;
  window.copyEntirePdfTextSmart = copyEntirePdfTextSmart;
  window.openPerplexityDigestForCurrentPdf = openPerplexityDigestForCurrentPdf;
  window.runPerplexityDigestForPdf = runPerplexityDigestForPdf;
  window.runBatchPerplexityDigestForFolders = runBatchPerplexityDigestForFolders;
  window.stripPageNumbersAndFooters = stripPageNumbersAndFooters;
  window.formatPageTextContent = formatPageTextContent;
  window.initSmartCopy = initSmartCopy;

  window.__onPerplexityPrefsUpdated = (prefs) => {
    if (!prefs || typeof prefs !== 'object') return;
    if (typeof prefs.pinnedProjectUrl === 'string') {
      safeStorageSet('pplx_pinned_project_url', prefs.pinnedProjectUrl);
      if (prefs.pinnedProjectUrl) {
        dbSetSetting('pplx_pinned_project_url', prefs.pinnedProjectUrl).catch(() => {});
      }
    }
    if (typeof prefs.autoSubmit === 'boolean') {
      safeStorageSet('pplx_auto_submit', prefs.autoSubmit ? 'true' : 'false');
    }
    if (prefs.digestMode === 'replace' || prefs.digestMode === 'append') {
      safeStorageSet('pplx_digest_mode', prefs.digestMode);
    }
    if (typeof prefs.autoSendDigest === 'boolean') {
      safeStorageSet('pplx_auto_send', prefs.autoSendDigest ? 'true' : 'false');
    }
  };

  window.__onPerplexityDigestReceived = async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const { importDigestIntoCaseDigestTab } = await import('./notepad.js');
    const ok = await importDigestIntoCaseDigestTab(
      msg.pdfId || '',
      msg.html || '',
      msg.text || '',
      msg.digestMode === 'replace' ? 'replace' : 'append'
    );
    if (typeof _batchDigestState.resolveCurrentPdf === 'function') {
      if (!_batchDigestState.currentPdfId || !msg.pdfId || String(msg.pdfId) === String(_batchDigestState.currentPdfId)) {
        _batchDigestState.resolveCurrentPdf(ok);
      }
    }
  };
}
