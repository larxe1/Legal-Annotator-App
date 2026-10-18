// Copies the web app's static assets and ES modules into ui/ (read-only from
// ../legal-annotator) and downloads vendor libraries locally so the standalone
// desktop app works 100% offline while keeping 100% notes/CSS/editor parity.
import { mkdirSync, copyFileSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(root, '../legal-annotator');
const uiDir = join(root, 'ui');
const vendorDir = join(uiDir, 'vendor');

mkdirSync(uiDir, { recursive: true });
mkdirSync(vendorDir, { recursive: true });

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    if (statSync(s).isDirectory()) {
      copyDir(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}

// 1. Copy src/ modules and root image/icon assets from legal-annotator (READ-ONLY)
copyDir(join(webRoot, 'src'), join(uiDir, 'src'));

for (const f of readdirSync(webRoot)) {
  if (/\.(png|jpg|webp|gif|ico|svg|json)$/i.test(f)) {
    copyFileSync(join(webRoot, f), join(uiDir, f));
  }
}

// 2. Patch ui/src/style.css to use local bundled fonts + content-visibility containment rules
const stylePath = join(uiDir, 'src', 'style.css');
let styleCss = readFileSync(stylePath, 'utf8');
styleCss = styleCss.replace(
  /@import url\('https:\/\/fonts\.googleapis\.com[^']+'\);/,
  "@import url('../fonts/fonts.css');"
);

const desktopCssAppend = `
/* ── Standalone Desktop Virtualization & Containment (Modern Web Guidance) ── */
.pg-wrap.pg-cv-auto {
  content-visibility: auto;
  contain-intrinsic-size: auto var(--pg-w, 800px) auto var(--pg-h, 1100px);
}
@supports not (content-visibility: auto) {
  .pg-wrap.pg-cv-auto {
    contain: layout style paint;
  }
}
.desktop-engine-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin: 6px 12px;
  padding: 6px 10px;
  background: rgba(20, 30, 50, 0.85);
  border: 1px solid var(--navy-b);
  border-radius: 6px;
  font-size: 11px;
  color: var(--text);
}
.desktop-open-local-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 6px 12px 2px 12px;
  padding: 7px 10px;
  background: linear-gradient(135deg, #1e3a8a, #2563eb);
  border: 1px solid #3b82f6;
  border-radius: 6px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.15s;
}
.desktop-open-local-btn:hover {
  filter: brightness(1.12);
}
`;
if (!styleCss.includes('Standalone Desktop Virtualization')) {
  styleCss += desktopCssAppend;
}
writeFileSync(stylePath, styleCss, 'utf8');

// 3. Generate ui/index.html from ../legal-annotator/index.html with local vendor + fonts + desktop bridge
let indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
indexHtml = indexHtml
  .replace(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\s*<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+" rel="stylesheet">/, '<link rel="stylesheet" href="fonts/fonts.css">')
  .replace('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', './vendor/pdf.min.js')
  .replace('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', './vendor/pdf.worker.min.js')
  .replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js', './vendor/supabase.min.js')
  .replace('https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js', './vendor/mermaid.min.js')
  .replace('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js', './vendor/html2pdf.bundle.min.js')
  .replace(
    '<script type="module" src="./src/backup.js"></script>',
    '<script type="module" src="./src/backup.js"></script>\n<script type="module" src="./src/desktop-bridge.js"></script>'
  )
  .replace("if ('serviceWorker' in navigator)", "if (false && 'serviceWorker' in navigator)");

writeFileSync(join(uiDir, 'index.html'), indexHtml, 'utf8');

// 4. Download vendor scripts locally for 100% offline standalone operation
const vendors = [
  ['pdf.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'],
  ['pdf.worker.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'],
  ['supabase.min.js', 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js'],
  ['mermaid.min.js', 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js'],
  ['html2pdf.bundle.min.js', 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js'],
];

for (const [name, url] of vendors) {
  const target = join(vendorDir, name);
  if (!existsSync(target)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
    writeFileSync(target, Buffer.from(await r.arrayBuffer()));
    console.log(`Downloaded vendor/${name}`);
  }
}

console.log('Synced web UI assets into ui/ successfully (legal-annotator untouched).');
