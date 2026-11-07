'use strict';
const os = require('os');

function get(name = process.platform) {
  if (name === 'linux') return require('./linux');
  if (name === 'darwin') return require('./darwin');
  if (name === 'win32') return require('./win32');
  throw new Error(`Sistema no compatible: ${name}`);
}

module.exports = { get, current: () => get(process.platform), hostname: os.hostname() };
