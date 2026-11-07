'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('md', {
  info: call('app:info'),
  disks: { list: call('disks:list'), listElevated: call('disks:listElevated') },
  ops: { validate: call('ops:validate'), describe: call('ops:describe'), script: call('ops:script') },
  job: {
    start: call('job:start'),
    cancel: call('job:cancel'),
    running: call('job:running'),
    onEvent: (fn) => ipcRenderer.on('job:event', (_e, payload) => fn(payload)),
  },
  activity: { list: call('activity:list'), clear: call('activity:clear') },
  settings: { get: call('settings:get'), set: call('settings:set') },
  sets: {
    list: call('sets:list'), add: call('sets:add'), register: call('sets:register'), forget: call('sets:forget'),
    deleteAll: call('sets:deleteAll'), deletePoint: call('sets:deletePoint'), pin: call('sets:pin'), files: call('sets:files'),
  },
  schedules: {
    list: call('schedules:list'), save: call('schedules:save'), remove: call('schedules:remove'), runNow: call('schedules:runNow'),
    onChange: (fn) => ipcRenderer.on('schedules:changed', () => fn()),
  },
  dialog: { openDir: call('dialog:openDir'), openPaths: call('dialog:openPaths'), openFile: call('dialog:openFile'), saveFile: call('dialog:saveFile') },
  file: { saveText: call('file:saveText') },
  shell: { open: call('shell:open'), show: call('shell:show'), external: call('shell:external') },
});
