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
// Copias de imagen (sector a sector) de discos, particiones o archivos de imagen.
// Bloques de 4 MiB: los bloques vacíos no se guardan; los incrementales/diferenciales
// solo guardan los bloques cuyo hash cambió respecto a la cadena.
const fs = require('fs');
const path = require('path');
const raw = require('./rawio');
const C = require('./container');
const BS = require('./backupset');
const { Progress, newId, writeJSON, readJSON, CancelledError, MiB } = require('./util');

const DEFAULT_BLOCK = 4 * MiB;
const ZERO = 'z';

/**
 * Crea un punto de restauración.
 * opts: { setDir?, destDir?, name?, type, source:{path, offset, length, ...info}, password, level, splitSize, blockSize }
 */
async function backup(opts, emit, isCancelled = () => false) {
  let set;
  let key = null;
  if (opts.setDir) {
    set = BS.load(opts.setDir);
    key = C.unlock(set.encryption, opts.password);
  } else {
    const encryption = C.makeEncryption(opts.password);
    set = BS.create(opts.destDir, opts.name, 'image', {
      source: opts.source,
      blockSize: opts.blockSize || DEFAULT_BLOCK,
      compression: { algo: 'gzip', level: opts.level ?? 3 },
      splitSize: opts.splitSize || 0,
      encryption,
    });
    key = C.unlock(encryption, opts.password);
  }
  const type = set.points.length === 0 ? 'full' : (opts.type || 'full');
  const parent = type === 'full' ? null : BS.parentFor(set, type);
  if (type !== 'full' && !parent) throw new Error('No hay una copia completa válida para crear un incremental/diferencial.');
  const parentHashes = parent ? readJSON(path.join(set.dir, parent.dir, 'index.json'), null)?.hashes : null;
  if (type !== 'full' && !parentHashes) throw new Error('No se pudo leer el índice de la copia anterior.');

  const src = { ...set.source, ...(opts.sourceOverride || {}) };
  const length = src.length;
  const blockSize = set.blockSize;
  const blocks = Math.ceil(length / blockSize);
  const id = newId('p-');
  const point = { id, type, parent: parent ? parent.id : null, created: new Date().toISOString(), dir: id, status: 'running' };
  const pdir = path.join(set.dir, id);
  fs.mkdirSync(pdir, { recursive: true });
  BS.addPoint(set, point);

  const writer = new C.ChunkWriter(pdir, set.splitSize);
  const hashes = new Array(blocks);
  const entries = {};
  let changed = 0;
  const fd = raw.open(src.path, false);
  const buf = Buffer.alloc(blockSize);
  const prog = new Progress(length, emit, type === 'full' ? 'Copia completa' : type === 'incremental' ? 'Copia incremental' : 'Copia diferencial');
  emit({ type: 'log', message: `Origen: ${src.path} (desplazamiento ${src.offset || 0}, ${length} bytes) → ${set.dir}` });
  try {
    for (let i = 0; i < blocks; i++) {
      if (isCancelled()) throw new CancelledError();
      const len = Math.min(blockSize, length - i * blockSize);
      const n = raw.readAt(fd, buf, len, (src.offset || 0) + i * blockSize);
      if (n < len) throw new Error(`Lectura incompleta en el bloque ${i} (${n}/${len} bytes). ¿Cambió el tamaño del origen?`);
      const view = buf.subarray(0, len);
      const h = C.isZero(view) ? ZERO : C.hashBlock(view);
      hashes[i] = h;
      const prev = parentHashes ? parentHashes[i] : undefined;
      if (type === 'full' ? h !== ZERO : h !== prev) {
        entries[i] = h === ZERO ? [0, 0, 0] : writer.write(C.seal(view, key, set.compression.level));
        changed++;
      }
      prog.add(len, `${changed} bloques guardados`);
    }
  } catch (err) {
    writer.close();
    raw.close(fd);
    BS.removePoint(set, id);
    throw err;
  }
  writer.close();
  raw.close(fd);
  writeJSON(path.join(pdir, 'index.json'), { id, type, parent: point.parent, blockSize, length, blocks, hashes, entries });
  const done = BS.finalizePoint(set, id, { status: 'ok', blocksChanged: changed, sourceBytes: length, finished: new Date().toISOString() });
  prog.set(length, 'Completado', true);
  return { setDir: set.dir, point: done };
}

function loadChain(set, pointId) {
  return BS.chain(set, pointId).map((p) => ({ point: p, index: readJSON(path.join(set.dir, p.dir, 'index.json'), null), dir: path.join(set.dir, p.dir) }));
}

/** Para cada bloque, el registro más reciente de la cadena que lo contiene. */
function resolveBlocks(chainData) {
  const target = chainData[0].index;
  const readers = chainData.map((c) => new C.ChunkReader(c.dir));
  const plan = new Array(target.blocks);
  for (let i = 0; i < target.blocks; i++) {
    const h = target.hashes[i];
    if (h === ZERO) { plan[i] = { zero: true, hash: h }; continue; }
    let found = null;
    for (let k = 0; k < chainData.length; k++) {
      const e = chainData[k].index.entries[i];
      if (e && chainData[k].index.hashes[i] === h) { found = { reader: k, entry: e, hash: h }; break; }
    }
    if (!found) throw new Error(`El bloque ${i} no está en ninguna copia de la cadena.`);
    plan[i] = found;
  }
  return { plan, readers, target };
}

async function verify({ setDir, pointId, password }, emit, isCancelled = () => false) {
  const set = BS.load(setDir);
  const key = C.unlock(set.encryption, password);
  pointId = pointId || set.points[set.points.length - 1]?.id;
  const chainData = loadChain(set, pointId);
  const { plan, readers, target } = resolveBlocks(chainData);
  const prog = new Progress(target.length, emit, 'Verificando');
  const bad = [];
  try {
    for (let i = 0; i < plan.length; i++) {
      if (isCancelled()) throw new CancelledError();
      const len = Math.min(target.blockSize, target.length - i * target.blockSize);
      const p = plan[i];
      if (!p.zero) {
        try {
          const data = C.open(readers[p.reader].read(p.entry), key);
          if (data.length !== len || C.hashBlock(data) !== p.hash) bad.push(i);
        } catch (e) {
          bad.push(i);
        }
      }
      prog.add(len);
    }
  } finally {
    readers.forEach((r) => r.close());
  }
  const ok = bad.length === 0;
  const p = set.points.find((x) => x.id === pointId);
  p.verified = new Date().toISOString();
  p.status = ok ? 'ok' : 'corrupt';
  BS.save(set);
  emit({ type: 'log', message: ok ? 'La copia es correcta.' : `${bad.length} bloques dañados (primeros: ${bad.slice(0, 10).join(', ')})` });
  return { ok, badBlocks: bad.length };
}

/**
 * Restaura un punto en target {path, offset, length?}. Si path es un archivo nuevo se crea
 * (exportar a .img). El destino debe ser igual o mayor que el origen.
 */
async function restore({ setDir, pointId, password, target, verifyAfter }, emit, isCancelled = () => false) {
  const set = BS.load(setDir);
  const key = C.unlock(set.encryption, password);
  pointId = pointId || set.points[set.points.length - 1]?.id;
  const chainData = loadChain(set, pointId);
  const { plan, readers, target: idx } = resolveBlocks(chainData);
  if (target.length != null && target.length < idx.length) {
    throw new Error(`El destino (${target.length} bytes) es más pequeño que la copia (${idx.length} bytes).`);
  }
  const fd = raw.open(target.path, true);
  const zero = Buffer.alloc(idx.blockSize);
  const prog = new Progress(idx.length, emit, 'Restaurando');
  emit({ type: 'log', message: `Restaurando ${set.name} (${chainData.length} copia(s) en la cadena) → ${target.path}` });
  try {
    for (let i = 0; i < plan.length; i++) {
      if (isCancelled()) throw new CancelledError();
      const len = Math.min(idx.blockSize, idx.length - i * idx.blockSize);
      const p = plan[i];
      const data = p.zero ? zero.subarray(0, len) : C.open(readers[p.reader].read(p.entry), key);
      if (!p.zero && C.hashBlock(data) !== p.hash) throw new Error(`El bloque ${i} de la copia está dañado.`);
      raw.writeAt(fd, data, len, (target.offset || 0) + i * idx.blockSize);
      prog.add(len);
    }
    raw.fsync(fd);
  } finally {
    raw.close(fd);
    readers.forEach((r) => r.close());
  }
  prog.set(idx.length, 'Restaurado', true);
  let verified = null;
  if (verifyAfter) verified = await compareRegion(target, plan, idx, emit, isCancelled);
  return { ok: true, bytes: idx.length, verified };
}

async function compareRegion(target, plan, idx, emit, isCancelled) {
  const fd = raw.open(target.path, false);
  const buf = Buffer.alloc(idx.blockSize);
  const prog = new Progress(idx.length, emit, 'Comprobando el destino');
  try {
    for (let i = 0; i < plan.length; i++) {
      if (isCancelled()) throw new CancelledError();
      const len = Math.min(idx.blockSize, idx.length - i * idx.blockSize);
      raw.readAt(fd, buf, len, (target.offset || 0) + i * idx.blockSize);
      const view = buf.subarray(0, len);
      const h = C.isZero(view) ? ZERO : C.hashBlock(view);
      if (h !== plan[i].hash) return false;
      prog.add(len);
    }
  } finally {
    raw.close(fd);
  }
  return true;
}

/** Copia en crudo de una región a otra (clonar disco/partición, grabar ISO). */
async function copyRegion({ source, target, verifyAfter, blockSize = DEFAULT_BLOCK }, emit, isCancelled = () => false) {
  const length = source.length;
  if (target.length != null && target.length < length) throw new Error('El destino es más pequeño que el origen.');
  const sfd = raw.open(source.path, false);
  const tfd = raw.open(target.path, true);
  const buf = Buffer.alloc(blockSize);
  const hashes = verifyAfter ? [] : null;
  const prog = new Progress(length, emit, 'Copiando');
  try {
    for (let pos = 0; pos < length; pos += blockSize) {
      if (isCancelled()) throw new CancelledError();
      const len = Math.min(blockSize, length - pos);
      const n = raw.readAt(sfd, buf, len, (source.offset || 0) + pos);
      if (n < len) throw new Error(`Lectura incompleta en ${pos}`);
      raw.writeAt(tfd, buf, len, (target.offset || 0) + pos);
      if (hashes) hashes.push(C.hashBlock(buf.subarray(0, len)));
      prog.add(len);
    }
    raw.fsync(tfd);
  } finally {
    raw.close(sfd);
    raw.close(tfd);
  }
  let verified = null;
  if (hashes) {
    const fd = raw.open(target.path, false);
    const vprog = new Progress(length, emit, 'Verificando la copia');
    verified = true;
    try {
      for (let pos = 0, i = 0; pos < length; pos += blockSize, i++) {
        if (isCancelled()) throw new CancelledError();
        const len = Math.min(blockSize, length - pos);
        raw.readAt(fd, buf, len, (target.offset || 0) + pos);
        if (C.hashBlock(buf.subarray(0, len)) !== hashes[i]) { verified = false; break; }
        vprog.add(len);
      }
    } finally {
      raw.close(fd);
    }
  }
  return { ok: true, bytes: length, verified };
}

module.exports = { backup, verify, restore, copyRegion, DEFAULT_BLOCK };
