'use strict';
// Proceso de trabajo de Maneja Discos. Se ejecuta (a menudo con permisos de administrador) como:
//   node worker.js <trabajo.json> <progreso.jsonl> [<archivo-de-cancelación>]
// y escribe eventos JSON (uno por línea) en el archivo de progreso y en stdout.
const fs = require('fs');
const os = require('os');
const platform = require('./platform');
const partition = require('./partition');
const imaging = require('./imaging');
const filebackup = require('./filebackup');
const wipe = require('./wipe');
const surface = require('./surface');
const BS = require('./backupset');

async function resolveTarget(t) {
  // t: { kind:'disk'|'partition'|'file', diskId?, partStart?, path? }
  if (t.kind === 'file') {
    const size = fs.existsSync(t.path) ? fs.statSync(t.path).size : null;
    return { path: t.path, offset: 0, length: t.length ?? size, info: { label: t.path } };
  }
  const plat = platform.current();
  const disks = await plat.listDisks();
  const disk = disks.find((d) => d.id === t.diskId);
  if (!disk) throw new Error(`El disco ${t.diskId} ya no está conectado.`);
  if (t.kind === 'disk') {
    return { path: disk.rawPath, offset: 0, length: disk.size, disk, info: { kind: 'disk', model: disk.model, serial: disk.serial, size: disk.size, partitionStyle: disk.partitionStyle, label: disk.model } };
  }
  const part = disk.partitions.find((p) => Math.abs(p.start - t.partStart) < 1024 * 1024);
  if (!part) throw new Error('La partición ya no existe.');
  return { path: disk.rawPath, offset: part.start, length: part.size, disk, part, info: { kind: 'partition', model: disk.model, serial: disk.serial, fs: part.fs, label: part.label || part.id, size: part.size } };
}

function guardWrite(t) {
  if (!t.disk) return;
  if (t.disk.readOnly) throw new Error('El disco de destino es de solo lectura.');
  if (t.disk.isSystem && (!t.part || t.part.flags?.system || t.part.mountpoint === '/')) {
    throw new Error('No se puede escribir sobre el disco/partición del sistema en ejecución. Usa un medio de arranque.');
  }
}

async function runJob(job, emit, isCancelled) {
  const plat = () => platform.current();
  switch (job.type) {
    case 'list-disks':
      return { disks: await plat().listDisks() };

    case 'apply-ops':
      return { results: await partition.apply(job.ops, emit, isCancelled) };

    case 'fscheck':
      return partition.fsCheck(job.diskId, job.partStart, job.repair, emit);

    case 'trim':
      return partition.trim(job.diskId, job.partStart, emit);

    case 'image-backup': {
      let source;
      if (job.setDir) {
        const set = BS.load(job.setDir);
        const t = await resolveTarget(set.source.target);
        source = { path: t.path, offset: t.offset, length: t.length };
        if (t.length !== set.source.length) throw new Error('El tamaño del origen cambió desde la copia completa. Crea una copia completa nueva.');
        return imaging.backup({ setDir: job.setDir, type: job.backupType, password: job.password, sourceOverride: source }, emit, isCancelled);
      }
      const t = await resolveTarget(job.source);
      source = { path: t.path, offset: t.offset, length: t.length, target: job.source, ...t.info };
      return imaging.backup({ destDir: job.destDir, name: job.name, password: job.password, level: job.level, splitSize: job.splitSize, source }, emit, isCancelled);
    }

    case 'image-restore': {
      const t = await resolveTarget(job.target);
      guardWrite(t);
      if (t.disk) await plat().prepareRawWrite(t.disk, t.part ? { offset: t.offset, length: t.length } : null);
      try {
        const r = await imaging.restore({ setDir: job.setDir, pointId: job.pointId, password: job.password, target: { path: t.path, offset: t.offset, length: t.length }, verifyAfter: job.verify }, emit, isCancelled);
        return job.target.kind === 'file' ? { ...r, outputPath: job.target.path } : r;
      } finally {
        if (t.disk) await plat().afterRawWrite(t.disk, { wholeDisk: !t.part, grow: true }).catch(() => {});
      }
    }

    case 'image-verify':
      return imaging.verify({ setDir: job.setDir, pointId: job.pointId, password: job.password }, emit, isCancelled);

    case 'file-backup':
      if (job.setDir) return filebackup.backup({ setDir: job.setDir, type: job.backupType, password: job.password }, emit, isCancelled);
      return filebackup.backup({ destDir: job.destDir, name: job.name, sources: job.sources, exclude: job.exclude, password: job.password, level: job.level, splitSize: job.splitSize }, emit, isCancelled);

    case 'file-restore':
      return filebackup.restore(job, emit, isCancelled);

    case 'file-verify':
      return filebackup.verify(job, emit, isCancelled);

    case 'retention': {
      const set = BS.load(job.setDir);
      return { removed: BS.applyRetention(set, job.retention) };
    }

    case 'clone': {
      const s = await resolveTarget(job.source);
      const t = await resolveTarget(job.target);
      guardWrite(t);
      if (s.disk && t.disk && s.disk.id === t.disk.id && !(t.offset >= s.offset + s.length || s.offset >= t.offset + t.length)) {
        throw new Error('El origen y el destino se solapan.');
      }
      if (t.length != null && t.length < s.length) throw new Error(`El destino (${(t.length / 1e9).toFixed(1)} GB) es más pequeño que el origen (${(s.length / 1e9).toFixed(1)} GB).`);
      if (t.disk) await plat().prepareRawWrite(t.disk, t.part ? { offset: t.offset, length: t.length } : null);
      try {
        return await imaging.copyRegion({ source: s, target: t, verifyAfter: job.verify }, emit, isCancelled);
      } finally {
        if (t.disk) await plat().afterRawWrite(t.disk, { wholeDisk: !t.part, grow: (t.length || 0) > s.length }).catch(() => {});
      }
    }

    case 'write-image': {
      // Grabar un archivo .iso/.img en un disco (medio de rescate)
      const size = fs.statSync(job.imagePath).size;
      const t = await resolveTarget(job.target);
      guardWrite(t);
      if (t.disk) await plat().prepareRawWrite(t.disk, null);
      try {
        return await imaging.copyRegion({ source: { path: job.imagePath, offset: 0, length: size }, target: { path: t.path, offset: 0, length: t.length }, verifyAfter: job.verify }, emit, isCancelled);
      } finally {
        if (t.disk) await plat().afterRawWrite(t.disk, {}).catch(() => {});
      }
    }

    case 'wipe': {
      const algo = wipe.resolveAlgorithm(job.algorithm);
      const t0 = new Date();
      let result;
      let targetLabel;
      let model = '';
      let serial = '';
      if (job.mode === 'files') {
        targetLabel = job.paths.join(', ');
        result = wipe.wipeFiles(job.paths, algo, emit, isCancelled);
      } else if (job.mode === 'free') {
        targetLabel = `Espacio libre de ${job.mountpoint}`;
        result = wipe.wipeFreeSpace(job.mountpoint, algo, emit, isCancelled);
      } else {
        const t = await resolveTarget(job.target);
        guardWrite(t);
        model = t.disk?.model || '';
        serial = t.disk?.serial || '';
        targetLabel = t.part ? `${t.part.label || t.part.id} (${t.disk.model})` : `${t.disk ? t.disk.model : t.path}`;
        if (t.disk) await plat().prepareRawWrite(t.disk, t.part ? { offset: t.offset, length: t.length } : null);
        try {
          const stamp = job.stamp && !t.part ? `${algo.name} ${t0.toISOString()} ${serial}` : null;
          result = wipe.wipeRegion({ path: t.path, offset: t.offset, length: t.length }, algo, emit, isCancelled, { verifyPercent: job.verifyPercent || 0, stamp });
        } finally {
          if (t.disk) await plat().afterRawWrite(t.disk, {}).catch(() => {});
        }
      }
      const report = {
        id: `${Date.now()}`, started: t0.toISOString(), finished: new Date().toISOString(), host: os.hostname(),
        target: targetLabel, model, serial, mode: { region: 'Disco o partición completa', free: 'Solo espacio libre', files: 'Archivos y carpetas' }[job.mode || 'region'],
        algorithm: algo.name, passes: algo.passes.length, bytes: result.bytes, seconds: result.seconds,
        verification: result.verification || null, ok: !result.verification || result.verification.ok,
      };
      const reportPath = job.reportDir ? wipe.writeReport(job.reportDir, report) : null;
      return { ...result, report, reportPath };
    }

    case 'surface': {
      const t = await resolveTarget(job.target);
      return surface.surfaceTest({ path: t.path, offset: t.offset, length: t.length }, emit, isCancelled, { sector: t.disk?.sectorSize || 512 });
    }

    default:
      throw new Error(`Trabajo desconocido: ${job.type}`);
  }
}

/** Si el trabajo corrió como root, devolver al usuario los archivos que creó (copias, informes). */
function giveBack(owner, result) {
  if (!owner || !process.getuid || process.getuid() !== 0 || owner.uid === 0 || !result) return;
  const chownR = (p) => {
    try {
      fs.lchownSync(p, owner.uid, owner.gid);
      if (fs.lstatSync(p).isDirectory()) for (const f of fs.readdirSync(p)) chownR(require('path').join(p, f));
    } catch { /* sin acceso */ }
  };
  if (result.setDir) chownR(result.setDir);
  if (result.reportPath) {
    const dir = require('path').dirname(result.reportPath);
    chownR(dir);
  }
  if (result.outputPath) chownR(result.outputPath);
}

async function main() {
  const [jobFile, progressFile, cancelFile] = process.argv.slice(2);
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  if (job.env) Object.assign(process.env, job.env);
  const out = progressFile ? fs.openSync(progressFile, 'a') : null;
  const emit = (ev) => {
    const line = JSON.stringify({ t: Date.now(), ...ev }) + '\n';
    if (out != null) fs.writeSync(out, line);
    if (!progressFile) process.stdout.write(line);
  };
  const isCancelled = () => !!cancelFile && fs.existsSync(cancelFile);
  try {
    const result = await runJob(job, emit, isCancelled);
    giveBack(job.owner, result);
    emit({ type: 'done', ok: true, result });
    process.exitCode = 0;
  } catch (err) {
    emit({ type: 'done', ok: false, cancelled: !!err.cancelled, needsPassword: !!err.needsPassword, error: err.message || String(err) });
    process.exitCode = err.cancelled ? 2 : 1;
  } finally {
    if (out != null) fs.closeSync(out);
    // Borrar el archivo del trabajo: puede contener contraseñas
    try { fs.unlinkSync(jobFile); } catch { /* ya borrado */ }
  }
}

if (require.main === module) main();

module.exports = { runJob, resolveTarget };
