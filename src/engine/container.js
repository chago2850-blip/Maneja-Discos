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
// Contenedor de copias de Maneja Discos: registros comprimidos (gzip) y opcionalmente cifrados
// (AES-256-GCM, clave derivada con scrypt) guardados en archivos "data-NNNN.bin" divididos por tamaño.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const FORMAT = 'maneja-discos';
const VERSION = 1;

function makeEncryption(password) {
  if (!password) return null;
  const salt = crypto.randomBytes(16).toString('hex');
  const params = { N: 1 << 15, r: 8, p: 1 };
  const key = deriveKey(password, { salt, ...params });
  return { algo: 'aes-256-gcm', kdf: 'scrypt', salt, ...params, check: keyCheck(key) };
}

function deriveKey(password, enc) {
  return crypto.scryptSync(String(password), Buffer.from(enc.salt, 'hex'), 32, { N: enc.N, r: enc.r, p: enc.p, maxmem: 256 * 1024 * 1024 });
}

function keyCheck(key) {
  return crypto.createHmac('sha256', key).update('maneja-discos-v1').digest('hex').slice(0, 32);
}

/** Devuelve la clave o lanza si la contraseña no es correcta. */
function unlock(enc, password) {
  if (!enc) return null;
  if (!password) { const e = new Error('Esta copia está protegida con contraseña.'); e.needsPassword = true; throw e; }
  const key = deriveKey(password, enc);
  if (keyCheck(key) !== enc.check) { const e = new Error('La contraseña no es correcta.'); e.needsPassword = true; throw e; }
  return key;
}

function seal(plain, key, level = 3) {
  const z = zlib.gzipSync(plain, { level });
  if (!key) return z;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(z), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

function open(record, key) {
  let z = record;
  if (key) {
    const iv = record.subarray(0, 12);
    const tag = record.subarray(12, 28);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    z = Buffer.concat([d.update(record.subarray(28)), d.final()]);
  }
  return zlib.gunzipSync(z);
}

function hashBlock(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

function isZero(buf) {
  // Comparación rápida por palabras de 8 bytes
  const n = buf.length - (buf.length % 8);
  for (let i = 0; i < n; i += 8) if (buf.readBigUInt64LE(i) !== 0n) return false;
  for (let i = n; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

class ChunkWriter {
  constructor(dir, splitSize) {
    this.dir = dir;
    this.splitSize = splitSize > 0 ? splitSize : Infinity;
    this.no = 0;
    this.fd = null;
    this.size = 0;
    this.total = 0;
  }
  _rotate() {
    if (this.fd != null) { fs.fsyncSync(this.fd); fs.closeSync(this.fd); }
    this.no += 1;
    this.fd = fs.openSync(path.join(this.dir, chunkName(this.no)), 'w');
    this.size = 0;
  }
  write(buf) {
    if (this.fd == null || (this.size > 0 && this.size + buf.length > this.splitSize)) this._rotate();
    const off = this.size;
    let w = 0;
    while (w < buf.length) w += fs.writeSync(this.fd, buf, w, buf.length - w);
    this.size += buf.length;
    this.total += buf.length;
    return [this.no, off, buf.length];
  }
  close() {
    if (this.fd != null) { fs.fsyncSync(this.fd); fs.closeSync(this.fd); this.fd = null; }
  }
}

class ChunkReader {
  constructor(dir) { this.dir = dir; this.fds = new Map(); }
  read([no, off, len]) {
    let fd = this.fds.get(no);
    if (fd == null) {
      const file = path.join(this.dir, chunkName(no));
      if (!fs.existsSync(file)) throw new Error(`Falta el archivo ${chunkName(no)} en ${path.basename(this.dir)}`);
      fd = fs.openSync(file, 'r');
      this.fds.set(no, fd);
    }
    const buf = Buffer.allocUnsafe(len);
    let r = 0;
    while (r < len) {
      const n = fs.readSync(fd, buf, r, len - r, off + r);
      if (n === 0) throw new Error(`Archivo ${chunkName(no)} truncado`);
      r += n;
    }
    return buf;
  }
  close() { for (const fd of this.fds.values()) fs.closeSync(fd); this.fds.clear(); }
}

function chunkName(no) {
  return `data-${String(no).padStart(4, '0')}.bin`;
}

function dirSize(dir) {
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    const st = fs.statSync(path.join(dir, f));
    total += st.isDirectory() ? dirSize(path.join(dir, f)) : st.size;
  }
  return total;
}

module.exports = { FORMAT, VERSION, makeEncryption, unlock, seal, open, hashBlock, isZero, ChunkWriter, ChunkReader, dirSize };
