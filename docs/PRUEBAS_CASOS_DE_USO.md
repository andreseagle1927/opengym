# Pruebas de casos de uso de openGym

**Ejecución:** 23 de octubre de 2026 (Bogotá)
**Aplicación:** https://gym.adrenocromo.com

## Resultados

| ID | Caso de uso | Resultado | Evidencia |
|---|---|---|---|
| UC-01 | Registrar cuentas y guardar un ejercicio personalizado en el perfil | PASS | API local aislada; datos temporales eliminados al finalizar |
| UC-02 | Exigir que el ejercicio exista en el perfil antes de cargar su video | PASS | La carga de un ID sin ejercicio guardado se rechaza |
| UC-03 | Subir MP4 como propietario y guardar el archivo e índice en el servidor | PASS | API local aislada; fixture MP4 con firma `ftyp` |
| UC-04 | Mostrar el video solo al propietario; ocultarlo a otra cuenta y a visitantes | PASS | Consultas al índice con tres sesiones distintas |
| UC-05 | Impedir que una cuenta cargue o elimine el video de otro perfil | PASS | Ambas operaciones reciben HTTP 403 |
| UC-06 | Eliminar video propio y limpiar archivo e índice | PASS | La operación devuelve HTTP 200 y elimina ambos registros |
| UC-07 | Permitir el encabezado de propietario en solicitudes móviles CORS | PASS | Preflight de producción desde `capacitor://localhost`, HTTP 204 |
| UC-08 | Iniciar Admin, abrir un perfil y cargar sus datos desde el backend | PASS | Perfil OpenGym Test visible en la aplicación publicada |
| UC-09 | Abrir Home, Plan, Exercises, Stats y Food en el perfil seleccionado | PASS | Cada pestaña llegó a su ruta y mostró su encabezado |
| UC-10 | Regresar al panel Admin y ocultar la navegación normal | PASS | El panel vuelve a `#/admin` sin barra de pestañas |
| UC-11 | Abrir el editor de ejercicio y comprobar mapa corporal, músculos y selector MP4 | PASS | Revisión visual en el navegador; no se guardó el formulario |
| UC-12 | Comprobar disponibilidad de la aplicación, API y configuración Nginx | PASS | Web HTTP 200, API HTTP 200, `nginx -t` correcto |

## Automatización

- Suite frontend: **329 pruebas aprobadas en 26 archivos**.
- Pruebas enfocadas de ejercicio, mapa corporal, estado Admin y aislamiento de claves de video: **8 aprobadas**.
- `node --check api/server.js` y `git diff --check`: aprobados.
- La prueba de API corrió con datos y almacenamiento temporales locales; se eliminaron al terminar.

## Límites de esta ejecución

- No se cargó un video ni se guardaron cambios en los perfiles de producción.
- La API se probó con un fixture pequeño que comprueba la firma MP4 y el flujo de almacenamiento; no es un video decodificable. La reproducción de un video real desde un teléfono queda pendiente de una carga controlada desde el dispositivo.
- La pantalla de carga se revisó en el navegador de escritorio y el preflight del origen móvil se verificó en producción.
