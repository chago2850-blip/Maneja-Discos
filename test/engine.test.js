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
// Pruebas del motor. Las de dispositivos reales (loop) necesitan Linux y root:
//   sudo MD_INCLUDE_LOOP=1 node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const imaging = require('../src/engine/imaging');
const filebackup = require('../src/engine/filebackup');
const wipe = require('../src/engine/wipe');
const BS = require('../src/engine/backupset');
const partition = require('../src/engine/partition');
const linux = require('../src/engine/platform/linux');
const { runJob } = require('../src/engine/worker');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-test-'));
const quiet = () => {};
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function makeImage(file, mb, seed) {
  const buf = Buffer.alloc(mb * 1024 * 1024);
  // mitad aleatoria, mitad ceros
  crypto.randomFillSync(buf, 0, buf.length / 2);
  if (seed) buf.write(seed, 10);
  fs.writeFileSync(file, buf);
}

test('copia de imagen completa + incremental + diferencial con cifrado y división', async () => {
  const src = path.join(tmp, 'disco.img');
  makeImage(src, 24, 'v1');
  const dest = path.join(tmp, 'copias');
  fs.mkdirSync(dest);
  const source = { path: src, offset: 0, length: fs.statSync(src).size, target: { kind: 'file', path: src } };
  const full = await imaging.backup({ destDir: dest, name: 'Disco prueba', source, password: 'secreta', splitSize: 4 * 1024 * 1024 }, quiet);
  assert.strictEqual(full.point.type, 'full');
  const set = BS.load(full.setDir);
  assert.ok(set.encryption);
  assert.ok(fs.readdirSync(path.join(full.setDir, full.point.dir)).filter((f) => f.startsWith('data-')).length > 1, 'debe dividir en varios archivos');
  const v1 = sha(src);

  // cambiar 1 bloque → incremental pequeño
  const fd = fs.openSync(src, 'r+');
  fs.writeSync(fd, Buffer.from('CAMBIO-INCREMENTAL'), 0, 18, 9 * 1024 * 1024);
  fs.closeSync(fd);
  const inc = await imaging.backup({ setDir: full.setDir, type: 'incremental', password: 'secreta' }, quiet);
  assert.strictEqual(inc.point.type, 'incremental');
  assert.strictEqual(inc.point.blocksChanged, 1);
  const v2 = sha(src);

  // cambiar otro bloque → diferencial (contra el completo): 2 bloques
  const fd2 = fs.openSync(src, 'r+');
  fs.writeSync(fd2, Buffer.from('DIFERENCIAL'), 0, 11, 20 * 1024 * 1024);
  fs.closeSync(fd2);
  const dif = await imaging.backup({ setDir: full.setDir, type: 'differential', password: 'secreta' }, quiet);
  assert.strictEqual(dif.point.parent, full.point.id);
  assert.strictEqual(dif.point.blocksChanged, 2);
  const v3 = sha(src);

  await assert.rejects(imaging.verify({ setDir: full.setDir, pointId: inc.point.id, password: 'mala' }, quiet), /contraseña/);
  const ver = await imaging.verify({ setDir: full.setDir, pointId: inc.point.id, password: 'secreta' }, quiet);
  assert.ok(ver.ok);

  for (const [pt, expected] of [[full.point, v1], [inc.point, v2], [dif.point, v3]]) {
    const out = path.join(tmp, `restaurado-${pt.type}.img`);
    const r = await imaging.restore({ setDir: full.setDir, pointId: pt.id, password: 'secreta', target: { path: out }, verifyAfter: true }, quiet);
    assert.ok(r.verified);
    assert.strictEqual(sha(out), expected, `restaurar ${pt.type}`);
  }
});

test('la corrupción de un archivo de datos se detecta al verificar', async () => {
  const src = path.join(tmp, 'c.img');
  makeImage(src, 8);
  const r = await imaging.backup({ destDir: tmp, name: 'Corrupta', source: { path: src, offset: 0, length: fs.statSync(src).size } }, quiet);
  const data = path.join(r.setDir, r.point.dir, 'data-0001.bin');
  const fd = fs.openSync(data, 'r+');
  fs.writeSync(fd, Buffer.from('XXXXXXXX'), 0, 8, 100);
  fs.closeSync(fd);
  const v = await imaging.verify({ setDir: r.setDir }, quiet);
  assert.strictEqual(v.ok, false);
});

test('copia de archivos incremental, exclusiones y restauración', async () => {
  const root = path.join(tmp, 'docs');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'hola');
  fs.writeFileSync(path.join(root, 'sub', 'b.bin'), crypto.randomBytes(9 * 1024 * 1024));
  fs.writeFileSync(path.join(root, 'tmp.tmp'), 'x');
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'x');
  const r1 = await filebackup.backup({ destDir: tmp, name: 'Docs', sources: [root], exclude: ['*.tmp', 'node_modules'], password: 'pw' }, quiet);
  assert.strictEqual(r1.point.files, 2);
  fs.writeFileSync(path.join(root, 'a.txt'), 'hola modificado');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'a.txt'), later, later);
  const r2 = await filebackup.backup({ setDir: r1.setDir, type: 'incremental', password: 'pw' }, quiet);
  assert.strictEqual(r2.point.filesStored, 1);
  const out = path.join(tmp, 'restaurados');
  await filebackup.restore({ setDir: r1.setDir, pointId: r2.point.id, password: 'pw', destination: out }, quiet);
  assert.strictEqual(fs.readFileSync(path.join(out, 'docs', 'a.txt'), 'utf8'), 'hola modificado');
  assert.strictEqual(sha(path.join(out, 'docs', 'sub', 'b.bin')), sha(path.join(root, 'sub', 'b.bin')));
  assert.ok(!fs.existsSync(path.join(out, 'docs', 'tmp.tmp')));
  // restaurar el punto antiguo con "conservar ambos"
  await filebackup.restore({ setDir: r1.setDir, pointId: r1.point.id, password: 'pw', destination: out, selection: ['0/a.txt'], policy: 'keepBoth' }, quiet);
  assert.strictEqual(fs.readFileSync(path.join(out, 'docs', 'a (restaurado).txt'), 'utf8'), 'hola');
  const v = await filebackup.verify({ setDir: r1.setDir, password: 'pw' }, quiet);
  assert.ok(v.ok);
});

test('retención conserva N cadenas y respeta las fijadas', async () => {
  const src = path.join(tmp, 'r.img');
  makeImage(src, 4);
  const first = await imaging.backup({ destDir: tmp, name: 'Ret', source: { path: src, offset: 0, length: fs.statSync(src).size } }, quiet);
  for (let i = 0; i < 3; i++) await imaging.backup({ setDir: first.setDir, type: 'full' }, quiet);
  let set = BS.load(first.setDir);
  BS.setPinned(set, set.points[0].id, true);
  set = BS.load(first.setDir);
  BS.applyRetention(set, { keepChains: 2 });
  set = BS.load(first.setDir);
  assert.strictEqual(set.points.length, 3); // fijada + 2 últimas
  assert.ok(set.points[0].pinned);
});

test('algoritmos de borrado: patrones, aleatorio verificable y algoritmo propio', async () => {
  assert.ok(wipe.ALGORITHMS.length >= 10);
  const f = path.join(tmp, 'borrar.img');
  makeImage(f, 6);
  for (const id of ['zero', 'dod3', 'vsitr']) {
    const algo = wipe.resolveAlgorithm(id);
    const r = wipe.wipeRegion({ path: f, offset: 0, length: fs.statSync(f).size }, algo, quiet, () => false, { verifyPercent: 100 });
    assert.ok(r.verification.ok, id);
  }
  const data = fs.readFileSync(f);
  assert.ok(data.every((b) => b === 0xaa), 'VSITR termina en 0xAA');
  const custom = wipe.resolveAlgorithm({ patterns: ['5A', 'random'], passesPerPattern: 2, groupRepeats: 2 });
  assert.strictEqual(custom.passes.length, 8);
  const r = wipe.wipeRegion({ path: f, offset: 1024 * 1024, length: 2 * 1024 * 1024 }, custom, quiet, () => false, { verifyPercent: 50 });
  assert.ok(r.verification.ok);
});

test('triturar archivos y borrar espacio libre', async () => {
  const d = path.join(tmp, 'secreto');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'clave.txt'), 'top secret');
  const r = wipe.wipeFiles([d], wipe.resolveAlgorithm('dod3'), quiet, () => false);
  assert.strictEqual(r.files, 1);
  assert.ok(!fs.existsSync(d));
});

test('macOS: -plist va justo después del verbo de diskutil', () => {
  const darwin = require('../src/engine/platform/darwin');
  assert.deepStrictEqual(darwin._plistArgs(['list', 'physical']), ['list', '-plist', 'physical']);
  assert.deepStrictEqual(darwin._plistArgs(['info', 'disk4s1']), ['info', '-plist', 'disk4s1']);
  assert.deepStrictEqual(darwin._plistArgs(['apfs', 'list']), ['apfs', 'list', '-plist']);
});

test('listar los discos reales de este sistema', { skip: process.env.MD_LIST_SMOKE !== '1' }, async () => {
  const plat = require('../src/engine/platform').current();
  const disks = await plat.listDisks();
  console.log(JSON.stringify(disks.map((d) => ({ id: d.id, model: d.model, size: d.size, style: d.partitionStyle, system: d.isSystem, parts: d.partitions.map((p) => [p.id, p.fs, p.label, p.size]) })), null, 1));
  assert.ok(disks.length > 0, 'debe encontrar al menos un disco');
  if (process.platform !== 'linux') assert.ok(disks.some((d) => d.partitions.length > 0), 'al menos un disco con particiones');
});

test('script de operaciones (Linux, macOS, Windows)', () => {
  const disk = { id: '/dev/sdz', path: '/dev/sdz', number: 3, partitionStyle: 'gpt', isSystem: false, partitions: [{ id: '/dev/sdz1', path: '/dev/sdz1', number: 1, start: 1048576, size: 1e9, fs: 'ext4', label: 'a', flags: {} }], free: [{ start: 1048576 + 1e9, size: 5e9 }] };
  const ops = [
    { kind: 'create', diskId: '/dev/sdz', start: 1048576 + 1e9, size: 2e9, fs: 'ntfs', label: 'Datos' },
    { kind: 'label', diskId: '/dev/sdz', partition: disk.partitions[0], label: 'Nuevo' },
  ];
  const s = partition.script(ops, [disk], 'linux');
  assert.match(s, /mkpart primary ntfs/);
  assert.match(s, /mkfs\.ntfs -Q -F -L Datos \/dev\/sdz2/);
  assert.match(s, /e2label \/dev\/sdz1 Nuevo/);
  const w = partition.script([{ ...ops[0], diskId: '3' }], [{ ...disk, id: '3' }], 'win32');
  assert.match(w, /New-Partition -DiskNumber 3/);
  assert.match(w, /Format-Volume .* -FileSystem NTFS/);
  const m = partition.script([{ ...ops[1], diskId: 'disk9' }], [{ ...disk, id: 'disk9' }], 'darwin');
  assert.match(m, /diskutil rename/);
});

// ---------- Pruebas con dispositivos de bloque reales ----------
const canLoop = process.platform === 'linux' && process.getuid && process.getuid() === 0 && fs.existsSync('/dev/loop-control');

test('dispositivo real: inicializar, crear, formatear, etiquetar, redimensionar, imagen y restauración', { skip: !canLoop }, async () => {
  process.env.MD_INCLUDE_LOOP = '1';
  const img = path.join(tmp, 'loop.img');
  fs.writeFileSync(img, Buffer.alloc(0));
  fs.truncateSync(img, 600 * 1024 * 1024);
  const dev = execFileSync('losetup', ['--show', '-f', '-P', img]).toString().trim();
  const log = [];
  const emit = (e) => { if (e.type === 'log') log.push(e.message); };
  try {
    const find = async () => (await linux.listDisks()).find((d) => d.path === dev);
    await partition.apply([{ kind: 'init', diskId: dev, style: 'gpt' }], emit);
    let disk = await find();
    assert.strictEqual(disk.partitionStyle, 'gpt');
    assert.strictEqual(disk.free.length, 1);
    const f = disk.free[0];
    await partition.apply([
      { kind: 'create', diskId: dev, start: f.start, size: 200 * 1024 * 1024, fs: 'ext4', label: 'LINUX' },
      { kind: 'create', diskId: dev, start: f.start + 200 * 1024 * 1024, size: 150 * 1024 * 1024, fs: 'ntfs', label: 'WINDOWS' },
    ], emit);
    disk = await find();
    assert.deepStrictEqual(disk.partitions.map((p) => p.fs), ['ext4', 'ntfs']);
    assert.deepStrictEqual(disk.partitions.map((p) => p.label), ['LINUX', 'WINDOWS']);

    // escribir datos en ext4
    const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mnt-'));
    execFileSync('mount', [disk.partitions[0].path, mnt]);
    fs.writeFileSync(path.join(mnt, 'importante.txt'), 'datos que deben sobrevivir');
    execFileSync('umount', [mnt]);

    await partition.apply([{ kind: 'label', diskId: dev, partition: disk.partitions[1], label: 'DATOS' }], emit);
    // redimensionar ext4 hacia abajo y la NTFS hacia arriba en el espacio libre final
    disk = await find();
    await partition.apply([{ kind: 'resize', diskId: dev, partition: disk.partitions[1], size: 250 * 1024 * 1024 }], emit);
    disk = await find();
    assert.ok(Math.abs(disk.partitions[1].size - 250 * 1024 * 1024) < 2 * 1024 * 1024, 'NTFS ampliada');
    await partition.apply([{ kind: 'resize', diskId: dev, partition: disk.partitions[0], size: 120 * 1024 * 1024 }], emit);
    disk = await find();
    assert.ok(Math.abs(disk.partitions[0].size - 120 * 1024 * 1024) < 2 * 1024 * 1024, 'ext4 reducida');
    const chk = await partition.fsCheck(dev, disk.partitions[0].start, false, emit);
    assert.ok(chk.ok, chk.output);

    // imagen de la partición ext4 vía el worker y restauración tras borrarla
    const backups = path.join(tmp, 'img-backups');
    fs.mkdirSync(backups);
    const b = await runJob({ type: 'image-backup', source: { kind: 'partition', diskId: dev, partStart: disk.partitions[0].start }, destDir: backups, name: 'ext4', password: 'x' }, emit, () => false);
    const w = await runJob({ type: 'wipe', mode: 'region', target: { kind: 'partition', diskId: dev, partStart: disk.partitions[0].start }, algorithm: 'zero', verifyPercent: 10, reportDir: path.join(tmp, 'informes') }, emit, () => false);
    assert.ok(w.report.ok);
    assert.ok(fs.existsSync(w.reportPath));
    disk = await find();
    assert.strictEqual(disk.partitions[0].fs, null, 'la partición quedó borrada');
    const r = await runJob({ type: 'image-restore', setDir: b.setDir, password: 'x', target: { kind: 'partition', diskId: dev, partStart: disk.partitions[0].start }, verify: true }, emit, () => false);
    assert.ok(r.verified);
    disk = await find();
    execFileSync('mount', [disk.partitions[0].path, mnt]);
    assert.strictEqual(fs.readFileSync(path.join(mnt, 'importante.txt'), 'utf8'), 'datos que deben sobrevivir');
    execFileSync('umount', [mnt]);

    // prueba de superficie y conversión GPT → MBR → GPT
    const s = await runJob({ type: 'surface', target: { kind: 'disk', diskId: dev } }, emit, () => false);
    assert.ok(s.ok);
    await partition.apply([{ kind: 'convert', diskId: dev, style: 'mbr' }], emit);
    assert.strictEqual((await find()).partitionStyle, 'mbr');
    await partition.apply([{ kind: 'convert', diskId: dev, style: 'gpt' }], emit);
    disk = await find();
    assert.strictEqual(disk.partitionStyle, 'gpt');
    assert.strictEqual(disk.partitions.length, 2);

    // borrar partición
    await partition.apply([{ kind: 'delete', diskId: dev, partition: disk.partitions[1] }], emit);
    assert.strictEqual((await find()).partitions.length, 1);
  } catch (e) {
    console.error(log.slice(-30).join('\n'));
    throw e;
  } finally {
    execFileSync('losetup', ['-d', dev]);
  }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
