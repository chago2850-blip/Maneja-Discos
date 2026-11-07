'use strict';
// Prueba de superficie: lee todo el dispositivo, mide la latencia y localiza sectores ilegibles.
const raw = require('./rawio');
const { Progress, CancelledError, MiB } = require('./util');

const CELLS = 400;

function surfaceTest(target, emit, isCancelled = () => false, { slowMs = 300, sector = 512 } = {}) {
  const block = MiB;
  const fd = raw.open(target.path, false);
  const buf = Buffer.alloc(block);
  const one = Buffer.alloc(sector);
  const prog = new Progress(target.length, emit, 'Prueba de superficie');
  const cells = new Array(CELLS).fill(0); // 0 ok, 1 lento, 2 dañado
  const cellSize = target.length / CELLS;
  const bad = [];
  let slow = 0;
  try {
    for (let off = 0; off < target.length; off += block) {
      if (isCancelled()) throw new CancelledError();
      const len = Math.min(block, target.length - off);
      const t0 = process.hrtime.bigint();
      let failed = false;
      try { raw.readAt(fd, buf, len, (target.offset || 0) + off); } catch { failed = true; }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const cell = Math.min(CELLS - 1, Math.floor(off / cellSize));
      if (failed) {
        // Localizar los sectores dañados dentro del bloque
        for (let s = 0; s < len; s += sector) {
          try { raw.readAt(fd, one, sector, (target.offset || 0) + off + s); } catch { if (bad.length < 10000) bad.push((off + s) / sector); }
        }
        cells[cell] = 2;
      } else if (ms > slowMs) {
        slow++;
        if (cells[cell] < 1) cells[cell] = 1;
      }
      prog.add(len, bad.length ? `${bad.length} sectores dañados` : slow ? `${slow} zonas lentas` : 'Sin errores');
      if (off % (64 * MiB) === 0) emit({ type: 'surface', cells });
    }
  } finally {
    raw.close(fd);
  }
  emit({ type: 'surface', cells });
  return { ok: bad.length === 0, badSectors: bad.length, firstBad: bad.slice(0, 50), slowBlocks: slow, cells };
}

module.exports = { surfaceTest };
