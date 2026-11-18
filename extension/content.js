/**
 * Script que la extensión inyecta en la pestaña que elijas (clic en el icono).
 * Corre aquí, dentro de la página, el reconocimiento de voz de Chrome (Web
 * Speech API) y le pasa cada frase al service worker, que la reenvía al backend.
 *
 * Al vivir en la página hereda sus reglas: el permiso de micrófono es de ese
 * sitio, y si la pestaña navega o se recarga, el script muere.
 */

// Si ya había un script (otra inyección, o uno huérfano de antes de recargar la
// extensión), se retira primero: dos reconocedores se pisarían el micrófono.
try {
	window.__dictado?.retirar();
} catch (error) {
	console.warn('[dictado] no se pudo retirar el script anterior:', error.message);
}
{

	const Engine = self.SpeechRecognition || self.webkitSpeechRecognition;

	/** Errores que no se arreglan reintentando: cortan el bucle en seco. */
	const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported']);
	/** Chrome corta por silencio, pero un reinicio inmediato y perpetuo es un bucle. */
	const RESTART_DELAY_MS = 250;
	const MAX_RESTARTS = 40;

	let recognition = null;
	let shouldListen = false;
	let restarts = 0;
	let inicioSesion = 0;
	/** Avisos que solo salen una vez por dictado, no en cada reinicio tras un silencio. */
	let anunciado = { arranque: false, audio: false };
	/** Una sesión que duró más que esto no es un bucle: el contador vuelve a cero. */
	const SESION_SANA_MS = 3000;

	// ── indicador visible en la página ─────────────────────────────────────
	// Shadow DOM para que los estilos de la página no lo rompan ni al revés.
	// La pastilla es un botón: abre el panel de voz (o calla, si está leyendo).

	const host = document.createElement('div');
	host.style.cssText = 'all: initial; position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;';
	const sombra = host.attachShadow({ mode: 'closed' });
	sombra.innerHTML = `
		<style>
			:host { color-scheme: dark; }
			* { box-sizing: border-box; }
			.raiz {
				--fondo: #16161a;
				--fondo-elevado: #202026;
				--borde: #33333b;
				--texto: #ececf1;
				--texto-suave: #a1a1ab;
				--acento: #a78bfa;
				--foco: #c4b5fd;
				display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
				font: 12px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif;
				color: var(--texto);
			}
			button, select, input { font: inherit; color: inherit; }
			:focus-visible { outline: 2px solid var(--foco); outline-offset: 2px; }

			/* pastilla */
			.pastilla {
				display: flex; align-items: center; gap: 8px; max-width: min(420px, calc(100vw - 32px));
				padding: 6px 8px 6px 12px; border: 1px solid transparent; border-radius: 999px;
				background: var(--fondo); opacity: 0.88; cursor: pointer;
				box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
				transition: opacity 120ms ease-out, border-color 120ms ease-out;
			}
			.pastilla:hover, .pastilla[aria-expanded='true'] { opacity: 1; border-color: var(--borde); }
			.texto { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
			.punto { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #8b8b95; }
			.espera .punto { background: #60a5fa; }
			.activo .punto { background: #f87171; animation: latido 1.2s ease-in-out infinite; }
			.voz .punto { background: var(--acento); animation: latido 0.8s ease-in-out infinite; }
			.error .punto { background: #fbbf24; }
			.clic { border-color: #fbbf24; }
			.ajustes-icono { flex: none; width: 14px; height: 14px; color: var(--texto-suave); }
			@keyframes latido { 50% { opacity: 0.25; } }

			/* panel */
			.panel {
				width: 320px; max-width: calc(100vw - 32px); max-height: calc(100vh - 80px); overflow-y: auto;
				padding: 16px; border: 1px solid var(--borde); border-radius: 12px;
				background: var(--fondo-elevado);
				box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
				display: grid; gap: 16px;
				font-size: 13px;
				transform-origin: bottom right;
				animation: aparecer 140ms ease-out;
			}
			.panel[hidden] { display: none; }
			@keyframes aparecer { from { opacity: 0; transform: translateY(4px) scale(0.98); } }
			.cabecera { display: flex; align-items: center; justify-content: space-between; }
			.titulo { margin: 0; font-size: 14px; font-weight: 600; }
			.cerrar {
				display: grid; place-items: center; width: 24px; height: 24px;
				border: 0; border-radius: 6px; background: transparent; color: var(--texto-suave); cursor: pointer;
			}
			.cerrar:hover { background: var(--borde); color: var(--texto); }
			.campo { display: grid; gap: 6px; }
			.etiqueta { display: flex; justify-content: space-between; color: var(--texto-suave); }
			.etiqueta output { color: var(--texto); font-variant-numeric: tabular-nums; }

			/* terminales */
			.terminales { display: grid; gap: 8px; }
			.lista {
				display: grid; gap: 2px; margin: 0 -6px; padding: 0; list-style: none;
				max-height: 232px; overflow-y: auto;
				scrollbar-width: thin; scrollbar-color: var(--borde) transparent;
			}
			.lista li { min-width: 0; }
			.terminal {
				display: grid; grid-template-columns: minmax(0, 1fr) 16px; align-items: center; column-gap: 8px;
				width: 100%; padding: 8px; border: 0; border-radius: 8px;
				background: transparent; text-align: left; cursor: pointer;
				transition: background-color 120ms ease-out;
			}
			.terminal:hover { background: var(--borde); }
			.terminal:focus-visible { outline-offset: -2px; }
			.terminal[aria-pressed='true'] { background: rgba(167, 139, 250, 0.16); }
			.nombre, .detalle { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
			.nombre { font-weight: 550; }
			.detalle { color: var(--texto-suave); font-size: 12px; }
			.marca { visibility: hidden; color: var(--acento); }
			.terminal[aria-pressed='true'] .marca { visibility: visible; }
			.vacio { margin: 0; color: var(--texto-suave); }
			.pie-terminales { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
			.detener {
				flex: none; padding: 6px 10px; border: 1px solid var(--borde); border-radius: 8px;
				background: transparent; cursor: pointer;
			}
			.detener:hover { background: var(--borde); }

			/* voz, plegada: se ajusta una vez y no se vuelve a tocar */
			.voz { border-top: 1px solid var(--borde); padding-top: 12px; }
			.voz summary {
				display: flex; align-items: center; justify-content: space-between;
				border-radius: 4px; color: var(--texto-suave); cursor: pointer; list-style: none;
			}
			.voz summary::-webkit-details-marker { display: none; }
			.voz summary:hover { color: var(--texto); }
			.voz summary svg { transition: transform 120ms ease-out; }
			.voz[open] summary svg { transform: rotate(180deg); }
			.ajustes-voz { display: grid; gap: 16px; padding-top: 12px; }
			select {
				width: 100%; padding: 8px 10px; border: 1px solid var(--borde); border-radius: 8px;
				background: var(--fondo); cursor: pointer;
			}
			input[type='range'] { width: 100%; margin: 0; accent-color: var(--acento); cursor: pointer; }
			.pie { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
			.nota { margin: 0; color: var(--texto-suave); font-size: 12px; }
			.probar {
				flex: none; padding: 8px 16px; border: 0; border-radius: 8px;
				background: var(--acento); color: #17112b; font-weight: 600; cursor: pointer;
			}
			.probar:hover { filter: brightness(1.08); }

			@media (prefers-reduced-motion: reduce) {
				.panel, .punto { animation: none; }
			}
		</style>
		<div class="raiz">
			<div class="panel" role="dialog" aria-labelledby="titulo-panel" hidden>
				<div class="cabecera">
					<h2 class="titulo" id="titulo-panel">Dictar a</h2>
					<button class="cerrar" type="button" aria-label="Cerrar">
						<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
					</button>
				</div>
				<div class="terminales">
					<ul class="lista" aria-labelledby="titulo-panel" hidden></ul>
					<p class="vacio" role="status">Buscando terminales…</p>
					<div class="pie-terminales">
						<p class="nota aviso-micro" role="status"></p>
						<button class="detener" type="button" hidden>Detener</button>
					</div>
				</div>
				<details class="voz">
					<summary>Voz de lectura
						<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
					</summary>
					<div class="ajustes-voz">
						<label class="campo">
							<span class="etiqueta">Voz</span>
							<select class="selector-voz"></select>
						</label>
						<label class="campo">
							<span class="etiqueta">Velocidad <output class="valor-velocidad"></output></span>
							<input class="velocidad" type="range" min="0.7" max="1.8" step="0.05" />
						</label>
						<div class="pie">
							<p class="nota">Las voces de Google suenan mejor, pero necesitan conexión.</p>
							<button class="probar" type="button">Probar</button>
						</div>
					</div>
				</details>
			</div>
			<button class="pastilla" type="button" aria-haspopup="dialog" aria-expanded="false">
				<span class="punto"></span>
				<span class="texto"></span>
				<svg class="ajustes-icono" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h7M13 4h1M2 12h1M7 12h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="11" cy="4" r="2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5" cy="12" r="2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
			</button>
		</div>`;
	const pastilla = sombra.querySelector('.pastilla');
	const textoPastilla = sombra.querySelector('.texto');
	const panel = sombra.querySelector('.panel');
	const selectorVoz = sombra.querySelector('.selector-voz');
	const deslizadorVelocidad = sombra.querySelector('.velocidad');
	const valorVelocidad = sombra.querySelector('.valor-velocidad');
	const listaTerminales = sombra.querySelector('.lista');
	const vacioTerminales = sombra.querySelector('.vacio');
	const avisoMicro = sombra.querySelector('.aviso-micro');
	const botonDetener = sombra.querySelector('.detener');
	document.documentElement.append(host);

	function indicar(estado, texto) {
		pastilla.className = `pastilla ${estado}`;
		textoPastilla.textContent = texto;
		pastilla.title = estado === 'voz' ? 'Callar' : 'Elegir terminal y ajustar la voz';
	}

	// ── ajustes de voz (panel de la pastilla) ──────────────────────────────
	// Se guardan en chrome.storage: valen para cualquier pestaña donde inyectes.

	const VELOCIDAD_POR_DEFECTO = 1.05;
	/** voz: nombre de la voz elegida, '' = automática (la mejor de Google del idioma). */
	let ajustesVoz = { voz: '', velocidad: VELOCIDAD_POR_DEFECTO };

	chrome.storage.local.get(['voz', 'velocidad']).then((guardado) => {
		ajustesVoz = { voz: guardado.voz ?? '', velocidad: guardado.velocidad ?? VELOCIDAD_POR_DEFECTO };
		pintarAjustes();
	});

	function guardarAjustes(cambio) {
		ajustesVoz = { ...ajustesVoz, ...cambio };
		chrome.storage.local.set(cambio).catch(() => {});
	}

	function nombreIdioma(lang) {
		try {
			return new Intl.DisplayNames(['es'], { type: 'language' }).of(lang) ?? lang;
		} catch {
			return lang;
		}
	}

	/** Primero las voces del idioma del dictado; el resto agrupadas aparte. */
	function llenarVoces() {
		const voces = speechSynthesis.getVoices();
		const base = idioma.split('-')[0];
		const opcion = (voz) => {
			const elemento = document.createElement('option');
			elemento.value = voz.name;
			const tipo = voz.localService ? 'sin conexión' : 'en línea';
			elemento.textContent = `${voz.name.replace(/^Google\s+/, 'Google · ')} (${tipo})`;
			return elemento;
		};
		const grupo = (etiqueta, lista) => {
			const elemento = document.createElement('optgroup');
			elemento.label = etiqueta;
			lista.forEach((voz) => elemento.append(opcion(voz)));
			return elemento;
		};
		const propias = voces.filter((voz) => voz.lang.startsWith(base));
		const otras = voces.filter((voz) => !voz.lang.startsWith(base)).sort((a, b) => a.lang.localeCompare(b.lang));

		const automatica = document.createElement('option');
		automatica.value = '';
		automatica.textContent = 'Automática (la mejor disponible)';
		selectorVoz.replaceChildren(automatica);
		if (propias.length) selectorVoz.append(grupo(nombreIdioma(base), propias));
		if (otras.length) selectorVoz.append(grupo('Otros idiomas', otras));
		selectorVoz.value = voces.some((voz) => voz.name === ajustesVoz.voz) ? ajustesVoz.voz : '';
	}

	function pintarAjustes() {
		llenarVoces();
		deslizadorVelocidad.value = String(ajustesVoz.velocidad);
		valorVelocidad.textContent = `${Number(ajustesVoz.velocidad).toFixed(2)}×`;
	}

	// Las voces llegan de forma asíncrona: la lista se rellena cuando estén.
	speechSynthesis.addEventListener('voiceschanged', () => {
		if (!panel.hidden) llenarVoces();
	});

	// ── terminales (panel de la pestaña) ───────────────────────────────────
	// El backend las enumera; aquí solo se pintan. Mientras el panel esté abierto
	// se vuelve a preguntar, para ver las que se abren y se cierran.

	const REFRESCO_TERMINALES_MS = 3000;
	/** El backend contesta en milisegundos: tanto silencio es que la petición no llegó a él. */
	const SIN_RESPUESTA_MS = 4000;
	let terminales = { lista: null, destinoId: null, escuchando: false, sinConexion: false };
	let refrescoTerminales = null;
	let terminalesPintadas = '';

	const pedirTerminales = () => post({ type: 'pedir-terminales' });

	function filaTerminal(terminal) {
		const boton = document.createElement('button');
		boton.className = 'terminal';
		boton.type = 'button';
		boton.dataset.id = terminal.id;
		boton.setAttribute('aria-pressed', String(terminal.id === terminales.destinoId));
		// textContent, nunca innerHTML: los títulos de ventana los escribe cualquier programa.
		const nombre = document.createElement('span');
		nombre.className = 'nombre';
		nombre.textContent = terminal.nombre;
		nombre.title = terminal.nombre;
		const marca = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		marca.setAttribute('class', 'marca');
		marca.setAttribute('viewBox', '0 0 16 16');
		marca.setAttribute('aria-hidden', 'true');
		marca.innerHTML = '<path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
		const detalle = document.createElement('span');
		detalle.className = 'detalle';
		detalle.textContent = terminal.detalle;
		boton.append(nombre, marca, detalle);
		boton.addEventListener('click', () => {
			post({ type: 'elegir-terminal', kittyPid: terminal.kittyPid, kittyWindowId: terminal.ventana });
		});
		const fila = document.createElement('li');
		fila.append(boton);
		return fila;
	}

	function pintarTerminales() {
		const { lista, destinoId, escuchando, sinConexion } = terminales;
		const huella = JSON.stringify(terminales);
		if (huella === terminalesPintadas) return;
		terminalesPintadas = huella;

		// Repintar destruye los botones: sin esto, el foco de teclado se perdería cada 3 s.
		const conFoco = sombra.activeElement?.dataset?.id;
		listaTerminales.replaceChildren(...(lista ?? []).map(filaTerminal));
		if (conFoco) listaTerminales.querySelector(`[data-id="${CSS.escape(conFoco)}"]`)?.focus();

		const hayTerminales = !sinConexion && lista?.length > 0;
		listaTerminales.hidden = !hayTerminales;
		vacioTerminales.hidden = hayTerminales;
		if (sinConexion) vacioTerminales.textContent = 'Sin conexión con el backend. Comprueba que esté corriendo: dictado-ctl status.';
		else if (lista) vacioTerminales.textContent = 'No hay ninguna terminal kitty abierta. Abre una y aparecerá aquí.';

		botonDetener.hidden = !escuchando;
		avisoMicro.textContent = sinConexion || !lista?.length
			? ''
			: escuchando
				? 'Micrófono encendido. Di «open» para enviar.'
				: 'Elige una para encender el micrófono.';
	}

	/** Cómo se llama en la pastilla la terminal a la que va el dictado. */
	function nombreDestino() {
		return terminales.lista?.find((terminal) => terminal.id === terminales.destinoId)?.nombre ?? 'la terminal';
	}

	botonDetener.addEventListener('click', () => post({ type: 'detener' }));

	function abrirPanel() {
		pintarAjustes();
		panel.hidden = false;
		pastilla.setAttribute('aria-expanded', 'true');
		pedirTerminales();
		refrescoTerminales = setInterval(pedirTerminales, REFRESCO_TERMINALES_MS);
		// Pasa con un service worker de antes de actualizar: inyecta este script nuevo
		// pero ignora la petición. Sin este aviso, «Buscando…» no acabaría nunca.
		setTimeout(() => {
			if (terminales.lista !== null || terminales.sinConexion) return;
			vacioTerminales.textContent = 'La extensión no responde. Recárgala en chrome://extensions, recarga esta pestaña y vuelve a pulsar el icono.';
		}, SIN_RESPUESTA_MS);
		(listaTerminales.querySelector('[aria-pressed="true"]') ?? listaTerminales.querySelector('.terminal') ?? sombra.querySelector('.cerrar')).focus();
	}

	function cerrarPanel({ devolverFoco = false } = {}) {
		if (panel.hidden) return;
		panel.hidden = true;
		pastilla.setAttribute('aria-expanded', 'false');
		clearInterval(refrescoTerminales);
		if (devolverFoco) pastilla.focus();
	}

	selectorVoz.addEventListener('change', () => guardarAjustes({ voz: selectorVoz.value }));
	deslizadorVelocidad.addEventListener('input', () => {
		const velocidad = Number(deslizadorVelocidad.value);
		valorVelocidad.textContent = `${velocidad.toFixed(2)}×`;
		guardarAjustes({ velocidad });
	});
	sombra.querySelector('.probar').addEventListener('click', () => {
		hablar('Hola. Así sonaré cuando te lea las respuestas de Claude.', { prueba: true });
	});
	sombra.querySelector('.cerrar').addEventListener('click', () => cerrarPanel({ devolverFoco: true }));
	panel.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') cerrarPanel({ devolverFoco: true });
	});
	// Clic fuera (en la página) lo cierra. Ojo: con el shadow DOM en modo
	// «closed», composedPath() visto desde document NO incluye los nodos de
	// dentro (raiz, el select…), solo llega hasta el host. Por eso se compara con
	// el host: cualquier clic en la pastilla o el panel lo lleva en la ruta.
	document.addEventListener(
		'pointerdown',
		(event) => {
			if (!event.composedPath().includes(host)) cerrarPanel();
		},
		true
	);

	/** «open» abre el envío y «stop»/«enter» lo cierran (lo decide el backend). */
	let enviando = false;
	/** Leyendo una respuesta en voz alta: el micro está en pausa mientras tanto. */
	let hablando = false;
	let idioma = 'es-PE';

	/** La pastilla refleja dos cosas: micro encendido y si se envía a la terminal. */
	function pintar() {
		if (hablando) indicar('voz', 'Leyendo… · di «cállate» o pulsa aquí');
		else if (!shouldListen) indicar('', 'Dictado listo · elige una terminal');
		else if (enviando) indicar('activo', `Enviando a ${nombreDestino()} · di «stop» o «enter»`);
		else indicar('espera', `${nombreDestino()} · di «open» para enviar`);
	}

	pintar();

	// ── reconocimiento ─────────────────────────────────────────────────────

	function post(message) {
		chrome.runtime.sendMessage({ target: 'sw', ...message }).catch((error) => {
			// Pasa si recargaste la extensión: este script quedó huérfano.
			console.warn('[dictado] no llego al service worker:', error.message);
		});
	}

	/**
	 * Cada paso del ciclo de vida sale en la consola de esta pestaña (filtra por
	 * "[dictado]") y en los logs del backend, para ver dónde se queda.
	 */
	function registrar(nivel, texto, extra) {
		const consola = { info: console.log, aviso: console.warn, error: console.error }[nivel] ?? console.log;
		consola('[dictado]', texto, ...(extra === undefined ? [] : [extra]));
		post({ type: 'evento', nivel, texto, extra });
	}

	function fallar(error, fatal) {
		indicar('error', `Dictado: ${error}`);
		console.error('[dictado] error del motor de voz:', error, fatal ? '(fatal, no se reintenta)' : '');
		post({ type: 'error', error, fatal });
	}

	/**
	 * Chrome 138+ puede correr el modelo en tu máquina en vez de en los servidores
	 * de Google. Si el modelo del idioma no está, lo pide y seguimos en la nube
	 * mientras se descarga.
	 */
	async function preferOnDevice(instance, lang) {
		if (typeof Engine.availableOnDevice !== 'function') return false;
		try {
			const status = await Engine.availableOnDevice(lang);
			if (status === 'available') {
				instance.processLocally = true;
				return true;
			}
			if (status === 'downloadable') Engine.installOnDevice(lang);
		} catch {
			/* la API existe pero falló: seguimos con reconocimiento en la nube */
		}
		return false;
	}

	function build(lang) {
		const instance = new Engine();
		instance.lang = lang;
		instance.continuous = true;
		// Parciales activados solo para detectar «cállate» mientras lee (ver onresult):
		// el dictado sigue usando únicamente las frases finales.
		instance.interimResults = true;
		instance.maxAlternatives = 1;

		// Fases del motor: si una no aparece, ahí está el problema.
		instance.onstart = () => {
			inicioSesion = Date.now();
			// Solo una vez por dictado: tras cada silencio Chrome reinicia y llenaría los logs.
			if (!anunciado.arranque) registrar('info', 'reconocimiento arrancado: escuchando');
			anunciado.arranque = true;
		};
		instance.onaudiostart = () => {
			if (!anunciado.audio) registrar('info', 'llega audio del micrófono');
			anunciado.audio = true;
		};
		instance.onspeechstart = () => console.log('[dictado] detecto voz');
		instance.onspeechend = () => console.log('[dictado] fin de la voz');
		instance.onaudioend = () => console.log('[dictado] el motor dejó de recibir audio');
		instance.onnomatch = () => registrar('aviso', 'oí algo pero no lo entendí');

		instance.onresult = (event) => {
			restarts = 0; // hay audio real llegando: el contador de seguridad se reinicia
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i];
				const text = result[0].transcript.trim();
				// Leyendo: el micro oye también los altavoces, y como la lectura no
				// hace pausas, todo se funde en UNA frase larga que no termina nunca.
				// Por eso la orden se busca en los parciales, en cualquier punto.
				if (hablando) {
					const orden = ordenDeCallarEn(text);
					if (orden) return callar(`dijiste «${orden}»`); // callar descarta el resto
					continue;
				}
				if (!result.isFinal || !text) continue;
				console.log('[dictado] frase:', text, `(confianza ${result[0].confidence.toFixed(2)})`);
				post({ type: 'transcript', text });
			}
		};

		// Chrome corta el reconocimiento tras un silencio; lo reanudamos si sigue activo.
		instance.onend = () => {
			// Una sesión vieja que acaba después de que arrancara otra: no es asunto suyo.
			if (recognition && recognition !== instance) return;
			if (!shouldListen) {
				registrar('info', 'reconocimiento detenido');
				return;
			}
			// En espera de «open» el micro pasa mucho rato en silencio y Chrome corta
			// cada pocos segundos: eso es normal. Solo cuentan los cortes seguidos rápidos.
			if (Date.now() - inicioSesion > SESION_SANA_MS) restarts = 0;
			console.log(`[dictado] Chrome cortó el reconocimiento; reinicio ${restarts + 1}/${MAX_RESTARTS}`);
			if (++restarts > MAX_RESTARTS) {
				shouldListen = false;
				fallar('demasiados reinicios seguidos', true);
				return;
			}
			setTimeout(() => {
				// Parar y volver a arrancar en menos de RESTART_DELAY_MS deja shouldListen
				// en true pero con otra instancia: reiniciar esta crearía un segundo reconocedor.
				if (!shouldListen || recognition !== instance) return;
				try {
					instance.start();
				} catch (error) {
					console.warn('[dictado] no se pudo reiniciar:', error.message);
				}
			}, RESTART_DELAY_MS);
		};

		instance.onerror = (event) => {
			if (event.error === 'no-speech' || event.error === 'aborted') {
				console.log(`[dictado] ${event.error} (normal, no es un fallo)`);
				return;
			}
			const fatal = FATAL_ERRORS.has(event.error);
			if (fatal) shouldListen = false; // corta el bucle de reinicio
			fallar(event.error, fatal);
		};

		return instance;
	}

	/**
	 * Pide el micrófono para ESTE sitio. Se llama al inyectar, que es cuando
	 * estás mirando la pestaña: si Chrome muestra el aviso, lo ves y lo aceptas.
	 */
	async function inspeccionarMicrofono() {
		const informe = { sitio: location.host, permiso: 'desconocido', getUserMedia: 'sin probar' };
		try {
			informe.permiso = (await navigator.permissions.query({ name: 'microphone' })).state;
		} catch (error) {
			informe.permiso = `query falló: ${error.name}`;
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			informe.getUserMedia = 'ok';
			stream.getTracks().forEach((track) => track.stop());
		} catch (error) {
			informe.getUserMedia = `${error.name}: ${error.message}`;
		}
		console.log('[dictado] permiso de micrófono comprobado (se abre y se cierra al instante):', informe);
		console.log('[dictado] listo. La escucha empieza al elegir una terminal en la pastilla, o con `dictado-ctl toggle`.');
		post({ type: 'diagnostico', informe });
		return informe.getUserMedia === 'ok';
	}

	async function start(lang) {
		if (shouldListen) return console.log('[dictado] start ignorado: ya estaba escuchando');
		if (!Engine) return fallar('este navegador no tiene Web Speech API', true);
		registrar('info', 'arrancando reconocimiento', { lang });
		idioma = lang;

		shouldListen = true;
		restarts = 0;
		anunciado = { arranque: false, audio: false };
		const instancia = build(lang);
		recognition = instancia;
		const local = await preferOnDevice(instancia, lang);
		// Si llegó «stop» (o un start nuevo) durante el await, esta instancia sobra:
		// no es un error, simplemente ya no hay que arrancarla.
		if (!shouldListen || recognition !== instancia) {
			return console.log('[dictado] arranque cancelado: llegó stop mientras arrancaba');
		}
		post({ type: 'status', onDevice: local });
		registrar('info', local ? 'motor local (el audio no sale del equipo)' : 'motor en la nube de Google');
		try {
			instancia.start();
			pintar();
		} catch (error) {
			shouldListen = false;
			fallar(String(error), true);
		}
	}

	function stop() {
		if (shouldListen) console.log('[dictado] parando por orden del backend');
		shouldListen = false;
		recognition?.stop();
		recognition = null;
		enviando = false;
		callar();
		pintar();
	}

	// ── respuestas en voz alta ────────────────────────────────────────────

	/**
	 * La voz elegida en el panel; si no hay (o ya no existe), una de Google del
	 * idioma del dictado, que suenan mucho mejor que las del sistema.
	 */
	function elegirVoz(lang) {
		const voces = speechSynthesis.getVoices();
		const elegida = ajustesVoz.voz && voces.find((voz) => voz.name === ajustesVoz.voz);
		if (elegida) return elegida;
		const base = lang.split('-')[0];
		return (
			voces.find((voz) => voz.lang === lang && voz.name.includes('Google')) ??
			voces.find((voz) => voz.lang.startsWith(base) && voz.name.includes('Google')) ??
			voces.find((voz) => voz.lang === lang) ??
			voces.find((voz) => voz.lang.startsWith(base)) ??
			null
		);
	}

	/**
	 * Trozos de una o varias frases de hasta ~200 caracteres. Chrome corta en
	 * seco las voces de Google a los ~15 s de una sola locución.
	 */
	function trocear(texto, max = 200) {
		const frases = texto.match(/[^.!?]+[.!?]*/g) ?? [texto];
		const trozos = [];
		let actual = '';
		for (const frase of frases) {
			if ((actual + frase).length > max && actual) {
				trozos.push(actual.trim());
				actual = '';
			}
			actual += frase;
		}
		if (actual.trim()) trozos.push(actual.trim());
		return trozos;
	}

	/** Minúsculas, sin tildes ni puntuación, en palabras. */
	function palabras(texto) {
		return texto
			.toLowerCase()
			.normalize('NFD')
			.replace(/\p{Diacritic}/gu, '')
			.replace(/[^\p{L}\s]/gu, ' ')
			.split(/\s+/)
			.filter(Boolean);
	}

	/** Palabras del texto que se está leyendo: si el micro las oye, es eco del altavoz. */
	let palabrasLeyendo = new Set();

	/**
	 * Mientras lee, el micro NO se apaga: sigue escuchando para que puedas decir
	 * «cállate». Pero solo atiende a eso (ver onresult): así no se transcribe a sí
	 * mismo ni un «open» dentro de la respuesta abre el envío.
	 */
	function pausarEscucha(texto) {
		hablando = true;
		palabrasLeyendo = new Set(palabras(texto));
	}

	/**
	 * Lo que el micro captó durante la lectura está mezclado con el altavoz y aún
	 * no ha terminado de transcribirse: si se dejara, llegaría al backend como si
	 * lo hubieras dictado tú. abort() lo tira y onend arranca una sesión limpia.
	 */
	function reanudarEscucha() {
		if (!hablando) return;
		hablando = false;
		palabrasLeyendo = new Set();
		try {
			recognition?.abort();
		} catch {
			/* no estaba escuchando */
		}
	}

	const ORDENES_CALLAR = ['callate', 'calla', 'callar', 'silencio', 'basta', 'stop', 'estop'];

	/**
	 * La orden puede ir en cualquier punto de lo oído (va mezclada con el
	 * altavoz). Una palabra que también está en el texto leído no cuenta: puede
	 * ser el propio altavoz diciendo «stop».
	 */
	function ordenDeCallarEn(oido) {
		return palabras(oido).find((palabra) => ORDENES_CALLAR.includes(palabra) && !palabrasLeyendo.has(palabra)) ?? null;
	}

	let pendienteDeClic = null;
	/** Cada lectura tiene su número: los avisos de una lectura cancelada se ignoran. */
	let lectura = 0;

	/**
	 * Chrome no deja hablar a una página con la que no has interactuado. Un clic
	 * en la pastilla basta, y vale hasta que recargues la página.
	 */
	function pedirClic(texto) {
		pendienteDeClic = texto;
		indicar('error clic', 'Clic aquí para que pueda leer en voz alta');
		registrar('aviso', 'Chrome necesita un clic en la página para hablar: pulsa la pastilla de abajo a la derecha');
	}

	// Prioridades del clic: callar si lee; leer lo pendiente si faltaba un clic;
	// si no, abrir/cerrar el panel de voz.
	pastilla.addEventListener('click', () => {
		if (hablando) return callar('clic en la pastilla');
		if (pendienteDeClic !== null) {
			const texto = pendienteDeClic;
			pendienteDeClic = null;
			return hablar(texto);
		}
		if (panel.hidden) abrirPanel();
		else cerrarPanel();
	});

	/** Corta la lectura ya. `motivo` sale en los logs; sin motivo (al parar el dictado) no avisa. */
	function callar(motivo) {
		if (!hablando && !speechSynthesis.speaking) return;
		lectura++; // los avisos de la lectura cortada ya no cuentan
		speechSynthesis.cancel();
		reanudarEscucha();
		pintar();
		if (motivo) registrar('info', `🔇 lectura cortada (${motivo})`);
	}

	/**
	 * `prueba`: el botón «Probar» del panel. `aviso`: confirmación corta del
	 * backend («Enviado»). Ninguno de los dos es una respuesta de Claude.
	 */
	function hablar(texto, { prueba = false, aviso = false } = {}) {
		if (!('speechSynthesis' in self)) return registrar('error', 'este navegador no puede hablar (sin speechSynthesis)');
		if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
			// Un aviso suelto no merece pedirte un clic; una respuesta sí.
			if (aviso) return console.log('[dictado] aviso sin leer (falta un clic en la página):', texto);
			return pedirClic(texto);
		}

		speechSynthesis.cancel();
		const esta = ++lectura;
		pausarEscucha(texto);
		pintar();

		const voz = elegirVoz(idioma);
		const trozos = trocear(texto);
		if (prueba || aviso) console.log(`[dictado] ${prueba ? 'probando voz' : 'aviso'}:`, texto, voz?.name ?? 'por defecto');
		else registrar('info', `🔊 leyendo la respuesta (${trozos.length} trozos)`, { voz: voz?.name ?? 'por defecto' });

		trozos.forEach((trozo, indice) => {
			const locucion = new SpeechSynthesisUtterance(trozo);
			locucion.lang = idioma;
			if (voz) locucion.voice = voz;
			locucion.rate = ajustesVoz.velocidad;
			const esUltimo = indice === trozos.length - 1;
			locucion.onend = () => {
				if (!esUltimo || esta !== lectura) return;
				if (!prueba && !aviso) registrar('info', '🔊 lectura terminada: vuelvo a escuchar');
				reanudarEscucha();
				pintar();
			};
			locucion.onerror = (event) => {
				if (esta !== lectura) return; // la sustituyó otra lectura
				// «interrupted»/«canceled»: lo cortamos nosotros (dictado-ctl).
				if (event.error === 'interrupted' || event.error === 'canceled') {
					if (!esUltimo) return; // el cancel() avisa a cada trozo: basta con uno
				}
				if (event.error === 'not-allowed') {
					speechSynthesis.cancel();
					reanudarEscucha();
					return pedirClic(texto);
				}
				if (event.error !== 'interrupted' && event.error !== 'canceled') {
					registrar('error', `no se pudo leer: ${event.error}`);
				}
				if (hablando) {
					reanudarEscucha();
					pintar();
				}
			};
			speechSynthesis.speak(locucion);
		});
	}

	// Las voces cargan de forma asíncrona: pedirlas pronto hace que estén listas.
	speechSynthesis.getVoices();

	function retirar() {
		console.log('[dictado] script retirado de esta pestaña');
		stop();
		clearInterval(refrescoTerminales);
		host.remove();
		try {
			chrome.runtime.onMessage.removeListener(alRecibir);
		} catch {
			/* huérfano: la extensión se recargó y chrome.runtime ya no existe */
		}
		window.__dictado = null;
	}

	/**
	 * Debe coincidir con VERSION_SCRIPT del service worker: así detecta una
	 * pestaña que sigue con el script de antes de recargar la extensión.
	 */
	const VERSION = 8;
	const ACCIONES = ['start', 'stop', 'retirar', 'hablar', 'compuerta', 'callar', 'terminales'];

	function alRecibir(message, _sender, sendResponse) {
		if (message?.target !== 'recognizer') return;
		if (!ACCIONES.includes(message.action)) {
			console.warn('[dictado] orden desconocida (¿script viejo?):', message.action);
			sendResponse({ ok: false, version: VERSION });
			return;
		}
		// El refresco de terminales llega cada 3 s con el panel abierto: no es una orden que seguir.
		if (message.action !== 'terminales') console.log('[dictado] orden del service worker:', message.action);
		if (message.action === 'start') start(message.lang);
		if (message.action === 'stop') stop();
		if (message.action === 'retirar') retirar();
		if (message.action === 'callar') callar('dictado-ctl callar');
		if (message.action === 'hablar') {
			idioma = message.lang ?? idioma;
			hablar(message.texto, { aviso: Boolean(message.aviso) });
		}
		if (message.action === 'compuerta') {
			enviando = message.abierta;
			pintar();
		}
		if (message.action === 'terminales') {
			terminales = message.sinConexion
				? { ...terminales, sinConexion: true }
				: { lista: message.lista, destinoId: message.destinoId, escuchando: message.escuchando, sinConexion: false };
			pintarTerminales();
			pintar();
		}
		sendResponse({ ok: true, version: VERSION });
	}

	chrome.runtime.onMessage.addListener(alRecibir);
	window.__dictado = { retirar };
	console.log('[dictado] script inyectado');
	pedirTerminales(); // la pastilla ya puede nombrar la terminal si el dictado estaba en marcha
	inspeccionarMicrofono();
}
