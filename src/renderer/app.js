/*
 * Maneja Discos — gestor de discos libre y de código abierto
 * Copyright (C) 2026 Santiago Miguel <chago2850@gmail.com>
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Este programa es software libre: puede redistribuirlo y/o modificarlo bajo los
 * términos de la Licencia Pública General GNU publicada por la Free Software
 * Foundation, ya sea la versión 3 de la Licencia o (a su elección) cualquier
 * versión posterior.
 *
 * Este programa se distribuye con la esperanza de que sea útil, pero SIN NINGUNA
 * GARANTÍA; ni siquiera la garantía implícita de COMERCIABILIDAD o IDONEIDAD PARA
 * UN PROPÓSITO PARTICULAR. Consulte la Licencia Pública General GNU para más detalles.
 *
 * Debería haber recibido una copia de la Licencia Pública General GNU junto con
 * este programa (archivo LICENSE). Si no, consulte <https://www.gnu.org/licenses/>.
 */
'use strict';
/* Maneja Discos — interfaz (sin frameworks). Toda la E/S pasa por window.md (preload). */

const MiB = 1024 * 1024;
const state = {
  info: null, settings: {}, view: 'home',
  disks: [], disksError: null, loadingDisks: false,
  sel: null, ops: [], redo: [], showNew: true,
  sets: [], schedules: [], activity: [],
  running: new Map(), callbacks: new Map(), surface: new Map(),
};

// ---------------------------------------------------------------- utilidades
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (['value', 'checked', 'disabled', 'hidden', 'selected', 'readOnly', 'min', 'max', 'step', 'placeholder', 'type', 'title'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  disk: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="12" cy="11" r="4"/><circle cx="12" cy="11" r="1"/><path d="M7 17h2"/>',
  backup: '<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v5c0 1.7 3.6 3 8 3"/><path d="M4 12v5c0 1.7 3.6 3 8 3"/><path d="M18 14v6M15 17l3 3 3-3"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h3v3"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  eraser: '<path d="M20 20H9l-6-6 10-10 9 9-6 7"/><path d="M6 11l7 7"/>',
  tools: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  brush: '<path d="M4 20c4 0 5-2 5-4a3 3 0 0 1 3-3l8-8-3-3-8 8a3 3 0 0 1-3 3c-2 0-4 1-2 7z"/>',
  tag: '<path d="M20 12l-8 8-9-9V3h8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  resize: '<path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  pin: '<path d="M12 17v5M5 17h14l-2-5V4H7v8z"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  warn: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  code: '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6"/>',
  usb: '<path d="M12 2v14"/><circle cx="12" cy="19" r="3"/><path d="M7 7v3l5 3 5-3V6"/><rect x="15" y="4" width="4" height="3"/><circle cx="7" cy="6" r="1.5"/>',
  gauge: '<path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 13l4-5"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  star: '<path d="M12 3l2.7 5.6 6.3.9-4.5 4.4 1 6.1-5.5-2.9-5.5 2.9 1-6.1L3 9.5l6.3-.9z"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3 3.5M6.5 7.6A17 17 0 0 0 2 12s4 6 10 6a9.6 9.6 0 0 0 4.4-1"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  ssd: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h2M7 14h2M12 10h5M12 14h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
};
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = ICONS[name] || ICONS.info;
  return s;
}

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0; let v = Number(n);
  while (Math.abs(v) >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleString('es', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDur(s) {
  if (s == null || !isFinite(s)) return '';
  s = Math.round(s);
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${s} s`;
}
const FS_LABEL = { ntfs: 'NTFS', fat32: 'FAT32', fat16: 'FAT16', exfat: 'exFAT', ext4: 'ext4', ext3: 'ext3', ext2: 'ext2', apfs: 'APFS', hfs: 'Mac OS Plus', btrfs: 'Btrfs', xfs: 'XFS', swap: 'Intercambio', refs: 'ReFS', none: 'Sin formato' };
const fsName = (f) => (f ? FS_LABEL[f] || f.toUpperCase() : 'Sin formato');
const FS_VARS = new Set(['ntfs', 'fat32', 'exfat', 'ext4', 'ext3', 'ext2', 'apfs', 'hfs', 'btrfs', 'xfs', 'swap', 'refs']);
const fsColor = (f) => { const k = ({ fat16: 'fat32', vfat: 'fat32' }[f] || f); return `var(--fs-${FS_VARS.has(k) ? k : 'unknown'})`; };
const TYPE_LABEL = { full: 'Completa', incremental: 'Incremental', differential: 'Diferencial' };

function toast(msg, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

// ---------------------------------------------------------------- modales
function modal({ title, body, buttons = [], wide = false, steps = '' }) {
  const root = document.getElementById('modal-root');
  const close = () => back.remove();
  const foot = h('div', { class: 'modal-foot' });
  const back = h('div', { class: 'modal-backdrop', onMousedown: (e) => { if (e.target === back) close(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}` },
      h('div', { class: 'modal-head' }, h('h2', {}, title), steps ? h('span', { class: 'steps' }, steps) : null),
      h('div', { class: 'modal-body' }, body),
      foot));
  const setButtons = (list) => {
    foot.replaceChildren(...list.map((b) => h('button', {
      class: `btn ${b.kind || ''} ${b.left ? 'left' : ''}`,
      disabled: b.disabled,
      onClick: async () => { const r = await b.onClick?.(); if (b.close !== false && r !== false) close(); },
    }, b.label)));
  };
  setButtons(buttons);
  root.append(back);
  return { close, setButtons, body: back.querySelector('.modal-body') };
}

function confirmDanger({ title, text, word = 'BORRAR', action = 'Continuar' }) {
  return new Promise((resolve) => {
    const needWord = state.settings.confirmTyping !== false;
    const input = h('input', { type: 'text', placeholder: word });
    let m;
    const body = h('div', {},
      h('div', { class: 'notice danger' }, text),
      needWord ? h('div', { class: 'field', style: { marginTop: '14px' } }, h('label', {}, `Escribe ${word} para confirmar`), input) : null);
    m = modal({
      title, body,
      buttons: [
        { label: 'Cancelar', onClick: () => resolve(false) },
        { label: action, kind: 'danger', onClick: () => { if (needWord && input.value.trim().toUpperCase() !== word) { toast(`Escribe ${word} para confirmar.`, 'error'); return false; } resolve(true); return true; } },
      ],
    });
    void m;
    setTimeout(() => input.focus(), 50);
  });
}

function askPassword(title = 'Contraseña de la copia') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'password', placeholder: 'Contraseña' });
    modal({
      title,
      body: h('div', { class: 'field' }, h('label', {}, 'Esta copia está cifrada'), input),
      buttons: [{ label: 'Cancelar', onClick: () => resolve(null) }, { label: 'Aceptar', kind: 'primary', onClick: () => resolve(input.value) }],
    });
    setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { document.querySelector('.modal-foot .btn.primary')?.click(); } });
  });
}

/** Asistente por pasos: steps = [{ title, render(data, rerender) → Node, check(data) → error|null }] */
function wizard({ title, steps, data, finishLabel = 'Iniciar', onFinish, wide = true }) {
  let i = 0;
  let m;
  const draw = () => {
    const step = steps[i];
    m.body.replaceChildren(step.render(data, draw));
    m.body.closest('.modal').querySelector('.steps').textContent = `Paso ${i + 1} de ${steps.length} · ${step.title}`;
    m.setButtons([
      { label: 'Cancelar', left: true },
      i > 0 ? { label: 'Atrás', close: false, onClick: () => { i--; draw(); } } : null,
      {
        label: i === steps.length - 1 ? finishLabel : 'Siguiente', kind: 'primary', close: false,
        onClick: async () => {
          const err = step.check ? await step.check(data) : null;
          if (err) { toast(err, 'error'); return; }
          if (i < steps.length - 1) { i++; draw(); } else { const ok = await onFinish(data); if (ok !== false) m.close(); }
        },
      },
    ].filter(Boolean));
  };
  m = modal({ title, body: h('div'), wide, steps: ' ' });
  draw();
  return m;
}

const choice = (on, t, d, onClick, extra) => h('button', { class: `choice ${on ? 'on' : ''}`, onClick }, h('div', { class: 't' }, t), d ? h('div', { class: 'd' }, d) : null, extra || null);
const field = (label, input, help) => h('div', { class: 'field' }, h('label', {}, label), input, help ? h('div', { class: 'help' }, help) : null);
const checkbox = (label, checked, onChange, small) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) }), h('span', {}, label, small ? h('small', {}, small) : null));
const select = (value, options, onChange) => h('select', { onChange: (e) => onChange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));

// ---------------------------------------------------------------- trabajos
async function startJob(job, meta, onDone) {
  const id = await md.job.start(job, meta);
  state.running.set(id, { id, title: meta.title, ev: null, log: [] });
  if (onDone) state.callbacks.set(id, onDone);
  renderDock();
  return id;
}

function onJobEvent({ id, ev }) {
  let r = state.running.get(id);
  if (!r && ev.type !== 'done') { r = { id, title: ev.title || 'Tarea', ev: null, log: [] }; state.running.set(id, r); }
  if (ev.type === 'progress') r.ev = ev;
  if (ev.type === 'log') r.log.push(ev.message);
  if (ev.type === 'surface') { state.surface.set(id, ev.cells); if (state.view === 'tools') drawSurface(id); }
  if (ev.type === 'done') {
    const title = r ? r.title : 'Tarea';
    state.running.delete(id);
    if (ev.ok) toast(`✓ ${title}`, 'ok');
    else if (ev.status === 'cancelled') toast(`${title}: cancelada`);
    else toast(`${title}: ${ev.error}`, 'error');
    if (ev.ok && ev.result?.setDir) md.sets.register(ev.result.setDir);
    const cb = state.callbacks.get(id);
    state.callbacks.delete(id);
    if (cb) cb(ev);
    if (['activity', 'backups', 'home', 'schedules'].includes(state.view)) refreshView();
  }
  renderDock();
  if (state.view === 'activity') updateActivityRunning();
}

function renderDock() {
  const dock = document.getElementById('jobs-dock');
  dock.replaceChildren(...[...state.running.values()].map(jobCard));
  const badge = document.querySelector('[data-nav="activity"] .badge');
  if (badge) { badge.textContent = state.running.size; badge.hidden = !state.running.size; }
}

function jobCard(r) {
  const ev = r.ev || {};
  const pct = ev.pct;
  return h('div', { class: 'job' },
    h('div', { class: 'row space' }, h('div', { class: 'title' }, r.title), h('button', { class: 'btn ghost small', onClick: () => md.job.cancel(r.id), title: 'Cancelar' }, 'Cancelar')),
    h('div', { class: `progress ${pct == null ? 'indeterminate' : ''}` }, h('div', { style: { width: `${pct || 0}%` } })),
    h('div', { class: 'meta' },
      h('span', {}, pct != null ? `${pct.toFixed(1)} %` : 'Preparando…', ev.total && ev.total > 1000 ? ` · ${fmtBytes(ev.done)} de ${fmtBytes(ev.total)}` : ''),
      h('span', {}, ev.speed > 1000 ? `${fmtBytes(ev.speed)}/s` : '', ev.eta ? ` · ${fmtDur(ev.eta)}` : '')),
    h('div', { class: 'msg' }, ev.message || ev.label || r.log[r.log.length - 1] || 'Esperando autorización de administrador…'));
}

// ---------------------------------------------------------------- simulación de operaciones pendientes
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function mergeFree(list) {
  const s = [...list].sort((a, b) => a.start - b.start);
  const out = [];
  for (const f of s) {
    const last = out[out.length - 1];
    if (last && f.start <= last.start + last.size + MiB) last.size = Math.max(last.size, f.start + f.size - last.start);
    else out.push({ ...f });
  }
  return out.filter((f) => f.size >= MiB);
}
function simulate(disks, ops) {
  const ds = clone(disks);
  ops.forEach((op, i) => {
    const d = ds.find((x) => x.id === op.diskId);
    if (!d) return;
    const p = op.partition && d.partitions.find((x) => Math.abs(x.start - op.partition.start) < MiB);
    switch (op.kind) {
      case 'init': d.partitions = []; d.partitionStyle = op.style; d.free = [{ start: MiB, size: d.size - 2 * MiB }]; break;
      case 'convert': d.partitionStyle = op.style; break;
      case 'create': {
        d.partitions.push({ id: `nuevo-${i}`, start: op.start, size: op.size, fs: op.fs === 'none' ? null : op.fs, label: op.label, letter: op.letter, pending: true, flags: {} });
        const out = [];
        for (const f of d.free) {
          if (op.start >= f.start - MiB && op.start < f.start + f.size) {
            if (op.start - f.start >= MiB) out.push({ start: f.start, size: op.start - f.start });
            const end = op.start + op.size;
            if (f.start + f.size - end >= MiB) out.push({ start: end, size: f.start + f.size - end });
          } else out.push(f);
        }
        d.free = out;
        break;
      }
      case 'delete': if (p) { d.partitions = d.partitions.filter((x) => x !== p); d.free = mergeFree([...d.free, { start: p.start, size: p.size }]); } break;
      case 'format': if (p) { p.fs = op.fs; p.label = op.label; p.used = null; p.pending = true; } break;
      case 'label': if (p) { p.label = op.label; p.pending = true; } break;
      case 'letter': if (p) { p.letter = op.letter || null; p.pending = true; } break;
      case 'active': if (p) { p.flags = { ...p.flags, active: op.value }; p.pending = true; } break;
      case 'hide': if (p) { p.flags = { ...p.flags, hidden: op.value }; p.pending = true; } break;
      case 'resize': if (p) {
        const end = p.start + p.size;
        const delta = op.size - p.size;
        p.size = op.size; p.pending = true;
        if (delta > 0) d.free = d.free.map((f) => (Math.abs(f.start - end) < MiB ? { start: f.start + delta, size: f.size - delta } : f)).filter((f) => f.size >= MiB);
        else d.free = mergeFree([...d.free, { start: end + delta, size: -delta }]);
        break;
      }
      default:
    }
    d.partitions.sort((a, b) => a.start - b.start);
  });
  return ds;
}
const shownDisks = () => (state.showNew && state.ops.length ? simulate(state.disks, state.ops) : state.disks);

// ---------------------------------------------------------------- navegación
const NAV = [
  ['home', 'Inicio', 'home'],
  ['disks', 'Discos y particiones', 'disk'],
  ['backups', 'Copias de seguridad', 'backup'],
  ['schedules', 'Tareas programadas', 'calendar'],
  ['clone', 'Copiar y migrar', 'copy'],
  ['wipe', 'Borrado seguro', 'eraser'],
  ['tools', 'Herramientas', 'tools'],
  '-',
  ['activity', 'Actividad', 'activity'],
  ['settings', 'Ajustes', 'settings'],
];
const TITLES = {
  home: ['Inicio', 'Resumen de tus discos y copias'],
  disks: ['Discos y particiones', 'Elige una partición o un espacio libre. Los cambios quedan pendientes hasta que pulses Aplicar.'],
  backups: ['Copias de seguridad', 'Imágenes de disco y copias de archivos, con incrementales, cifrado y verificación'],
  schedules: ['Tareas programadas', 'Copias automáticas con estrategia y retención'],
  clone: ['Copiar y migrar', 'Clona un disco o una partición a otro destino'],
  wipe: ['Borrado seguro', 'Destruye datos de forma irrecuperable con algoritmos estándar'],
  tools: ['Herramientas', 'Prueba de superficie, comprobación del sistema de archivos, TRIM y medios de arranque'],
  activity: ['Actividad', 'Operaciones en curso e historial'],
  settings: ['Ajustes', 'Preferencias de Maneja Discos'],
};

function renderNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...NAV.map((n) => (n === '-' ? h('div', { class: 'nav-sep' })
    : h('button', { class: `nav-item ${state.view === n[0] ? 'active' : ''}`, 'data-nav': n[0], onClick: () => go(n[0]) },
      icon(n[2]), n[1], n[0] === 'activity' ? h('span', { class: 'badge', hidden: !state.running.size }, String(state.running.size)) : null))));
  const foot = document.getElementById('sidebar-foot');
  const i = state.info;
  foot.replaceChildren(
    h('div', { class: 'admin' }, h('span', { class: `dot ${i.admin ? 'ok' : 'warn'}` }), i.admin ? 'Con permisos de administrador' : 'Se pedirán permisos al aplicar'),
    h('div', { class: 'faint', style: { marginTop: '4px' } }, `v${i.version} · ${{ win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[i.platform] || i.platform} ${i.arch}`));
}

function go(view) {
  state.view = view;
  renderNav();
  refreshView();
}

async function refreshView() {
  const [title, sub] = TITLES[state.view];
  document.getElementById('view-title').textContent = title;
  document.getElementById('view-sub').textContent = sub;
  const actions = document.getElementById('topbar-actions');
  actions.replaceChildren();
  const content = document.getElementById('content');
  const views = { home: viewHome, disks: viewDisks, backups: viewBackups, schedules: viewSchedules, clone: viewClone, wipe: viewWipe, tools: viewTools, activity: viewActivity, settings: viewSettings };
  try {
    const node = await views[state.view](actions);
    content.replaceChildren(node);
  } catch (err) {
    content.replaceChildren(h('div', { class: 'notice danger' }, `Error: ${err.message}`));
  }
  renderPending();
}

async function loadDisks(force) {
  if (state.loadingDisks) return;
  state.loadingDisks = true;
  try {
    const r = await md.disks.list();
    state.disks = r.disks || [];
    state.disksError = r.error || null;
  } finally {
    state.loadingDisks = false;
  }
  if (force && ['disks', 'home', 'clone', 'wipe', 'tools'].includes(state.view)) refreshView();
}

const refreshBtn = (fn) => h('button', { class: 'btn', onClick: fn }, icon('refresh'), 'Actualizar');

// ---------------------------------------------------------------- Inicio
async function viewHome(actions) {
  actions.append(refreshBtn(async () => { await loadDisks(); refreshView(); }));
  const [sets, schedules, activity] = await Promise.all([md.sets.list(), md.schedules.list(), md.activity.list()]);
  state.sets = sets; state.schedules = schedules;
  const total = state.disks.reduce((a, d) => a + d.size, 0);
  const points = sets.flatMap((s) => s.points || []);
  const last = points.map((p) => p.created).sort().pop();
  const active = schedules.filter((s) => s.enabled);
  const next = active.map((s) => s.nextRun).filter(Boolean).sort((a, b) => a - b)[0];
  const lastAct = activity.find((a) => a.status !== 'running');
  const quick = (ic, t, d, view) => h('div', { class: 'card quick', onClick: () => go(view) }, h('div', { class: 'ico' }, icon(ic)), h('div', {}, h('h3', {}, t), h('p', {}, d)));
  const tools = state.info.missingTools || [];
  return h('div', { class: 'stack' },
    tools.length ? h('div', { class: 'notice' }, h('b', {}, 'Faltan herramientas del sistema: '), tools.join(', '), '. Instálalas con: ', h('code', {}, `sudo apt install parted fdisk gdisk dosfstools ntfs-3g exfatprogs policykit-1`)) : null,
    state.disksError ? h('div', { class: 'notice danger' }, `No se pudieron leer los discos: ${state.disksError} `, h('button', { class: 'btn small', onClick: readElevated }, 'Leer como administrador')) : null,
    h('div', { class: 'grid cols-4' },
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Discos'), h('div', { class: 'value' }, state.disks.length), h('div', { class: 'hint' }, `${fmtBytes(total)} en total`)),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Última copia'), h('div', { class: 'value', style: { fontSize: '17px', marginTop: '9px' } }, last ? fmtDate(last) : 'Ninguna'), h('div', { class: 'hint' }, `${sets.length} juegos · ${points.length} puntos de restauración`)),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Próxima tarea'), h('div', { class: 'value', style: { fontSize: '17px', marginTop: '9px' } }, next ? fmtDate(next) : 'Sin programar'), h('div', { class: 'hint' }, `${active.length} tareas activas`)),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Última actividad'), h('div', { class: 'value', style: { fontSize: '17px', marginTop: '9px' } }, lastAct ? lastAct.title : '—'),
        h('div', { class: 'hint' }, lastAct ? h('span', { class: `pill ${lastAct.status === 'ok' ? 'ok' : lastAct.status === 'error' ? 'danger' : ''}` }, { ok: 'Correcta', error: 'Con errores', cancelled: 'Cancelada' }[lastAct.status] || lastAct.status) : ''))),
    h('div', { class: 'grid cols-3' },
      quick('backup', 'Hacer una copia ahora', 'Imagen de un disco o partición, o de tus carpetas.', 'backups'),
      quick('restore', 'Restaurar', 'Recupera un disco, una partición o archivos sueltos.', 'backups'),
      quick('disk', 'Particionar', 'Crear, formatear, redimensionar o eliminar.', 'disks'),
      quick('copy', 'Clonar disco', 'Pasa todo a un disco nuevo o a un SSD.', 'clone'),
      quick('eraser', 'Borrado seguro', '11 algoritmos, espacio libre y archivos.', 'wipe'),
      quick('gauge', 'Revisar un disco', 'Prueba de superficie y comprobación.', 'tools')),
    h('div', { class: 'card' }, h('h2', {}, 'Tus discos'), state.disks.length ? state.disks.map((d) => miniDisk(d)) : h('div', { class: 'empty' }, 'No se encontraron discos.')));
}

function miniDisk(d) {
  return h('div', { style: { marginBottom: '12px' } },
    h('div', { class: 'row space' }, h('div', {}, h('b', {}, d.model), ' ', h('span', { class: 'muted' }, `· ${fmtBytes(d.size)} · ${d.partitionStyle === 'none' ? 'sin inicializar' : d.partitionStyle.toUpperCase()}`)), d.isSystem ? h('span', { class: 'pill primary' }, 'Sistema') : null),
    h('div', { class: 'bar', style: { height: '26px', marginTop: '6px' } }, segments(d, true)));
}

async function readElevated() {
  const r = await md.disks.listElevated();
  if (r.error) toast(r.error, 'error');
  else { state.disks = r.disks; state.disksError = null; refreshView(); }
}

// ---------------------------------------------------------------- Discos y particiones
function segments(d, mini = false) {
  const items = [...d.partitions.map((p) => ({ ...p, segType: 'part' })), ...d.free.map((f) => ({ ...f, segType: 'free' }))].sort((a, b) => a.start - b.start);
  if (!items.length) {
    return [h('div', {
      class: 'seg free', style: mini ? { flexGrow: '1', minWidth: '8px', padding: '0', borderRadius: '5px' } : { flexGrow: '1' },
      onClick: mini ? null : () => { state.sel = { diskId: d.id, type: 'disk' }; refreshView(); },
    }, mini ? null : h('div', { class: 't1' }, d.partitionStyle === 'none' ? 'Sin inicializar' : 'Sin particiones reconocidas'), mini ? null : h('div', { class: 't2' }, `${fmtBytes(d.size)} · usa "Inicializar" en Acciones del disco`))];
  }
  return items.map((it) => {
    const selected = !mini && state.sel && state.sel.diskId === d.id && state.sel.type === it.segType && Math.abs(state.sel.start - it.start) < MiB;
    const style = { flexGrow: String(Math.max(it.size, d.size * 0.02)), flexBasis: '0' };
    if (it.segType === 'part') style.backgroundColor = fsColor(it.fs);
    const used = it.segType === 'part' && it.used != null && it.size ? Math.min(100, (it.used / it.size) * 100) : null;
    return h('div', {
      class: `seg ${it.segType === 'free' ? 'free' : ''} ${selected ? 'selected' : ''} ${it.pending ? 'seg-pending' : ''}`,
      style: mini ? { ...style, minWidth: '8px', padding: '0', borderRadius: '5px' } : style,
      title: it.segType === 'free' ? `Espacio libre · ${fmtBytes(it.size)}` : `${it.label || it.id} · ${fsName(it.fs)} · ${fmtBytes(it.size)}`,
      onClick: mini ? null : () => { state.sel = { diskId: d.id, type: it.segType, start: it.start }; refreshView(); },
    },
    used != null && !mini ? h('div', { class: 'used', style: { width: `${used}%` } }) : null,
    mini ? null : h('div', { class: 't1' }, it.segType === 'free' ? 'Libre' : `${it.letter ? `${it.letter}: ` : ''}${it.label || fsName(it.fs)}`),
    mini ? null : h('div', { class: 't2' }, it.segType === 'free' ? fmtBytes(it.size) : `${fsName(it.fs)} · ${fmtBytes(it.size)}`));
  });
}

async function viewDisks(actions) {
  actions.append(...[
    state.ops.length ? h('div', { class: 'toggle-layout' },
      h('button', { class: state.showNew ? '' : 'on', onClick: () => { state.showNew = false; refreshView(); } }, 'Diseño actual'),
      h('button', { class: state.showNew ? 'on' : '', onClick: () => { state.showNew = true; refreshView(); } }, 'Diseño nuevo')) : null,
    refreshBtn(async () => { await loadDisks(); refreshView(); })].filter(Boolean));
  if (!state.disks.length) {
    return h('div', { class: 'card empty' }, state.disksError ? `No se pudieron leer los discos: ${state.disksError}` : 'No se encontraron discos.',
      h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onClick: readElevated }, 'Leer discos como administrador')));
  }
  const disks = shownDisks();
  const legend = new Set(disks.flatMap((d) => d.partitions.map((p) => p.fs || 'unknown')));
  return h('div', { class: 'disks-layout' },
    h('div', {},
      disks.map((d) => h('div', { class: `card disk ${state.sel && state.sel.diskId === d.id && state.sel.type === 'disk' ? 'selected-disk' : ''}` },
        h('div', { class: 'disk-head', style: { cursor: 'pointer' }, onClick: () => { state.sel = { diskId: d.id, type: 'disk' }; refreshView(); } },
          h('div', { class: 'ico' }, icon(d.ssd ? 'ssd' : 'disk')),
          h('div', {},
            h('div', { class: 'disk-title' }, d.model, ' ', h('span', { class: 'muted', style: { fontWeight: 400 } }, `(${d.name})`)),
            h('div', { class: 'disk-meta' }, h('span', {}, [fmtBytes(d.size), d.partitionStyle === 'none' ? 'Sin inicializar' : d.partitionStyle.toUpperCase(), d.bus].filter(Boolean).join(' · ')),
              d.ssd ? h('span', { class: 'pill' }, 'SSD') : null, d.removable ? h('span', { class: 'pill' }, 'Extraíble') : null,
              d.isSystem ? h('span', { class: 'pill primary' }, 'Sistema') : null, d.readOnly ? h('span', { class: 'pill warn' }, 'Solo lectura') : null)),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn ghost small', onClick: (e) => { e.stopPropagation(); state.sel = { diskId: d.id, type: 'disk' }; refreshView(); } }, 'Acciones del disco')),
        h('div', { class: 'bar' }, segments(d)))),
      h('div', { class: 'legend' }, [...legend].map((f) => h('span', {}, h('i', { style: { backgroundColor: fsColor(f === 'unknown' ? null : f) } }), f === 'unknown' ? 'Desconocido' : fsName(f))),
        h('span', {}, h('i', { style: { backgroundColor: 'var(--line)' } }), 'Espacio libre'), state.ops.length ? h('span', {}, h('i', { style: { outline: '2px dashed var(--accent)', backgroundColor: 'transparent' } }), 'Cambio pendiente') : null)),
    propsPanel(disks));
}

function propsPanel(disks) {
  const s = state.sel;
  const d = s && disks.find((x) => x.id === s.diskId);
  if (!d) return h('div', { class: 'card props' }, h('div', { class: 'empty' }, h('img', { src: 'assets/logo.png', width: 72 }), h('div', {}, 'Selecciona una partición, un espacio libre o un disco para ver sus propiedades y acciones.')));
  const realDisk = state.disks.find((x) => x.id === d.id);
  const act = (ic, label, fn, opts = {}) => h('button', { class: `action ${opts.danger ? 'danger' : ''}`, disabled: !!opts.disabled, title: opts.title || '', onClick: fn }, icon(ic), label);
  const isWin = state.info.platform === 'win32';
  const isMac = state.info.platform === 'darwin';

  if (s.type === 'disk') {
    return h('div', { class: 'card props' },
      h('h2', {}, d.model),
      h('dl', {}, h('dt', {}, 'Tamaño'), h('dd', {}, fmtBytes(d.size)), h('dt', {}, 'Tabla'), h('dd', {}, d.partitionStyle.toUpperCase()), h('dt', {}, 'Dispositivo'), h('dd', {}, d.path),
        h('dt', {}, 'Sector'), h('dd', {}, `${d.sectorSize} B`), h('dt', {}, 'Tipo'), h('dd', {}, [d.ssd ? 'SSD' : 'HDD', d.bus, d.removable ? 'extraíble' : ''].filter(Boolean).join(' · ')),
        d.serial ? [h('dt', {}, 'Serie'), h('dd', {}, d.serial)] : null),
      d.isSystem ? h('div', { class: 'notice info', style: { marginBottom: '12px' } }, 'Es el disco del sistema: algunas operaciones están bloqueadas mientras está en uso.') : null,
      h('div', { class: 'actions' },
        act('backup', 'Copia de seguridad del disco', () => backupWizard({ kind: 'image', source: { kind: 'disk', diskId: d.id } })),
        act('copy', 'Clonar el disco', () => { state.clonePreset = { source: { kind: 'disk', diskId: d.id } }; go('clone'); }),
        act('gauge', 'Prueba de superficie', () => { state.toolsPreset = { kind: 'disk', diskId: d.id }; go('tools'); }),
        h('div', { class: 'section-label' }, 'Tabla de particiones'),
        act('layers', 'Inicializar (nueva tabla GPT/MBR)…', () => opInit(realDisk), { danger: true, disabled: d.isSystem }),
        act('swap', d.partitionStyle === 'gpt' ? 'Convertir a MBR' : 'Convertir a GPT', () => queue({ kind: 'convert', diskId: d.id, style: d.partitionStyle === 'gpt' ? 'mbr' : 'gpt' }), { disabled: isMac || d.partitionStyle === 'none' }),
        act('eraser', 'Borrar el disco de forma segura', () => { state.wipePreset = { mode: 'region', target: { kind: 'disk', diskId: d.id } }; go('wipe'); }, { danger: true, disabled: d.isSystem })));
  }

  if (s.type === 'free') {
    const f = d.free.find((x) => Math.abs(x.start - s.start) < MiB);
    if (!f) return h('div', { class: 'card props' }, 'El espacio ya no existe.');
    return h('div', { class: 'card props' },
      h('h2', {}, 'Espacio sin asignar'),
      h('dl', {}, h('dt', {}, 'Tamaño'), h('dd', {}, fmtBytes(f.size)), h('dt', {}, 'Inicio'), h('dd', {}, `${(f.start / MiB).toFixed(0)} MiB`), h('dt', {}, 'Disco'), h('dd', {}, d.model)),
      h('div', { class: 'actions' }, act('plus', 'Crear partición…', () => opCreate(d, f))));
  }

  const p = d.partitions.find((x) => Math.abs(x.start - s.start) < MiB);
  if (!p) return h('div', { class: 'card props' }, 'La partición ya no existe.');
  const sys = p.flags && p.flags.system;
  const pend = p.pending && String(p.id).startsWith('nuevo');
  const realPart = realDisk && realDisk.partitions.find((x) => Math.abs(x.start - p.start) < MiB);
  const usedPct = p.used != null && p.size ? Math.round((p.used / p.size) * 100) : null;
  return h('div', { class: 'card props' },
    h('h2', {}, p.label || p.id),
    h('dl', {},
      h('dt', {}, 'Sistema'), h('dd', {}, fsName(p.fs)),
      h('dt', {}, 'Tamaño'), h('dd', {}, fmtBytes(p.size)),
      h('dt', {}, 'Usado'), h('dd', {}, p.used != null ? `${fmtBytes(p.used)} (${usedPct} %)` : '—'),
      h('dt', {}, isWin ? 'Letra' : 'Montaje'), h('dd', {}, isWin ? (p.letter ? `${p.letter}:` : '—') : (p.mountpoint || 'No montada')),
      h('dt', {}, 'Tipo'), h('dd', {}, p.type || '—'),
      h('dt', {}, 'Inicio'), h('dd', {}, `${(p.start / MiB).toFixed(0)} MiB`)),
    sys ? h('div', { class: 'notice info', style: { marginBottom: '12px' } }, 'Partición del sistema en uso: no se puede formatear, eliminar ni redimensionar desde aquí.') : null,
    pend ? h('div', { class: 'notice', style: { marginBottom: '12px' } }, 'Esta partición se creará al aplicar los cambios.') : null,
    h('div', { class: 'actions' },
      act('backup', 'Copia de seguridad…', () => backupWizard({ kind: 'image', source: { kind: 'partition', diskId: d.id, partStart: p.start } }), { disabled: pend }),
      p.mountpoint && !pend ? act('folder', 'Abrir', () => md.shell.open(p.mountpoint)) : null,
      h('div', { class: 'section-label' }, 'Partición'),
      act('brush', 'Formatear…', () => opFormat(d, realPart || p), { disabled: sys || pend }),
      act('tag', 'Cambiar etiqueta…', () => opLabel(d, realPart || p), { disabled: pend || !p.fs }),
      act('resize', 'Redimensionar…', () => opResize(d, realPart || p), { disabled: sys || pend }),
      isWin ? act('hash', 'Cambiar letra de unidad…', () => opLetter(d, realPart || p), { disabled: pend }) : null,
      d.partitionStyle === 'mbr' && !isMac ? act('star', p.flags?.active ? 'Desmarcar como activa' : 'Marcar como activa', () => queue({ kind: 'active', diskId: d.id, partition: realPart, value: !p.flags?.active }), { disabled: pend }) : null,
      d.partitionStyle === 'mbr' && !isMac ? act('eyeoff', p.flags?.hidden ? 'Mostrar partición' : 'Ocultar partición', () => queue({ kind: 'hide', diskId: d.id, partition: realPart, value: !p.flags?.hidden }), { disabled: pend || sys }) : null,
      act('trash', 'Eliminar partición', () => opDelete(d, realPart), { danger: true, disabled: sys || pend }),
      h('div', { class: 'section-label' }, 'Mantenimiento'),
      act('shield', 'Comprobar sistema de archivos', () => fsCheck(d, p, false), { disabled: pend || !p.fs }),
      act('copy', 'Copiar partición…', () => { state.clonePreset = { source: { kind: 'partition', diskId: d.id, partStart: p.start } }; go('clone'); }, { disabled: pend }),
      act('eraser', 'Borrar de forma segura…', () => { state.wipePreset = { mode: 'region', target: { kind: 'partition', diskId: d.id, partStart: p.start } }; go('wipe'); }, { danger: true, disabled: sys || pend }),
      p.mountpoint && !pend ? act('eraser', 'Borrar el espacio libre…', () => { state.wipePreset = { mode: 'free', mountpoint: p.mountpoint }; go('wipe'); }) : null));
}

async function queue(op) {
  const disk = shownDisks().find((x) => x.id === op.diskId);
  const v = await md.ops.validate(op, disk);
  if (!v.ok) { toast(v.error, 'error'); return false; }
  state.ops.push(op);
  state.redo = [];
  state.showNew = true;
  toast(`Pendiente: ${await md.ops.describe(op)}`);
  refreshView();
  return true;
}

function fsOptions() { return state.info.fileSystems.map((f) => [f, fsName(f)]); }

function opCreate(d, f) {
  const data = { size: Math.floor(f.size / MiB), fs: state.info.fileSystems[0], label: '', letter: '' };
  const sizeIn = h('input', { type: 'number', min: 1, max: Math.floor(f.size / MiB), value: data.size, onInput: (e) => { data.size = Number(e.target.value); range.value = data.size; } });
  const range = h('input', { type: 'range', min: 1, max: Math.floor(f.size / MiB), value: data.size, onInput: (e) => { data.size = Number(e.target.value); sizeIn.value = data.size; } });
  modal({
    title: 'Crear partición',
    body: h('div', {},
      field('Tamaño (MB)', h('div', { class: 'stack' }, range, sizeIn), `Disponible: ${fmtBytes(f.size)}`),
      h('div', { class: 'two' },
        field('Sistema de archivos', select(data.fs, [...fsOptions(), ['none', 'Sin formato']], (v) => { data.fs = v; })),
        field('Etiqueta', h('input', { type: 'text', placeholder: 'Datos', onInput: (e) => { data.label = e.target.value; } }))),
      state.info.platform === 'win32' ? field('Letra de unidad', select('', [['', 'Automática'], ...'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => [l, `${l}:`])], (v) => { data.letter = v; })) : null),
    buttons: [{ label: 'Cancelar' }, { label: 'Añadir a pendientes', kind: 'primary', onClick: () => queue({ kind: 'create', diskId: d.id, start: f.start, size: Math.min(f.size, data.size * MiB), fs: data.fs, label: data.label, letter: data.letter || undefined }) }],
  });
}

function opFormat(d, p) {
  const data = { fs: state.info.fileSystems.includes(p.fs) ? p.fs : state.info.fileSystems[0], label: p.label || '', cluster: '' };
  modal({
    title: `Formatear ${p.label || p.id}`,
    body: h('div', {},
      h('div', { class: 'notice danger', style: { marginBottom: '14px' } }, 'Se borrarán todos los datos de esta partición.'),
      h('div', { class: 'two' },
        field('Sistema de archivos', select(data.fs, fsOptions(), (v) => { data.fs = v; })),
        field('Etiqueta', h('input', { type: 'text', value: data.label, onInput: (e) => { data.label = e.target.value; } }))),
      field('Tamaño de clúster', select('', [['', 'Predeterminado'], ['4096', '4 KB'], ['8192', '8 KB'], ['16384', '16 KB'], ['32768', '32 KB'], ['65536', '64 KB']], (v) => { data.cluster = v; }))),
    buttons: [{ label: 'Cancelar' }, { label: 'Añadir a pendientes', kind: 'primary', onClick: () => queue({ kind: 'format', diskId: d.id, partition: p, fs: data.fs, label: data.label, cluster: data.cluster ? Number(data.cluster) : undefined }) }],
  });
}

function opLabel(d, p) {
  const input = h('input', { type: 'text', value: p.label || '' });
  modal({ title: 'Cambiar etiqueta', body: field('Nueva etiqueta', input), buttons: [{ label: 'Cancelar' }, { label: 'Añadir a pendientes', kind: 'primary', onClick: () => queue({ kind: 'label', diskId: d.id, partition: p, label: input.value.trim() }) }] });
}

function opLetter(d, p) {
  let letter = p.letter || '';
  modal({ title: 'Letra de unidad', body: field('Letra', select(letter, [['', '(ninguna)'], ...'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => [l, `${l}:`])], (v) => { letter = v; })), buttons: [{ label: 'Cancelar' }, { label: 'Añadir a pendientes', kind: 'primary', onClick: () => queue({ kind: 'letter', diskId: d.id, partition: p, letter }) }] });
}

function opResize(d, p) {
  const after = d.free.find((f) => Math.abs(f.start - (p.start + p.size)) < MiB);
  const max = Math.floor((p.size + (after ? after.size : 0)) / MiB);
  const min = Math.max(16, Math.ceil(((p.used || 0) + 64 * MiB) / MiB));
  let size = Math.floor(p.size / MiB);
  const out = h('b', {}, fmtBytes(size * MiB));
  modal({
    title: `Redimensionar ${p.label || p.id}`,
    body: h('div', {},
      field('Nuevo tamaño', h('input', { type: 'range', min, max, value: size, onInput: (e) => { size = Number(e.target.value); out.textContent = fmtBytes(size * MiB); } }), `Mínimo ${fmtBytes(min * MiB)} · máximo ${fmtBytes(max * MiB)} (se usa el espacio libre que sigue a la partición).`),
      h('div', {}, 'Tamaño: ', out),
      h('div', { class: 'notice', style: { marginTop: '12px' } }, 'Haz una copia de seguridad antes de redimensionar. Compatibles: Windows NTFS · Linux ext2/3/4 y NTFS · macOS APFS y Mac OS Plus.')),
    buttons: [{ label: 'Cancelar' }, { label: 'Añadir a pendientes', kind: 'primary', onClick: () => queue({ kind: 'resize', diskId: d.id, partition: p, size: size * MiB }) }],
  });
}

async function opDelete(d, p) {
  if (await confirmDanger({ title: 'Eliminar partición', text: `Se eliminará "${p.label || p.id}" (${fmtBytes(p.size)}) y todos sus datos cuando apliques los cambios.`, word: 'ELIMINAR', action: 'Añadir a pendientes' })) {
    queue({ kind: 'delete', diskId: d.id, partition: p });
  }
}

function opInit(d) {
  let style = 'gpt';
  modal({
    title: `Inicializar ${d.model}`,
    body: h('div', {},
      h('div', { class: 'notice danger', style: { marginBottom: '12px' } }, 'Se borrarán TODAS las particiones de este disco.'),
      field('Tabla de particiones', select(style, [['gpt', 'GPT (recomendada, discos de más de 2 TB, UEFI)'], ['mbr', 'MBR (equipos antiguos con BIOS)']], (v) => { style = v; }))),
    buttons: [{ label: 'Cancelar' }, { label: 'Añadir a pendientes', kind: 'danger', onClick: () => queue({ kind: 'init', diskId: d.id, style }) }],
  });
}

function renderPending() {
  const el = document.getElementById('pending');
  const content = document.getElementById('content');
  if (!state.ops.length || state.view !== 'disks') { el.hidden = true; content.classList.remove('with-pending'); return; }
  el.hidden = false;
  content.classList.add('with-pending');
  Promise.all(state.ops.map((o) => md.ops.describe(o))).then((descs) => {
    el.replaceChildren(
      h('div', { class: 'count' }, String(state.ops.length)),
      h('div', { class: 'list' }, descs.map((t, i) => h('div', {}, `${i + 1}. ${t}`))),
      h('button', { class: 'btn ghost small', title: 'Deshacer', onClick: () => { state.redo.push(state.ops.pop()); refreshView(); } }, icon('undo')),
      h('button', { class: 'btn ghost small', title: 'Rehacer', disabled: !state.redo.length, onClick: () => { state.ops.push(state.redo.pop()); refreshView(); } }, icon('redo')),
      h('button', { class: 'btn small', onClick: showScript }, icon('code'), 'Script'),
      h('button', { class: 'btn small', onClick: () => { state.ops = []; state.redo = []; refreshView(); } }, 'Descartar'),
      h('button', { class: 'btn primary', onClick: applyOps }, icon('check'), 'Aplicar'));
  });
}

async function showScript() {
  const text = await md.ops.script(state.ops, state.disks);
  const ext = state.info.platform === 'win32' ? 'ps1' : 'sh';
  modal({ title: 'Script de las operaciones pendientes', wide: true, body: h('pre', { class: 'script' }, text), buttons: [{ label: 'Cerrar' }, { label: `Guardar .${ext}`, kind: 'primary', onClick: () => md.file.saveText(`maneja-discos-operaciones.${ext}`, text) }] });
}

async function applyOps() {
  const descs = await Promise.all(state.ops.map((o) => md.ops.describe(o)));
  const ok = await confirmDanger({ title: `Aplicar ${state.ops.length} operación(es)`, text: h('div', {}, h('div', {}, 'Se ejecutará en este orden:'), h('ol', { style: { margin: '8px 0 0 18px', padding: 0 } }, descs.map((d) => h('li', {}, d))), h('div', { style: { marginTop: '8px' } }, 'Haz una copia de seguridad de los datos importantes antes de continuar.')), word: 'APLICAR', action: 'Aplicar' });
  if (!ok) return;
  const ops = state.ops;
  startJob({ type: 'apply-ops', ops }, { title: `Aplicar ${ops.length} operación(es)`, elevated: true, kind: 'partition' }, async () => {
    state.ops = []; state.redo = [];
    await loadDisks();
    refreshView();
  });
}

async function fsCheck(d, p, repair) {
  startJob({ type: 'fscheck', diskId: d.id, partStart: p.start, repair }, { title: `${repair ? 'Reparar' : 'Comprobar'} ${p.label || p.id}`, elevated: true, kind: 'check' }, (ev) => {
    const out = ev.result?.output || ev.error || '';
    modal({
      title: ev.ok ? 'Comprobación terminada' : 'Se encontraron problemas', wide: true,
      body: h('div', {}, h('div', { class: `notice ${ev.ok ? 'info' : 'danger'}`, style: { marginBottom: '10px' } }, ev.ok ? 'El sistema de archivos no tiene errores.' : 'El comprobador informó errores. Puedes intentar repararlos.'), h('div', { class: 'log' }, out.trim() || '(sin salida)')),
      buttons: [{ label: 'Cerrar' }, !ev.ok && !repair ? { label: 'Reparar', kind: 'primary', onClick: () => fsCheck(d, p, true) } : null].filter(Boolean),
    });
  });
}

// ---------------------------------------------------------------- selector de origen/destino
function targetChoices({ data, key, allowDisk = true, allowPart = true, filter = () => true, minSize = 0, excludeSystem = false, onChange = null }) {
  const cur = data[key];
  const items = [];
  for (const d of state.disks) {
    if (allowDisk && filter({ kind: 'disk', disk: d }) && d.size >= minSize && !(excludeSystem && d.isSystem)) items.push({ t: { kind: 'disk', diskId: d.id }, title: `${d.model}`, sub: `Disco completo · ${fmtBytes(d.size)}${d.isSystem ? ' · sistema' : ''}`, disk: d });
    if (allowPart) for (const p of d.partitions) {
      if (!filter({ kind: 'partition', disk: d, part: p }) || p.size < minSize || (excludeSystem && p.flags?.system)) continue;
      items.push({ t: { kind: 'partition', diskId: d.id, partStart: p.start }, title: `${p.letter ? `${p.letter}: ` : ''}${p.label || p.id}`, sub: `${fsName(p.fs)} · ${fmtBytes(p.size)} · ${d.model}`, disk: d, part: p });
    }
  }
  const same = (a, b) => a && b && a.kind === b.kind && a.diskId === b.diskId && (a.kind === 'disk' || Math.abs(a.partStart - b.partStart) < MiB);
  if (!items.length) return h('div', { class: 'empty' }, 'No hay destinos adecuados.');
  return h('div', { class: 'choice-grid' }, items.map((it) => choice(same(cur, it.t), it.title, it.sub, (e) => {
    data[key] = it.t;
    const btn = e.currentTarget;
    btn.parentElement.querySelectorAll('.choice').forEach((c) => c.classList.remove('on'));
    btn.classList.add('on');
    if (onChange) onChange(it.t);
  })));
}

function describeTarget(t) {
  if (!t) return '—';
  if (t.kind === 'file') return t.path;
  const d = state.disks.find((x) => x.id === t.diskId);
  if (!d) return t.diskId;
  if (t.kind === 'disk') return `${d.model} (disco completo, ${fmtBytes(d.size)})`;
  const p = d.partitions.find((x) => Math.abs(x.start - t.partStart) < MiB);
  return p ? `${p.label || p.id} (${fsName(p.fs)}, ${fmtBytes(p.size)}) en ${d.model}` : 'partición';
}
function sizeOfTarget(t) {
  const d = state.disks.find((x) => x.id === t?.diskId);
  if (!d) return null;
  if (t.kind === 'disk') return d.size;
  return d.partitions.find((x) => Math.abs(x.start - t.partStart) < MiB)?.size ?? null;
}

// ---------------------------------------------------------------- Copias de seguridad
async function viewBackups(actions) {
  actions.append(
    h('button', { class: 'btn', onClick: async () => { try { if (await md.sets.add()) refreshView(); } catch (e) { toast(e.message, 'error'); } } }, icon('folder'), 'Añadir copia existente'),
    h('button', { class: 'btn primary', onClick: () => backupWizard({}) }, icon('plus'), 'Nueva copia'));
  const sets = await md.sets.list();
  state.sets = sets;
  if (!sets.length) {
    return h('div', { class: 'card empty' }, h('img', { src: 'assets/logo.png', width: 80 }), h('h2', {}, 'Aún no tienes copias de seguridad'),
      h('p', {}, 'Crea una imagen de un disco o partición, o una copia de tus carpetas. Puedes cifrarla y programarla.'),
      h('button', { class: 'btn primary', onClick: () => backupWizard({}) }, icon('plus'), 'Crear la primera copia'));
  }
  return h('div', { class: 'stack' }, sets.map(setCard));
}

function setCard(s) {
  if (!s.available) {
    return h('div', { class: 'card' }, h('div', { class: 'row space' }, h('div', {}, h('b', {}, s.name), h('div', { class: 'muted' }, s.dir), h('div', { class: 'pill' }, 'No disponible (¿disco desconectado?)')),
      h('button', { class: 'btn small', onClick: async () => { await md.sets.forget(s.dir); refreshView(); } }, 'Quitar de la lista')));
  }
  const isImage = s.kind === 'image';
  const total = s.points.reduce((a, p) => a + (p.size || 0), 0);
  const depth = (p) => { let n = 0; let q = p; while (q && q.parent) { n++; q = s.points.find((x) => x.id === q.parent); } return n; };
  const pw = async () => (s.encrypted ? askPassword() : null);
  const newPoint = async (type) => {
    const password = await pw();
    if (s.encrypted && password == null) return;
    startJob({ type: isImage ? 'image-backup' : 'file-backup', setDir: s.dir, backupType: type, password }, { title: `${s.name}: copia ${TYPE_LABEL[type].toLowerCase()}`, elevated: isImage, kind: 'backup' });
  };
  return h('div', { class: 'card' },
    h('div', { class: 'row space' },
      h('div', { class: 'row' },
        h('div', { class: 'quick', style: { cursor: 'default' } }, h('div', { class: 'ico' }, icon(isImage ? 'disk' : 'folder'))),
        h('div', {},
          h('div', { style: { fontWeight: 700, fontSize: '15px' } }, s.name, ' ', s.encrypted ? h('span', { class: 'pill primary' }, icon('lock'), 'Cifrada') : null),
          h('div', { class: 'muted' }, isImage ? `Imagen de ${s.source?.label || s.source?.model || 'disco'} · ${fmtBytes(s.source?.length)}` : `Archivos de ${(s.sources || []).map((x) => x.name).join(', ')}`, ` · ${s.points.length} puntos · ${fmtBytes(total)} en disco`),
          h('div', { class: 'faint', style: { fontSize: '12px' } }, s.dir))),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onClick: () => newPoint('incremental') }, 'Incremental'),
        h('button', { class: 'btn small', onClick: () => newPoint('differential') }, 'Diferencial'),
        h('button', { class: 'btn small', onClick: () => newPoint('full') }, 'Completa'),
        h('button', { class: 'btn ghost small', title: 'Abrir carpeta', onClick: () => md.shell.open(s.dir) }, icon('folder')),
        h('button', { class: 'btn ghost small', title: 'Eliminar', onClick: async () => {
          if (await confirmDanger({ title: `Eliminar "${s.name}"`, text: 'Se borrarán del disco todos los puntos de restauración de esta copia.', word: 'ELIMINAR', action: 'Eliminar' })) { await md.sets.deleteAll(s.dir); refreshView(); }
        } }, icon('trash')))),
    h('div', { class: 'points' }, [...s.points].reverse().map((p) => h('div', { class: 'point' },
      h('span', { class: `st ${p.status}`, title: p.status }),
      h('div', {}, h('span', { class: 'chain-line' }, '└ '.repeat(Math.min(depth(p), 1)), ''), h('b', {}, TYPE_LABEL[p.type]), ' · ', fmtDate(p.created), p.pinned ? h('span', { class: 'pill primary', style: { marginLeft: '6px' } }, 'Fijada') : null, p.verified ? h('span', { class: 'pill ok', style: { marginLeft: '6px' } }, 'Verificada') : null),
      h('div', { class: 'muted' }, isImage ? `${p.blocksChanged ?? '—'} bloques` : `${p.files ?? '—'} archivos (${p.filesStored ?? '—'} guardados)`),
      h('div', { class: 'muted' }, fmtBytes(p.size)),
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', disabled: p.status !== 'ok', onClick: () => restoreWizard(s, p) }, icon('restore'), 'Restaurar'),
        h('button', { class: 'btn ghost small', title: 'Verificar', disabled: p.status === 'missing' || p.status === 'running', onClick: async () => {
          const password = await pw(); if (s.encrypted && password == null) return;
          startJob({ type: isImage ? 'image-verify' : 'file-verify', setDir: s.dir, pointId: p.id, password }, { title: `Verificar ${s.name}`, kind: 'verify' });
        } }, icon('shield')),
        h('button', { class: 'btn ghost small', title: p.pinned ? 'Desfijar' : 'Fijar (no la borra la retención)', onClick: async () => { await md.sets.pin(s.dir, p.id, !p.pinned); refreshView(); } }, icon('pin')),
        h('button', { class: 'btn ghost small', title: 'Eliminar este punto y los que dependen de él', onClick: async () => {
          if (await confirmDanger({ title: 'Eliminar punto de restauración', text: 'También se eliminarán los incrementales/diferenciales que dependen de él.', word: 'ELIMINAR', action: 'Eliminar' })) { await md.sets.deletePoint(s.dir, p.id); refreshView(); }
        } }, icon('trash')))))));
}

function backupWizard(preset) {
  const st = state.settings;
  const data = {
    kind: preset.kind || 'image', source: preset.source || null, sources: [], exclude: 'Thumbs.db\n.DS_Store\n*.tmp\nnode_modules',
    destDir: st.backupDir, name: '', level: st.compression ?? 3, split: st.splitSizeMB || 0, password: '', password2: '', verify: st.verifyAfterBackup !== false,
    schedule: false, strategy: 'daily', freq: 'daily', time: '02:00', weekday: 1, day: 1, everyHours: 6, keepChains: 2,
  };
  const steps = [
    {
      title: 'Qué copiar',
      render: (dt, redraw) => h('div', {},
        h('div', { class: 'choice-grid', style: { marginBottom: '16px' } },
          choice(dt.kind === 'image', 'Disco o partición (imagen)', 'Copia sector a sector, restaurable completa. Requiere permisos de administrador.', () => { dt.kind = 'image'; redraw(); }),
          choice(dt.kind === 'files', 'Archivos y carpetas', 'Copia tus documentos con incrementales y exclusiones.', () => { dt.kind = 'files'; redraw(); })),
        dt.kind === 'image'
          ? h('div', {}, h('div', { class: 'label', style: { marginBottom: '8px' } }, 'Origen'), targetChoices({ data: dt, key: 'source' }),
            h('div', { class: 'notice info', style: { marginTop: '12px' } }, 'Consejo: para una imagen coherente del disco del sistema, usa una copia de archivos o arranca desde un medio externo. Los bloques vacíos no ocupan espacio.'))
          : h('div', {},
            h('div', { class: 'row', style: { marginBottom: '8px' } },
              h('button', { class: 'btn small', onClick: async () => { dt.sources.push(...(await md.dialog.openPaths('Carpetas a copiar', true))); redraw(); } }, icon('folder'), 'Añadir carpetas'),
              h('button', { class: 'btn small', onClick: async () => { dt.sources.push(...(await md.dialog.openPaths('Archivos a copiar', false))); redraw(); } }, icon('file'), 'Añadir archivos')),
            dt.sources.length ? h('div', { class: 'paths' }, dt.sources.map((p, i) => h('div', {}, h('span', {}, p), h('button', { class: 'btn ghost small', onClick: () => { dt.sources.splice(i, 1); redraw(); } }, icon('x'))))) : h('div', { class: 'muted' }, 'Ninguna carpeta seleccionada.'),
            field('Excluir (una máscara por línea)', h('textarea', { rows: 4, value: dt.exclude, onInput: (e) => { dt.exclude = e.target.value; } }), 'Ejemplos: *.tmp · cache · **/node_modules'))),
      check: (dt) => (dt.kind === 'image' ? (dt.source ? null : 'Elige el disco o la partición.') : (dt.sources.length ? null : 'Añade al menos una carpeta o archivo.')),
    },
    {
      title: 'Dónde guardar',
      render: (dt, redraw) => {
        if (!dt.name) dt.name = dt.kind === 'image' ? `Imagen ${describeTarget(dt.source).split(' (')[0]}` : `Archivos ${dt.sources.map((p) => p.split(/[\\/]/).pop()).join(', ')}`.slice(0, 60);
        return h('div', {},
          field('Carpeta de destino', h('div', { class: 'row' }, h('input', { type: 'text', value: dt.destDir, onInput: (e) => { dt.destDir = e.target.value; } }), h('button', { class: 'btn', onClick: async () => { const d = await md.dialog.openDir('Carpeta de destino'); if (d) { dt.destDir = d; redraw(); } } }, 'Elegir…')), 'Un disco externo, otra partición o una carpeta de red montada. No uses el mismo disco que copias.'),
          field('Nombre de la copia', h('input', { type: 'text', value: dt.name, onInput: (e) => { dt.name = e.target.value; } })));
      },
      check: (dt) => (!dt.destDir ? 'Elige la carpeta de destino.' : !dt.name.trim() ? 'Pon un nombre.' : null),
    },
    {
      title: 'Opciones',
      render: (dt) => h('div', {},
        h('div', { class: 'two' },
          field('Compresión', select(dt.level, [[1, 'Rápida'], [3, 'Normal'], [6, 'Alta'], [9, 'Máxima (lenta)']], (v) => { dt.level = Number(v); })),
          field('Dividir en archivos de', select(dt.split, [[0, 'Sin dividir'], [4095, '4 GB (para FAT32)'], [2048, '2 GB'], [700, '700 MB (CD)'], [4480, '4,7 GB (DVD)'], [25000, '25 GB (Blu-ray)']], (v) => { dt.split = Number(v); }))),
        h('div', { class: 'two' },
          field('Contraseña (opcional)', h('input', { type: 'password', value: dt.password, onInput: (e) => { dt.password = e.target.value; } }), 'Cifrado AES-256. Si la olvidas, no se puede recuperar.'),
          field('Repetir contraseña', h('input', { type: 'password', value: dt.password2, onInput: (e) => { dt.password2 = e.target.value; } }))),
        checkbox('Verificar la copia al terminar', dt.verify, (v) => { dt.verify = v; })),
      check: (dt) => (dt.password !== dt.password2 ? 'Las contraseñas no coinciden.' : null),
    },
    {
      title: 'Programación',
      render: (dt, redraw) => h('div', {},
        checkbox('Repetir esta copia automáticamente', dt.schedule, (v) => { dt.schedule = v; redraw(); }, 'Maneja Discos debe estar abierto (o en la bandeja) a la hora programada.'),
        dt.schedule ? h('div', {},
          field('Estrategia', select(dt.strategy, Object.entries(state.info.strategies).filter(([k]) => k !== 'custom').map(([k, v]) => [k, v.name]), (v) => { dt.strategy = v; dt.keepChains = state.info.strategies[v].keepChains; redraw(); })),
          h('div', { class: 'two' },
            field('Frecuencia', select(dt.freq, [['hourly', 'Cada N horas'], ['daily', 'Diaria'], ['weekly', 'Semanal'], ['monthly', 'Mensual']], (v) => { dt.freq = v; redraw(); })),
            dt.freq === 'hourly' ? field('Cada (horas)', h('input', { type: 'number', min: 1, max: 24, value: dt.everyHours, onInput: (e) => { dt.everyHours = Number(e.target.value); } }))
              : field('Hora', h('input', { type: 'time', value: dt.time, onInput: (e) => { dt.time = e.target.value; } }))),
          dt.freq === 'weekly' ? field('Día', select(dt.weekday, [[1, 'Lunes'], [2, 'Martes'], [3, 'Miércoles'], [4, 'Jueves'], [5, 'Viernes'], [6, 'Sábado'], [0, 'Domingo']], (v) => { dt.weekday = Number(v); })) : null,
          dt.freq === 'monthly' ? field('Día del mes', h('input', { type: 'number', min: 1, max: 28, value: dt.day, onInput: (e) => { dt.day = Number(e.target.value); } })) : null,
          field('Conservar', select(dt.keepChains, [[1, 'La última cadena'], [2, 'Las 2 últimas cadenas'], [3, 'Las 3 últimas'], [5, 'Las 5 últimas'], [10, 'Las 10 últimas']], (v) => { dt.keepChains = Number(v); }), 'Una cadena = una copia completa y sus incrementales/diferenciales. Las fijadas nunca se borran.')) : null),
    },
    {
      title: 'Resumen',
      render: (dt) => h('div', {},
        h('table', { class: 'table' },
          [['Tipo', dt.kind === 'image' ? 'Imagen de disco/partición' : 'Archivos y carpetas'],
            ['Origen', dt.kind === 'image' ? describeTarget(dt.source) : dt.sources.join(', ')],
            ['Destino', `${dt.destDir} / ${dt.name}`],
            ['Compresión', { 1: 'Rápida', 3: 'Normal', 6: 'Alta', 9: 'Máxima' }[dt.level]],
            ['Cifrado', dt.password ? 'Sí (AES-256)' : 'No'],
            ['División', dt.split ? `${dt.split} MB` : 'No'],
            ['Programación', dt.schedule ? `${state.info.strategies[dt.strategy].name} · ${{ hourly: `cada ${dt.everyHours} h`, daily: `cada día a las ${dt.time}`, weekly: 'semanal', monthly: `el día ${dt.day} de cada mes` }[dt.freq]}` : 'Solo ahora']].map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))),
        dt.kind === 'image' ? h('div', { class: 'notice info', style: { marginTop: '12px' } }, 'Se pedirán permisos de administrador para leer el disco.') : null),
    },
  ];
  wizard({
    title: 'Nueva copia de seguridad', steps, data, finishLabel: data.schedule ? 'Guardar e iniciar' : 'Iniciar copia',
    onFinish: async (dt) => {
      const isImage = dt.kind === 'image';
      const job = isImage
        ? { type: 'image-backup', source: dt.source, destDir: dt.destDir, name: dt.name, level: dt.level, splitSize: dt.split * MiB }
        : { type: 'file-backup', sources: dt.sources, exclude: dt.exclude.split('\n').map((x) => x.trim()).filter(Boolean), destDir: dt.destDir, name: dt.name, level: dt.level, splitSize: dt.split * MiB };
      const afterVerify = (ev) => {
        if (ev.ok && dt.verify && ev.result?.setDir) {
          startJob({ type: isImage ? 'image-verify' : 'file-verify', setDir: ev.result.setDir, password: dt.password || null }, { title: `Verificar ${dt.name}`, kind: 'verify' });
        }
      };
      if (dt.schedule) {
        const id = `sch-${Date.now().toString(36)}`;
        await md.schedules.save({ id, name: dt.name, kind: dt.kind, firstJob: job, strategy: dt.strategy, schedule: { freq: dt.freq, time: dt.time, weekday: dt.weekday, day: dt.day, everyHours: dt.everyHours }, keepChains: dt.keepChains, enabled: true }, dt.password || '');
        await md.schedules.runNow(id);
        toast('Tarea programada creada; la primera copia empezó ahora.', 'ok');
      } else {
        await startJob({ ...job, password: dt.password || null }, { title: `Copia: ${dt.name}`, elevated: isImage, kind: 'backup' }, afterVerify);
      }
      go('activity');
      return true;
    },
  });
}

async function restoreWizard(s, p) {
  let password = null;
  if (s.encrypted) { password = await askPassword(); if (password == null) return; }
  if (s.kind === 'files') return restoreFilesWizard(s, p, password);
  const length = s.source?.length;
  const data = { target: null, verify: true };
  const original = s.source?.target && state.disks.some((d) => d.id === s.source.target.diskId) ? s.source.target : null;
  wizard({
    title: `Restaurar ${s.name}`, data, finishLabel: 'Restaurar',
    steps: [
      {
        title: 'Destino',
        render: (dt, redraw) => h('div', {},
          h('div', { class: 'muted', style: { marginBottom: '10px' } }, `Punto: ${TYPE_LABEL[p.type]} del ${fmtDate(p.created)} · Tamaño necesario: ${fmtBytes(length)}`),
          h('div', { class: 'choice-grid', style: { marginBottom: '14px' } },
            original ? choice(dt.mode === 'original', 'Ubicación original', describeTarget(original), () => { dt.mode = 'original'; dt.target = original; redraw(); }) : null,
            choice(dt.mode === 'other', 'Otro disco o partición', 'Debe ser igual o mayor que el origen', () => { dt.mode = 'other'; dt.target = null; redraw(); }),
            choice(dt.mode === 'file', 'Exportar a archivo .img', 'Para montarlo o usarlo en una máquina virtual', async () => {
              const f = await md.dialog.saveFile('Exportar imagen', `${s.name}.img`, [{ name: 'Imagen de disco', extensions: ['img'] }]);
              if (f) { dt.mode = 'file'; dt.target = { kind: 'file', path: f }; redraw(); }
            })),
          dt.mode === 'other' ? targetChoices({ data: dt, key: 'target', minSize: length, excludeSystem: true }) : null,
          checkbox('Verificar el destino después de restaurar', dt.verify, (v) => { dt.verify = v; })),
        check: (dt) => (dt.target ? null : 'Elige el destino.'),
      },
    ],
    onFinish: async (dt) => {
      if (dt.target.kind !== 'file') {
        const ok = await confirmDanger({ title: 'Restaurar sobre un disco', text: `Se sobrescribirá por completo: ${describeTarget(dt.target)}.`, word: 'RESTAURAR', action: 'Restaurar' });
        if (!ok) return false;
      }
      await startJob({ type: 'image-restore', setDir: s.dir, pointId: p.id, password, target: dt.target, verify: dt.verify }, { title: `Restaurar ${s.name}`, elevated: dt.target.kind !== 'file', kind: 'restore' }, () => loadDisks(true));
      go('activity');
      return true;
    },
  });
}

async function restoreFilesWizard(s, p, password) {
  const list = await md.sets.files(s.dir, p.id);
  const data = { selection: new Set(), filter: '', destination: null, policy: 'keepBoth' };
  const roots = Object.fromEntries(list.roots.map((r) => [r.index, r]));
  const display = (key) => { const i = key.indexOf('/'); return `${roots[key.slice(0, i)]?.name || ''}/${key.slice(i + 1)}`; };
  wizard({
    title: `Restaurar archivos de ${s.name}`, data, finishLabel: 'Restaurar',
    steps: [
      {
        title: 'Archivos',
        render: (dt, redraw) => {
          const shown = list.files.filter((f) => !dt.filter || display(f.key).toLowerCase().includes(dt.filter.toLowerCase())).slice(0, 2000);
          const box = h('div', { class: 'filelist' }, shown.map((f) => h('label', {}, h('input', { type: 'checkbox', checked: dt.selection.has(f.key), onChange: (e) => { if (e.target.checked) dt.selection.add(f.key); else dt.selection.delete(f.key); count.textContent = label(); } }), h('span', {}, display(f.key)), h('span', { class: 'size' }, fmtBytes(f.size)))));
          const label = () => (dt.selection.size ? `${dt.selection.size} seleccionados` : `Todo (${list.files.length} archivos)`);
          const count = h('b', {}, label());
          const search = h('input', { type: 'text', placeholder: 'Buscar…', value: dt.filter, onInput: (e) => { dt.filter = e.target.value; clearTimeout(search.t); search.t = setTimeout(() => { redraw(); document.querySelector('.modal input[type=text]')?.focus(); }, 250); } });
          return h('div', {}, h('div', { class: 'row', style: { marginBottom: '8px' } }, search, h('button', { class: 'btn small', onClick: () => { shown.forEach((f) => dt.selection.add(f.key)); redraw(); } }, 'Marcar visibles'), h('button', { class: 'btn small', onClick: () => { dt.selection.clear(); redraw(); } }, 'Ninguno')),
            box, h('div', { class: 'muted', style: { marginTop: '8px' } }, count, ' · Si no marcas nada se restaura todo.', shown.length >= 2000 ? ' (se muestran 2000; usa la búsqueda)' : ''));
        },
      },
      {
        title: 'Destino',
        render: (dt, redraw) => h('div', {},
          h('div', { class: 'choice-grid', style: { marginBottom: '14px' } },
            choice(!dt.destination, 'Ubicación original', list.roots.map((r) => r.path).join(', '), () => { dt.destination = null; redraw(); }),
            choice(!!dt.destination, 'Otra carpeta', dt.destination || 'Elegir…', async () => { const d = await md.dialog.openDir('Restaurar en'); if (d) { dt.destination = d; redraw(); } })),
          field('Si el archivo ya existe', select(dt.policy, [['keepBoth', 'Conservar ambos (renombrar el restaurado)'], ['overwrite', 'Sobrescribir'], ['skip', 'Omitir']], (v) => { dt.policy = v; }))),
      },
    ],
    onFinish: async (dt) => {
      await startJob({ type: 'file-restore', setDir: s.dir, pointId: p.id, password, selection: [...dt.selection], destination: dt.destination, policy: dt.policy }, { title: `Restaurar archivos de ${s.name}`, kind: 'restore' });
      go('activity');
      return true;
    },
  });
}

// ---------------------------------------------------------------- Tareas programadas
async function viewSchedules(actions) {
  actions.append(h('button', { class: 'btn primary', onClick: () => backupWizard({}) }, icon('plus'), 'Nueva tarea'));
  const list = await md.schedules.list();
  state.schedules = list;
  if (!list.length) return h('div', { class: 'card empty' }, h('h2', {}, 'Sin tareas programadas'), h('p', {}, 'Al crear una copia, activa "Repetir automáticamente" en el paso Programación.'), h('button', { class: 'btn primary', onClick: () => backupWizard({}) }, 'Crear tarea'));
  const freqText = (s) => ({ hourly: `Cada ${s.schedule.everyHours || 1} h`, daily: `Diaria a las ${s.schedule.time}`, weekly: `Semanal (${['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'][s.schedule.weekday ?? 1]}) a las ${s.schedule.time}`, monthly: `Día ${s.schedule.day} de cada mes a las ${s.schedule.time}` }[s.schedule.freq]);
  return h('div', { class: 'card', style: { padding: 0 } }, list.map((s) => h('div', { class: 'list-item' },
    h('div', { class: 'quick', style: { cursor: 'default' } }, h('div', { class: 'ico' }, icon(s.kind === 'image' ? 'disk' : 'folder'))),
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, s.name, ' ', s.hasPassword ? h('span', { class: 'pill primary' }, 'Cifrada') : null),
      h('div', { class: 'sub' }, `${freqText(s)} · ${state.info.strategies[s.strategy]?.name || s.strategy} · conservar ${s.keepChains} cadena(s)`),
      h('div', { class: 'sub' }, 'Próxima: ', s.enabled ? fmtDate(s.nextRun) : 'desactivada', ' · Última: ', s.lastRun ? fmtDate(s.lastRun) : 'nunca', ' ', s.lastStatus ? h('span', { class: `pill ${s.lastStatus === 'ok' ? 'ok' : s.lastStatus === 'error' ? 'danger' : ''}` }, { ok: 'Correcta', error: 'Error', skipped: 'Omitida' }[s.lastStatus]) : null),
      s.lastError ? h('div', { class: 'sub', style: { color: 'var(--danger)' } }, s.lastError) : null),
    h('label', { class: 'check', style: { margin: 0 } }, h('input', { type: 'checkbox', checked: s.enabled, onChange: async (e) => { await md.schedules.save({ id: s.id, enabled: e.target.checked }); refreshView(); } }), 'Activa'),
    h('button', { class: 'btn small', onClick: async () => { await md.schedules.runNow(s.id); toast('Tarea iniciada'); } }, icon('play'), 'Ejecutar ahora'),
    h('button', { class: 'btn ghost small', title: 'Eliminar tarea', onClick: async () => { if (await confirmDanger({ title: 'Eliminar tarea', text: 'Las copias ya creadas no se borran.', word: 'ELIMINAR', action: 'Eliminar' })) { await md.schedules.remove(s.id); refreshView(); } } }, icon('trash')))));
}

// ---------------------------------------------------------------- Copiar y migrar
async function viewClone(actions) {
  actions.append(refreshBtn(async () => { await loadDisks(); refreshView(); }));
  const data = state.cloneData || (state.cloneData = { source: null, target: null, verify: true, ...(state.clonePreset || {}) });
  state.clonePreset = null;
  const srcSize = sizeOfTarget(data.source);
  const sameKind = (t) => !data.source || t.kind === data.source.kind;
  return h('div', { class: 'stack' },
    h('div', { class: 'card' }, h('h2', {}, '1. Origen'), h('p', { class: 'muted', style: { marginTop: 0 } }, 'Elige el disco o la partición que quieres copiar.'), targetChoices({ data, key: 'source', onChange: () => { data.target = null; refreshView(); } })),
    h('div', { class: 'card' }, h('h2', {}, '2. Destino'),
      h('p', { class: 'muted', style: { marginTop: 0 } }, srcSize ? `Debe medir al menos ${fmtBytes(srcSize)}. Todo su contenido se borrará.` : 'Primero elige el origen.'),
      data.source ? targetChoices({ data, key: 'target', minSize: srcSize || 0, excludeSystem: true, filter: (t) => sameKind(t) && !(t.disk.id === data.source.diskId && (t.kind === 'disk' || Math.abs(t.part.start - data.source.partStart) < MiB)) }) : null),
    h('div', { class: 'card' }, h('h2', {}, '3. Opciones'),
      checkbox('Verificar la copia al terminar', data.verify, (v) => { data.verify = v; }),
      h('div', { class: 'notice info', style: { marginBottom: '12px' } }, 'Para migrar el sistema a un SSD: clona el disco completo a uno igual o mayor, y arranca desde el nuevo. Si el destino es mayor, en Linux se amplía la tabla GPT automáticamente; luego amplía la última partición desde "Discos y particiones".'),
      h('button', { class: 'btn primary', onClick: async () => {
        if (!data.source || !data.target) { toast('Elige origen y destino.', 'error'); return; }
        const ok = await confirmDanger({ title: 'Clonar', text: `Se copiará ${describeTarget(data.source)} sobre ${describeTarget(data.target)}. Todo el contenido del destino se perderá.`, word: 'CLONAR', action: 'Clonar' });
        if (!ok) return;
        await startJob({ type: 'clone', source: data.source, target: data.target, verify: data.verify }, { title: 'Clonar disco', elevated: true, kind: 'clone' }, () => loadDisks(true));
        state.cloneData = null;
        go('activity');
      } }, icon('copy'), 'Clonar ahora')));
}

// ---------------------------------------------------------------- Borrado seguro
async function viewWipe(actions) {
  actions.append(refreshBtn(async () => { await loadDisks(); refreshView(); }));
  const data = state.wipeData || (state.wipeData = { mode: 'region', target: null, paths: [], mountpoint: null, algorithm: 'dod3', verify: 10, stamp: false, custom: { patterns: ['00', 'FF', 'random', ''], passesPerPattern: 1, groupRepeats: 1, finalRandom: false }, ...(state.wipePreset || {}) });
  state.wipePreset = null;
  const redraw = () => refreshView();
  const targetDisk = data.target && state.disks.find((d) => d.id === data.target.diskId);
  const mounted = state.disks.flatMap((d) => d.partitions.filter((p) => p.mountpoint).map((p) => ({ d, p })));
  const algos = state.info.algorithms;
  return h('div', { class: 'stack' },
    h('div', { class: 'card' }, h('h2', {}, '1. Qué borrar'),
      h('div', { class: 'choice-grid' },
        choice(data.mode === 'region', 'Disco o partición', 'Sobrescribe todo, incluida la tabla de particiones si es un disco', () => { data.mode = 'region'; redraw(); }),
        choice(data.mode === 'free', 'Solo el espacio libre', 'Elimina rastros de archivos borrados sin tocar los actuales', () => { data.mode = 'free'; redraw(); }),
        choice(data.mode === 'files', 'Archivos y carpetas', 'Tritura elementos concretos', () => { data.mode = 'files'; redraw(); })),
      h('div', { style: { marginTop: '14px' } },
        data.mode === 'region' ? targetChoices({ data, key: 'target', excludeSystem: true, onChange: () => refreshView() }) : null,
        data.mode === 'free' ? (mounted.length ? h('div', { class: 'choice-grid' }, mounted.map(({ d, p }) => choice(data.mountpoint === p.mountpoint, `${p.letter ? `${p.letter}: ` : ''}${p.label || p.mountpoint}`, `${fsName(p.fs)} · libre ${p.used != null ? fmtBytes(p.size - p.used) : '?'} · ${d.model}`, () => { data.mountpoint = p.mountpoint; redraw(); }))) : h('div', { class: 'muted' }, 'No hay volúmenes montados.')) : null,
        data.mode === 'files' ? h('div', {},
          h('div', { class: 'row', style: { marginBottom: '8px' } },
            h('button', { class: 'btn small', onClick: async () => { data.paths.push(...(await md.dialog.openPaths('Archivos a triturar', false))); redraw(); } }, icon('file'), 'Añadir archivos'),
            h('button', { class: 'btn small', onClick: async () => { data.paths.push(...(await md.dialog.openPaths('Carpetas a triturar', true))); redraw(); } }, icon('folder'), 'Añadir carpetas')),
          data.paths.length ? h('div', { class: 'paths' }, data.paths.map((p, i) => h('div', {}, h('span', {}, p), h('button', { class: 'btn ghost small', onClick: () => { data.paths.splice(i, 1); redraw(); } }, icon('x'))))) : h('div', { class: 'muted' }, 'Nada seleccionado.')) : null),
      targetDisk?.ssd && data.mode === 'region' ? h('div', { class: 'notice', style: { marginTop: '12px' } }, h('b', {}, 'Es un SSD. '), 'Sobrescribir un SSD varias veces lo desgasta y no garantiza borrar las celdas de reserva. Recomendado: una pasada (Relleno de ceros o Aleatorio) seguida de TRIM, o el borrado seguro del fabricante.') : null),
    h('div', { class: 'card' }, h('h2', {}, '2. Algoritmo'),
      h('div', { class: 'choice-grid' }, [...algos.map((a) => choice(data.algorithm === a.id, a.name, `${a.passes} pasada${a.passes > 1 ? 's' : ''}${a.note ? ` · ${a.note}` : ''}`, () => { data.algorithm = a.id; redraw(); })),
        choice(data.algorithm === 'custom', 'Algoritmo propio', 'Hasta 4 patrones hex (00–FF) o "random"', () => { data.algorithm = 'custom'; redraw(); })]),
      data.algorithm === 'custom' ? h('div', { style: { marginTop: '14px' } },
        h('div', { class: 'grid cols-4' }, data.custom.patterns.map((v, i) => field(`Patrón ${i + 1}`, h('input', { type: 'text', value: v, placeholder: i ? '(vacío)' : '00', onInput: (e) => { data.custom.patterns[i] = e.target.value.trim(); } })))),
        h('div', { class: 'two' },
          field('Pasadas por patrón', h('input', { type: 'number', min: 1, max: 10, value: data.custom.passesPerPattern, onInput: (e) => { data.custom.passesPerPattern = Number(e.target.value); } })),
          field('Repetir el grupo', h('input', { type: 'number', min: 1, max: 10, value: data.custom.groupRepeats, onInput: (e) => { data.custom.groupRepeats = Number(e.target.value); } }))),
        checkbox('Pasada final aleatoria', data.custom.finalRandom, (v) => { data.custom.finalRandom = v; })) : null),
    h('div', { class: 'card' }, h('h2', {}, '3. Opciones'),
      data.mode === 'region' ? field('Verificación del borrado', select(data.verify, [[0, 'No verificar'], [10, 'Comprobar el 10 % de los bloques'], [25, 'Comprobar el 25 %'], [100, 'Comprobar todo (lento)']], (v) => { data.verify = Number(v); })) : null,
      data.mode === 'region' && data.target?.kind === 'disk' ? checkbox('Escribir un sello de borrado en el primer sector', data.stamp, (v) => { data.stamp = v; }, 'Registra el algoritmo, la fecha y el número de serie.') : null,
      h('div', { class: 'muted', style: { marginBottom: '12px' } }, `Se guardará un informe en ${state.settings.reportsDir}.`),
      h('div', { class: 'row' },
        h('button', { class: 'btn danger', onClick: () => startWipe(data) }, icon('eraser'), 'Borrar de forma segura'),
        targetDisk?.ssd && data.mode === 'region' && state.info.platform !== 'darwin' ? h('button', { class: 'btn', onClick: async () => {
          const ok = await confirmDanger({ title: 'TRIM de todo el disco', text: `Se descartarán todos los bloques de ${describeTarget(data.target)}. Los datos dejarán de ser legibles.`, word: 'BORRAR', action: 'Ejecutar TRIM' });
          if (ok) startJob({ type: 'trim', diskId: data.target.diskId, partStart: data.target.kind === 'partition' ? data.target.partStart : null }, { title: 'TRIM', elevated: true, kind: 'trim' });
        } }, icon('ssd'), 'Usar TRIM') : null)));
}

async function startWipe(data) {
  const algorithm = data.algorithm === 'custom' ? { ...data.custom, patterns: data.custom.patterns.filter(Boolean) } : data.algorithm;
  let job; let what;
  if (data.mode === 'region') {
    if (!data.target) return toast('Elige qué borrar.', 'error');
    what = describeTarget(data.target);
    job = { type: 'wipe', mode: 'region', target: data.target, algorithm, verifyPercent: data.verify, stamp: data.stamp };
  } else if (data.mode === 'free') {
    if (!data.mountpoint) return toast('Elige un volumen.', 'error');
    what = `el espacio libre de ${data.mountpoint}`;
    job = { type: 'wipe', mode: 'free', mountpoint: data.mountpoint, algorithm };
  } else {
    if (!data.paths.length) return toast('Añade archivos o carpetas.', 'error');
    what = `${data.paths.length} elemento(s)`;
    job = { type: 'wipe', mode: 'files', paths: data.paths, algorithm };
  }
  const ok = await confirmDanger({ title: 'Borrado seguro', text: `Se destruirá ${what} de forma IRRECUPERABLE.`, word: 'BORRAR', action: 'Borrar' });
  if (!ok) return;
  await startJob(job, { title: `Borrado seguro: ${what}`, elevated: data.mode === 'region' || data.mode === 'free', kind: 'wipe' }, (ev) => {
    if (ev.ok && ev.result?.reportPath) {
      modal({ title: 'Borrado completado', body: h('div', {}, h('p', {}, ev.result.report?.verification ? (ev.result.report.verification.ok ? '✓ La verificación fue correcta.' : '⚠ La verificación encontró diferencias.') : 'Los datos se sobrescribieron.'), h('p', { class: 'muted' }, ev.result.reportPath)),
        buttons: [{ label: 'Cerrar' }, { label: 'Abrir informe', kind: 'primary', onClick: () => md.shell.open(ev.result.reportPath) }] });
    }
    loadDisks(true);
  });
  state.wipeData = null;
  go('activity');
}

// ---------------------------------------------------------------- Herramientas
async function viewTools(actions) {
  actions.append(refreshBtn(async () => { await loadDisks(); refreshView(); }));
  const t = state.toolsData || (state.toolsData = { surface: state.toolsPreset || null, check: null, iso: null, isoTarget: null });
  if (state.toolsPreset) { t.surface = state.toolsPreset; state.toolsPreset = null; }
  const lastSurface = [...state.surface.keys()].pop();
  return h('div', { class: 'grid cols-2' },
    h('div', { class: 'card' }, h('h2', {}, icon('gauge'), ' Prueba de superficie'),
      h('p', { class: 'muted' }, 'Lee todo el disco o partición y localiza sectores dañados o lentos. No modifica nada.'),
      targetChoices({ data: t, key: 'surface' }),
      h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn primary', onClick: () => {
        if (!t.surface) return toast('Elige un disco o partición.', 'error');
        startJob({ type: 'surface', target: t.surface }, { title: `Prueba de superficie: ${describeTarget(t.surface)}`, elevated: true, kind: 'surface' }, (ev) => {
          if (ev.ok) {
            const r = ev.result;
            modal({ title: r.ok ? 'Sin sectores dañados' : `${r.badSectors} sectores dañados`, body: h('div', {}, h('p', {}, `Zonas lentas: ${r.slowBlocks}.`), r.firstBad?.length ? h('p', { class: 'mono' }, `Primeros sectores dañados: ${r.firstBad.join(', ')}`) : null, surfaceGrid(r.cells)), buttons: [{ label: 'Cerrar' }] });
          }
        });
      } }, icon('play'), 'Iniciar prueba')),
      h('div', { id: 'surface-live', style: { marginTop: '14px' } }, lastSurface ? surfaceGrid(state.surface.get(lastSurface)) : null)),
    h('div', { class: 'card' }, h('h2', {}, icon('shield'), ' Comprobar sistema de archivos'),
      h('p', { class: 'muted' }, 'Busca errores (chkdsk, fsck, diskutil verify) y opcionalmente los repara. La partición se desmonta durante la comprobación.'),
      targetChoices({ data: t, key: 'check', allowDisk: false, filter: ({ part }) => !!part?.fs }),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('button', { class: 'btn', onClick: () => runCheck(t.check, false) }, 'Comprobar'),
        h('button', { class: 'btn primary', onClick: () => runCheck(t.check, true) }, 'Comprobar y reparar'))),
    h('div', { class: 'card' }, h('h2', {}, icon('usb'), ' Crear medio de arranque / grabar imagen'),
      h('p', { class: 'muted' }, 'Graba un archivo .iso o .img en una memoria USB (por ejemplo SystemRescue o un instalador). Útil para respaldar o restaurar el disco del sistema arrancando desde USB.'),
      h('div', { class: 'row', style: { marginBottom: '10px' } }, h('button', { class: 'btn small', onClick: async () => { const f = await md.dialog.openFile('Imagen a grabar', [{ name: 'Imágenes', extensions: ['iso', 'img', 'raw', 'bin'] }]); if (f) { t.iso = f; refreshView(); } } }, icon('file'), 'Elegir imagen…'), h('span', { class: 'muted' }, t.iso || 'Ninguna')),
      targetChoices({ data: t, key: 'isoTarget', allowPart: false, excludeSystem: true, filter: ({ disk }) => disk.removable || !disk.isSystem }),
      h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn danger', onClick: async () => {
        if (!t.iso || !t.isoTarget) return toast('Elige la imagen y la memoria USB.', 'error');
        if (!(await confirmDanger({ title: 'Grabar imagen', text: `Se borrará todo ${describeTarget(t.isoTarget)}.`, word: 'GRABAR', action: 'Grabar' }))) return;
        startJob({ type: 'write-image', imagePath: t.iso, target: t.isoTarget, verify: true }, { title: 'Grabar imagen en USB', elevated: true, kind: 'write' }, () => loadDisks(true));
        go('activity');
      } }, icon('usb'), 'Grabar'))),
    h('div', { class: 'card' }, h('h2', {}, icon('code'), ' Otras herramientas'),
      h('div', { class: 'actions' },
        h('button', { class: 'action', onClick: () => { if (!state.ops.length) toast('No hay operaciones pendientes. Añádelas en Discos y particiones.'); else showScript(); } }, icon('code'), 'Generar script de las operaciones pendientes'),
        h('button', { class: 'action', onClick: readElevated }, icon('lock'), 'Leer discos como administrador'),
        h('button', { class: 'action', onClick: () => { state.wipePreset = { mode: 'free' }; go('wipe'); } }, icon('eraser'), 'Borrar espacio libre de un volumen'),
        h('button', { class: 'action', onClick: () => go('clone') }, icon('copy'), 'Migrar el sistema a otro disco'))));
}

function runCheck(target, repair) {
  if (!target) return toast('Elige una partición.', 'error');
  const d = state.disks.find((x) => x.id === target.diskId);
  const p = d?.partitions.find((x) => Math.abs(x.start - target.partStart) < MiB);
  if (p) fsCheck(d, p, repair);
}

function surfaceGrid(cells) {
  if (!cells) return null;
  return h('div', {}, h('div', { class: 'surface' }, cells.map((c) => h('i', { class: c === 2 ? 'bad' : c === 1 ? 'slow' : 'ok' }))),
    h('div', { class: 'legend', style: { marginTop: '8px' } }, h('span', {}, h('i', { style: { backgroundColor: '#22c55e' } }), 'Correcto'), h('span', {}, h('i', { style: { backgroundColor: 'var(--accent)' } }), 'Lento'), h('span', {}, h('i', { style: { backgroundColor: 'var(--danger)' } }), 'Dañado')));
}
function drawSurface(id) {
  const el = document.getElementById('surface-live');
  if (el) el.replaceChildren(surfaceGrid(state.surface.get(id)));
}

// ---------------------------------------------------------------- Actividad
async function viewActivity(actions) {
  actions.append(h('button', { class: 'btn', onClick: async () => { await md.activity.clear(); refreshView(); } }, 'Limpiar historial'));
  const list = await md.activity.list();
  const running = h('div', { id: 'running-jobs', class: 'stack' });
  const node = h('div', { class: 'stack' },
    h('div', { class: 'card' }, h('h2', {}, 'En curso'), running),
    h('div', { class: 'card', style: { padding: 0 } },
      h('div', { style: { padding: '16px 18px 4px' } }, h('h2', { style: { margin: 0 } }, 'Historial')),
      list.filter((a) => !state.running.has(a.id)).length ? list.filter((a) => !state.running.has(a.id)).map(activityItem) : h('div', { class: 'empty' }, 'Sin actividad todavía.')));
  setTimeout(updateActivityRunning, 0);
  return node;
}

function updateActivityRunning() {
  const el = document.getElementById('running-jobs');
  if (!el) return;
  const items = [...state.running.values()];
  el.replaceChildren(...(items.length ? items.map((r) => h('div', {}, jobCard(r), r.log.length ? h('div', { class: 'log', style: { marginTop: '8px', maxHeight: '140px' } }, r.log.slice(-40).join('\n')) : null)) : [h('div', { class: 'muted' }, 'No hay operaciones en curso.')]));
}

function activityItem(a) {
  const details = h('div', { hidden: true, style: { marginTop: '8px' } }, a.error ? h('div', { class: 'notice danger', style: { marginBottom: '8px' } }, a.error) : null, h('div', { class: 'log' }, (a.log || []).join('\n') || '(sin registro)'));
  return h('div', { class: 'list-item', style: { display: 'block' } },
    h('div', { class: 'row' },
      h('span', { class: `pill ${a.status === 'ok' ? 'ok' : a.status === 'error' ? 'danger' : a.status === 'running' ? 'warn' : ''}` }, { ok: 'Correcta', error: 'Error', cancelled: 'Cancelada', running: 'Interrumpida' }[a.status] || a.status),
      h('div', { class: 'grow' }, h('div', { class: 'title' }, a.title), h('div', { class: 'sub' }, fmtDate(a.started), a.finished ? ` · ${fmtDur((Date.parse(a.finished) - Date.parse(a.started)) / 1000)}` : '', a.error ? ` · ${a.error.slice(0, 120)}` : '')),
      a.reportPath ? h('button', { class: 'btn small', onClick: () => md.shell.open(a.reportPath) }, 'Informe') : null,
      h('button', { class: 'btn ghost small', onClick: () => { details.hidden = !details.hidden; } }, 'Detalles')),
    details);
}

// ---------------------------------------------------------------- Ajustes
async function viewSettings() {
  const s = await md.settings.get();
  state.settings = s;
  const set = async (patch) => { state.settings = await md.settings.set(patch); if ('theme' in patch) applyTheme(); };
  const i = state.info;
  return h('div', { class: 'grid cols-2' },
    h('div', { class: 'card' }, h('h2', {}, 'Copias de seguridad'),
      field('Carpeta predeterminada', h('div', { class: 'row' }, h('input', { type: 'text', value: s.backupDir, onChange: (e) => set({ backupDir: e.target.value }) }), h('button', { class: 'btn', onClick: async () => { const d = await md.dialog.openDir('Carpeta de copias'); if (d) { await set({ backupDir: d }); refreshView(); } } }, 'Elegir…'))),
      h('div', { class: 'two' },
        field('Compresión', select(s.compression, [[1, 'Rápida'], [3, 'Normal'], [6, 'Alta'], [9, 'Máxima']], (v) => set({ compression: Number(v) }))),
        field('Dividir archivos', select(s.splitSizeMB, [[0, 'Sin dividir'], [4095, '4 GB (FAT32)'], [2048, '2 GB'], [700, '700 MB']], (v) => set({ splitSizeMB: Number(v) })))),
      checkbox('Verificar las copias al terminar', s.verifyAfterBackup, (v) => set({ verifyAfterBackup: v })),
      checkbox('Ejecutar tareas que no se hicieron porque el equipo estaba apagado', s.runMissed, (v) => set({ runMissed: v }))),
    h('div', { class: 'card' }, h('h2', {}, 'General'),
      field('Tema', select(s.theme, [['system', 'Igual que el sistema'], ['light', 'Claro'], ['dark', 'Oscuro']], (v) => set({ theme: v }))),
      checkbox('Al cerrar la ventana, seguir en la bandeja (necesario para tareas programadas)', s.minimizeToTray, (v) => set({ minimizeToTray: v })),
      i.platform !== 'linux' ? checkbox('Abrir al iniciar sesión', s.startAtLogin, (v) => set({ startAtLogin: v })) : null,
      checkbox('Pedir escribir una palabra para confirmar operaciones destructivas', s.confirmTyping !== false, (v) => set({ confirmTyping: v })),
      field('Carpeta de informes de borrado', h('div', { class: 'row' }, h('input', { type: 'text', value: s.reportsDir, onChange: (e) => set({ reportsDir: e.target.value }) }), h('button', { class: 'btn', onClick: () => md.shell.open(s.reportsDir) }, 'Abrir')))),
    h('div', { class: 'card' }, h('h2', {}, 'Acerca de'),
      h('div', { class: 'row', style: { alignItems: 'flex-start' } }, h('img', { src: 'assets/logo.png', width: 64 }),
        h('div', {}, h('b', {}, `Maneja Discos ${i.version}`),
          h('div', { class: 'muted' }, 'Copyright © 2026 Santiago Miguel · chago2850@gmail.com'),
          h('p', { class: 'muted', style: { fontSize: '12.5px', margin: '8px 0' } },
            'Este programa es software libre: puede redistribuirlo y/o modificarlo bajo los términos de la Licencia Pública General GNU, versión 3 o (a su elección) cualquier versión posterior. ',
            h('b', {}, 'Se distribuye SIN NINGUNA GARANTÍA.'), ' Consulte la licencia para más detalles.'),
          h('div', { class: 'row', style: { flexWrap: 'wrap' } },
            h('button', { class: 'btn small', onClick: () => showLegal('license') }, 'Ver licencia (GPL-3.0)'),
            h('button', { class: 'btn small', onClick: () => showLegal('thirdParty') }, 'Componentes de terceros'),
            h('button', { class: 'btn small', onClick: () => md.shell.external('https://github.com/chago2850-blip/Maneja-Discos') }, 'Código fuente'))))),
    h('div', { class: 'card' }, h('h2', {}, 'Sistema'),
      h('table', { class: 'table' },
        h('tr', {}, h('th', {}, 'Plataforma'), h('td', {}, `${i.platform} ${i.arch}`)),
        h('tr', {}, h('th', {}, 'Permisos'), h('td', {}, i.admin ? 'Administrador' : 'Usuario (se pedirá autorización para operaciones de disco)')),
        h('tr', {}, h('th', {}, 'Sistemas de archivos'), h('td', {}, i.fileSystems.map(fsName).join(', '))),
        i.platform === 'linux' ? h('tr', {}, h('th', {}, 'Herramientas que faltan'), h('td', {}, i.missingTools.length ? i.missingTools.join(', ') : 'Ninguna')) : null),
      i.platform === 'darwin' ? h('div', { class: 'notice info', style: { marginTop: '12px' } }, 'En macOS, para leer o escribir discos externos en crudo activa Maneja Discos en Ajustes del Sistema → Privacidad y seguridad → Acceso total al disco.') : null));
}

async function showLegal(which) {
  const legal = await md.legal();
  const text = legal[which] || 'Consulte https://www.gnu.org/licenses/gpl-3.0.html';
  modal({ title: which === 'license' ? 'Licencia Pública General GNU v3' : 'Componentes de terceros', wide: true,
    body: h('pre', { class: 'log', style: { maxHeight: '60vh', whiteSpace: 'pre-wrap' } }, text),
    buttons: [{ label: 'Cerrar' }, which === 'license' ? { label: 'Leer en gnu.org', onClick: () => md.shell.external('https://www.gnu.org/licenses/gpl-3.0.html') } : null].filter(Boolean) });
}

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ---------------------------------------------------------------- inicio
async function init() {
  state.info = await md.info();
  state.settings = await md.settings.get();
  applyTheme();
  md.job.onEvent(onJobEvent);
  md.schedules.onChange(() => { if (state.view === 'schedules' || state.view === 'home') refreshView(); });
  for (const r of await md.job.running()) state.running.set(r.id, { id: r.id, title: r.title, ev: r.last, log: r.log || [] });
  renderNav();
  renderDock();
  document.getElementById('content').replaceChildren(h('div', { class: 'empty' }, 'Leyendo discos…'));
  await loadDisks();
  refreshView();
  setInterval(() => { if (!state.running.size && !state.ops.length && ['home', 'disks'].includes(state.view) && !document.querySelector('.modal-backdrop')) loadDisks(true); }, 15000);
}

init().catch((err) => {
  document.getElementById('content').replaceChildren(h('div', { class: 'notice danger' }, `No se pudo iniciar: ${err.message}`));
});
