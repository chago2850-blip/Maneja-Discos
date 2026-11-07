'use strict';
// Ejecuta trabajos del motor en un proceso aparte, con o sin permisos de administrador,
// y retransmite el progreso a la interfaz.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { app } = require('electron');
const store = require('./store');

const running = new Map();
const waiters = new Map();
const finished = new Map();
let listener = () => {};
const onEvent = (fn) => { listener = fn; };

/** Copia el motor a una carpeta temporal legible por root (necesario en AppImage y asar). */
function engineDir() {
  const src = path.join(__dirname, '..', 'engine');
  const dest = path.join(os.tmpdir(), `maneja-discos-motor-${app.getVersion()}-${process.getuid ? process.getuid() : 'w'}`);
  const stamp = path.join(dest, '.stamp');
  const want = `${app.getVersion()}:${fs.statSync(path.join(src, 'worker.js')).mtimeMs}`;
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) return dest;
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const a = path.join(from, name);
      const b = path.join(to, name);
      if (fs.statSync(a).isDirectory()) copy(a, b);
      else fs.writeFileSync(b, fs.readFileSync(a));
    }
  };
  copy(src, dest);
  fs.writeFileSync(stamp, want);
  return dest;
}

function nodeExe() {
  // En AppImage, root no puede leer el montaje FUSE del usuario: se relanza el propio AppImage.
  return process.env.APPIMAGE || process.execPath;
}

function isAdmin() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') execFile('net', ['session'], { windowsHide: true }, (err) => resolve(!err));
    else resolve(process.getuid && process.getuid() === 0);
  });
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

async function launch({ elevated, worker, jobFile, progressFile, cancelFile }) {
  const exe = nodeExe();
  const args = [worker, jobFile, progressFile, cancelFile];
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  if (!elevated || (await isAdmin())) {
    return spawn(exe, args, { env, stdio: 'ignore', windowsHide: true });
  }
  if (process.platform === 'linux') {
    return spawn('pkexec', ['env', 'ELECTRON_RUN_AS_NODE=1', `DISPLAY=${process.env.DISPLAY || ''}`, exe, ...args], { stdio: 'ignore' });
  }
  if (process.platform === 'darwin') {
    const cmd = `ELECTRON_RUN_AS_NODE=1 ${[exe, ...args].map(shq).join(' ')}`;
    const script = `do shell script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with prompt "Maneja Discos necesita permisos de administrador para acceder a los discos." with administrator privileges`;
    return spawn('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' });
  }
  // Windows: UAC mediante un .cmd (Start-Process -Verb RunAs no hereda variables de entorno)
  const cmdFile = path.join(path.dirname(jobFile), `${path.basename(jobFile, '.json')}.cmd`);
  const q = (s) => `"${s}"`;
  fs.writeFileSync(cmdFile, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n${[exe, ...args].map(q).join(' ')}\r\n`);
  const ps = `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','"${cmdFile}"' -Verb RunAs -WindowStyle Hidden -Wait`;
  return spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'ignore', windowsHide: true });
}

/**
 * Lanza un trabajo. meta: { title, elevated, kind }
 * Devuelve el id; los eventos llegan por onEvent(jobId, ev).
 */
async function start(job, meta) {
  const id = `job-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maneja-discos-'));
  const jobFile = path.join(tmp, 'trabajo.json');
  const progressFile = path.join(tmp, 'progreso.jsonl');
  const cancelFile = path.join(tmp, 'cancelar');
  const owner = process.getuid ? { uid: process.getuid(), gid: process.getgid() } : null;
  fs.writeFileSync(jobFile, JSON.stringify({ ...job, owner }), { mode: 0o600 });
  fs.writeFileSync(progressFile, '');
  try { fs.chmodSync(tmp, 0o755); fs.chmodSync(progressFile, 0o666); } catch { /* Windows */ }

  const entry = { id, title: meta.title, kind: meta.kind || job.type, started: new Date().toISOString(), status: 'running', log: [], last: null };
  running.set(id, { ...entry, tmp, cancelFile });
  store.activity.add({ ...entry });
  listener(id, { type: 'start', title: meta.title, kind: entry.kind });

  let child;
  try {
    child = await launch({ elevated: !!meta.elevated, worker: path.join(engineDir(), 'worker.js'), jobFile, progressFile, cancelFile });
  } catch (err) {
    finish(id, { type: 'done', ok: false, error: `No se pudo iniciar: ${err.message}` });
    return id;
  }

  let offset = 0;
  let done = false;
  let exited = false;
  const pump = () => {
    let data = '';
    try {
      const fd = fs.openSync(progressFile, 'r');
      const size = fs.fstatSync(fd).size;
      if (size > offset) {
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = size;
        data = buf.toString('utf8');
      }
      fs.closeSync(fd);
    } catch { /* aún no existe */ }
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const r = running.get(id);
      if (r) {
        if (ev.type === 'log') r.log.push(ev.message);
        if (ev.type === 'progress') r.last = ev;
      }
      if (ev.type === 'done') { done = true; finish(id, ev); } else listener(id, ev);
    }
  };
  const timer = setInterval(() => {
    pump();
    if (done) clearInterval(timer);
    else if (exited) {
      pump();
      if (!done) {
        finish(id, { type: 'done', ok: false, error: fs.existsSync(cancelFile) ? 'Cancelado' : 'El proceso terminó sin resultado. ¿Se canceló la autorización de administrador?' });
      }
      clearInterval(timer);
    }
  }, 200);
  child.on('exit', () => { setTimeout(() => { exited = true; }, 400); });
  child.on('error', (err) => { finish(id, { type: 'done', ok: false, error: err.message }); clearInterval(timer); done = true; });
  return id;
}

function finish(id, ev) {
  const r = running.get(id);
  if (!r) return;
  running.delete(id);
  const status = ev.ok ? 'ok' : ev.cancelled || /cancel/i.test(ev.error || '') ? 'cancelled' : 'error';
  store.activity.update(id, {
    finished: new Date().toISOString(),
    status,
    error: ev.error || null,
    log: r.log.slice(-80),
    result: summarize(ev.result),
    reportPath: ev.result && ev.result.reportPath,
  });
  setTimeout(() => fs.rm(r.tmp, { recursive: true, force: true }, () => {}), 5000);
  const final = { ...ev, status };
  finished.set(id, final);
  setTimeout(() => finished.delete(id), 60000);
  listener(id, final);
  const w = waiters.get(id);
  if (w) { waiters.delete(id); w(final); }
}

function summarize(result) {
  if (!result || typeof result !== 'object') return null;
  const { disks, cells, report, ...rest } = result;
  return JSON.parse(JSON.stringify(rest, (k, v) => (Array.isArray(v) && v.length > 50 ? `[${v.length}]` : v)));
}

function cancel(id) {
  const r = running.get(id);
  if (r) fs.writeFileSync(r.cancelFile, '1');
}

/** Ejecuta un trabajo y espera el resultado (para el programador y operaciones cortas). */
async function runAndWait(job, meta) {
  const id = await start(job, meta);
  if (finished.has(id)) return finished.get(id);
  return new Promise((resolve) => waiters.set(id, resolve));
}

module.exports = { start, cancel, onEvent, runAndWait, running: () => [...running.values()].map(({ tmp, cancelFile, ...r }) => r), isAdmin };
