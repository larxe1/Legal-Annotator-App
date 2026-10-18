// ═══════════════════════════════════════════════
// DIAGNOSTICS & AUDIT LOG FOR PDF NOTEPAD & CASE DIGESTS
// ═══════════════════════════════════════════════

import { safeStorageSet, safeStorageGet } from './storage.js';

const MAX_LOGS_PER_PDF = 60;
const MAX_GLOBAL_LOGS  = 120;

export function logNotepadDiagnostic(pdfId, action, status, code, message, extra = null) {
  if (!pdfId) pdfId = 'UNKNOWN_PDF';
  const entry = {
    id: 'diag_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    ts: Date.now(),
    iso: new Date().toISOString(),
    pdfId,
    action,  // 'SAVE' | 'LOAD' | 'RESTORE' | 'SYNC' | 'OUTBOX' | 'OPEN' | 'MERGE'
    status,  // 'OK' | 'WARN' | 'ERR' | 'INFO'
    code:    String(code || 'UNKNOWN'),
    message: String(message || ''),
    online:  typeof navigator !== 'undefined' ? navigator.onLine : true,
    extra:   extra ? JSON.parse(JSON.stringify(extra, (k, v) => v instanceof Error ? { message: v.message, stack: v.stack } : v)) : null
  };

  try {
    // 1. Per-PDF diagnostic log
    const pdfKey = 'notepad_diag_log_' + pdfId;
    let pdfLogs = JSON.parse(safeStorageGet(pdfKey, '[]') || '[]');
    pdfLogs.unshift(entry);
    if (pdfLogs.length > MAX_LOGS_PER_PDF) pdfLogs = pdfLogs.slice(0, MAX_LOGS_PER_PDF);
    safeStorageSet(pdfKey, JSON.stringify(pdfLogs));

    // 2. Global diagnostic log
    const globalKey = 'notepad_global_diag_log';
    let globalLogs = JSON.parse(safeStorageGet(globalKey, '[]') || '[]');
    globalLogs.unshift(entry);
    if (globalLogs.length > MAX_GLOBAL_LOGS) globalLogs = globalLogs.slice(0, MAX_GLOBAL_LOGS);
    safeStorageSet(globalKey, JSON.stringify(globalLogs));

    // Console logging with distinct format
    const prefix = `[Notepad Diag][${action}][${status}][${code}]`;
    if (status === 'ERR') {
      console.error(prefix, message, entry);
    } else if (status === 'WARN') {
      console.warn(prefix, message, entry);
    } else {
      console.log(prefix, message);
    }
  } catch (e) {
    console.warn('[Diag Logger Error]', e);
  }

  return entry;
}

export function getNotepadDiagnostics(pdfId) {
  if (!pdfId) return [];
  try {
    const pdfKey = 'notepad_diag_log_' + pdfId;
    return JSON.parse(safeStorageGet(pdfKey, '[]') || '[]');
  } catch {
    return [];
  }
}

export function getGlobalDiagnostics() {
  try {
    return JSON.parse(safeStorageGet('notepad_global_diag_log', '[]') || '[]');
  } catch {
    return [];
  }
}

export function clearNotepadDiagnostics(pdfId) {
  if (!pdfId) return;
  safeStorageSet('notepad_diag_log_' + pdfId, '[]');
}

export function generateDiagnosticReport(pdfId, pdfName = '') {
  const logs = getNotepadDiagnostics(pdfId);
  const globalLogs = getGlobalDiagnostics().slice(0, 20);
  const report = {
    report_generated_at: new Date().toISOString(),
    pdf_id: pdfId,
    pdf_name: pdfName,
    online_status: typeof navigator !== 'undefined' ? navigator.onLine : true,
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    recent_logs_count: logs.length,
    pdf_logs: logs,
    global_system_logs: globalLogs
  };
  return JSON.stringify(report, null, 2);
}
