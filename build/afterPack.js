'use strict';
// Firma ad-hoc de la app de macOS (sin cuenta de desarrollador). Sin firma, macOS en
// Apple Silicon dice que la app "está dañada". Con firma ad-hoc basta con
// "Abrir igualmente" en Privacidad y seguridad.
const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_NAME || process.env.CSC_LINK) return; // firma real configurada
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • firma ad-hoc  ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--verbose=1', app], { stdio: 'inherit' });
};
