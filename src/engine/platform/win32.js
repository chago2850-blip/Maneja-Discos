'use strict';
// Adaptador Windows: cmdlets de almacenamiento de PowerShell (Get-Disk, New-Partition, Format-Volume…).
const { powershellOk, MiB, psQuote } = require('../util');

const FS_NAME = { ntfs: 'NTFS', fat32: 'FAT32', exfat: 'exFAT', refs: 'ReFS' };

const LIST_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$phys = @{}
Get-PhysicalDisk | ForEach-Object { $phys[[string]$_.DeviceId] = [string]$_.MediaType }
$disks = @(Get-Disk | ForEach-Object {
  [pscustomobject]@{ Number=$_.Number; FriendlyName=$_.FriendlyName; SerialNumber=$_.SerialNumber; Size=$_.Size;
    PartitionStyle=[string]$_.PartitionStyle; BusType=[string]$_.BusType; IsSystem=$_.IsSystem; IsBoot=$_.IsBoot;
    IsOffline=$_.IsOffline; IsReadOnly=$_.IsReadOnly; LogicalSectorSize=$_.LogicalSectorSize; MediaType=$phys[[string]$_.Number] }
})
$parts = @(Get-Partition | ForEach-Object {
  $v = $null; try { $v = $_ | Get-Volume -ErrorAction Stop } catch {}
  [pscustomobject]@{ DiskNumber=$_.DiskNumber; PartitionNumber=$_.PartitionNumber; Offset=$_.Offset; Size=$_.Size;
    DriveLetter=[string]$_.DriveLetter; Type=[string]$_.Type; GptType=$_.GptType; MbrType=$_.MbrType; IsActive=$_.IsActive;
    IsHidden=$_.IsHidden; IsBoot=$_.IsBoot; IsSystem=$_.IsSystem; FileSystem=$v.FileSystem; Label=$v.FileSystemLabel;
    VolSize=$v.Size; Remaining=$v.SizeRemaining }
})
[pscustomobject]@{ disks=$disks; parts=$parts } | ConvertTo-Json -Depth 4 -Compress
`;

function letterOf(s) {
  const c = (s || '').replace(/\u0000/g, '').trim();
  return /^[A-Z]$/i.test(c) ? c.toUpperCase() : null;
}

function normFs(fs) {
  if (!fs) return null;
  const f = String(fs).toLowerCase();
  return f === 'fat' ? 'fat16' : f;
}

async function listDisks() {
  const r = await powershellOk(LIST_SCRIPT);
  const data = JSON.parse(r.stdout || '{}');
  const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  const parts = arr(data.parts);
  return arr(data.disks).map((d) => {
    const ps = parts.filter((p) => p.DiskNumber === d.Number).map((p) => {
      const letter = letterOf(p.DriveLetter);
      return {
        id: `${d.Number}:${p.PartitionNumber}`,
        path: `\\\\.\\PhysicalDrive${d.Number}`,
        number: p.PartitionNumber,
        start: Number(p.Offset),
        size: Number(p.Size),
        fs: normFs(p.FileSystem),
        label: p.Label || '',
        mountpoint: letter ? `${letter}:\\` : null,
        letter,
        used: p.VolSize != null && p.Remaining != null ? Number(p.VolSize) - Number(p.Remaining) : null,
        type: p.Type || '',
        flags: { system: !!(p.IsSystem || p.IsBoot) || (letter && letter === (process.env.SystemDrive || 'C:')[0]), active: !!p.IsActive, hidden: !!p.IsHidden, boot: !!p.IsBoot },
      };
    }).sort((a, b) => a.start - b.start);
    const style = String(d.PartitionStyle || '').toUpperCase();
    return {
      id: String(d.Number),
      number: d.Number,
      path: `\\\\.\\PhysicalDrive${d.Number}`,
      rawPath: `\\\\.\\PhysicalDrive${d.Number}`,
      name: `Disco ${d.Number}`,
      model: d.FriendlyName || 'Disco',
      serial: (d.SerialNumber || '').trim(),
      size: Number(d.Size),
      sectorSize: d.LogicalSectorSize || 512,
      partitionStyle: style === 'GPT' ? 'gpt' : style === 'MBR' ? 'mbr' : 'none',
      bus: d.BusType || '',
      removable: ['USB', 'SD', 'MMC'].includes(String(d.BusType).toUpperCase()),
      ssd: String(d.MediaType) === 'SSD' || String(d.MediaType) === '4',
      readOnly: !!d.IsReadOnly,
      offline: !!d.IsOffline,
      isSystem: !!(d.IsSystem || d.IsBoot),
      partitions: ps,
      free: computeFree(Number(d.Size), ps, style),
    };
  });
}

function computeFree(size, parts, style) {
  if (style !== 'GPT' && style !== 'MBR') return [];
  const free = [];
  let cursor = MiB;
  const end = style === 'GPT' ? size - MiB : size;
  for (const p of parts) {
    if (p.start - cursor >= MiB) free.push({ start: cursor, size: p.start - cursor });
    cursor = Math.max(cursor, p.start + p.size);
  }
  if (end - cursor >= MiB) free.push({ start: cursor, size: Math.floor((end - cursor) / MiB) * MiB });
  return free;
}

function plan(op, disk) {
  const n = disk.number;
  const part = op.partition;
  const getPart = part ? `(Get-Partition -DiskNumber ${n} -PartitionNumber ${part.number})` : '';
  const S = [];
  const P = (script) => S.push({ ps: script });
  const fsName = (fs) => {
    const f = FS_NAME[fs];
    if (!f) throw new Error(`Windows no puede formatear en ${fs}. Usa NTFS, exFAT, FAT32 o ReFS.`);
    return f;
  };
  const fmt = (target, fs, label, cluster) => `Format-Volume -Partition ${target} -FileSystem ${fsName(fs)} -NewFileSystemLabel ${psQuote(label || '')}${cluster ? ` -AllocationUnitSize ${cluster}` : ''} -Confirm:$false -Force | Out-Null`;
  switch (op.kind) {
    case 'init':
      P(`if ((Get-Disk -Number ${n}).PartitionStyle -ne 'RAW') { Clear-Disk -Number ${n} -RemoveData -RemoveOEM -Confirm:$false }`);
      P(`Initialize-Disk -Number ${n} -PartitionStyle ${op.style === 'mbr' ? 'MBR' : 'GPT'}`);
      break;
    case 'create':
      P(`$p = New-Partition -DiskNumber ${n} -Offset ${op.start} -Size ${op.size}${op.letter ? ` -DriveLetter ${op.letter}` : ' -AssignDriveLetter'}${disk.partitionStyle === 'gpt' ? '' : ''}; ${op.fs && op.fs !== 'none' ? fmt('$p', op.fs, op.label, op.cluster) : ''}`);
      break;
    case 'format':
      P(fmt(getPart, op.fs, op.label, op.cluster));
      break;
    case 'delete':
      P(`Remove-Partition -DiskNumber ${n} -PartitionNumber ${part.number} -Confirm:$false`);
      break;
    case 'label':
      P(`${getPart} | Get-Volume | Set-Volume -NewFileSystemLabel ${psQuote(op.label)}`);
      break;
    case 'letter':
      if (op.letter) P(`Set-Partition -DiskNumber ${n} -PartitionNumber ${part.number} -NewDriveLetter ${op.letter}`);
      else if (part.letter) P(`Remove-PartitionAccessPath -DiskNumber ${n} -PartitionNumber ${part.number} -AccessPath '${part.letter}:\\'`);
      break;
    case 'resize':
      P(`Resize-Partition -DiskNumber ${n} -PartitionNumber ${part.number} -Size ${op.size}`);
      break;
    case 'active':
      if (disk.partitionStyle !== 'mbr') throw new Error('La partición activa solo existe en discos MBR.');
      P(`Set-Partition -DiskNumber ${n} -PartitionNumber ${part.number} -IsActive $${op.value ? 'true' : 'false'}`);
      break;
    case 'hide':
      P(`Set-Partition -DiskNumber ${n} -PartitionNumber ${part.number} -IsHidden $${op.value ? 'true' : 'false'}`);
      break;
    case 'convert':
      if (!disk.partitions.length) P(`Set-Disk -Number ${n} -PartitionStyle ${op.style === 'mbr' ? 'MBR' : 'GPT'}`);
      else if (op.style === 'gpt' && disk.isSystem) S.push({ cmd: 'mbr2gpt.exe', args: ['/convert', `/disk:${n}`, '/allowFullOS'] });
      else throw new Error('Windows solo convierte sin borrar el disco del sistema de MBR a GPT (mbr2gpt). Para otros discos con particiones, respalda y usa "Inicializar disco".');
      break;
    default:
      throw new Error(`Operación no compatible: ${op.kind}`);
  }
  return S;
}

async function fsCheck(part, repair) {
  return [{ ps: `(Get-Partition -DiskNumber ${part.id.split(':')[0]} -PartitionNumber ${part.number}) | Get-Volume | Repair-Volume ${repair ? '-OfflineScanAndFix' : '-Scan'}` }];
}

function trimSteps(target) {
  if (!target.letter) throw new Error('Asigna una letra de unidad al volumen para ejecutar TRIM.');
  return [{ ps: `Optimize-Volume -DriveLetter ${target.letter} -ReTrim -Verbose` }];
}

/** Windows bloquea escrituras en crudo sobre volúmenes montados: poner el disco fuera de línea. */
async function prepareRawWrite(disk) {
  if (disk.isSystem) throw new Error('No se puede escribir en crudo en el disco del sistema mientras Windows está en ejecución.');
  await powershellOk(`Set-Disk -Number ${disk.number} -IsReadOnly $false; Set-Disk -Number ${disk.number} -IsOffline $true`);
}

async function afterRawWrite(disk) {
  await powershellOk(`Set-Disk -Number ${disk.number} -IsOffline $false; Update-HostStorageCache`).catch(() => {});
}

function scriptLine(step) {
  if (step.ps) return step.ps;
  return [step.cmd, ...step.args].join(' ');
}

module.exports = {
  name: 'win32', listDisks, plan, fsCheck, trimSteps, prepareRawWrite, afterRawWrite, scriptLine,
  scriptHeader: '# Script generado por Maneja Discos — ejecútalo en PowerShell como administrador\n$ErrorActionPreference = "Stop"\n',
  fileSystems: ['ntfs', 'exfat', 'fat32', 'refs'],
  _computeFree: computeFree,
};
