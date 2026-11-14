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

const GLOBAL_MAIN_INSTR_KEY = 'copy_instr_global_main_v1';
const GLOBAL_FOOTER_INSTR_KEY = 'copy_instr_global_footer_v1';

export const DEFAULT_GLOBAL_MAIN_INSTRUCTION_TEMPLATE =
  'Create a digest for this case. The topic is {topic}, specifically {subtopic}.';

export const DEFAULT_DIGEST_FOOTER_INSTRUCTION =
  '---\nApply both the ph-case-digest and strict-source-verification skills. Begin Line 1 with "I have accessed the text from..." followed immediately by "### 1. Recit-Ready Summary Table" (no case title banner above it), and end with "### 6. Sources, Syllabus Note & Self-QA Verification (exclude)".';

/**
 * Reads the saved global Main Instruction template (preserving '' if intentionally cleared).
 */
export function getGlobalMainCopyInstructionTemplate() {
  const stored = safeStorageGet(GLOBAL_MAIN_INSTR_KEY, null);
  return stored === null ? DEFAULT_GLOBAL_MAIN_INSTRUCTION_TEMPLATE : stored;
}

/**
 * Persists the global Main Instruction template to localStorage and Supabase app_settings.
 */
export function saveGlobalMainCopyInstructionTemplate(text) {
  const clean = String(text ?? '').trim();
  safeStorageSet(GLOBAL_MAIN_INSTR_KEY, clean);
  dbSetSetting(GLOBAL_MAIN_INSTR_KEY, clean).catch(() => {});
  updateCopyInstructionButtonState();
}

/**
 * Reads the saved global Bottom Instruction (preserving '' if intentionally cleared).
 */
export function getGlobalFooterCopyInstruction() {
  const stored = safeStorageGet(GLOBAL_FOOTER_INSTR_KEY, null);
  return stored === null ? DEFAULT_DIGEST_FOOTER_INSTRUCTION : stored;
}

/**
 * Persists the global Bottom Instruction to localStorage and Supabase app_settings.
 */
export function saveGlobalFooterCopyInstruction(text) {
  const clean = String(text ?? '').trim();
  safeStorageSet(GLOBAL_FOOTER_INSTR_KEY, clean);
  dbSetSetting(GLOBAL_FOOTER_INSTR_KEY, clean).catch(() => {});
  updateCopyInstructionButtonState();
}

/**
 * Resolves { topic, subtopic } from a folder's hierarchy and parent subject.
 */
export function resolveFolderTopicParts(folderId) {
  if (!folderId || !Array.isArray(S.folders)) {
    return { topic: '', subtopic: '' };
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
    return { topic: folderChain[0], subtopic: folderChain.slice(1).join(' > ') };
  }

  if (folderChain.length === 1) {
    const folderName = folderChain[0];
    if (subjectName && subjectName.toLowerCase() !== folderName.toLowerCase()) {
      return { topic: subjectName, subtopic: folderName };
    }
    return { topic: folderName, subtopic: '' };
  }

  if (subjectName) {
    return { topic: subjectName, subtopic: '' };
  }

  return { topic: '', subtopic: '' };
}

/**
 * Resolves {topic} and {subtopic} placeholders in a global main instruction template.
 */
export function resolveGlobalMainTemplate(template, topic = '', subtopic = '') {
  const tpl = String(template ?? '');
  if (!tpl.trim()) return '';

  const hasTopicPh = tpl.includes('{topic}');
  const hasSubtopicPh = tpl.includes('{subtopic}');
  if (!hasTopicPh && !hasSubtopicPh) {
    return tpl.trim();
  }

  let out = tpl;
  if (topic && subtopic) {
    out = out.replace(/\{topic\}/g, topic).replace(/\{subtopic\}/g, subtopic);
  } else if (topic && !subtopic) {
    out = out
      .replace(/,\s*specifically\s*\{subtopic\}/gi, '')
      .replace(/\bspecifically\s*\{subtopic\}/gi, '')
      .replace(/\{topic\}/g, topic)
      .replace(/\{subtopic\}/g, '');
  } else if (!topic && subtopic) {
    out = out
      .replace(/\{topic\}\s*,\s*specifically\s*/gi, '')
      .replace(/\{topic\}/g, '')
      .replace(/\{subtopic\}/g, subtopic);
  } else {
    out = out
      .replace(/\s*The topic is\s*\{topic\}\s*,\s*specifically\s*\{subtopic\}\.?/gi, '')
      .replace(/\s*The topic is\s*\{topic\}\.?/gi, '')
      .replace(/,\s*specifically\s*\{subtopic\}/gi, '')
      .replace(/\bspecifically\s*\{subtopic\}/gi, '')
      .replace(/\{topic\}/g, '')
      .replace(/\{subtopic\}/g, '');
  }

  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;!?])/g, '$1')
    .trim();
}

/**
 * Automatically builds the main digest instruction from the global template
 * and the PDF's folder (Topic) / subfolder chain (Subtopic).
 */
export function getDefaultDigestInstructionForFolder(folderId, templateOverride = null) {
  const tpl = templateOverride !== null ? String(templateOverride) : getGlobalMainCopyInstructionTemplate();
  if (!tpl.trim()) return '';
  const { topic, subtopic } = resolveFolderTopicParts(folderId);
  return resolveGlobalMainTemplate(tpl, topic, subtopic);
}

/**
 * Combines the Global Main Instruction with any optional extra
 * subfolder instruction added via "+ Add Instruction".
 */
export function buildFullCopyInstruction(folderId) {
  const mainInstruction = getDefaultDigestInstructionForFolder(folderId).trim();
  const extraInstruction = folderId ? getSubfolderCopyInstruction(folderId).trim() : '';
  return [mainInstruction, extraInstruction].filter(Boolean).join('\n');
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
  const mainTpl = getGlobalMainCopyInstructionTemplate();
  const footerTpl = getGlobalFooterCopyInstruction();
  const hasCustomGlobal =
    mainTpl !== DEFAULT_GLOBAL_MAIN_INSTRUCTION_TEMPLATE ||
    footerTpl !== DEFAULT_DIGEST_FOOTER_INSTRUCTION;
  const resolvedMain = getDefaultDigestInstructionForFolder(folderId) || '(none)';
  const footerSummary = footerTpl.trim() || '(none)';
  const instr = folderId ? getSubfolderCopyInstruction(folderId).trim() : '';

  if (instr || hasCustomGlobal) {
    btn.classList.add('has-instr');
    btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-check"/></svg><span>Instruction</span>';
  } else {
    btn.classList.remove('has-instr');
    btn.innerHTML = folderId ? '<span>+ Add Instruction</span>' : '<span>+ Edit Instructions</span>';
  }

  if (!folderId) {
    btn.title = `Global Main Instruction: ${resolvedMain}\nGlobal Bottom Instruction: ${footerSummary}\nClick to edit global Copy Text instructions`;
    return;
  }

  const breadcrumb = getFolderBreadcrumb(folderId);
  if (instr) {
    const preview = instr.length > 140 ? instr.slice(0, 140) + '…' : instr;
    btn.title = `Main Instruction: ${resolvedMain}\nExtra Subfolder Instruction for "${breadcrumb}" (click to edit):\n${preview}\n\nBottom Footer:\n${footerSummary}`;
  } else {
    btn.title = `Main Instruction (auto-included): ${resolvedMain}\nBottom Footer: ${footerSummary}\nClick to edit global instructions or add extra instructions for "${breadcrumb}"`;
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

function updateCopyInstrAutoPreview(folderId, mainVal) {
  const autoPreview = document.getElementById('copy-instr-auto-preview');
  if (!autoPreview) return;
  const { topic, subtopic } = resolveFolderTopicParts(folderId);
  const topicLabel = topic ? ` (${subtopic ? `${topic} › ${subtopic}` : topic})` : '';
  const resolved = resolveGlobalMainTemplate(mainVal, topic, subtopic);
  autoPreview.textContent = `Preview${topicLabel}: ${resolved || '(empty)'}`;
}

async function hydrateGlobalCopyInstructionsFromCloud() {
  try {
    let changed = false;
    if (safeStorageGet(GLOBAL_MAIN_INSTR_KEY, null) === null) {
      const cloudMain = await dbGetSetting(GLOBAL_MAIN_INSTR_KEY);
      if (typeof cloudMain === 'string' && safeStorageGet(GLOBAL_MAIN_INSTR_KEY, null) === null) {
        safeStorageSet(GLOBAL_MAIN_INSTR_KEY, cloudMain);
        changed = true;
      }
    }
    if (safeStorageGet(GLOBAL_FOOTER_INSTR_KEY, null) === null) {
      const cloudFooter = await dbGetSetting(GLOBAL_FOOTER_INSTR_KEY);
      if (typeof cloudFooter === 'string' && safeStorageGet(GLOBAL_FOOTER_INSTR_KEY, null) === null) {
        safeStorageSet(GLOBAL_FOOTER_INSTR_KEY, cloudFooter);
        changed = true;
      }
    }
    if (changed) {
      updateCopyInstructionButtonState();
      const modal = document.getElementById('mo-copy-instructions');
      if (modal?.classList.contains('open')) {
        const globalMainEl = document.getElementById('copy-instr-global-main');
        const globalFooterEl = document.getElementById('copy-instr-global-footer');
        const mainVal = getGlobalMainCopyInstructionTemplate();
        if (globalMainEl) globalMainEl.value = mainVal;
        if (globalFooterEl) globalFooterEl.value = getGlobalFooterCopyInstruction();
        const folderId = modal.dataset.folderId || getActiveSubfolderId();
        updateCopyInstrAutoPreview(folderId, mainVal);
      }
    }
  } catch {}
}

export function openCopyInstructionModal() {
  const folderId = getActiveSubfolderId();
  const modal = document.getElementById('mo-copy-instructions');
  const lbl = document.getElementById('copy-instr-folder-lbl');
  const globalMainEl = document.getElementById('copy-instr-global-main');
  const globalFooterEl = document.getElementById('copy-instr-global-footer');
  const subfolderWrap = document.getElementById('copy-instr-subfolder-wrap');
  const textarea = document.getElementById('copy-instr-textarea');
  const btnClear = document.getElementById('btn-copy-instr-clear');
  if (!modal) return;

  const mainVal = getGlobalMainCopyInstructionTemplate();
  const footerVal = getGlobalFooterCopyInstruction();
  if (globalMainEl) globalMainEl.value = mainVal;
  if (globalFooterEl) globalFooterEl.value = footerVal;

  if (folderId) {
    const breadcrumb = getFolderBreadcrumb(folderId);
    if (lbl) lbl.textContent = `Subfolder: ${breadcrumb}`;
    if (subfolderWrap) subfolderWrap.style.display = '';
    if (textarea) textarea.value = getSubfolderCopyInstruction(folderId);
    if (btnClear) btnClear.style.display = '';
    modal.dataset.folderId = folderId;
  } else {
    if (lbl) lbl.textContent = 'Global Copy Text Settings (applies to ALL folders)';
    if (subfolderWrap) subfolderWrap.style.display = 'none';
    if (textarea) textarea.value = '';
    if (btnClear) btnClear.style.display = 'none';
    delete modal.dataset.folderId;
  }

  updateCopyInstrAutoPreview(folderId, mainVal);
  modal.classList.add('open');
  setTimeout(() => (folderId && textarea ? textarea : globalMainEl)?.focus(), 40);
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
    toast('No text selected to copy');
    return false;
  }

  const clean = cleanSelectedText(rawText);
  if (!clean) {
    toast('No text to copy after filtering');
    return false;
  }

  const ok = await copyToClipboard(clean);
  if (ok) {
    toast('Copied formatted text (page numbers removed)');
    return true;
  } else {
    toast('Failed to copy to clipboard');
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
    toast('No PDF is currently open');
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
    toast(`Extracting text from ${total} page${total === 1 ? '' : 's'}…`);

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
      toast('No selectable text found in this PDF (it may be a scanned document without OCR).');
      return;
    }

    let fullText = validPages.join('\n\n').trim();
    fullText = stripPageNumbersAndFooters(fullText);

    const activeFolderId = getActiveSubfolderId();
    const fullInstruction = buildFullCopyInstruction(activeFolderId);
    const extraInstr = activeFolderId ? getSubfolderCopyInstruction(activeFolderId).trim() : '';
    const footerInstruction = getGlobalFooterCopyInstruction().trim();
    const finalCopyText = [fullInstruction, fullText, footerInstruction].filter(Boolean).join('\n\n');

    const ok = await copyToClipboard(finalCopyText);
    if (!ok) {
      toast('Failed to copy to clipboard. Please check clipboard permissions.');
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
      toast(`Copied PDF + Topic/Subtopic & Extra Instruction (${wordCount.toLocaleString()} words, ${pageLabel})!`);
    } else {
      toast(`Copied PDF + Topic/Subtopic Digest Instruction (${wordCount.toLocaleString()} words, ${pageLabel})!`);
    }
  } catch (err) {
    console.error('[smart-copy] Error:', err);
    toast(`Text extraction stopped: ${err.message || err}`);
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
let _isDigestingGemini = false;
let _singleDigestCancelled = false;
let _lastPplxWebWin = null;
let _lastPplxUrl = 'https://www.perplexity.ai/spaces';
let _lastStudioPayload = null;
let _lastGeminiWebWin = null;
let _lastGeminiUrl = 'https://gemini.google.com/app';
let _lastGeminiStudioPayload = null;
let _bannerAutoHideTimer = null;
let _batchDigestState = {
  running: false,
  cancelled: false,
  provider: 'perplexity',
  currentPdfId: null,
  resolveCurrentPdf: null,
  countLabel: '',
};
let _pplxMonitorState = {
  provider: 'perplexity',
  state: 'idle',
  title: 'Perplexity Studio',
  status: 'Ready',
  error: '',
  countLabel: '',
  pdfId: '',
  pdfName: '',
  canRetry: false,
};

/**
 * Resolves { subjectId, subjectName } for a given folderId by walking S.folders -> S.subjects.
 */
export function getSubjectInfoForFolder(folderId) {
  if (!folderId || !Array.isArray(S.folders)) {
    return { subjectId: '', subjectName: '' };
  }
  let cur = S.folders.find(f => f.id === folderId);
  let subjId = cur?.subject_id || null;
  let guard = 0;
  while (cur && guard++ < 20) {
    if (cur.subject_id) subjId = cur.subject_id;
    cur = cur.parent_folder_id ? S.folders.find(f => f.id === cur.parent_folder_id) : null;
  }
  let subjectName = '';
  if (subjId && Array.isArray(S.subjects)) {
    const subj = S.subjects.find(s => s.id === subjId);
    if (subj?.name) subjectName = String(subj.name).trim();
  }
  return {
    subjectId: subjId ? String(subjId) : '',
    subjectName,
  };
}

/**
 * Normalizes a Gemini Notebook URL, stripping trailing chat segments after
 * https://gemini.google.com/notebook/<uuid>.
 */
export function normalizeGeminiNotebookUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProto);
    if (!/^gemini\.google\.com$/i.test(u.hostname)) return '';
    const nbMatch = u.pathname.match(/^(\/(?:u\/\d+\/)?notebook\/[^\/?#]+)/i);
    if (nbMatch) {
      return `https://gemini.google.com${nbMatch[1]}`;
    }
    if (/^\/(?:u\/\d+\/)?notebooks\/?$/i.test(u.pathname)) {
      return `https://gemini.google.com${u.pathname.replace(/\/+$/, '')}`;
    }
    return `${u.origin}${u.pathname}`;
  } catch {
    const m = raw.match(/^(https:\/\/gemini\.google\.com\/notebook\/[^\/?#]+)/i);
    return m ? m[1] : '';
  }
}

function readLocalGeminiNotebooksMap() {
  try {
    const raw = safeStorageGet('gemini_subject_notebooks', '{}') || '{}';
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [k, v] of Object.entries(parsed)) {
      const norm = normalizeGeminiNotebookUrl(v);
      if (k && norm) clean[String(k)] = norm;
    }
    return clean;
  } catch {
    return {};
  }
}

function writeLocalGeminiNotebooksMap(map) {
  const clean = {};
  if (map && typeof map === 'object') {
    for (const [k, v] of Object.entries(map)) {
      const norm = normalizeGeminiNotebookUrl(v);
      if (k && norm) clean[String(k)] = norm;
    }
  }
  safeStorageSet('gemini_subject_notebooks', JSON.stringify(clean));
  return clean;
}

async function hydrateGeminiNotebooksMapFromCloud() {
  let localMap = readLocalGeminiNotebooksMap();
  try {
    const cloudRaw = await dbGetSetting('gemini_subject_notebooks');
    if (cloudRaw) {
      const cloudObj = typeof cloudRaw === 'string' ? JSON.parse(cloudRaw) : cloudRaw;
      if (cloudObj && typeof cloudObj === 'object' && !Array.isArray(cloudObj)) {
        let changed = false;
        const merged = { ...localMap };
        for (const [k, v] of Object.entries(cloudObj)) {
          const norm = normalizeGeminiNotebookUrl(v);
          if (k && norm && !merged[String(k)]) {
            merged[String(k)] = norm;
            changed = true;
          }
        }
        if (changed) localMap = writeLocalGeminiNotebooksMap(merged);
      }
    }
  } catch {}
  return localMap;
}

export async function getPinnedGeminiNotebookForSubject(subjectId) {
  const sid = subjectId ? String(subjectId) : '';
  let map = readLocalGeminiNotebooksMap();
  if (sid && map[sid]) return map[sid];
  map = await hydrateGeminiNotebooksMapFromCloud();
  if (sid && map[sid]) return map[sid];
  try {
    const tauriInvoke = getTauriInvoke();
    const prefs = typeof window.desktopGetGeminiPrefs === 'function'
      ? await window.desktopGetGeminiPrefs()
      : (tauriInvoke ? await tauriInvoke('desktop_get_gemini_prefs') : null);
    if (sid) {
      const desktopUrl = prefs?.subjectNotebooks?.[sid];
      const norm = normalizeGeminiNotebookUrl(desktopUrl);
      if (norm) {
        map[sid] = norm;
        writeLocalGeminiNotebooksMap(map);
        return norm;
      }
    }
    const defNorm = normalizeGeminiNotebookUrl(prefs?.defaultNotebookUrl);
    if (defNorm) return defNorm;
    if (prefs?.subjectNotebooks && typeof prefs.subjectNotebooks === 'object') {
      for (const v of Object.values(prefs.subjectNotebooks)) {
        const norm = normalizeGeminiNotebookUrl(v);
        if (norm) return norm;
      }
    }
  } catch {}
  for (const v of Object.values(map)) {
    const norm = normalizeGeminiNotebookUrl(v);
    if (norm) return norm;
  }
  return '';
}

function syncGeminiPrefsToDesktop(prefsPatch) {
  try {
    if (typeof window.desktopSaveGeminiPrefs === 'function') {
      window.desktopSaveGeminiPrefs(prefsPatch).catch?.(() => {});
      return;
    }
    const tauriInvoke = getTauriInvoke();
    if (tauriInvoke) {
      tauriInvoke('desktop_save_gemini_prefs', { prefs: prefsPatch }).catch(() => {});
    }
  } catch {}
}

export async function setPinnedGeminiNotebookForSubject(subjectId, url) {
  if (!subjectId) return;
  const sid = String(subjectId);
  const norm = normalizeGeminiNotebookUrl(url);
  const map = await hydrateGeminiNotebooksMapFromCloud();
  if (norm) {
    map[sid] = norm;
  } else {
    delete map[sid];
  }
  const cleanMap = writeLocalGeminiNotebooksMap(map);
  dbSetSetting('gemini_subject_notebooks', JSON.stringify(cleanMap)).catch(() => {});
  syncGeminiPrefsToDesktop({ subjectNotebooks: cleanMap });
}

export function getGeminiModelPrefs() {
  const rawModel = safeStorageGet('gemini_model_label', '4 Hydrogen');
  const rawThinking = safeStorageGet('gemini_thinking_level', 'High');
  const modelLabel = (rawModel && String(rawModel).trim()) || '4 Hydrogen';
  const thinkingLevel = (rawThinking && String(rawThinking).trim()) || 'High';
  return { modelLabel, thinkingLevel };
}

async function resolveGeminiModelPrefs() {
  let modelLabel = safeStorageGet('gemini_model_label', '');
  let thinkingLevel = safeStorageGet('gemini_thinking_level', '');
  if (!modelLabel) {
    try {
      const cloudModel = await dbGetSetting('gemini_model_label');
      if (cloudModel && typeof cloudModel === 'string' && cloudModel.trim()) {
        modelLabel = cloudModel.trim();
        safeStorageSet('gemini_model_label', modelLabel);
      }
    } catch {}
  }
  if (!thinkingLevel) {
    try {
      const cloudThinking = await dbGetSetting('gemini_thinking_level');
      if (cloudThinking && typeof cloudThinking === 'string' && cloudThinking.trim()) {
        thinkingLevel = cloudThinking.trim();
        safeStorageSet('gemini_thinking_level', thinkingLevel);
      }
    } catch {}
  }
  if (!modelLabel || !thinkingLevel) {
    try {
      const tauriInvoke = getTauriInvoke();
      const prefs = typeof window.desktopGetGeminiPrefs === 'function'
        ? await window.desktopGetGeminiPrefs()
        : (tauriInvoke ? await tauriInvoke('desktop_get_gemini_prefs') : null);
      if (!modelLabel && prefs?.modelLabel) {
        modelLabel = String(prefs.modelLabel).trim();
        if (modelLabel) safeStorageSet('gemini_model_label', modelLabel);
      }
      if (!thinkingLevel && prefs?.thinkingLevel) {
        thinkingLevel = String(prefs.thinkingLevel).trim();
        if (thinkingLevel) safeStorageSet('gemini_thinking_level', thinkingLevel);
      }
    } catch {}
  }
  return {
    modelLabel: (modelLabel && String(modelLabel).trim()) || '4 Hydrogen',
    thinkingLevel: (thinkingLevel && String(thinkingLevel).trim()) || 'High',
  };
}

export async function saveGeminiModelPrefs({ modelLabel, thinkingLevel } = {}) {
  const cleanModel = String(modelLabel || '').trim() || '4 Hydrogen';
  const cleanThinking = String(thinkingLevel || '').trim() || 'High';
  safeStorageSet('gemini_model_label', cleanModel);
  safeStorageSet('gemini_thinking_level', cleanThinking);
  dbSetSetting('gemini_model_label', cleanModel).catch(() => {});
  dbSetSetting('gemini_thinking_level', cleanThinking).catch(() => {});
  syncGeminiPrefsToDesktop({ modelLabel: cleanModel, thinkingLevel: cleanThinking });
  return { modelLabel: cleanModel, thinkingLevel: cleanThinking };
}

export async function refreshGeminiDigestSettingsCard() {
  const modelInp = document.getElementById('settings-gemini-model');
  const thinkingSel = document.getElementById('settings-gemini-thinking');
  const listEl = document.getElementById('settings-gemini-notebooks-list');
  if (!modelInp && !thinkingSel && !listEl) return;

  const [{ modelLabel, thinkingLevel }, notebooksMap] = await Promise.all([
    resolveGeminiModelPrefs(),
    hydrateGeminiNotebooksMapFromCloud(),
  ]);

  if (modelInp) modelInp.value = modelLabel;
  if (thinkingSel) {
    const validOptions = Array.from(thinkingSel.options || []).map(o => o.value);
    thinkingSel.value = validOptions.includes(thinkingLevel) ? thinkingLevel : 'High';
  }

  if (listEl) {
    listEl.innerHTML = '';
    const subjects = Array.isArray(S.subjects) ? S.subjects : [];
    if (!subjects.length) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'settings-gemini-empty';
      emptyEl.style.cssText = 'font-size:11px; color:var(--muted); padding:4px 0;';
      emptyEl.textContent = 'No subjects created yet.';
      listEl.appendChild(emptyEl);
      return;
    }

    for (const subj of subjects) {
      if (!subj || !subj.id) continue;
      const sid = String(subj.id);
      const row = document.createElement('div');
      row.className = 'gemini-notebook-row';

      const lbl = document.createElement('span');
      lbl.className = 'gemini-notebook-row__name';
      lbl.textContent = subj.name || 'Untitled Subject';
      lbl.title = subj.name || '';

      const inp = document.createElement('input');
      inp.type = 'url';
      inp.className = 'gemini-notebook-row__input';
      inp.dataset.subjectId = sid;
      inp.placeholder = 'https://gemini.google.com/notebook/…';
      inp.value = notebooksMap[sid] || '';

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'btn-sec gemini-notebook-row__clear';
      clearBtn.title = `Clear pinned Notebook for ${subj.name || 'Subject'}`;
      clearBtn.setAttribute('aria-label', `Clear pinned Notebook for ${subj.name || 'Subject'}`);
      clearBtn.textContent = '✕';
      clearBtn.addEventListener('click', () => {
        inp.value = '';
        inp.focus();
      });

      row.append(lbl, inp, clearBtn);
      listEl.appendChild(row);
    }
  }
}

async function saveGeminiDigestSettingsFromCard() {
  const modelInp = document.getElementById('settings-gemini-model');
  const thinkingSel = document.getElementById('settings-gemini-thinking');
  const listEl = document.getElementById('settings-gemini-notebooks-list');

  const modelLabel = (modelInp?.value || '').trim() || '4 Hydrogen';
  const thinkingLevel = (thinkingSel?.value || '').trim() || 'High';

  const nextMap = { ...readLocalGeminiNotebooksMap() };
  if (listEl) {
    const inputs = listEl.querySelectorAll('input[data-subject-id]');
    for (const inp of inputs) {
      const sid = inp.dataset.subjectId;
      if (!sid) continue;
      const raw = (inp.value || '').trim();
      if (!raw) {
        delete nextMap[sid];
        continue;
      }
      const norm = normalizeGeminiNotebookUrl(raw);
      if (!norm) {
        toast('Notebook URLs must point to https://gemini.google.com/notebook/...');
        inp.focus();
        return;
      }
      nextMap[sid] = norm;
    }
  }

  const cleanMap = writeLocalGeminiNotebooksMap(nextMap);
  await saveGeminiModelPrefs({ modelLabel, thinkingLevel });
  dbSetSetting('gemini_subject_notebooks', JSON.stringify(cleanMap)).catch(() => {});
  syncGeminiPrefsToDesktop({
    modelLabel,
    thinkingLevel,
    subjectNotebooks: cleanMap,
  });
  toast('✓ Gemini Case Digest settings saved');
  await refreshGeminiDigestSettingsCard();
}

/**
 * Shared PDF text extraction helper (10-page batch + ocr.js fallback +
 * stripPageNumbersAndFooters + buildFullCopyInstruction) used by both
 * Perplexity and Gemini Case Digest flows.
 */
async function extractPdfDigestPromptPayload({ doc, total, pdfObj, isCancelled }) {
  const trueId = pdfObj.linked_pdf_id || pdfObj.id;
  const pageTexts = new Array(total);
  const BATCH_SIZE = 10;

  for (let i = 1; i <= total; i += BATCH_SIZE) {
    if (isCancelled?.()) {
      throw new Error('Cancelled by user');
    }
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

  if (isCancelled?.()) {
    throw new Error('Cancelled by user');
  }

  const validPages = pageTexts.filter(t => t && t.trim().length > 0);
  if (!validPages.length) {
    return { ok: false, reason: 'no_text', trueId };
  }

  let pdfText = validPages.join('\n\n').trim();
  pdfText = stripPageNumbersAndFooters(pdfText);

  const activeFolderId = getActiveSubfolderId();
  const subfolderName = activeFolderId ? getFolderBreadcrumb(activeFolderId) : '';
  const instructionText = buildFullCopyInstruction(activeFolderId);
  const footerInstruction = getGlobalFooterCopyInstruction().trim();
  const fullPromptText = [instructionText, pdfText, footerInstruction].filter(Boolean).join('\n\n');

  return {
    ok: true,
    trueId,
    pdfText,
    activeFolderId,
    subfolderName,
    instructionText,
    fullPromptText,
  };
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

function hasDesktopPerplexityStudio() {
  return typeof window !== 'undefined' &&
    (typeof window.desktopOpenPerplexityStudio === 'function' || !!getTauriInvoke());
}

function hasDesktopGeminiStudio() {
  return typeof window !== 'undefined' &&
    (typeof window.desktopOpenGeminiStudio === 'function' || !!getTauriInvoke());
}

function preOpenWebWindowForProvider(provider) {
  const isGemini = provider === 'gemini';
  if (isGemini ? hasDesktopGeminiStudio() : hasDesktopPerplexityStudio()) return null;
  if (typeof window === 'undefined' || typeof window.open !== 'function') return null;
  try {
    const win = window.open('about:blank', '_blank');
    if (win) {
      if (isGemini) {
        _lastGeminiWebWin = win;
      } else {
        _lastPplxWebWin = win;
      }
      const label = isGemini ? 'Gemini' : 'Perplexity';
      try {
        win.document.title = `Opening ${label} Case Digest…`;
        win.document.body.innerHTML = `<div style="font-family:system-ui,-apple-system,sans-serif;padding:32px;color:#1b1f23;background:#f8f7f3;min-height:100vh;margin:0;"><h2 style="margin:0 0 8px;font-size:18px;">Preparing ${label} Case Digest…</h2><p style="margin:0;color:#555;font-size:14px;">Extracting PDF text and subfolder instructions. This tab will redirect to ${label} automatically.</p></div>`;
      } catch {}
    }
    return win;
  } catch {
    return null;
  }
}

function preOpenPerplexityWebWindow() {
  return preOpenWebWindowForProvider('perplexity');
}

function preOpenGeminiWebWindow() {
  return preOpenWebWindowForProvider('gemini');
}

export async function focusOrReopenPerplexityStudio() {
  if (hasDesktopPerplexityStudio()) {
    try {
      if (typeof window.desktopFocusPerplexityStudio === 'function') {
        const focused = await window.desktopFocusPerplexityStudio();
        if (focused) return true;
      } else {
        const tauriInvoke = getTauriInvoke();
        if (tauriInvoke) {
          const focused = await tauriInvoke('desktop_focus_perplexity_studio');
          if (focused) return true;
        }
      }
    } catch (err) {
      console.warn('[perplexity-digest] focus desktop studio failed:', err);
    }

    if (_lastStudioPayload) {
      try {
        if (typeof window.desktopOpenPerplexityStudio === 'function') {
          const reopened = await window.desktopOpenPerplexityStudio(_lastStudioPayload);
          if (reopened) {
            toast('Reopened Perplexity Digest Studio');
            return true;
          }
        } else {
          const tauriInvoke = getTauriInvoke();
          if (tauriInvoke) {
            const reopened = await tauriInvoke('desktop_open_perplexity_studio', _lastStudioPayload);
            if (reopened) {
              toast('Reopened Perplexity Digest Studio');
              return true;
            }
          }
        }
      } catch (err) {
        console.warn('[perplexity-digest] reopen desktop studio failed:', err);
      }
    }
    if (S.curPDF) {
      await openPerplexityDigestForCurrentPdf();
      return true;
    }
    return false;
  }

  if (_lastPplxWebWin && !_lastPplxWebWin.closed) {
    try {
      _lastPplxWebWin.focus();
      return true;
    } catch {}
  }

  const targetUrl = _lastPplxUrl || safeStorageGet('pplx_pinned_project_url', '') || 'https://www.perplexity.ai/spaces';
  try {
    const win = window.open(targetUrl, '_blank');
    if (win) {
      _lastPplxWebWin = win;
      win.focus?.();
      return true;
    }
  } catch {}
  toast('Could not focus Perplexity tab — please allow popups for this site.');
  return false;
}

export async function focusOrReopenGeminiStudio() {
  if (hasDesktopGeminiStudio()) {
    try {
      if (typeof window.desktopFocusGeminiStudio === 'function') {
        const focused = await window.desktopFocusGeminiStudio();
        if (focused) return true;
      } else {
        const tauriInvoke = getTauriInvoke();
        if (tauriInvoke) {
          const focused = await tauriInvoke('desktop_focus_gemini_studio');
          if (focused) return true;
        }
      }
    } catch (err) {
      console.warn('[gemini-digest] focus desktop studio failed:', err);
    }

    if (_lastGeminiStudioPayload) {
      try {
        if (typeof window.desktopOpenGeminiStudio === 'function') {
          const reopened = await window.desktopOpenGeminiStudio(_lastGeminiStudioPayload);
          if (reopened) {
            toast('Reopened Gemini Digest Studio');
            return true;
          }
        } else {
          const tauriInvoke = getTauriInvoke();
          if (tauriInvoke) {
            const reopened = await tauriInvoke('desktop_open_gemini_studio', _lastGeminiStudioPayload);
            if (reopened) {
              toast('Reopened Gemini Digest Studio');
              return true;
            }
          }
        }
      } catch (err) {
        console.warn('[gemini-digest] reopen desktop studio failed:', err);
      }
    }
    if (S.curPDF) {
      await openGeminiDigestForCurrentPdf();
      return true;
    }
    return false;
  }

  if (_lastGeminiWebWin && !_lastGeminiWebWin.closed) {
    try {
      _lastGeminiWebWin.focus();
      return true;
    } catch {}
  }

  const activeFolderId = getActiveSubfolderId();
  const { subjectId } = getSubjectInfoForFolder(activeFolderId);
  const pinnedForSubj = await getPinnedGeminiNotebookForSubject(subjectId);
  const targetUrl = _lastGeminiUrl || pinnedForSubj || 'https://gemini.google.com/notebooks';
  try {
    const win = window.open(targetUrl, '_blank');
    if (win) {
      _lastGeminiWebWin = win;
      win.focus?.();
      return true;
    }
  } catch {}
  toast('Could not focus Gemini tab — please allow popups for this site.');
  return false;
}

export function stopActivePerplexityDigest() {
  _singleDigestCancelled = true;
  if (_batchDigestState.running && _batchDigestState.provider !== 'gemini') {
    _batchDigestState.cancelled = true;
    if (typeof _batchDigestState.resolveCurrentPdf === 'function') {
      _batchDigestState.resolveCurrentPdf(false);
    }
  }
  applyDigestMonitorStatus('perplexity', {
    state: 'idle',
    stepLabel: 'Stopped',
    message: 'Case Digest stopped by user.',
    error: '',
    hideStripAfterMs: 2500,
  });
}

export function stopActiveGeminiDigest() {
  _singleDigestCancelled = true;
  if (_batchDigestState.running && _batchDigestState.provider === 'gemini') {
    _batchDigestState.cancelled = true;
    if (typeof _batchDigestState.resolveCurrentPdf === 'function') {
      _batchDigestState.resolveCurrentPdf(false);
    }
  }
  applyDigestMonitorStatus('gemini', {
    state: 'idle',
    stepLabel: 'Stopped',
    message: 'Gemini Case Digest stopped by user.',
    error: '',
    hideStripAfterMs: 2500,
  });
}

function normalizeMonitorDotState(state) {
  const s = String(state || 'idle').toLowerCase();
  if (s === 'error' || s === 'failed') return 'error';
  if (s === 'done' || s === 'saved' || s === 'complete' || s === 'completed') return 'done';
  if (s === 'extracting' || s === 'preparing' || s === 'loading') return 'extracting';
  if (s === 'awaiting' || s === 'submitted' || s === 'streaming' || s === 'generating' || s === 'working') return 'awaiting';
  return 'idle';
}

function renderPplxMonitorStrip() {
  const strip = document.getElementById('pplxMonitorStrip');
  if (!strip) return;

  const { provider, state, title, status, error, countLabel } = _pplxMonitorState;
  const activeProvider = provider === 'gemini' ? 'gemini' : 'perplexity';
  const dotState = normalizeMonitorDotState(state);
  const isActive = dotState === 'extracting' || dotState === 'awaiting';
  const showStrip = isActive || dotState === 'error' || (dotState === 'done' && Boolean(status));

  strip.hidden = !showStrip;
  strip.dataset.state = dotState;
  strip.dataset.provider = activeProvider;

  const dot = document.getElementById('pplxMonitorDot');
  if (dot) dot.dataset.state = dotState;

  const titleEl = document.getElementById('pplxMonitorTitle');
  if (titleEl) {
    titleEl.textContent = countLabel ? `${title} · ${countLabel}` : title;
  }

  const statusEl = document.getElementById('pplxMonitorStatus');
  if (statusEl) {
    statusEl.textContent = status || 'Ready';
    statusEl.title = status || '';
  }

  const stopBtn = document.getElementById('stopDigestBtn');
  if (stopBtn) {
    stopBtn.disabled = !isActive && !_batchDigestState.running && !_isDigestingPerplexity && !_isDigestingGemini;
  }

  const focusBtn = document.getElementById('focusPplxBtn');
  if (focusBtn) {
    const labelSpan = focusBtn.querySelector('span');
    if (labelSpan) {
      const hasDesktop = activeProvider === 'gemini' ? hasDesktopGeminiStudio() : hasDesktopPerplexityStudio();
      labelSpan.textContent = hasDesktop ? 'Focus / Reopen' : 'Focus Tab';
    }
  }

  const alertEl = document.getElementById('pplxMonitorAlert');
  const alertTextEl = document.getElementById('pplxMonitorAlertText');
  const alertBtn = document.getElementById('pplxMonitorAlertBtn');
  if (alertEl) {
    const hasErr = dotState === 'error' && Boolean(error || status);
    alertEl.hidden = !hasErr;
    if (alertTextEl && hasErr) {
      alertTextEl.textContent = error || status;
    }
    if (alertBtn && hasErr) {
      alertBtn.textContent = _pplxMonitorState.canRetry ? 'Retry' : 'Focus Studio';
    }
  }
}

function renderFloatingMonitorBanner() {
  clearTimeout(_bannerAutoHideTimer);
  const existing = document.getElementById('la-batch-pplx-banner');
  const { provider, state, title, status, error, countLabel } = _pplxMonitorState;
  const activeProvider = provider === 'gemini' ? 'gemini' : 'perplexity';
  const dotState = normalizeMonitorDotState(state);
  const isRunning = dotState === 'extracting' || dotState === 'awaiting' || _batchDigestState.running || _isDigestingPerplexity || _isDigestingGemini;
  const isError = dotState === 'error';
  const showBanner = isRunning || isError || Boolean(status && state !== 'idle');

  if (!showBanner) {
    if (existing) existing.remove();
    return;
  }

  let banner = existing;
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'la-batch-pplx-banner';
    banner.className = 'pplx-floating-banner';
    document.body.appendChild(banner);
  }
  banner.dataset.state = dotState;
  banner.dataset.provider = activeProvider;
  banner.style.fontFamily = 'var(--font-ui)';

  const badgeText = countLabel ? `${title} (${countLabel})` : title;
  const defaultErrMsg = activeProvider === 'gemini'
    ? 'Gemini Studio encountered an issue.'
    : 'Perplexity Studio encountered an issue.';
  const displayMsg = isError ? (error || status || defaultErrMsg) : (status || 'Working…');
  const hasDesktop = activeProvider === 'gemini' ? hasDesktopGeminiStudio() : hasDesktopPerplexityStudio();
  const focusLabel = hasDesktop ? 'Focus / Reopen' : 'Focus Tab';
  const stopLabel = _batchDigestState.running ? 'Stop Batch' : (isRunning ? 'Stop' : 'Dismiss');

  banner.innerHTML = `
    <span class="pplx-floating-banner__badge">
      <svg class="icon" aria-hidden="true"><use href="${isError ? '#i-alert' : '#i-spark'}"/></svg>
      <span id="la-batch-pplx-title"></span>
    </span>
    <span id="la-batch-pplx-msg" class="pplx-floating-banner__msg"></span>
    <div class="pplx-floating-banner__actions">
      <button type="button" id="la-batch-pplx-focus" class="pplx-floating-banner__btn">
        <svg class="icon" aria-hidden="true"><use href="#i-external"/></svg>
        <span></span>
      </button>
      <button type="button" id="la-batch-pplx-stop" class="pplx-floating-banner__btn pplx-floating-banner__btn--stop">
        <svg class="icon" aria-hidden="true"><use href="${isRunning ? '#i-stop' : '#i-close'}"/></svg>
        <span></span>
      </button>
    </div>
  `;

  const titleEl = banner.querySelector('#la-batch-pplx-title');
  if (titleEl) titleEl.textContent = badgeText;
  const msgEl = banner.querySelector('#la-batch-pplx-msg');
  if (msgEl) {
    msgEl.textContent = displayMsg;
    msgEl.title = displayMsg;
  }
  const focusBtn = banner.querySelector('#la-batch-pplx-focus');
  if (focusBtn) {
    const span = focusBtn.querySelector('span');
    if (span) span.textContent = focusLabel;
    focusBtn.addEventListener('click', () => {
      if (activeProvider === 'gemini') {
        focusOrReopenGeminiStudio();
      } else {
        focusOrReopenPerplexityStudio();
      }
    });
  }
  const stopBtn = banner.querySelector('#la-batch-pplx-stop');
  if (stopBtn) {
    const span = stopBtn.querySelector('span');
    if (span) span.textContent = stopLabel;
    stopBtn.addEventListener('click', () => {
      if (isRunning) {
        if (activeProvider === 'gemini') {
          stopActiveGeminiDigest();
        } else {
          stopActivePerplexityDigest();
        }
      } else {
        _pplxMonitorState = { ..._pplxMonitorState, state: 'idle', status: '', error: '' };
        renderPplxMonitorStrip();
        renderFloatingMonitorBanner();
      }
    });
  }
}

function applyDigestMonitorStatus(provider = 'perplexity', payload = {}) {
  if (!payload || typeof payload !== 'object') return;
  const activeProvider = provider === 'gemini' ? 'gemini' : 'perplexity';
  const defaultTitle = activeProvider === 'gemini' ? 'Gemini Studio' : 'Perplexity Studio';
  const defaultErr = activeProvider === 'gemini'
    ? 'Gemini Studio requires attention.'
    : 'Perplexity Studio requires attention.';
  const rawState = payload.state || payload.status || (payload.error ? 'error' : 'idle');
  const dotState = normalizeMonitorDotState(rawState);
  const countLabel = payload.count != null
    ? String(payload.count)
    : (payload.countLabel || _batchDigestState.countLabel || '');
  const stageTitle = payload.stepLabel || payload.stage || payload.title || (_batchDigestState.running ? 'Batch Digest' : defaultTitle);
  const msg = payload.message || payload.error || payload.detail || (dotState === 'idle' ? '' : stageTitle);
  const errMsg = dotState === 'error' ? (payload.error || payload.message || defaultErr) : '';

  _pplxMonitorState = {
    provider: activeProvider,
    state: dotState,
    title: stageTitle,
    status: msg,
    error: errMsg,
    countLabel,
    pdfId: payload.pdfId != null ? String(payload.pdfId) : _pplxMonitorState.pdfId,
    pdfName: payload.pdfName != null ? String(payload.pdfName) : _pplxMonitorState.pdfName,
    canRetry: Boolean(payload.canRetry),
  };

  renderPplxMonitorStrip();
  renderFloatingMonitorBanner();

  if (payload.hideStripAfterMs && !isNaN(payload.hideStripAfterMs)) {
    const delay = Number(payload.hideStripAfterMs);
    _bannerAutoHideTimer = setTimeout(() => {
      if (!_batchDigestState.running && !_isDigestingPerplexity && !_isDigestingGemini && _pplxMonitorState.state !== 'error') {
        _pplxMonitorState = { ..._pplxMonitorState, state: 'idle', status: '', error: '' };
        renderPplxMonitorStrip();
        renderFloatingMonitorBanner();
      }
    }, delay);
  }
}

function applyPerplexityStudioStatus(payload = {}) {
  applyDigestMonitorStatus('perplexity', payload);
}

function updateBatchDigestBanner(text = '', showStop = true, extra = {}) {
  const activeProvider = extra.provider || _batchDigestState.provider || 'perplexity';
  if (!text) {
    if (!showStop) {
      _pplxMonitorState = { ..._pplxMonitorState, provider: activeProvider, state: 'idle', status: '', error: '', countLabel: '' };
      renderPplxMonitorStrip();
      renderFloatingMonitorBanner();
    }
    return;
  }
  applyDigestMonitorStatus(activeProvider, {
    state: extra.state || (showStop ? 'streaming' : 'done'),
    stepLabel: extra.stepLabel || 'Batch Digest',
    message: text,
    countLabel: extra.countLabel ?? _batchDigestState.countLabel,
    hideStripAfterMs: extra.hideStripAfterMs,
  });
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

function collectPdfQueueForFolders(foldersOrFolder) {
  const folders = (Array.isArray(foldersOrFolder) ? foldersOrFolder : [foldersOrFolder]).filter(Boolean);
  if (!folders.length) return { folders: [], pdfQueue: [] };
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
  return { folders, pdfQueue };
}

/**
 * Right-click handler for a single PDF in the Library sidebar:
 * Opens the PDF if needed and launches Perplexity Digest Studio for it.
 */
export async function runPerplexityDigestForPdf(pdfItem) {
  if (!pdfItem) return;
  if (_isDigestingGemini || (_batchDigestState.running && _batchDigestState.provider === 'gemini')) {
    toast('A Gemini Case Digest is currently running. Stop it before starting Perplexity.');
    return;
  }
  const preOpenedWebWin = preOpenPerplexityWebWindow();
  const ready = await ensurePdfOpenedAndLoaded(pdfItem);
  if (!ready) {
    if (preOpenedWebWin && !preOpenedWebWin.closed) {
      try { preOpenedWebWin.close(); } catch {}
    }
    toast(`Could not load "${pdfItem.name}" for Perplexity Digest.`);
    return;
  }
  await openPerplexityDigestForCurrentPdf({ preOpenedWebWin });
}

/**
 * Right-click handler for a Folder/Subfolder in the Library sidebar:
 * Automatically processes every PDF in the folder one-by-one in Perplexity "Law" Project
 * using Claude 5.5 Sonnet, waits for each digest to finish and save into Case Digest,
 * and moves to the next PDF automatically.
 */
export async function runBatchPerplexityDigestForFolders(foldersOrFolder) {
  if (_batchDigestState.running) {
    toast(_batchDigestState.provider === 'gemini'
      ? 'A Batch Gemini Digest is already running. Stop it first.'
      : 'A Batch Perplexity Digest is already running.');
    return;
  }
  if (_isDigestingGemini) {
    toast('A Gemini Case Digest is currently running. Stop it first.');
    return;
  }
  if (_isDigestingPerplexity) {
    toast('A Perplexity Case Digest is already in progress.');
    return;
  }
  const { folders, pdfQueue } = collectPdfQueueForFolders(foldersOrFolder);
  if (!folders.length) return;

  if (!pdfQueue.length) {
    toast('No PDFs found inside this folder/subfolder to digest.');
    return;
  }

  const sharedWebWin = preOpenPerplexityWebWindow();
  _batchDigestState.running = true;
  _batchDigestState.cancelled = false;
  _batchDigestState.provider = 'perplexity';
  _batchDigestState.currentPdfId = null;
  _batchDigestState.resolveCurrentPdf = null;
  _batchDigestState.countLabel = `0 / ${pdfQueue.length}`;

  let completedCount = 0;
  const folderTitle = folders.map(f => f.name).join(', ');
  toast(`Starting Batch Perplexity Digest for ${pdfQueue.length} PDF${pdfQueue.length === 1 ? '' : 's'} in "${folderTitle}"…`);

  try {
    for (let i = 0; i < pdfQueue.length; i++) {
      if (_batchDigestState.cancelled) break;
      const pdfItem = pdfQueue[i];
      const trueId = String(pdfItem.linked_pdf_id || pdfItem.id || '');
      const stepLabel = `${i + 1} / ${pdfQueue.length}`;
      _batchDigestState.countLabel = stepLabel;

      updateBatchDigestBanner(`Loading "${pdfItem.name}"…`, true, { provider: 'perplexity', state: 'extracting', countLabel: stepLabel });
      const loaded = await ensurePdfOpenedAndLoaded(pdfItem);
      if (!loaded || _batchDigestState.cancelled) {
        toast(`Skipping "${pdfItem.name}" (could not load PDF).`);
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

      updateBatchDigestBanner(`Submitting "${pdfItem.name}" to Perplexity "Law"…`, true, { provider: 'perplexity', state: 'extracting', countLabel: stepLabel });
      await openPerplexityDigestForCurrentPdf({
        forceAutoSubmit: true,
        forceAutoSend: true,
        preOpenedWebWin: sharedWebWin && !sharedWebWin.closed ? sharedWebWin : undefined,
        keepWebWinOnEmpty: true,
        countLabel: stepLabel,
      });

      if (_batchDigestState.cancelled) break;

      updateBatchDigestBanner(`Waiting for Perplexity to finish "${pdfItem.name}"…`, true, { provider: 'perplexity', state: 'awaiting', countLabel: stepLabel });
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
            `Saved "${pdfItem.name}"! Starting next case (${i + 2}/${pdfQueue.length}) in ${cd}s…`,
            true,
            { provider: 'perplexity', state: 'awaiting', countLabel: stepLabel }
          );
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    if (!_batchDigestState.cancelled) {
      updateBatchDigestBanner(
        `Batch Complete! Saved Case Digests for ${completedCount} of ${pdfQueue.length} PDFs.`,
        false,
        { provider: 'perplexity', state: 'done', countLabel: `${completedCount} / ${pdfQueue.length}`, hideStripAfterMs: 5000 }
      );
      toast(`Batch Perplexity Digest complete! (${completedCount}/${pdfQueue.length} cases digested)`);
    }
  } finally {
    if (sharedWebWin && !sharedWebWin.closed && completedCount === 0 && _batchDigestState.cancelled) {
      try { sharedWebWin.close(); } catch {}
    }
    _batchDigestState.running = false;
    _batchDigestState.currentPdfId = null;
    _batchDigestState.resolveCurrentPdf = null;
    _batchDigestState.countLabel = '';
  }
}

/**
 * Extracts entire PDF text + Subfolder Instruction, copies to clipboard, and opens
 * the Perplexity "Law" Project Digest Studio window (with auto-paste & auto-submit).
 */
export async function openPerplexityDigestForCurrentPdf(opts = {}) {
  if (_isDigestingPerplexity) return;
  if (_isDigestingGemini || (_batchDigestState.running && _batchDigestState.provider === 'gemini')) {
    if (opts.preOpenedWebWin && !opts.preOpenedWebWin.closed && !opts.keepWebWinOnEmpty) {
      try { opts.preOpenedWebWin.close(); } catch {}
    }
    toast('A Gemini Case Digest is currently running. Stop it before starting Perplexity.');
    return;
  }
  if (!S.pdfDoc || !S.totalPages || S.totalPages <= 0 || !S.curPDF) {
    if (opts.preOpenedWebWin && !opts.preOpenedWebWin.closed && !opts.keepWebWinOnEmpty) {
      try { opts.preOpenedWebWin.close(); } catch {}
    }
    toast('Open a PDF first to generate a Case Digest in Perplexity.');
    return;
  }

  const tauriInvoke = getTauriInvoke();
  const hasDesktopStudio = hasDesktopPerplexityStudio();
  let preOpenedWebWin = (opts.preOpenedWebWin && !opts.preOpenedWebWin.closed)
    ? opts.preOpenedWebWin
    : preOpenPerplexityWebWindow();

  const btn = document.getElementById('btn-perplexity-digest');
  const origHtml = btn ? btn.innerHTML : '';
  _isDigestingPerplexity = true;
  _singleDigestCancelled = false;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-clock"/></svg><span>Preparing…</span>';
  }

  const total = S.totalPages;
  const doc = S.pdfDoc;
  const pdfObj = S.curPDF;
  const trueId = pdfObj.linked_pdf_id || pdfObj.id;
  const countLabel = opts.countLabel || _batchDigestState.countLabel || '';

  applyPerplexityStudioStatus({
    state: 'extracting',
    stepLabel: _batchDigestState.running ? 'Batch Digest' : 'Perplexity Studio',
    message: `Extracting ${total} page${total === 1 ? '' : 's'} of "${pdfObj.name || 'Case'}"…`,
    countLabel,
    pdfId: String(trueId || ''),
    pdfName: String(pdfObj.name || ''),
  });

  try {
    toast(`Extracting PDF text (${total} page${total === 1 ? '' : 's'}) for Perplexity "Law" Project…`);

    const extracted = await extractPdfDigestPromptPayload({
      doc,
      total,
      pdfObj,
      isCancelled: () => _singleDigestCancelled || _batchDigestState.cancelled,
    });

    if (!extracted.ok) {
      if (preOpenedWebWin && !preOpenedWebWin.closed && !opts.keepWebWinOnEmpty) {
        try { preOpenedWebWin.close(); } catch {}
      }
      applyPerplexityStudioStatus({
        state: 'error',
        stepLabel: 'No Text Found',
        message: 'No selectable text found in this PDF (run Scan OCR first).',
        error: 'No selectable text found in this PDF (run Scan OCR first).',
        countLabel,
        pdfId: String(trueId || ''),
        pdfName: String(pdfObj.name || ''),
        canRetry: true,
      });
      toast('No selectable text found in this PDF (run Scan OCR first).');
      return;
    }

    const { pdfText, subfolderName, instructionText, fullPromptText } = extracted;
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
    _lastStudioPayload = studioPayload;
    _lastPplxUrl = pinnedProjectUrl || 'https://www.perplexity.ai/spaces';

    if (typeof window.desktopOpenPerplexityStudio === 'function') {
      const opened = await window.desktopOpenPerplexityStudio(studioPayload);
      if (opened) {
        applyPerplexityStudioStatus({
          state: 'streaming',
          stepLabel: _batchDigestState.running ? 'Batch Digest' : 'Perplexity Studio',
          message: `Digesting "${pdfObj.name || 'Case'}" in Perplexity Studio…`,
          countLabel,
          pdfId: String(trueId || ''),
          pdfName: String(pdfObj.name || ''),
        });
        toast('Opened Perplexity "Law" Digest Studio!');
        return;
      }
    } else if (tauriInvoke) {
      try {
        const opened = await tauriInvoke('desktop_open_perplexity_studio', studioPayload);
        if (opened) {
          applyPerplexityStudioStatus({
            state: 'streaming',
            stepLabel: _batchDigestState.running ? 'Batch Digest' : 'Perplexity Studio',
            message: `Digesting "${pdfObj.name || 'Case'}" in Perplexity Studio…`,
            countLabel,
            pdfId: String(trueId || ''),
            pdfName: String(pdfObj.name || ''),
          });
          toast('Opened Perplexity "Law" Digest Studio!');
          return;
        }
      } catch (ipcErr) {
        console.warn('[perplexity-digest] direct Tauri invoke failed:', ipcErr);
      }
    }

    // Web / external browser fallback
    const fallbackUrl = _lastPplxUrl;
    if (preOpenedWebWin && !preOpenedWebWin.closed) {
      preOpenedWebWin.location.href = fallbackUrl;
      preOpenedWebWin.focus?.();
      _lastPplxWebWin = preOpenedWebWin;
    } else if (typeof window.desktopOpenUrl === 'function') {
      await window.desktopOpenUrl(fallbackUrl);
    } else if (tauriInvoke) {
      await tauriInvoke('desktop_open_url', { url: fallbackUrl }).catch(() => {});
    } else if (!hasDesktopStudio) {
      const w = window.open(fallbackUrl, '_blank');
      if (w) {
        _lastPplxWebWin = w;
        w.focus?.();
      } else {
        applyPerplexityStudioStatus({
          state: 'error',
          stepLabel: 'Popup Blocked',
          message: 'Browser blocked the Perplexity tab. Click Focus Tab to open it.',
          error: 'Browser blocked the Perplexity tab. Click Focus Tab to open it.',
          countLabel,
          pdfId: String(trueId || ''),
          pdfName: String(pdfObj.name || ''),
          canRetry: false,
        });
      }
    }
    if (_pplxMonitorState.state !== 'error') {
      applyPerplexityStudioStatus({
        state: 'awaiting',
        stepLabel: 'Perplexity Tab',
        message: 'Opened Perplexity tab — Paste (Ctrl+V) & copy reply back to Case Digest',
        countLabel,
        pdfId: String(trueId || ''),
        pdfName: String(pdfObj.name || ''),
      });
    }
    toast('Copied case + instructions! Paste (Ctrl+V) in your Perplexity "Law" Project.');
  } catch (err) {
    if (preOpenedWebWin && !preOpenedWebWin.closed && !opts.keepWebWinOnEmpty) {
      try { preOpenedWebWin.close(); } catch {}
    }
    if (_singleDigestCancelled || _batchDigestState.cancelled || err?.message === 'Cancelled by user') {
      return;
    }
    console.error('[perplexity-digest] Error:', err);
    applyPerplexityStudioStatus({
      state: 'error',
      stepLabel: 'Digest Error',
      message: `Could not start Perplexity Digest: ${err.message || err}`,
      error: `Could not start Perplexity Digest: ${err.message || err}`,
      countLabel,
      pdfId: String(trueId || ''),
      pdfName: String(pdfObj.name || ''),
      canRetry: true,
    });
    toast(`Could not start Perplexity Digest: ${err.message || err}`);
  } finally {
    _isDigestingPerplexity = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
}

/**
 * Right-click handler for a single PDF in the Library sidebar:
 * Opens the PDF if needed and launches Gemini Digest Studio for it.
 */
export async function runGeminiDigestForPdf(pdfItem) {
  if (!pdfItem) return;
  if (_isDigestingPerplexity || (_batchDigestState.running && _batchDigestState.provider !== 'gemini')) {
    toast('A Perplexity Case Digest is currently running. Stop it before starting Gemini.');
    return;
  }
  const preOpenedWebWin = preOpenGeminiWebWindow();
  const ready = await ensurePdfOpenedAndLoaded(pdfItem);
  if (!ready) {
    if (preOpenedWebWin && !preOpenedWebWin.closed) {
      try { preOpenedWebWin.close(); } catch {}
    }
    toast(`Could not load "${pdfItem.name}" for Gemini Digest.`);
    return;
  }
  await openGeminiDigestForCurrentPdf({ preOpenedWebWin });
}

/**
 * Right-click handler for a Folder/Subfolder in the Library sidebar:
 * Automatically processes every PDF in the folder one-by-one in the Subject's
 * Gemini Notebook, waits for each digest to finish and save into Case Digest,
 * and moves to the next PDF automatically.
 */
export async function runBatchGeminiDigestForFolders(foldersOrFolder) {
  if (_batchDigestState.running) {
    toast(_batchDigestState.provider === 'gemini'
      ? 'A Batch Gemini Digest is already running.'
      : 'A Batch Perplexity Digest is already running. Stop it first.');
    return;
  }
  if (_isDigestingPerplexity) {
    toast('A Perplexity Case Digest is currently running. Stop it first.');
    return;
  }
  if (_isDigestingGemini) {
    toast('A Gemini Case Digest is already in progress.');
    return;
  }
  const { folders, pdfQueue } = collectPdfQueueForFolders(foldersOrFolder);
  if (!folders.length) return;

  if (!pdfQueue.length) {
    toast('No PDFs found inside this folder/subfolder to digest.');
    return;
  }

  const sharedWebWin = preOpenGeminiWebWindow();
  _batchDigestState.running = true;
  _batchDigestState.cancelled = false;
  _batchDigestState.provider = 'gemini';
  _batchDigestState.currentPdfId = null;
  _batchDigestState.resolveCurrentPdf = null;
  _batchDigestState.countLabel = `0 / ${pdfQueue.length}`;

  let completedCount = 0;
  const folderTitle = folders.map(f => f.name).join(', ');
  toast(`Starting Batch Gemini Digest for ${pdfQueue.length} PDF${pdfQueue.length === 1 ? '' : 's'} in "${folderTitle}"…`);

  try {
    for (let i = 0; i < pdfQueue.length; i++) {
      if (_batchDigestState.cancelled) break;
      const pdfItem = pdfQueue[i];
      const trueId = String(pdfItem.linked_pdf_id || pdfItem.id || '');
      const stepLabel = `${i + 1} / ${pdfQueue.length}`;
      _batchDigestState.countLabel = stepLabel;

      updateBatchDigestBanner(`Loading "${pdfItem.name}"…`, true, { provider: 'gemini', state: 'extracting', countLabel: stepLabel });
      const loaded = await ensurePdfOpenedAndLoaded(pdfItem);
      if (!loaded || _batchDigestState.cancelled) {
        toast(`Skipping "${pdfItem.name}" (could not load PDF).`);
        continue;
      }

      const digestSavedPromise = new Promise((resolve) => {
        _batchDigestState.currentPdfId = trueId;
        const timeoutId = setTimeout(() => {
          if (_batchDigestState.resolveCurrentPdf) {
            _batchDigestState.resolveCurrentPdf = null;
          }
          resolve(false);
        }, 6 * 60 * 1000);

        _batchDigestState.resolveCurrentPdf = (ok) => {
          clearTimeout(timeoutId);
          _batchDigestState.resolveCurrentPdf = null;
          _batchDigestState.currentPdfId = null;
          resolve(Boolean(ok));
        };
      });

      updateBatchDigestBanner(`Submitting "${pdfItem.name}" to Gemini Notebook…`, true, { provider: 'gemini', state: 'extracting', countLabel: stepLabel });
      await openGeminiDigestForCurrentPdf({
        forceAutoSubmit: true,
        forceAutoSend: true,
        preOpenedWebWin: sharedWebWin && !sharedWebWin.closed ? sharedWebWin : undefined,
        keepWebWinOnEmpty: true,
        countLabel: stepLabel,
      });

      if (_batchDigestState.cancelled) break;

      updateBatchDigestBanner(`Waiting for Gemini to finish "${pdfItem.name}"…`, true, { provider: 'gemini', state: 'awaiting', countLabel: stepLabel });
      const savedOk = await digestSavedPromise;
      if (_batchDigestState.cancelled) break;

      if (savedOk) {
        completedCount++;
      }

      if (i + 1 < pdfQueue.length && !_batchDigestState.cancelled) {
        for (let cd = 5; cd >= 1; cd--) {
          if (_batchDigestState.cancelled) break;
          updateBatchDigestBanner(
            `Saved "${pdfItem.name}"! Starting next case (${i + 2}/${pdfQueue.length}) in ${cd}s…`,
            true,
            { provider: 'gemini', state: 'awaiting', countLabel: stepLabel }
          );
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }

    if (!_batchDigestState.cancelled) {
      updateBatchDigestBanner(
        `Batch Complete! Saved Gemini Case Digests for ${completedCount} of ${pdfQueue.length} PDFs.`,
        false,
        { provider: 'gemini', state: 'done', countLabel: `${completedCount} / ${pdfQueue.length}`, hideStripAfterMs: 5000 }
      );
      toast(`Batch Gemini Digest complete! (${completedCount}/${pdfQueue.length} cases digested)`);
    }
  } finally {
    if (sharedWebWin && !sharedWebWin.closed && completedCount === 0 && _batchDigestState.cancelled) {
      try { sharedWebWin.close(); } catch {}
    }
    _batchDigestState.running = false;
    _batchDigestState.currentPdfId = null;
    _batchDigestState.resolveCurrentPdf = null;
    _batchDigestState.countLabel = '';
  }
}

/**
 * Extracts entire PDF text + Subfolder Instruction, copies to clipboard, resolves
 * the Subject's pinned Gemini Notebook URL, and opens the Gemini Digest Studio
 * window (or falls back to opening Gemini in the browser).
 */
export async function openGeminiDigestForCurrentPdf(opts = {}) {
  if (_isDigestingGemini) return;
  if (_isDigestingPerplexity || (_batchDigestState.running && _batchDigestState.provider !== 'gemini')) {
    if (opts.preOpenedWebWin && !opts.preOpenedWebWin.closed && !opts.keepWebWinOnEmpty) {
      try { opts.preOpenedWebWin.close(); } catch {}
    }
    toast('A Perplexity Case Digest is currently running. Stop it before starting Gemini.');
    return;
  }
  if (!S.pdfDoc || !S.totalPages || S.totalPages <= 0 || !S.curPDF) {
    if (opts.preOpenedWebWin && !opts.preOpenedWebWin.closed && !opts.keepWebWinOnEmpty) {
      try { opts.preOpenedWebWin.close(); } catch {}
    }
    toast('Open a PDF first to generate a Case Digest in Gemini.');
    return;
  }

  const tauriInvoke = getTauriInvoke();
  const hasDesktopStudio = hasDesktopGeminiStudio();
  let preOpenedWebWin = (opts.preOpenedWebWin && !opts.preOpenedWebWin.closed)
    ? opts.preOpenedWebWin
    : preOpenGeminiWebWindow();

  const btn = document.getElementById('btn-gemini-digest');
  const origHtml = btn ? btn.innerHTML : '';
  _isDigestingGemini = true;
  _singleDigestCancelled = false;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-clock"/></svg><span>Preparing…</span>';
  }

  const total = S.totalPages;
  const doc = S.pdfDoc;
  const pdfObj = S.curPDF;
  const trueId = pdfObj.linked_pdf_id || pdfObj.id;
  const countLabel = opts.countLabel || _batchDigestState.countLabel || '';

  applyDigestMonitorStatus('gemini', {
    state: 'extracting',
    stepLabel: _batchDigestState.running ? 'Batch Digest' : 'Gemini Studio',
    message: `Extracting ${total} page${total === 1 ? '' : 's'} of "${pdfObj.name || 'Case'}"…`,
    countLabel,
    pdfId: String(trueId || ''),
    pdfName: String(pdfObj.name || ''),
  });

  try {
    toast(`Extracting PDF text (${total} page${total === 1 ? '' : 's'}) for Gemini Notebook…`);

    const extracted = await extractPdfDigestPromptPayload({
      doc,
      total,
      pdfObj,
      isCancelled: () => _singleDigestCancelled || _batchDigestState.cancelled,
    });

    if (!extracted.ok) {
      if (preOpenedWebWin && !preOpenedWebWin.closed && !opts.keepWebWinOnEmpty) {
        try { preOpenedWebWin.close(); } catch {}
      }
      applyDigestMonitorStatus('gemini', {
        state: 'error',
        stepLabel: 'No Text Found',
        message: 'No selectable text found in this PDF (run Scan OCR first).',
        error: 'No selectable text found in this PDF (run Scan OCR first).',
        countLabel,
        pdfId: String(trueId || ''),
        pdfName: String(pdfObj.name || ''),
        canRetry: true,
      });
      toast('No selectable text found in this PDF (run Scan OCR first).');
      return;
    }

    const { pdfText, activeFolderId, subfolderName, instructionText, fullPromptText } = extracted;
    await copyToClipboard(fullPromptText);

    const { subjectId, subjectName } = getSubjectInfoForFolder(activeFolderId);
    const pinnedNotebookUrl = await getPinnedGeminiNotebookForSubject(subjectId);
    const { modelLabel, thinkingLevel } = await resolveGeminiModelPrefs();

    const autoSubmitPref = opts?.forceAutoSubmit
      ? true
      : safeStorageGet('gemini_auto_submit', 'true') !== 'false';
    const digestModePref = safeStorageGet('gemini_digest_mode_v2', 'replace') === 'append' ? 'append' : 'replace';
    const autoSendPref = opts?.forceAutoSend
      ? true
      : safeStorageGet('gemini_auto_send', 'true') !== 'false';

    const studioPayload = {
      pdfId: String(trueId || ''),
      pdfName: String(pdfObj.name || 'Case.pdf'),
      subjectId: String(subjectId || ''),
      subjectName: String(subjectName || ''),
      subfolderName: subfolderName ? String(subfolderName) : '',
      instructionText: instructionText ? String(instructionText) : '',
      pdfText: String(pdfText || ''),
      fullPromptText: String(fullPromptText || ''),
      pinnedNotebookUrl: pinnedNotebookUrl ? String(pinnedNotebookUrl) : null,
      modelLabel: String(modelLabel || '4 Hydrogen'),
      thinkingLevel: String(thinkingLevel || 'High'),
      autoSubmit: Boolean(autoSubmitPref),
      digestMode: String(digestModePref),
      autoSendDigest: Boolean(autoSendPref),
    };
    _lastGeminiStudioPayload = studioPayload;
    _lastGeminiUrl = pinnedNotebookUrl || 'https://gemini.google.com/notebooks';

    if (typeof window.desktopOpenGeminiStudio === 'function') {
      const opened = await window.desktopOpenGeminiStudio(studioPayload);
      if (opened) {
        applyDigestMonitorStatus('gemini', {
          state: 'streaming',
          stepLabel: _batchDigestState.running ? 'Batch Digest' : 'Gemini Studio',
          message: `Digesting "${pdfObj.name || 'Case'}" in Gemini Studio…`,
          countLabel,
          pdfId: String(trueId || ''),
          pdfName: String(pdfObj.name || ''),
        });
        toast(subjectName ? `Opened Gemini Digest Studio (${subjectName})!` : 'Opened Gemini Digest Studio!');
        return;
      }
    } else if (tauriInvoke) {
      try {
        const opened = await tauriInvoke('desktop_open_gemini_studio', studioPayload);
        if (opened) {
          applyDigestMonitorStatus('gemini', {
            state: 'streaming',
            stepLabel: _batchDigestState.running ? 'Batch Digest' : 'Gemini Studio',
            message: `Digesting "${pdfObj.name || 'Case'}" in Gemini Studio…`,
            countLabel,
            pdfId: String(trueId || ''),
            pdfName: String(pdfObj.name || ''),
          });
          toast(subjectName ? `Opened Gemini Digest Studio (${subjectName})!` : 'Opened Gemini Digest Studio!');
          return;
        }
      } catch (ipcErr) {
        console.warn('[gemini-digest] direct Tauri invoke failed:', ipcErr);
      }
    }

    // Web / external browser fallback
    const fallbackUrl = _lastGeminiUrl;
    if (preOpenedWebWin && !preOpenedWebWin.closed) {
      preOpenedWebWin.location.href = fallbackUrl;
      preOpenedWebWin.focus?.();
      _lastGeminiWebWin = preOpenedWebWin;
    } else if (typeof window.desktopOpenUrl === 'function') {
      await window.desktopOpenUrl(fallbackUrl);
    } else if (tauriInvoke) {
      await tauriInvoke('desktop_open_url', { url: fallbackUrl }).catch(() => {});
    } else if (!hasDesktopStudio) {
      const w = window.open(fallbackUrl, '_blank');
      if (w) {
        _lastGeminiWebWin = w;
        w.focus?.();
      } else {
        applyDigestMonitorStatus('gemini', {
          state: 'error',
          stepLabel: 'Popup Blocked',
          message: 'Browser blocked the Gemini tab. Click Focus Tab to open it.',
          error: 'Browser blocked the Gemini tab. Click Focus Tab to open it.',
          countLabel,
          pdfId: String(trueId || ''),
          pdfName: String(pdfObj.name || ''),
          canRetry: false,
        });
      }
    }
    if (_pplxMonitorState.state !== 'error') {
      applyDigestMonitorStatus('gemini', {
        state: 'awaiting',
        stepLabel: 'Gemini Tab',
        message: 'Opened Gemini tab — Paste (Ctrl+V) & copy reply back to Case Digest',
        countLabel,
        pdfId: String(trueId || ''),
        pdfName: String(pdfObj.name || ''),
      });
    }
    toast(pinnedNotebookUrl
      ? `Copied case + instructions! Paste (Ctrl+V) in your ${subjectName || 'Subject'} Gemini Notebook.`
      : 'Copied case + instructions! Open your Subject Notebook in Gemini and paste (Ctrl+V).');
  } catch (err) {
    if (preOpenedWebWin && !preOpenedWebWin.closed && !opts.keepWebWinOnEmpty) {
      try { preOpenedWebWin.close(); } catch {}
    }
    if (_singleDigestCancelled || _batchDigestState.cancelled || err?.message === 'Cancelled by user') {
      return;
    }
    console.error('[gemini-digest] Error:', err);
    applyDigestMonitorStatus('gemini', {
      state: 'error',
      stepLabel: 'Digest Error',
      message: `Could not start Gemini Digest: ${err.message || err}`,
      error: `Could not start Gemini Digest: ${err.message || err}`,
      countLabel,
      pdfId: String(trueId || ''),
      pdfName: String(pdfObj.name || ''),
      canRetry: true,
    });
    toast(`Could not start Gemini Digest: ${err.message || err}`);
  } finally {
    _isDigestingGemini = false;
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
 * 4. Wires #btn-perplexity-digest, #btn-gemini-digest, monitor strip & Gemini Settings
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
      copyBtn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-copy"/></svg><span>Copy Text</span>';
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
          toast('Copied formatted text (page numbers removed)');
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
      const globalMainEl = document.getElementById('copy-instr-global-main');
      const globalFooterEl = document.getElementById('copy-instr-global-footer');
      const textarea = document.getElementById('copy-instr-textarea');
      const folderId = modal?.dataset.folderId || getActiveSubfolderId();

      if (globalMainEl) {
        saveGlobalMainCopyInstructionTemplate(globalMainEl.value);
      }
      if (globalFooterEl) {
        saveGlobalFooterCopyInstruction(globalFooterEl.value);
      }
      if (folderId && textarea) {
        saveSubfolderCopyInstruction(folderId, textarea.value);
      }

      updateCopyInstructionButtonState();
      modal?.classList.remove('open');

      if (folderId) {
        const breadcrumb = getFolderBreadcrumb(folderId);
        toast(`Saved global & "${breadcrumb}" copy instructions`);
      } else {
        toast('Saved global Copy Text instructions');
      }
    });
  }

  const btnResetGlobalInstr = document.getElementById('btn-copy-instr-reset-global');
  if (btnResetGlobalInstr) {
    btnResetGlobalInstr.addEventListener('click', () => {
      const modal = document.getElementById('mo-copy-instructions');
      const globalMainEl = document.getElementById('copy-instr-global-main');
      const globalFooterEl = document.getElementById('copy-instr-global-footer');
      if (globalMainEl) globalMainEl.value = DEFAULT_GLOBAL_MAIN_INSTRUCTION_TEMPLATE;
      if (globalFooterEl) globalFooterEl.value = DEFAULT_DIGEST_FOOTER_INSTRUCTION;
      const folderId = modal?.dataset.folderId || getActiveSubfolderId();
      updateCopyInstrAutoPreview(folderId, DEFAULT_GLOBAL_MAIN_INSTRUCTION_TEMPLATE);
      toast('Reset global instructions to default (click Save to apply)');
    });
  }

  const globalMainInput = document.getElementById('copy-instr-global-main');
  if (globalMainInput) {
    globalMainInput.addEventListener('input', () => {
      const modal = document.getElementById('mo-copy-instructions');
      const folderId = modal?.dataset.folderId || getActiveSubfolderId();
      updateCopyInstrAutoPreview(folderId, globalMainInput.value);
    });
    globalMainInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        btnSaveInstr?.click();
      }
    });
  }

  const globalFooterInput = document.getElementById('copy-instr-global-footer');
  if (globalFooterInput) {
    globalFooterInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        btnSaveInstr?.click();
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
        toast(`Cleared copy instructions for "${breadcrumb}"`);
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
  hydrateGlobalCopyInstructionsFromCloud();

  const btnPplx = document.getElementById('btn-perplexity-digest');
  if (btnPplx) {
    btnPplx.addEventListener('click', (e) => {
      e.stopPropagation();
      openPerplexityDigestForCurrentPdf();
    });
  }

  const btnGemini = document.getElementById('btn-gemini-digest');
  if (btnGemini) {
    btnGemini.addEventListener('click', (e) => {
      e.stopPropagation();
      openGeminiDigestForCurrentPdf();
    });
  }

  const btnSaveGeminiSettings = document.getElementById('settings-btn-save-gemini-digest');
  if (btnSaveGeminiSettings) {
    btnSaveGeminiSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      saveGeminiDigestSettingsFromCard();
    });
  }

  document.getElementById('focusPplxBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_pplxMonitorState.provider === 'gemini') {
      focusOrReopenGeminiStudio();
    } else {
      focusOrReopenPerplexityStudio();
    }
  });
  document.getElementById('pplxMonitorAlertBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isGemini = _pplxMonitorState.provider === 'gemini';
    if (_pplxMonitorState.canRetry && S.curPDF) {
      if (isGemini) {
        openGeminiDigestForCurrentPdf();
      } else {
        openPerplexityDigestForCurrentPdf();
      }
    } else if (isGemini) {
      focusOrReopenGeminiStudio();
    } else {
      focusOrReopenPerplexityStudio();
    }
  });
  document.getElementById('stopDigestBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_pplxMonitorState.provider === 'gemini') {
      stopActiveGeminiDigest();
    } else {
      stopActivePerplexityDigest();
    }
  });
}

if (typeof window !== 'undefined') {
  window.copySelectedTextClean = copySelectedTextClean;
  window.copyEntirePdfTextSmart = copyEntirePdfTextSmart;
  window.openPerplexityDigestForCurrentPdf = openPerplexityDigestForCurrentPdf;
  window.runPerplexityDigestForPdf = runPerplexityDigestForPdf;
  window.runBatchPerplexityDigestForFolders = runBatchPerplexityDigestForFolders;
  window.focusOrReopenPerplexityStudio = focusOrReopenPerplexityStudio;
  window.stopActivePerplexityDigest = stopActivePerplexityDigest;
  window.openGeminiDigestForCurrentPdf = openGeminiDigestForCurrentPdf;
  window.runGeminiDigestForPdf = runGeminiDigestForPdf;
  window.runBatchGeminiDigestForFolders = runBatchGeminiDigestForFolders;
  window.focusOrReopenGeminiStudio = focusOrReopenGeminiStudio;
  window.stopActiveGeminiDigest = stopActiveGeminiDigest;
  window.getSubjectInfoForFolder = getSubjectInfoForFolder;
  window.normalizeGeminiNotebookUrl = normalizeGeminiNotebookUrl;
  window.getPinnedGeminiNotebookForSubject = getPinnedGeminiNotebookForSubject;
  window.setPinnedGeminiNotebookForSubject = setPinnedGeminiNotebookForSubject;
  window.getGeminiModelPrefs = getGeminiModelPrefs;
  window.saveGeminiModelPrefs = saveGeminiModelPrefs;
  window.refreshGeminiDigestSettingsCard = refreshGeminiDigestSettingsCard;
  window.stripPageNumbersAndFooters = stripPageNumbersAndFooters;
  window.formatPageTextContent = formatPageTextContent;
  window.initSmartCopy = initSmartCopy;

  window.__onPerplexityStudioStatus = (payload) => {
    applyPerplexityStudioStatus(payload);
  };

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
    if (ok) {
      applyPerplexityStudioStatus({
        state: 'done',
        stepLabel: _batchDigestState.running ? 'Batch Digest' : 'Perplexity Studio',
        message: 'Saved into Case Digest',
        pdfId: msg.pdfId || '',
        hideStripAfterMs: _batchDigestState.running ? undefined : 4000,
      });
    }
    if (typeof _batchDigestState.resolveCurrentPdf === 'function') {
      if (!_batchDigestState.currentPdfId || !msg.pdfId || String(msg.pdfId) === String(_batchDigestState.currentPdfId)) {
        _batchDigestState.resolveCurrentPdf(ok);
      }
    }
  };

  window.__onGeminiStudioStatus = (payload) => {
    applyDigestMonitorStatus('gemini', payload);
  };

  window.__onGeminiPrefsUpdated = (prefs) => {
    if (!prefs || typeof prefs !== 'object') return;
    let notebooksUpdated = false;
    const map = readLocalGeminiNotebooksMap();

    if (prefs.subjectNotebooks && typeof prefs.subjectNotebooks === 'object' && !Array.isArray(prefs.subjectNotebooks)) {
      for (const [sid, url] of Object.entries(prefs.subjectNotebooks)) {
        if (!sid) continue;
        const norm = normalizeGeminiNotebookUrl(url);
        if (norm) {
          map[String(sid)] = norm;
        } else {
          delete map[String(sid)];
        }
      }
      notebooksUpdated = true;
    }

    if (prefs.subjectId && typeof prefs.pinnedNotebookUrl === 'string') {
      const sid = String(prefs.subjectId);
      const norm = normalizeGeminiNotebookUrl(prefs.pinnedNotebookUrl);
      if (norm) {
        map[sid] = norm;
      } else {
        delete map[sid];
      }
      notebooksUpdated = true;
    }

    if (notebooksUpdated) {
      const cleanMap = writeLocalGeminiNotebooksMap(map);
      dbSetSetting('gemini_subject_notebooks', JSON.stringify(cleanMap)).catch(() => {});
    }

    if (typeof prefs.modelLabel === 'string' && prefs.modelLabel.trim()) {
      const cleanModel = prefs.modelLabel.trim();
      safeStorageSet('gemini_model_label', cleanModel);
      dbSetSetting('gemini_model_label', cleanModel).catch(() => {});
    }
    if (typeof prefs.thinkingLevel === 'string' && prefs.thinkingLevel.trim()) {
      const cleanThinking = prefs.thinkingLevel.trim();
      safeStorageSet('gemini_thinking_level', cleanThinking);
      dbSetSetting('gemini_thinking_level', cleanThinking).catch(() => {});
    }
    if (typeof prefs.autoSubmit === 'boolean') {
      safeStorageSet('gemini_auto_submit', prefs.autoSubmit ? 'true' : 'false');
    }
    if (prefs.digestMode === 'replace' || prefs.digestMode === 'append') {
      safeStorageSet('gemini_digest_mode', prefs.digestMode);
      safeStorageSet('gemini_digest_mode_v2', prefs.digestMode);
    }
    if (typeof prefs.autoSendDigest === 'boolean') {
      safeStorageSet('gemini_auto_send', prefs.autoSendDigest ? 'true' : 'false');
    }

    if (document.getElementById('mo-settings')?.classList.contains('open')) {
      refreshGeminiDigestSettingsCard().catch(() => {});
    }
  };

  window.__onGeminiDigestReceived = async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const { importDigestIntoCaseDigestTab } = await import('./notepad.js');
    const ok = await importDigestIntoCaseDigestTab(
      msg.pdfId || '',
      msg.html || '',
      msg.text || '',
      msg.digestMode === 'append' ? 'append' : 'replace',
      'Gemini'
    );
    if (ok) {
      applyDigestMonitorStatus('gemini', {
        state: 'done',
        stepLabel: _batchDigestState.running ? 'Batch Digest' : 'Gemini Studio',
        message: 'Saved into Case Digest',
        pdfId: msg.pdfId || '',
        hideStripAfterMs: _batchDigestState.running ? undefined : 4000,
      });
    }
    if (typeof _batchDigestState.resolveCurrentPdf === 'function') {
      if (!_batchDigestState.currentPdfId || !msg.pdfId || String(msg.pdfId) === String(_batchDigestState.currentPdfId)) {
        _batchDigestState.resolveCurrentPdf(ok);
      }
    }
  };
}
