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
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, Notification, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const jobs = require('./jobs');
const scheduler = require('./scheduler');
const platform = require('../engine/platform');
const partition = require('../engine/partition');
const wipe = require('../engine/wipe');
const BS = require('../engine/backupset');
const filebackup = require('../engine/filebackup');

let win = null;
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function asset(name) { return path.join(__dirname, '..', 'renderer', 'assets', name); }

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1040,
    minHeight: 660,
    title: 'Maneja Discos',
    icon: asset('logo.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1020' : '#f5f6fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!quitting && store.settings.get().minimizeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(asset('tray.png')).resize({ width: 18, height: 18 });
    tray = new Tray(img);
    tray.setToolTip('Maneja Discos');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir Maneja Discos', click: showWindow },
      { type: 'separator' },
      { label: 'Salir', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch { tray = null; }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, icon: asset('logo.png') }).show();
}

// ---------------- IPC ----------------

const which = (cmd) => (process.env.PATH || '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, cmd)) || fs.existsSync(path.join(d, `${cmd}.exe`)));

function registerIpc() {
  ipcMain.handle('app:info', async () => ({
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    admin: await jobs.isAdmin(),
    fileSystems: platform.current().fileSystems,
    algorithms: wipe.ALGORITHMS.map(({ id, name, passes, note }) => ({ id, name, passes: passes.length, note })),
    strategies: scheduler.STRATEGIES,
    missingTools: process.platform === 'linux'
      ? ['parted', 'sfdisk', 'sgdisk', 'mkfs.ntfs', 'mkfs.vfat', 'mkfs.exfat', 'pkexec'].filter((t) => !which(t) && !fs.existsSync(`/usr/sbin/${t}`) && !fs.existsSync(`/sbin/${t}`))
      : [],
  }));

  ipcMain.handle('app:legal', () => {
    const root = path.join(__dirname, '..', '..');
    const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return null; } };
    return { license: read('LICENSE'), thirdParty: read('THIRD_PARTY_NOTICES.md') };
  });

  ipcMain.handle('disks:list', async () => {
    try {
      return { disks: await platform.current().listDisks() };
    } catch (err) {
      return { disks: [], error: err.message };
    }
  });

  ipcMain.handle('disks:listElevated', async () => {
    const ev = await jobs.runAndWait({ type: 'list-disks' }, { title: 'Leer discos', elevated: true, kind: 'list' });
    return ev.ok ? { disks: ev.result.disks } : { disks: [], error: ev.error };
  });

  ipcMain.handle('ops:validate', (_e, op, disk) => {
    try { partition.validate(op, disk); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('ops:describe', (_e, op) => partition.describe(op));
  ipcMain.handle('ops:script', (_e, ops, disks) => partition.script(ops, disks));

  ipcMain.handle('job:start', async (_e, job, meta) => {
    for (const d of [job.destDir, job.reportDir].filter(Boolean)) fs.mkdirSync(d, { recursive: true });
    if (job.type === 'wipe' && !job.reportDir) job.reportDir = store.settings.get().reportsDir;
    if (job.reportDir) fs.mkdirSync(job.reportDir, { recursive: true });
    return jobs.start(job, meta);
  });
  ipcMain.handle('job:cancel', (_e, id) => jobs.cancel(id));
  ipcMain.handle('job:running', () => jobs.running());
  ipcMain.handle('activity:list', () => store.activity.list());
  ipcMain.handle('activity:clear', () => store.activity.clear());

  ipcMain.handle('settings:get', () => store.settings.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = store.settings.set(patch);
    if ('startAtLogin' in patch && process.platform !== 'linux') app.setLoginItemSettings({ openAtLogin: !!patch.startAtLogin, openAsHidden: true });
    if ('theme' in patch) nativeTheme.themeSource = patch.theme;
    return s;
  });

  ipcMain.handle('sets:list', () => {
    const out = [];
    for (const dir of store.sets.list()) {
      try {
        const s = BS.load(dir);
        delete s.encryption?.check;
        out.push({ ...s, encrypted: !!s.encryption, available: true });
      } catch (err) {
        out.push({ dir, name: path.basename(dir), available: false, error: err.message, points: [] });
      }
    }
    return out;
  });
  ipcMain.handle('sets:add', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Añadir una copia existente', properties: ['openDirectory'], message: 'Elige la carpeta que contiene set.json' });
    if (r.canceled) return null;
    const dir = r.filePaths[0];
    BS.load(dir);
    store.sets.add(dir);
    return dir;
  });
  ipcMain.handle('sets:register', (_e, dir) => { store.sets.add(dir); return true; });
  ipcMain.handle('sets:forget', (_e, dir) => { store.sets.remove(dir); return true; });
  ipcMain.handle('sets:deleteAll', (_e, dir) => {
    BS.load(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    store.sets.remove(dir);
    return true;
  });
  ipcMain.handle('sets:deletePoint', (_e, dir, pointId) => BS.removePoint(BS.load(dir), pointId));
  ipcMain.handle('sets:pin', (_e, dir, pointId, pinned) => { BS.setPinned(BS.load(dir), pointId, pinned); return true; });
  ipcMain.handle('sets:files', (_e, dir, pointId) => filebackup.listFiles({ setDir: dir, pointId }));

  ipcMain.handle('schedules:list', () => store.schedules.list().map((s) => ({ ...s, passwordEnc: undefined, hasPassword: !!s.passwordEnc, nextRun: s.enabled ? scheduler.nextRun(s) : null })));
  ipcMain.handle('schedules:save', (_e, s, password) => {
    const prev = store.schedules.list().find((x) => x.id === s.id);
    const data = { ...prev, ...s };
    if (password != null) data.passwordEnc = store.secrets.encrypt(password);
    if (!data.created) data.created = new Date().toISOString();
    return store.schedules.save(data);
  });
  ipcMain.handle('schedules:remove', (_e, id) => store.schedules.remove(id));
  ipcMain.handle('schedules:runNow', (_e, id) => {
    const s = store.schedules.list().find((x) => x.id === id);
    if (s) scheduler.runSchedule(s, 'manual');
    return true;
  });

  ipcMain.handle('dialog:openDir', async (_e, title) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:openPaths', async (_e, title, dirs) => {
    const r = await dialog.showOpenDialog(win, { title, properties: [dirs ? 'openDirectory' : 'openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:openFile', async (_e, title, filters) => {
    const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:saveFile', async (_e, title, defaultPath, filters) => {
    const r = await dialog.showSaveDialog(win, { title, defaultPath, filters });
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('file:saveText', async (_e, defaultName, text) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName });
    if (r.canceled) return null;
    fs.writeFileSync(r.filePath, text);
    return r.filePath;
  });
  ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:show', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('shell:external', (_e, url) => shell.openExternal(url));
}

jobs.onEvent((id, ev) => {
  send('job:event', { id, ev });
  if (ev.type === 'done' && win && !win.isVisible()) {
    notify(ev.ok ? 'Tarea terminada' : 'La tarea no se completó', ev.ok ? 'Maneja Discos terminó la operación.' : ev.error || 'Error');
  }
});

if (process.env.MD_USERDATA) app.setPath('userData', process.env.MD_USERDATA);

/** Capturas automáticas de cada vista (desarrollo): MD_SHOTS=<carpeta> */
function screenshotTour(dir) {
  const views = (process.env.MD_SHOT_VIEWS || 'home,disks,backups,schedules,clone,wipe,tools,activity,settings').split(',');
  win.webContents.once('did-finish-load', async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(2500);
    fs.mkdirSync(dir, { recursive: true });
    for (const v of views) {
      const [view, script] = v.split(':');
      await win.webContents.executeJavaScript(`go(${JSON.stringify(view)})`);
      await wait(1200);
      if (script && process.env[`MD_SHOT_JS_${script}`]) { await win.webContents.executeJavaScript(process.env[`MD_SHOT_JS_${script}`]); await wait(1200); }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `${v.replace(':', '-')}.png`), img.toPNG());
    }
    quitting = true;
    app.quit();
  });
}

app.whenReady().then(() => {
  nativeTheme.themeSource = store.settings.get().theme || 'system';
  registerIpc();
  createWindow();
  if (process.env.MD_SHOTS) screenshotTour(process.env.MD_SHOTS);
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2 && process.env.MD_SHOTS) console.error('[renderer]', message); });
  createTray();
  scheduler.start((s, ev) => {
    if (!ev.ok) notify(`Falló la copia programada "${s.name}"`, ev.error || '');
    send('schedules:changed', null);
  });
  app.on('activate', showWindow);
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {
  if (!tray || !store.settings.get().minimizeToTray) app.quit();
});
