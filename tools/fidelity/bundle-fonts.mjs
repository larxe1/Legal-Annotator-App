// Downloads Libre Baskerville (400, 400i, 700) and Inter (300, 400, 500, 600)
// .woff2 files and writes ui/fonts/fonts.css for 100% offline typography fidelity.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fontsDir = join(root, 'ui', 'fonts');
mkdirSync(fontsDir, { recursive: true });

const cssUrl = 'https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500;600&display=swap';
const res = await fetch(cssUrl, {
  headers: {
    // Modern Chromium UA so Google Fonts returns woff2
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  },
});
if (!res.ok) throw new Error(`Failed to fetch Google Fonts CSS: ${res.status}`);
let css = await res.text();

const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g)].map(m => m[1]))];
console.log(`Found ${urls.length} font files to bundle locally.`);

let idx = 0;
for (const u of urls) {
  idx++;
  const fileName = `font-${idx}-${u.split('/').pop()}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`Failed to download ${u}: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(join(fontsDir, fileName), buf);
  css = css.replaceAll(u, `./${fileName}`);
}

writeFileSync(join(fontsDir, 'fonts.css'), css, 'utf8');
console.log(`Bundled ${urls.length} .woff2 files into ${fontsDir}`);
