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
// Borrado seguro. Las pasadas "aleatorias" usan AES-256-CTR con una clave al azar: datos
// imposibles de distinguir de ruido, rápidos (AES-NI) y reproducibles para poder verificar.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const raw = require('./rawio');
const { Progress, CancelledError, MiB, newId } = require('./util');

const R = { random: true };
const pat = (...bytes) => ({ bytes });

const GUTMANN = [
  R, R, R, R,
  pat(0x55), pat(0xaa), pat(0x92, 0x49, 0x24), pat(0x49, 0x24, 0x92), pat(0x24, 0x92, 0x49),
  pat(0x00), pat(0x11), pat(0x22), pat(0x33), pat(0x44), pat(0x55), pat(0x66), pat(0x77),
  pat(0x88), pat(0x99), pat(0xaa), pat(0xbb), pat(0xcc), pat(0xdd), pat(0xee), pat(0xff),
  pat(0x92, 0x49, 0x24), pat(0x49, 0x24, 0x92), pat(0x24, 0x92, 0x49),
  pat(0x6d, 0xb6, 0xdb), pat(0xb6, 0xdb, 0x6d), pat(0xdb, 0x6d, 0xb6),
  R, R, R, R,
];

const ALGORITHMS = [
  { id: 'zero', name: 'Relleno de ceros', passes: [pat(0x00)], note: 'Rápido. Suficiente para discos modernos según NIST 800-88 (Clear).' },
  { id: 'random', name: 'Datos aleatorios', passes: [R] },
  { id: 'gost', name: 'GOST R 50739-95 (Rusia)', passes: [pat(0x00), R] },
  { id: 'dod3', name: 'US DoD 5220.22-M (3 pasadas)', passes: [pat(0x00), pat(0xff), R] },
  { id: 'hmg', name: 'British HMG IS5 Enhanced', passes: [pat(0x00), pat(0xff), R] },
  { id: 'navso', name: 'US Navy NAVSO P-5239-26', passes: [pat(0x01), pat(0x27, 0xff, 0xff, 0xff), R] },
  { id: 'nsa', name: 'NSA 130-2', passes: [R, R, pat(0x00)] },
  { id: 'dod7', name: 'US DoD 5220.22-M ECE (7 pasadas)', passes: [pat(0x00), pat(0xff), R, R, pat(0x00), pat(0xff), R] },
  { id: 'vsitr', name: 'German VSITR', passes: [pat(0x00), pat(0xff), pat(0x00), pat(0xff), pat(0x00), pat(0xff), pat(0xaa)] },
  { id: 'schneier', name: 'Bruce Schneier', passes: [pat(0xff), pat(0x00), R, R, R, R, R] },
  { id: 'gutmann', name: 'Peter Gutmann (35 pasadas)', passes: GUTMANN, note: 'Pensado para discos de los años 90; muy lento.' },
];

/** Algoritmo propio: hasta 4 patrones (hex 00–FF), pasadas por patrón y repeticiones del grupo. */
function customAlgorithm({ patterns = [], passesPerPattern = 1, groupRepeats = 1, finalRandom = false }) {
  const list = patterns.slice(0, 4).map((h) => {
    if (h === 'random' || h === 'R') return R;
    const b = parseInt(h, 16);
    if (isNaN(b) || b < 0 || b > 255) throw new Error(`Patrón no válido: ${h}`);
    return pat(b);
  });
  if (!list.length) throw new Error('Añade al menos un patrón.');
  const passes = [];
  for (let g = 0; g < Math.max(1, groupRepeats); g++) for (const p of list) for (let i = 0; i < Math.max(1, passesPerPattern); i++) passes.push(p);
  if (finalRandom) passes.push(R);
  return { id: 'custom', name: 'Algoritmo propio', passes };
}

function resolveAlgorithm(algo) {
  if (algo && typeof algo === 'object') return customAlgorithm(algo);
  const a = ALGORITHMS.find((x) => x.id === algo);
  if (!a) throw new Error(`Algoritmo desconocido: ${algo}`);
  return a;
}

/** Rellena buf con la pasada para la posición absoluta pos. */
function fillPass(pass, buf, len, pos, key) {
  if (pass.random) {
    // Contador = posición/16 → mismo contenido para la misma posición.
    const iv = Buffer.alloc(16);
    const block = BigInt(Math.floor(pos / 16));
    iv.writeBigUInt64BE(block >> 64n, 0);
    iv.writeBigUInt64BE(block & 0xffffffffffffffffn, 8);
    const c = crypto.createCipheriv('aes-256-ctr', key, iv);
    const skip = pos % 16;
    const out = c.update(Buffer.alloc(len + skip));
    out.copy(buf, 0, skip, skip + len);
    return;
  }
  const b = pass.bytes;
  if (b.length === 1) { buf.fill(b[0], 0, len); return; }
  for (let i = 0; i < len; i++) buf[i] = b[(pos + i) % b.length];
}

/** Sobrescribe una región (dispositivo, partición o archivo). */
function wipeRegion(target, algo, emit, isCancelled, { verifyPercent = 0, stamp = null } = {}) {
  const passes = algo.passes;
  const block = 4 * MiB;
  const buf = Buffer.alloc(block);
  const total = target.length * passes.length;
  const prog = new Progress(total, emit, 'Borrando');
  const fd = raw.open(target.path, true);
  const keys = passes.map(() => crypto.randomBytes(32));
  const t0 = Date.now();
  try {
    passes.forEach((pass, pi) => {
      for (let off = 0; off < target.length; off += block) {
        if (isCancelled()) throw new CancelledError();
        const len = Math.min(block, target.length - off);
        fillPass(pass, buf, len, off, keys[pi]);
        raw.writeAt(fd, buf, len, (target.offset || 0) + off);
        prog.add(len, `Pasada ${pi + 1} de ${passes.length}`);
      }
      raw.fsync(fd);
    });
    if (stamp) {
      const text = Buffer.from(`MANEJA-DISCOS WIPE ${stamp}`.slice(0, 440));
      const sector = Buffer.alloc(512);
      text.copy(sector);
      raw.writeAt(fd, sector, 512, target.offset || 0);
      raw.fsync(fd);
    }
  } finally {
    raw.close(fd);
  }
  let verification = null;
  if (verifyPercent > 0) verification = verifyRegion(target, passes[passes.length - 1], keys[keys.length - 1], verifyPercent, emit, isCancelled, !!stamp);
  return { bytes: target.length, passes: passes.length, seconds: (Date.now() - t0) / 1000, verification };
}

function verifyRegion(target, lastPass, key, percent, emit, isCancelled, skipFirstSector) {
  const block = MiB;
  const blocks = Math.ceil(target.length / block);
  const sample = Math.max(1, Math.round((blocks * Math.min(100, percent)) / 100));
  const step = blocks / sample;
  const fd = raw.open(target.path, false);
  const got = Buffer.alloc(block);
  const want = Buffer.alloc(block);
  const prog = new Progress(sample, emit, 'Verificando el borrado');
  let mismatches = 0;
  try {
    for (let s = 0; s < sample; s++) {
      if (isCancelled()) throw new CancelledError();
      const i = Math.min(blocks - 1, Math.floor(s * step));
      const off = i * block;
      const len = Math.min(block, target.length - off);
      raw.readAt(fd, got, len, (target.offset || 0) + off);
      fillPass(lastPass, want, len, off, key);
      const from = skipFirstSector && off === 0 ? 512 : 0;
      if (got.compare(want, from, len, from, len) !== 0) mismatches++;
      prog.add(1);
    }
  } finally {
    raw.close(fd);
  }
  return { sampledBlocks: sample, mismatches, ok: mismatches === 0 };
}

/** Borra el espacio libre de un volumen montado llenándolo con archivos temporales. */
function wipeFreeSpace(mountpoint, algo, emit, isCancelled) {
  const dir = path.join(mountpoint, `.maneja-discos-borrado-${newId()}`);
  fs.mkdirSync(dir);
  const block = 4 * MiB;
  const buf = Buffer.alloc(block);
  const files = [];
  const keys = algo.passes.map(() => crypto.randomBytes(32));
  let estimate = 0;
  try { const s = fs.statfsSync(mountpoint); estimate = Number(s.bavail) * Number(s.bsize); } catch { /* Node antiguo */ }
  const prog = new Progress(estimate * algo.passes.length || null, emit, 'Borrando espacio libre');
  const t0 = Date.now();
  let written = 0;
  try {
    // Primera pasada: llenar hasta quedarse sin espacio (archivos de 1 GB para FAT32)
    const maxFile = 1024 * MiB;
    let fileNo = 0;
    let full = false;
    while (!full) {
      const f = path.join(dir, `relleno-${fileNo++}.bin`);
      const fd = fs.openSync(f, 'w');
      let size = 0;
      try {
        while (size < maxFile) {
          if (isCancelled()) throw new CancelledError();
          fillPass(algo.passes[0], buf, block, size, keys[0]);
          let n;
          try { n = fs.writeSync(fd, buf, 0, block, size); } catch (e) {
            if (e.code === 'ENOSPC' || e.code === 'EFBIG' || e.code === 'EDQUOT') { full = true; break; }
            throw e;
          }
          size += n;
          written += n;
          prog.add(n, `Pasada 1 de ${algo.passes.length}`);
          if (n < block) { full = true; break; }
        }
        try { fs.fsyncSync(fd); } catch { /* lleno */ }
      } finally {
        fs.closeSync(fd);
      }
      files.push({ f, size });
      if (size === 0) full = true;
    }
    // Pasadas siguientes sobre los mismos archivos
    for (let pi = 1; pi < algo.passes.length; pi++) {
      for (const { f, size } of files) {
        const fd = fs.openSync(f, 'r+');
        try {
          for (let off = 0; off < size; off += block) {
            if (isCancelled()) throw new CancelledError();
            const len = Math.min(block, size - off);
            fillPass(algo.passes[pi], buf, len, off, keys[pi]);
            fs.writeSync(fd, buf, 0, len, off);
            prog.add(len, `Pasada ${pi + 1} de ${algo.passes.length}`);
          }
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { bytes: written, passes: algo.passes.length, seconds: (Date.now() - t0) / 1000 };
}

/** Tritura archivos y carpetas: sobrescribe el contenido, renombra y elimina. */
function wipeFiles(paths, algo, emit, isCancelled) {
  const list = [];
  const dirs = [];
  const walk = (p) => {
    const st = fs.lstatSync(p);
    if (st.isDirectory()) { for (const e of fs.readdirSync(p)) walk(path.join(p, e)); dirs.push(p); } else if (st.isFile()) list.push({ p, size: st.size });
  };
  paths.forEach(walk);
  const total = list.reduce((a, x) => a + x.size, 0) * algo.passes.length;
  const prog = new Progress(total, emit, 'Triturando archivos');
  const block = MiB;
  const buf = Buffer.alloc(block);
  const t0 = Date.now();
  for (const { p, size } of list) {
    const keys = algo.passes.map(() => crypto.randomBytes(32));
    const fd = fs.openSync(p, 'r+');
    try {
      algo.passes.forEach((pass, pi) => {
        for (let off = 0; off < size; off += block) {
          if (isCancelled()) throw new CancelledError();
          const len = Math.min(block, size - off);
          fillPass(pass, buf, len, off, keys[pi]);
          fs.writeSync(fd, buf, 0, len, off);
          prog.add(len);
        }
        fs.fsyncSync(fd);
      });
      fs.ftruncateSync(fd, 0);
    } finally {
      fs.closeSync(fd);
    }
    const anon = path.join(path.dirname(p), crypto.randomBytes(8).toString('hex'));
    fs.renameSync(p, anon);
    fs.unlinkSync(anon);
  }
  for (const d of dirs) { try { fs.rmdirSync(d); } catch { /* no vacía */ } }
  return { files: list.length, bytes: list.reduce((a, x) => a + x.size, 0), passes: algo.passes.length, seconds: (Date.now() - t0) / 1000 };
}

function reportHtml(r) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = Object.entries({
    'Fecha': new Date(r.finished).toLocaleString('es'),
    'Equipo': r.host,
    'Destino': r.target,
    'Modelo / serie': [r.model, r.serial].filter(Boolean).join(' · ') || '—',
    'Tipo de borrado': r.mode,
    'Algoritmo': `${r.algorithm} (${r.passes} pasadas)`,
    'Datos sobrescritos': `${(r.bytes / 1e9).toFixed(2)} GB`,
    'Duración': `${Math.round(r.seconds)} s`,
    'Verificación': r.verification ? (r.verification.ok ? `Correcta (${r.verification.sampledBlocks} bloques comprobados)` : `FALLÓ en ${r.verification.mismatches} bloques`) : 'No realizada',
    'Resultado': r.ok ? 'COMPLETADO' : 'CON ERRORES',
  }).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  return `<!doctype html><html lang="es"><meta charset="utf-8"><title>Informe de borrado</title>
<style>body{font:14px system-ui,sans-serif;max-width:720px;margin:40px auto;color:#1f2937}h1{font-size:22px}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid #e5e7eb}th{width:38%;color:#6b7280;font-weight:500}.ok{color:#15803d}.bad{color:#b91c1c}</style>
<h1>Informe de borrado seguro</h1><p class="${r.ok ? 'ok' : 'bad'}"><b>${r.ok ? 'Los datos se sobrescribieron correctamente.' : 'El borrado terminó con errores.'}</b></p>
<table>${rows}</table><p style="color:#9ca3af;margin-top:24px">Generado por Maneja Discos · ID ${esc(r.id)}</p></html>`;
}

function writeReport(dir, r) {
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `borrado-${r.finished.replace(/[:.]/g, '-')}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(r, null, 2));
  fs.writeFileSync(`${base}.html`, reportHtml(r));
  return `${base}.html`;
}

module.exports = { ALGORITHMS, resolveAlgorithm, customAlgorithm, wipeRegion, wipeFreeSpace, wipeFiles, writeReport, fillPass };
