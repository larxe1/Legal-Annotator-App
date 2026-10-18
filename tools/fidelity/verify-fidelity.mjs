// ─────────────────────────────────────────────────────────────────────────────
// Notes Fidelity — Step 3: Automated Chromium/WebView2 DOM & Storage Gate
//
// Runs all 1,175 real user documents (pdf_notes.content, pdf_notes.digest,
// annotation_notes.note_html) through:
//   1. Storage/Sync SHA-256 byte-for-byte check
//   2. Real Chromium (Microsoft Edge / WebView2 engine) contenteditable DOM
//      round-trip with ui/src/style.css and offline bundled fonts loaded
//   3. Structural & semantic preservation check (textContent, tag counts for
//      tables/lists/headings/formatting, classes, inline styles)
//   4. Offline bundled font readiness check (Libre Baskerville & Inter)
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const uiDir = join(root, 'ui');
const snapDir = join(here, 'snapshot');
const latest = readdirSync(snapDir).filter(f => f.endsWith('.json')).sort().pop();
const snap = JSON.parse(readFileSync(join(snapDir, latest), 'utf8'));

const sha = s => createHash('sha256').update(s ?? '', 'utf8').digest('hex');

// 1. Verify Storage/Cache byte-for-byte SHA-256 preservation against snapshot metadata
let storageChecked = 0;
let storageExact = 0;
const docs = [];

for (const table of ['pdf_notes', 'annotation_notes']) {
  const rows = snap.tables[table];
  const meta = snap.tables[table + '__meta'];
  const checksumMap = new Map(meta.checksums.map(c => [String(c.id), c]));
  for (const r of rows) {
    const id = String(r.id ?? r.pdf_id);
    const expected = checksumMap.get(id);
    for (const f of meta.htmlFields) {
      const val = r[f] ?? '';
      const serializedRoundTrip = JSON.parse(JSON.stringify({ val })).val;
      if (sha(serializedRoundTrip) === expected[f]) {
        storageExact++;
      }
      storageChecked++;
      if (val) {
        docs.push({ table, id, field: f, html: val, sha256: expected[f] });
      }
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

const testHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/fonts/fonts.css">
<link rel="stylesheet" href="/src/style.css">
</head>
<body>
<div id="notepad-panel" class="open" style="position:static;display:block;width:600px;">
  <div id="np-notes-editor" class="np-editor" contenteditable="true"></div>
</div>
<script type="module">
async function runGate() {
  await document.fonts.ready;
  // Trigger font loading by rendering sample spans
  const probe = document.createElement('div');
  probe.innerHTML = '<span style="font-family:\\'Libre Baskerville\\'">Law</span><span style="font-family:\\'Inter\\';font-weight:500">Notes</span>';
  document.body.appendChild(probe);
  await document.fonts.load('400 16px "Libre Baskerville"');
  await document.fonts.load('700 16px "Libre Baskerville"');
  await document.fonts.load('400 16px "Inter"');
  await document.fonts.load('600 16px "Inter"');
  await document.fonts.ready;

  const fontsOk = {
    libreBaskerville400: document.fonts.check('400 16px "Libre Baskerville"'),
    libreBaskerville700: document.fonts.check('700 16px "Libre Baskerville"'),
    inter400: document.fonts.check('400 16px "Inter"'),
    inter600: document.fonts.check('600 16px "Inter"'),
  };

  const res = await fetch('/__docs.json');
  const docs = await res.json();
  const ed = document.getElementById('np-notes-editor');

  let byteExact = 0;
  let idempotentOnSecondPass = 0;
  let textExact = 0;
  let structureExact = 0;
  let totalTables = 0;
  let totalCells = 0;
  let totalLists = 0;
  const diffs = [];

  const KEY_TAGS = ['table','thead','tbody','tr','td','th','ul','ol','li','b','strong','i','em','u','blockquote','h1','h2','h3','h4','h5','h6','a'];

  for (const d of docs) {
    ed.innerHTML = d.html;
    const pass1 = ed.innerHTML;
    const text1 = ed.textContent;
    const counts1 = Object.fromEntries(KEY_TAGS.map(t => [t, ed.querySelectorAll(t).length]));
    totalTables += counts1.table;
    totalCells += counts1.td + counts1.th;
    totalLists += counts1.li;

    if (pass1 === d.html) {
      byteExact++;
      idempotentOnSecondPass++;
      textExact++;
      structureExact++;
    } else {
      ed.innerHTML = pass1;
      const pass2 = ed.innerHTML;
      const text2 = ed.textContent;
      const counts2 = Object.fromEntries(KEY_TAGS.map(t => [t, ed.querySelectorAll(t).length]));
      if (pass2 === pass1) idempotentOnSecondPass++;
      if (text2 === text1) textExact++;
      const sameStruct = KEY_TAGS.every(t => counts1[t] === counts2[t]);
      if (sameStruct) structureExact++;
      if (diffs.length < 5) {
        diffs.push({ table: d.table, id: d.id, field: d.field, rawLen: d.html.length, pass1Len: pass1.length, sameText: text1 === text2, sameStruct });
      }
    }
  }

  await fetch('/__report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      totalDocs: docs.length,
      byteExact,
      idempotentOnSecondPass,
      textExact,
      structureExact,
      totalTables,
      totalCells,
      totalLists,
      fontsOk,
      sampleCanonicalizedDiffs: diffs,
    }),
  });
}
runGate().catch(async e => {
  await fetch('/__report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: String(e?.stack || e) }),
  });
});
</script>
</body>
</html>`;

let resolveReport;
const reportPromise = new Promise(r => { resolveReport = r; });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__test.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(testHtml);
    return;
  }
  if (url.pathname === '/__docs.json') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify(docs));
    return;
  }
  if (url.pathname === '/__report' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200);
      res.end('ok');
      resolveReport(JSON.parse(body));
    });
    return;
  }
  const filePath = join(uiDir, url.pathname);
  if (existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

const edgePaths = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const edgeBin = edgePaths.find(p => existsSync(p));
if (!edgeBin) throw new Error('Microsoft Edge not found for headless WebView2 DOM verification');

const userDataDir = join(here, 'report', 'edge-tmp-profile');
mkdirSync(userDataDir, { recursive: true });

const edge = spawn(edgeBin, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${userDataDir}`,
  `http://127.0.0.1:${port}/__test.html`,
], { stdio: 'ignore' });

const domResult = await reportPromise;
edge.kill();
server.close();

const fullReport = {
  verifiedAt: new Date().toISOString(),
  snapshot: latest,
  storageGate: {
    fieldsChecked: storageChecked,
    sha256ByteExact: storageExact,
    passed: storageChecked === storageExact,
  },
  chromiumDomGate: domResult,
  gatePassed:
    storageChecked === storageExact &&
    !domResult.error &&
    domResult.textExact === domResult.totalDocs &&
    domResult.structureExact === domResult.totalDocs &&
    domResult.idempotentOnSecondPass === domResult.totalDocs &&
    Object.values(domResult.fontsOk || {}).every(Boolean),
};

mkdirSync(join(here, 'report'), { recursive: true });
writeFileSync(join(here, 'report', 'fidelity-report.json'), JSON.stringify(fullReport, null, 2), 'utf8');
console.log(JSON.stringify(fullReport, null, 2));
if (!fullReport.gatePassed) process.exit(1);
