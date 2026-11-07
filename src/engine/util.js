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
// Utilidades comunes del motor. Solo módulos integrados de Node: el motor se copia y se
// ejecuta con permisos de administrador sin node_modules.
const { spawn } = require('child_process');
const fs = require('fs');

/** Ejecuta un programa sin shell. Devuelve { code, stdout, stderr }. */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...(opts.env || {}) },
        windowsHide: true,
        cwd: opts.cwd,
      });
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: String(err.message || err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; if (opts.onOutput) opts.onOutput(String(d)); });
    child.stderr.on('data', (d) => { stderr += d; if (opts.onOutput) opts.onOutput(String(d)); });
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + String(err.message || err) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Igual que run, pero lanza un error si el código de salida no es 0. */
async function runOk(cmd, args = [], opts = {}) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-6).join('\n');
    const err = new Error(`${cmd} ${args.join(' ')} → código ${r.code}${msg ? `\n${msg}` : ''}`);
    err.code = r.code;
    err.output = r.stderr + r.stdout;
    throw err;
  }
  return r;
}

async function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

async function powershellOk(script) {
  const r = await powershell(script);
  if (r.code !== 0) {
    const err = new Error((r.stderr || r.stdout || `PowerShell código ${r.code}`).trim());
    err.output = r.stderr + r.stdout;
    throw err;
  }
  return r;
}

function formatBytes(n) {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = Number(n);
  while (Math.abs(v) >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function formatDuration(s) {
  if (!isFinite(s) || s < 0) return '—';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${sec} s`;
  return `${sec} s`;
}

const MiB = 1024 * 1024;
const alignDown = (n, a) => Math.floor(n / a) * a;
const alignUp = (n, a) => Math.ceil(n / a) * a;

/** Quoting para mostrar comandos en scripts (no se usa para ejecutar). */
function shQuote(s) {
  s = String(s);
  if (/^[A-Za-z0-9_\-./:=+,@%]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Progreso con velocidad y tiempo restante, limitado a ~4 eventos/s. */
class Progress {
  constructor(total, emit, label = '') {
    this.total = total;
    this.emit = emit;
    this.label = label;
    this.done = 0;
    this.start = Date.now();
    this.last = 0;
  }
  add(n, message) { this.set(this.done + n, message); }
  set(done, message, force = false) {
    this.done = done;
    const now = Date.now();
    if (!force && now - this.last < 250 && done < this.total) return;
    this.last = now;
    const elapsed = (now - this.start) / 1000;
    const speed = elapsed > 0 ? done / elapsed : 0;
    const eta = speed > 0 && this.total ? (this.total - done) / speed : null;
    this.emit({
      type: 'progress',
      label: this.label,
      message,
      done,
      total: this.total,
      pct: this.total ? Math.min(100, (done / this.total) * 100) : null,
      speed,
      eta,
    });
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSON(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function newId(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

class CancelledError extends Error {
  constructor() { super('Operación cancelada por el usuario'); this.cancelled = true; }
}

module.exports = {
  run, runOk, powershell, powershellOk, formatBytes, formatDuration, MiB, alignDown, alignUp,
  shQuote, psQuote, Progress, ensureDir, readJSON, writeJSON, newId, CancelledError,
};
