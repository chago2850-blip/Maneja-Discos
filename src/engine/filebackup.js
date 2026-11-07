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
// Copias de archivos y carpetas: completas, incrementales y diferenciales, con exclusiones.
// Cada archivo se guarda en trozos de 4 MiB sellados (gzip + AES opcional).
const fs = require('fs');
const path = require('path');
const C = require('./container');
const BS = require('./backupset');
const { Progress, newId, writeJSON, readJSON, CancelledError, MiB } = require('./util');

const PIECE = 4 * MiB;

function globToRegex(glob) {
  const g = glob.trim().replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(^|/)${re}$`, 'i');
}

function makeExcluder(patterns = []) {
  const res = patterns.filter((p) => p && p.trim()).map(globToRegex);
  return (rel) => res.some((r) => r.test(rel));
}

/** Recorre los orígenes y devuelve la lista de archivos con su clave "<raíz>/<relativa>". */
function scan(sources, exclude, emit) {
  const isExcluded = makeExcluder(exclude);
  const files = [];
  const dirs = [];
  let skipped = 0;
  sources.forEach((src, rootIdx) => {
    const st = fs.lstatSync(src);
    if (st.isFile()) {
      files.push({ key: `${rootIdx}/${path.basename(src)}`, abs: src, size: st.size, mtime: st.mtimeMs, mode: st.mode });
      return;
    }
    const walk = (dir, rel) => {
      let list;
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { skipped++; emit({ type: 'log', message: `Omitido (sin acceso): ${dir}` }); return; }
      dirs.push(`${rootIdx}/${rel}`.replace(/\/$/, ''));
      for (const ent of list) {
        const r = rel ? `${rel}/${ent.name}` : ent.name;
        if (isExcluded(r)) continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(abs, r);
        else if (ent.isFile()) {
          try {
            const s = fs.statSync(abs);
            files.push({ key: `${rootIdx}/${r}`, abs, size: s.size, mtime: s.mtimeMs, mode: s.mode });
          } catch { skipped++; }
        }
      }
    };
    walk(src, '');
  });
  return { files, dirs, skipped };
}

async function backup(opts, emit, isCancelled = () => false) {
  let set;
  let key;
  if (opts.setDir) {
    set = BS.load(opts.setDir);
    key = C.unlock(set.encryption, opts.password);
  } else {
    const encryption = C.makeEncryption(opts.password);
    set = BS.create(opts.destDir, opts.name, 'files', {
      sources: opts.sources.map((p) => ({ path: path.resolve(p), name: path.basename(p) || p })),
      exclude: opts.exclude || [],
      compression: { algo: 'gzip', level: opts.level ?? 6 },
      splitSize: opts.splitSize || 0,
      encryption,
    });
    key = C.unlock(encryption, opts.password);
  }
  const type = set.points.length === 0 ? 'full' : (opts.type || 'incremental');
  const parent = type === 'full' ? null : BS.parentFor(set, type);
  const prevFiles = parent ? readJSON(path.join(set.dir, parent.dir, 'index.json'), {}).files || {} : {};

  emit({ type: 'log', message: 'Analizando archivos…' });
  const { files, dirs, skipped } = scan(set.sources.map((s) => s.path), set.exclude, emit);
  const total = files.reduce((a, f) => a + f.size, 0);
  const id = newId('p-');
  const point = { id, type, parent: parent ? parent.id : null, created: new Date().toISOString(), dir: id, status: 'running' };
  const pdir = path.join(set.dir, id);
  fs.mkdirSync(pdir, { recursive: true });
  BS.addPoint(set, point);

  const writer = new C.ChunkWriter(pdir, set.splitSize);
  const index = {};
  let stored = 0;
  let storedBytes = 0;
  const prog = new Progress(total, emit, type === 'full' ? 'Copia completa de archivos' : `Copia ${type === 'incremental' ? 'incremental' : 'diferencial'}`);
  const buf = Buffer.alloc(PIECE);
  try {
    for (const f of files) {
      if (isCancelled()) throw new CancelledError();
      const prev = prevFiles[f.key];
      if (prev && prev.size === f.size && Math.abs(prev.mtime - f.mtime) < 2) {
        index[f.key] = prev; // sin cambios: referencia al punto donde están los datos
        prog.add(f.size);
        continue;
      }
      let fd;
      try { fd = fs.openSync(f.abs, 'r'); } catch (e) { emit({ type: 'log', message: `Omitido (no se pudo abrir): ${f.abs}` }); prog.add(f.size); continue; }
      const pieces = [];
      try {
        let pos = 0;
        do {
          const n = fs.readSync(fd, buf, 0, PIECE, pos);
          if (n === 0 && pos > 0) break;
          pieces.push(writer.write(C.seal(buf.subarray(0, n), key, set.compression.level)));
          pos += n;
          prog.add(n);
          if (n < PIECE) break;
        } while (true);
      } finally {
        fs.closeSync(fd);
      }
      index[f.key] = { size: f.size, mtime: f.mtime, mode: f.mode, point: id, pieces };
      stored++;
      storedBytes += f.size;
    }
  } catch (err) {
    writer.close();
    BS.removePoint(set, id);
    throw err;
  }
  writer.close();
  writeJSON(path.join(pdir, 'index.json'), { id, type, parent: point.parent, files: index, dirs });
  const done = BS.finalizePoint(set, id, { status: 'ok', files: files.length, filesStored: stored, sourceBytes: total, storedSourceBytes: storedBytes, skipped, finished: new Date().toISOString() });
  prog.set(total, 'Completado', true);
  emit({ type: 'log', message: `${files.length} archivos (${stored} nuevos o modificados)${skipped ? `, ${skipped} omitidos` : ''}.` });
  return { setDir: set.dir, point: done };
}

/** Lista los archivos de un punto (para el selector de restauración). */
function listFiles({ setDir, pointId }) {
  const set = BS.load(setDir);
  const p = pointId ? set.points.find((x) => x.id === pointId) : set.points[set.points.length - 1];
  const idx = readJSON(path.join(set.dir, p.dir, 'index.json'), { files: {} });
  return {
    roots: set.sources.map((s, i) => ({ index: i, name: s.name, path: s.path })),
    files: Object.entries(idx.files).map(([k, v]) => ({ key: k, size: v.size, mtime: v.mtime })),
  };
}

function uniqueName(file) {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  let i = 1;
  let out;
  do { out = `${base} (restaurado${i > 1 ? ` ${i}` : ''})${ext}`; i++; } while (fs.existsSync(out));
  return out;
}

/**
 * Restaura archivos. selection: lista de prefijos de clave (vacía = todo).
 * destination: null = ubicación original; carpeta = <carpeta>/<nombre raíz>/<ruta>.
 * policy: overwrite | skip | keepBoth
 */
async function restore({ setDir, pointId, password, selection = [], destination = null, policy = 'keepBoth' }, emit, isCancelled = () => false) {
  const set = BS.load(setDir);
  const key = C.unlock(set.encryption, password);
  const p = pointId ? set.points.find((x) => x.id === pointId) : set.points[set.points.length - 1];
  const idx = readJSON(path.join(set.dir, p.dir, 'index.json'), null);
  if (!idx) throw new Error('No se pudo leer el índice de la copia.');
  const chosen = Object.entries(idx.files).filter(([k]) => !selection.length || selection.some((s) => k === s || k.startsWith(s.endsWith('/') ? s : `${s}/`)));
  const total = chosen.reduce((a, [, v]) => a + v.size, 0);
  const prog = new Progress(total, emit, 'Restaurando archivos');
  const readers = new Map();
  const reader = (pid) => {
    if (!readers.has(pid)) {
      const pt = set.points.find((x) => x.id === pid);
      if (!pt) throw new Error('Falta un punto de la cadena de copias.');
      readers.set(pid, new C.ChunkReader(path.join(set.dir, pt.dir)));
    }
    return readers.get(pid);
  };
  let restored = 0;
  let skippedCount = 0;
  try {
    for (const [k, v] of chosen) {
      if (isCancelled()) throw new CancelledError();
      const slash = k.indexOf('/');
      const root = set.sources[Number(k.slice(0, slash))];
      const rel = k.slice(slash + 1);
      const rootIsFile = !idx.dirs.includes(k.slice(0, slash));
      let out;
      if (rootIsFile) out = destination ? path.join(destination, rel) : root.path;
      else out = destination ? path.join(destination, root.name, rel) : path.join(root.path, rel);
      if (fs.existsSync(out)) {
        if (policy === 'skip') { skippedCount++; prog.add(v.size); continue; }
        if (policy === 'keepBoth') out = uniqueName(out);
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const fd = fs.openSync(out, 'w');
      try {
        for (const piece of v.pieces) {
          const data = C.open(reader(v.point).read(piece), key);
          let w = 0;
          while (w < data.length) w += fs.writeSync(fd, data, w, data.length - w);
          prog.add(data.length);
        }
      } finally {
        fs.closeSync(fd);
      }
      try { fs.utimesSync(out, new Date(), new Date(v.mtime)); fs.chmodSync(out, v.mode & 0o777); } catch { /* sin permisos para metadatos */ }
      restored++;
    }
  } finally {
    for (const r of readers.values()) r.close();
  }
  prog.set(total, 'Completado', true);
  emit({ type: 'log', message: `${restored} archivos restaurados${skippedCount ? `, ${skippedCount} omitidos (ya existían)` : ''}.` });
  return { ok: true, restored, skipped: skippedCount };
}

async function verify({ setDir, pointId, password }, emit, isCancelled = () => false) {
  const set = BS.load(setDir);
  const key = C.unlock(set.encryption, password);
  const p = pointId ? set.points.find((x) => x.id === pointId) : set.points[set.points.length - 1];
  const idx = readJSON(path.join(set.dir, p.dir, 'index.json'), { files: {} });
  const entries = Object.entries(idx.files);
  const total = entries.reduce((a, [, v]) => a + v.size, 0);
  const prog = new Progress(total, emit, 'Verificando');
  const readers = new Map();
  let bad = 0;
  try {
    for (const [k, v] of entries) {
      if (isCancelled()) throw new CancelledError();
      let size = 0;
      try {
        if (!readers.has(v.point)) readers.set(v.point, new C.ChunkReader(path.join(set.dir, set.points.find((x) => x.id === v.point).dir)));
        for (const piece of v.pieces) size += C.open(readers.get(v.point).read(piece), key).length;
        if (size !== v.size) throw new Error('tamaño');
      } catch {
        bad++;
        emit({ type: 'log', message: `Dañado: ${k}` });
      }
      prog.add(v.size);
    }
  } finally {
    for (const r of readers.values()) r.close();
  }
  p.verified = new Date().toISOString();
  p.status = bad ? 'corrupt' : 'ok';
  BS.save(set);
  return { ok: bad === 0, badFiles: bad };
}

module.exports = { backup, restore, verify, listFiles, scan, globToRegex };
