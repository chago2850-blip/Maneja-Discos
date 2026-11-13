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
// Tablas de particiones en JavaScript puro (sin herramientas externas), para que funcione
// igual en Windows, Linux y macOS:
//   · leer MBR (con particiones lógicas) y GPT
//   · convertir GPT → MBR y MBR → GPT sin tocar los datos de las particiones
//   · convertir una partición lógica en primaria
// Solo se reescriben los sectores de las tablas; las particiones quedan donde están.
const crypto = require('crypto');
const rawio = require('./rawio');

const EXTENDED = new Set([0x05, 0x0f, 0x85]);
const GPT_ENTRIES = 128;
const GPT_ENTRY_SIZE = 128;
const MAX32 = 0xffffffff;

// ------------------------------------------------------------------ GUID y CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** GUID en texto → 16 bytes con el orden mixto de GPT. */
function guidToBytes(s) {
  const h = s.replace(/[{}-]/g, '');
  const b = Buffer.from(h, 'hex');
  const out = Buffer.alloc(16);
  out.writeUInt32LE(b.readUInt32BE(0), 0);
  out.writeUInt16LE(b.readUInt16BE(4), 4);
  out.writeUInt16LE(b.readUInt16BE(6), 6);
  b.copy(out, 8, 8, 16);
  return out;
}

function bytesToGuid(b) {
  const hex = (x, n) => x.toString(16).padStart(n, '0');
  return [
    hex(b.readUInt32LE(0), 8), hex(b.readUInt16LE(4), 4), hex(b.readUInt16LE(6), 4),
    b.subarray(8, 10).toString('hex'), b.subarray(10, 16).toString('hex'),
  ].join('-').toUpperCase();
}

function randomGuid() {
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // versión 4 (posición del campo en el formato GPT)
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}

const GUID = {
  empty: '00000000-0000-0000-0000-000000000000',
  efi: 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B',
  msdata: 'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7',
  msreserved: 'E3C9E316-0B5C-4DB8-817D-F92DF00215AE',
  winre: 'DE94BBA4-06D1-4D40-A16A-BFD50179D6AC',
  linux: '0FC63DAF-8483-4772-8E79-3D69D8477DE4',
  swap: '0657FD6D-A4AB-43C4-84E5-0933C84B4F4F',
  lvm: 'E6D6D379-F507-44C2-A23C-238F2A3DF928',
  raid: 'A19D880F-05FC-4D3B-A006-743F0F84911E',
  hfs: '48465300-0000-11AA-AA11-00306543ECAC',
  apfs: '7C3457EF-0000-11AA-AA11-00306543ECAC',
  biosboot: '21686148-6449-6E6F-744E-656564454649',
};

const GPT_NAME = {
  [GUID.efi]: 'EFI System Partition', [GUID.msdata]: 'Basic data partition', [GUID.winre]: 'Recovery',
  [GUID.linux]: 'Linux filesystem', [GUID.swap]: 'Linux swap', [GUID.lvm]: 'Linux LVM', [GUID.raid]: 'Linux RAID',
  [GUID.hfs]: 'Mac OS Extended', [GUID.apfs]: 'APFS',
};

/** Tipo MBR → tipo GPT. */
function mbrTypeToGuid(t) {
  switch (t) {
    case 0xef: return GUID.efi;
    case 0x27: return GUID.winre;
    case 0x83: return GUID.linux;
    case 0x82: return GUID.swap;
    case 0x8e: return GUID.lvm;
    case 0xfd: return GUID.raid;
    case 0xaf: return GUID.hfs;
    case 0x01: case 0x04: case 0x06: case 0x07: case 0x0b: case 0x0c: case 0x0e:
    case 0x11: case 0x14: case 0x16: case 0x17: case 0x1b: case 0x1c: case 0x1e:
      return GUID.msdata;
    default: return GUID.msdata;
  }
}

/** Tipo GPT → tipo MBR (para datos de Microsoft se mira el sector de arranque). */
function guidToMbrType(guid, bootSector) {
  switch (guid) {
    case GUID.efi: return 0xef;
    case GUID.winre: return 0x27;
    case GUID.linux: return 0x83;
    case GUID.swap: return 0x82;
    case GUID.lvm: return 0x8e;
    case GUID.raid: return 0xfd;
    case GUID.hfs: case GUID.apfs: return 0xaf;
    case GUID.msreserved: return null; // MSR no existe en MBR: se omite
    case GUID.biosboot: return null;
    case GUID.msdata: default: {
      if (bootSector) {
        if (bootSector.toString('latin1', 82, 90) === 'FAT32   ') return 0x0c;
        if (bootSector.toString('latin1', 54, 59) === 'FAT16' || bootSector.toString('latin1', 54, 59) === 'FAT12') return 0x0e;
      }
      return guid === GUID.msdata ? 0x07 : 0x83;
    }
  }
}

// ------------------------------------------------------------------ E/S de sectores
class Dev {
  constructor(path, sectorSize, diskSize, write) {
    this.ss = sectorSize || 512;
    this.fd = rawio.open(path, write);
    this.size = diskSize || rawio.sizeOf(path);
    this.sectors = Math.floor(this.size / this.ss);
  }

  read(lba, count = 1) {
    const buf = Buffer.alloc(count * this.ss);
    const n = rawio.readAt(this.fd, buf, buf.length, lba * this.ss);
    if (n !== buf.length) throw new Error(`No se pudo leer el sector ${lba}.`);
    return buf;
  }

  write(lba, buf) {
    if (buf.length % this.ss) throw new Error('Escritura no alineada al sector.');
    rawio.writeAt(this.fd, buf, buf.length, lba * this.ss);
  }

  close() {
    rawio.fsync(this.fd);
    rawio.close(this.fd);
  }
}

function withDev(path, opts, write, fn) {
  const dev = new Dev(path, opts.sectorSize, opts.diskSize, write);
  try { return fn(dev); } finally { dev.close(); }
}

// ------------------------------------------------------------------ MBR
function parseEntry(buf, off) {
  return {
    status: buf[off],
    type: buf[off + 4],
    start: buf.readUInt32LE(off + 8),
    count: buf.readUInt32LE(off + 12),
  };
}

function chs(lba) {
  const H = 255; const S = 63;
  const c = Math.floor(lba / (H * S));
  if (c > 1023) return [0xfe, 0xff, 0xff];
  const h = Math.floor(lba / S) % H;
  const s = (lba % S) + 1;
  return [h, s | ((c >> 2) & 0xc0), c & 0xff];
}

function writeEntry(buf, off, e) {
  buf.fill(0, off, off + 16);
  if (!e || !e.type) return;
  buf[off] = e.status || 0;
  const a = chs(e.start);
  const b = chs(e.start + e.count - 1);
  buf[off + 1] = a[0]; buf[off + 2] = a[1]; buf[off + 3] = a[2];
  buf[off + 4] = e.type;
  buf[off + 5] = b[0]; buf[off + 6] = b[1]; buf[off + 7] = b[2];
  buf.writeUInt32LE(e.start, off + 8);
  buf.writeUInt32LE(e.count, off + 12);
}

function hasSig(buf) { return buf[510] === 0x55 && buf[511] === 0xaa; }

/** Lee el MBR y la cadena de EBR. Devuelve { mbr, slots, extSlot, ext, logicals }. */
function readMbr(dev) {
  const mbr = dev.read(0);
  if (!hasSig(mbr)) throw new Error('El disco no tiene una tabla MBR válida.');
  const slots = [0, 1, 2, 3].map((i) => parseEntry(mbr, 446 + i * 16));
  if (slots.some((s) => s.type === 0xee)) throw new Error('El disco usa GPT (MBR protector), no MBR.');
  const extSlot = slots.findIndex((s) => EXTENDED.has(s.type));
  const logicals = [];
  if (extSlot >= 0) {
    const ext = slots[extSlot];
    let ebrLba = ext.start;
    const seen = new Set();
    while (ebrLba && !seen.has(ebrLba) && logicals.length < 128) {
      seen.add(ebrLba);
      const ebr = dev.read(ebrLba);
      if (!hasSig(ebr)) break;
      const l = parseEntry(ebr, 446);
      const link = parseEntry(ebr, 462);
      if (l.type) logicals.push({ ebrLba, ebr, status: l.status, type: l.type, start: ebrLba + l.start, count: l.count, link });
      ebrLba = link.type && link.start ? ext.start + link.start : 0;
    }
  }
  return { mbr, slots, extSlot, ext: extSlot >= 0 ? slots[extSlot] : null, logicals };
}

/** Lista plana de particiones del MBR (primarias + lógicas), en sectores. */
function mbrPartitions(t) {
  const out = [];
  t.slots.forEach((s, i) => { if (s.type && !EXTENDED.has(s.type)) out.push({ ...s, primary: true, slot: i }); });
  t.logicals.forEach((l) => out.push({ status: l.status, type: l.type, start: l.start, count: l.count, primary: false, ebrLba: l.ebrLba }));
  return out.sort((a, b) => a.start - b.start);
}

// ------------------------------------------------------------------ GPT
function readGptHeader(dev, lba) {
  const h = dev.read(lba);
  if (h.toString('latin1', 0, 8) !== 'EFI PART') return null;
  const size = h.readUInt32LE(12);
  const copy = Buffer.from(h.subarray(0, size));
  const crc = copy.readUInt32LE(16);
  copy.writeUInt32LE(0, 16);
  if (crc32(copy) !== crc) return null;
  return {
    myLba: Number(h.readBigUInt64LE(24)), altLba: Number(h.readBigUInt64LE(32)),
    firstUsable: Number(h.readBigUInt64LE(40)), lastUsable: Number(h.readBigUInt64LE(48)),
    diskGuid: Buffer.from(h.subarray(56, 72)), entriesLba: Number(h.readBigUInt64LE(72)),
    count: h.readUInt32LE(80), entrySize: h.readUInt32LE(84),
  };
}

function readGpt(dev) {
  let hdr = readGptHeader(dev, 1);
  if (!hdr) hdr = readGptHeader(dev, dev.sectors - 1);
  if (!hdr) throw new Error('El disco no tiene una tabla GPT válida.');
  const bytes = hdr.count * hdr.entrySize;
  const raw = dev.read(hdr.entriesLba, Math.ceil(bytes / dev.ss));
  const parts = [];
  for (let i = 0; i < hdr.count; i++) {
    const e = raw.subarray(i * hdr.entrySize, (i + 1) * hdr.entrySize);
    const type = bytesToGuid(e.subarray(0, 16));
    if (type === GUID.empty) continue;
    parts.push({
      index: i + 1, type, unique: bytesToGuid(e.subarray(16, 32)),
      start: Number(e.readBigUInt64LE(32)), last: Number(e.readBigUInt64LE(40)),
      attrs: e.readBigUInt64LE(48), name: e.toString('utf16le', 56, 128).replace(/\0.*$/, ''),
    });
  }
  return { hdr, parts: parts.sort((a, b) => a.start - b.start) };
}

function gptLayout(dev) {
  const entrySectors = Math.ceil((GPT_ENTRIES * GPT_ENTRY_SIZE) / dev.ss);
  return {
    entrySectors,
    firstUsable: 2 + entrySectors,
    lastUsable: dev.sectors - 2 - entrySectors,
    backupEntries: dev.sectors - 1 - entrySectors,
    backupHeader: dev.sectors - 1,
  };
}

function buildGptHeader(dev, L, { myLba, altLba, entriesLba, diskGuid, entriesCrc }) {
  const h = Buffer.alloc(dev.ss);
  h.write('EFI PART', 0, 'latin1');
  h.writeUInt32LE(0x00010000, 8);
  h.writeUInt32LE(92, 12);
  h.writeBigUInt64LE(BigInt(myLba), 24);
  h.writeBigUInt64LE(BigInt(altLba), 32);
  h.writeBigUInt64LE(BigInt(L.firstUsable), 40);
  h.writeBigUInt64LE(BigInt(L.lastUsable), 48);
  diskGuid.copy(h, 56);
  h.writeBigUInt64LE(BigInt(entriesLba), 72);
  h.writeUInt32LE(GPT_ENTRIES, 80);
  h.writeUInt32LE(GPT_ENTRY_SIZE, 84);
  h.writeUInt32LE(entriesCrc, 88);
  h.writeUInt32LE(crc32(h.subarray(0, 92)), 16);
  return h;
}

// ------------------------------------------------------------------ Conversiones
/** Lee la tabla del disco (para comprobaciones y para la interfaz). */
function inspect(path, opts = {}) {
  return withDev(path, opts, false, (dev) => {
    const s0 = dev.read(0);
    const protective = hasSig(s0) && [0, 1, 2, 3].some((i) => s0[446 + i * 16 + 4] === 0xee);
    if (protective || readGptHeader(dev, 1)) {
      const g = readGpt(dev);
      return { style: 'gpt', sectorSize: dev.ss, partitions: g.parts.map((p) => ({ start: p.start, count: p.last - p.start + 1, type: p.type, name: p.name })) };
    }
    const t = readMbr(dev);
    return {
      style: 'mbr', sectorSize: dev.ss,
      extended: t.ext ? { start: t.ext.start, count: t.ext.count } : null,
      partitions: mbrPartitions(t).map((p) => ({ start: p.start, count: p.count, type: p.type, primary: p.primary, active: p.status === 0x80 })),
    };
  });
}

/** GPT → MBR conservando las particiones (máx. 4, o 3 primarias + lógicas si hay hueco para los EBR). */
function gptToMbr(path, opts = {}) {
  return withDev(path, opts, true, (dev) => {
    const g = readGpt(dev);
    const skipped = [];
    const parts = [];
    for (const p of g.parts) {
      const boot = dev.read(p.start);
      const type = guidToMbrType(p.type, boot);
      const count = p.last - p.start + 1;
      if (type == null) {
        // Las reservadas de Microsoft y BIOS boot no tienen datos de usuario y no existen en MBR
        if (count * dev.ss <= 256 * 1024 * 1024) { skipped.push(p.name || p.type); continue; }
        throw new Error(`La partición ${p.index} (${p.name || p.type}) no tiene equivalente en MBR.`);
      }
      if (p.last > MAX32 || count > MAX32) throw new Error('MBR solo admite discos y particiones de hasta 2 TiB (con sectores de 512 bytes). Este disco usa espacio por encima de ese límite.');
      parts.push({ start: p.start, count, type, status: (p.attrs & 4n) ? 0x80 : 0 });
    }
    if (!parts.length) throw new Error('El disco GPT no tiene particiones que convertir. Usa "Inicializar" para crear una tabla MBR vacía.');

    const mbr = dev.read(0);
    mbr.fill(0, 440, 510); // conserva el código de arranque (0–439)
    crypto.randomBytes(4).copy(mbr, 440);
    mbr[510] = 0x55; mbr[511] = 0xaa;
    const ebrs = [];
    if (parts.length <= 4) {
      parts.forEach((p, i) => writeEntry(mbr, 446 + i * 16, p));
    } else {
      const prim = parts.slice(0, 3);
      const logi = parts.slice(3);
      // Cada lógica necesita un sector libre justo antes (su EBR) que no pise la partición anterior
      let prevEnd = prim[2].start + prim[2].count - 1;
      for (const l of logi) {
        if (l.start - 1 <= prevEnd) {
          throw new Error(`MBR admite 4 particiones primarias y el disco tiene ${parts.length}. Para crear particiones lógicas hace falta al menos un sector libre antes de cada partición a partir de la cuarta, y no lo hay. Elimina o une particiones hasta dejar 4 o menos.`);
        }
        prevEnd = l.start + l.count - 1;
      }
      const extStart = logi[0].start - 1;
      const last = logi[logi.length - 1];
      prim.forEach((p, i) => writeEntry(mbr, 446 + i * 16, p));
      writeEntry(mbr, 446 + 48, { type: 0x0f, start: extStart, count: last.start + last.count - extStart });
      logi.forEach((l, i) => {
        const ebr = Buffer.alloc(dev.ss);
        ebr[510] = 0x55; ebr[511] = 0xaa;
        const ebrLba = l.start - 1;
        writeEntry(ebr, 446, { status: l.status, type: l.type, start: 1, count: l.count });
        const next = logi[i + 1];
        if (next) writeEntry(ebr, 462, { type: 0x05, start: next.start - 1 - extStart, count: next.count + 1 });
        ebrs.push([ebrLba, ebr]);
      });
    }

    // Borrar ambas copias de GPT y después escribir el MBR nuevo
    const zero = Buffer.alloc(dev.ss * (1 + Math.ceil((g.hdr.count * g.hdr.entrySize) / dev.ss)));
    const backup = readGptHeader(dev, dev.sectors - 1);
    if (backup) {
      dev.write(backup.entriesLba, Buffer.alloc(dev.ss * Math.ceil((backup.count * backup.entrySize) / dev.ss)));
      dev.write(dev.sectors - 1, Buffer.alloc(dev.ss));
    }
    dev.write(1, zero);
    for (const [lba, buf] of ebrs) dev.write(lba, buf);
    dev.write(0, mbr);
    return { style: 'mbr', partitions: parts.length, logical: ebrs.length, skipped };
  });
}

/** MBR → GPT conservando las particiones (incluidas las lógicas). */
function mbrToGpt(path, opts = {}) {
  return withDev(path, opts, true, (dev) => {
    const t = readMbr(dev);
    const parts = mbrPartitions(t);
    const L = gptLayout(dev);
    if (!parts.length) throw new Error('El disco MBR no tiene particiones que convertir. Usa "Inicializar" para crear una tabla GPT vacía.');
    if (parts.length > GPT_ENTRIES) throw new Error('Demasiadas particiones para GPT.');
    for (const p of parts) {
      if (p.start < L.firstUsable) throw new Error('La primera partición empieza demasiado cerca del inicio del disco: no hay sitio para la tabla GPT.');
      if (p.start + p.count - 1 > L.lastUsable) {
        throw new Error(`La última partición llega hasta el final del disco y GPT necesita ${(L.entrySectors + 1) * dev.ss / 1024} KB libres al final para su copia de seguridad. Reduce esa partición 1 MB y vuelve a intentarlo.`);
      }
    }
    const entries = Buffer.alloc(L.entrySectors * dev.ss);
    parts.forEach((p, i) => {
      const off = i * GPT_ENTRY_SIZE;
      const type = mbrTypeToGuid(p.type);
      guidToBytes(type).copy(entries, off);
      randomGuid().copy(entries, off + 16);
      entries.writeBigUInt64LE(BigInt(p.start), off + 32);
      entries.writeBigUInt64LE(BigInt(p.start + p.count - 1), off + 40);
      let attrs = 0n;
      if (p.status === 0x80) attrs |= 4n; // arranque BIOS heredado
      if ([0x11, 0x14, 0x16, 0x17, 0x1b, 0x1c, 0x1e].includes(p.type)) attrs |= 1n << 62n; // oculta
      entries.writeBigUInt64LE(attrs, off + 48);
      entries.write((GPT_NAME[type] || '').slice(0, 36), off + 56, 'utf16le');
    });
    const ecrc = crc32(entries.subarray(0, GPT_ENTRIES * GPT_ENTRY_SIZE));
    const diskGuid = randomGuid();
    const primary = buildGptHeader(dev, L, { myLba: 1, altLba: L.backupHeader, entriesLba: 2, diskGuid, entriesCrc: ecrc });
    const backup = buildGptHeader(dev, L, { myLba: L.backupHeader, altLba: 1, entriesLba: L.backupEntries, diskGuid, entriesCrc: ecrc });

    const pmbr = Buffer.alloc(dev.ss);
    t.mbr.copy(pmbr, 0, 0, 440); // conserva el código de arranque
    writeEntry(pmbr, 446, { type: 0xee, start: 1, count: Math.min(dev.sectors - 1, MAX32) });
    pmbr[446 + 1] = 0x00; pmbr[446 + 2] = 0x02; pmbr[446 + 3] = 0x00;
    pmbr[510] = 0x55; pmbr[511] = 0xaa;

    // Copia de seguridad al final, luego la principal y por último el MBR protector
    dev.write(L.backupEntries, entries);
    dev.write(L.backupHeader, backup);
    dev.write(2, entries);
    dev.write(1, primary);
    // Los EBR antiguos quedan dentro de espacio que ya no es de ninguna partición: se limpian
    for (const l of t.logicals) if (l.ebrLba >= L.firstUsable) dev.write(l.ebrLba, Buffer.alloc(dev.ss));
    dev.write(0, pmbr);
    return { style: 'gpt', partitions: parts.length };
  });
}

/** Convierte la partición lógica que empieza en el byte `startBytes` en primaria. */
function logicalToPrimary(path, startBytes, opts = {}) {
  return withDev(path, opts, true, (dev) => {
    const t = readMbr(dev);
    const startLba = Math.round(startBytes / dev.ss);
    if (t.slots.some((s) => s.type && !EXTENDED.has(s.type) && s.start === startLba)) throw new Error('La partición ya es primaria.');
    const idx = t.logicals.findIndex((l) => l.start === startLba);
    if (idx < 0) throw new Error('No se encontró la partición lógica en la tabla MBR.');
    const L = t.logicals;
    const target = L[idx];
    const ext = t.ext;
    const entry = { status: target.status, type: target.type, start: target.start, count: target.count };
    const slots = t.slots.map((s) => ({ ...s }));
    const writes = [];

    if (L.length === 1) {
      // Única lógica: la entrada de la extendida pasa a ser la partición primaria
      slots[t.extSlot] = entry;
      if (target.ebrLba < target.start) writes.push([target.ebrLba, Buffer.alloc(dev.ss)]);
    } else {
      const free = slots.findIndex((s) => !s.type);
      if (free < 0) throw new Error('El MBR ya tiene sus 4 entradas ocupadas (3 primarias + la extendida). Elimina o mueve una partición primaria para poder convertir esta en primaria.');
      if (idx === 0) {
        // Primera lógica: la extendida empieza ahora en el EBR de la siguiente
        const newStart = L[1].ebrLba;
        const extEnd = ext.start + ext.count - 1;
        slots[t.extSlot] = { ...ext, start: newStart, count: extEnd - newStart + 1 };
        for (let k = 1; k < L.length; k++) {
          const ebr = Buffer.from(L[k].ebr);
          const next = L[k + 1];
          writeEntry(ebr, 462, next ? { type: 0x05, start: next.ebrLba - newStart, count: next.start + next.count - next.ebrLba } : null);
          writes.push([L[k].ebrLba, ebr]);
        }
        if (target.ebrLba < target.start) writes.push([target.ebrLba, Buffer.alloc(dev.ss)]);
      } else if (idx === L.length - 1) {
        // Última lógica: la anterior deja de enlazarla y la extendida termina antes
        const prev = L[idx - 1];
        const ebr = Buffer.from(prev.ebr);
        writeEntry(ebr, 462, null);
        writes.push([prev.ebrLba, ebr]);
        slots[t.extSlot] = { ...ext, count: prev.start + prev.count - ext.start };
        if (target.ebrLba < target.start) writes.push([target.ebrLba, Buffer.alloc(dev.ss)]);
      } else {
        throw new Error('Solo se puede convertir en primaria la primera o la última partición lógica de la partición extendida. Esta está en medio de otras lógicas.');
      }
      slots[free] = entry;
    }

    // Ordenar las entradas por posición (las vacías al final)
    const ordered = slots.filter((s) => s.type).sort((a, b) => a.start - b.start);
    while (ordered.length < 4) ordered.push(null);
    const mbr = Buffer.from(t.mbr);
    ordered.forEach((e, i) => writeEntry(mbr, 446 + i * 16, e));
    for (const [lba, buf] of writes) dev.write(lba, buf);
    dev.write(0, mbr);
    return { converted: startLba, remainingLogical: L.length - 1 };
  });
}

module.exports = { inspect, gptToMbr, mbrToGpt, logicalToPrimary, crc32, guidToBytes, bytesToGuid, GUID, EXTENDED };
