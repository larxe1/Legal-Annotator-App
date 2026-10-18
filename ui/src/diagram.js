// ═══════════════════════════════════════════════
// LEGAL DIAGRAMMER & SUCCESSION TREE STUDIO
// Powered by Mermaid.js (Client-side, Offline, Zero API Key)
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { openModal, closeModal, toast } from './ui.js';
import { safeStorageSet, safeStorageGet } from './storage.js';

// ── Built-in Law School Templates ──
export const LEGAL_TEMPLATES = {
  succession: {
    title: '👨‍👩‍👧‍👦 Wills & Succession: Compulsory Heirs & Legitime',
    code: `graph TD
    classDef dec fill:#0c1322,stroke:#d4af37,stroke-width:2px,color:#d4af37;
    classDef heir fill:#1b253b,stroke:#5c7cfa,stroke-width:1.5px,color:#e8e4db;
    classDef free fill:#1b253b,stroke:#40c057,stroke-width:1.5px,color:#40c057;

    D["👤 DECEDENT (Estate: ₱1,000,000)"]:::dec
    D --> S["👰 Surviving Spouse<br/>(Legitime: 1/4 = ₱250,000)"]:::heir
    D --> C1["👦 Legitimate Child 1<br/>(Legitime: 1/4 = ₱250,000)"]:::heir
    D --> C2["👧 Legitimate Child 2<br/>(Legitime: 1/4 = ₱250,000)"]:::heir
    D --> FP["🎁 Free Portion (Discretionary)<br/>(1/4 = ₱250,000)"]:::free`
  },
  chain_of_custody: {
    title: '⛓️ Criminal Law: Chain of Custody (R.A. 9165)',
    code: `graph LR
    classDef step fill:#1b253b,stroke:#d4af37,stroke-width:1.5px,color:#e8e4db;
    classDef wit fill:#0c1322,stroke:#fa5252,stroke-width:1.5px,color:#ffa8a8;
    classDef court fill:#0c1322,stroke:#40c057,stroke-width:2px,color:#40c057;

    A["1. Seizure & Marking<br/>(Immediate physical marking)"]:::step
    W["Mandatory Witnesses:<br/>• DOJ / Media<br/>• Elected Official"]:::wit
    B["2. Physical Inventory<br/>& Photography"]:::step
    C["3. Turn-over to Forensic<br/>Chemist (Laboratory Exam)"]:::step
    D["4. Submission to Court<br/>(Marked as Exhibit)"]:::court

    A --> B
    B -.-> W
    B --> C
    C --> D`
  },
  appeals_hierarchy: {
    title: '🏛️ Remedial Law: Appeals & Jurisdiction Route',
    code: `graph TD
    classDef court fill:#1b253b,stroke:#d4af37,stroke-width:1.5px,color:#e8e4db;
    classDef sc fill:#0c1322,stroke:#d4af37,stroke-width:2.5px,color:#ffd43b;

    MTC["First-Level Courts (MTC / MeTC)<br/>Original Exclusive Jurisdiction"]:::court
    RTC["Regional Trial Court (RTC)<br/>Appellate Jurisdiction (Rule 40)"]:::court
    CA["Court of Appeals (CA)<br/>Petition for Review (Rule 42)"]:::court
    SC["🏛️ SUPREME COURT<br/>Petition for Review on Certiorari (Rule 45)"]:::sc

    MTC -->|Notice of Appeal| RTC
    RTC -->|Rule 42 (Pure Questions of Fact/Law)| CA
    CA -->|Rule 45 (Pure Questions of Law Only)| SC`
  },
  oblicon_remedies: {
    title: '📜 Obligations & Contracts: Breach & Remedies',
    code: `graph TD
    classDef main fill:#0c1322,stroke:#d4af37,stroke-width:2px,color:#d4af37;
    classDef rem fill:#1b253b,stroke:#5c7cfa,stroke-width:1.5px,color:#e8e4db;
    classDef ext fill:#1b253b,stroke:#868e96,stroke-width:1px,color:#ced4da;

    O["Obligation Due & Demandable"]:::main
    O --> D["Extrajudicial / Judicial Demand (Mora)"]
    D --> B{"Is Obligor in Breach?"}
    B -->|Yes: Reciprocal| R1["Rescission (Art. 1191) + Damages"]:::rem
    B -->|Yes: Specific Thing| R2["Specific Performance + Damages"]:::rem
    B -->|Yes: Generic Thing| R3["Substitute Performance at Obligor's Expense"]:::rem
    B -->|No: Fortuitous Event (No Fault/Delay)| E["Obligation Extinguished (Art. 1174)"]:::ext`
  },
  case_parties: {
    title: '⚖️ Case Parties, Facts & Doctrine Flow',
    code: `graph TD
    classDef party fill:#1b253b,stroke:#5c7cfa,stroke-width:1.5px,color:#e8e4db;
    classDef doc fill:#0c1322,stroke:#d4af37,stroke-width:2px,color:#ffd43b;

    P["👨‍💼 Petitioner / Plaintiff"]:::party
    R["🏢 Respondent / Defendant"]:::party

    P -->|Files Complaint / Claims Title| RTC["Regional Trial Court"]
    R -->|Argues Good Faith Possession| RTC
    RTC -->|Ruling Appealed| SC["🏛️ Supreme Court"]
    SC --> D["📜 SC DOCTRINE:<br/>'A purchaser in good faith is one who buys property<br/>without notice of other claims.'"]:::doc`
  },
  blank: {
    title: '🔲 Blank Custom Flowchart',
    code: `graph TD
    A[Start / Issue] --> B{Condition?}
    B -->|Yes| C[Result A]
    B -->|No| D[Result B]`
  }
};

let _mermaidInitialized = false;
let _renderTimer = null;
let _saveDebounce = null;
let _zoomLevel = 1.0;
let _lastSvgData = '';

export async function initDiagramStudio() {
  const btn = document.getElementById('btn-diagram');
  if (btn) {
    btn.addEventListener('click', openDiagramStudio);
  }

  // Template select listener
  const sel = document.getElementById('diag-template-select');
  if (sel) {
    sel.addEventListener('change', () => {
      const tpl = LEGAL_TEMPLATES[sel.value];
      if (tpl) {
        const ed = document.getElementById('diag-editor');
        if (ed) {
          ed.value = tpl.code;
          triggerRender();
          scheduleSave();
        }
      }
    });
  }

  // Code editor input listener
  const editor = document.getElementById('diag-editor');
  if (editor) {
    editor.addEventListener('input', () => {
      triggerRender();
      scheduleSave();
    });
    // Tab key indentation support
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
        editor.selectionStart = editor.selectionEnd = start + 2;
        triggerRender();
      }
    });
  }

  // Action buttons
  document.getElementById('btn-diag-export-jpg')?.addEventListener('click', exportDiagramJPG);
  document.getElementById('btn-diag-export-png')?.addEventListener('click', exportDiagramPNG);
  document.getElementById('btn-diag-export-svg')?.addEventListener('click', exportDiagramSVG);
  document.getElementById('btn-diag-insert-notes')?.addEventListener('click', insertDiagramIntoNotes);
  document.getElementById('btn-diag-zin')?.addEventListener('click', () => adjustZoom(0.2));
  document.getElementById('btn-diag-zout')?.addEventListener('click', () => adjustZoom(-0.2));
  document.getElementById('btn-diag-zreset')?.addEventListener('click', () => resetZoom());

  initDiagramLightbox();
}

async function ensureMermaid() {
  if (_mermaidInitialized) return true;
  if (typeof mermaid === 'undefined') {
    // Dynamically inject if not yet loaded
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    }).catch(e => {
      console.warn('[Diagram] Mermaid script load failed:', e);
      return false;
    });
  }
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        darkMode: true,
        background: '#0c1322',
        primaryColor: '#1b253b',
        primaryTextColor: '#e8e4db',
        primaryBorderColor: '#d4af37',
        lineColor: '#5c7cfa',
        secondaryColor: '#141d30',
        tertiaryColor: '#0a0f1d'
      },
      fontFamily: 'Inter, sans-serif',
      securityLevel: 'loose'
    });
    _mermaidInitialized = true;
    return true;
  }
  return false;
}

export async function openDiagramStudio() {
  openModal('mo-diagram');
  const ok = await ensureMermaid();
  if (!ok) {
    toast('Loading diagram engine…');
  }

  // Load diagram code for active PDF (or default template)
  const ed = document.getElementById('diag-editor');
  if (ed) {
    const key = S.curPDF ? `diagram_${S.curPDF.id}` : 'diagram_global';
    const saved = safeStorageGet(key);
    if (saved && saved.trim()) {
      ed.value = saved;
    } else {
      ed.value = LEGAL_TEMPLATES.succession.code;
    }
  }

  const titleEl = document.getElementById('diag-modal-pdf-title');
  if (titleEl) {
    titleEl.textContent = S.curPDF ? `📄 ${S.curPDF.name}` : '🌐 General Library Diagram';
  }

  resetZoom();
  triggerRender();
}

function triggerRender() {
  clearTimeout(_renderTimer);
  _renderTimer = setTimeout(renderDiagram, 150);
}

async function renderDiagram() {
  const ed = document.getElementById('diag-editor');
  const preview = document.getElementById('diag-preview-inner');
  const errEl = document.getElementById('diag-error-lbl');
  if (!ed || !preview) return;

  const code = ed.value.trim();
  if (!code) {
    preview.innerHTML = '<div style="color:var(--muted); font-size:13px; text-align:center; padding:40px;">Diagram code is empty. Type Mermaid syntax or choose a template above.</div>';
    if (errEl) errEl.style.display = 'none';
    return;
  }

  try {
    await ensureMermaid();
    const id = 'mermaid-render-' + Date.now();
    const { svg } = await mermaid.render(id, code);
    _lastSvgData = svg;
    preview.innerHTML = svg;
    applyZoom();
    if (errEl) errEl.style.display = 'none';
  } catch (err) {
    if (errEl) {
      errEl.textContent = 'Syntax error: ' + (err.message || err.str || 'Invalid syntax');
      errEl.style.display = 'block';
    }
  }
}

function adjustZoom(delta) {
  _zoomLevel = Math.max(0.4, Math.min(3.0, _zoomLevel + delta));
  applyZoom();
}

function resetZoom() {
  _zoomLevel = 1.0;
  applyZoom();
}

function applyZoom() {
  const preview = document.getElementById('diag-preview-inner');
  const zoomLbl = document.getElementById('diag-zoom-lbl');
  if (preview) {
    const svg = preview.querySelector('svg');
    if (svg) {
      svg.style.transform = `scale(${_zoomLevel})`;
      svg.style.transformOrigin = 'center center';
      svg.style.transition = 'transform 0.15s ease-out';
    }
  }
  if (zoomLbl) {
    zoomLbl.textContent = `${Math.round(_zoomLevel * 100)}%`;
  }
}

function scheduleSave() {
  clearTimeout(_saveDebounce);
  _saveDebounce = setTimeout(async () => {
    const ed = document.getElementById('diag-editor');
    if (!ed) return;
    const key = S.curPDF ? `diagram_${S.curPDF.id}` : 'diagram_global';
    const val = ed.value;
    try {
      safeStorageSet(key, val);
      // Also save to Supabase via safeDbWrite
      const { safeDbWrite } = await import('./outbox.js');
      const { db } = await import('./db.js');
      await safeDbWrite(db, 'dictionary', 'upsert', {
        word: '__diag_' + (S.curPDF?.id || 'global'),
        definition: val
      });
    } catch {}
  }, 1000);
}

// ── Helper to extract SVG dimensions from viewBox or attributes ──
function extractSvgDimensions(svgString) {
  let width = 1920;
  let height = 1080;
  
  const vbMatch = svgString.match(/viewBox=["']\s*([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)\s*["']/i);
  if (vbMatch) {
    const vbW = parseFloat(vbMatch[3]);
    const vbH = parseFloat(vbMatch[4]);
    if (vbW > 0 && vbH > 0) {
      width = vbW;
      height = vbH;
    }
  } else {
    const wMatch = svgString.match(/width=["']\s*([\d.]+)(?:px)?\s*["']/i);
    const hMatch = svgString.match(/height=["']\s*([\d.]+)(?:px)?\s*["']/i);
    if (wMatch) width = parseFloat(wMatch[1]);
    if (hMatch) height = parseFloat(hMatch[1]);
  }
  return { width, height };
}

// ── Generic Ultra-HD JPG Image Downloader ──
export function downloadImageAsJPG(imgSrc, defaultName = 'legal_diagram.jpg') {
  if (!imgSrc) {
    toast('No diagram to download.');
    return;
  }

  // If it's an SVG, ensure ultra-high resolution (up to 4K-8K)
  if (imgSrc.startsWith('data:image/svg+xml') || imgSrc.startsWith('<svg')) {
    let svgData = '';
    if (imgSrc.startsWith('data:image/svg+xml;base64,')) {
      svgData = decodeURIComponent(escape(atob(imgSrc.replace('data:image/svg+xml;base64,', ''))));
    } else if (imgSrc.startsWith('data:image/svg+xml;utf8,')) {
      svgData = decodeURIComponent(imgSrc.replace('data:image/svg+xml;utf8,', ''));
    } else {
      svgData = imgSrc;
    }

    const { width: origW, height: origH } = extractSvgDimensions(svgData);

    // Target ultra-crisp resolution (up to 4000-8000px wide for massive readability)
    let targetW = Math.max(origW * 3.5, 3840);
    let targetH = Math.round(targetW * (origH / origW));

    // Cap max dimension to 14,000px so canvas doesn't exceed browser limits
    const maxDim = 14000;
    if (targetW > maxDim || targetH > maxDim) {
      const ratio = Math.min(maxDim / targetW, maxDim / targetH);
      targetW = Math.round(targetW * ratio);
      targetH = Math.round(targetH * ratio);
    }

    // Inject explicit width/height into root SVG tag so browser rasterizes at ultra-res
    let scaledSvg = svgData;
    if (!scaledSvg.includes('xmlns="http://www.w3.org/2000/svg"')) {
      scaledSvg = scaledSvg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    }
    scaledSvg = scaledSvg.replace(/<svg\b([^>]*)>/i, (m, attrs) => {
      const cleanAttrs = attrs.replace(/\b(width|height)=["'][^"']*["']/gi, '');
      return `<svg ${cleanAttrs} width="${targetW}" height="${targetH}">`;
    });

    const scaledBase64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(scaledSvg)));

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0c1322';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const jpgURL = canvas.toDataURL('image/jpeg', 0.98);
        const a = document.createElement('a');
        const filename = defaultName.endsWith('.jpg') || defaultName.endsWith('.jpeg') ? defaultName : defaultName + '.jpg';
        a.download = filename;
        a.href = jpgURL;
        a.click();
        toast('✅ Ultra-HD JPG Diagram downloaded!');
      } catch (err) {
        console.error('[Diagram] High-res JPG export failed:', err);
        toast('❌ Failed to export JPG.');
      }
    };
    img.onerror = () => {
      toast('❌ Failed to load SVG for JPG export.');
    };
    img.src = scaledBase64;
    return;
  }

  // Fallback for regular bitmap images
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      const scale = 2.0;
      const width = image.naturalWidth || image.width || 1200;
      const height = image.naturalHeight || image.height || 800;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);

      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0c1322';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

      const jpgURL = canvas.toDataURL('image/jpeg', 0.95);
      const a = document.createElement('a');
      const filename = defaultName.endsWith('.jpg') || defaultName.endsWith('.jpeg') ? defaultName : defaultName + '.jpg';
      a.download = filename;
      a.href = jpgURL;
      a.click();
      toast('✅ Diagram downloaded as JPG!');
    } catch (e) {
      toast('❌ Failed to convert image to JPG.');
    }
  };
  image.src = imgSrc;
}

// ── Generic Ultra-HD PNG Image Downloader ──
export function downloadImageAsPNG(imgSrc, defaultName = 'legal_diagram.png') {
  if (!imgSrc) {
    toast('No diagram to download.');
    return;
  }

  if (imgSrc.startsWith('data:image/svg+xml') || imgSrc.startsWith('<svg')) {
    let svgData = '';
    if (imgSrc.startsWith('data:image/svg+xml;base64,')) {
      svgData = decodeURIComponent(escape(atob(imgSrc.replace('data:image/svg+xml;base64,', ''))));
    } else if (imgSrc.startsWith('data:image/svg+xml;utf8,')) {
      svgData = decodeURIComponent(imgSrc.replace('data:image/svg+xml;utf8,', ''));
    } else {
      svgData = imgSrc;
    }

    const { width: origW, height: origH } = extractSvgDimensions(svgData);
    let targetW = Math.max(origW * 3.5, 3840);
    let targetH = Math.round(targetW * (origH / origW));

    const maxDim = 14000;
    if (targetW > maxDim || targetH > maxDim) {
      const ratio = Math.min(maxDim / targetW, maxDim / targetH);
      targetW = Math.round(targetW * ratio);
      targetH = Math.round(targetH * ratio);
    }

    let scaledSvg = svgData;
    if (!scaledSvg.includes('xmlns="http://www.w3.org/2000/svg"')) {
      scaledSvg = scaledSvg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    }
    scaledSvg = scaledSvg.replace(/<svg\b([^>]*)>/i, (m, attrs) => {
      const cleanAttrs = attrs.replace(/\b(width|height)=["'][^"']*["']/gi, '');
      return `<svg ${cleanAttrs} width="${targetW}" height="${targetH}">`;
    });

    const scaledBase64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(scaledSvg)));

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0c1322';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        const pngURL = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        const filename = defaultName.endsWith('.png') ? defaultName : defaultName + '.png';
        a.download = filename;
        a.href = pngURL;
        a.click();
        toast('✅ Ultra-HD PNG Diagram downloaded!');
      } catch (err) {
        console.error('[Diagram] High-res PNG export failed:', err);
        toast('❌ Failed to export PNG.');
      }
    };
    img.src = scaledBase64;
    return;
  }

  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      const scale = 2.0;
      const width = image.naturalWidth || image.width || 1200;
      const height = image.naturalHeight || image.height || 800;
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);

      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0c1322';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

      const pngURL = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      const filename = defaultName.endsWith('.png') ? defaultName : defaultName + '.png';
      a.download = filename;
      a.href = pngURL;
      a.click();
      toast('✅ PNG Diagram downloaded!');
    } catch (e) {
      toast('❌ Failed to convert image to PNG.');
    }
  };
  image.src = imgSrc;
}

// ── Export as JPG image from Diagram Studio ──
export function exportDiagramJPG() {
  const preview = document.getElementById('diag-preview-inner');
  const svg = preview?.querySelector('svg');
  if (!svg) {
    toast('No valid diagram to export.');
    return;
  }

  let svgData = new XMLSerializer().serializeToString(svg);
  if (!svgData.includes('xmlns="http://www.w3.org/2000/svg"')) {
    svgData = svgData.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  }
  const base64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
  const name = (S.curPDF ? S.curPDF.name.replace(/\.pdf$/i, '') : 'legal_diagram') + '_diagram.jpg';
  downloadImageAsJPG(base64, name);
}

// ── Export as PNG image from Diagram Studio ──
export function exportDiagramPNG() {
  const preview = document.getElementById('diag-preview-inner');
  const svg = preview?.querySelector('svg');
  if (!svg) {
    toast('No valid diagram to export.');
    return;
  }

  let svgData = new XMLSerializer().serializeToString(svg);
  if (!svgData.includes('xmlns="http://www.w3.org/2000/svg"')) {
    svgData = svgData.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  }
  const base64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
  const name = (S.curPDF ? S.curPDF.name.replace(/\.pdf$/i, '') : 'legal_diagram') + '_diagram.png';
  downloadImageAsPNG(base64, name);
}

// ── Export as SVG vector file ──
export function exportDiagramSVG() {
  if (!_lastSvgData) {
    toast('No diagram to export.');
    return;
  }
  const blob = new Blob([_lastSvgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const name = (S.curPDF ? S.curPDF.name.replace(/\.pdf$/i, '') : 'legal_diagram') + '_diagram.svg';
  a.download = name;
  a.href = url;
  a.click();
  URL.revokeObjectURL(url);
  toast('✅ SVG Vector exported!');
}

// ── Insert diagram directly into Folder Document or PDF Notepad ──
export async function insertDiagramIntoNotes() {
  const preview = document.getElementById('diag-preview-inner');
  const svg = preview?.querySelector('svg');
  if (!svg) {
    toast('No diagram to insert. Please render a diagram first.');
    return;
  }

  try {
    let svgData = new XMLSerializer().serializeToString(svg);
    if (!svgData.includes('xmlns="http://www.w3.org/2000/svg"')) {
      svgData = svgData.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
    }

    const base64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
    const imgHtml = `<p><br></p><div style="text-align:center; margin:14px 0;"><img src="${base64}" class="diagram-clickable" style="max-width:100%; border-radius:6px; border:1px solid #2a3b5c; box-shadow:0 4px 12px rgba(0,0,0,0.3); background:#0c1322; padding:10px; cursor:zoom-in; transition:transform 0.15s, box-shadow 0.15s;" title="🔍 Click to expand full-screen" alt="Legal Diagram"></div><p><br></p>`;

    const folderDocViewer = document.getElementById('folder-doc-viewer');
    const folderDoc = document.getElementById('folder-doc-editor');
    const isFolderDocVisible = folderDocViewer && folderDocViewer.style.display !== 'none';

    const npDigestEd = document.getElementById('np-digest-editor');
    const npNotesEd = document.getElementById('np-editor');
    const isDigestActive = npDigestEd && npDigestEd.style.display !== 'none';
    const targetNotepadEd = isDigestActive ? npDigestEd : npNotesEd;

    const annPanel = document.getElementById('ann-panel');
    const noteEd = document.getElementById('note-editor');
    const editNoteEd = document.getElementById('edit-note-ed');
    const moEditNote = document.getElementById('mo-edit-note');

    if (isFolderDocVisible && folderDoc) {
      folderDoc.innerHTML += imgHtml;
      folderDoc.dispatchEvent(new Event('input'));
      closeModal('mo-diagram');
      toast('✅ Diagram inserted into Folder Notes!');
    } else if (moEditNote && moEditNote.classList.contains('open') && editNoteEd) {
      editNoteEd.innerHTML += imgHtml;
      editNoteEd.dispatchEvent(new Event('input'));
      closeModal('mo-diagram');
      toast('✅ Diagram inserted into Note!');
    } else if (annPanel && annPanel.classList.contains('open') && noteEd) {
      noteEd.innerHTML += imgHtml;
      noteEd.dispatchEvent(new Event('input'));
      closeModal('mo-diagram');
      toast('✅ Diagram inserted into Note!');
    } else if (targetNotepadEd) {
      targetNotepadEd.innerHTML += imgHtml;
      targetNotepadEd.dispatchEvent(new Event('input'));
      closeModal('mo-diagram');
      toast('✅ Diagram inserted into PDF Notepad!');
    } else if (folderDoc) {
      folderDoc.innerHTML += imgHtml;
      folderDoc.dispatchEvent(new Event('input'));
      closeModal('mo-diagram');
      toast('✅ Diagram inserted into Folder Notes!');
    } else {
      toast('Could not find active notes editor.');
    }
  } catch (e) {
    console.error('[Diagram] Insert error:', e);
    toast('❌ Failed to insert diagram.');
  }
}

// ═══════════════════════════════════════════════
// FULL-SCREEN VECTOR DIAGRAM LIGHTBOX WITH ULTRA PAN & ZOOM
// ═══════════════════════════════════════════════
let _lbZoom = 1.0;
let _lbPanX = 0;
let _lbPanY = 0;
let _lbIsDragging = false;
let _lbStartX = 0;
let _lbStartY = 0;
let _currentLightboxSvgData = null;
let _currentLightboxImgSrc = null;

export function openDiagramLightbox(imgSrc) {
  const modal = document.getElementById('mo-diagram-lightbox');
  const img = document.getElementById('lb-img');
  const svgContainer = document.getElementById('lb-svg-container');
  if (!modal) return;

  _currentLightboxImgSrc = imgSrc;
  _currentLightboxSvgData = null;

  if (imgSrc && imgSrc.startsWith('data:image/svg+xml;base64,')) {
    try {
      const b64 = imgSrc.replace('data:image/svg+xml;base64,', '');
      const decoded = decodeURIComponent(escape(atob(b64)));
      _currentLightboxSvgData = decoded;

      if (svgContainer) {
        svgContainer.innerHTML = decoded;
        const svgEl = svgContainer.querySelector('svg');
        if (svgEl) {
          svgEl.style.width = '100%';
          svgEl.style.height = '100%';
          svgEl.style.display = 'block';
          svgEl.style.overflow = 'visible';
          svgEl.style.pointerEvents = 'none';
        }
        svgContainer.style.display = 'block';
        if (img) img.style.display = 'none';
      }
    } catch (e) {
      console.warn('[Diagram] Failed to parse vector SVG for lightbox:', e);
      if (img) {
        img.src = imgSrc;
        img.style.display = 'block';
      }
      if (svgContainer) svgContainer.style.display = 'none';
    }
  } else {
    if (img) {
      img.src = imgSrc;
      img.style.display = 'block';
    }
    if (svgContainer) svgContainer.style.display = 'none';
  }

  _lbZoom = 1.0;
  _lbPanX = 0;
  _lbPanY = 0;
  updateLbTransform();
  openModal('mo-diagram-lightbox');
}

function updateLbTransform() {
  const target = document.getElementById('lb-target') || document.getElementById('lb-img');
  const lbl = document.getElementById('lb-zoom-lbl');
  if (!target) return;
  target.style.transform = `translate(${_lbPanX}px, ${_lbPanY}px) scale(${_lbZoom})`;
  if (lbl) lbl.textContent = Math.round(_lbZoom * 100) + '%';
}

export function initDiagramLightbox() {
  const modal = document.getElementById('mo-diagram-lightbox');
  const canvas = document.getElementById('lb-canvas');
  if (!modal || !canvas) return;

  // Delegated click listener on note editors to expand any diagram/image on click
  document.addEventListener('click', (e) => {
    const imgEl = e.target.closest('#folder-doc-editor img, #np-editor img, #np-digest-editor img, .note-body img, #note-editor img, #edit-note-ed img, .diagram-clickable');
    if (imgEl && imgEl.src && imgEl.id !== 'lb-img') {
      e.stopPropagation();
      openDiagramLightbox(imgEl.src);
    }
  });

  // Download expanded diagram as high-resolution JPG
  document.getElementById('btn-lb-download-jpg')?.addEventListener('click', () => {
    const src = _currentLightboxSvgData ? _currentLightboxSvgData : _currentLightboxImgSrc;
    if (src) {
      const name = (S.curPDF ? S.curPDF.name.replace(/\.pdf$/i, '') : 'legal_diagram') + '_ultra_hd.jpg';
      downloadImageAsJPG(src, name);
    } else {
      toast('No diagram available to download.');
    }
  });

  // Download expanded diagram as high-resolution PNG
  document.getElementById('btn-lb-download-png')?.addEventListener('click', () => {
    const src = _currentLightboxSvgData ? _currentLightboxSvgData : _currentLightboxImgSrc;
    if (src) {
      const name = (S.curPDF ? S.curPDF.name.replace(/\.pdf$/i, '') : 'legal_diagram') + '_ultra_hd.png';
      downloadImageAsPNG(src, name);
    } else {
      toast('No diagram available to download.');
    }
  });

  // Download expanded diagram as raw Vector SVG (infinite resolution)
  document.getElementById('btn-lb-download-svg')?.addEventListener('click', () => {
    const svgData = _currentLightboxSvgData || _lastSvgData;
    if (svgData) {
      const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const name = (S.curPDF ? S.curPDF.name.replace(/\.pdf$/i, '') : 'legal_diagram') + '_vector.svg';
      a.download = name;
      a.href = url;
      a.click();
      URL.revokeObjectURL(url);
      toast('✅ Infinite-Resolution Vector SVG downloaded!');
    } else {
      toast('No vector diagram available to export.');
    }
  });

  // Zoom controls (supports up to 3500% / 35x zoom for giant flowcharts!)
  document.getElementById('btn-lb-zin')?.addEventListener('click', () => {
    _lbZoom = Math.min(35.0, _lbZoom * 1.25);
    updateLbTransform();
  });
  document.getElementById('btn-lb-zout')?.addEventListener('click', () => {
    _lbZoom = Math.max(0.05, _lbZoom / 1.25);
    updateLbTransform();
  });
  document.getElementById('btn-lb-zreset')?.addEventListener('click', () => {
    _lbZoom = 1.0;
    _lbPanX = 0;
    _lbPanY = 0;
    updateLbTransform();
  });
  document.getElementById('btn-lb-fit')?.addEventListener('click', () => {
    _lbZoom = 0.85;
    _lbPanX = 0;
    _lbPanY = 0;
    updateLbTransform();
  });

  // Smooth, calibrated mouse wheel zoom (cursor-centered)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - rect.width / 2;
    const mouseY = e.clientY - rect.top - rect.height / 2;

    // Normalize and clamp delta to prevent rapid jump on precision wheels / trackpads
    const delta = Math.max(-120, Math.min(120, e.deltaY));
    // Gentle exponential factor: ~1.12x per notch instead of explosive multiplication
    const factor = Math.exp(-delta * 0.0012);
    const newZoom = Math.max(0.05, Math.min(35.0, _lbZoom * factor));

    if (newZoom !== _lbZoom) {
      // Adjust pan so the diagram point under the mouse cursor stays locked in place
      _lbPanX = mouseX - (mouseX - _lbPanX) * (newZoom / _lbZoom);
      _lbPanY = mouseY - (mouseY - _lbPanY) * (newZoom / _lbZoom);
      _lbZoom = newZoom;
      updateLbTransform();
    }
  }, { passive: false });

  // Pan / Drag handlers
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    _lbIsDragging = true;
    _lbStartX = e.clientX - _lbPanX;
    _lbStartY = e.clientY - _lbPanY;
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('pointermove', (e) => {
    if (!_lbIsDragging) return;
    _lbPanX = e.clientX - _lbStartX;
    _lbPanY = e.clientY - _lbStartY;
    updateLbTransform();
  });

  window.addEventListener('pointerup', () => {
    if (_lbIsDragging) {
      _lbIsDragging = false;
      if (canvas) canvas.style.cursor = 'grab';
    }
  });
}
