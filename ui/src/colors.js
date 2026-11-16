// ═══════════════════════════════════════════════
// COLORS — color category management
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { toast, openModal, closeModal } from './ui.js';
import { dbCreateColorCat, dbUpdateColorCat, dbDelColorCat } from './db.js';

const COLOR_ORDER_STORAGE_KEY = 'la_color_cat_order';
let _memoryColorOrder = null;
let _draggingDotCatId = null;
let _draggingRowCatId = null;

function _hexToHsl(hex) {
  const norm = normalizeHexColor(hex);
  if (!norm) return null;
  const r = parseInt(norm.slice(1, 3), 16) / 255;
  const g = parseInt(norm.slice(3, 5), 16) / 255;
  const b = parseInt(norm.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) {
    h = ((g - b) / d) + (g < b ? 6 : 0);
  } else if (max === g) {
    h = ((b - r) / d) + 2;
  } else {
    h = ((r - g) / d) + 4;
  }
  h *= 60;
  return { h, s, l };
}

function _getDefaultColorBucket(hex) {
  const hsl = _hexToHsl(hex);
  if (!hsl || hsl.s < 0.12 || hsl.l <= 0.04 || hsl.l >= 0.97) return 3;
  const { h } = hsl;
  if (h >= 25 && h <= 68) return 0; // Yellow-brown / gold / amber / ochre
  if (h >= 338 || h < 25) return 1; // Red / coral / crimson / rose-red
  if (h >= 190 && h <= 255) return 2; // Blue
  return 3;
}

function _readSavedColorOrder() {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(COLOR_ORDER_STORAGE_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.map(id => String(id));
        }
      }
    }
  } catch (e) {
    console.warn('[Colors] Failed to read saved color order:', e);
  }
  return Array.isArray(_memoryColorOrder) ? _memoryColorOrder : null;
}

function _saveColorOrder(ids) {
  _memoryColorOrder = ids;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(COLOR_ORDER_STORAGE_KEY, JSON.stringify(ids));
    }
  } catch (e) {
    console.warn('[Colors] Failed to save color order:', e);
  }
}

/**
 * Sort color categories in place using saved custom order from localStorage,
 * or deterministic RGB/HSL bucket order (Yellow-brown -> Red -> Blue -> Others).
 */
export function applySavedColorOrder(cats) {
  if (!Array.isArray(cats) || cats.length <= 1) return cats;
  const savedOrder = _readSavedColorOrder();
  const indexed = cats.map((cat, idx) => ({ cat, idx }));

  if (savedOrder && savedOrder.length > 0) {
    const posMap = new Map();
    savedOrder.forEach((id, i) => {
      if (!posMap.has(id)) posMap.set(id, i);
    });
    indexed.sort((a, b) => {
      const aPos = posMap.has(String(a.cat?.id)) ? posMap.get(String(a.cat?.id)) : Infinity;
      const bPos = posMap.has(String(b.cat?.id)) ? posMap.get(String(b.cat?.id)) : Infinity;
      if (aPos !== bPos) return aPos - bPos;
      return a.idx - b.idx;
    });
  } else {
    indexed.sort((a, b) => {
      const aBucket = _getDefaultColorBucket(a.cat?.hex_color);
      const bBucket = _getDefaultColorBucket(b.cat?.hex_color);
      if (aBucket !== bBucket) return aBucket - bBucket;
      return a.idx - b.idx;
    });
  }

  for (let i = 0; i < indexed.length; i++) {
    cats[i] = indexed[i].cat;
  }
  return cats;
}

/**
 * Reorder a color category in S.colorCats relative to targetId ('before' | 'after'),
 * persist order to localStorage, re-render UI, and notify listeners.
 */
export function reorderColorCat(draggedId, targetId, position = 'before') {
  if (!Array.isArray(S.colorCats) || S.colorCats.length < 2) return false;
  const fromIdx = S.colorCats.findIndex(c => String(c.id) === String(draggedId));
  const toIdx = S.colorCats.findIndex(c => String(c.id) === String(targetId));
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return false;

  const [moved] = S.colorCats.splice(fromIdx, 1);
  let insertIdx = S.colorCats.findIndex(c => String(c.id) === String(targetId));
  if (insertIdx === -1) {
    S.colorCats.splice(fromIdx, 0, moved);
    return false;
  }
  if (position === 'after') insertIdx += 1;
  S.colorCats.splice(insertIdx, 0, moved);

  _saveColorOrder(S.colorCats.map(c => String(c.id)));
  renderColorDots();
  const modal = document.getElementById('mo-color-categories');
  if (modal && modal.classList.contains('open')) {
    renderColorCategoriesList();
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('la:color-order-changed', {
      detail: { colorCats: S.colorCats },
    }));
  }
  return true;
}

/**
 * Normalize a CSS color string (#rgb, #rrggbb, rgb(), rgba()) to lowercase #rrggbb.
 * Returns null for empty, transparent, or unrecognized values.
 */
export function normalizeHexColor(val) {
  if (typeof val !== 'string') return null;
  const s = val.trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'none' || s === 'inherit' || s === 'initial') return null;

  const m6 = s.match(/^#?([0-9a-f]{6})$/);
  if (m6) return '#' + m6[1];

  const m3 = s.match(/^#?([0-9a-f]{3})$/);
  if (m3) return '#' + m3[1].split('').map(ch => ch + ch).join('');

  const mRgb = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+))?\s*\)$/);
  if (mRgb) {
    if (mRgb[4] !== undefined && parseFloat(mRgb[4]) === 0) return null;
    const hex = [mRgb[1], mRgb[2], mRgb[3]]
      .map(n => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0'))
      .join('');
    return '#' + hex;
  }
  return null;
}

/**
 * Resolve a highlight hex color against active S.colorCats.
 * Never drops or mutates legacy/orphan hex colors.
 */
export function getColorCategoryForHex(hex) {
  const norm = normalizeHexColor(hex);
  if (!norm) {
    return { id: null, name: 'Custom', hex_color: null, isLegacy: true };
  }
  const cats = Array.isArray(S.colorCats) ? S.colorCats : [];
  const match = cats.find(c => normalizeHexColor(c.hex_color) === norm);
  if (match) {
    return {
      id: match.id ?? null,
      name: match.name || 'Color',
      hex_color: norm,
      isLegacy: false,
    };
  }
  return {
    id: null,
    name: `Custom (${norm})`,
    hex_color: norm,
    isLegacy: true,
  };
}

export function getColorCategoryLabel(hex) {
  return getColorCategoryForHex(hex).name;
}

function _syncActiveSwatchSelection(targetHex) {
  const targetNorm = normalizeHexColor(targetHex);
  document.querySelectorAll('.cdot, #selmenuSwatches [data-color], #selmenuSwatches button, #selmenuSwatches .sel-swatch').forEach(el => {
    const elNorm = normalizeHexColor(el.getAttribute('data-color') || el.style.backgroundColor || el.style.background);
    el.classList.toggle('sel', Boolean(targetNorm && elNorm === targetNorm));
  });
}

function _syncSelectionMenuSwatches() {
  const wrap = document.getElementById('selmenuSwatches');
  if (!wrap) return;
  const activeNorm = normalizeHexColor(S.activeColor);
  wrap.querySelectorAll('[data-color], button, .sel-swatch, .cdot').forEach(el => {
    const raw = el.getAttribute('data-color') || el.style.backgroundColor || el.style.background;
    const norm = normalizeHexColor(raw);
    if (!norm) return;
    el.setAttribute('data-color', norm);
    const info = getColorCategoryForHex(norm);
    el.title = info.name;
    el.setAttribute('aria-label', info.name);
    el.classList.toggle('sel', Boolean(activeNorm && norm === activeNorm));
  });
}

function _clearDotDragClasses(container) {
  if (!container) return;
  container.querySelectorAll('.cdot').forEach(el => {
    el.classList.remove('dragging', 'drop-before', 'drop-after');
  });
}

function _clearRowDragClasses(list) {
  if (!list) return;
  list.querySelectorAll('.color-cat-row').forEach(el => {
    el.classList.remove('dragging', 'drop-above', 'drop-below');
  });
}

export function renderColorDots() {
  const w = document.getElementById('color-dots');
  if (!w) return;
  applySavedColorOrder(S.colorCats);
  w.innerHTML = '';
  const activeNorm = normalizeHexColor(S.activeColor);
  for (const cat of S.colorCats || []) {
    const norm = normalizeHexColor(cat.hex_color) || cat.hex_color;
    const catId = String(cat.id);
    const d = document.createElement('div');
    d.className = 'cdot' + (activeNorm && normalizeHexColor(norm) === activeNorm ? ' sel' : '');
    d.draggable = true;
    d.dataset.catId = catId;
    if (norm) d.dataset.color = norm;
    d.style.background = norm;
    d.title = cat.name; // tooltip via CSS ::after
    d.setAttribute('aria-label', cat.name);
    d.addEventListener('click', () => {
      S.activeColor = norm;
      _syncActiveSwatchSelection(norm);
    });
    d.addEventListener('dragstart', (e) => {
      _draggingDotCatId = catId;
      d.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', catId);
      }
    });
    d.addEventListener('dragover', (e) => {
      if (_draggingDotCatId && _draggingDotCatId === catId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      w.querySelectorAll('.cdot').forEach(el => {
        if (el !== d) el.classList.remove('drop-before', 'drop-after');
      });
      const rect = d.getBoundingClientRect();
      const isBefore = e.clientX < rect.left + rect.width / 2;
      d.classList.toggle('drop-before', isBefore);
      d.classList.toggle('drop-after', !isBefore);
    });
    d.addEventListener('dragleave', () => {
      d.classList.remove('drop-before', 'drop-after');
    });
    d.addEventListener('drop', (e) => {
      e.preventDefault();
      const draggedId = _draggingDotCatId || e.dataTransfer?.getData('text/plain');
      const rect = d.getBoundingClientRect();
      const position = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
      _draggingDotCatId = null;
      _clearDotDragClasses(w);
      if (draggedId && String(draggedId) !== catId) {
        reorderColorCat(draggedId, catId, position);
      }
    });
    d.addEventListener('dragend', () => {
      _draggingDotCatId = null;
      _clearDotDragClasses(w);
    });
    w.appendChild(d);
  }
  _syncSelectionMenuSwatches();
}

export function renderColorCategoriesList() {
  const list = document.getElementById('color-cat-list');
  if (!list) return;
  applySavedColorOrder(S.colorCats);
  list.innerHTML = '';

  const cats = Array.isArray(S.colorCats) ? S.colorCats : [];
  if (!cats.length) {
    const empty = document.createElement('div');
    empty.className = 'color-cat-empty';
    empty.textContent = 'No highlight categories yet. Add one below.';
    list.appendChild(empty);
    return;
  }

  for (const cat of cats) {
    const normHex = normalizeHexColor(cat.hex_color) || '#c9a84c';
    const catId = String(cat.id);
    const row = document.createElement('div');
    row.className = 'color-cat-row';
    row.setAttribute('role', 'listitem');
    row.draggable = true;
    row.dataset.catId = catId;

    const dragHandle = document.createElement('span');
    dragHandle.className = 'color-cat-drag';
    dragHandle.title = 'Drag to reorder';
    dragHandle.setAttribute('aria-hidden', 'true');
    dragHandle.textContent = '⋮⋮';

    const swatch = document.createElement('span');
    swatch.className = 'color-cat-row__swatch';
    swatch.style.background = normHex;

    const colorInp = document.createElement('input');
    colorInp.type = 'color';
    colorInp.className = 'color-cat-row__color';
    colorInp.value = normHex;
    colorInp.title = 'Pick category color';
    colorInp.setAttribute('aria-label', `${cat.name} color`);

    const hexInp = document.createElement('input');
    hexInp.type = 'text';
    hexInp.className = 'color-cat-row__hex';
    hexInp.value = normHex;
    hexInp.maxLength = 7;
    hexInp.spellcheck = false;
    hexInp.setAttribute('aria-label', `${cat.name} hex code`);

    const nameInp = document.createElement('input');
    nameInp.type = 'text';
    nameInp.className = 'color-cat-row__name';
    nameInp.value = cat.name || '';
    nameInp.placeholder = 'Category name';
    nameInp.setAttribute('aria-label', 'Category name');

    const syncFromColorPicker = () => {
      const n = normalizeHexColor(colorInp.value) || colorInp.value;
      hexInp.value = n;
      swatch.style.background = n;
    };
    const syncFromHexInput = () => {
      const n = normalizeHexColor(hexInp.value);
      if (n) {
        colorInp.value = n;
        swatch.style.background = n;
      }
    };
    colorInp.addEventListener('input', syncFromColorPicker);
    colorInp.addEventListener('change', syncFromColorPicker);
    hexInp.addEventListener('input', syncFromHexInput);
    hexInp.addEventListener('change', syncFromHexInput);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'color-cat-row__save';
    saveBtn.textContent = 'Save';
    saveBtn.draggable = false;

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'color-cat-row__del';
    delBtn.title = `Delete ${cat.name || 'category'}`;
    delBtn.setAttribute('aria-label', `Delete ${cat.name || 'category'}`);
    delBtn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>';
    delBtn.draggable = false;
    colorInp.draggable = false;
    hexInp.draggable = false;
    nameInp.draggable = false;

    const handleSave = async () => {
      if (saveBtn.disabled) return;
      const nextName = nameInp.value.trim();
      if (!nextName) {
        toast('Enter a category name', 'err');
        nameInp.focus();
        return;
      }
      const rawHex = hexInp.value.trim();
      const nextHex = rawHex ? normalizeHexColor(rawHex) : normalizeHexColor(colorInp.value);
      if (!nextHex) {
        toast('Enter a valid hex color (e.g. #c9a84c)', 'err');
        hexInp.focus();
        return;
      }
      saveBtn.disabled = true;
      try {
        const prevNorm = normalizeHexColor(cat.hex_color);
        await dbUpdateColorCat(cat.id, nextName, nextHex);
        if (prevNorm && normalizeHexColor(S.activeColor) === prevNorm) {
          S.activeColor = nextHex;
        }
        refreshColorCategoryUI();
        toast('Color category updated');
      } catch (err) {
        console.error('[Colors] Failed to update category:', err);
        const reason = err?.message ? `: ${err.message}` : '';
        toast(`Could not update color category${reason}`, 'err');
      } finally {
        saveBtn.disabled = false;
      }
    };

    saveBtn.addEventListener('click', handleSave);
    const onEnterSave = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      }
    };
    nameInp.addEventListener('keydown', onEnterSave);
    hexInp.addEventListener('keydown', onEnterSave);

    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true;
      try {
        const deletedNorm = normalizeHexColor(cat.hex_color);
        await dbDelColorCat(cat.id);
        if (deletedNorm && normalizeHexColor(S.activeColor) === deletedNorm) {
          S.activeColor = normalizeHexColor(S.colorCats[0]?.hex_color) || '#c9a84c';
        }
        refreshColorCategoryUI();
        toast('Color category removed');
      } catch (err) {
        console.error('[Colors] Failed to delete category:', err);
        const reason = err?.message ? `: ${err.message}` : '';
        toast(`Could not remove color category${reason}`, 'err');
      } finally {
        delBtn.disabled = false;
      }
    });

    const disableRowDragForControls = (e) => {
      if (e.target && e.target.closest && e.target.closest('input, textarea, select, button')) {
        row.draggable = false;
        const restoreDraggable = () => { row.draggable = true; };
        window.addEventListener('pointerup', restoreDraggable, { once: true });
        window.addEventListener('mouseup', restoreDraggable, { once: true });
        window.addEventListener('pointercancel', restoreDraggable, { once: true });
      } else {
        row.draggable = true;
      }
    };
    row.addEventListener('pointerdown', disableRowDragForControls);
    row.addEventListener('mousedown', disableRowDragForControls);
    row.addEventListener('dragstart', (e) => {
      if (!row.draggable || (e.target && e.target.closest && e.target.closest('input, textarea, select, button'))) {
        e.preventDefault();
        return;
      }
      _draggingRowCatId = catId;
      row.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', catId);
      }
    });
    row.addEventListener('dragover', (e) => {
      if (_draggingRowCatId && _draggingRowCatId === catId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      list.querySelectorAll('.color-cat-row').forEach(el => {
        if (el !== row) el.classList.remove('drop-above', 'drop-below');
      });
      const rect = row.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;
      row.classList.toggle('drop-above', isAbove);
      row.classList.toggle('drop-below', !isAbove);
    });
    row.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && row.contains(e.relatedTarget)) return;
      row.classList.remove('drop-above', 'drop-below');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const draggedId = _draggingRowCatId || e.dataTransfer?.getData('text/plain');
      const rect = row.getBoundingClientRect();
      const position = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      _draggingRowCatId = null;
      _clearRowDragClasses(list);
      if (draggedId && String(draggedId) !== catId) {
        reorderColorCat(draggedId, catId, position);
      }
    });
    row.addEventListener('dragend', () => {
      _draggingRowCatId = null;
      row.draggable = true;
      _clearRowDragClasses(list);
    });

    row.appendChild(dragHandle);
    row.appendChild(swatch);
    row.appendChild(colorInp);
    row.appendChild(hexInp);
    row.appendChild(nameInp);
    row.appendChild(saveBtn);
    row.appendChild(delBtn);
    list.appendChild(row);
  }
}

function _wireColorCategoriesModal() {
  const modal = document.getElementById('mo-color-categories');
  if (!modal || modal.dataset.wired === '1') return;
  modal.dataset.wired = '1';

  const form = document.getElementById('color-cat-add-form');
  const addBtn = document.getElementById('addColorCatBtn') || document.getElementById('color-cat-add-btn');
  const nameInput = document.getElementById('newCatName') || document.getElementById('color-cat-new-name');
  const colorInput = document.getElementById('newCatColor') || document.getElementById('color-cat-new-color');
  const hexInput = document.getElementById('newCatHex');

  if (colorInput && hexInput) {
    colorInput.addEventListener('input', () => {
      hexInput.value = normalizeHexColor(colorInput.value) || colorInput.value;
    });
    hexInput.addEventListener('input', () => {
      const n = normalizeHexColor(hexInput.value);
      if (n) colorInput.value = n;
    });
  }

  const handleAdd = async (e) => {
    if (e) e.preventDefault();
    const name = nameInput?.value.trim() || '';
    if (!name) {
      toast('Enter a category name');
      nameInput?.focus();
      return;
    }
    const hex = normalizeHexColor(hexInput?.value) || normalizeHexColor(colorInput?.value) || '#a855f7';
    if (addBtn) addBtn.disabled = true;
    try {
      await dbCreateColorCat(name, hex);
      if (nameInput) nameInput.value = '';
      refreshColorCategoryUI();
      toast('Color category added');
    } catch (err) {
      console.error('[Colors] Failed to add category:', err);
      toast('Could not add color category');
    } finally {
      if (addBtn) addBtn.disabled = false;
    }
  };

  if (form) {
    form.addEventListener('submit', handleAdd);
  } else if (addBtn) {
    addBtn.addEventListener('click', handleAdd);
  }
}

export function openColorCategoriesModal() {
  const modal = document.getElementById('mo-color-categories');
  if (!modal) {
    openModal('mo-color');
    return;
  }
  _wireColorCategoriesModal();
  renderColorCategoriesList();
  openModal('mo-color-categories');
}

export function refreshColorCategoryUI({ dispatch = true } = {}) {
  renderColorDots();
  const modal = document.getElementById('mo-color-categories');
  if (modal && (modal.classList.contains('open') || document.getElementById('color-cat-list'))) {
    renderColorCategoriesList();
  }
  if (dispatch && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('la:color-cats-changed', {
      detail: { fromColorsJs: true, colorCats: S.colorCats || [] },
    }));
    window.dispatchEvent(new CustomEvent('la:colors-updated', {
      detail: { colorCats: S.colorCats || [] },
    }));
  }
}

let _colorsListenerAttached = false;
export function initColors() {
  document.getElementById('add-color-btn')?.addEventListener('click', () => openModal('mo-color'));
  document.getElementById('save-color')?.addEventListener('click', async () => {
    const nameEl = document.getElementById('cat-name');
    const colorEl = document.getElementById('cat-color');
    const name = nameEl?.value.trim() || '';
    if (!name) return;
    const hex = normalizeHexColor(colorEl?.value) || colorEl?.value || '#a855f7';
    await dbCreateColorCat(name, hex);
    refreshColorCategoryUI();
    closeModal('mo-color');
    if (nameEl) nameEl.value = '';
    toast('Color added');
  });

  if (!_colorsListenerAttached && typeof window !== 'undefined') {
    _colorsListenerAttached = true;
    window.addEventListener('la:color-cats-changed', (ev) => {
      if (ev?.detail?.fromColorsJs) return;
      refreshColorCategoryUI({ dispatch: false });
    });
    window.addEventListener('la:reorder-color-cat', (ev) => {
      const { draggedId, targetId, position } = ev?.detail || {};
      if (draggedId != null && targetId != null) {
        reorderColorCat(draggedId, targetId, position || 'before');
      }
    });
  }
}
