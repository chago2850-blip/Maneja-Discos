'use strict';
// Juegos de copias (set.json) y sus puntos de restauración: cadenas, retención, fijado, borrado.
const fs = require('fs');
const path = require('path');
const { readJSON, writeJSON, newId } = require('./util');
const { FORMAT, VERSION, dirSize } = require('./container');

function setFile(dir) { return path.join(dir, 'set.json'); }

function load(dir) {
  const s = readJSON(setFile(dir), null);
  if (!s || s.format !== FORMAT) throw new Error(`No es una copia de Maneja Discos: ${dir}`);
  s.dir = dir;
  for (const p of s.points) {
    const pdir = path.join(dir, p.dir);
    p.status = fs.existsSync(path.join(pdir, 'index.json')) ? (p.status === 'corrupt' ? 'corrupt' : 'ok') : 'missing';
  }
  return s;
}

function save(set) {
  const { dir, ...data } = set;
  writeJSON(setFile(dir), data);
}

function create(parentDir, name, kind, extra) {
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'Copia';
  let dir = path.join(parentDir, safe);
  let i = 2;
  while (fs.existsSync(dir)) dir = path.join(parentDir, `${safe} (${i++})`);
  fs.mkdirSync(dir, { recursive: true });
  const set = { format: FORMAT, version: VERSION, id: newId('set-'), name: safe, kind, created: new Date().toISOString(), points: [], ...extra, dir };
  save(set);
  return set;
}

/** Cadena de restauración de un punto: [punto, padre, …, completo]. */
function chain(set, pointId) {
  const byId = new Map(set.points.map((p) => [p.id, p]));
  const out = [];
  let p = byId.get(pointId);
  while (p) {
    out.push(p);
    p = p.parent ? byId.get(p.parent) : null;
  }
  if (!out.length) throw new Error('Punto de restauración no encontrado.');
  if (out[out.length - 1].type !== 'full') throw new Error('La cadena está incompleta: falta la copia completa base.');
  for (const q of out) if (q.status === 'missing') throw new Error(`Falta el punto ${q.created} de la cadena.`);
  return out;
}

/** Padre de un nuevo punto: incremental → último punto; diferencial → último completo. */
function parentFor(set, type) {
  const valid = set.points.filter((p) => p.status !== 'missing' && p.status !== 'corrupt');
  if (type === 'incremental') return valid[valid.length - 1] || null;
  if (type === 'differential') return [...valid].reverse().find((p) => p.type === 'full') || null;
  return null;
}

function addPoint(set, point) {
  set.points.push(point);
  save(set);
}

function finalizePoint(set, pointId, fields) {
  const p = set.points.find((x) => x.id === pointId);
  Object.assign(p, fields);
  p.size = dirSize(path.join(set.dir, p.dir));
  save(set);
  return p;
}

function descendants(set, pointId) {
  const out = new Set([pointId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of set.points) if (p.parent && out.has(p.parent) && !out.has(p.id)) { out.add(p.id); grew = true; }
  }
  return out;
}

function removePoint(set, pointId) {
  const ids = descendants(set, pointId);
  for (const p of set.points) {
    if (ids.has(p.id)) fs.rmSync(path.join(set.dir, p.dir), { recursive: true, force: true });
  }
  set.points = set.points.filter((p) => !ids.has(p.id));
  save(set);
  return [...ids];
}

function setPinned(set, pointId, pinned) {
  // Fijar un punto fija toda su cadena
  const ids = pinned ? new Set(chain(set, pointId).map((p) => p.id)) : new Set([pointId]);
  for (const p of set.points) if (ids.has(p.id)) p.pinned = pinned;
  save(set);
}

/**
 * Retención: conserva las últimas `keepChains` cadenas (completo + derivados) y/o
 * las de los últimos `keepDays` días. Las cadenas fijadas nunca se borran.
 */
function applyRetention(set, { keepChains, keepDays } = {}) {
  const fulls = set.points.filter((p) => p.type === 'full');
  const removed = [];
  const cutoff = keepDays ? Date.now() - keepDays * 86400000 : null;
  fulls.forEach((f, i) => {
    const fromEnd = fulls.length - i;
    const ids = descendants(set, f.id);
    const chainPoints = set.points.filter((p) => ids.has(p.id));
    if (chainPoints.some((p) => p.pinned)) return;
    const newest = Math.max(...chainPoints.map((p) => Date.parse(p.created)));
    const tooMany = keepChains && fromEnd > keepChains;
    const tooOld = cutoff && newest < cutoff;
    if (tooMany || tooOld) removed.push(...removePoint(set, f.id));
  });
  return removed;
}

module.exports = { load, save, create, chain, parentFor, addPoint, finalizePoint, removePoint, setPinned, applyRetention };
