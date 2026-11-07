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
// Operaciones pendientes: validar, generar script y aplicar.
const platform = require('./platform');
const { run, powershellOk, runOk, MiB } = require('./util');

const KIND_TITLE = {
  init: 'Inicializar disco', create: 'Crear partición', format: 'Formatear', delete: 'Eliminar partición',
  label: 'Cambiar etiqueta', letter: 'Cambiar letra', resize: 'Redimensionar', active: 'Marcar activa',
  hide: 'Ocultar/mostrar', convert: 'Convertir tabla de particiones',
};

function describe(op) {
  const t = KIND_TITLE[op.kind] || op.kind;
  const target = op.partition ? (op.partition.label || op.partition.id) : op.diskId;
  switch (op.kind) {
    case 'create': return `${t} de ${(op.size / 1e9).toFixed(1)} GB (${op.fs || 'sin formato'}${op.label ? `, "${op.label}"` : ''}) en ${op.diskId}`;
    case 'format': return `${t} ${target} como ${op.fs}${op.label ? ` "${op.label}"` : ''}`;
    case 'label': return `${t} de ${target} a "${op.label}"`;
    case 'resize': return `${t} ${target} a ${(op.size / 1e9).toFixed(2)} GB`;
    case 'init': case 'convert': return `${t} ${op.diskId} a ${op.style.toUpperCase()}`;
    case 'letter': return `${t} de ${target} a ${op.letter ? `${op.letter}:` : '(ninguna)'}`;
    default: return `${t} ${target}`;
  }
}

/** Reglas de seguridad antes de encolar o aplicar. */
function validate(op, disk) {
  if (!disk) throw new Error('El disco ya no está disponible.');
  if (disk.readOnly) throw new Error('El disco es de solo lectura.');
  const sys = disk.isSystem;
  if (['init', 'convert'].includes(op.kind) && sys && !(op.kind === 'convert' && process.platform === 'win32')) {
    throw new Error('No se puede inicializar ni convertir el disco del sistema en uso.');
  }
  if (op.partition) {
    const p = op.partition;
    if (p.flags && p.flags.system && ['format', 'delete', 'resize'].includes(op.kind)) {
      throw new Error('Esta partición pertenece al sistema en ejecución y no se puede modificar.');
    }
  }
  if (op.kind === 'create') {
    if (!disk.free.some((f) => op.start >= f.start - MiB && op.start + op.size <= f.start + f.size + MiB)) {
      throw new Error('La nueva partición no cabe en el espacio libre seleccionado.');
    }
    if (op.size < MiB) throw new Error('La partición debe tener al menos 1 MB.');
  }
  if (op.kind === 'resize') {
    const p = op.partition;
    const after = disk.free.find((f) => Math.abs(f.start - (p.start + p.size)) < MiB);
    const max = p.size + (after ? after.size : 0);
    if (op.size > max) throw new Error(`El tamaño máximo posible es ${(max / 1e9).toFixed(2)} GB.`);
    if (p.used != null && op.size < p.used + 64 * MiB) throw new Error('El nuevo tamaño es menor que el espacio ocupado.');
  }
  return true;
}

function script(ops, disks, platformName = process.platform) {
  const plat = platform.get(platformName);
  const lines = [plat.scriptHeader];
  for (const op of ops) {
    const disk = disks.find((d) => d.id === op.diskId);
    lines.push(`\n# ${describe(op)}`);
    try {
      for (const step of plat.plan(op, disk)) lines.push(plat.scriptLine(step));
    } catch (e) {
      lines.push(`# ⚠ ${e.message}`);
    }
  }
  return lines.join('\n') + '\n';
}

async function execStep(step, emit) {
  if (step.ps) {
    emit({ type: 'log', message: `PS> ${step.ps}` });
    const r = await powershellOk(step.ps);
    if (r.stdout.trim()) emit({ type: 'log', message: r.stdout.trim() });
    return;
  }
  emit({ type: 'log', message: `$ ${step.cmd} ${step.args.join(' ')}` });
  const r = await run(step.cmd, step.args, { input: step.input });
  const ok = (step.okCodes || [0]).includes(r.code);
  const out = (r.stdout + r.stderr).trim();
  if (out) emit({ type: 'log', message: out.split('\n').slice(-15).join('\n') });
  if (!ok && !step.ignoreError) {
    throw new Error(`${step.cmd} falló (código ${r.code})${out ? `: ${out.split('\n').slice(-3).join(' ')}` : ''}`);
  }
}

/** Aplica la cola en orden. Antes de cada operación vuelve a leer los discos. */
async function apply(ops, emit, isCancelled = () => false) {
  const plat = platform.current();
  const results = [];
  for (let i = 0; i < ops.length; i++) {
    if (isCancelled()) throw new Error('Cancelado');
    const op = { ...ops[i] };
    emit({ type: 'progress', pct: (i / ops.length) * 100, message: describe(op), done: i, total: ops.length });
    const disks = await plat.listDisks();
    const disk = disks.find((d) => d.id === op.diskId);
    if (op.partition) {
      const fresh = disk && disk.partitions.find((p) => Math.abs(p.start - op.partition.start) < MiB);
      if (!fresh) throw new Error(`No se encontró la partición de "${describe(op)}". La cola se detuvo.`);
      op.partition = fresh;
    }
    validate(op, disk);
    for (const step of plat.plan(op, disk)) {
      if (step.post === 'formatNewPartition') {
        const again = (await plat.listDisks()).find((d) => d.id === op.diskId);
        const created = again && again.partitions.find((p) => Math.abs(p.start - op.start) < 2 * MiB);
        if (!created) throw new Error('No se encontró la partición recién creada.');
        const sub = plat.plan({ kind: 'format', fs: step.fs, label: step.label, diskId: op.diskId, partition: created }, again);
        for (const s of sub) await execStep(s, emit);
        continue;
      }
      await execStep(step, emit);
    }
    results.push({ op: describe(op), ok: true });
    emit({ type: 'log', message: `✓ ${describe(op)}` });
  }
  emit({ type: 'progress', pct: 100, message: 'Operaciones aplicadas', done: ops.length, total: ops.length });
  return results;
}

async function fsCheck(diskId, partStart, repair, emit) {
  const plat = platform.current();
  const disk = (await plat.listDisks()).find((d) => d.id === diskId);
  const part = disk && disk.partitions.find((p) => Math.abs(p.start - partStart) < MiB);
  if (!part) throw new Error('No se encontró la partición.');
  if (repair && part.flags && part.flags.system && process.platform !== 'win32') throw new Error('No se puede reparar la partición del sistema en uso.');
  const steps = await plat.fsCheck(part, repair);
  let output = '';
  for (const step of steps) {
    if (step.ps) {
      const r = await powershellOk(step.ps).catch((e) => ({ stdout: e.message }));
      output += r.stdout;
    } else {
      const r = await run(step.cmd, step.args);
      output += r.stdout + r.stderr;
      if (!(step.okCodes || [0]).includes(r.code) && step.cmd !== 'umount') {
        emit({ type: 'log', message: output });
        return { ok: false, code: r.code, output };
      }
    }
  }
  emit({ type: 'log', message: output });
  return { ok: true, output };
}

async function trim(diskId, partStart, emit) {
  const plat = platform.current();
  const disk = (await plat.listDisks()).find((d) => d.id === diskId);
  const target = partStart == null ? disk : disk && disk.partitions.find((p) => Math.abs(p.start - partStart) < MiB);
  if (!target) throw new Error('No se encontró el destino.');
  for (const step of plat.trimSteps(target)) await execStep(step, emit);
  return { ok: true };
}

module.exports = { describe, validate, script, apply, fsCheck, trim, KIND_TITLE, runOk };
