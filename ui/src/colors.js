// ═══════════════════════════════════════════════
// COLORS — color category management
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { toast, openModal, closeModal } from './ui.js';
import { dbCreateColorCat, dbUpdateColorCat, dbDelColorCat } from './db.js';

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

export function renderColorDots() {
  const w = document.getElementById('color-dots');
  if (!w) return;
  w.innerHTML = '';
  const activeNorm = normalizeHexColor(S.activeColor);
  for (const cat of S.colorCats || []) {
    const norm = normalizeHexColor(cat.hex_color) || cat.hex_color;
    const d = document.createElement('div');
    d.className = 'cdot' + (activeNorm && normalizeHexColor(norm) === activeNorm ? ' sel' : '');
    if (norm) d.dataset.color = norm;
    d.style.background = norm;
    d.title = cat.name; // tooltip via CSS ::after
    d.setAttribute('aria-label', cat.name);
    d.addEventListener('click', () => {
      S.activeColor = norm;
      _syncActiveSwatchSelection(norm);
    });
    w.appendChild(d);
  }
  _syncSelectionMenuSwatches();
}

export function renderColorCategoriesList() {
  const list = document.getElementById('color-cat-list');
  if (!list) return;
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
    const row = document.createElement('div');
    row.className = 'color-cat-row';
    row.setAttribute('role', 'listitem');
    row.dataset.catId = cat.id;

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

    colorInp.addEventListener('input', () => {
      const n = normalizeHexColor(colorInp.value) || colorInp.value;
      hexInp.value = n;
      swatch.style.background = n;
    });
    hexInp.addEventListener('input', () => {
      const n = normalizeHexColor(hexInp.value);
      if (n) {
        colorInp.value = n;
        swatch.style.background = n;
      }
    });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'color-cat-row__save';
    saveBtn.textContent = 'Save';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'color-cat-row__del';
    delBtn.title = `Delete ${cat.name || 'category'}`;
    delBtn.setAttribute('aria-label', `Delete ${cat.name || 'category'}`);
    delBtn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>';

    const handleSave = async () => {
      const nextName = nameInp.value.trim();
      if (!nextName) {
        toast('Enter a category name');
        nameInp.focus();
        return;
      }
      const nextHex = normalizeHexColor(hexInp.value) || normalizeHexColor(colorInp.value);
      if (!nextHex) {
        toast('Enter a valid hex color (e.g. #c9a84c)');
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
        toast('Could not update color category');
      } finally {
        saveBtn.disabled = false;
      }
    };

    saveBtn.addEventListener('click', handleSave);
    nameInp.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      }
    });

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
        toast('Could not remove color category');
      } finally {
        delBtn.disabled = false;
      }
    });

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
  }
}
