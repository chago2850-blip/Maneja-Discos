# Cómo contribuir a Maneja Discos

¡Gracias por tu interés! Maneja Discos es **software libre y de código abierto** bajo la [GNU General Public License v3.0 o posterior](LICENSE) (`GPL-3.0-or-later`).

## Licencia de las contribuciones

Al enviar un *pull request*, un parche o cualquier otro aporte, aceptas que tu contribución se publique bajo la misma licencia **GPL-3.0-or-later** que el resto del proyecto. Conservas los derechos de autor sobre tu aporte.

Para dejarlo claro, firma cada *commit* con `git commit -s`. Eso añade la línea `Signed-off-by:` del [Developer Certificate of Origin](https://developercertificate.org/), con la que declaras que tienes derecho a aportar ese código.

En cada archivo nuevo, copia el encabezado de licencia que llevan los demás archivos (aviso de copyright y `SPDX-License-Identifier: GPL-3.0-or-later`).

## Antes de enviar cambios

1. `npm install`
2. `npm test` para las pruebas del motor. En Linux, con discos reales: `sudo MD_INCLUDE_LOOP=1 node --test test/engine.test.js`.
3. `npm start` para probar la app.
4. Describe en el *pull request* qué cambia y cómo lo probaste.

## Código de terceros

Solo se aceptan dependencias con licencias compatibles con la GPL-3.0 (MIT, BSD, Apache-2.0, LGPL, GPL…). Añádelas a [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No copies código de productos propietarios.

## Reportar problemas

Abre un *issue* en https://github.com/chago2850-blip/Maneja-Discos/issues con tu sistema operativo, la versión de Maneja Discos y, si puedes, el registro de la operación (*Actividad → Detalles*).
