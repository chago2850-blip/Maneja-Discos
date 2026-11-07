# Mapa de recon: Paragon Hard Disk Manager for Business

**Alcance:** respaldo y recuperación, gestión de particiones, copia/migración de discos y borrado seguro, con el modelo de "operaciones pendientes" de Paragon.
**Plataformas del clon:** Windows, Linux y macOS (escritorio).
**Para:** **Maneja Discos**, una app libre y de código abierto, sin licencias, pruebas ni límites.
**Fecha:** 2026-11-07

> Método clean-room: todo sale del sitio público de Paragon y de manuales publicados. No se descargó, abrió ni descompiló el software.

## Fuentes

| # | fuente | URL |
| --- | --- | --- |
| 1 | Página del producto (ES) | https://www.paragon-software.com/es/main-page-2/ |
| 2 | Hard Disk Manager Advanced (lista de funciones y sistemas de archivos) | https://www.paragon-software.com/es/home/hdm-windows/ |
| 3 | Manual de usuario de HDM 16 | https://manualmachine.com/paragon/harddiskmanager16/2842518-user-manual |
| 4 | Base de conocimiento de Paragon | https://paragon-software.zendesk.com/hc/ |
| 5 | Página Business (EN) | https://www.paragon-software.com/business/hard-disk-manager/ |

## Bucle principal

Ver los discos en un **mapa** → elegir una operación (respaldar, particionar, copiar, borrar) → revisarla como **operación pendiente** → **Aplicar**. Para respaldos, lo mismo pero programado: un trabajo con estrategia (completo + incrementales), retención y restauración desde cualquier punto.

## Pantallas

| ID | pantalla | propósito | componentes | estados |
| --- | --- | --- | --- | --- |
| S01 | Inicio / panel | Estado general: discos, último respaldo, próximas tareas | Tarjetas de resumen, accesos rápidos | sin respaldos, con respaldos, errores |
| S02 | Mi equipo: mapa de discos | Ver discos y particiones como barras, con el espacio libre | Barra por disco, segmentos por partición, menú contextual, panel de propiedades | cargando, vacío, sin permisos, disco del sistema |
| S03 | Barra de operaciones pendientes | Cola con Aplicar, Descartar, Deshacer, Rehacer y "Generar script"; vista antes/después | Lista de operaciones, botones | vacía, con cambios, aplicando, error |
| S04 | Asistente: crear partición | Tipo, sistema de archivos, tamaño, etiqueta, letra, tamaño de clúster | Formulario, control deslizante de tamaño | sin espacio libre, MBR con 4 primarias |
| S05 | Asistente: formatear | Sistema de archivos, etiqueta y clúster | Formulario | partición del sistema (deshabilitado) |
| S06 | Asistente: redimensionar o mover | Nuevo tamaño, arrastrando en el mapa | Control deslizante | FS sin soporte para encoger |
| S07 | Propiedades avanzadas | Geometría, clúster, ubicación exacta, número de serie | Tabla | — |
| S08 | Asistente: copia de seguridad única | Origen (disco, volumen o archivos), destino, opciones (compresión, división, contraseña, exclusiones) | Pasos | destino lleno, sin acceso |
| S09 | Asistente: trabajo de respaldo | Estrategia (diaria, semanal, a demanda, personalizada), programación, retención | Pasos, selector de horario | — |
| S10 | Mis copias | Lista de respaldos y cadenas; verificar, fijar, reparar, montar | Lista con estado (verde, gris, rojo) | vacío, dañado, no disponible |
| S11 | Asistente: restaurar | Elegir punto de restauración y destino (disco o volumen, o archivos) | Pasos, mapa del destino | destino más pequeño, sobrescribir arranque |
| S12 | Asistente: copiar disco/partición y migrar SO | Origen, destino, ajuste proporcional | Pasos | destino más pequeño |
| S13 | Asistente: borrado seguro | Destino (disco, partición, espacio libre), algoritmo, verificación, sello e informe; TRIM para SSD | Pasos, lista de algoritmos, editor de algoritmo propio | SSD detectado, disco del sistema |
| S14 | Herramientas | Prueba de superficie, comprobar sistema de archivos, convertir MBR↔GPT, convertir FS, editor de sectores, discos virtuales | Lista de herramientas | — |
| S15 | Mis actividades | Operaciones en curso, programadas y terminadas, con registros | Lista y progreso | — |
| S16 | Ajustes | Copias, imágenes, particionado (alineación, protección), correo y registros | Pestañas | — |
| S17 | Constructor de medios de rescate | WinPE en USB o ISO, controladores y red | Asistente | **skip** (ver abajo) |

## Flujos

```
F01 Respaldar un disco ahora           S02 → S08 (origen → destino → opciones) → S15 → S10    clics: 5
F02 Respaldo diario automático         S09 (origen → destino → estrategia → horario → retención) → S10
F03 Restaurar un disco/volumen         S10 → S11 (punto → destino) → pendiente → Aplicar
F04 Restaurar archivos sueltos         S10 → montar o extraer → elegir archivos → destino
F05 Crear partición en espacio libre   S02 → clic en espacio libre → S04 → S03 Aplicar        clics: 4
F06 Redimensionar partición            S02 → S06 → S03 Aplicar
F07 Formatear / eliminar / etiqueta    S02 → menú contextual → S05 → S03 Aplicar
F08 Copiar disco (clonar)              S12 → origen → destino → confirmar
F09 Borrado seguro de disco            S13 → destino → algoritmo → verificación → informe
F10 Borrar espacio libre               S13 → partición → "solo espacio libre"
F11 Convertir MBR↔GPT                  S14 → disco → convertir → S03 Aplicar
F12 Prueba de superficie               S14 → disco → resultado (sectores dañados o lentos)
F13 Comprobar sistema de archivos      S02 → menú → comprobar/reparar
F14 Generar script                     S03 → "Generar script" → guardar
    edge (todos): disco del sistema, disco en uso, permisos de administrador, destino insuficiente
```

## Componentes

Botón (primario, secundario, peligro), mapa de disco (barra con segmentos coloreados por FS), panel de propiedades, menú contextual, asistente por pasos, control deslizante de tamaño, selector de archivos/carpetas, barra de progreso con velocidad y tiempo restante, lista de copias con estado, tarjeta de resumen, notificación (toast), modal de confirmación destructiva (escribir el nombre), registro de actividad y barra de operaciones pendientes.

## Modelo de datos inferido

```
Disk        id, path, model, serial, size, sector_size, partition_style (gpt|mbr|none),
            bus, removable, ssd, is_system, partitions[], free[]            evidencia: S02 · alta
Partition   id, path, number, start, size, fs, label, letter/mountpoint, used, type,
            flags (boot, system, hidden, active)                            evidencia: S02, S07 · alta
PendingOp   id, kind (create|format|delete|resize|label|letter|convert|init), target,
            params, created_at                                              evidencia: S03 · alta
BackupSet   id, name, kind (image|files), source, destination, chain[], encrypted,
            compression, split_size                                         evidencia: S08, S10 · alta
RestorePoint id, set_id, type (full|incremental|differential), parent_id, created_at,
            size, status (ok|missing|corrupt), pinned                       evidencia: S10 · alta
BackupJob   id, set_id, strategy, schedule (cron), retention (count|days),
            enabled, last_run, next_run                                     evidencia: S09 · alta
WipeMethod  id, name, passes[{pattern|random|complement}], verify_percent    evidencia: S13 · alta
Activity    id, kind, target, started_at, ended_at, status, log, report     evidencia: S15 · media
Settings    alignment, fs_check_policy, compression, split_size, email, theme   evidencia: S16 · media
```

## Fuera de alcance

| qué | por qué |
| --- | --- |
| Constructor de medios de rescate WinPE | Depende de Windows ADK/WinPE (licencia de Microsoft). Alternativa: grabar cualquier ISO de rescate (p. ej. SystemRescue) con la misma función de escritura en crudo. |
| Corrector de arranque, BCD y EFI | Específico de WinPE y del arranque de Windows. |
| Migración de SO con ajuste de BCD | Se ofrece la copia de disco completa; reajustar el arranque de Windows queda para una versión futura. |
| Conversión de FS sin perder datos (FAT↔NTFS↔HFS) | No hay herramientas abiertas fiables multiplataforma. |
| Desfragmentar o compactar la MFT y editor de sectores con escritura | Alto riesgo; editor de solo lectura como mejora futura. |
| Exclusiones a nivel de aplicación (Exchange, SQL, Hyper-V) | Requieren VSS writers de Windows. |
| Licencias, activación y consola de administración remota | El clon es libre y local. |

## Tamaño

17 pantallas (15 se construyen), 14 flujos, 9 entidades.

Partes difíciles:
1. **Acceso en crudo a discos en 3 sistemas** con elevación de privilegios (UAC, pkexec, administrador de macOS más Acceso total al disco) y sin escribir nunca en el disco equivocado.
2. **Respaldos de imagen incrementales** fiables: índice de bloques, cadenas, cifrado, verificación y restauración desde cualquier punto.
3. **Particionado** con herramientas distintas por sistema (PowerShell Storage, parted/sgdisk/mkfs, diskutil), sin poder redimensionar todos los sistemas de archivos en todas partes.

Tamaño: **XL** para paridad completa. La versión 1 cubre el bucle principal de las 4 áreas (respaldo, particiones, copia y borrado): **L**.
