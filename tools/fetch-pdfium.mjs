// Downloads the prebuilt Windows x64 pdfium.dll from bblanchon/pdfium-binaries
// and extracts it into src-tauri/bin/pdfium.dll.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const binDir = join(root, 'src-tauri', 'bin');
const dllPath = join(binDir, 'pdfium.dll');

if (existsSync(dllPath)) {
  console.log('pdfium.dll already exists at', dllPath);
  process.exit(0);
}

mkdirSync(binDir, { recursive: true });

const relRes = await fetch('https://api.github.com/repos/bblanchon/pdfium-binaries/releases/latest', {
  headers: { 'User-Agent': 'legal-annotator-desktop-builder' },
});
if (!relRes.ok) throw new Error(`GitHub API error: ${relRes.status}`);
const rel = await relRes.json();
const asset = rel.assets.find(a => a.name === 'pdfium-win-x64.tgz');
if (!asset) throw new Error('Could not find pdfium-win-x64.tgz in latest release');

console.log(`Downloading ${asset.name} (${(asset.size / 1048576).toFixed(1)} MB) from ${rel.tag_name}...`);
const tgzRes = await fetch(asset.browser_download_url);
if (!tgzRes.ok) throw new Error(`Download failed: ${tgzRes.status}`);
const tgzPath = join(binDir, 'pdfium-win-x64.tgz');
writeFileSync(tgzPath, Buffer.from(await tgzRes.arrayBuffer()));

// Extract bin/pdfium.dll using Windows built-in tar.exe
execFileSync('tar.exe', ['-xzf', tgzPath, '-C', binDir, '--strip-components=1', 'bin/pdfium.dll']);
console.log('Extracted native pdfium.dll to', dllPath);
