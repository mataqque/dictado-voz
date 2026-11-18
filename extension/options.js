/**
 * Página de opciones. Cumple tres funciones:
 *   1. Muestra qué pestaña tiene el script y el estado de la conexión.
 *   2. Guarda token, puerto e idioma.
 *   3. Deja probar la transcripción sin depender del backend.
 */

const Engine = self.SpeechRecognition || self.webkitSpeechRecognition;

const $ = (id) => document.getElementById(id);
const estado = $('estado');
const salida = $('prueba-salida');

// ── 0 · estado en vivo ────────────────────────────────────────────────────

const ESTADO_MS = 1500;

/**
 * El service worker se duerme, así que no sirve que él avise: preguntamos.
 * Si no responde, es que está dormido y sin conexión activa.
 */
async function refrescarEstado() {
	let info = null;
	try {
		info = await chrome.runtime.sendMessage({ target: 'sw', type: 'get-status' });
	} catch {
		/* service worker dormido o recargando */
	}

	const conectado = Boolean(info?.connected);
	$('punto-backend').className = `punto ${conectado ? 'ok' : 'mal'}`;
	$('texto-backend').textContent = conectado
		? `Conectado al backend (127.0.0.1:${$('port').value})`
		: 'Sin conexión con el backend';

	const escuchando = Boolean(info?.listening);
	$('punto-micro').className = `punto ${escuchando ? 'activo' : ''}`;
	$('texto-micro').textContent = escuchando
		? 'Escuchando — vuelve a pulsar el atajo para parar'
		: 'Micrófono en reposo';

	// Un segundo reconocedor abortaría al del dictado: solo uno a la vez.
	$('prueba').disabled = escuchando;
	$('prueba').title = escuchando ? 'Para el dictado para poder usar la prueba' : '';

	$('detalle').textContent = detalle(info);

	const eventos = info?.eventos ?? [];
	$('actividad').textContent = eventos.length ? eventos.join('\n') : 'Sin actividad todavía.';
}

function detalle(info) {
	if (!info) return 'El service worker no responde. Recarga la extensión si persiste.';
	const partes = [];
	partes.push(info.pestana ? `Script en «${info.pestana}»` : 'Ninguna pestaña tiene el script: pulsa el icono en una');
	if (info.onDevice === true) partes.push('Motor local (el audio no sale de tu equipo)');
	if (info.onDevice === false) partes.push('Motor en la nube de Google');
	if (info.lastTranscript) partes.push(`Última frase: "${info.lastTranscript}"`);
	if (info.diagnostico) {
		partes.push(
			`Micrófono en ${info.diagnostico.sitio} → permiso: ${info.diagnostico.permiso} · getUserMedia: ${info.diagnostico.getUserMedia}`
		);
	}
	if (info.lastError) partes.push(`⚠ ${info.lastError}`);
	return partes.join(' · ');
}

async function reconectar() {
	try {
		await chrome.runtime.sendMessage({ target: 'sw', type: 'reconnect' });
	} catch {
		/* si está dormido, el propio sendMessage lo despierta */
	}
	setTimeout(refrescarEstado, 400);
}

// ── 1 · permiso de micrófono ──────────────────────────────────────────────

async function estadoPermiso() {
	try {
		const { state } = await navigator.permissions.query({ name: 'microphone' });
		return state; // granted | prompt | denied
	} catch (error) {
		return `query falló: ${error.name}`;
	}
}

async function pedirPermiso() {
	const previo = await estadoPermiso();
	console.log('[dictado][options] permiso antes:', previo);
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		stream.getTracks().forEach((track) => track.stop()); // no queremos grabar aquí
		const despues = await estadoPermiso();
		console.log('[dictado][options] permiso después:', despues);
		estado.textContent = `Permiso concedido (${despues}) para la prueba de esta página.`;
	} catch (error) {
		console.error('[dictado][options] getUserMedia falló:', error.name, error.message);
		estado.textContent = `Permiso denegado: ${error.name}. Revísalo en el candado de la barra de direcciones.`;
	}
}

// ── 2 · ajustes ───────────────────────────────────────────────────────────

async function cargarAjustes() {
	// Mismo valor por defecto que getSettings() en service-worker.js.
	const { token = '', port = 8777, lang = 'es-PE' } = await chrome.storage.local.get([
		'token',
		'port',
		'lang',
	]);
	$('token').value = token;
	$('port').value = port;
	$('lang').value = lang;
}

async function guardarAjustes() {
	await chrome.storage.local.set({
		token: $('token').value.trim(),
		port: Number($('port').value) || 8777,
		lang: $('lang').value,
	});
	$('guardar').textContent = 'Guardado ✓';
	setTimeout(() => ($('guardar').textContent = 'Guardar'), 1500);
	await reconectar(); // aplica el token nuevo sin recargar la extensión
}

// ── 3 · prueba de transcripción ───────────────────────────────────────────

let prueba = null;

function alternarPrueba() {
	if (prueba) {
		prueba.stop();
		prueba = null;
		$('prueba').textContent = 'Empezar a hablar';
		return;
	}

	prueba = new Engine();
	prueba.lang = $('lang').value;
	prueba.continuous = true;
	prueba.interimResults = true;
	salida.textContent = '';

	prueba.onresult = (event) => {
		let texto = '';
		for (const result of event.results) texto += result[0].transcript;
		salida.textContent = texto;
	};
	prueba.onerror = (event) => {
		salida.textContent = `Error: ${event.error}`;
	};

	prueba.start();
	$('prueba').textContent = 'Detener';
}

$('permiso').addEventListener('click', pedirPermiso);
$('guardar').addEventListener('click', guardarAjustes);
$('prueba').addEventListener('click', alternarPrueba);
$('reconectar').addEventListener('click', reconectar);

cargarAjustes().then(refrescarEstado);
setInterval(refrescarEstado, ESTADO_MS);
