<p align="center">
  <img src="build/icon-256.png" width="150" alt="Maneja Discos">
</p>

<h1 align="center">Maneja Discos</h1>
<p align="center"><b>Copias de seguridad, particiones, clonado y borrado seguro de discos.<br>Libre, gratuito y de código abierto para Windows, Linux y macOS.</b></p>

---

Maneja Discos es una alternativa abierta a las suites comerciales de gestión de discos. No tiene licencias, periodos de prueba ni límites.

## Funciones

### Particiones
- **Mapa visual** de discos y particiones, con el espacio usado y el espacio libre.
- **Operaciones pendientes**: los cambios se acumulan en una cola y se pueden revisar con **Diseño actual / Diseño nuevo**, deshacer, rehacer, descartar o **exportar como script** (`.sh` o `.ps1`) antes de **Aplicar**.
- **Operaciones**: crear, formatear, eliminar, redimensionar, cambiar etiqueta, cambiar letra (Windows), marcar como activa u ocultar (MBR), inicializar el disco (GPT/MBR) y **convertir MBR↔GPT**.
- **Sistemas de archivos**:
  - Windows: NTFS, exFAT, FAT32 y ReFS.
  - Linux: ext4, NTFS, FAT32, exFAT, Btrfs, XFS, ext2/3 y swap.
  - macOS: APFS, Mac OS Plus, exFAT y FAT32 (NTFS con [MacNTFS](https://github.com/chago2850-blip/MacNTFS)).

### Copias de seguridad
- **Imagen de disco o partición** sector a sector. Los bloques vacíos no ocupan espacio.
- **Copia de archivos y carpetas** con exclusiones por máscara (`*.tmp`, `node_modules`…).
- Copias **completas, incrementales y diferenciales**, organizadas en cadenas.
- **Compresión** en cuatro niveles y **división** en archivos de 4 GB, CD, DVD o Blu-ray.
- **Cifrado AES-256-GCM** con contraseña (clave derivada con scrypt).
- **Verificación** de integridad con un hash por bloque.
- **Tareas programadas** con estrategias (1 completa + 6 incrementales, diferenciales, solo completas, una sola copia), por horas, diaria, semanal o mensual, con **retención** y puntos **fijados**.
- **Restauración** del disco o la partición original, de otro destino, **exportación a `.img`** o de **archivos sueltos** con búsqueda.

### Copiar y migrar
- **Clonar** un disco o una partición a otro destino igual o mayor, con verificación.
- **Migrar** el sistema a un SSD clonando el disco completo.

### Borrado seguro
- **Algoritmos**: Ceros, Aleatorio, GOST R 50739-95, DoD 5220.22-M (3 y 7 pasadas), HMG IS5, NAVSO P-5239-26, NSA 130-2, VSITR, Schneier y Gutmann (35 pasadas).
- **Algoritmo propio** de hasta 4 patrones.
- **Qué se puede borrar**: un disco o una partición, **solo el espacio libre** o **archivos y carpetas** concretos.
- **Comprobación**: verificación de un porcentaje de los bloques, **informe HTML/JSON**, sello opcional en el primer sector y **TRIM** para SSD.

### Herramientas
- Prueba de superficie con mapa de sectores lentos o dañados.
- Comprobación y reparación del sistema de archivos (`chkdsk` en Windows, `fsck` en Linux, `diskutil` en macOS).
- Grabar una imagen ISO o IMG en una memoria USB, para crear un medio de rescate.
- Registro de actividad de cada operación.

## Descargar

Los instaladores están en **[Releases](https://github.com/chago2850-blip/Maneja-Discos/releases/latest)**:

| Sistema | Archivo |
|---|---|
| Windows | `…-Windows-x64-Instalador.exe` · `…-Portable.exe` · `…-arm64-Instalador.exe` |
| macOS | `…-macOS-arm64.dmg` (Apple Silicon) · `…-macOS-x64.dmg` (Intel) |
| Linux | `…-amd64.deb` · `…-x86_64.AppImage` · versiones arm64 |

- **Linux:** instala las herramientas de disco que la app necesita:
  ```bash
  sudo apt install parted fdisk gdisk dosfstools ntfs-3g exfatprogs policykit-1
  ```
- **macOS:**
  - La app no está firmada con una cuenta de desarrollador de Apple. La primera vez que la abras, ve a *Ajustes del Sistema → Privacidad y seguridad → Abrir igualmente*.
  - Para leer o escribir discos externos en crudo, activa Maneja Discos en *Acceso total al disco*.
- **Permisos:** la app se ejecuta como usuario normal. Para cada operación de disco pide permisos de administrador (UAC en Windows, `pkexec` en Linux, contraseña de administrador en macOS).

## Seguridad de los datos

- Nada se escribe en un disco hasta que pulsas **Aplicar** y escribes la palabra de confirmación.
- El disco y las particiones del sistema en uso están protegidos: no se pueden formatear, eliminar, borrar ni restaurar encima.
- Antes de cada operación se vuelve a leer el estado real de los discos. Si algo cambió, la cola se detiene.
- **Haz siempre una copia de seguridad antes de redimensionar o convertir particiones.**

## Desarrollo

```bash
npm install
npm start                 # abrir la app
npm test                  # pruebas del motor
sudo MD_INCLUDE_LOOP=1 node --test test/engine.test.js   # incluye discos reales (loop) en Linux
npm run dist              # instaladores del sistema actual
```

```
src/engine/   motor en Node puro (sin dependencias; se ejecuta con permisos elevados)
  platform/   adaptadores: linux.js (lsblk, parted, sfdisk, sgdisk, mkfs) · win32.js (PowerShell Storage) · darwin.js (diskutil)
  partition.js  validación, script y aplicación de operaciones pendientes
  imaging.js    imágenes por bloques: completa/incremental/diferencial, restaurar, clonar
  filebackup.js copias de archivos con exclusiones
  container.js  formato de copia: gzip + AES-256-GCM, archivos divididos
  wipe.js       algoritmos de borrado, espacio libre, triturado, verificación e informes
  surface.js    prueba de superficie
  worker.js     proceso de trabajo (progreso en JSON por líneas)
src/main/     proceso principal de Electron: ventana, bandeja, permisos, tareas programadas
src/renderer/ interfaz (HTML, CSS y JavaScript sin frameworks)
replica/      análisis funcional del producto de referencia
```

## Licencia

GPL-3.0-or-later. Desarrollado por **Santiago Miguel** · chago2850@gmail.com
