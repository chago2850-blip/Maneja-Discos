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
// Adaptador macOS: diskutil (+ plutil para convertir plist a JSON).
const fs = require('fs');
const { run, runOk, MiB, shQuote } = require('../util');

const DISKUTIL = '/usr/sbin/diskutil';
const FS_NAME = { apfs: 'APFS', hfs: 'JHFS+', exfat: 'ExFAT', fat32: 'MS-DOS FAT32', ntfs: 'ExFAT' };
// mkntfs de MacNTFS si está instalado
const MKNTFS = ['/usr/local/libexec/macntfs/bin/mkntfs', '/usr/local/sbin/mkntfs', '/opt/homebrew/sbin/mkntfs'].find((p) => fs.existsSync(p));
const MKEXT4 = ['/opt/homebrew/opt/e2fsprogs/sbin/mkfs.ext4', '/usr/local/opt/e2fsprogs/sbin/mkfs.ext4'].find((p) => fs.existsSync(p));

/**
 * diskutil exige -plist justo después del verbo:
 *   diskutil list -plist physical · diskutil info -plist disk2 · diskutil apfs list -plist
 */
function plistArgs(args) {
  if (args[0] === 'apfs') return ['apfs', args[1], '-plist', ...args.slice(2)];
  return [args[0], '-plist', ...args.slice(1)];
}

async function plist(args) {
  const r = await runOk(DISKUTIL, plistArgs(args));
  const j = await runOk('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: r.stdout });
  return JSON.parse(j.stdout);
}

function normFs(info) {
  const t = (info.FilesystemType || info.FilesystemName || '').toLowerCase();
  if (!t) return info.Content === 'Apple_APFS' ? 'apfs' : null;
  if (t.includes('apfs')) return 'apfs';
  if (t.includes('hfs')) return 'hfs';
  if (t.includes('exfat')) return 'exfat';
  if (t.includes('msdos') || t.includes('fat')) return 'fat32';
  if (t.includes('ntfs')) return 'ntfs';
  if (t.includes('ext')) return 'ext4';
  return t;
}

async function listDisks() {
  const list = await plist(['list', 'physical']);
  const apfs = await plist(['apfs', 'list']).catch(() => null);
  const rootDev = (await run('/bin/df', ['/'])).stdout.split('\n')[1]?.split(/\s+/)[0] || '';
  const disks = [];
  for (const d of list.AllDisksAndPartitions || []) {
    const id = d.DeviceIdentifier;
    const info = await plist(['info', id]).catch(() => ({}));
    const parts = [];
    let isSystem = false;
    for (const p of d.Partitions || []) {
      const pi = await plist(['info', p.DeviceIdentifier]).catch(() => ({}));
      let mount = pi.MountPoint || p.MountPoint || null;
      let used = pi.TotalSize && pi.FreeSpace != null ? pi.TotalSize - pi.FreeSpace : null;
      let label = pi.VolumeName || p.VolumeName || '';
      // Contenedor APFS: mostrar el volumen principal
      if (pi.Content === 'Apple_APFS' || p.Content === 'Apple_APFS') {
        const c = apfs?.Containers?.find((x) => x.DesignatedPhysicalStore === p.DeviceIdentifier || (x.PhysicalStores || []).some((s) => s.DeviceIdentifier === p.DeviceIdentifier));
        if (c) {
          used = c.CapacityCeiling - c.CapacityFree;
          const v = (c.Volumes || []).find((x) => !(x.Roles || []).length) || (c.Volumes || [])[0];
          if (v) {
            label = v.Name;
            const vi = await plist(['info', v.DeviceIdentifier]).catch(() => ({}));
            mount = vi.MountPoint || mount;
            if ((c.Volumes || []).some((x) => (x.Roles || []).includes('System'))) isSystem = true;
          }
        }
      }
      if (rootDev.startsWith(`/dev/${p.DeviceIdentifier}`)) isSystem = true;
      parts.push({
        id: p.DeviceIdentifier,
        path: `/dev/${p.DeviceIdentifier}`,
        number: Number(String(p.DeviceIdentifier).replace(/^disk\d+s/, '')) || 0,
        start: pi.PartitionMapPartitionOffset ?? 0,
        size: p.Size,
        fs: normFs(pi),
        label,
        mountpoint: mount,
        letter: null,
        used,
        type: p.Content || '',
        flags: { system: p.Content === 'EFI' || isSystem, efi: p.Content === 'EFI', logical: d.Content === 'FDisk_partition_scheme' && Number(String(p.DeviceIdentifier).replace(/^disk\d+s/, '')) >= 5 },
      });
    }
    parts.sort((a, b) => a.start - b.start);
    const scheme = d.Content === 'GUID_partition_scheme' ? 'gpt' : d.Content === 'FDisk_partition_scheme' ? 'mbr' : (parts.length ? 'unknown' : 'none');
    disks.push({
      id,
      path: `/dev/${id}`,
      rawPath: `/dev/r${id}`,
      name: id,
      model: info.MediaName || info.IORegistryEntryName || 'Disco',
      serial: '',
      size: d.Size,
      sectorSize: info.DeviceBlockSize || 512,
      partitionStyle: scheme,
      bus: info.BusProtocol || '',
      removable: !!(info.RemovableMedia || info.Removable || info.Ejectable),
      ssd: info.SolidState === true,
      readOnly: info.WritableMedia === false,
      isSystem: isSystem || info.Internal === true && parts.some((p) => p.flags.system && !p.flags.efi),
      internal: info.Internal === true,
      partitions: parts,
      free: computeFree(d.Size, parts, scheme),
    });
  }
  return disks;
}

function computeFree(size, parts, scheme) {
  if (scheme === 'none') return [];
  const free = [];
  let cursor = scheme === 'gpt' ? 40 * 512 : MiB;
  const end = scheme === 'gpt' ? size - 34 * 512 : size;
  for (const p of parts) {
    if (p.start - cursor >= 16 * MiB) free.push({ start: cursor, size: p.start - cursor });
    cursor = Math.max(cursor, p.start + p.size);
  }
  if (end - cursor >= 16 * MiB) free.push({ start: cursor, size: end - cursor });
  return free;
}

function plan(op, disk) {
  const steps = [];
  const P = (cmd, args, extra = {}) => steps.push({ cmd, args, ...extra });
  const part = op.partition;
  const fsName = (fs) => {
    if (fs === 'ext4' && !MKEXT4) throw new Error('Para crear ext4 en macOS instala e2fsprogs (brew install e2fsprogs).');
    return FS_NAME[fs] || (fs === 'ext4' ? 'ExFAT' : null);
  };
  switch (op.kind) {
    case 'init':
      P(DISKUTIL, ['eraseDisk', 'free', 'SINNOMBRE', op.style === 'mbr' ? 'MBR' : 'GPT', disk.id]);
      break;
    case 'create': {
      const prev = [...disk.partitions].filter((p) => p.start < op.start).pop();
      const name = op.label || 'Sin titulo';
      P(DISKUTIL, ['addPartition', prev ? prev.id : disk.id, fsName(op.fs) || 'free', name, `${op.size}B`]);
      if (op.fs === 'ntfs' || op.fs === 'ext4') steps.push({ post: 'formatNewPartition', fs: op.fs, label: name, note: 'se aplica a la partición recién creada' });
      break;
    }
    case 'format':
      P(DISKUTIL, ['eraseVolume', fsName(op.fs), op.label || 'Sin titulo', part.id]);
      if (op.fs === 'ntfs') {
        if (!MKNTFS) throw new Error('Para formatear en NTFS en macOS instala MacNTFS (incluye mkntfs).');
        P(DISKUTIL, ['unmount', part.id], { ignoreError: true });
        P(MKNTFS, ['-Q', '-F', '-L', (op.label || 'Sin titulo').slice(0, 32), part.path]);
      }
      if (op.fs === 'ext4') {
        P(DISKUTIL, ['unmount', part.id], { ignoreError: true });
        P(MKEXT4, ['-F', '-L', (op.label || 'Sin titulo').slice(0, 16), part.path]);
      }
      break;
    case 'delete':
      P(DISKUTIL, ['eraseVolume', 'free', 'none', part.id]);
      break;
    case 'label':
      P(DISKUTIL, ['rename', part.id, op.label]);
      break;
    case 'resize':
      if (!['apfs', 'hfs'].includes(part.fs)) throw new Error('En macOS solo se pueden redimensionar volúmenes APFS y Mac OS Plus.');
      P(DISKUTIL, [part.fs === 'apfs' ? 'apfs' : 'resizeVolume', ...(part.fs === 'apfs' ? ['resizeContainer', part.id] : [part.id]), `${op.size}B`]);
      break;
    case 'convert':
    case 'primary': {
      if (disk.isSystem) throw new Error('No se puede cambiar la tabla del disco de arranque de macOS en uso.');
      const js = op.kind === 'convert'
        ? { js: op.style === 'mbr' ? 'gptToMbr' : 'mbrToGpt', note: `Convertir la tabla a ${op.style.toUpperCase()} sin borrar datos` }
        : { js: 'logicalToPrimary', start: part.start, note: `Convertir ${part.id} en partición primaria` };
      steps.push({
        ...js, device: disk.rawPath, sectorSize: disk.sectorSize, diskSize: disk.size,
        before: [{ cmd: DISKUTIL, args: ['unmountDisk', 'force', disk.id] }],
        after: [{ cmd: DISKUTIL, args: ['mountDisk', disk.id], ignoreError: true }],
      });
      break;
    }
    case 'active':
    case 'hide':
    case 'letter':
      throw new Error('Esta operación no está disponible en macOS.');
    default:
      throw new Error(`Operación no compatible: ${op.kind}`);
  }
  return steps;
}

async function fsCheck(part, repair) {
  return [{ cmd: DISKUTIL, args: [repair ? 'repairVolume' : 'verifyVolume', part.id] }];
}

function trimSteps() {
  throw new Error('macOS gestiona TRIM automáticamente en los SSD de Apple; para discos externos usa "trimforce" desde Terminal.');
}

async function prepareRawWrite(disk) {
  await runOk(DISKUTIL, ['unmountDisk', 'force', disk.id]);
}

async function afterRawWrite(disk) {
  await run(DISKUTIL, ['mountDisk', disk.id]);
}

function scriptLine(step) {
  if (step.post) return `# después: formatear la nueva partición como ${step.fs}`;
  return [step.cmd, ...step.args].map(shQuote).join(' ');
}

module.exports = {
  name: 'darwin', listDisks, plan, fsCheck, trimSteps, prepareRawWrite, afterRawWrite, scriptLine,
  scriptHeader: '#!/bin/sh\n# Script generado por Maneja Discos — ejecútalo con sudo\nset -e\n',
  fileSystems: ['apfs', 'hfs', 'exfat', 'fat32', 'ntfs', 'ext4'],
  _computeFree: computeFree,
  _plistArgs: plistArgs,
};
