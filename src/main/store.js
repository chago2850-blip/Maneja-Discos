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
// Persistencia local (JSON en la carpeta de datos de la app).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, safeStorage } = require('electron');

const dir = () => app.getPath('userData');
const file = (name) => path.join(dir(), `${name}.json`);

function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}

function write(name, data) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${file(name)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(name));
}

const DEFAULT_SETTINGS = () => ({
  backupDir: path.join(os.homedir(), 'Copias Maneja Discos'),
  reportsDir: path.join(app.getPath('documents'), 'Informes Maneja Discos'),
  compression: 3,
  splitSizeMB: 0,
  verifyAfterBackup: true,
  theme: 'system',
  minimizeToTray: true,
  runMissed: true,
  startAtLogin: false,
  alignment: 'mib',
  confirmTyping: true,
});

const settings = {
  get() { return { ...DEFAULT_SETTINGS(), ...read('settings', {}) }; },
  set(patch) {
    const next = { ...settings.get(), ...patch };
    write('settings', next);
    return next;
  },
};

const sets = {
  list() { return read('sets', []); },
  add(setDir) {
    const all = sets.list().filter((d) => d !== setDir);
    all.unshift(setDir);
    write('sets', all);
  },
  remove(setDir) { write('sets', sets.list().filter((d) => d !== setDir)); },
};

const schedules = {
  list() { return read('schedules', []); },
  save(s) {
    const all = schedules.list();
    const i = all.findIndex((x) => x.id === s.id);
    if (i >= 0) all[i] = { ...all[i], ...s }; else all.push(s);
    write('schedules', all);
    return s;
  },
  remove(id) { write('schedules', schedules.list().filter((x) => x.id !== id)); },
};

const activity = {
  list() { return read('activity', []); },
  add(entry) {
    const all = activity.list();
    all.unshift(entry);
    write('activity', all.slice(0, 300));
  },
  update(id, patch) {
    const all = activity.list();
    const e = all.find((x) => x.id === id);
    if (e) Object.assign(e, patch);
    write('activity', all);
  },
  clear() { write('activity', []); },
};

/** Contraseñas de trabajos programados cifradas con el llavero del sistema. */
const secrets = {
  encrypt(text) {
    if (!text) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.encryptString(text).toString('base64');
  },
  decrypt(b64) {
    if (!b64) return null;
    try { return safeStorage.decryptString(Buffer.from(b64, 'base64')); } catch { return null; }
  },
};

module.exports = { settings, sets, schedules, activity, secrets, read, write };
