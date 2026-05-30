# WhatsApp Bot con Baileys

Bot funcional hecho con Node.js y Baileys para automatizar WhatsApp Web.

## Que hace

- inicia sesion con QR
- recibe mensajes
- responde automaticamente
- soporta comandos basicos
- permite hacer un broadcast simple a contactos configurados

## Requisitos

- Node.js 18 o superior
- una cuenta de WhatsApp para escanear el QR

## Instalacion

```bash
npm install
cp .env.example .env
```

## Configuracion

Abre el archivo `.env` y ajusta estos valores:

- `BOT_NAME`: nombre del bot
- `DEFAULT_REPLY`: mensaje por defecto cuando no coincide ningun comando
- `TIMEZONE`: zona horaria para el comando `!time`
- `OWNER_JID`: unico usuario autorizado para usar `!broadcast`
- `ALLOWED_BROADCAST`: lista de contactos separados por coma

Ejemplo:

```env
BOT_NAME=Mi Bot
DEFAULT_REPLY=Hola, recibi tu mensaje. Escribe !help para ver los comandos.
TIMEZONE=America/Mexico_City
OWNER_JID=5215512345678@s.whatsapp.net
ALLOWED_BROADCAST=5215511111111@s.whatsapp.net,5215522222222@s.whatsapp.net
```

## Formato de JID

WhatsApp usa identificadores como estos:

```text
5215512345678@s.whatsapp.net
```

Usa el numero con codigo de pais, sin `+`, espacios ni guiones.

## Como iniciarlo

```bash
npm start
```

Si quieres reinicio automatico durante desarrollo:

```bash
npm run dev
```

## Primer inicio

1. ejecuta `npm start`
2. espera a que aparezca el QR en la terminal
3. abre WhatsApp en tu telefono
4. entra a `Dispositivos vinculados`
5. escanea el QR

La sesion se guarda en la carpeta `auth/`, asi que no necesitas escanear el QR cada vez.

## Comandos disponibles

- `!help`: muestra la ayuda
- `!time`: devuelve la hora actual segun `TIMEZONE`
- `!about`: muestra informacion del bot
- `!ping`: prueba simple de respuesta
- `!broadcast`: envia un mensaje de prueba a los contactos de `ALLOWED_BROADCAST`

## Menu de nutricionista

Si el usuario escribe `hola`, `menu` o `turno`, el bot responde con este menu:

- `1`: sacar un turno
- `2`: cambiar un turno
- `3`: cancelar un turno
- `6`: ver direccion del consultorio
- `7`: consultar atencion online
- `8`: ver indicaciones para la primera consulta

Cada opcion devuelve un texto listo para continuar la conversacion por WhatsApp.

## Respuestas automaticas

El bot tambien responde asi:

- si recibe `hola`, `hi`, `menu` o `turno`, muestra el menu
- si recibe otro texto, responde con `DEFAULT_REPLY`

## Estructura del proyecto

```text
.
|-- src/
|   `-- index.js
|-- .env.example
|-- .gitignore
|-- package.json
`-- README.md
```

## Archivos importantes

- `src/index.js`: logica principal del bot
- `.env`: configuracion local
- `auth/`: sesion autenticada de WhatsApp

## Problemas comunes

### No aparece el QR

- verifica que ejecutaste `npm install`
- vuelve a correr `npm start`
- revisa que no haya una sesion corrupta en `auth/`

### Quiero volver a enlazar la cuenta

Elimina la carpeta `auth/` y vuelve a iniciar el proyecto para generar un QR nuevo.

### El broadcast no funciona

- verifica que `OWNER_JID` sea exactamente el mismo JID del remitente autorizado
- verifica que `ALLOWED_BROADCAST` tenga JIDs validos

## Notas importantes

- Baileys no es oficial.
- WhatsApp puede cambiar el protocolo y romper integraciones.
- No uses este bot para spam.
- Si necesitas volumen serio o uso empresarial, usa la API oficial de WhatsApp Business.
