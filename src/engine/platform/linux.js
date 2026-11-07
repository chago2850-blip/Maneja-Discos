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
// Adaptador Linux: lsblk + sysfs para listar; parted, sfdisk, sgdisk y mkfs.* para operar.
const fs = require('fs');
const path = require('path');
const { run, runOk, MiB, shQuote } = require('../util');

const FS_MKFS = {
  ext4: (dev, label, cluster) => ['mkfs.ext4', ['-F', ...(label ? ['-L', label.slice(0, 16)] : []), ...(cluster ? ['-b', String(cluster)] : []), dev]],
  ext3: (dev, label, cluster) => ['mkfs.ext3', ['-F', ...(label ? ['-L', label.slice(0, 16)] : []), ...(cluster ? ['-b', String(cluster)] : []), dev]],
  ext2: (dev, label, cluster) => ['mkfs.ext2', ['-F', ...(label ? ['-L', label.slice(0, 16)] : []), ...(cluster ? ['-b', String(cluster)] : []), dev]],
  ntfs: (dev, label, cluster) => ['mkfs.ntfs', ['-Q', '-F', ...(label ? ['-L', label.slice(0, 32)] : []), ...(cluster ? ['-c', String(cluster)] : []), dev]],
  fat32: (dev, label, cluster) => ['mkfs.vfat', ['-F', '32', ...(label ? ['-n', label.toUpperCase().slice(0, 11)] : []), ...(cluster ? ['-S', '512', '-s', String(Math.max(1, cluster / 512))] : []), dev]],
  exfat: (dev, label, cluster) => ['mkfs.exfat', [...(label ? ['-n', label.slice(0, 15)] : []), ...(cluster ? ['-c', String(cluster)] : []), dev]],
  btrfs: (dev, label) => ['mkfs.btrfs', ['-f', ...(label ? ['-L', label.slice(0, 255)] : []), dev]],
  xfs: (dev, label) => ['mkfs.xfs', ['-f', ...(label ? ['-L', label.slice(0, 12)] : []), dev]],
  swap: (dev, label) => ['mkswap', [...(label ? ['-L', label] : []), dev]],
};

const FS_PARTED_HINT = { ntfs: 'ntfs', exfat: 'ntfs', fat32: 'fat32', ext4: 'ext4', ext3: 'ext3', ext2: 'ext2', btrfs: 'btrfs', xfs: 'xfs', swap: 'linux-swap' };

const FS_LABEL = {
  ext2: (d, l) => ['e2label', [d, l]], ext3: (d, l) => ['e2label', [d, l]], ext4: (d, l) => ['e2label', [d, l]],
  ntfs: (d, l) => ['ntfslabel', ['-f', d, l]],
  vfat: (d, l) => ['fatlabel', [d, l.toUpperCase()]], fat32: (d, l) => ['fatlabel', [d, l.toUpperCase()]],
  exfat: (d, l) => ['exfatlabel', [d, l]],
  btrfs: (d, l) => ['btrfs', ['filesystem', 'label', d, l]],
  xfs: (d, l) => ['xfs_admin', ['-L', l, d]],
  swap: (d, l) => ['swaplabel', ['-L', l, d]],
};

function sys(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

function partPath(disk, n) {
  return /\d$/.test(disk) ? `${disk}p${n}` : `${disk}${n}`;
}

function normFs(fstype) {
  if (!fstype) return null;
  if (fstype === 'vfat') return 'fat32';
  if (fstype === 'ntfs' || fstype === 'ntfs3') return 'ntfs';
  return fstype;
}

/** Respaldo cuando udev no tiene datos (contenedores, sistemas mínimos): sondear con blkid. */
async function blkidProbe(dev) {
  const r = await run('blkid', ['-p', '-o', 'export', dev]);
  const out = {};
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

async function fillFromBlkid(node) {
  if (node.pttype || node.fstype) return;
  const p = await blkidProbe(node.path);
  if (p.PTTYPE && node.type !== 'part') node.pttype = p.PTTYPE;
  if (p.TYPE) node.fstype = p.TYPE;
  if (p.LABEL && !node.label) node.label = p.LABEL;
  if (p.UUID && !node.uuid) node.uuid = p.UUID;
}

async function listDisks() {
  const r = await runOk('lsblk', ['-J', '-b', '-o', 'NAME,KNAME,PATH,TYPE,SIZE,FSTYPE,LABEL,UUID,MOUNTPOINT,FSUSED,FSSIZE,MODEL,SERIAL,ROTA,RM,TRAN,PTTYPE,PARTTYPENAME,RO']);
  const data = JSON.parse(r.stdout);
  for (const d of data.blockdevices || []) {
    if (d.type !== 'disk' && d.type !== 'loop') continue;
    await fillFromBlkid(d);
    for (const p of d.children || []) await fillFromBlkid(p);
  }
  const includeLoop = process.env.MD_INCLUDE_LOOP === '1';
  const disks = [];
  for (const d of data.blockdevices || []) {
    if (!(d.type === 'disk' || (includeLoop && d.type === 'loop'))) continue;
    if (/^(zram|ram)/.test(d.name) || Number(d.size) === 0) continue;
    const sector = Number(sys(`/sys/block/${d.kname}/queue/logical_block_size`)) || 512;
    const size = Number(d.size);
    const parts = [];
    let isSystem = false;
    for (const p of d.children || []) {
      if (p.type !== 'part') continue;
      const start = Number(sys(`/sys/class/block/${p.kname}/start`)) * 512;
      const number = Number(sys(`/sys/class/block/${p.kname}/partition`));
      const mp = p.mountpoint || null;
      if (mp === '/' || mp === '/boot' || mp === '/boot/efi' || mp === '[SWAP]') isSystem = true;
      parts.push({
        id: p.path,
        path: p.path,
        number,
        start,
        size: Number(p.size),
        fs: normFs(p.fstype),
        label: p.label || '',
        uuid: p.uuid || null,
        mountpoint: mp && mp !== '[SWAP]' ? mp : null,
        letter: null,
        used: p.fsused != null ? Number(p.fsused) : null,
        type: p.parttypename || '',
        flags: { system: mp === '/' || mp === '/boot' || mp === '/boot/efi', swap: mp === '[SWAP]' },
      });
    }
    // Un disco sin tabla con sistema de archivos directo
    if (!parts.length && d.fstype) {
      parts.push({ id: d.path, path: d.path, number: 0, start: 0, size, fs: normFs(d.fstype), label: d.label || '', mountpoint: d.mountpoint || null, used: d.fsused != null ? Number(d.fsused) : null, type: 'sin tabla', flags: { whole: true } });
      if (d.mountpoint === '/') isSystem = true;
    }
    parts.sort((a, b) => a.start - b.start);
    disks.push({
      id: d.path,
      path: d.path,
      rawPath: d.path,
      name: d.name,
      model: (d.model || '').trim() || (d.type === 'loop' ? 'Dispositivo loop' : 'Disco'),
      serial: (d.serial || '').trim(),
      size,
      sectorSize: sector,
      partitionStyle: d.pttype === 'gpt' ? 'gpt' : d.pttype === 'dos' ? 'mbr' : d.fstype ? 'none' : (parts.length ? 'unknown' : 'none'),
      bus: (d.tran || (d.type === 'loop' ? 'loop' : '')).toUpperCase(),
      removable: d.rm === true || d.rm === '1' || d.rm === 1,
      ssd: d.rota === false || d.rota === '0' || d.rota === 0,
      readOnly: d.ro === true || d.ro === '1',
      isSystem,
      partitions: parts,
      free: computeFree(size, parts, d.pttype),
    });
  }
  return disks;
}

function computeFree(size, parts, pttype) {
  if (!pttype) return parts.length ? [] : [];
  const first = MiB;
  const end = pttype === 'gpt' ? size - MiB : size;
  const free = [];
  let cursor = first;
  for (const p of parts) {
    if (p.start - cursor >= MiB) free.push({ start: cursor, size: p.start - cursor });
    cursor = Math.max(cursor, p.start + p.size);
  }
  if (end - cursor >= MiB) free.push({ start: cursor, size: Math.floor((end - cursor) / MiB) * MiB });
  return free;
}

function nextPartNumber(disk) {
  const used = new Set(disk.partitions.map((p) => p.number));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/**
 * Traduce una operación pendiente a pasos ejecutables.
 * Cada paso: { cmd, args, input?, ignoreError?, note? }
 */
function plan(op, disk) {
  const steps = [];
  const P = (cmd, args, extra = {}) => steps.push({ cmd, args, ...extra });
  const part = op.partition;
  switch (op.kind) {
    case 'init': {
      for (const p of disk.partitions) if (p.mountpoint) P('umount', [p.path], { ignoreError: true });
      P('wipefs', ['-a', disk.path]);
      P('parted', ['-s', disk.path, 'mklabel', op.style === 'mbr' ? 'msdos' : 'gpt']);
      P('partprobe', [disk.path], { ignoreError: true });
      break;
    }
    case 'create': {
      const n = op.number || nextPartNumber(disk);
      const dev = partPath(disk.path, n);
      const start = op.start;
      const end = op.start + op.size - 1;
      const hint = FS_PARTED_HINT[op.fs] || '';
      P('parted', ['-s', '-a', 'optimal', disk.path, 'unit', 'B', 'mkpart', 'primary', ...(hint ? [hint] : []), `${start}B`, `${end}B`]);
      P('partprobe', [disk.path], { ignoreError: true });
      P('udevadm', ['settle'], { ignoreError: true });
      if (op.fs && op.fs !== 'none') {
        const [c, a] = FS_MKFS[op.fs](dev, op.label, op.cluster);
        P(c, a);
      }
      break;
    }
    case 'format': {
      if (part.mountpoint) P('umount', [part.path]);
      P('wipefs', ['-a', part.path], { ignoreError: true });
      const [c, a] = FS_MKFS[op.fs](part.path, op.label, op.cluster);
      P(c, a);
      if (disk.partitionStyle === 'mbr' && part.number) {
        const id = { ntfs: '7', exfat: '7', fat32: 'c', ext4: '83', ext3: '83', ext2: '83', btrfs: '83', xfs: '83', swap: '82' }[op.fs];
        if (id) P('sfdisk', ['--part-type', disk.path, String(part.number), id], { ignoreError: true });
      } else if (disk.partitionStyle === 'gpt' && part.number) {
        const msft = ['ntfs', 'exfat', 'fat32'].includes(op.fs);
        P('sgdisk', ['-t', `${part.number}:${msft ? '0700' : op.fs === 'swap' ? '8200' : '8300'}`, disk.path], { ignoreError: true });
      }
      break;
    }
    case 'delete': {
      if (part.mountpoint) P('umount', [part.path]);
      if (part.flags && part.flags.swap) P('swapoff', [part.path], { ignoreError: true });
      P('parted', ['-s', disk.path, 'rm', String(part.number)]);
      P('partprobe', [disk.path], { ignoreError: true });
      break;
    }
    case 'label': {
      const f = FS_LABEL[part.fs];
      if (!f) throw new Error(`No se puede cambiar la etiqueta de ${part.fs || 'este sistema de archivos'} en Linux.`);
      const [c, a] = f(part.path, op.label);
      P(c, a);
      break;
    }
    case 'resize': {
      const sectors = Math.floor(op.size / 512);
      const shrinking = op.size < part.size;
      const fsType = part.fs;
      if (!['ext2', 'ext3', 'ext4', 'ntfs'].includes(fsType)) {
        throw new Error(`Redimensionar ${fsType || 'esta partición'} no está disponible en Linux (compatibles: ext2/3/4 y NTFS).`);
      }
      if (part.mountpoint) P('umount', [part.path]);
      if (fsType.startsWith('ext')) P('e2fsck', ['-f', '-y', part.path], { okCodes: [0, 1] });
      if (shrinking) {
        if (fsType.startsWith('ext')) P('resize2fs', [part.path, `${Math.floor(op.size / 1024) - 1024}K`]);
        else P('ntfsresize', ['-f', '-s', `${op.size - MiB}`, part.path], { input: 'y\n' });
      }
      P('sfdisk', ['--no-reread', '-N', String(part.number), disk.path], { input: `,${sectors}\n`, note: 'tamaño en sectores de 512 bytes' });
      P('partprobe', [disk.path], { ignoreError: true });
      P('udevadm', ['settle'], { ignoreError: true });
      if (fsType.startsWith('ext')) P('resize2fs', [part.path]);
      else P('ntfsresize', ['-f', part.path], { input: 'y\n' });
      break;
    }
    case 'active': {
      P('parted', ['-s', disk.path, 'set', String(part.number), disk.partitionStyle === 'gpt' ? 'legacy_boot' : 'boot', op.value ? 'on' : 'off']);
      break;
    }
    case 'hide': {
      if (disk.partitionStyle !== 'mbr') throw new Error('Ocultar particiones solo está disponible en discos MBR.');
      P('parted', ['-s', disk.path, 'set', String(part.number), 'hidden', op.value ? 'on' : 'off']);
      break;
    }
    case 'convert': {
      for (const p of disk.partitions) if (p.mountpoint) P('umount', [p.path], { ignoreError: true });
      if (op.style === 'gpt') P('sgdisk', ['-g', disk.path]);
      else {
        if (disk.partitions.length > 4) throw new Error('Para convertir a MBR el disco debe tener 4 particiones o menos.');
        P('sgdisk', ['-m', disk.partitions.map((p) => p.number).join(':'), disk.path]);
      }
      P('partprobe', [disk.path], { ignoreError: true });
      break;
    }
    case 'letter':
      throw new Error('Las letras de unidad solo existen en Windows. En Linux usa el punto de montaje.');
    default:
      throw new Error(`Operación no compatible: ${op.kind}`);
  }
  return steps;
}

async function fsCheck(part, repair) {
  const dev = part.path;
  const map = {
    ext2: ['e2fsck', [repair ? '-fy' : '-fn', dev]], ext3: ['e2fsck', [repair ? '-fy' : '-fn', dev]], ext4: ['e2fsck', [repair ? '-fy' : '-fn', dev]],
    ntfs: ['ntfsfix', [repair ? '-d' : '-n', dev]],
    fat32: ['fsck.vfat', [repair ? '-a' : '-n', '-v', dev]],
    exfat: ['fsck.exfat', [repair ? '-y' : '-n', dev]],
    btrfs: ['btrfs', ['check', ...(repair ? ['--repair', '--force'] : ['--readonly']), dev]],
    xfs: ['xfs_repair', [...(repair ? [] : ['-n']), dev]],
  };
  const m = map[part.fs];
  if (!m) throw new Error(`No hay comprobador para ${part.fs || 'este sistema de archivos'}.`);
  const steps = [];
  if (part.mountpoint) steps.push({ cmd: 'umount', args: [dev] });
  steps.push({ cmd: m[0], args: m[1], okCodes: [0, 1] });
  return steps;
}

function trimSteps(target) {
  if (target.mountpoint) return [{ cmd: 'fstrim', args: ['-v', target.mountpoint] }];
  return [{ cmd: 'blkdiscard', args: ['-f', target.path] }];
}

/** Prepara un disco o región para escritura en crudo: desmonta lo necesario. */
async function prepareRawWrite(disk, region) {
  for (const p of disk.partitions) {
    const overlaps = !region || (p.start < region.offset + region.length && p.start + p.size > region.offset);
    if (overlaps && p.mountpoint) await runOk('umount', [p.path]);
    if (overlaps && p.flags && p.flags.swap) await run('swapoff', [p.path]);
  }
}

async function afterRawWrite(disk, { wholeDisk, grow } = {}) {
  if (wholeDisk && grow) await run('sgdisk', ['-e', disk.path]);
  await run('partprobe', [disk.path]);
  await run('udevadm', ['settle']);
}

function scriptLine(step) {
  const line = [step.cmd, ...step.args].map(shQuote).join(' ');
  return step.input ? `printf ${shQuote(step.input)} | ${line}` : line;
}

module.exports = {
  name: 'linux', listDisks, plan, fsCheck, trimSteps, prepareRawWrite, afterRawWrite, scriptLine,
  scriptHeader: '#!/bin/sh\n# Script generado por Maneja Discos — ejecútalo como root\nset -e\n',
  fileSystems: ['ext4', 'ntfs', 'fat32', 'exfat', 'btrfs', 'xfs', 'ext3', 'ext2', 'swap'],
  partPath,
  _computeFree: computeFree,
};
void path;
