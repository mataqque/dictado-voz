/**
 * Puente entre la extensión de dictado y el terminal.
 *
 * Un solo puerto, dos protocolos sobre el mismo servidor HTTP:
 *   - HTTP       ← el keybind de Hyprland (POST /start, /stop, /toggle, GET /status)
 *   - WebSocket  ← la extensión de Chrome (transcripciones)
 *
 * Cuando llega una transcripción la entrega al terminal. El mecanismo de
 * entrega está aislado en `deliver()`: si cambias de terminal, es el único
 * punto que se toca.
 *
 * Desarrollo:  yarn dev     (node --watch, recarga al guardar)
 * Producción:  yarn start
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

import express from 'express';
import { WebSocketServer } from 'ws';

import { buscarApertura, interpretar, pideDetalle } from './comandos.js';
import { destinoVivo, idDelDestino, leerEstadoGuardado, leerStat, listarTerminales, serializarEstado } from './destino.js';
import { limpiarParaVoz, quitarBloqueHablado, textoParaLeer } from './voz.js';

const CONFIG_PATH = process.env.DICTADO_CONFIG ?? path.join(homedir(), '.config/dictado/config.json');
const ESTADO_PATH = path.join(path.dirname(CONFIG_PATH), 'estado.json');
const VIGILANCIA_TERMINAL_MS = 5000;
const PING_INTERVAL_MS = 20_000;
const COMANDO_TIMEOUT_MS = 5000;

const DEFAULTS = {
	port: 8777,
	token: '', // se genera solo en el primer arranque
	delivery: 'auto', // auto | kitty | wtype | clipboard
	kittySocket: '/tmp/kitty-dictado',
	kittyPassword: 'dictado',
	kittyMatch: '', // vacío = ventana activa de kitty; ej. "title:claude"
	trailingSpace: true,
	// Enter sin teclado: decir «enter», o parar el dictado si esto está activo.
	enviarAlParar: true, // el toggle que para el dictado también pulsa Enter
	esperaFraseFinalMs: 1500, // al parar, la última frase aún puede estar en camino
	leerRespuestas: true, // Chrome lee en voz alta las respuestas de Claude (hook Stop)
	leerMaxCaracteres: 1200, // más largo que esto se corta: el resto está en la terminal
	confirmarEnvio: 'Enviado', // se dice en voz alta cuando el Enter llega a kitty; '' = sin aviso
	leerDetalleMaxCaracteres: 4000, // tope de «más detalle»: el resto de la respuesta
	modoVoz: true, // avisa a Claude (hook UserPromptSubmit) de que escriba un resumen hablado
};

const clientes = new Set();
/**
 * listening: el micrófono está encendido (dictado-ctl).
 * enviando: lo que oye se escribe en la terminal. Lo abre «open» y lo cierran
 *   «stop» o «enter». Con el micro encendido y esto cerrado, se ignora todo.
 */
const estado = { listening: false, enviando: false };
let config = null; // se carga en main()

// ──────────────────────────────── logs ────────────────────────────────

const COLORES = { info: '\x1b[36m', ok: '\x1b[32m', aviso: '\x1b[33m', error: '\x1b[31m', gris: '\x1b[90m' };
const RESET = '\x1b[0m';

function log(nivel, mensaje, extra) {
	const hora = new Date().toLocaleTimeString('es', { hour12: false });
	const color = COLORES[nivel] ?? COLORES.info;
	const etiqueta = { info: '·', ok: '✓', aviso: '!', error: '✗', gris: '·' }[nivel] ?? '·';
	const cola = extra === undefined ? '' : ` ${COLORES.gris}${JSON.stringify(extra)}${RESET}`;
	console.log(`${COLORES.gris}${hora}${RESET} ${color}${etiqueta}${RESET} ${mensaje}${cola}`);
}

// ───────────────────────────── configuración ─────────────────────────────

function cargarConfig() {
	let config = { ...DEFAULTS };
	if (existsSync(CONFIG_PATH)) {
		try {
			config = { ...config, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
		} catch (error) {
			log('aviso', `config ilegible (${error.message}); uso valores por defecto`);
		}
	}
	if (!config.token) {
		config.token = randomBytes(16).toString('base64url');
		guardarConfig(config);
		log('ok', `token generado: ${config.token}`);
	}
	return config;
}

function guardarConfig(config) {
	mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// ────────────────────────── entrega al terminal ──────────────────────────

/**
 * Ejecuta un comando de entrega.
 *
 * `capture: false` es obligatorio para procesos que se quedan de demonio con
 * las tuberías abiertas (wl-copy sirve el portapapeles tras forkear): esperar
 * su salida no terminaría nunca.
 */
function ejecutar(cmd, args, { stdin = null, capture = true, env = {} } = {}) {
	return new Promise((resolve) => {
		const hijo = spawn(cmd, args, {
			env: { ...process.env, ...env },
			stdio: [
				stdin === null ? 'ignore' : 'pipe',
				capture ? 'pipe' : 'ignore',
				capture ? 'pipe' : 'ignore',
			],
		});

		let stderr = '';
		hijo.stderr?.on('data', (trozo) => (stderr += trozo));

		const temporizador = setTimeout(() => {
			hijo.kill('SIGKILL');
			log('error', `${cmd} agotó el tiempo de espera`);
			resolve(false);
		}, COMANDO_TIMEOUT_MS);

		hijo.on('error', (error) => {
			clearTimeout(temporizador);
			log('error', `no se pudo ejecutar ${cmd}`, { motivo: error.message });
			resolve(false);
		});

		hijo.on('close', (code) => {
			clearTimeout(temporizador);
			if (code !== 0) log('aviso', `${cmd} salió con ${code}`, { stderr: stderr.trim().slice(0, 200) });
			resolve(code === 0);
		});

		if (stdin !== null) hijo.stdin.end(stdin);
	});
}

function existeComando(cmd) {
	return (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(path.join(dir, cmd)));
}

/**
 * Socket IPC de Hyprland. Se habla con él directamente en vez de con `hyprctl`
 * para no depender del binario (dentro de Docker no está). Si no hay firma en
 * el entorno se usa la instancia más reciente: sobrevive a reiniciar Hyprland
 * sin tocar el contenedor.
 */
function socketHyprland() {
	const raiz = path.join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`, 'hypr');
	if (!existsSync(raiz)) return null;
	const firma = process.env.HYPRLAND_INSTANCE_SIGNATURE;
	const instancias = firma
		? [firma]
		: readdirSync(raiz).sort((a, b) => statSync(path.join(raiz, b)).mtimeMs - statSync(path.join(raiz, a)).mtimeMs);
	for (const instancia of instancias) {
		const ruta = path.join(raiz, instancia, '.socket.sock');
		if (existsSync(ruta)) return ruta;
	}
	return null;
}

/** Pregunta a Hyprland por su socket. Sin Hyprland o sin respuesta válida: null. */
function consultarHyprland(comando) {
	const ruta = socketHyprland();
	if (!ruta) return Promise.resolve(null);
	return new Promise((resolve) => {
		let respuesta = '';
		const conexion = createConnection(ruta, () => conexion.write(comando));
		conexion.setEncoding('utf8'); // los títulos llevan tildes: un trozo puede partir un carácter
		conexion.setTimeout(1000, () => conexion.destroy());
		conexion.on('data', (trozo) => (respuesta += trozo));
		conexion.on('error', () => resolve(null));
		conexion.on('close', () => {
			try {
				resolve(JSON.parse(respuesta));
			} catch {
				resolve(null);
			}
		});
	});
}

/**
 * PID de la ventana enfocada si es un kitty. Con varios kitty abiertos, es lo
 * que decide a cuál va el texto.
 */
async function pidKittyEnfocado() {
	const ventana = await consultarHyprland('j/activewindow');
	return ventana?.class === 'kitty' ? ventana.pid : null;
}

const esSocket = (ruta) => statSync(ruta, { throwIfNoEntry: false })?.isSocket() === true;

/** Resuelve el socket de kitty; tolera el sufijo -<pid> que kitty le añade. */
async function socketKitty(base) {
	if (esSocket(base)) return base;

	// Primero el kitty enfocado: si no, el texto caería en el último que se abrió.
	const pid = await pidKittyEnfocado();
	if (pid && esSocket(`${base}-${pid}`)) return `${base}-${pid}`;

	const dir = path.dirname(base);
	const prefijo = path.basename(base);
	if (!existsSync(dir)) return null;

	const candidatos = readdirSync(dir)
		.filter((nombre) => nombre.startsWith(prefijo))
		.map((nombre) => path.join(dir, nombre))
		.filter(esSocket)
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

	log('aviso', 'la ventana enfocada no es un kitty: uso el último abierto', { socket: candidatos[0] });
	return candidatos[0] ?? null;
}

/**
 * Cada instancia de kitty genera su propia clave pública al arrancar, y
 * `kitten` la necesita para cifrar la contraseña. Solo está en el entorno de
 * los procesos que esa instancia lanzó, así que la buscamos en /proc (en Docker
 * hace falta `pid: host`). Es estable mientras viva el kitty: se cachea.
 */
const clavesKitty = new Map();

function clavePublicaKitty(pid) {
	if (clavesKitty.has(pid)) return clavesKitty.get(pid);
	for (const proceso of readdirSync('/proc')) {
		if (!/^\d+$/.test(proceso)) continue;
		let entorno;
		try {
			entorno = readFileSync(`/proc/${proceso}/environ`, 'utf8').split('\0');
		} catch {
			continue; // de otro usuario o ya terminó
		}
		if (!entorno.includes(`KITTY_PID=${pid}`)) continue;
		const clave = entorno.find((variable) => variable.startsWith('KITTY_PUBLIC_KEY='));
		if (clave) {
			clavesKitty.set(pid, clave.slice('KITTY_PUBLIC_KEY='.length));
			return clavesKitty.get(pid);
		}
	}
	return null;
}

/**
 * Ventana de kitty a la que va todo el dictado: se fija al empezar y no cambia
 * aunque muevas el foco. Así Enter y los borrados caen en el mismo prompt.
 *   socket: el de la instancia de kitty (/tmp/kitty-dictado-<pid>)
 *   ventana: id de la ventana dentro de esa instancia, o null = la activa
 */
let destino = null;

/**
 * Decide el destino al empezar a dictar.
 *   - `dictado-ctl` ejecutado dentro de kitty manda KITTY_PID y KITTY_WINDOW_ID:
 *     el texto va a esa misma ventana.
 *   - Desde un atajo de Hyprland no hay esas variables: se usa el kitty
 *     enfocado en ese momento.
 */
async function fijarDestino(origen = {}) {
	// Solo dígitos: van a parar a argumentos de kitten.
	const pid = /^\d+$/.test(origen.kittyPid ?? '') ? origen.kittyPid : null;
	const ventana = /^\d+$/.test(origen.kittyWindowId ?? '') ? origen.kittyWindowId : null;

	if (pid && esSocket(`${config.kittySocket}-${pid}`)) {
		destino = { socket: `${config.kittySocket}-${pid}`, ventana };
		log('ok', '🎯 destino: la terminal donde ejecutaste dictado-ctl', { kitty: pid, ventana });
		return;
	}
	if (pid) log('aviso', `ese kitty (${pid}) no tiene socket de control; uso el enfocado`);

	const socket = await socketKitty(config.kittySocket);
	destino = socket ? { socket, ventana: null } : null;
	if (destino) log('ok', '🎯 destino: el kitty enfocado al empezar', { kitty: socket.match(/-(\d+)$/)?.[1] });
	else log('error', 'no encuentro ningún kitty con socket de control');
}

/**
 * ¿Queda algún proceso en esa ventana? Se mira en /proc porque el password de
 * kitty solo permite send-text, a propósito, así que no se le puede preguntar.
 */
function ventanaKittyViva(pid, ventana) {
	return readdirSync('/proc').some((proceso) => {
		if (!/^\d+$/.test(proceso)) return false;
		try {
			const entorno = readFileSync(`/proc/${proceso}/environ`, 'utf8').split('\0');
			return entorno.includes(`KITTY_PID=${pid}`) && entorno.includes(`KITTY_WINDOW_ID=${ventana}`);
		} catch {
			return false; // de otro usuario o ya terminó
		}
	});
}

const terminalAbierta = (terminal) =>
	destinoVivo(terminal, {
		esSocket,
		procesoVivo: (pid) => existsSync(`/proc/${pid}`),
		ventanaViva: ventanaKittyViva,
	});

/**
 * Todos los procesos lanzados desde una ventana de kitty. Se lee de /proc porque
 * el password de kitty solo permite send-text, a propósito: `kitten @ ls` no vale.
 */
function procesosDeKitty() {
	const procesos = [];
	for (const pid of readdirSync('/proc')) {
		if (!/^\d+$/.test(pid)) continue;
		try {
			const entorno = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
			const variable = (nombre) => entorno.find((v) => v.startsWith(`${nombre}=`))?.slice(nombre.length + 1);
			const kittyPid = variable('KITTY_PID');
			const ventana = variable('KITTY_WINDOW_ID');
			if (!kittyPid || !ventana) continue;
			procesos.push({
				pid,
				kittyPid,
				ventana,
				cwd: readlinkSync(`/proc/${pid}/cwd`),
				...leerStat(readFileSync(`/proc/${pid}/stat`, 'utf8')),
			});
		} catch {
			continue; // de otro usuario o ya terminó
		}
	}
	return procesos;
}

async function terminalesAbiertas() {
	const clientes = await consultarHyprland('j/clients');
	const ventanas = (Array.isArray(clientes) ? clientes : [])
		.filter((cliente) => cliente.class === 'kitty')
		.map((cliente) => ({ pid: cliente.pid, titulo: cliente.title, escritorio: cliente.workspace?.name }));
	return listarTerminales(procesosDeKitty(), (pid) => esSocket(`${config.kittySocket}-${pid}`), ventanas);
}

/** Lo que el panel de la pestaña necesita: qué hay abierto y adónde va el dictado. */
async function difundirTerminales() {
	const lista = await terminalesAbiertas();
	difundir({
		type: 'terminales',
		lista,
		destinoId: estado.listening ? idDelDestino(destino, lista) : null,
		escuchando: estado.listening,
	});
}

/**
 * Elegida en el panel. Con el micro apagado lo enciende, en espera de «open». Con
 * el dictado en marcha cambia de terminal y cierra el envío: una frase a medias
 * no debe acabar en otro prompt, y lo dictado sin Enter se queda donde está.
 */
async function elegirTerminal({ kittyPid, kittyWindowId }) {
	// La lista es la validación: lo que no esté abierto ahora no llega a kitten.
	const terminal = (await terminalesAbiertas()).find((t) => t.kittyPid === kittyPid && t.ventana === kittyWindowId);
	if (!terminal) {
		log('aviso', 'esa terminal ya no está abierta');
		return difundirTerminales();
	}
	if (!estado.listening) return fijarEscucha(true, { kittyPid, kittyWindowId });

	const socket = `${config.kittySocket}-${kittyPid}`;
	if (destino?.socket === socket && destino.ventana === kittyWindowId) return difundirTerminales();

	fijarEnvio(false, 'cambiaste de terminal');
	// En la cola: lo que ya estaba escribiéndose termina en la terminal anterior.
	await enCola(() => {
		destino = { socket, ventana: kittyWindowId };
		prompt.frases = [];
		ultimaRespuesta = ''; // «más detalle» no debe leer la respuesta de otra terminal
		guardarEstado();
		log('ok', `🎯 destino: «${terminal.nombre}», elegida en el panel`, { kitty: kittyPid, ventana: kittyWindowId });
	});
	return difundirTerminales();
}

/** Al disco, para que un reinicio del servidor no corte el dictado. Sin él, solo se pierde eso. */
function guardarEstado() {
	try {
		const temporal = `${ESTADO_PATH}.tmp`;
		writeFileSync(temporal, serializarEstado(estado.listening, destino));
		renameSync(temporal, ESTADO_PATH);
	} catch (error) {
		log('aviso', 'no pude guardar el estado del dictado', { motivo: error.message });
	}
}

/**
 * Sigue dictando a la terminal de antes del reinicio, si aún está abierta. Tras
 * apagar la laptop ya no lo está, así que el micro no se enciende solo. El envío
 * no se restaura: hay que volver a decir «open».
 */
function restaurarEstado() {
	if (!existsSync(ESTADO_PATH)) return;
	const guardado = leerEstadoGuardado(readFileSync(ESTADO_PATH, 'utf8'), config.kittySocket);
	if (guardado && terminalAbierta(guardado)) {
		destino = guardado;
		estado.listening = true;
		log('ok', '🎯 sigo con la terminal de antes del reinicio: di «open» para enviar', guardado);
		return;
	}
	guardarEstado(); // lo que hubiera ya no vale: que no se reintente
}

/**
 * La terminal se cerró. No pasa por la parada normal: su Enter final, sin terminal,
 * caería en lo que tengas enfocado. Sin destino, el siguiente dictado-ctl empieza
 * desde cualquier otra terminal.
 */
function liberarTerminal() {
	log('aviso', '🔌 la terminal del dictado se cerró: micrófono detenido, ya puedes empezar desde otra');
	clearTimeout(temporizadorParada);
	temporizadorParada = null;
	destino = null;
	estado.listening = false;
	prompt.frases = [];
	fijarEnvio(false, 'terminal cerrada');
	difundir({ type: 'listen', action: 'stop' });
	guardarEstado();
	difundirTerminales();
}

/** @returns {boolean} si se puede seguir dictando a la terminal elegida. */
function comprobarTerminal() {
	if (!estado.listening || !destino || terminalAbierta(destino)) return true;
	liberarTerminal();
	return false;
}

async function enviarKitty(texto, config) {
	const socket = destino?.socket ?? (await socketKitty(config.kittySocket));
	if (!socket) return false;
	if (!existeComando('kitten')) return false;

	const pid = socket.match(/-(\d+)$/)?.[1];
	const clave = pid ? clavePublicaKitty(pid) : null;
	if (config.kittyPassword && !clave) {
		log('error', 'no encuentro la clave pública de ese kitty', { socket });
		return false;
	}

	const args = ['@', '--to', `unix:${socket}`];
	if (config.kittyPassword) args.push('--password', config.kittyPassword);
	args.push('send-text', '--stdin');
	const match = destino?.ventana ? `id:${destino.ventana}` : config.kittyMatch;
	if (match) args.push('--match', match);

	return ejecutar('kitten', args, { stdin: texto, env: clave ? { KITTY_PUBLIC_KEY: clave } : {} });
}

const BACKENDS = {
	kitty: (texto, config) => enviarKitty(texto, config),
	wtype: (texto) => (existeComando('wtype') ? ejecutar('wtype', ['--', texto]) : Promise.resolve(false)),
	clipboard: (texto) =>
		existeComando('wl-copy')
			? ejecutar('wl-copy', ['--', texto], { capture: false })
			: Promise.resolve(false),
};

/** Entrega el texto al terminal. Devuelve el backend que funcionó o 'none'. */
async function deliver(contenido, config) {
	const cadena = config.delivery === 'auto' ? ['kitty', 'wtype', 'clipboard'] : [config.delivery];

	for (const nombre of cadena) {
		if (await BACKENDS[nombre](contenido, config)) return nombre;
	}
	return 'none';
}

// ──────────────────────────────── WebSocket ────────────────────────────────

function difundir(payload) {
	const mensaje = JSON.stringify(payload);
	for (const cliente of clientes) {
		if (cliente.readyState === cliente.OPEN) cliente.send(mensaje);
	}
}

/**
 * Al parar, Chrome todavía entrega la última frase un momento después. Durante
 * esperaFraseFinalMs el envío sigue como estaba (abierto, si lo estaba) para no
 * perderla; después se cierra y, si toca, se pulsa Enter.
 */
let temporizadorParada = null;

function cerrarTrasParar() {
	clearTimeout(temporizadorParada);
	temporizadorParada = null;
	fijarEnvio(false, 'dictado parado');
	if (config.enviarAlParar) return enCola(() => pulsarEnter('al parar el dictado'));
}

async function fijarEscucha(activo, origen) {
	// /start ya activo (o /stop ya parado) no cambia nada: si siguiera, cerraría
	// un «open» en curso, o reprogramaría la parada y su Enter.
	if (activo === estado.listening) {
		log('gris', `ya estaba ${activo ? 'activo' : 'parado'}: sin cambios`);
		return;
	}
	if (activo) {
		// Volver a empezar antes de que acabe la espera de la parada anterior:
		// se cierra aquella ya (con su Enter) para que no caiga en el dictado nuevo.
		if (temporizadorParada) await cerrarTrasParar();
		// El destino se fija antes de abrir el micro: la primera frase ya sabe adónde ir.
		await fijarDestino(origen);
		// Dictado nuevo, prompt nuevo: restos de antes no deben provocar un Enter.
		prompt.frases = [];
	}
	estado.listening = activo;
	guardarEstado();
	difundir({ type: 'listen', action: activo ? 'start' : 'stop' });
	log(activo ? 'ok' : 'info', `micrófono ${activo ? 'ACTIVADO' : 'detenido'}`, {
		extensiones: clientes.size,
	});
	difundirTerminales();

	if (activo) {
		// El micro arranca en espera: no se envía nada hasta que digas «open».
		fijarEnvio(false, 'esperando «open»');
		return;
	}
	clearTimeout(temporizadorParada);
	temporizadorParada = setTimeout(cerrarTrasParar, Math.max(0, config.esperaFraseFinalMs ?? 0));
}

/** Abre o cierra el envío y lo avisa a la pestaña (la pastilla cambia de color). */
function fijarEnvio(abierto, motivo) {
	const cambia = estado.enviando !== abierto;
	estado.enviando = abierto;
	difundir({ type: 'compuerta', abierta: abierto });
	if (cambia || motivo) {
		log(abierto ? 'ok' : 'info', abierto ? '▶ enviando a la terminal' : `⏸ sin enviar${motivo ? ` (${motivo})` : ''}`);
	}
}

// ───────────────────────────── prompt y comandos ─────────────────────────────

/**
 * Todo lo que escribe en kitty pasa por esta cola, en orden: si «texto» y su
 * Enter se cruzaran, se enviaría el prompt sin la última frase.
 */
let cola = Promise.resolve();
const enCola = (tarea) => (cola = cola.then(tarea).catch((error) => log('error', 'fallo al escribir', { motivo: error.message })));

/** Lo dictado desde el último Enter, frase a frase (para «borrar eso»). */
const prompt = { frases: [] };

/** Secuencias de teclas tal como las recibe el terminal. */
const TECLAS = {
	enter: '\r',
	borrarLinea: '\x15', // Ctrl+U
	retroceso: '\x7f',
	nuevaLinea: '\\\r', // «\» + Enter: salto de línea en Claude Code sin enviar
};

/** Teclas de control: solo kitty puede (wtype/portapapeles no). */
async function teclas(secuencia, motivo) {
	const ok = await enviarKitty(secuencia, config);
	if (!ok) log('error', `no se pudo ${motivo}: las teclas de control solo funcionan con kitty`);
	return ok;
}

async function pulsarEnter(motivo) {
	if (!prompt.frases.length) return; // nada dictado: no mandamos un Enter suelto
	if (await teclas(TECLAS.enter, 'pulsar Enter')) {
		log('ok', `⏎ prompt enviado (${motivo})`, { texto: prompt.frases.join('').trim() });
		prompt.frases = [];
		// Solo aquí: kitten terminó sin error, así que el Enter llegó de verdad.
		if (config.confirmarEnvio) difundir({ type: 'hablar', texto: config.confirmarEnvio, aviso: true });
	}
}

async function escribir(texto) {
	const contenido = config.trailingSpace ? `${texto} ` : texto;
	const backend = await deliver(contenido, config);
	log(backend === 'none' ? 'error' : 'ok', `«${texto}»`, { entregado: backend });
	// La extensión muestra este resultado en su panel: así el usuario ve qué
	// pasó sin tener que mirar esta consola.
	difundir({ type: 'delivered', backend, text: texto });
	if (backend !== 'none') prompt.frases.push(contenido);
}

const ACCIONES = {
	enviar: () => pulsarEnter('dijiste «enter»'),
	parar: async () => {}, // solo cierra el envío, ver alRecibirTranscripcion
	'nueva-linea': async () => {
		if (await teclas(TECLAS.nuevaLinea, 'saltar de línea')) {
			prompt.frases.push('\n');
			log('ok', '↵ nueva línea');
		}
	},
	'borrar-ultima': async () => {
		const ultima = prompt.frases.pop();
		if (!ultima) return log('aviso', 'nada que borrar');
		// Un retroceso por carácter (no por byte: «ñ» o una tilde son uno).
		if (await teclas(TECLAS.retroceso.repeat([...ultima].length), 'borrar la última frase')) {
			log('ok', `⌫ borrado «${ultima.trim()}»`);
		} else {
			prompt.frases.push(ultima);
		}
	},
	'borrar-todo': async () => {
		if (await teclas(TECLAS.borrarLinea, 'borrar el prompt')) {
			prompt.frases = [];
			log('ok', '⌫ prompt borrado');
		}
	},
};

async function alRecibirTranscripcion(mensaje) {
	const frase = (mensaje.text ?? '').trim();
	if (!frase) return log('aviso', 'llegó una transcripción vacía');
	// Antes de entregar: si kitty se atasca, al menos consta que el texto llegó.
	log(estado.enviando ? 'info' : 'gris', `← texto de Chrome: «${frase}»`);
	// Sin esto, entre dos vigilancias la frase acabaría en la ventana enfocada.
	if (!comprobarTerminal()) return;

	// En espera solo cuenta «open»; lo que venga después en la misma frase sí se envía.
	let resto = frase;
	if (!estado.enviando) {
		// Parado, una frase tardía no puede reabrir el envío aunque diga «open».
		if (!estado.listening) return log('gris', '  ignorado: el dictado está parado');
		if (pideDetalle(frase)) return leerDetalle();
		resto = buscarApertura(frase);
		if (resto === null) return log('gris', '  ignorado: di «open» para empezar a enviar');
		fijarEnvio(true);
		if (!resto) return;
	}

	const { texto, accion } = interpretar(resto);
	// «stop» y «enter» cierran el envío ya, antes de escribir: una frase que
	// llegue mientras se escribe esta no debe colarse.
	if (accion === 'parar' || accion === 'enviar') fijarEnvio(false, `dijiste «${accion === 'parar' ? 'stop' : 'enter'}»`);
	await enCola(async () => {
		if (texto) await escribir(texto);
		if (accion) {
			log('info', `comando de voz: ${accion}`);
			await ACCIONES[accion]();
		}
	});
}

function atenderConexion(socket, config) {
	let autenticado = false;

	socket.on('message', async (datos) => {
		let mensaje;
		try {
			mensaje = JSON.parse(datos.toString());
		} catch {
			return;
		}

		if (!autenticado) {
			if (mensaje.type !== 'hello' || mensaje.token !== config.token) {
				log('error', 'extensión rechazada: token inválido');
				socket.close(1008, 'token invalido');
				return;
			}
			autenticado = true;
			clientes.add(socket);
			log('ok', 'extensión conectada', { total: clientes.size });
			socket.send(JSON.stringify({ type: 'ready', listening: estado.listening }));
			socket.send(JSON.stringify({ type: 'compuerta', abierta: estado.enviando }));
			difundirTerminales();
			return;
		}

		if (mensaje.type === 'transcript') await alRecibirTranscripcion(mensaje);
		if (mensaje.type === 'pedir-terminales') await difundirTerminales();
		if (mensaje.type === 'elegir-terminal') await elegirTerminal(mensaje);
		if (mensaje.type === 'detener') await fijarEscucha(false);
		// Lo que pasa en Chrome, para verlo aquí sin abrir consolas del navegador.
		if (mensaje.type === 'pestana') {
			if (mensaje.title) log('ok', `script activo en la pestaña «${mensaje.title}»`, { url: mensaje.url });
			else log('aviso', 'ninguna pestaña tiene el script: pulsa el icono de Dictado en una');
		}
		if (mensaje.type === 'diagnostico') log('info', 'permiso de micrófono comprobado en la pestaña', mensaje.informe);
		if (mensaje.type === 'evento') log(mensaje.nivel ?? 'info', `Chrome: ${mensaje.texto}`, mensaje.extra);
		if (mensaje.type === 'error') log('error', `Chrome: ${mensaje.error}`, mensaje.fatal ? { fatal: true } : undefined);
	});

	socket.on('close', (code) => {
		clientes.delete(socket);
		if (autenticado) log('info', 'extensión desconectada', { code, vivos: clientes.size });
	});

	socket.on('error', (error) => log('error', 'error de socket', { motivo: error.message }));
}

// ─────────────────────────── respuestas en voz alta ───────────────────────────

/**
 * ¿Esta respuesta es de la terminal donde estás dictando? Solo esa habla: tus
 * otras sesiones de Claude no deben ponerse a leer en voz alta.
 */
function esDelDestino({ kittyPid, kittyWindowId }) {
	if (!destino || !/^\d+$/.test(kittyPid ?? '')) return false;
	if (!destino.socket.endsWith(`-${kittyPid}`)) return false;
	return !destino.ventana || destino.ventana === String(kittyWindowId);
}

/** Lo llama el hook Stop de Claude Code (dictado-hablar) al terminar cada respuesta. */
function alPedirLectura(cuerpo = {}) {
	const respuesta = typeof cuerpo.texto === 'string' ? cuerpo.texto : '';
	if (!config.leerRespuestas) return { leido: false, motivo: 'leerRespuestas desactivado' };
	if (!estado.listening) return { leido: false, motivo: 'no estás dictando' };
	if (!esDelDestino(cuerpo)) return { leido: false, motivo: 'no es la terminal del dictado' };

	ultimaRespuesta = respuesta;
	const texto = textoParaLeer(respuesta, config.leerMaxCaracteres);
	if (!texto) return { leido: false, motivo: 'respuesta vacía' };

	difundir({ type: 'hablar', texto });
	log('ok', `🔊 leyendo la respuesta de Claude (${texto.length} caracteres)`, { inicio: texto.slice(0, 80) });
	return { leido: true };
}

/** La última respuesta leída, entera: «más detalle» lee lo que no era resumen. */
let ultimaRespuesta = '';

function leerDetalle() {
	const texto = limpiarParaVoz(quitarBloqueHablado(ultimaRespuesta), config.leerDetalleMaxCaracteres);
	if (!texto) return log('aviso', '«más detalle»: no hay respuesta que ampliar');
	difundir({ type: 'hablar', texto });
	log('ok', `🔊 leyendo el detalle de la respuesta (${texto.length} caracteres)`);
}

/**
 * Lo llama el hook UserPromptSubmit (dictado-modo) antes de cada prompt: si
 * estás dictando a esta terminal, Claude responde con un resumen para oír.
 */
function modoVozActivo(origen = {}) {
	return Boolean(config.modoVoz && config.leerRespuestas && estado.listening && esDelDestino(origen));
}

// ──────────────────────────── API HTTP de control ────────────────────────────

/**
 * Host válido: solo el puerto local. Una página que use DNS rebinding (un
 * dominio suyo que resuelve a 127.0.0.1) llega con su propio Host y se rechaza.
 */
function hostLocal(host) {
	return host === `127.0.0.1:${config.port}` || host === `localhost:${config.port}`;
}

/**
 * La API HTTP no lleva token: la protege que solo se pueda llamar desde fuera
 * de un navegador. Un fetch(…, { mode: 'no-cors' }) desde cualquier web llega
 * igual (CORS solo impide LEER la respuesta, no que la petición se ejecute), y
 * sin esto podría encenderte el micro. Los navegadores siempre mandan Origin
 * o Sec-Fetch-Site en un POST; curl (dictado-ctl) y el hook no mandan ninguna.
 */
function soloLocalSinNavegador(req, res, next) {
	const motivo = !hostLocal(req.headers.host)
		? `Host no permitido (${req.headers.host ?? 'ninguno'})`
		: req.headers.origin !== undefined
			? `petición desde un navegador (Origin: ${req.headers.origin})`
			: req.headers['sec-fetch-site'] !== undefined
				? `petición desde un navegador (Sec-Fetch-Site: ${req.headers['sec-fetch-site']})`
				: null;
	if (!motivo) return next();
	log('aviso', `🛡 rechazado ${req.method} ${req.path}: ${motivo}`);
	res.status(403).json({ error: 'solo se acepta desde esta máquina y fuera del navegador' });
}

function crearApi() {
	const api = express();
	// Antes que nada, incluido el parseo del cuerpo: lo rechazado no se procesa.
	api.use(soloLocalSinNavegador);
	api.use(express.json({ limit: '2mb' })); // /hablar trae respuestas enteras de Claude

	api.use((req, _res, next) => {
		if (req.path !== '/status') log('info', `${req.method} ${req.path}`);
		next();
	});

	const responder = (res) => res.json({ listening: estado.listening, clients: clientes.size });

	api.get('/status', (_req, res) => responder(res));
	// El cuerpo trae KITTY_PID/KITTY_WINDOW_ID de quien llama (ver dictado-ctl).
	api.post('/start', async (req, res) => (await fijarEscucha(true, req.body), responder(res)));
	api.post('/stop', async (_req, res) => (await fijarEscucha(false), responder(res)));
	api.post('/hablar', (req, res) => {
		const resultado = alPedirLectura(req.body);
		if (!resultado.leido) log('gris', `🔇 respuesta de Claude sin leer: ${resultado.motivo}`);
		res.json(resultado);
	});
	api.post('/modo', (req, res) => res.json({ voz: modoVozActivo(req.body) }));
	// Corta la lectura en voz alta al momento (dictado-ctl callar / un atajo).
	api.post('/callar', (_req, res) => {
		difundir({ type: 'callar' });
		log('info', '🔇 callar pedido');
		responder(res);
	});
	api.post('/toggle', async (req, res) => (await fijarEscucha(!estado.listening, req.body), responder(res)));

	api.use((_req, res) => res.status(404).json({ error: 'ruta desconocida' }));
	return api;
}

// ─────────────────────────────── arranque ───────────────────────────────

function main() {
	config = cargarConfig();
	restaurarEstado();

	const servidor = createServer(crearApi());
	// El WebSocket sí lleva token (es la extensión, con Origin chrome-extension://);
	// el Host se comprueba igual por DNS rebinding.
	const wss = new WebSocketServer({
		server: servidor,
		verifyClient: ({ req }) => {
			if (hostLocal(req.headers.host)) return true;
			log('aviso', `🛡 WebSocket rechazado: Host no permitido (${req.headers.host ?? 'ninguno'})`);
			return false;
		},
	});
	wss.on('connection', (socket) => atenderConexion(socket, config));

	const latido = setInterval(() => difundir({ type: 'ping' }), PING_INTERVAL_MS);
	const vigilancia = setInterval(comprobarTerminal, VIGILANCIA_TERMINAL_MS);

	servidor.listen(config.port, '127.0.0.1', () => {
		log('ok', `escuchando en http://127.0.0.1:${config.port} (HTTP + WebSocket)`);
		log('info', 'esperando a que la extensión de Chrome conecte…');
	});

	servidor.on('error', (error) => {
		if (error.code === 'EADDRINUSE') log('error', `el puerto ${config.port} ya está ocupado`);
		else log('error', 'fallo del servidor', { motivo: error.message });
		process.exit(1);
	});

	const cerrar = () => {
		clearInterval(latido);
		clearInterval(vigilancia);
		// Sin esto servidor.close() espera para siempre a que la extensión se
		// desconecte, y `node --watch` se queda en "Waiting for graceful termination".
		for (const cliente of wss.clients) cliente.terminate();
		wss.close();
		servidor.close(() => process.exit(0));
	};
	process.on('SIGINT', cerrar);
	process.on('SIGTERM', cerrar);
}

main();
