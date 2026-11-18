# dictado-voz

Dictado por voz hacia el terminal. La transcripción la hace el motor de voz de
Chrome (Web Speech API) desde un **script que la extensión inyecta en la pestaña
que elijas**: pulsas el icono de la extensión en esa pestaña y desde ahí escucha.

```
clic en el icono de Dictado (en la pestaña que quieras)
   │
   ▼
content.js inyectado en esa pestaña ── pastilla "Dictado listo" abajo a la derecha
   │  micrófono + reconocimiento de voz (servicio de Google)
   │  cada frase ─► chrome.runtime ─► service worker de la extensión
   │                                        │ WebSocket 127.0.0.1:8777
   ▼                                        ▼
Súper+V ─► dictado-ctl toggle ─► POST /toggle ─► backend (Docker o yarn dev)
                                                    │ kitten @ send-text
                                                    ▼
                                          el kitty que tengas enfocado
```

## Cómo saber qué pestaña tiene el script

- El icono de la extensión muestra **ON** en esa pestaña.
- La página muestra una **pastilla abajo a la derecha**: gris = listo, roja
  parpadeando = dictando, ámbar = error.
- Los logs del backend dicen `script activo en la pestaña «…»`.

Solo una pestaña a la vez: inyectar en otra retira el script de la anterior.
Otro clic en el icono sobre la misma pestaña lo retira.

## Lo que hay que saber de inyectar en una pestaña

- **El micrófono se pide por sitio.** Al pulsar el icono, Chrome pide permiso
  para ese sitio (p. ej. youtube.com). Una vez por sitio.
- **Navegar o recargar la pestaña destruye el script.** Hay que volver a pulsar
  el icono. Una pestaña dedicada que no toques es lo más cómodo.
- **No funciona en todas las páginas.** `chrome://`, la Chrome Web Store y los
  sitios que bloquean el micrófono con `Permissions-Policy` no lo admiten.
- **El texto lo envía el service worker, no la página.** Así la CSP del sitio no
  puede bloquear la conexión con el backend.
- **Entrega desacoplada**: `deliver()` en `server.js` intenta kitty → wtype →
  portapapeles. Si cambias de terminal, es lo único que se toca.

## Instalación

### 1. Backend

```bash
cd backend
yarn install
yarn dev      # node --watch: recarga al guardar
```

Los logs salen por esa terminal, con colores y hora:

```
1:17:39 ✓ escuchando en http://127.0.0.1:8777 (HTTP + WebSocket)
1:17:41 ✓ micrófono ACTIVADO {"extensiones":1}
1:17:46 ✓ «crea un server component para el dashboard» {"entregado":"kitty"}
```

El primer arranque crea `~/.config/dictado/config.json` con un **token
aleatorio** y lo imprime. Míralo cuando quieras con:

```bash
cat ~/.config/dictado/config.json
```

### 1b. Backend en Docker (alternativa)

```bash
cd backend
docker compose up -d --build   # arranca y se reinicia solo con el sistema
docker compose logs -f         # logs en vivo
```

`server.js` está montado y corre con `node --watch`: guardas y se recarga.
Al recargarse sigue dictando a la misma terminal (`~/.config/dictado/estado.json`),
pero hay que volver a decir «open». Si cierras esa terminal, el micrófono se
detiene en unos segundos y `dictado-ctl` ya puede empezar desde otra.
El contenedor necesita ver cosas del host, y cada montaje tiene su motivo
(comentado en `compose.yaml`): `/tmp` para los sockets de kitty, la carpeta de
Hyprland para saber qué kitty está enfocado, `kitten` del host y `pid: host`
porque **cada instancia de kitty tiene su propia clave pública** y solo aparece
en el entorno de sus procesos, en `/proc`.

### 2. Extensión

1. Abre `chrome://extensions`
2. Activa **Modo de desarrollador**
3. **Cargar descomprimida** → selecciona la carpeta `extension/`

### 3. Configurar

Clic derecho en el icono de la extensión → **Opciones**:

1. Pega el **token** y elige el **idioma**. Guardar. El punto de estado se pone
   verde.
2. Opcional: la **prueba de transcripción** para ver la calidad.

### 4. kitty (ya configurado)

Añadido a `~/.config/kitty/kitty.conf`:

```conf
allow_remote_control password
remote_control_password "dictado" send-text
listen_on unix:/tmp/kitty-dictado
```

El password limita el control remoto **solo** a `send-text`: no puede lanzar
procesos ni leer el contenido de tus ventanas. Requiere **reiniciar kitty**
(`allow_remote_control` no se recarga en caliente).

### 5. Hyprland (opcional, aplícalo tú)

Nada de esto está puesto. Son snippets; el proyecto funciona sin ellos.

Atajo — `SUPER + D` está ocupado por rofi, así que `SUPER + V` ("voz"), en
`UserConfigs/UserKeybinds.conf`:

```conf
bind = $mainMod, V, exec, $HOME/Desktop/personal-projects/dictado-voz/backend/dictado-ctl toggle
```

## Uso

1. Ve a la pestaña que quieras usar y pulsa el icono de Dictado. Acepta el
   micrófono si Chrome lo pide. Aparece la pastilla «Dictado listo».
2. Pulsa la pastilla y **elige la terminal** en la lista: el micrófono se enciende
   en espera de «open». **Detener** lo apaga. También puedes ejecutar
   `dictado-ctl toggle` en la terminal donde quieres el texto.

**Adónde va el texto:**

- Elegida en la pastilla → **esa ventana**. Puedes cambiar a otra terminal en pleno
  dictado: el envío se cierra (hay que volver a decir «open»), lo dictado sin Enter
  se queda en la anterior y, a partir de ahí, solo se leen las respuestas de la nueva.
- `dictado-ctl` ejecutado en kitty → **esa misma ventana** (usa `KITTY_PID` y
  `KITTY_WINDOW_ID`). Puedes cambiar el foco a otra cosa y sigue escribiendo ahí.
- Desde un atajo de Hyprland (`SUPER+V`) → el kitty enfocado al pulsarlo.

La lista muestra los kitty con socket de control. Se saca de `/proc` y de Hyprland,
no de `kitten @ ls`: el password sigue permitiendo solo `send-text`. El título de
la ventana solo se usa si ese kitty tiene una sola ventana, y dos terminales de
shell en la misma carpeta se distinguen solo por el número: «proyecto (2)».

**El micrófono arranca en espera: no envía nada hasta que digas «open».**

| Dices | Qué pasa |
|---|---|
| **«open»** | empieza a enviar a la terminal lo que dices (lo que digas después en la misma frase ya se envía) |
| **«stop»** / «estop» | deja de enviar, sin Enter |
| **«enter»** | escribe lo último, pulsa Enter y deja de enviar |

La pastilla de la página lo muestra: **gris** = micro apagado, **azul** =
escuchando a la espera de «open», **roja** parpadeando = enviando a la terminal.

Parar el dictado con `dictado-ctl` también pulsa Enter si quedó algo sin enviar
(`enviarAlParar`).

Y para corregir:

| Dices | Qué hace |
|---|---|
| «borrar eso» | quita la última frase dictada |
| «borrar todo» | vacía el prompt (Ctrl+U) |
| «nueva línea» | salto de línea sin enviar (`\` + Enter, como en Claude Code) |

- «enter», «stop» y «nueva línea» solo cuentan **al final** de la frase: «pulsa
  enter dos veces» se escribe tal cual. «open» vale en cualquier punto.
- **En espera, el audio sigue yendo al motor de voz** (a Google, salvo que el
  panel diga «motor local»): el backend descarta lo que oye, pero el micro está
  abierto. Para cortar de verdad, `dictado-ctl` otra vez.
- «borrar eso/todo» solo cuentan como **frase completa**.
- Enter solo se pulsa si hay algo dictado sin enviar, y siempre en el kitty que
  recibió el texto, aunque hayas cambiado de ventana.
- Las teclas de control (Enter, borrar) solo funcionan con kitty, no con
  `wtype` ni con el portapapeles.
- Las palabras están en `backend/comandos.js`.

## Respuestas de Claude en voz alta

Al terminar cada respuesta, un hook `Stop` de Claude Code
(`backend/dictado-hablar`) se la manda al backend y Chrome la lee con una voz
de Google desde la pestaña inyectada.

- **Solo lee** si estás dictando y la respuesta viene de la terminal donde
  ejecutaste `dictado-ctl`. Tus otras sesiones de Claude no hablan.
- **No lee** código, tablas ni URLs; corta a `leerMaxCaracteres` (1200).
- **No lee** lo que Claude responde a otro hook `Stop` (`stop_hook_active`), como
  el aviso de commit: cortaría la lectura de la respuesta de verdad.
- **Modo voz:** si la respuesta trae un párrafo que empieza por `🔊`, **solo
  lee ese párrafo**. Claude lo escribe porque el hook `UserPromptSubmit`
  (`backend/dictado-modo`) le avisa de que estás dictando a esa terminal, y la
  skill `modo-voz` (`claude/skills/modo-voz/`, enlazada en `~/.claude/skills` y
  `~/.claude-cuenta2/skills`) dice cómo escribirlo: conclusión primero, dos a
  cuatro frases, sin rutas ni código, y una pregunta concreta si te necesita.
- **«más detalle»** (o «lee todo»), dicho en espera y como frase completa, lee
  el resto de la última respuesta, sin el 🔊, hasta `leerDetalleMaxCaracteres`.
- Las tablas y el código se anuncian («tabla», «bloque de código»), no se recitan.
- **Para callarlo en cualquier momento:**
  - decir **«cállate»**, «calla», «silencio», «basta» o «stop». Vale en
    cualquier punto de lo que oiga, salvo que esa palabra esté en el texto que
    se está leyendo (sería el propio altavoz). Con auriculares va mejor;
  - `dictado-ctl callar` (asígnalo a un atajo de Hyprland);
  - clic en la pastilla morada;
  - parar el dictado con `dictado-ctl`.
- Mientras lee, el micro sigue abierto **solo para esas órdenes**: lo demás se
  descarta, porque incluye su propia voz saliendo por los altavoces. Al acabar
  la lectura se tira todo lo captado durante ella (el reconocedor se reinicia),
  para que esa mezcla nunca llegue a la terminal. Por eso un «open» dentro de la
  respuesta no abre el envío.
- La pastilla se pone **morada** mientras lee.
- Chrome no deja hablar a una página sin un clic previo: si hace falta, la
  pastilla lo pide («Clic aquí…»). Vale hasta recargar la página.

Instalar el hook (en el `settings.json` de cada configuración de Claude que
uses, junto a los hooks que ya tengas):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/edu/Desktop/personal-projects/dictado-voz/backend/dictado-hablar",
            "timeout": 5,
            "async": true
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/home/edu/Desktop/personal-projects/dictado-voz/backend/dictado-modo",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

`dictado-modo` no es async: tiene que añadir el aviso antes de que Claude
empiece. Pregunta con un timeout de 0,8 s y, si el backend no está, no añade nada.

`async: true`: corre en segundo plano y nunca retrasa a Claude.

## Configuración

`~/.config/dictado/config.json`:

| clave | por defecto | qué hace |
|---|---|---|
| `port` | `8777` | puerto de HTTP + WebSocket |
| `token` | generado | autentica a la extensión |
| `delivery` | `auto` | `auto` \| `kitty` \| `wtype` \| `clipboard` |
| `kittySocket` | `/tmp/kitty-dictado` | debe coincidir con `listen_on` |
| `kittyPassword` | `dictado` | debe coincidir con `remote_control_password` |
| `kittyMatch` | `""` | vacío = ventana activa; ej. `title:claude` |
| `trailingSpace` | `true` | espacio al final de cada frase |
| `enviarAlParar` | `true` | el `toggle` que para también pulsa Enter |
| `esperaFraseFinalMs` | `1500` | al parar, cuánto esperar la última frase antes del Enter |
| `leerRespuestas` | `true` | leer en voz alta las respuestas de Claude |
| `leerMaxCaracteres` | `1200` | lo que pase de aquí se corta (está en la terminal) |
| `confirmarEnvio` | `"Enviado"` | se dice en voz alta cuando el Enter llega a kitty; `""` lo desactiva |
| `leerDetalleMaxCaracteres` | `4000` | tope de lo que lee «más detalle» |
| `modoVoz` | `true` | avisa a Claude de que escriba el resumen hablado 🔊 |

## API de control

```bash
curl -X POST http://127.0.0.1:8777/toggle
curl http://127.0.0.1:8777/status      # {"listening":false,"clients":1}
```

`dictado-ctl` es un envoltorio de esto en tres líneas de bash.

**Solo desde fuera del navegador.** La API HTTP no lleva token, así que se
protege de otra forma: rechaza (403) toda petición con cabecera `Origin` o
`Sec-Fetch-Site`, que los navegadores siempre mandan en un POST, y toda petición
cuyo `Host` no sea `127.0.0.1:<puerto>` o `localhost:<puerto>` (DNS rebinding).
Sin esto, cualquier web podría encenderte el micro con un
`fetch(…, { mode: 'no-cors' })`. `curl` y el hook no mandan esas cabeceras. Los
rechazos salen en los logs con 🛡.

## Tests

```bash
cd backend && yarn test   # node --test: voz.js y comandos.js, puros
```

## Diagnóstico

La página de opciones tiene un **panel de estado en vivo** (se refresca cada
1.5 s): conexión con el backend, si el micrófono está escuchando, si el motor
corre local o en la nube, la última frase transcrita y el último error. Ese es el
primer sitio donde mirar.

| Síntoma | Dónde mirar |
|---|---|
| No llega nada | la terminal donde corre `yarn dev` |
| La extensión no conecta | `chrome://extensions` → *service worker* → consola |
| El micro no arranca | Candado de la barra de direcciones de esa pestaña → Micrófono → Permitir |
| `sin pestaña con el script` en los logs | Pulsa el icono en una pestaña (o la pestaña navegó) |
| El panel dice «La extensión no responde» | Recarga la extensión en `chrome://extensions`, recarga la pestaña y pulsa el icono. Al inyectar, Chrome lee `content.js` de disco, pero el service worker sigue siendo el de antes hasta recargar |
| El texto no entra en kitty | `dictado-ctl status`; prueba `delivery: "clipboard"` en la config |

`dictado-ctl status` dice si hay extensión conectada (`clients: 1`).

## Por qué no un offscreen document

La primera versión usaba `chrome.offscreen`, que es la forma canónica de tener
un documento invisible. **No funciona para esto.** Medido con instrumentación,
no deducido:

```
[dictado][recognizer] micrófono: { permiso: 'granted', getUserMedia: 'ok', dispositivos: 1 }
[dictado] STT: not-allowed
```

El micrófono es plenamente accesible dentro del offscreen document. Lo que falla
es `SpeechRecognition`, que devuelve `not-allowed` en ese contexto. El mismo
código, con el mismo permiso y el mismo micro, funciona en una página normal de
la extensión — la prueba de la sección 3 lo demuestra.

Son dos permisos distintos que es fácil confundir: **acceso al dispositivo** y
**acceso al servicio de reconocimiento**. Solo el primero se hereda al offscreen.

Por eso el reconocimiento corre en una pestaña normal, inyectado.
