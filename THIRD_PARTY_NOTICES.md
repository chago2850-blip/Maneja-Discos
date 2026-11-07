# Componentes de terceros

Maneja Discos se distribuye bajo la **GPL-3.0-or-later**. Este archivo enumera el software de terceros que se incluye en los instaladores o que la aplicación utiliza, junto con su licencia. Todas las licencias son compatibles con la GPL-3.0.

## Incluidos en los instaladores

| Componente | Licencia | Dónde está el texto |
|---|---|---|
| [Electron](https://github.com/electron/electron) | MIT | `LICENSE.electron.txt`, junto al ejecutable |
| [Chromium](https://www.chromium.org) (dentro de Electron) | BSD-3-Clause y otras | `LICENSES.chromium.html`, junto al ejecutable |
| [Node.js](https://nodejs.org) (dentro de Electron) | MIT | incluido en `LICENSES.chromium.html` |

El código de Maneja Discos (motor, proceso principal e interfaz) no tiene otras dependencias en tiempo de ejecución. Las herramientas de compilación ([electron-builder](https://github.com/electron-userland/electron-builder), MIT) no forman parte de la aplicación distribuida.

## Herramientas del sistema que la aplicación ejecuta

Maneja Discos no incluye estos programas. Ejecuta los que ya están instalados en el sistema operativo, como **programas independientes**, sin enlazarlos. Cada uno conserva su propia licencia.

| Programa | Sistema | Licencia |
|---|---|---|
| parted, partprobe | Linux | GPL-3.0-or-later |
| lsblk, sfdisk, wipefs, blkid, blkdiscard, fstrim (util-linux) | Linux | GPL-2.0-or-later |
| sgdisk (gdisk) | Linux | GPL-2.0 |
| mkfs.ext4, e2fsck, resize2fs, e2label (e2fsprogs) | Linux | GPL-2.0 |
| mkfs.ntfs, ntfsresize, ntfsfix, ntfslabel (ntfs-3g) | Linux / macOS | GPL-2.0-or-later |
| mkfs.vfat, fsck.vfat, fatlabel (dosfstools) | Linux | GPL-3.0-or-later |
| mkfs.exfat, fsck.exfat (exfatprogs) | Linux | GPL-2.0-or-later |
| mkfs.btrfs (btrfs-progs), mkfs.xfs (xfsprogs) | Linux | GPL-2.0 |
| pkexec (polkit) | Linux | LGPL-2.0-or-later |
| diskutil, plutil, osascript | macOS | propiedad de Apple, incluidos en macOS |
| PowerShell (cmdlets de almacenamiento), mbr2gpt | Windows | propiedad de Microsoft, incluidos en Windows |

## Marcas

"Paragon" y "Hard Disk Manager" son marcas de Paragon Software Group. Maneja Discos es un proyecto independiente y no está afiliado a Paragon. La carpeta `replica/` contiene un análisis funcional hecho únicamente con documentación pública; no se usó código, binarios ni recursos de Paragon.
