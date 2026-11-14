// ═════════════════════════════════════════════════════════════════════════════
// GEMINI WEB STUDIO — Native WebView2 Automation & Per-Subject Notebook Bridge
// - Dedicated "gemini-studio" WebviewWindow (isolated from perplexity-studio)
// - Loopback IPC bridge on http://127.0.0.1:19877/__gemini_msg?d=
// - Persists prefs at <data_dir>/gemini_studio_prefs.json
// ═════════════════════════════════════════════════════════════════════════════

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

static GEMINI_JOB_STATE: OnceLock<Arc<Mutex<serde_json::Value>>> = OnceLock::new();
static GEMINI_MOUSE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn get_gemini_job_state() -> Arc<Mutex<serde_json::Value>> {
    GEMINI_JOB_STATE
        .get_or_init(|| Arc::new(Mutex::new(serde_json::json!({}))))
        .clone()
}

fn gemini_prefs_path() -> PathBuf {
    crate::resolve_data_dir().join("gemini_studio_prefs.json")
}

fn default_gemini_prefs() -> serde_json::Value {
    serde_json::json!({
        "subjectNotebooks": {},
        "modelLabel": "4 Hydrogen",
        "thinkingLevel": "High",
        "autoSubmit": true,
        "digestMode": "append",
        "autoSendDigest": true
    })
}

pub(crate) fn normalize_gemini_notebook_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lower = trimmed.to_lowercase();
    if let Some(idx) = lower.find("gemini.google.com/notebook/") {
        let after = &trimmed[(idx + "gemini.google.com/notebook/".len())..];
        let uuid_part: String = after
            .chars()
            .take_while(|c| *c != '/' && *c != '?' && *c != '#')
            .collect();
        if !uuid_part.is_empty() {
            return format!("https://gemini.google.com/notebook/{}", uuid_part);
        }
    }
    trimmed.to_string()
}

fn load_gemini_prefs_disk() -> serde_json::Value {
    let mut base = default_gemini_prefs();
    let p = gemini_prefs_path();
    if let Ok(raw) = fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(obj) = v.as_object() {
                for (k, val) in obj {
                    if k == "subjectNotebooks" {
                        if let Some(nb_obj) = val.as_object() {
                            let mut cleaned = serde_json::Map::new();
                            for (sid, surl) in nb_obj {
                                if let Some(s) = surl.as_str() {
                                    let norm = normalize_gemini_notebook_url(s);
                                    if !norm.is_empty() {
                                        cleaned.insert(sid.clone(), serde_json::Value::String(norm));
                                    }
                                }
                            }
                            base["subjectNotebooks"] = serde_json::Value::Object(cleaned);
                        }
                    } else {
                        base[k] = val.clone();
                    }
                }
            }
        }
    }
    base
}

fn save_gemini_prefs_disk(prefs: &serde_json::Value) {
    let p = gemini_prefs_path();
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(prefs) {
        let _ = fs::write(&p, s);
    }
}

const GEMINI_INIT_SCRIPT: &str = r#"
(function() {
  if (window.__LA_GEMINI_STUDIO_LOADED__) return;
  window.__LA_GEMINI_STUDIO_LOADED__ = true;
  try { Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', { get: function() { return false; }, configurable: true }); } catch (e) {}

  var _state = {
    pdfId: '',
    pdfName: 'Current PDF',
    subjectId: '',
    subjectName: '',
    subfolderName: '',
    instructionText: '',
    pdfText: '',
    fullPromptText: '',
    pinnedNotebookUrl: '',
    modelLabel: '4 Hydrogen',
    thinkingLevel: 'High',
    autoSubmit: true,
    digestMode: 'append',
    autoSendDigest: true,
    jobId: 0
  };

  try {
    if (window.__INITIAL_GEMINI_JOB__ && typeof window.__INITIAL_GEMINI_JOB__ === 'object') {
      for (var ik in window.__INITIAL_GEMINI_JOB__) {
        if (window.__INITIAL_GEMINI_JOB__[ik] !== undefined && window.__INITIAL_GEMINI_JOB__[ik] !== null) {
          _state[ik] = window.__INITIAL_GEMINI_JOB__[ik];
        }
      }
    }
    var cached = sessionStorage.getItem('la_gemini_state_cache');
    if (cached) {
      var parsed = JSON.parse(cached);
      if (parsed && typeof parsed === 'object') {
        var initJobId = Number(window.__INITIAL_GEMINI_JOB__ && window.__INITIAL_GEMINI_JOB__.jobId ? window.__INITIAL_GEMINI_JOB__.jobId : 0);
        var cachedJobId = Number(parsed.jobId || 0);
        if (cachedJobId >= initJobId) {
          for (var k in parsed) { _state[k] = parsed[k]; }
        }
      }
    }
    sessionStorage.setItem('la_gemini_state_cache', JSON.stringify(_state));
  } catch (e) {}

  function saveStateCache() {
    try {
      sessionStorage.setItem('la_gemini_state_cache', JSON.stringify(_state));
    } catch (e) {}
  }

  function toUtf8Base64(obj) {
    try {
      var jsonStr = JSON.stringify(obj);
      var bytes = new TextEncoder().encode(jsonStr);
      var bin = '';
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    } catch (e) {
      return '';
    }
  }

  var _bridgeQueue = [];
  var _bridgeBusy = false;
  var _menuInteractionActive = false;
  function flushBridgeQueue() {
    if (_bridgeBusy || !_bridgeQueue.length) return;
    var nextIdx = -1;
    for (var qi = 0; qi < _bridgeQueue.length; qi++) {
      if (_menuInteractionActive && _bridgeQueue[qi] && _bridgeQueue[qi].action === 'studio_status') {
        continue;
      }
      nextIdx = qi;
      break;
    }
    if (nextIdx === -1) return;
    _bridgeBusy = true;
    var payload = _bridgeQueue.splice(nextIdx, 1)[0];
    var b64 = toUtf8Base64(payload);
    if (b64) {
      try {
        window.location.href = 'http://127.0.0.1:19877/__gemini_msg?d=' + encodeURIComponent(b64);
      } catch (e) {}
    }
    setTimeout(function() {
      _bridgeBusy = false;
      if (_bridgeQueue.length) flushBridgeQueue();
    }, 45);
  }

  function sendBridgeMsg(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.action === 'studio_status' || payload.action === 'studio_error') {
      _bridgeQueue = _bridgeQueue.filter(function(item) {
        return item.action !== 'studio_status' && item.action !== 'studio_error';
      });
    }
    _bridgeQueue.push(payload);
    flushBridgeQueue();
  }

  var _lastEmittedStatusKey = '';
  var _lastEmittedStatusAt = 0;
  function emitStudioStatus(state, stepLabel, message, canRetry, force) {
    var st = state || 'idle';
    var action = st === 'error' ? 'studio_error' : 'studio_status';
    var key = action + '|' + st + '|' + (stepLabel || '') + '|' + (message || '') + '|' + (_state.pdfId || '');
    var now = Date.now();
    if (!force && key === _lastEmittedStatusKey && (now - _lastEmittedStatusAt) < 3500) return;
    _lastEmittedStatusKey = key;
    _lastEmittedStatusAt = now;
    sendBridgeMsg({
      action: action,
      state: st,
      stepLabel: stepLabel || '',
      message: message || '',
      pdfId: _state.pdfId || '',
      canRetry: !!canRetry
    });
  }

  function syncPrefsToApp() {
    saveStateCache();
    sendBridgeMsg({
      action: 'save_prefs',
      subjectId: _state.subjectId || '',
      subjectName: _state.subjectName || '',
      pinnedNotebookUrl: _state.pinnedNotebookUrl || '',
      modelLabel: (_state.modelLabel || '4 Hydrogen').trim() || '4 Hydrogen',
      thinkingLevel: _state.thinkingLevel != null ? String(_state.thinkingLevel).trim() : 'High',
      autoSubmit: !!_state.autoSubmit,
      digestMode: _state.digestMode === 'replace' ? 'replace' : 'append',
      autoSendDigest: _state.autoSendDigest !== false
    });
  }

  function getGeminiHomeUrl() {
    var m = (window.location.href || '').match(/^https?:\/\/gemini\.google\.com(\/u\/\d+)\//i);
    if (m && m[1]) return 'https://gemini.google.com' + m[1] + '/app';
    return 'https://gemini.google.com/app';
  }

  function isNotebookUrl(u) {
    if (!u || typeof u !== 'string') return false;
    return /gemini\.google\.com\/(?:u\/\d+\/)?notebook\/[A-Za-z0-9_\-]+/i.test(u);
  }

  function normalizeNotebookUrl(u) {
    if (!u || typeof u !== 'string') return '';
    var m = u.match(/^https?:\/\/gemini\.google\.com((?:\/u\/\d+)?\/notebook\/[A-Za-z0-9_\-]+)/i);
    if (m && m[1]) {
      return 'https://gemini.google.com' + m[1];
    }
    return '';
  }

  function isNotebooksIndexUrl(u) {
    if (!u || typeof u !== 'string') return false;
    try {
      var parsed = new URL(u);
      return /^(?:\/u\/\d+)?\/(?:app|notebooks)?\/?$/i.test(parsed.pathname);
    } catch (e) {
      return /gemini\.google\.com\/(?:u\/\d+\/)?(?:app|notebooks)?\/?(?:$|[?#])/i.test(u);
    }
  }

  function showStatus(msg, color) {
    var el = document.getElementById('la-gemini-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = color || '#93c5fd';
  }

  function getModelPillText() {
    var m = (_state.modelLabel || '4 Hydrogen').trim() || '4 Hydrogen';
    var t = (_state.thinkingLevel != null ? String(_state.thinkingLevel).trim() : 'High');
    if (t && t.toLowerCase() !== 'none') {
      return m + ' · ' + t;
    }
    return m;
  }

  function updateBarUI() {
    var pdfLbl = document.getElementById('la-gemini-pdf-lbl');
    if (pdfLbl) {
      var subjPrefix = _state.subjectName ? ('[' + _state.subjectName + '] ') : '';
      pdfLbl.textContent = subjPrefix + (_state.pdfName || 'Current PDF');
      pdfLbl.title =
        (_state.subjectName ? ('Subject: ' + _state.subjectName + '\n') : '') +
        (_state.subfolderName ? ('Subfolder: ' + _state.subfolderName + '\n') : '') +
        (_state.pdfName || '');
    }

    var pinBtn = document.getElementById('la-gemini-pin-btn');
    if (pinBtn) {
      pinBtn.textContent = 'Gemini Home';
      pinBtn.style.borderColor = '#334155';
      pinBtn.style.background = '#1e293b';
      pinBtn.style.color = '#cbd5e1';
      pinBtn.title = 'Return to the general Gemini homepage (https://gemini.google.com/app)';
    }

    var mBtn = document.getElementById('la-gemini-model-btn');
    if (mBtn) {
      var verified = mBtn.dataset.verified === '1';
      mBtn.textContent = getModelPillText() + (verified ? ' ✓' : ' ▾');
      if (verified) {
        mBtn.style.borderColor = 'rgba(74,222,128,0.6)';
        mBtn.style.color = '#86efac';
      } else {
        mBtn.style.borderColor = 'rgba(96,165,250,0.55)';
        mBtn.style.color = '#bfdbfe';
      }
    }

    var autoSubBtn = document.getElementById('la-gemini-autosubmit-btn');
    if (autoSubBtn) {
      autoSubBtn.textContent = _state.autoSubmit ? '☑ Auto-Submit: ON' : '☐ Auto-Submit: OFF';
      autoSubBtn.style.borderColor = _state.autoSubmit ? 'rgba(96,165,250,0.55)' : '#334155';
      autoSubBtn.style.color = _state.autoSubmit ? '#93c5fd' : '#94a3b8';
    }

    var autoSendBtn = document.getElementById('la-gemini-autosend-btn');
    if (autoSendBtn) {
      var isAutoSend = _state.autoSendDigest !== false;
      autoSendBtn.textContent = isAutoSend ? '☑ Auto-Send: ON' : '☐ Auto-Send: OFF';
      autoSendBtn.style.borderColor = isAutoSend ? 'rgba(74,222,128,0.5)' : '#334155';
      autoSendBtn.style.color = isAutoSend ? '#4ade80' : '#94a3b8';
    }

    var modeBtn = document.getElementById('la-gemini-mode-btn');
    if (modeBtn) {
      var isAppend = _state.digestMode !== 'replace';
      modeBtn.textContent = isAppend ? 'Digest: Append' : 'Digest: Replace';
      modeBtn.style.borderColor = isAppend ? 'rgba(96,165,250,0.45)' : 'rgba(248,113,113,0.45)';
      modeBtn.style.color = isAppend ? '#93c5fd' : '#fca5a5';
    }
  }

  function toggleModelPopover(forceClose) {
    var pop = document.getElementById('la-gemini-model-popover');
    if (!pop) return;
    if (forceClose === true || pop.style.display === 'block') {
      pop.style.display = 'none';
      return;
    }
    var mInp = document.getElementById('la-gemini-cfg-model');
    var tSel = document.getElementById('la-gemini-cfg-thinking');
    if (mInp) mInp.value = (_state.modelLabel || '4 Hydrogen').trim();
    if (tSel) tSel.value = (_state.thinkingLevel != null ? String(_state.thinkingLevel).trim() : 'High') || 'High';
    pop.style.display = 'block';
  }

  function mkEl(tag, opts, children) {
    var node = document.createElement(tag);
    if (opts) {
      if (opts.id) node.id = opts.id;
      if (opts.className) node.className = opts.className;
      if (opts.style) node.style.cssText = opts.style;
      if (opts.title) node.title = opts.title;
      if (opts.text != null) node.textContent = opts.text;
      if (opts.type) node.type = opts.type;
      if (opts.placeholder) node.placeholder = opts.placeholder;
      if (opts.value != null) node.value = opts.value;
      if (opts.attrs) {
        for (var k in opts.attrs) {
          if (Object.prototype.hasOwnProperty.call(opts.attrs, k)) {
            node.setAttribute(k, opts.attrs[k]);
          }
        }
      }
    }
    if (children && children.length) {
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        if (!c) continue;
        if (typeof c === 'string') {
          node.appendChild(document.createTextNode(c));
        } else {
          node.appendChild(c);
        }
      }
    }
    return node;
  }

  function mkSvg(w, h, shapes) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < shapes.length; i++) {
      var sp = shapes[i];
      var el = document.createElementNS(ns, sp[0]);
      for (var k in sp[1]) {
        if (Object.prototype.hasOwnProperty.call(sp[1], k)) {
          el.setAttribute(k, sp[1][k]);
        }
      }
      svg.appendChild(el);
    }
    return svg;
  }

  function makeSvgSpark() {
    return mkSvg(13, 13, [
      ['path', { d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z' }]
    ]);
  }

  function makeSvgScale() {
    return mkSvg(13, 13, [
      ['path', { d: 'M12 3v18' }],
      ['path', { d: 'M5 7h14' }],
      ['path', { d: 'M5 7l-3 7h6l-3-7z' }],
      ['path', { d: 'M19 7l-3 7h6l-3-7z' }],
      ['path', { d: 'M8 21h8' }]
    ]);
  }

  function makeSvgCopy() {
    return mkSvg(12, 12, [
      ['rect', { x: '9', y: '9', width: '13', height: '13', rx: '2' }],
      ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]
    ]);
  }

  function ensureStudioBar() {
    if (!document.body) return;
    document.documentElement.style.scrollPaddingTop = '48px';
    document.body.style.paddingTop = '44px';

    if (document.getElementById('la-gemini-studio-bar')) {
      updateBarUI();
      return;
    }

    var btnStyle = 'padding:5px 8px;border-radius:5px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-size:11.5px;font-weight:500;cursor:pointer;white-space:nowrap;font-family:"Public Sans","Segoe UI",system-ui,sans-serif;transition:all 0.15s;display:inline-flex;align-items:center;gap:4px;';
    var goldBtnStyle = 'padding:5px 12px;border-radius:5px;border:1px solid #c9a84c;background:linear-gradient(180deg,#d4b254 0%,#b89334 100%);color:#0f172a;font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:"Public Sans","Segoe UI",system-ui,sans-serif;box-shadow:0 2px 8px rgba(201,168,76,0.3);display:inline-flex;align-items:center;gap:5px;';
    var modelBtnStyle = 'padding:5px 9px;border-radius:5px;border:1px solid rgba(96,165,250,0.55);background:rgba(59,130,246,0.16);color:#bfdbfe;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;font-family:"Public Sans","Segoe UI",system-ui,sans-serif;display:inline-flex;align-items:center;gap:5px;';

    var bar = mkEl('div', {
      id: 'la-gemini-studio-bar',
      style: 'position:fixed;top:0;left:0;right:0;height:44px;background:linear-gradient(90deg,#0f172a 0%,#172542 100%);border-bottom:1.5px solid #60a5fa;z-index:2147483647;display:flex;align-items:center;gap:7px;padding:0 12px;font-family:"Public Sans","Segoe UI",system-ui,sans-serif;font-size:12px;color:#e8e4db;box-shadow:0 4px 16px rgba(0,0,0,0.45);user-select:none;overflow-x:auto;'
    }, [
      mkEl('span', {
        style: 'color:#60a5fa;font-weight:700;font-size:12.5px;white-space:nowrap;letter-spacing:0.02em;display:inline-flex;align-items:center;gap:5px;'
      }, [makeSvgSpark(), 'Gemini Digest Studio']),
      mkEl('span', {
        id: 'la-gemini-pdf-lbl',
        style: 'max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(255,255,255,0.06);padding:3px 8px;border-radius:4px;font-size:11px;color:#cbd5e1;',
        text: 'Current PDF'
      }),
      mkEl('button', {
        id: 'la-gemini-pin-btn',
        type: 'button',
        style: btnStyle,
        title: 'Return to the general Gemini homepage (https://gemini.google.com/app)',
        text: 'Gemini Home'
      }),
      mkEl('button', {
        id: 'la-gemini-model-btn',
        type: 'button',
        style: modelBtnStyle,
        title: 'Configure Gemini Model & Thinking Level',
        text: '4 Hydrogen · High ▾'
      }),
      mkEl('button', {
        id: 'la-gemini-autosubmit-btn',
        type: 'button',
        style: btnStyle,
        title: 'Toggle whether pasting a case automatically presses Submit',
        text: '☑ Auto-Submit: ON'
      }),
      mkEl('button', {
        id: 'la-gemini-autosend-btn',
        type: 'button',
        style: btnStyle,
        title: 'Toggle whether the finished digest is automatically sent to the Case Digest tab',
        text: '☑ Auto-Send: ON'
      }),
      mkEl('button', {
        id: 'la-gemini-mode-btn',
        type: 'button',
        style: btnStyle,
        title: 'Choose whether sending to Case Digest appends at the bottom or replaces existing digest',
        text: 'Digest: Append'
      }),
      mkEl('button', {
        id: 'la-gemini-paste-btn',
        type: 'button',
        style: btnStyle,
        title: 'Select Model/Thinking and paste Subfolder Instruction + PDF Text into Gemini'
      }, [makeSvgCopy(), 'Paste Case']),
      mkEl('span', {
        id: 'la-gemini-status',
        style: 'font-size:11px;color:#93c5fd;white-space:nowrap;margin-left:auto;margin-right:4px;'
      }),
      mkEl('button', {
        id: 'la-gemini-send-btn',
        type: 'button',
        style: goldBtnStyle,
        title: 'Send Gemini\'s latest response directly into the Case Digest tab in Legal Annotator'
      }, [makeSvgScale(), mkEl('span', { id: 'la-gemini-send-lbl', text: 'Send to Case Digest' })])
    ]);

    document.body.appendChild(bar);

    // Inline Model & Thinking Configuration Popover (TrustedHTML-safe pure DOM)
    var presetModels = ['4 Hydrogen', '3.5 Flash-Lite', '3.1 Pro', '4 Argon', '4 Carbon'];
    var presetChips = presetModels.map(function(m) {
      return mkEl('button', {
        type: 'button',
        className: 'la-gemini-model-preset',
        style: 'padding:3px 7px;border-radius:4px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;font-size:11px;cursor:pointer;',
        text: m,
        attrs: { 'data-model': m }
      });
    });

    var thinkingOptions = ['High', 'Medium', 'Low', 'None'].map(function(lvl) {
      return mkEl('option', { value: lvl, text: lvl });
    });

    var pop = mkEl('div', {
      id: 'la-gemini-model-popover',
      style: 'display:none;position:fixed;top:48px;left:220px;z-index:2147483647;width:330px;background:#0f172a;border:1px solid #60a5fa;border-radius:8px;padding:12px;box-shadow:0 12px 30px rgba(0,0,0,0.65);font-family:"Public Sans","Segoe UI",system-ui,sans-serif;font-size:12px;color:#e2e8f0;'
    }, [
      mkEl('div', { style: 'font-weight:700;color:#93c5fd;margin-bottom:8px;', text: 'Gemini Model & Thinking Level' }),
      mkEl('label', { style: 'display:block;font-size:11px;color:#94a3b8;margin-bottom:4px;', text: 'Model Label' }),
      mkEl('input', {
        id: 'la-gemini-cfg-model',
        type: 'text',
        placeholder: '4 Hydrogen',
        style: 'width:100%;box-sizing:border-box;padding:6px 8px;border-radius:5px;border:1px solid #334155;background:#1e293b;color:#f8fafc;font-size:12px;margin-bottom:6px;'
      }),
      mkEl('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px;' }, presetChips),
      mkEl('label', { style: 'display:block;font-size:11px;color:#94a3b8;margin-bottom:4px;', text: 'Thinking Level' }),
      mkEl('select', {
        id: 'la-gemini-cfg-thinking',
        style: 'width:100%;box-sizing:border-box;padding:6px 8px;border-radius:5px;border:1px solid #334155;background:#1e293b;color:#f8fafc;font-size:12px;margin-bottom:10px;'
      }, thinkingOptions),
      mkEl('div', { style: 'display:flex;justify-content:flex-end;gap:6px;' }, [
        mkEl('button', { type: 'button', id: 'la-gemini-cfg-cancel', style: btnStyle, text: 'Cancel' }),
        mkEl('button', {
          type: 'button',
          id: 'la-gemini-cfg-apply',
          style: 'padding:5px 10px;border-radius:5px;border:1px solid #60a5fa;background:#2563eb;color:#ffffff;font-size:11.5px;font-weight:600;cursor:pointer;',
          text: 'Apply & Select'
        })
      ])
    ]);
    document.body.appendChild(pop);

    // Floating quick-send FAB positioned above Gemini's fixed bottom "Ask Gemini" bar
    var fab = mkEl('button', {
      id: 'la-gemini-fab-send',
      type: 'button',
      style: 'position:fixed;bottom:88px;right:20px;z-index:2147483646;padding:9px 15px;border-radius:999px;border:1.5px solid #c9a84c;background:#0f172a;color:#f3d37a;font-family:"Public Sans","Segoe UI",system-ui,sans-serif;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,0.55);display:flex;align-items:center;gap:6px;',
      title: 'Send latest Gemini answer directly into the Case Digest tab'
    }, [makeSvgScale(), mkEl('span', { id: 'la-gemini-fab-lbl', text: 'Send to Case Digest' })]);
    fab.addEventListener('click', function() { extractAndSendDigest(); });
    document.body.appendChild(fab);

    document.getElementById('la-gemini-pin-btn').addEventListener('click', function() {
      var homeUrl = getGeminiHomeUrl();
      _notebookTransitionReadyAt = Date.now() + 1000;
      showStatus('Opening Gemini homepage…', '#93c5fd');
      window.location.href = homeUrl;
    });

    document.getElementById('la-gemini-model-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      toggleModelPopover();
    });

    Array.from(pop.querySelectorAll('.la-gemini-model-preset')).forEach(function(chip) {
      chip.addEventListener('click', function() {
        var mInp = document.getElementById('la-gemini-cfg-model');
        if (mInp) mInp.value = chip.getAttribute('data-model') || '4 Hydrogen';
      });
    });

    document.getElementById('la-gemini-cfg-cancel').addEventListener('click', function() {
      toggleModelPopover(true);
    });

    document.getElementById('la-gemini-cfg-apply').addEventListener('click', function() {
      var mInp = document.getElementById('la-gemini-cfg-model');
      var tSel = document.getElementById('la-gemini-cfg-thinking');
      var newModel = (mInp && mInp.value ? mInp.value.trim() : '') || '4 Hydrogen';
      var newThinking = (tSel && tSel.value ? tSel.value.trim() : '') || 'High';
      _state.modelLabel = newModel;
      _state.thinkingLevel = newThinking;
      var mBtn = document.getElementById('la-gemini-model-btn');
      if (mBtn) mBtn.dataset.verified = '0';
      syncPrefsToApp();
      updateBarUI();
      toggleModelPopover(true);
      ensureGeminiModelSelected(findGeminiPromptInput(), function(ok) {
        showStatus(ok ? ('Model verified: ' + getModelPillText()) : ('Attempted model: ' + getModelPillText()), ok ? '#4ade80' : '#fbbf24');
      }, true);
    });

    document.addEventListener('click', function(ev) {
      var p = document.getElementById('la-gemini-model-popover');
      if (!p || p.style.display !== 'block') return;
      if (p.contains(ev.target)) return;
      if (ev.target && ev.target.id === 'la-gemini-model-btn') return;
      p.style.display = 'none';
    });

    document.getElementById('la-gemini-autosubmit-btn').addEventListener('click', function() {
      _state.autoSubmit = !_state.autoSubmit;
      syncPrefsToApp();
      updateBarUI();
      showStatus(_state.autoSubmit ? 'Auto-Submit enabled' : 'Auto-Submit disabled', '#93c5fd');
    });

    document.getElementById('la-gemini-autosend-btn').addEventListener('click', function() {
      _state.autoSendDigest = (_state.autoSendDigest === false) ? true : false;
      syncPrefsToApp();
      updateBarUI();
      showStatus(_state.autoSendDigest ? 'Auto-Send enabled' : 'Auto-Send disabled', '#4ade80');
    });

    document.getElementById('la-gemini-mode-btn').addEventListener('click', function() {
      _state.digestMode = (_state.digestMode === 'replace') ? 'append' : 'replace';
      syncPrefsToApp();
      updateBarUI();
      showStatus(_state.digestMode === 'replace' ? 'Digest mode: Replace' : 'Digest mode: Append', '#93c5fd');
    });

    document.getElementById('la-gemini-paste-btn').addEventListener('click', function() {
      pasteAndMaybeSubmit(true);
    });

    document.getElementById('la-gemini-send-btn').addEventListener('click', function() {
      extractAndSendDigest();
    });

    updateBarUI();
  }

  var _verifiedModelKeyOnCurrentPage = '';
  var _notebookTransitionReadyAt = Date.now() + 1000;

  function returnToNotebookHome() {
    var homeUrl = getGeminiHomeUrl();
    _verifiedModelKeyOnCurrentPage = '';
    _notebookTransitionReadyAt = Date.now() + 1000;
    window.location.href = homeUrl;
    return true;
  }

  function tryAutoOpenSubjectNotebook() {
    var subj = (_state.subjectName || '').trim();
    if (!subj) return false;
    var subjLower = subj.toLowerCase();

    var links = Array.from(document.querySelectorAll('a[href*="/notebook/"]')).filter(function(a) {
      if (!a.isConnected || a.closest('#la-gemini-studio-bar') || a.closest('#la-gemini-model-popover')) return false;
      return isNotebookUrl(a.href);
    });

    function textMatches(txt) {
      var t = (txt || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!t) return 0;
      if (t === subjLower) return 100;
      if (t.indexOf(subjLower) !== -1 && t.length <= subjLower.length + 65) return 70;
      return 0;
    }

    var bestLink = null;
    var bestScore = 0;
    links.forEach(function(a) {
      var s = textMatches(a.innerText || a.textContent || a.getAttribute('aria-label') || '');
      if (s > bestScore) {
        bestScore = s;
        bestLink = a;
      }
    });

    if (bestLink && bestLink.href) {
      var norm = normalizeNotebookUrl(bestLink.href);
      if (norm) {
        _state.pinnedNotebookUrl = norm;
        syncPrefsToApp();
        updateBarUI();
        _notebookTransitionReadyAt = Date.now() + 1000;
        showStatus('Matched "' + subj + '" Notebook! Opening…', '#4ade80');
        window.location.href = norm;
        return true;
      }
    }

    // Fallback: scan visible cards/buttons/rows on /notebooks that may navigate on click without an <a> href
    var cards = Array.from(document.querySelectorAll('[role="link"], [role="button"], button, mat-card, .notebook-card, div[tabindex], li')).filter(function(el) {
      if (!el.isConnected || el.closest('#la-gemini-studio-bar') || el.closest('#la-gemini-model-popover') || el.closest('#la-gemini-fab-send')) return false;
      var r = el.getBoundingClientRect();
      return r.width >= 80 && r.height >= 24 && r.top >= 44;
    });

    var bestCard = null;
    var bestCardScore = 0;
    cards.forEach(function(el) {
      var s = textMatches(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
      if (s > bestCardScore) {
        bestCardScore = s;
        bestCard = el;
      }
    });

    if (bestCard) {
      _notebookTransitionReadyAt = Date.now() + 1000;
      showStatus('Opening "' + subj + '" Notebook…', '#4ade80');
      realPointerClick(bestCard);
      return true;
    }

    return false;
  }

  function findGeminiPromptInput() {
    var selectors = [
      'rich-textarea .ql-editor[contenteditable="true"]',
      'rich-textarea [contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="Ask Gemini" i]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="Ask Gemini" i]',
      'textarea[aria-label*="Ask Gemini" i]',
      'textarea:not([readonly]):not([disabled])',
      'div[contenteditable="true"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var els = Array.from(document.querySelectorAll(selectors[i]));
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (!el.isConnected) continue;
        if (el.closest('#la-gemini-studio-bar') || el.closest('#la-gemini-model-popover') || el.closest('#la-gemini-fab-send')) continue;
        var r = el.getBoundingClientRect();
        if (r.width > 120 && r.height > 18) return el;
      }
    }
    return null;
  }

  function showClickCursorAt(x, y, labelText) {
    try {
      var ring = document.getElementById('la-gemini-click-cursor');
      if (!ring) {
        ring = mkEl('div', {
          id: 'la-gemini-click-cursor',
          style: 'position:fixed;z-index:2147483647;pointer-events:none;transition:left 0.14s ease,top 0.14s ease,opacity 0.2s ease;display:flex;align-items:center;gap:6px;transform:translate(-12px,-12px);'
        }, [
          mkEl('div', {
            style: 'width:24px;height:24px;border-radius:50%;border:2.5px solid #60a5fa;background:rgba(96,165,250,0.28);box-shadow:0 0 14px rgba(96,165,250,0.85);'
          }),
          mkEl('span', {
            id: 'la-gemini-click-cursor-lbl',
            style: 'background:#0f172a;border:1px solid #60a5fa;color:#dbeafe;font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.6);'
          })
        ]);
        document.body.appendChild(ring);
      }
      ring.style.left = Math.round(x) + 'px';
      ring.style.top = Math.round(y) + 'px';
      ring.style.opacity = '1';
      var lbl = document.getElementById('la-gemini-click-cursor-lbl');
      if (lbl) lbl.textContent = labelText || 'Selecting model';
      clearTimeout(ring._hideTimer);
      ring._hideTimer = setTimeout(function() {
        if (ring) ring.style.opacity = '0';
      }, 1500);
    } catch (e) {}
  }

  function cleanVisibleUiText(el) {
    if (!el) return '';
    try {
      var clone = el.cloneNode(true);
      var icons = clone.querySelectorAll('mat-icon, .mat-icon, .google-symbols, .material-icons, .material-symbols-outlined, svg, style, script, [aria-hidden="true"]');
      for (var i = 0; i < icons.length; i++) {
        if (icons[i].parentNode) icons[i].parentNode.removeChild(icons[i]);
      }
      var chunks = [];
      if (document.createTreeWalker && window.NodeFilter) {
        var walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null, false);
        var node;
        while ((node = walker.nextNode())) {
          var s = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
          if (s) chunks.push(s);
        }
      }
      var raw = chunks.length ? chunks.join(' ') : ((clone.textContent || '') + '');
      raw = raw
        .replace(/\b(?:keyboard_arrow_down|keyboard_arrow_up|expand_more|expand_less|chevron_right|chevron_left|arrow_right|arrow_drop_down|arrow_drop_up|arrow_forward|lock_outline)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (raw) return raw;
    } catch (e) {}
    return ((el.innerText || el.textContent || '') + '')
      .replace(/\b(?:keyboard_arrow_down|keyboard_arrow_up|expand_more|expand_less|chevron_right|chevron_left|arrow_right|arrow_drop_down|arrow_drop_up|arrow_forward|lock_outline)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function resolveInteractiveMenuItem(el) {
    if (!el || !el.closest) return el;
    return el.closest('button, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="radio"], .mat-mdc-menu-item, .mdc-list-item, [mat-menu-item]') || el;
  }

  function buildDomPointerOpts(cx, cy, buttonsVal) {
    return {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: cx,
      clientY: cy,
      screenX: cx,
      screenY: cy,
      button: 0,
      buttons: buttonsVal,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true
    };
  }

  function dispatchDomHoverSequence(target, cx, cy) {
    var downOpts = buildDomPointerOpts(cx, cy, 0);
    var enterOpts = Object.assign({}, downOpts, { bubbles: false });
    if (typeof PointerEvent === 'function') target.dispatchEvent(new PointerEvent('pointerover', downOpts));
    target.dispatchEvent(new MouseEvent('mouseover', downOpts));
    if (typeof PointerEvent === 'function') target.dispatchEvent(new PointerEvent('pointerenter', enterOpts));
    target.dispatchEvent(new MouseEvent('mouseenter', enterOpts));
    if (typeof PointerEvent === 'function') target.dispatchEvent(new PointerEvent('pointermove', downOpts));
    target.dispatchEvent(new MouseEvent('mousemove', downOpts));
  }

  function programmaticDomClick(el, labelText) {
    var target = resolveInteractiveMenuItem(el);
    if (!target || !target.isConnected) return false;
    try {
      var r = target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      var cx = Math.round(r.left + r.width / 2);
      var cy = Math.round(r.top + r.height / 2);
      if (labelText && (r.width > 0 || r.height > 0)) {
        showClickCursorAt(cx, cy, labelText);
      }
      dispatchDomHoverSequence(target, cx, cy);
      var downOpts = buildDomPointerOpts(cx, cy, 1);
      if (typeof PointerEvent === 'function') target.dispatchEvent(new PointerEvent('pointerdown', downOpts));
      target.dispatchEvent(new MouseEvent('mousedown', downOpts));
      if (typeof target.focus === 'function') {
        try { target.focus({ preventScroll: true }); } catch (fe) { target.focus(); }
      }
      var upOpts = buildDomPointerOpts(cx, cy, 0);
      if (typeof PointerEvent === 'function') target.dispatchEvent(new PointerEvent('pointerup', upOpts));
      target.dispatchEvent(new MouseEvent('mouseup', upOpts));
      if (typeof target.click === 'function') {
        target.click();
      } else {
        target.dispatchEvent(new MouseEvent('click', Object.assign({}, upOpts, { detail: 1 })));
      }
      return true;
    } catch (e) {
      try { target.click(); return true; } catch (e2) { return false; }
    }
  }

  function programmaticDomOpenSubmenu(trigEl, labelText) {
    return programmaticDomClick(trigEl, labelText);
  }

  function programmaticDomSubmenuKey(trigEl) {
    var target = resolveInteractiveMenuItem(trigEl);
    if (!target || !target.isConnected) return false;
    try {
      var r = target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      var cx = Math.round(r.left + r.width / 2);
      var cy = Math.round(r.top + r.height / 2);
      if (typeof target.focus === 'function') {
        try { target.focus({ preventScroll: true }); } catch (fe) { target.focus(); }
      }
      dispatchDomHoverSequence(target, cx, cy);
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        code: 'ArrowRight',
        keyCode: 39,
        which: 39,
        bubbles: true,
        cancelable: true
      }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function realPointerClick(el) {
    return programmaticDomClick(el, '');
  }

  function extractModelFamilyTokens(label) {
    var words = ((label || '') + '').toLowerCase().match(/[a-z][a-z\-]{1,}/g) || [];
    var filtered = words.filter(function(w) { return w !== 'gemini' && w !== 'model'; });
    return filtered.length ? filtered : words;
  }

  function matchesModelLabelText(pillText, targetLabel) {
    var p = ((pillText || '') + '').replace(/\s+/g, ' ').trim().toLowerCase();
    var t = ((targetLabel || '') + '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!p || !t) return false;
    if (p.indexOf(t) !== -1) return true;
    var tokens = extractModelFamilyTokens(t);
    if (!tokens.length) return false;
    for (var i = 0; i < tokens.length; i++) {
      if (p.indexOf(tokens[i]) === -1) return false;
    }
    return true;
  }

  function matchesThinkingLevelText(pillText, targetThinking) {
    var lvl = ((targetThinking || '') + '').trim().toLowerCase();
    if (!lvl || lvl === 'none') return true;
    var p = ((pillText || '') + '').replace(/\s+/g, ' ').trim().toLowerCase();
    return new RegExp('\\b' + lvl + '\\b', 'i').test(p);
  }

  function findGeminiModelPill(inputEl) {
    var ir = (inputEl && inputEl.isConnected) ? inputEl.getBoundingClientRect() : null;
    var candidates = Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup]')).filter(function(el) {
      if (!el.isConnected) return false;
      if (el.closest('#la-gemini-studio-bar') || el.closest('#la-gemini-model-popover') || el.closest('#la-gemini-fab-send') || el.closest('#la-gemini-click-cursor')) return false;
      if (el.closest('nav, aside, [role="navigation"], model-response, .model-response-text, .markdown')) return false;
      if (el.closest('.cdk-overlay-pane, [role="menu"], [role="listbox"]')) return false;
      var r = el.getBoundingClientRect();
      if (r.top < 44 || r.width < 28 || r.width > 320 || r.height < 18 || r.height > 64) return false;
      if (ir && ir.width > 40) {
        if (r.top < ir.top - 160 || r.bottom > ir.bottom + 220) return false;
      }
      return true;
    });

    var scored = [];
    candidates.forEach(function(el) {
      var txt = cleanVisibleUiText(el);
      var aria = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('mattooltip') || '') + ' ' + (el.getAttribute('data-test-id') || '')).toLowerCase();
      if (!txt && !aria) return;
      if (/^(?:send|submit|stop)$/i.test(txt)) return;
      if (/\b(send message|submit|stop generating|microphone|use microphone|voice|dictat|attach|upload|add files|new chat)\b/i.test(txt + ' ' + aria)) return;
      if (txt.length > 48) return;

      var score = 0;
      var matchedSelectorMeta = /bard-mode|model-selector|mode-switch/i.test((el.className || '') + ' ' + aria)
        || !!(el.closest && el.closest('[class*="bard-mode" i], [class*="model-selector" i], [class*="mode-switch" i], [data-test-id*="mode" i], [data-test-id*="model" i]'));
      if (matchedSelectorMeta) score += 120;
      var hasModelTok = /\b(hydrogen|argon|carbon|flash|pro|ultra)\b/i.test(txt);
      var hasLevelTok = /\b(low|medium|high)\b/i.test(txt);
      if (hasModelTok || hasLevelTok) score += 140;
      if (hasModelTok && hasLevelTok) score += 100;
      if (/\b(gemini|2\.5|3\.0|3\.1|3\.5|thinking|fast|reasoning)\b/i.test(txt)) score += 60;
      if (/\b(model|mode|switch model)\b/i.test(aria)) score += 60;
      if (el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('aria-haspopup') === 'listbox' || el.getAttribute('aria-expanded') !== null) score += 50;
      if (ir) {
        var r = el.getBoundingClientRect();
        var dist = Math.abs(r.top - ir.bottom) + Math.abs(r.right - ir.right) * 0.15;
        score += Math.max(0, 40 - dist * 0.2);
      }
      if (score >= 45) scored.push({ el: el, score: score, txt: txt });
    });

    if (scored.length === 0 && ir) {
      return findGeminiModelPill(null);
    }
    if (!scored.length) return null;
    scored.sort(function(a, b) { return b.score - a.score; });
    return scored[0].el;
  }

  function getFloatingMenuItems(triggerEl) {
    var rawNodes = Array.from(document.querySelectorAll(
      '.cdk-overlay-pane button, .cdk-overlay-pane [role="menuitem"], .cdk-overlay-pane [role="menuitemradio"], .cdk-overlay-pane [role="menuitemcheckbox"], .cdk-overlay-pane [role="option"], .cdk-overlay-pane [role="radio"], .cdk-overlay-pane .mat-mdc-menu-item, .cdk-overlay-pane .mdc-list-item, .cdk-overlay-pane [mat-menu-item], [role="menu"] button, [role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"], [role="listbox"] [role="option"]'
    ));
    var unique = [];
    rawNodes.forEach(function(el) {
      var host = resolveInteractiveMenuItem(el);
      if (!host || !host.isConnected || host === triggerEl || (triggerEl && triggerEl.contains(host))) return;
      if (host.closest('#la-gemini-studio-bar') || host.closest('#la-gemini-model-popover') || host.closest('nav, aside')) return;
      var r = host.getBoundingClientRect();
      if (r.width < 40 || r.height < 16 || r.top < 44 || r.bottom > window.innerHeight + 8) return;
      if (unique.indexOf(host) === -1) unique.push(host);
    });
    return unique;
  }

  function findModelMenuItem(triggerEl, targetLabel) {
    var items = getFloatingMenuItems(triggerEl);
    var tLower = (targetLabel || '4 Hydrogen').trim().toLowerCase();
    var familyTokens = extractModelFamilyTokens(tLower);
    var best = null;
    var bestScore = 0;

    items.forEach(function(el) {
      var txt = cleanVisibleUiText(el);
      if (!txt || txt.length > 140) return;
      if (/\bthinking\s*level\b/i.test(txt) || /^(?:low|medium|high)\b/i.test(txt)) return;
      var ltxt = txt.toLowerCase();
      var score = 0;
      if (ltxt === tLower || ltxt.indexOf(tLower) === 0) score += 500;
      else if (ltxt.indexOf(tLower) !== -1) score += 350;
      else if (familyTokens.length && familyTokens.every(function(tok) { return ltxt.indexOf(tok) !== -1; })) score += 260;

      if (score > bestScore) {
        bestScore = score;
        best = { el: resolveInteractiveMenuItem(el), text: txt, score: score };
      }
    });
    return best;
  }

  function findThinkingMenuTrigger(triggerEl) {
    var items = getFloatingMenuItems(triggerEl);
    for (var i = 0; i < items.length; i++) {
      var txt = cleanVisibleUiText(items[i]);
      if (/\bthinking\s*level\b/i.test(txt)) return resolveInteractiveMenuItem(items[i]);
    }
    var fallback = Array.from(document.querySelectorAll('.cdk-overlay-pane *'));
    for (var j = 0; j < fallback.length; j++) {
      var el = fallback[j];
      if (!el.isConnected || el.closest('#la-gemini-studio-bar') || el.closest('#la-gemini-model-popover')) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 16 || r.height > 90 || r.top < 44 || r.bottom > window.innerHeight + 8) continue;
      var host = resolveInteractiveMenuItem(el);
      var ftxt = cleanVisibleUiText(host);
      if (ftxt && ftxt.length <= 80 && /\bthinking\s*level\b/i.test(ftxt)) {
        return host;
      }
    }
    return null;
  }

  function findThinkingLevelRow(triggerEl, targetLevel) {
    var lvl = (targetLevel || '').trim().toLowerCase();
    if (!lvl || lvl === 'none') return null;
    var thinkingTrigger = findThinkingMenuTrigger(triggerEl);

    function pickBest(candidates) {
      var found = null;
      var foundScore = 0;
      var seen = [];
      candidates.forEach(function(el) {
        var host = resolveInteractiveMenuItem(el);
        if (!host || !host.isConnected || seen.indexOf(host) !== -1) return;
        seen.push(host);
        if (host === triggerEl || host === thinkingTrigger) return;
        if (host.closest('#la-gemini-studio-bar') || host.closest('#la-gemini-model-popover')) return;
        var txt = cleanVisibleUiText(host);
        if (!txt || txt.length > 80) return;
        if (/\bthinking\s*level\b/i.test(txt)) return;
        if (/\b(flash-?lite|hydrogen|argon|carbon|3\.1\s*pro|quick answers|everyday help|detailed research|code & analysis|most complex work)\b/i.test(txt)) return;
        var ltxt = txt.toLowerCase();
        var score = 0;
        if (ltxt === lvl) score = 600;
        else if (new RegExp('^' + lvl + '\\b', 'i').test(ltxt)) score = 500;
        else if (new RegExp('\\b' + lvl + '\\b', 'i').test(ltxt)) score = 300;
        if (score > foundScore) {
          foundScore = score;
          found = host;
        }
      });
      return found;
    }

    var items = getFloatingMenuItems(triggerEl);
    var match = pickBest(items);
    if (match) return resolveInteractiveMenuItem(match);

    var fallbackNodes = Array.from(document.querySelectorAll('.cdk-overlay-pane div, .cdk-overlay-pane li, .cdk-overlay-pane span, .cdk-overlay-pane label, .cdk-overlay-pane button')).filter(function(el) {
      if (!el.isConnected || el.closest('#la-gemini-studio-bar') || el.closest('#la-gemini-model-popover')) return false;
      var r = el.getBoundingClientRect();
      return r.width >= 40 && r.height >= 16 && r.height <= 90 && r.top >= 44 && r.bottom <= window.innerHeight + 8;
    });
    var fbMatch = pickBest(fallbackNodes);
    return fbMatch ? resolveInteractiveMenuItem(fbMatch) : null;
  }

  function getElementScreenCenter(el) {
    try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    var r = el.getBoundingClientRect();
    return {
      cx: Math.round(r.left + r.width / 2),
      cy: Math.round(r.top + r.height / 2)
    };
  }

  function nativeOsClickElement(el, labelText) {
    var target = resolveInteractiveMenuItem(el);
    if (!target || !target.isConnected) return false;
    var pos = getElementScreenCenter(target);
    showClickCursorAt(pos.cx, pos.cy, labelText);
    sendBridgeMsg({
      action: 'native_click',
      x: pos.cx,
      y: pos.cy,
      dpr: window.devicePixelRatio || 1
    });
    return true;
  }

  function nativeOsHoverElement(el, labelText) {
    var target = resolveInteractiveMenuItem(el);
    if (!target || !target.isConnected) return false;
    var pos = getElementScreenCenter(target);
    showClickCursorAt(pos.cx, pos.cy, labelText);
    sendBridgeMsg({
      action: 'native_hover',
      x: pos.cx,
      y: pos.cy,
      dpr: window.devicePixelRatio || 1
    });
    return true;
  }

  function ensureGeminiModelSelected(inputEl, callback, forceOpenMenu) {
    var targetModel = (_state.modelLabel || '4 Hydrogen').trim() || '4 Hydrogen';
    var targetThinking = (_state.thinkingLevel != null ? String(_state.thinkingLevel).trim() : 'High');
    var needThinking = !!targetThinking && targetThinking.toLowerCase() !== 'none';
    _menuInteractionActive = true;
    var finished = false;
    var menuSafetyTimer = setTimeout(function() {
      _menuInteractionActive = false;
      flushBridgeQueue();
    }, 9000);

    function getPillText(el) {
      if (!el) return '';
      var vis = cleanVisibleUiText(el);
      if (vis) return vis;
      return (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    }

    function isStateVerified(el) {
      if (!el || !el.isConnected) return false;
      var txt = getPillText(el);
      if (!matchesModelLabelText(txt, targetModel)) return false;
      if (!needThinking) return true;
      if (matchesThinkingLevelText(txt, targetThinking)) return true;
      if (_verifiedModelKeyOnCurrentPage === getModelPillText()) return true;
      return false;
    }

    function dismissOverlayIfOpen() {
      if (document.querySelector('.cdk-overlay-pane [role="menu"], .cdk-overlay-pane [role="listbox"], .cdk-overlay-pane button, .cdk-overlay-pane [role="menuitem"], .cdk-overlay-pane [role="menuitemradio"]')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      }
    }

    var finish = function(ok) {
      if (finished) return;
      finished = true;
      clearTimeout(menuSafetyTimer);
      _menuInteractionActive = false;
      var mBtn = document.getElementById('la-gemini-model-btn');
      if (mBtn) {
        mBtn.dataset.verified = ok ? '1' : '0';
      }
      updateBarUI();
      flushBridgeQueue();
      if (typeof callback === 'function') callback(!!ok);
    };

    var pillWaitAttempts = 0;
    function waitForPillAndRun() {
      pillWaitAttempts++;
      var pill = findGeminiModelPill(inputEl || findGeminiPromptInput());
      if (!pill) {
        if (pillWaitAttempts < 8) {
          setTimeout(waitForPillAndRun, 220);
          return;
        }
        finish(false);
        return;
      }

      if (!forceOpenMenu && isStateVerified(pill)) {
        finish(true);
        return;
      }

      runSelectionPass(1);
    }

    function openMenuTriggerWithKeys(pillEl) {
      if (!pillEl || !pillEl.isConnected) return;
      try {
        if (typeof pillEl.focus === 'function') pillEl.focus();
        pillEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true, cancelable: true }));
        pillEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      } catch (e) {}
    }

    function runSelectionPass(passNum) {
      var curPill = findGeminiModelPill(inputEl || findGeminiPromptInput());
      if (!curPill) {
        finish(false);
        return;
      }
      if (!(forceOpenMenu && passNum === 1) && isStateVerified(curPill)) {
        dismissOverlayIfOpen();
        finish(true);
        return;
      }

      showStatus('Selecting ' + getModelPillText() + (passNum > 1 ? ' (retry)' : '') + '…', '#93c5fd');
      if (getFloatingMenuItems(curPill).length === 0) {
        nativeOsClickElement(curPill, 'Opening model menu');
      }

      var openPolls = 0;
      var openTimer = setInterval(function() {
        openPolls++;
        var livePill = findGeminiModelPill(inputEl || findGeminiPromptInput()) || curPill;
        var openItems = getFloatingMenuItems(livePill);
        if (openItems.length === 0) {
          if (openPolls === 6) {
            nativeOsClickElement(livePill, 'Opening model menu');
            return;
          }
          if (passNum >= 2 && openPolls === 10) {
            nativeOsClickElement(livePill, 'Opening model menu');
            return;
          }
          if (openPolls >= 14) {
            clearInterval(openTimer);
            if (passNum < 2) {
              setTimeout(function() { runSelectionPass(passNum + 1); }, 280);
            } else {
              finish(isStateVerified(livePill));
            }
          }
          return;
        }

        clearInterval(openTimer);
        var modelOk = matchesModelLabelText(getPillText(livePill), targetModel);
        if (!modelOk) {
          var modelItem = findModelMenuItem(livePill, targetModel);
          if (modelItem && modelItem.el) {
            nativeOsClickElement(modelItem.el, 'Selecting ' + targetModel);
            setTimeout(function() {
              advanceToThinkingStep(passNum);
            }, 550);
            return;
          }
        }
        // Model already matches (e.g. "Hydrogen Low"): do NOT re-click "4 Hydrogen", go straight to Thinking level!
        advanceToThinkingStep(passNum);
      }, 180);
    }

    function advanceToThinkingStep(passNum) {
      var livePill = findGeminiModelPill(inputEl || findGeminiPromptInput());
      if (!needThinking) {
        setTimeout(function() {
          dismissOverlayIfOpen();
          var finalPill = findGeminiModelPill(inputEl || findGeminiPromptInput()) || livePill;
          var ok = isStateVerified(finalPill);
          if (!ok && passNum < 2) {
            runSelectionPass(passNum + 1);
          } else {
            finish(ok);
          }
        }, 280);
        return;
      }

      if (livePill && isStateVerified(livePill)) {
        dismissOverlayIfOpen();
        finish(true);
        return;
      }

      var pillReopened = false;
      var submenuOpenedAt = 0;
      var submenuKeySent = false;
      var levelClickSent = false;
      var thinkPolls = 0;

      var thinkTimer = setInterval(function() {
        thinkPolls++;
        var pNow = findGeminiModelPill(inputEl || findGeminiPromptInput()) || livePill;
        if (pNow && isStateVerified(pNow)) {
          clearInterval(thinkTimer);
          dismissOverlayIfOpen();
          finish(true);
          return;
        }

        var lvlRow = findThinkingLevelRow(pNow, targetThinking);
        if (lvlRow && !levelClickSent) {
          levelClickSent = true;
          clearInterval(thinkTimer);
          nativeOsClickElement(lvlRow, 'Thinking: ' + targetThinking);
          setTimeout(function() {
            _verifiedModelKeyOnCurrentPage = getModelPillText();
            dismissOverlayIfOpen();
            finish(true);
          }, 500);
          return;
        }

        var openItems = getFloatingMenuItems(pNow);
        if (openItems.length === 0) {
          if (!pillReopened && pNow) {
            pillReopened = true;
            nativeOsClickElement(pNow, 'Opening menu for ' + targetThinking);
            return;
          }
        } else {
          var trig = findThinkingMenuTrigger(pNow);
          if (trig) {
            if (!submenuOpenedAt) {
              submenuOpenedAt = Date.now();
              nativeOsHoverElement(trig, 'Hovering Thinking level');
              return;
            }
            if (!submenuKeySent && (Date.now() - submenuOpenedAt >= 420)) {
              submenuKeySent = true;
              nativeOsClickElement(trig, 'Opening Thinking level');
              return;
            }
          }
        }

        if (thinkPolls >= 22) {
          clearInterval(thinkTimer);
          dismissOverlayIfOpen();
          var endPill = findGeminiModelPill(inputEl || findGeminiPromptInput()) || pNow;
          if (endPill && isStateVerified(endPill)) {
            finish(true);
          } else if (passNum < 2) {
            setTimeout(function() { runSelectionPass(passNum + 1); }, 280);
          } else {
            finish(false);
          }
        }
      }, 180);
    }

    function waitVerifyPill(passNum) {
      var polls = 0;
      var vTimer = setInterval(function() {
        polls++;
        var pNow = findGeminiModelPill(inputEl || findGeminiPromptInput());
        if (pNow && isStateVerified(pNow)) {
          clearInterval(vTimer);
          dismissOverlayIfOpen();
          finish(true);
          return;
        }
        if (polls >= 8) {
          clearInterval(vTimer);
          dismissOverlayIfOpen();
          if (passNum < 2) {
            setTimeout(function() { runSelectionPass(passNum + 1); }, 280);
          } else {
            finish(pNow ? isStateVerified(pNow) : false);
          }
        }
      }, 140);
    }

    waitForPillAndRun();
  }

  function setGeminiInputText(inputEl, text) {
    if (!inputEl) return false;
    var expectedMin = Math.min(8, String(text || '').trim().length);
    function hasInputText() {
      var raw = (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT')
        ? (inputEl.value || '')
        : (inputEl.innerText || inputEl.textContent || '');
      return raw.replace(/\u200B/g, '').trim().length >= expectedMin && expectedMin > 0;
    }

    inputEl.focus();

    if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
      try {
        var proto = window.HTMLTextAreaElement && inputEl.tagName === 'TEXTAREA'
          ? window.HTMLTextAreaElement.prototype
          : Object.getPrototypeOf(inputEl);
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        var setter = desc && desc.set;
        if (setter) setter.call(inputEl, text);
        else inputEl.value = text;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        if (hasInputText()) return true;
      } catch (e) {}
    }

    try {
      if (window.getSelection && document.createRange) {
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(inputEl);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      var dt = new DataTransfer();
      dt.setData('text/plain', text);
      var pasteEvt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      });
      inputEl.dispatchEvent(pasteEvt);
      if (hasInputText()) return true;
    } catch (e) {}

    try {
      inputEl.focus();
      if (window.getSelection && document.createRange) {
        var sel2 = window.getSelection();
        var range2 = document.createRange();
        range2.selectNodeContents(inputEl);
        sel2.removeAllRanges();
        sel2.addRange(range2);
      }
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      try {
        inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } catch (ie) {
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (hasInputText()) return true;
    } catch (e) {}

    // Pure-DOM Quill / rich-textarea fallback (no innerHTML so Trusted Types stay happy)
    try {
      while (inputEl.firstChild) inputEl.removeChild(inputEl.firstChild);
      var lines = String(text || '').split(/\r?\n/);
      for (var li = 0; li < lines.length; li++) {
        var p = document.createElement('p');
        if (lines[li]) p.textContent = lines[li];
        else p.appendChild(document.createElement('br'));
        inputEl.appendChild(p);
      }
      if (inputEl.classList) inputEl.classList.remove('ql-blank');
      try {
        inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } catch (ie2) {
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
      return hasInputText();
    } catch (e2) {}
    return false;
  }

  function typeTrailingSpaceKeystroke(inputEl) {
    if (!inputEl || !inputEl.isConnected) return;
    try { inputEl.focus(); } catch (e) {}

    if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
      try {
        var cur = inputEl.value || '';
        if (typeof inputEl.setSelectionRange === 'function') {
          inputEl.setSelectionRange(cur.length, cur.length);
        }
        inputEl.dispatchEvent(new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          keyCode: 32,
          which: 32,
          bubbles: true,
          cancelable: true
        }));
        var insertedInput = false;
        try {
          insertedInput = document.execCommand('insertText', false, ' ');
        } catch (ec) {}
        if (!insertedInput || (inputEl.value || '').length <= cur.length) {
          var proto = window.HTMLTextAreaElement && inputEl.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : Object.getPrototypeOf(inputEl);
          var desc = Object.getOwnPropertyDescriptor(proto, 'value');
          var setter = desc && desc.set;
          var nextVal = cur + ' ';
          if (setter) setter.call(inputEl, nextVal);
          else inputEl.value = nextVal;
        }
        try {
          inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }));
        } catch (ie) {
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        inputEl.dispatchEvent(new KeyboardEvent('keyup', {
          key: ' ',
          code: 'Space',
          keyCode: 32,
          which: 32,
          bubbles: true
        }));
      } catch (e) {}
      return;
    }

    try {
      if (window.getSelection && document.createRange) {
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(inputEl);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      inputEl.dispatchEvent(new KeyboardEvent('keydown', {
        key: ' ',
        code: 'Space',
        keyCode: 32,
        which: 32,
        bubbles: true,
        cancelable: true
      }));
      try {
        inputEl.dispatchEvent(new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: ' '
        }));
      } catch (bi) {}
      var insertedCe = false;
      try {
        insertedCe = document.execCommand('insertText', false, ' ');
      } catch (ec2) {}
      if (!insertedCe) {
        var targetNode = inputEl.lastChild || inputEl;
        if (targetNode && targetNode.nodeType === 1) {
          targetNode.appendChild(document.createTextNode(' '));
        } else {
          inputEl.appendChild(document.createTextNode(' '));
        }
      }
      try {
        inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }));
      } catch (ie2) {
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      inputEl.dispatchEvent(new KeyboardEvent('keyup', {
        key: ' ',
        code: 'Space',
        keyCode: 32,
        which: 32,
        bubbles: true
      }));
    } catch (e2) {}
  }

  function triggerGeminiSubmit(inputEl) {
    var container = (inputEl && (inputEl.closest('form') || inputEl.closest('.input-area, .text-input-field, rich-textarea')?.parentElement?.parentElement)) || document;
    var btnSelectors = [
      'button[aria-label*="Send" i]:not([disabled])',
      'button[aria-label*="Submit" i]:not([disabled])',
      'button.send-button:not([disabled])',
      'button[data-test-id*="send" i]:not([disabled])',
      'button[mattooltip*="Send" i]:not([disabled])'
    ];
    var roots = container !== document ? [container, document] : [document];
    for (var ri = 0; ri < roots.length; ri++) {
      var root = roots[ri];
      for (var i = 0; i < btnSelectors.length; i++) {
        var btns = Array.from(root.querySelectorAll(btnSelectors[i]));
        for (var j = 0; j < btns.length; j++) {
          var btn = btns[j];
          if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
          if (btn.closest('#la-gemini-studio-bar') || btn.closest('#la-gemini-fab-send') || btn.closest('#la-gemini-model-popover')) continue;
          var r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            realPointerClick(btn);
            return true;
          }
        }
      }
    }
    if (inputEl) {
      inputEl.focus();
      inputEl.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      }));
      return true;
    }
    return false;
  }

  var _isPasting = false;
  var _autoSendLastText = '';
  var _autoSendStableSince = 0;

  function isGeminiStillGenerating() {
    var stopSelectors = [
      'button[aria-label*="Stop" i]',
      'button[mattooltip*="Stop" i]',
      'button[data-test-id*="stop" i]',
      'button.stop-button'
    ];
    for (var i = 0; i < stopSelectors.length; i++) {
      var btns = Array.from(document.querySelectorAll(stopSelectors[i]));
      for (var j = 0; j < btns.length; j++) {
        var b = btns[j];
        if (b.closest('#la-gemini-studio-bar') || b.closest('#la-gemini-fab-send')) continue;
        var r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return true;
      }
    }
    return false;
  }

  function stripThinkingFromClone(rootEl) {
    if (!rootEl) return;
    var thoughtSelectors = [
      'model-thoughts',
      '.thoughts-container',
      '.thoughts-wrapper',
      '.thoughts-header',
      '.thought-content',
      '.thinking-block',
      '[data-test-id*="thought" i]',
      '[data-testid*="thought" i]',
      '[class*="thoughts-container" i]',
      '[class*="thinking-block" i]',
      '[aria-label*="Show thinking" i]',
      '[aria-label*="Hide thinking" i]'
    ];
    rootEl.querySelectorAll(thoughtSelectors.join(',')).forEach(function(n) {
      n.remove();
    });
    // Also remove any collapsed/expanded "Show thinking" toggle blocks
    Array.from(rootEl.querySelectorAll('button, [role="button"], mat-expansion-panel, details')).forEach(function(el) {
      var txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^(?:show|hide)\s+thinking\b/i.test(txt) || /^thinking\s*(?:process)?$/i.test(txt)) {
        var panel = el.closest('model-thoughts, mat-expansion-panel, details, .thoughts-container') || el;
        panel.remove();
      }
    });
  }

  function stripSourcesFromClone(rootEl) {
    if (!rootEl) return;
    var allEls = Array.from(rootEl.querySelectorAll('h1, h2, h3, h4, h5, h6, p, div, li, strong, b'));
    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      if (!el.isConnected && !rootEl.contains(el)) continue;
      var t = (el.innerText || el.textContent || '').trim();
      var firstLine = (t.split(/\r?\n/)[0] || '').trim();
      var isExcludeTag = firstLine.length > 0 && firstLine.length <= 260 && /\(\s*exclude\s*\)/i.test(firstLine);
      if (isExcludeTag || /^(?:sources?|references?)\s*:?$/i.test(t)) {
        var topChild = isExcludeTag ? (el.closest('h1, h2, h3, h4, h5, h6, li, p') || el) : el;
        if (!isExcludeTag) {
          while (topChild.parentElement && topChild.parentElement !== rootEl) {
            var parentTxt = (topChild.parentElement.innerText || topChild.parentElement.textContent || '').trim();
            if (/^(?:sources?|references?)\b/i.test(parentTxt)) {
              topChild = topChild.parentElement;
            } else {
              break;
            }
          }
        }
        var cur = topChild;
        while (cur && cur.parentElement && cur !== rootEl) {
          var nxt = cur.nextSibling;
          while (nxt) {
            var rem = nxt;
            nxt = nxt.nextSibling;
            rem.remove();
          }
          cur = cur.parentElement;
        }
        topChild.remove();
        break;
      }
    }
  }

  function stripLeadingPreambleFromClone(rootEl) {
    if (!rootEl) return;
    var removePreceding = function(target, keepTarget) {
      if (!target || target === rootEl) return;
      var cur = target;
      while (cur && cur.parentElement && cur !== rootEl) {
        var prev = cur.previousSibling;
        while (prev) {
          var toRem = prev;
          prev = prev.previousSibling;
          toRem.remove();
        }
        cur = cur.parentElement;
      }
      if (!keepTarget) {
        target.remove();
      }
    };

    var firstTable = rootEl.querySelector('table');
    if (firstTable) {
      removePreceding(firstTable, true);
      return;
    }

    var allEls = Array.from(rootEl.querySelectorAll('h1, h2, h3, h4, h5, h6, p, div, li, strong, b'));
    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      if (!el.isConnected && !rootEl.contains(el)) continue;
      var t = (el.innerText || el.textContent || '').trim();
      if (/^(?:[#*\s\d.()IVX\-–—]+)?recit[\s\-]*ready\s+summary\b\s*:?\s*$/i.test(t)) {
        var block = el.closest('h1, h2, h3, h4, h5, h6, p, li') || el;
        var bTxt = (block.innerText || block.textContent || '').trim();
        if (bTxt.length < 160 && /recit[\s\-]*ready\s+summary/i.test(bTxt)) {
          removePreceding(block, false);
          break;
        }
      }
    }

    var topChildren = Array.from(rootEl.children || []);
    for (var c = 0; c < Math.min(topChildren.length, 4); c++) {
      var child = topChildren[c];
      if (!child || (!child.isConnected && !rootEl.contains(child))) continue;
      var ct = (child.innerText || child.textContent || '').trim();
      if (
        ct.length < 650 &&
        /\b(?:full text of the (?:decision|case|ponencia)|from the text you (?:pasted|provided|shared)|complete ponencia|based on the (?:full )?text you (?:pasted|provided)|here is the (?:case )?digest)\b/i.test(ct)
      ) {
        removePreceding(child, false);
      }
    }
  }

  function stripLeadingPreambleTextInStudio(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    var cleaned = rawText.trim();
    var lines = cleaned.split(/\r?\n/);
    for (var i = 0; i < lines.length - 1; i++) {
      var line = lines[i].trim();
      if (line.indexOf('|') !== -1) {
        var nextIdx = i + 1;
        while (nextIdx < lines.length && !lines[nextIdx].trim()) nextIdx++;
        if (nextIdx < lines.length) {
          var nextLine = lines[nextIdx].trim();
          if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(nextLine) || (line.indexOf('|') === 0 && nextLine.indexOf('|') === 0)) {
            return lines.slice(i).join('\n').trim();
          }
        }
      }
    }
    var recitMatch = cleaned.match(/(?:^|\n)\s*(?:#{1,6}\s*|\*{1,2}\s*|\d+[\.\)]\s*|[IVX]+[\.\)]\s*)*recit[\s\-]*ready\s+summary\b[^\n]*(?:\n+|$)/i);
    if (recitMatch && typeof recitMatch.index === 'number') {
      cleaned = cleaned.slice(recitMatch.index + recitMatch[0].length).trim();
    }
    cleaned = cleaned.replace(
      /^(?:\s*[^\n]*\b(?:full text of the (?:decision|case|ponencia)|from the text you (?:pasted|provided|shared)|complete ponencia|based on the (?:full )?text you (?:pasted|provided)|here is the (?:case )?digest)\b[^\n]*(?:\n+|$))+/i,
      ''
    ).trim();
    return cleaned;
  }

  function stripTrailingSourcesTextInStudio(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    var cleaned = rawText.trim();
    var lines = cleaned.split(/\r?\n/);
    for (var li = 0; li < lines.length; li++) {
      var lt = lines[li].trim();
      if (lt.length > 0 && lt.length <= 260 && /\(\s*exclude\s*\)/i.test(lt)) {
        cleaned = lines.slice(0, li).join('\n').trim();
        break;
      }
    }
    cleaned = cleaned.replace(/\n+\s*(?:#{1,6}\s*|\*{1,2}\s*|[•\-*]\s*)?Sources?\s*\*{0,2}\s*:?\s*\n+[\s\S]*$/i, '');
    return cleaned.trim();
  }

  function getLatestGeminiAnswerSnapshot() {
    var rawNodes = Array.from(document.querySelectorAll(
      'model-response, message-content, .model-response-text, [data-test-id*="model-response"], .markdown, .markdown-main-panel'
    )).filter(function(el) {
      if (el.closest('#la-gemini-studio-bar') || el.closest('#la-gemini-model-popover') || el.closest('#la-gemini-fab-send')) return false;
      if (el.closest('textarea, [contenteditable="true"], nav, aside, model-thoughts, .thoughts-container, [data-test-id*="thought"], .thinking-block')) return false;
      var txt = (el.innerText || '').trim();
      return txt.length > 5;
    });

    var outerNodes = rawNodes.filter(function(el) {
      return !rawNodes.some(function(other) {
        return other !== el && other.contains(el);
      });
    });

    if (outerNodes.length === 0) {
      return { html: '', text: '', wordCount: 0 };
    }

    var targetBlock = outerNodes[outerNodes.length - 1];
    // If targetBlock is a <model-response> containing <message-content>, prefer its message-content children when present
    var msgContents = Array.from(targetBlock.querySelectorAll('message-content, .markdown-main-panel, .model-response-text')).filter(function(mc) {
      return !mc.closest('model-thoughts, .thoughts-container, [data-test-id*="thought"], .thinking-block');
    });
    var blocks = msgContents.length ? [msgContents[msgContents.length - 1]] : [targetBlock];

    var htmlParts = [];
    var textParts = [];
    blocks.forEach(function(block) {
      var clone = block.cloneNode(true);
      stripThinkingFromClone(clone);
      clone.querySelectorAll(
        'button, svg, sup, .citation, [data-test-id*="action"], [data-test-id*="feedback"], [data-test-id*="copy"], [aria-label*="Copy" i], model-response-footer, .response-footer, .message-actions'
      ).forEach(function(n) {
        n.remove();
      });
      stripLeadingPreambleFromClone(clone);
      stripSourcesFromClone(clone);
      var h = clone.innerHTML.trim();
      var t = stripLeadingPreambleTextInStudio(stripTrailingSourcesTextInStudio(clone.innerText || clone.textContent || ''));
      if (t) {
        htmlParts.push(h);
        textParts.push(t);
      }
    });

    var fullHtml = htmlParts.join('<br>');
    var fullText = stripLeadingPreambleTextInStudio(stripTrailingSourcesTextInStudio(textParts.join('\n\n')));
    var words = fullText ? fullText.split(/\s+/).filter(Boolean) : [];
    return {
      html: fullHtml,
      text: fullText,
      wordCount: words.length
    };
  }

  function armAutoSendWatcher() {
    try {
      var baseSnap = getLatestGeminiAnswerSnapshot();
      var jid = String(_state.jobId || Date.now());
      if (!_state.jobId) _state.jobId = Number(jid);
      sessionStorage.setItem('la_gemini_awaiting_autosend_job_id', jid);
      sessionStorage.setItem('la_gemini_baseline_text', baseSnap.text || '');
      _autoSendLastText = '';
      _autoSendStableSince = 0;
    } catch (e) {}
  }

  var _awaitingLastChangeAt = 0;
  var _awaitingStoppedAt = 0;
  var _studioBlockerReported = false;
  var _studioMountedAt = Date.now();

  function detectStudioPageBlocker() {
    if (Date.now() - _studioMountedAt < 3500) return false;
    var url = (window.location.href || '').toLowerCase();
    var hasInput = !!findGeminiPromptInput();
    if (/accounts\.google\.com|\/servicelogin|\/signin/.test(url)) {
      emitStudioStatus('error', 'Sign-in required', 'Sign in to Google/Gemini inside the Studio window, then click Paste Case.', true);
      return true;
    }
    var bodyTxt = '';
    try {
      bodyTxt = ((document.body && document.body.innerText) || '').slice(0, 2500);
    } catch (e) {}
    if (!hasInput && /\b(sign in to continue|choose an account|use your google account)\b/i.test(bodyTxt)) {
      emitStudioStatus('error', 'Sign-in required', 'Sign in to Google/Gemini inside the Studio window, then click Paste Case.', true);
      return true;
    }
    if (!hasInput && /\b(something went wrong|unusual traffic|verify you are human|rate limit)\b/i.test(bodyTxt)) {
      emitStudioStatus('error', 'Gemini error', 'Gemini reported an error or verification prompt — check the Studio window.', true);
      return true;
    }
    return false;
  }

  function checkAutoSendProgress() {
    if (_state.autoSendDigest === false) return;
    var awaitingJobId = sessionStorage.getItem('la_gemini_awaiting_autosend_job_id');
    if (!awaitingJobId) {
      _awaitingLastChangeAt = 0;
      _awaitingStoppedAt = 0;
      return;
    }
    if (sessionStorage.getItem('la_gemini_autosent_job_id') === awaitingJobId) {
      sessionStorage.removeItem('la_gemini_awaiting_autosend_job_id');
      _awaitingLastChangeAt = 0;
      _awaitingStoppedAt = 0;
      return;
    }

    if (!_awaitingLastChangeAt) _awaitingLastChangeAt = Date.now();

    var baseline = sessionStorage.getItem('la_gemini_baseline_text') || '';
    var snap = getLatestGeminiAnswerSnapshot();
    var generating = isGeminiStillGenerating();

    if (!snap.text || snap.text === baseline || snap.wordCount < 55) {
      if (snap.text && snap.text !== baseline && snap.wordCount > 5) {
        if (snap.text !== _autoSendLastText) {
          _awaitingLastChangeAt = Date.now();
          _awaitingStoppedAt = 0;
        }
        showStatus('Gemini is writing digest (' + snap.wordCount + ' words)… will auto-send when finished.', '#fbbf24');
        emitStudioStatus('streaming', 'Writing digest (' + snap.wordCount + ' words)', 'Gemini is writing digest (' + snap.wordCount + ' words)…', false);
      } else if (!generating) {
        if (!_awaitingStoppedAt) _awaitingStoppedAt = Date.now();
        if (Date.now() - _awaitingStoppedAt > 25000 && Date.now() - _awaitingLastChangeAt > 25000) {
          emitStudioStatus('error', 'Generation stalled', 'Gemini did not start or stalled before completing digest — focus Studio to check.', true);
        }
      } else {
        _awaitingStoppedAt = 0;
      }
      _autoSendLastText = snap.text || '';
      _autoSendStableSince = Date.now();
      return;
    }

    _awaitingStoppedAt = 0;
    if (snap.text !== _autoSendLastText || generating) {
      if (snap.text !== _autoSendLastText) _awaitingLastChangeAt = Date.now();
      _autoSendLastText = snap.text;
      _autoSendStableSince = Date.now();
      showStatus('Gemini is writing digest (' + snap.wordCount + ' words)… will auto-send when finished.', '#fbbf24');
      emitStudioStatus('streaming', 'Writing digest (' + snap.wordCount + ' words)', 'Gemini is writing digest (' + snap.wordCount + ' words)…', false);
      if (Date.now() - _awaitingLastChangeAt > 180000) {
        emitStudioStatus('error', 'Generation stalled', 'Gemini digest generation appears stalled — focus Studio to check or send manually.', true);
      }
      return;
    }

    if (!_autoSendStableSince) {
      _autoSendStableSince = Date.now();
      return;
    }

    var stableMs = Date.now() - _autoSendStableSince;
    if (stableMs < 4500) {
      var secsLeft = Math.max(1, Math.ceil((4500 - stableMs) / 1000));
      showStatus('Digest complete (' + snap.wordCount + ' words) — auto-sending in ' + secsLeft + 's…', '#4ade80');
      emitStudioStatus('streaming', 'Finalizing digest (' + snap.wordCount + ' words)', 'Digest complete (' + snap.wordCount + ' words) — sending in ' + secsLeft + 's…', false);
      return;
    }

    sessionStorage.setItem('la_gemini_autosent_job_id', awaitingJobId);
    sessionStorage.removeItem('la_gemini_awaiting_autosend_job_id');
    _awaitingLastChangeAt = 0;
    _awaitingStoppedAt = 0;
    sendDigestPayload(snap.html, snap.text);
  }

  function pasteAndMaybeSubmit(manualTrigger) {
    if (_isPasting) return false;
    var fullText = (_state.fullPromptText || '').trim();
    if (!fullText) {
      showStatus('No PDF text loaded yet — click "Case Digest (Gemini)" in Legal Annotator.', '#f87171');
      emitStudioStatus('error', 'No PDF text', 'No PDF text loaded yet — retry Gemini Digest from Legal Annotator.', true);
      return false;
    }

    var activeInput = findGeminiPromptInput();
    if (!activeInput) {
      if (manualTrigger) showStatus('Waiting for Gemini "Ask Gemini" prompt box…', '#fbbf24');
      return false;
    }

    _isPasting = true;
    showStatus('Verifying ' + getModelPillText() + ' with OS mouse…', '#93c5fd');

    ensureGeminiModelSelected(activeInput, function(modelVerified) {
      var targetInput = findGeminiPromptInput() || activeInput;
      if (!targetInput || !targetInput.isConnected) {
        _isPasting = false;
        setTimeout(function() { processActiveJob(); }, 400);
        return;
      }

      try { targetInput.scrollIntoView({ block: 'center' }); } catch (e) {}
      var pos = getElementScreenCenter(targetInput);
      if (!pos || pos.cy < 44) {
        _isPasting = false;
        return;
      }

      if (_state.jobId) {
        sessionStorage.setItem('la_gemini_handled_job_id', String(_state.jobId));
      }
      armAutoSendWatcher();
      showStatus('Clicking prompt box (OS) → waiting 1s → OS Ctrl+V → waiting 1s → OS Enter…', '#93c5fd');
      emitStudioStatus('extracting', 'Pasting via OS', 'Clicking prompt box (OS) → waiting 1s → OS Ctrl+V → waiting 1s → OS Enter…', false);

      sendBridgeMsg({
        action: 'native_paste_and_submit',
        x: pos.cx,
        y: pos.cy,
        dpr: window.devicePixelRatio || 1,
        autoSubmit: !!_state.autoSubmit
      });
    });

    return true;
  }

  window.__onNativePasteSubmitDone = function(ok) {
    _isPasting = false;
    _awaitingLastChangeAt = Date.now();
    _awaitingStoppedAt = 0;
    if (!ok) {
      showStatus('Click inside Ask Gemini and press Ctrl+V (OS paste failed).', '#fbbf24');
      emitStudioStatus('error', 'Paste needs focus', 'Could not paste automatically via OS — click inside Ask Gemini and press Ctrl+V.', true);
      return;
    }
    if (_state.autoSubmit) {
      showStatus('Submitted via OS Ctrl+V + Enter! Waiting to auto-send to Case Digest…', '#4ade80');
      emitStudioStatus('submitted', 'Prompt submitted', 'Submitted via OS Ctrl+V + Enter — waiting for Gemini response…', false, true);
      setTimeout(function() {
        if (!isGeminiStillGenerating()) {
          var curBox = findGeminiPromptInput();
          var boxLen = ((curBox && (curBox.innerText || curBox.textContent || curBox.value || '').trim().length) || 0);
          if (boxLen > 20) {
            var sendSelectors = [
              'button[aria-label*="Send" i]:not([disabled])',
              'button[aria-label*="Submit" i]:not([disabled])',
              'button.send-button:not([disabled])',
              'button[data-test-id*="send" i]:not([disabled])',
              'button[mattooltip*="Send" i]:not([disabled])'
            ];
            for (var si = 0; si < sendSelectors.length; si++) {
              var btns = Array.from(document.querySelectorAll(sendSelectors[si]));
              for (var bi = 0; bi < btns.length; bi++) {
                var btn = btns[bi];
                if (!btn || !btn.isConnected) continue;
                if (btn.closest('#la-gemini-studio-bar') || btn.closest('#la-gemini-model-popover') || btn.closest('#la-gemini-fab-send') || btn.closest('#la-gemini-click-cursor')) continue;
                if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
                var r = btn.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0 || r.top < 44) continue;
                var st = window.getComputedStyle ? window.getComputedStyle(btn) : null;
                if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
                nativeOsClickElement(btn, 'Send');
                return;
              }
            }
          }
        }
      }, 900);
    } else {
      showStatus('Pasted via OS Ctrl+V! Review prompt and press Enter to submit.', '#4ade80');
      emitStudioStatus('idle', 'Ready in Studio', 'Pasted via OS Ctrl+V — press Enter in Studio to submit.', false, true);
    }
  };

  function extractAndSendDigest() {
    var sel = window.getSelection ? window.getSelection() : null;
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 20) {
      var range = sel.getRangeAt(0);
      var div = document.createElement('div');
      div.appendChild(range.cloneContents());
      stripThinkingFromClone(div);
      stripLeadingPreambleFromClone(div);
      stripSourcesFromClone(div);
      sendDigestPayload(div.innerHTML, stripLeadingPreambleTextInStudio(stripTrailingSourcesTextInStudio(sel.toString().trim())));
      return;
    }

    var snap = getLatestGeminiAnswerSnapshot();
    if (snap.text && snap.text.length > 10) {
      sendDigestPayload(snap.html, snap.text);
      return;
    }

    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function(clipText) {
        if (clipText && clipText.trim().length > 10) {
          sendDigestPayload('', stripLeadingPreambleTextInStudio(stripTrailingSourcesTextInStudio(clipText.trim())));
        } else {
          showStatus('No Gemini answer found yet — wait for answer or select text.', '#f87171');
          emitStudioStatus('error', 'No answer found', 'No Gemini answer found yet — wait for reply or select text in Studio.', true);
        }
      }).catch(function() {
        showStatus('No Gemini answer found on page yet.', '#f87171');
        emitStudioStatus('error', 'No answer found', 'No Gemini answer found on page yet.', true);
      });
    } else {
      showStatus('No Gemini answer found on page yet.', '#f87171');
      emitStudioStatus('error', 'No answer found', 'No Gemini answer found on page yet.', true);
    }
  }

  function sendDigestPayload(html, text) {
    showStatus('Sending to Case Digest tab…', '#fbbf24');
    sendBridgeMsg({
      action: 'send_digest',
      pdfId: _state.pdfId || '',
      pdfName: _state.pdfName || '',
      subjectId: _state.subjectId || '',
      digestMode: _state.digestMode === 'replace' ? 'replace' : 'append',
      html: html || '',
      text: text || ''
    });
  }

  window.__onGeminiDigestSentAck = function(ok) {
    if (ok) {
      var modeWord = _state.digestMode === 'replace' ? 'Replaced in' : 'Appended to';
      showStatus(modeWord + ' Case Digest tab! Ready for next case.', '#4ade80');
      emitStudioStatus('done', 'Digest saved', modeWord + ' Case Digest tab!', false, true);
      var sendLbl = document.getElementById('la-gemini-send-lbl');
      var fabLbl = document.getElementById('la-gemini-fab-lbl');
      if (sendLbl) {
        sendLbl.textContent = '✓ Sent to Case Digest!';
        setTimeout(function() {
          var el = document.getElementById('la-gemini-send-lbl');
          if (el) el.textContent = 'Send to Case Digest';
        }, 2400);
      }
      if (fabLbl) {
        fabLbl.textContent = '✓ Sent to Case Digest!';
        setTimeout(function() {
          var el = document.getElementById('la-gemini-fab-lbl');
          if (el) el.textContent = 'Send to Case Digest';
        }, 2400);
      }
      // Return to the general Gemini homepage after 900ms for batch/next case readiness
      setTimeout(function() {
        returnToNotebookHome();
      }, 900);
    }
  };

  var _jobTimer = null;
  function processActiveJob() {
    ensureStudioBar();
    if (!_state.jobId || !_state.fullPromptText) return;

    var handledJob = sessionStorage.getItem('la_gemini_handled_job_id');
    if (handledJob === String(_state.jobId)) return;

    var curUrl = window.location.href;
    if (isNotebookUrl(curUrl)) {
      returnToNotebookHome();
      return;
    }

    if (_jobTimer) clearInterval(_jobTimer);
    var attempts = 0;
    _jobTimer = setInterval(function() {
      if (Date.now() < _notebookTransitionReadyAt) {
        showStatus('Waiting 1s for Gemini session & skills to initialize…', '#93c5fd');
        return;
      }
      attempts++;
      if (sessionStorage.getItem('la_gemini_handled_job_id') === String(_state.jobId)) {
        clearInterval(_jobTimer);
        _jobTimer = null;
        return;
      }
      var inputEl = findGeminiPromptInput();
      if (inputEl && inputEl.isConnected) {
        clearInterval(_jobTimer);
        _jobTimer = null;
        setTimeout(function() {
          pasteAndMaybeSubmit(false);
        }, 250);
      } else if (attempts >= 25) {
        clearInterval(_jobTimer);
        _jobTimer = null;
        sessionStorage.setItem('la_gemini_handled_job_id', String(_state.jobId));
        showStatus('Click "Paste Case" above when prompt box is ready.', '#fbbf24');
        if (!detectStudioPageBlocker()) {
          emitStudioStatus('error', 'Prompt box missing', 'Gemini "Ask Gemini" box not found — focus Studio and click Paste Case.', true);
        }
      }
    }, 350);
  }

  window.__GEMINI_STUDIO_RECEIVE_JOB = function(job) {
    if (!job || typeof job !== 'object') return;
    var isNewJob = job.jobId && String(job.jobId) !== String(_state.jobId);
    for (var k in job) {
      if (job[k] !== undefined && job[k] !== null) {
        _state[k] = job[k];
      }
    }
    _state.pinnedNotebookUrl = '';
    if (isNewJob) {
      sessionStorage.removeItem('la_gemini_handled_job_id');
      sessionStorage.removeItem('la_gemini_awaiting_autosend_job_id');
      sessionStorage.removeItem('la_gemini_auto_opened_job_id');
      _isPasting = false;
      _verifiedModelKeyOnCurrentPage = '';
      if (_jobTimer) {
        clearInterval(_jobTimer);
        _jobTimer = null;
      }
      _notebookTransitionReadyAt = Math.max(_notebookTransitionReadyAt, Date.now() + 1000);
    }
    saveStateCache();
    ensureStudioBar();

    if (isNewJob) {
      var curHref = window.location.href || '';
      var isInNotebookOrThread = isNotebookUrl(curHref) || /gemini\.google\.com\/(?:u\/\d+\/)?app\/[A-Za-z0-9_\-]+/i.test(curHref);
      if (isInNotebookOrThread) {
        if (sessionStorage.getItem('la_gemini_nav_once_job_id') !== String(_state.jobId)) {
          sessionStorage.setItem('la_gemini_nav_once_job_id', String(_state.jobId));
          showStatus('Opening Gemini homepage…', '#93c5fd');
          if (returnToNotebookHome()) {
            setTimeout(function() { processActiveJob(); }, 1200);
            return;
          }
        }
      }
    }

    processActiveJob();
  };

  var _lastHref = window.location.href;
  setInterval(function() {
    try {
      ensureStudioBar();
      checkAutoSendProgress();
      if (!_studioBlockerReported && !sessionStorage.getItem('la_gemini_handled_job_id')) {
        if (detectStudioPageBlocker()) _studioBlockerReported = true;
      }
      if (window.location.href !== _lastHref) {
        _lastHref = window.location.href;
        _studioBlockerReported = false;
        _verifiedModelKeyOnCurrentPage = '';
        updateBarUI();
        _notebookTransitionReadyAt = Math.max(_notebookTransitionReadyAt, Date.now() + 1000);
        processActiveJob();
      }
    } catch (e) {
      try { console.warn('[GeminiStudio] interval tick error:', e); } catch (_e) {}
    }
  }, 800);

  function bootGeminiStudio() {
    try {
      _notebookTransitionReadyAt = Math.max(_notebookTransitionReadyAt, Date.now() + 1000);
      ensureStudioBar();
      emitStudioStatus('extracting', 'Studio ready', 'Gemini Studio loaded.', false);
      processActiveJob();
    } catch (e) {
      try { console.warn('[GeminiStudio] boot error:', e); } catch (_e) {}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootGeminiStudio);
  } else {
    bootGeminiStudio();
  }
})();
"#;

#[tauri::command]
pub async fn desktop_get_gemini_prefs() -> Result<serde_json::Value, String> {
    Ok(load_gemini_prefs_disk())
}

#[tauri::command]
pub async fn desktop_save_gemini_prefs(prefs: serde_json::Value) -> Result<bool, String> {
    let mut current = load_gemini_prefs_disk();
    if let Some(obj) = prefs.as_object() {
        for (k, v) in obj {
            if k == "subjectNotebooks" {
                if let Some(nb_obj) = v.as_object() {
                    let mut cleaned = serde_json::Map::new();
                    for (sid, surl) in nb_obj {
                        if let Some(s) = surl.as_str() {
                            let norm = normalize_gemini_notebook_url(s);
                            if !norm.is_empty() {
                                cleaned.insert(sid.clone(), serde_json::Value::String(norm));
                            }
                        }
                    }
                    current["subjectNotebooks"] = serde_json::Value::Object(cleaned);
                }
            } else {
                current[k] = v.clone();
            }
        }
        // Also support single-subject update payloads { subjectId, pinnedNotebookUrl }
        if let Some(sid) = obj
            .get("subjectId")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            if let Some(url_val) = obj.get("pinnedNotebookUrl").and_then(|v| v.as_str()) {
                let norm = normalize_gemini_notebook_url(url_val);
                if !current["subjectNotebooks"].is_object() {
                    current["subjectNotebooks"] = serde_json::json!({});
                }
                if let Some(map) = current["subjectNotebooks"].as_object_mut() {
                    if norm.is_empty() {
                        map.remove(sid);
                    } else {
                        map.insert(sid.to_string(), serde_json::Value::String(norm));
                    }
                }
            }
        }
    }
    save_gemini_prefs_disk(&current);
    Ok(true)
}

fn emit_gemini_studio_status(app: &tauri::AppHandle, mut payload: serde_json::Value) {
    if let Some(obj) = payload.as_object_mut() {
        if !obj.contains_key("action") {
            let is_err = obj.get("state").and_then(|v| v.as_str()) == Some("error");
            obj.insert(
                "action".to_string(),
                serde_json::Value::String(
                    if is_err {
                        "studio_error"
                    } else {
                        "studio_status"
                    }
                    .to_string(),
                ),
            );
        }
    }
    if let Some(main_win) = app.get_webview_window("main") {
        if let Ok(json_str) = serde_json::to_string(&payload) {
            let js = format!(
                "(function(p){{ if (typeof window.__desktopForwardGeminiStatus === 'function') window.__desktopForwardGeminiStatus(p); else if (typeof window.__onGeminiStudioStatus === 'function') window.__onGeminiStudioStatus(p); }})({});",
                json_str
            );
            let _ = main_win.eval(&js);
        }
    }
}

#[tauri::command]
pub fn desktop_focus_gemini_studio(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(win) = app.get_webview_window("gemini-studio") {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
        let _ = win.show();
        let _ = win.set_focus();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn desktop_open_gemini_studio(
    app: tauri::AppHandle,
    pdf_id: String,
    pdf_name: String,
    subject_id: Option<String>,
    subject_name: Option<String>,
    subfolder_name: Option<String>,
    instruction_text: Option<String>,
    pdf_text: String,
    full_prompt_text: String,
    pinned_notebook_url: Option<String>,
    model_label: Option<String>,
    thinking_level: Option<String>,
    auto_submit: Option<bool>,
    digest_mode: Option<String>,
    auto_send_digest: Option<bool>,
) -> Result<bool, String> {
    let mut disk_prefs = load_gemini_prefs_disk();
    let eff_subject_id = subject_id.unwrap_or_default().trim().to_string();
    let eff_subject_name = subject_name.unwrap_or_default().trim().to_string();

    let _ = pinned_notebook_url;
    let eff_pinned = String::new();

    let eff_model_label = model_label
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            disk_prefs
                .get("modelLabel")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "4 Hydrogen".to_string());

    let eff_thinking_level = thinking_level
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            disk_prefs
                .get("thinkingLevel")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "High".to_string());

    let eff_auto_submit = auto_submit.unwrap_or_else(|| {
        disk_prefs
            .get("autoSubmit")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    });

    let eff_digest_mode = digest_mode
        .filter(|s| s == "replace" || s == "append")
        .or_else(|| {
            disk_prefs
                .get("digestMode")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "append".to_string());

    let eff_auto_send = auto_send_digest.unwrap_or_else(|| {
        disk_prefs
            .get("autoSendDigest")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    });

    if !eff_subject_id.is_empty() && !eff_pinned.is_empty() {
        if !disk_prefs["subjectNotebooks"].is_object() {
            disk_prefs["subjectNotebooks"] = serde_json::json!({});
        }
        if let Some(map) = disk_prefs["subjectNotebooks"].as_object_mut() {
            map.insert(
                eff_subject_id.clone(),
                serde_json::Value::String(eff_pinned.clone()),
            );
        }
    }
    disk_prefs["modelLabel"] = serde_json::Value::String(eff_model_label.clone());
    disk_prefs["thinkingLevel"] = serde_json::Value::String(eff_thinking_level.clone());
    disk_prefs["autoSubmit"] = serde_json::Value::Bool(eff_auto_submit);
    disk_prefs["digestMode"] = serde_json::Value::String(eff_digest_mode.clone());
    disk_prefs["autoSendDigest"] = serde_json::Value::Bool(eff_auto_send);
    save_gemini_prefs_disk(&disk_prefs);

    let job_id = crate::now_ms();
    let job_val = serde_json::json!({
        "pdfId": pdf_id,
        "pdfName": pdf_name,
        "subjectId": eff_subject_id,
        "subjectName": eff_subject_name,
        "subfolderName": subfolder_name.unwrap_or_default(),
        "instructionText": instruction_text.unwrap_or_default(),
        "pdfText": pdf_text,
        "fullPromptText": full_prompt_text,
        "pinnedNotebookUrl": eff_pinned,
        "modelLabel": eff_model_label,
        "thinkingLevel": eff_thinking_level,
        "autoSubmit": eff_auto_submit,
        "digestMode": eff_digest_mode,
        "autoSendDigest": eff_auto_send,
        "jobId": job_id,
    });

    let state_arc = get_gemini_job_state();
    if let Ok(mut g) = state_arc.lock() {
        *g = job_val.clone();
    }

    let job_json_str = serde_json::to_string(&job_val).unwrap_or_else(|_| "{}".to_string());
    let win_label = "gemini-studio";
    let win_title = if eff_subject_name.is_empty() {
        format!("Gemini Digest Studio — {} — Legal Annotator", pdf_name)
    } else {
        format!(
            "Gemini Digest Studio ({}) — {} — Legal Annotator",
            eff_subject_name, pdf_name
        )
    };

    if let Some(existing) = app.get_webview_window(win_label) {
        let _ = existing.set_title(&win_title);
        if existing.is_minimized().unwrap_or(false) {
            let _ = existing.unminimize();
        }
        let _ = existing.show();
        let _ = existing.set_focus();
        let eval_js = format!(
            "window.__GEMINI_STUDIO_RECEIVE_JOB && window.__GEMINI_STUDIO_RECEIVE_JOB({});",
            job_json_str
        );
        let _ = existing.eval(&eval_js);
        emit_gemini_studio_status(
            &app,
            serde_json::json!({
                "action": "studio_status",
                "state": "extracting",
                "stepLabel": "Studio focused",
                "message": format!("Opened Gemini Studio for {}", pdf_name),
                "pdfId": pdf_id,
                "canRetry": false
            }),
        );
        return Ok(true);
    }

    let start_url_str = "https://gemini.google.com/app".to_string();

    let parsed_url = tauri::Url::parse(&start_url_str).map_err(|e| e.to_string())?;
    let app_for_nav = app.clone();
    let state_for_nav = get_gemini_job_state();
    let init_script_with_job = format!(
        "window.__INITIAL_GEMINI_JOB__ = {};\n{}",
        job_json_str, GEMINI_INIT_SCRIPT
    );

    let mut builder = WebviewWindowBuilder::new(&app, win_label, WebviewUrl::External(parsed_url))
        .title(win_title)
        .inner_size(1120.0, 840.0)
        .center()
        .visible(true)
        .focused(true)
        .initialization_script(&init_script_with_job);

    builder = builder.on_navigation(move |url| {
        let url_str = url.as_str();
        if let Some(idx) = url_str.find("http://127.0.0.1:19877/__gemini_msg?d=") {
            let encoded = &url_str[(idx + "http://127.0.0.1:19877/__gemini_msg?d=".len())..];
            let b64_clean = crate::percent_decode_str(encoded);
            if let Ok(decoded_bytes) = BASE64.decode(b64_clean.as_bytes()) {
                if let Ok(json_str) = String::from_utf8(decoded_bytes) {
                    if let Ok(msg_val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                        let action = msg_val
                            .get("action")
                            .and_then(|a| a.as_str())
                            .unwrap_or("");
                        if action == "save_prefs" {
                            let mut prefs = load_gemini_prefs_disk();
                            let sid = msg_val
                                .get("subjectId")
                                .and_then(|v| v.as_str())
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty())
                                .or_else(|| {
                                    state_for_nav.lock().ok().and_then(|st| {
                                        st.get("subjectId")
                                            .and_then(|v| v.as_str())
                                            .map(|s| s.trim().to_string())
                                            .filter(|s| !s.is_empty())
                                    })
                                });
                            if let (Some(subject_id_str), Some(u)) = (
                                sid,
                                msg_val.get("pinnedNotebookUrl").and_then(|v| v.as_str()),
                            ) {
                                let norm = normalize_gemini_notebook_url(u);
                                if !prefs["subjectNotebooks"].is_object() {
                                    prefs["subjectNotebooks"] = serde_json::json!({});
                                }
                                if let Some(map) = prefs["subjectNotebooks"].as_object_mut() {
                                    if norm.is_empty() {
                                        map.remove(&subject_id_str);
                                    } else {
                                        map.insert(
                                            subject_id_str,
                                            serde_json::Value::String(norm.clone()),
                                        );
                                    }
                                }
                                if let Ok(mut st) = state_for_nav.lock() {
                                    st["pinnedNotebookUrl"] = serde_json::Value::String(norm);
                                }
                            }
                            if let Some(m) = msg_val.get("modelLabel").and_then(|v| v.as_str()) {
                                let trimmed = m.trim();
                                if !trimmed.is_empty() {
                                    prefs["modelLabel"] =
                                        serde_json::Value::String(trimmed.to_string());
                                    if let Ok(mut st) = state_for_nav.lock() {
                                        st["modelLabel"] =
                                            serde_json::Value::String(trimmed.to_string());
                                    }
                                }
                            }
                            if let Some(t) = msg_val.get("thinkingLevel").and_then(|v| v.as_str()) {
                                let trimmed = t.trim();
                                if !trimmed.is_empty() {
                                    prefs["thinkingLevel"] =
                                        serde_json::Value::String(trimmed.to_string());
                                    if let Ok(mut st) = state_for_nav.lock() {
                                        st["thinkingLevel"] =
                                            serde_json::Value::String(trimmed.to_string());
                                    }
                                }
                            }
                            if let Some(a) = msg_val.get("autoSubmit").and_then(|v| v.as_bool()) {
                                prefs["autoSubmit"] = serde_json::Value::Bool(a);
                                if let Ok(mut st) = state_for_nav.lock() {
                                    st["autoSubmit"] = serde_json::Value::Bool(a);
                                }
                            }
                            if let Some(m) = msg_val.get("digestMode").and_then(|v| v.as_str()) {
                                prefs["digestMode"] = serde_json::Value::String(m.to_string());
                                if let Ok(mut st) = state_for_nav.lock() {
                                    st["digestMode"] = serde_json::Value::String(m.to_string());
                                }
                            }
                            if let Some(asend) =
                                msg_val.get("autoSendDigest").and_then(|v| v.as_bool())
                            {
                                prefs["autoSendDigest"] = serde_json::Value::Bool(asend);
                                if let Ok(mut st) = state_for_nav.lock() {
                                    st["autoSendDigest"] = serde_json::Value::Bool(asend);
                                }
                            }
                            save_gemini_prefs_disk(&prefs);
                            if let Some(main_win) = app_for_nav.get_webview_window("main") {
                                let js = format!(
                                    "window.__onGeminiPrefsUpdated && window.__onGeminiPrefsUpdated({});",
                                    json_str
                                );
                                let _ = main_win.eval(&js);
                            }
                        } else if action == "send_digest" {
                            if let Some(main_win) = app_for_nav.get_webview_window("main") {
                                let js = format!(
                                    "window.__onGeminiDigestReceived && window.__onGeminiDigestReceived({});",
                                    json_str
                                );
                                let _ = main_win.eval(&js);
                            }
                            let app_ack = app_for_nav.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(60));
                                if let Some(gw) = app_ack.get_webview_window("gemini-studio") {
                                    let _ = gw.eval(
                                        "window.__onGeminiDigestSentAck && window.__onGeminiDigestSentAck(true);",
                                    );
                                }
                            });
                        } else if action == "native_click" || action == "native_hover" {
                            let is_click = action == "native_click";
                            let css_x = msg_val.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let css_y = msg_val.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let js_dpr = msg_val.get("dpr").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let app_click = app_for_nav.clone();
                            std::thread::spawn(move || {
                                let _guard = GEMINI_MOUSE_LOCK
                                    .get_or_init(|| Mutex::new(()))
                                    .lock();
                                if let Some(gw) = app_click.get_webview_window("gemini-studio") {
                                    let _ = gw.show();
                                    let _ = gw.unminimize();
                                    let _ = gw.set_focus();
                                    std::thread::sleep(std::time::Duration::from_millis(25));
                                    if let Ok(inner_pos) = gw.inner_position() {
                                        let win_scale = gw.scale_factor().unwrap_or(1.0);
                                        let scale = if js_dpr > 0.2 { js_dpr } else { win_scale };
                                        let screen_x =
                                            inner_pos.x + (css_x * scale).round() as i32;
                                        let screen_y =
                                            inner_pos.y + (css_y * scale).round() as i32;
                                        if is_click {
                                            crate::perform_native_os_mouse_click(screen_x, screen_y);
                                        } else {
                                            crate::perform_native_os_mouse_move(screen_x, screen_y);
                                        }
                                    }
                                }
                            });
                        } else if action == "native_paste_and_submit" {
                            let css_x = msg_val.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let css_y = msg_val.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let js_dpr = msg_val.get("dpr").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let auto_submit = msg_val
                                .get("autoSubmit")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true);
                            let prompt_text = state_for_nav
                                .lock()
                                .ok()
                                .and_then(|st| {
                                    st.get("fullPromptText")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string())
                                })
                                .unwrap_or_default();
                            let app_paste = app_for_nav.clone();
                            std::thread::spawn(move || {
                                let _guard = GEMINI_MOUSE_LOCK
                                    .get_or_init(|| Mutex::new(()))
                                    .lock();
                                let mut ok = false;
                                if !prompt_text.is_empty()
                                    && crate::set_native_os_clipboard_text(&prompt_text)
                                {
                                    if let Some(gw) = app_paste.get_webview_window("gemini-studio")
                                    {
                                        let _ = gw.show();
                                        let _ = gw.unminimize();
                                        let _ = gw.set_focus();
                                        std::thread::sleep(std::time::Duration::from_millis(80));
                                        if let Ok(inner_pos) = gw.inner_position() {
                                            let win_scale = gw.scale_factor().unwrap_or(1.0);
                                            let scale = if js_dpr > 0.2 { js_dpr } else { win_scale };
                                            let screen_x =
                                                inner_pos.x + (css_x * scale).round() as i32;
                                            let screen_y =
                                                inner_pos.y + (css_y * scale).round() as i32;
                                            crate::perform_native_os_mouse_click(
                                                screen_x, screen_y,
                                            );
                                            std::thread::sleep(std::time::Duration::from_millis(
                                                1000,
                                            ));
                                            let _ = gw.show();
                                            let _ = gw.unminimize();
                                            let _ = gw.set_focus();
                                            std::thread::sleep(std::time::Duration::from_millis(
                                                50,
                                            ));
                                            crate::perform_native_os_mouse_click(
                                                screen_x, screen_y,
                                            );
                                            std::thread::sleep(std::time::Duration::from_millis(
                                                120,
                                            ));
                                            crate::perform_native_os_ctrl_v();
                                            std::thread::sleep(std::time::Duration::from_millis(
                                                200,
                                            ));
                                            let _ = gw.set_focus();
                                            crate::perform_native_os_key_space();
                                            std::thread::sleep(std::time::Duration::from_millis(
                                                800,
                                            ));
                                            if auto_submit {
                                                let _ = gw.set_focus();
                                                std::thread::sleep(
                                                    std::time::Duration::from_millis(40),
                                                );
                                                crate::perform_native_os_key_enter();
                                            }
                                            ok = true;
                                        }
                                    }
                                }
                                std::thread::sleep(std::time::Duration::from_millis(100));
                                if let Some(gw) = app_paste.get_webview_window("gemini-studio") {
                                    let js = format!(
                                        "window.__onNativePasteSubmitDone && window.__onNativePasteSubmitDone({});",
                                        if ok { "true" } else { "false" }
                                    );
                                    let _ = gw.eval(&js);
                                }
                            });
                        } else if action == "studio_status" || action == "studio_error" {
                            let mut status_val = msg_val.clone();
                            if let Some(obj) = status_val.as_object_mut() {
                                if !obj.contains_key("pdfId") {
                                    if let Ok(st) = state_for_nav.lock() {
                                        if let Some(pid) = st.get("pdfId").cloned() {
                                            obj.insert("pdfId".to_string(), pid);
                                        }
                                    }
                                }
                                if action == "studio_error" && !obj.contains_key("state") {
                                    obj.insert(
                                        "state".to_string(),
                                        serde_json::Value::String("error".to_string()),
                                    );
                                }
                            }
                            emit_gemini_studio_status(&app_for_nav, status_val);
                        }
                    }
                }
            }
            return false;
        }
        true
    });

    let win = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            let err_msg = e.to_string();
            emit_gemini_studio_status(
                &app,
                serde_json::json!({
                    "action": "studio_error",
                    "state": "error",
                    "stepLabel": "Studio failed to open",
                    "message": format!("Could not open Gemini Studio: {}", err_msg),
                    "pdfId": pdf_id,
                    "canRetry": true
                }),
            );
            return Err(err_msg);
        }
    };

    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    emit_gemini_studio_status(
        &app,
        serde_json::json!({
            "action": "studio_status",
            "state": "extracting",
            "stepLabel": "Studio opened",
            "message": format!("Opening Gemini Studio for {}", pdf_name),
            "pdfId": pdf_id,
            "canRetry": false
        }),
    );

    let app_for_close = app.clone();
    let state_for_close = get_gemini_job_state();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let cur_pdf_id = state_for_close
                .lock()
                .ok()
                .and_then(|st| {
                    st.get("pdfId")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_default();
            emit_gemini_studio_status(
                &app_for_close,
                serde_json::json!({
                    "action": "studio_status",
                    "state": "idle",
                    "stepLabel": "Studio closed",
                    "message": "Gemini Studio window was closed.",
                    "pdfId": cur_pdf_id,
                    "canRetry": false
                }),
            );
        }
    });
    Ok(true)
}
