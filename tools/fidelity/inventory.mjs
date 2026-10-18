// Notes Fidelity — Step 2: formatting inventory (offline, reads the local snapshot only)
// Lists every HTML tag, class, inline-style property, font, and external resource
// used across all notes, so the fidelity gate is guaranteed to cover each one.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const snapDir = join(here, 'snapshot');
const latest = readdirSync(snapDir).filter(f => f.endsWith('.json')).sort().pop();
const snap = JSON.parse(readFileSync(join(snapDir, latest), 'utf8'));

const fields = { pdf_notes: ['content', 'digest'], annotation_notes: ['note_html'] };
const tags = {}, classes = {}, styles = {}, fonts = {}, external = {}, attrs = {};
let dataImages = 0, dataImageBytes = 0, docs = 0;
const bump = (m, k) => (m[k] = (m[k] || 0) + 1);

for (const [t, fs] of Object.entries(fields)) {
  for (const row of snap.tables[t]) {
    for (const f of fs) {
      const h = row[f];
      if (!h) continue;
      docs++;
      for (const m of h.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)) {
        bump(tags, m[1].toLowerCase());
        for (const a of m[2].matchAll(/\s([a-zA-Z-:]+)\s*=/g)) bump(attrs, a[1].toLowerCase());
      }
      for (const m of h.matchAll(/class\s*=\s*"([^"]*)"/g)) m[1].split(/\s+/).filter(Boolean).forEach(c => bump(classes, c));
      for (const m of h.matchAll(/style\s*=\s*"([^"]*)"/g)) {
        for (const decl of m[1].split(';')) {
          const [p, ...v] = decl.split(':');
          if (!p?.trim()) continue;
          bump(styles, p.trim().toLowerCase());
          if (p.trim().toLowerCase() === 'font-family') bump(fonts, v.join(':').replace(/&quot;/g, '"').trim());
        }
      }
      for (const m of h.matchAll(/<font[^>]*face\s*=\s*"([^"]*)"/g)) bump(fonts, m[1]);
      for (const m of h.matchAll(/(?:src|href)\s*=\s*"(https?:[^"]+)"/g)) bump(external, new URL(m[1]).host);
      for (const m of h.matchAll(/src\s*=\s*"data:([^;"]+)[^"]*"/g)) { dataImages++; dataImageBytes += m[0].length; }
    }
  }
}

const sortObj = o => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
const report = {
  snapshot: latest, documents: docs,
  tags: sortObj(tags), attributes: sortObj(attrs), classes: sortObj(classes),
  inlineStyleProps: sortObj(styles), fonts: sortObj(fonts),
  externalResourceHosts: sortObj(external),
  embeddedDataImages: { count: dataImages, totalMB: (dataImageBytes / 1048576).toFixed(2) },
};
mkdirSync(join(here, 'report'), { recursive: true });
writeFileSync(join(here, 'report', 'inventory.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
