'use strict';
// E/S en crudo sobre dispositivos o archivos, con lecturas alineadas al sector.
const fs = require('fs');

const ALIGN = 4096;

function open(path, write = false) {
  // En Windows, \\.\PhysicalDriveN requiere apertura sin crear ni truncar.
  const flags = write ? (fs.existsSync(path) || path.startsWith('\\\\.\\') ? 'r+' : 'w+') : 'r';
  return fs.openSync(path, flags);
}

function readAt(fd, buf, length, position) {
  let off = 0;
  while (off < length) {
    const n = fs.readSync(fd, buf, off, length - off, position + off);
    if (n === 0) break;
    off += n;
  }
  return off;
}

function writeAt(fd, buf, length, position) {
  let off = 0;
  while (off < length) {
    const n = fs.writeSync(fd, buf, off, length - off, position + off);
    if (n <= 0) throw new Error(`Escritura incompleta en la posición ${position + off}`);
    off += n;
  }
  return off;
}

/** Tamaño de un archivo o dispositivo de bloques. */
function sizeOf(path) {
  const st = fs.statSync(path);
  if (st.isFile()) return st.size;
  // Dispositivo: buscar el final leyendo en binario (lseek no está expuesto en Node).
  const fd = fs.openSync(path, 'r');
  try {
    const buf = Buffer.alloc(ALIGN);
    let lo = 0;
    let hi = ALIGN;
    while (readAt(fd, buf, ALIGN, hi) === ALIGN) { lo = hi; hi *= 2; }
    while (hi - lo > ALIGN) {
      const mid = Math.floor((lo + hi) / 2 / ALIGN) * ALIGN;
      if (readAt(fd, buf, ALIGN, mid) > 0) lo = mid; else hi = mid;
    }
    const n = readAt(fd, buf, ALIGN, lo);
    return lo + n;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { open, readAt, writeAt, sizeOf, ALIGN, close: (fd) => fs.closeSync(fd), fsync: (fd) => { try { fs.fsyncSync(fd); } catch { /* dispositivos sin fsync */ } } };
