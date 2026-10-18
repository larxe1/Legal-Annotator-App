// ═══════════════════════════════════════════════
// OUTBOX — Offline Write & Two-Way Auto-Sync Queue
// Allows creating, editing, and deleting notes/highlights offline,
// and automatically replays all changes to Supabase when reconnected.
// ═══════════════════════════════════════════════

import { safeStorageSet, safeStorageGet } from './storage.js';

const QUEUE_KEY = 'offline_outbox_queue';
let _isReplaying = false;

// ── Read / Write Queue in localStorage ──
export function getOutboxQueue() {
  try {
    return JSON.parse(safeStorageGet(QUEUE_KEY, '[]') || '[]');
  } catch {
    return [];
  }
}

function saveOutboxQueue(queue) {
  safeStorageSet(QUEUE_KEY, JSON.stringify(queue));
  updateOutboxUI();
}

// ── Add action to offline queue ──
export function enqueueAction(table, action, data, matchQuery = null) {
  const queue = getOutboxQueue();
  const entry = {
    qid: 'outbox_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    table,
    action, // 'upsert' | 'delete'
    data,
    matchQuery, // { id: '...' } for delete
    created_at: Date.now()
  };

  queue.push(entry);
  saveOutboxQueue(queue);
  console.log(`[Outbox] Enqueued offline action: ${action} on ${table}`, entry);
}

// ── Update sync status bar with pending count ──
export function updateOutboxUI() {
  const queue = getOutboxQueue();
  const stxt = document.getElementById('stxt');
  const sdot = document.getElementById('sdot');
  if (!stxt || !sdot) return;

  if (queue.length > 0) {
    sdot.className = 'sdot spin';
    sdot.style.background = 'var(--gold)';
    stxt.textContent = `Offline (${queue.length} edit${queue.length === 1 ? '' : 's'} pending sync)`;
  } else if (!navigator.onLine) {
    sdot.className = 'sdot ok';
    sdot.style.background = '#38bdf8';
    stxt.textContent = 'Offline Mode (Local Cache)';
  } else {
    sdot.style.background = '';
  }
}

function getUpsertOptions(table) {
  if (table === 'dictionary') return { onConflict: 'word' };
  if (table === 'pdf_notes') return { onConflict: 'pdf_id' };
  return undefined;
}

// ── Safety Guard: Ensure delete/update queries always have valid, non-empty criteria ──
function isValidMatchQuery(matchQuery) {
  if (!matchQuery || typeof matchQuery !== 'object') return false;
  const entries = Object.entries(matchQuery);
  if (entries.length === 0) return false;
  return entries.every(([_, v]) => v !== undefined && v !== null && v !== '');
}

// ── Replay all queued actions to Supabase ──
export async function replayOutbox(dbClient) {
  if (_isReplaying) return;
  if (!navigator.onLine) return;

  const queue = getOutboxQueue();
  if (queue.length === 0) return;

  _isReplaying = true;
  console.log(`[Outbox] Replaying ${queue.length} pending offline actions to Supabase…`);

  const stxt = document.getElementById('stxt');
  const sdot = document.getElementById('sdot');
  if (stxt) stxt.textContent = `Syncing ${queue.length} offline edit${queue.length === 1 ? '' : 's'}…`;
  if (sdot) sdot.className = 'sdot spin';

  const remaining = [];

  for (const item of queue) {
    try {
      if (item.action === 'upsert') {
        const { error } = await dbClient.from(item.table).upsert(item.data, getUpsertOptions(item.table));
        if (error) throw error;
      } else if (item.action === 'update') {
        let q = dbClient.from(item.table).update(item.data);
        if (item.matchQuery && isValidMatchQuery(item.matchQuery)) {
          q = q.match(item.matchQuery);
        } else if (item.data?.id) {
          q = q.eq('id', item.data.id);
        } else {
          console.warn(`[Outbox] Dropping unsafe update without criteria on ${item.table}`);
          continue;
        }
        const { error } = await q;
        if (error) throw error;
      } else if (item.action === 'delete') {
        if (!isValidMatchQuery(item.matchQuery)) {
          console.warn(`[Outbox] Dropping unsafe delete with invalid criteria on ${item.table}:`, item.matchQuery);
          continue;
        }
        const { error } = await dbClient.from(item.table).delete().match(item.matchQuery);
        if (error) throw error;
      }
      console.log(`[Outbox] Successfully synced: ${item.action} on ${item.table}`);
    } catch (err) {
      item.retries = (item.retries || 0) + 1;
      import('./ui.js').then(m => m.recordError(err, `Sync ${item.action} on ${item.table}`));
      
      const errMsg = (err?.message || err?.details || String(err)).toLowerCase();
      const isFatal = errMsg.includes('syntax') || errMsg.includes('constraint') || 
                      errMsg.includes('violates') || errMsg.includes('column') || 
                      errMsg.includes('relation') || errMsg.includes('42703') || 
                      errMsg.includes('23502') || errMsg.includes('23503') || errMsg.includes('22p02') || 
                      errMsg.includes('23505') || errMsg.includes('foreign key') || item.retries >= 2 || 
                      (Date.now() - (item.created_at || 0) > 86400000);
      
      if (isFatal) {
        console.warn(`[Outbox] Dropping unrecoverable outbox action:`, item, err);
      } else {
        remaining.push(item);
      }
    }
  }

  saveOutboxQueue(remaining);
  _isReplaying = false;

  if (remaining.length === 0) {
    if (stxt) stxt.textContent = 'DB Sync Active';
    if (sdot) { sdot.className = 'sdot ok'; sdot.style.background = ''; }
  } else {
    updateOutboxUI();
  }
}

// ── Wrapper: Execute Supabase write or safely enqueue if offline ──
export async function safeDbWrite(dbClient, table, action, data, matchQuery = null) {
  // Safety check on delete operations: ensure strict criteria
  if (action === 'delete' && !isValidMatchQuery(matchQuery)) {
    console.error(`[Outbox] Blocked unsafe delete on "${table}" — matchQuery is missing or contains invalid keys:`, matchQuery);
    return;
  }

  // If we know we are offline, enqueue immediately
  if (!navigator.onLine) {
    enqueueAction(table, action, data, matchQuery);
    return;
  }

  let timeoutId = null;
  try {
    const dbPromise = (async () => {
      if (action === 'upsert') {
        const { error } = await dbClient.from(table).upsert(data, getUpsertOptions(table));
        if (error) throw error;
      } else if (action === 'update') {
        let q = dbClient.from(table).update(data);
        if (matchQuery && isValidMatchQuery(matchQuery)) {
          q = q.match(matchQuery);
        } else if (data?.id) {
          q = q.eq('id', data.id);
        } else {
          console.error(`[Outbox] Blocked unsafe update on "${table}" — no valid matchQuery or id provided:`, data);
          return;
        }
        const { error } = await q;
        if (error) throw error;
      } else if (action === 'delete') {
        const { error } = await dbClient.from(table).delete().match(matchQuery);
        if (error) throw error;
      }
    })();

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Supabase ${action} on ${table} timed out after 8s`)), 8000);
    });

    await Promise.race([dbPromise, timeoutPromise]);
  } catch (err) {
    const errMsg = (err?.message || err?.details || String(err)).toLowerCase();
    const isForeignKey = err?.code === '23503' || errMsg.includes('23503') || errMsg.includes('foreign key') || errMsg.includes('fkey');

    if (isForeignKey) {
      console.warn(`[Outbox] Foreign key constraint on ${table} (referenced parent item missing/deleted). Skipping enqueue:`, err);
      return;
    }

    console.warn(`[Outbox] Direct Supabase write failed — saving to offline outbox queue:`, err);
    import('./ui.js').then(m => m.recordError(err, `Write to ${table}`));
    enqueueAction(table, action, data, matchQuery);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ── Initialize event listeners for online reconnection ──
export function initOutbox(dbClient) {
  // 1. When Wi-Fi reconnects, automatically replay queue
  window.addEventListener('online', () => {
    console.log('[Outbox] Device is back ONLINE. Triggering auto-sync…');
    replayOutbox(dbClient);
  });

  window.addEventListener('offline', () => {
    console.log('[Outbox] Device went OFFLINE.');
    updateOutboxUI();
  });

  // 2. Periodic sync check every 30 seconds
  setInterval(() => {
    if (navigator.onLine && getOutboxQueue().length > 0) {
      replayOutbox(dbClient);
    }
  }, 30000);

  // 3. Initial check on startup
  if (navigator.onLine && getOutboxQueue().length > 0) {
    replayOutbox(dbClient);
  } else {
    updateOutboxUI();
  }
}
