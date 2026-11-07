'use strict';
// Trabajos de copia programados: estrategia (completa/incremental/diferencial), horario y retención.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const jobs = require('./jobs');

/** Estrategias al estilo Paragon. fullEvery = cada cuántas ejecuciones se hace una completa. */
const STRATEGIES = {
  daily: { name: 'Diaria: 1 completa + 6 incrementales', fullEvery: 7, type: 'incremental', keepChains: 2 },
  differential: { name: 'Diaria: 1 completa + 6 diferenciales', fullEvery: 7, type: 'differential', keepChains: 2 },
  weekly: { name: 'Solo completas (conservar 3)', fullEvery: 1, type: 'full', keepChains: 3 },
  single: { name: 'Una sola copia (se reemplaza)', fullEvery: 1, type: 'full', keepChains: 1 },
  custom: { name: 'Personalizada', fullEvery: 7, type: 'incremental', keepChains: 2 },
};

function nextRun(s, from = Date.now()) {
  const sch = s.schedule || {};
  const [hh, mm] = String(sch.time || '02:00').split(':').map(Number);
  const base = new Date(from);
  if (sch.freq === 'hourly') {
    const every = Math.max(1, Number(sch.everyHours) || 1);
    const last = s.lastRun ? Date.parse(s.lastRun) : Date.parse(s.created || new Date().toISOString());
    return last + every * 3600000;
  }
  const d = new Date(base);
  d.setSeconds(0, 0);
  d.setHours(hh || 0, mm || 0);
  const ref = s.lastRun ? Date.parse(s.lastRun) : Date.parse(s.created || new Date(0).toISOString());
  const candidate = (date) => date.getTime() > ref;
  for (let i = 0; i < 62; i++) {
    const t = new Date(d);
    t.setDate(d.getDate() + i - 31);
    let ok = true;
    if (sch.freq === 'weekly') ok = t.getDay() === Number(sch.weekday ?? 1);
    if (sch.freq === 'monthly') ok = t.getDate() === Math.min(Number(sch.day || 1), 28);
    if (ok && candidate(t)) return t.getTime();
  }
  return null;
}

function typeForRun(s, set) {
  const strat = { ...STRATEGIES[s.strategy || 'daily'], ...(s.strategy === 'custom' ? s.custom : {}) };
  if (!set || !set.points.length) return 'full';
  const sinceFull = [...set.points].reverse().findIndex((p) => p.type === 'full');
  if (sinceFull === -1) return 'full';
  return sinceFull + 1 >= strat.fullEvery ? 'full' : strat.type;
}

let busy = new Set();
let timer = null;
let notify = () => {};

async function runSchedule(s, reason = 'programada') {
  if (busy.has(s.id)) return;
  busy.add(s.id);
  try {
    let set = null;
    try { set = s.setDir && fs.existsSync(path.join(s.setDir, 'set.json')) ? require('../engine/backupset').load(s.setDir) : null; } catch { set = null; }
    const type = typeForRun(s, set);
    const password = store.secrets.decrypt(s.passwordEnc);
    const isImage = s.kind === 'image';
    const job = set
      ? { type: isImage ? 'image-backup' : 'file-backup', setDir: s.setDir, backupType: type, password }
      : { ...s.firstJob, password };
    const ev = await jobs.runAndWait(job, { title: `${s.name} (${reason}, ${type === 'full' ? 'completa' : type === 'incremental' ? 'incremental' : 'diferencial'})`, elevated: isImage, kind: 'backup' });
    const patch = { lastRun: new Date().toISOString(), lastStatus: ev.ok ? 'ok' : 'error', lastError: ev.error || null };
    if (ev.ok && ev.result && ev.result.setDir) {
      patch.setDir = ev.result.setDir;
      store.sets.add(ev.result.setDir);
      const strat = { ...STRATEGIES[s.strategy || 'daily'], ...(s.strategy === 'custom' ? s.custom : {}) };
      await jobs.runAndWait({ type: 'retention', setDir: ev.result.setDir, retention: { keepChains: s.keepChains || strat.keepChains, keepDays: s.keepDays || null } }, { title: `Retención de ${s.name}`, elevated: isImage, kind: 'retention' });
    }
    store.schedules.save({ ...s, ...patch });
    notify(s, ev);
  } finally {
    busy.delete(s.id);
  }
}

function tick() {
  const now = Date.now();
  const settings = store.settings.get();
  for (const s of store.schedules.list()) {
    if (!s.enabled) continue;
    const next = nextRun(s);
    if (next == null) continue;
    const missed = now - next > 5 * 60000;
    if (now >= next && (!missed || settings.runMissed)) runSchedule(s, missed ? 'pendiente' : 'programada');
    else if (missed && !settings.runMissed) store.schedules.save({ ...s, lastRun: new Date().toISOString(), lastStatus: 'skipped' });
  }
}

function start(onNotify) {
  notify = onNotify || notify;
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 30000);
  setTimeout(tick, 5000);
}

module.exports = { STRATEGIES, nextRun, runSchedule, start, typeForRun };
