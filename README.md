# Legal Annotator Desktop (Native Windows)

A high-performance standalone desktop version of **Legal Annotator** built for law students and practitioners. Designed to eliminate large-PDF lag while keeping **100% of existing notes & formatting intact** and seamlessly syncing with Supabase and Google Drive.

---

## ⚡ Key Highlights & Architecture

- **Native C++ PDFium Rendering (x64)**: Offloads PDF decoding and rendering directly to native PDFium DLLs, eliminating WebView2 memory bloat and canvas freezing on 300+ page law textbooks and jurisprudence documents.
- **Two-Tier Permanent Page Vault**:
  - **In-Memory Session DOM Vault (`_pdfSessionVault`)**: Keeps previously rendered PDF page elements preserved in memory for instantaneous (0ms) tab and document switching.
  - **Disk Page Vault (`data/page_vault/`)**: Persists pre-rendered page bitmaps and extracted text spans on disk, skipping re-rendering on subsequent launches.
- **Native SQLite Mirror (`data/notes_mirror.sqlite`)**:
  - 100% SHA-256 byte-exact mirroring for all `pdf_notes`, `annotation_notes`, `drawings`, `bookmarks`, and `folder_notes`.
  - 50-revision restorable snapshot history per PDF directly stored in SQLite, immune to browser storage quotas.
  - Offline write queue (`outbox_mirror`) with smart mutation coalescing for seamless two-way sync when reconnected.
- **Native Google (Gmail) OAuth Bridge**: Integrated Google sign-in window for Google Drive PDF access without third-party redirection issues.
- **Dual-Pane Split View & Vault-Accelerated Full-Text Search**: Side-by-side reference reading with parallel 4-page batching, and `Ctrl+F` in-memory text search.
- **Interactive PDF Export Studio**: Full-screen print preview with single/double-column and compact/standard layout toggles.
- **Client-Side Mermaid Diagrammer**: Law school diagram templates (Wills & Succession legitime trees, Chain of Custody, Remedial Law Appeals) running 100% offline.

---

## 🛠️ Project Structure

```
legal-annotator-desktop/
├── src-tauri/             # Rust & Tauri 2 backend
│   ├── src/main.rs        # Native commands, SQLite mirror, PDFium bridge, OAuth
│   ├── bin/               # Native PDFium binaries (pdfium.dll, pdfium.lib)
│   └── Cargo.toml         # Rust crate dependencies
├── ui/                    # Frontend application
│   ├── src/               # Application logic (viewer, notepad, annotate, etc.)
│   ├── vendor/            # Offline bundled libraries (PDF.js, Mermaid, Supabase)
│   └── index.html         # Main UI layout
├── tools/fidelity/        # Notes fidelity gate & verification suites
└── Launch-Legal-Annotator-Desktop.bat # One-click Windows desktop launcher
```

---

## 🚀 Building & Running

### Prerequisites
- [Rust](https://rustup.rs/) (stable-x86_64-pc-windows-msvc)
- Microsoft Visual Studio C++ Build Tools
- Node.js (v18+)

### Development
```bash
cargo build --release --manifest-path src-tauri/Cargo.toml
```

### Run
Launch `Launch-Legal-Annotator-Desktop.bat` or run:
```bash
src-tauri/target/release/legal-annotator-desktop.exe
```
