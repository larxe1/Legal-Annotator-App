// ═══════════════════════════════════════════════
// COLORS — color category management
// ═══════════════════════════════════════════════
import { S } from './state.js';
import { toast, openModal, closeModal } from './ui.js';
import { dbCreateColorCat, dbDelColorCat } from './db.js';

export function renderColorDots() {
  const w = document.getElementById('color-dots');
  w.innerHTML = '';
  for (const cat of S.colorCats) {
    const d = document.createElement('div');
    d.className = 'cdot' + (S.activeColor === cat.hex_color ? ' sel' : '');
    d.style.background = cat.hex_color;
    d.title = cat.name; // tooltip via CSS ::after
    d.addEventListener('click', () => {
      S.activeColor = cat.hex_color;
      document.querySelectorAll('.cdot').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel');
    });
    w.appendChild(d);
  }
}

export function initColors() {
  document.getElementById('add-color-btn').addEventListener('click', () => openModal('mo-color'));
  document.getElementById('save-color').addEventListener('click', async () => {
    const name = document.getElementById('cat-name').value.trim();
    if (!name) return;
    await dbCreateColorCat(name, document.getElementById('cat-color').value);
    renderColorDots();
    closeModal('mo-color');
    document.getElementById('cat-name').value = '';
    toast('Color added');
  });
}
