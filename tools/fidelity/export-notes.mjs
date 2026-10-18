// ─────────────────────────────────────────────────────────────────────────────
// Notes Fidelity — Step 1: READ-ONLY snapshot export
//
// Downloads every note row from Supabase exactly as stored (raw HTML strings,
// no parsing, no normalisation) so the desktop app can later be verified to
// load/save them byte-for-byte identically to the web app.
//
// SAFETY: this script only issues HTTP GET requests. It never writes, updates,
// or deletes anything in Supabase.
//
// Usage:  node tools/fidelity/export-notes.mjs
// Output: tools/fidelity/snapshot/notes-<timestamp>.json   (gitignored)
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));

// Read credentials from the main app WITHOUT modifying it.
// (Same publishable key the web app already ships in index.html.)
function loadConfig() {
  const html = readFileSync(resolve(here, '../../../legal-annotator/index.html'), 'utf8');
  const url = html.match(/SUPABASE_URL:\s*'([^']+)'/)?.[1];
  const key = html.match(/SUPABASE_KEY:\s*'([^']+)'/)?.[1];
  if (!url || !key) throw new Error('Could not read SUPABASE_URL / SUPABASE_KEY from legal-annotator/index.html');
  return { url, key };
}

// Tables that hold user-authored rich-text content.
const TABLES = ['pdf_notes', 'annotation_notes'];
const PAGE = 1000;

async function fetchAll({ url, key }, table) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${url}/rest/v1/${table}?select=*`, {
      method: 'GET',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Range: `${from}-${from + PAGE - 1}`,
        'Range-Unit': 'items',
      },
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
    }
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

const sha = s => createHash('sha256').update(s ?? '', 'utf8').digest('hex');

const cfg = loadConfig();
const snapshot = { exportedAt: new Date().toISOString(), source: cfg.url, tables: {} };
const summary = [];

for (const t of TABLES) {
  const rows = await fetchAll(cfg, t);
  snapshot.tables[t] = rows;
  // Per-field checksums let later steps prove nothing changed, byte-for-byte.
  const htmlFields = rows.length ? Object.keys(rows[0]).filter(k => rows.some(r => typeof r[k] === 'string' && /<[a-z][\s\S]*>/i.test(r[k]))) : [];
  let bytes = 0;
  for (const r of rows) for (const f of htmlFields) bytes += Buffer.byteLength(r[f] ?? '', 'utf8');
  snapshot.tables[t + '__meta'] = {
    htmlFields,
    checksums: rows.map(r => Object.fromEntries([['id', r.id ?? r.pdf_id], ...htmlFields.map(f => [f, sha(r[f])])])),
  };
  summary.push({ table: t, rows: rows.length, htmlFields: htmlFields.join(', ') || '(none detected)', htmlKB: (bytes / 1024).toFixed(1) });
}

const outDir = join(here, 'snapshot');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `notes-${snapshot.exportedAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(outFile, JSON.stringify(snapshot, null, 2), 'utf8');

console.table(summary);
console.log(`\nSnapshot written (read-only export): ${outFile}`);
