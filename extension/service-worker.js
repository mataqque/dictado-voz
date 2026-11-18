/**
 * Service worker: mantiene el WebSocket con el backend y hace de puente con el
 * script inyectado en la pestaña que elegiste.
 *
 * Clic en el icono → inyecta content.js en esa pestaña (solo una a la vez).
 * El backend manda start/stop → se lo pasamos a la pestaña.
 * La pestaña transcribe → nos manda el texto → lo reenviamos al backend.
 */

const CONTENT_SCRIPT = 'content.js';
/** Sube junto con VERSION en content.js cuando cambien las órdenes que entiende. */
const VERSION_SCRIPT = 8;
const KEEPALIVE_ALARM = 'dictado-keepalive';
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let socket = null;
let connecting = false;
let reconnectMs = RECONNECT_MIN_MS;

/** Traducción de los códigos de la Web Speech API a algo accionable. */
const ERROR_HINTS = {
	'not-allowed':
		'Micrófono denegado para ese sitio. Permítelo en el candado de la barra de direcciones de esa pestaña.',
	'service-not-allowed': 'Chrome bloqueó el servicio de reconocimiento de voz.',
	'audio-capture': 'No se encontró micrófono. Revisa el dispositivo de entrada del sistema.',
	network: 'Sin conexión con el motor de voz y sin modelo local instalado.',
	'language-not-supported': 'El idioma elegido no está soportado.',
};

/** Estado observable desde la página de opciones. */
const state = {
	listening: false,
	onDevice: null, // null = desconocido hasta el primer dictado
	lastError: '',
	lastTranscript: '',
	diagnostico: null, // lo que la pestaña inyectada ve del micrófono
	pendientes: 0, // transcripciones en cola esperando conexión
	pestana: null, // título de la pestaña con el script inyectado
	eventos: [], // bitácora legible para la página de opciones
};

function isConnected() {
	return socket?.readyState === WebSocket.OPEN;
}

/** Bitácora visible en la página de opciones, para no depender de la consola. */
const MAX_EVENTOS = 12;

function anotar(texto) {
	const hora = new Date().toLocaleTimeString('es', { hour12: false });
	state.eventos.unshift(`${hora}  ${texto}`);
	state.eventos.length = Math.min(state.eventos.length, MAX_EVENTOS);
	log(texto);
}

/** Transcripciones aún no entregadas: sobreviven a una caída del socket. */
const pendientes = [];
const MAX_PENDIENTES = 50;

function vaciarCola() {
	while (pendientes.length && isConnected()) {
		socket.send(JSON.stringify({ type: 'transcript', text: pendientes.shift() }));
	}
	// Sin conexión y con la cola llena, descartamos lo más viejo, no lo reciente.
	while (pendientes.length > MAX_PENDIENTES) pendientes.shift();
	state.pendientes = pendientes.length;
}

/** Filtra la consola con "[dictado]" para ver solo lo nuestro. */
function log(...args) {
	console.log('[dictado]', ...args);
}

async function getSettings() {
	// Mismo valor por defecto que options.js (IDIOMA_POR_DEFECTO): si no coinciden,
	// hasta pulsar Guardar se dicta en un idioma distinto del que muestra la página.
	const { token = '', port = 8777, lang = 'es-PE' } = await chrome.storage.local.get([
		'token',
		'port',
		'lang',
	]);
	return { token, port, lang };
}

// ───────────────────────────── WebSocket ─────────────────────────────

async function connect() {
	// El guard tiene que ser síncrono: `socket` no se asigna hasta después del
	// await de abajo, así que dos llamadas concurrentes abrían dos sockets.
	if (connecting) return;
	if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
		return;
	}
	connecting = true;
	try {
		await abrirSocket();
	} finally {
		connecting = false;
	}
}

async function abrirSocket() {
	const { token, port } = await getSettings();
	if (!token) {
		state.lastError = 'Falta el token: pégalo aquí abajo y guarda.';
		return;
	}

	// Los handlers usan `ws`, no la variable global: `onclose` la pone a null y
	// un socket viejo abriéndose tarde reventaba con "Cannot read ... of null".
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	socket = ws;

	ws.onopen = () => {
		reconnectMs = RECONNECT_MIN_MS;
		state.lastError = '';
		ws.send(JSON.stringify({ type: 'hello', token }));
		anotar('🔌 conectado al backend');
		vaciarCola();
	};
	ws.onmessage = (event) => {
		log('← backend:', event.data);
		onServerMessage(event.data);
	};
	ws.onerror = () => {};
	ws.onclose = (event) => {
		log('socket cerrado', { code: event.code, vigente: socket === ws });
		if (socket === ws) anotar(`🔌 sin conexión (código ${event.code})`);
		if (socket !== ws) return; // socket obsoleto: ya hay otro en curso
		socket = null;
		// El dictado NO se para: la pestaña inyectada sigue escuchando y las
		// transcripciones se encolan hasta que vuelva la conexión. Una caída del
		// socket no debe costarte lo que estabas dictando.
		// 1008 = el backend rechazó el token; reintentar no lo va a arreglar.
		state.lastError =
			event.code === 1008 ? 'Token rechazado por el backend.' : 'Sin conexión con el backend.';
		if (event.code === 1008) stopDictation().catch(() => {});
		if (event.code !== 1008) {
			setTimeout(connect, reconnectMs);
			reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
		}
	};
}

async function onServerMessage(raw) {
	let message;
	try {
		message = JSON.parse(raw);
	} catch {
		return;
	}
	if (message.type === 'ping') {
		socket?.send(JSON.stringify({ type: 'pong' }));
		return;
	}
	if (message.type === 'listen') {
		await (message.action === 'start' ? startDictation() : stopDictation());
	}
	// «open» / «stop» / «enter»: la pastilla de la página lo refleja.
	if (message.type === 'compuerta') {
		state.enviando = message.abierta;
		await avisarPestana({ action: 'compuerta', abierta: message.abierta });
	}
	// Respuesta de Claude para leer en voz alta (la lee la pestaña inyectada).
	if (message.type === 'hablar') {
		const { lang } = await getSettings();
		const orden = { action: 'hablar', texto: message.texto, lang, aviso: Boolean(message.aviso) };
		if (!(await avisarPestana(orden))) {
			informarBackend({ type: 'error', error: 'no hay pestaña con el script para leer la respuesta' });
		}
	}
	if (message.type === 'callar') await avisarPestana({ action: 'callar' });
	if (message.type === 'terminales') {
		await avisarPestana({
			action: 'terminales',
			lista: message.lista,
			destinoId: message.destinoId,
			escuchando: message.escuchando,
		});
	}
	if (message.type === 'delivered') {
		const destino = {
			kitty: '✅ escrito en kitty',
			wtype: '✅ tecleado',
			clipboard: '📋 copiado al portapapeles',
			none: '❌ no se pudo entregar',
		};
		anotar(`${destino[message.backend] ?? message.backend}: "${message.text}"`);
	}
	// Al reconectar, el backend manda su estado: alineamos el nuestro con él.
	if (message.type === 'ready') {
		await (message.listening ? startDictation() : stopDictation());
		const tab = await pestanaInyectada();
		informarBackend({ type: 'pestana', title: tab?.title ?? null, url: tab?.url });
	}
}

// ──────────────────────── pestaña con el script inyectado ────────────────────────
//
// Se guarda en storage.session: el service worker se duerme y pierde la
// memoria, pero la pestaña sigue teniendo el script.

async function pestanaInyectada() {
	const { tabId = null } = await chrome.storage.session.get('tabId');
	if (tabId === null) return null;
	try {
		return await chrome.tabs.get(tabId);
	} catch {
		await olvidarPestana(); // la cerraron
		return null;
	}
}

async function olvidarPestana() {
	const { tabId = null } = await chrome.storage.session.get('tabId');
	await chrome.storage.session.remove('tabId');
	state.listening = false;
	state.pestana = null;
	if (tabId !== null) chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

async function avisarPestana(message) {
	const tab = await pestanaInyectada();
	if (!tab) return false;
	try {
		const respuesta = await chrome.tabs.sendMessage(tab.id, { target: 'recognizer', ...message });
		log(`→ pestaña «${tab.title}»:`, message.action);
		// Un script de antes de una actualización contesta sin hacer nada (o no
		// contesta nada útil): sin este aviso, la orden se pierde en silencio.
		if (!respuesta?.ok || respuesta.version !== VERSION_SCRIPT) {
			const aviso = 'la pestaña tiene un script desactualizado: recárgala (F5) y pulsa el icono de Dictado';
			state.lastError = aviso;
			anotar(`⚠ ${aviso}`);
			informarBackend({ type: 'error', error: aviso });
		}
		return true;
	} catch (error) {
		console.warn('[dictado] la pestaña no respondió (¿navegó o se recargó?):', error.message);
		// El script ya no está (la página navegó): hay que volver a inyectar.
		await olvidarPestana();
		return false;
	}
}

/** Clic en el icono: inyecta en esta pestaña, o lo retira si ya estaba aquí. */
async function alternarInyeccion(tab) {
	const actual = await pestanaInyectada();

	if (actual?.id === tab.id) {
		await avisarPestana({ action: 'retirar' });
		await olvidarPestana();
		anotar(`🧹 script retirado de «${tab.title}»`);
		informarBackend({ type: 'pestana', title: null });
		return;
	}

	// Solo una pestaña a la vez: dos reconocedores se pisarían el micrófono.
	if (actual) await avisarPestana({ action: 'retirar' });
	await olvidarPestana();

	try {
		await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT] });
	} catch (error) {
		// chrome://, la Web Store y similares no admiten scripts.
		state.lastError = `No se puede inyectar en esta página: ${error.message}`;
		anotar(`⚠ ${state.lastError}`);
		return;
	}

	await chrome.storage.session.set({ tabId: tab.id });
	state.pestana = tab.title;
	chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
	chrome.action.setBadgeText({ tabId: tab.id, text: 'ON' });
	anotar(`💉 script inyectado en «${tab.title}»`);
	informarBackend({ type: 'pestana', title: tab.title, url: tab.url });

	// Si el backend ya estaba en modo escucha, arrancamos directamente.
	if (estadoBackend.listening) await startDictation();
}

/** Lo que pasa en Chrome también sale en los logs del backend. */
function informarBackend(payload) {
	if (isConnected()) socket.send(JSON.stringify(payload));
}

const estadoBackend = { listening: false };

async function startDictation() {
	estadoBackend.listening = true;
	const { lang } = await getSettings();
	if (!(await avisarPestana({ action: 'start', lang }))) {
		state.lastError = 'No hay pestaña con el script: pulsa el icono de Dictado en la pestaña que quieras.';
		anotar(`⚠ ${state.lastError}`);
		informarBackend({ type: 'error', error: 'sin pestaña con el script inyectado' });
		return;
	}
	state.listening = true;
	anotar('🎙 dictado activado');
}

async function stopDictation() {
	estadoBackend.listening = false;
	state.listening = false;
	if (await avisarPestana({ action: 'stop' })) anotar('🛑 dictado detenido');
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
	const { tabId: inyectada = null } = await chrome.storage.session.get('tabId');
	if (tabId !== inyectada) return;
	await olvidarPestana();
	anotar('🗙 se cerró la pestaña con el script');
	informarBackend({ type: 'pestana', title: null });
});

// Navegar o recargar destruye el script, y el permiso activeTab se pierde con él.
chrome.tabs.onUpdated.addListener(async (tabId, cambio) => {
	if (cambio.status !== 'loading') return;
	const { tabId: inyectada = null } = await chrome.storage.session.get('tabId');
	if (tabId !== inyectada) return;
	await olvidarPestana();
	anotar('↻ la pestaña navegó: vuelve a pulsar el icono para reinyectar');
	informarBackend({ type: 'pestana', title: null });
});

// ─────────────────────────── mensajes del reconocedor ───────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message?.target !== 'sw') return;

	if (message.type === 'transcript') {
		state.lastTranscript = message.text;
		pendientes.push(message.text);
		vaciarCola();
	}
	if (message.type === 'status') state.onDevice = message.onDevice;
	// El panel de la pestaña: la página no habla con el backend, solo este worker.
	if (['pedir-terminales', 'elegir-terminal', 'detener'].includes(message.type)) {
		if (isConnected()) {
			const { target, ...orden } = message;
			informarBackend(orden);
		} else {
			connect();
			avisarPestana({ action: 'terminales', sinConexion: true });
		}
	}
	if (message.type === 'evento') {
		anotar(message.texto);
		informarBackend({ type: 'evento', nivel: message.nivel, texto: message.texto, extra: message.extra });
	}
	if (message.type === 'diagnostico') {
		state.diagnostico = message.informe;
		log('diagnóstico de la pestaña:', message.informe);
		informarBackend({ type: 'diagnostico', informe: message.informe });
	}
	if (message.type === 'error') {
		state.lastError = ERROR_HINTS[message.error] ?? `Motor de voz: ${message.error}`;
		anotar(`⚠ ${state.lastError}`);
		informarBackend({ type: 'error', error: message.error, fatal: message.fatal });
		if (message.fatal) state.listening = false;
	}

	// Consultas de la página de opciones.
	if (message.type === 'get-status') {
		// La pestaña sale de storage: si el worker durmió, `state` la perdió.
		pestanaInyectada().then((tab) =>
			sendResponse({ connected: isConnected(), ...state, pestana: tab?.title ?? null })
		);
		return true; // respuesta asíncrona
	}
	if (message.type === 'reconnect') {
		reconnectMs = RECONNECT_MIN_MS;
		socket?.close();
		connect();
		sendResponse({ ok: true });
	}
});

// ─────────────────────────────── arranque ───────────────────────────────

function boot() {
	chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
	connect();
}

chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(boot);
chrome.alarms.onAlarm.addListener(connect);
chrome.action.onClicked.addListener(alternarInyeccion);

boot();
