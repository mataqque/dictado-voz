/**
 * Recordar la terminal del dictado y saber si sigue abierta. Puro, sin efectos,
 * como comandos.js y voz.js: lo que toca el sistema llega por parámetro.
 */

const SOLO_DIGITOS = /^\d+$/;

export const pidDelSocket = (socket) => socket.match(/-(\d+)$/)?.[1] ?? null;

/** Lo que se guarda en disco. Parado no hay nada que recordar. */
export function serializarEstado(listening, destino) {
	return JSON.stringify(listening && destino ? { listening: true, destino } : { listening: false });
}

/**
 * Frontera de confianza: el fichero puede estar roto o manipulado, y el socket y
 * la ventana acaban en argumentos de kitten.
 * @returns {{socket: string, ventana: string | null} | null} la terminal que
 *   estaba dictando, o null si no hay ninguna válida.
 */
export function leerEstadoGuardado(texto, baseSocket) {
	let datos;
	try {
		datos = JSON.parse(texto);
	} catch {
		return null;
	}
	if (datos?.listening !== true) return null;

	const { socket, ventana = null } = datos.destino ?? {};
	if (typeof socket !== 'string') return null;
	const socketValido = socket === baseSocket || (socket.startsWith(`${baseSocket}-`) && pidDelSocket(socket) !== null);
	if (!socketValido) return null;
	if (ventana !== null && !SOLO_DIGITOS.test(ventana)) return null;
	return { socket, ventana };
}

/**
 * ¿Sigue abierta la terminal? El socket por sí solo no lo prueba: si kitty muere
 * de golpe, el fichero se queda. Y un kitty vivo puede haber cerrado esa ventana.
 */
export function destinoVivo({ socket, ventana }, { esSocket, procesoVivo, ventanaViva }) {
	if (!esSocket(socket)) return false;
	const pid = pidDelSocket(socket);
	if (pid === null) return true; // socket sin pid: no hay nada más que comprobar
	if (!procesoVivo(pid)) return false;
	return ventana === null || ventanaViva(pid, ventana);
}

/** Campos de /proc/<pid>/stat que importan. El nombre va entre paréntesis y puede tener espacios. */
export function leerStat(texto) {
	const cierre = texto.lastIndexOf(')');
	const campos = texto.slice(cierre + 2).split(' ');
	return {
		comm: texto.slice(texto.indexOf('(') + 1, cierre),
		ppid: campos[1],
		sid: campos[3],
		tpgid: campos[5],
	};
}

const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'nu']);
const NOMBRES_PROGRAMA = { claude: 'Claude Code' };

const carpetaDe = (cwd) => (cwd ? cwd.split('/').filter(Boolean).pop() ?? '/' : null);
/** Claude Code empieza su título con un símbolo animado (✳ ◑) que no dice nada. */
const limpiarTitulo = (titulo = '') => titulo.replace(/^[^\p{L}\p{N}]+/u, '').trim();

/**
 * Las terminales a las que se puede dictar. Una ventana de kitty es la sesión
 * cuyo líder es hijo directo de kitty: heredan KITTY_WINDOW_ID muchos más procesos,
 * incluidos los que sobreviven a la ventana.
 *
 * El título de Hyprland es de la ventana del sistema, o sea de la pestaña activa:
 * solo identifica a la terminal si ese kitty no tiene más.
 *
 * @param procesos [{pid, ppid, sid, tpgid, comm, cwd, kittyPid, ventana}], todo texto
 * @param conSocket (kittyPid) => boolean: sin socket de control no se le puede escribir
 * @param ventanasHyprland [{pid, titulo, escritorio}], vacío si no hay Hyprland
 */
export function listarTerminales(procesos, conSocket, ventanasHyprland = []) {
	const lideres = procesos
		.filter((p) => p.ppid === p.kittyPid && p.sid === p.pid && conSocket(p.kittyPid))
		.sort((a, b) => Number(a.kittyPid) - Number(b.kittyPid) || Number(a.ventana) - Number(b.ventana));

	const vistos = new Map();
	return lideres.map((lider) => {
		const frente = procesos.find((p) => p.pid === lider.tpgid) ?? lider;
		const sola = lideres.filter((p) => p.kittyPid === lider.kittyPid).length === 1;
		const ventana = sola ? ventanasHyprland.find((v) => String(v.pid) === lider.kittyPid) : null;
		const conPrograma = !SHELLS.has(frente.comm);
		const titulo = conPrograma ? limpiarTitulo(ventana?.titulo) : '';
		const carpeta = carpetaDe(frente.cwd ?? lider.cwd);

		const base = titulo || carpeta || `Terminal ${lider.ventana}`;
		const repeticion = (vistos.get(base) ?? 0) + 1;
		vistos.set(base, repeticion);

		return {
			id: `${lider.kittyPid}:${lider.ventana}`,
			kittyPid: lider.kittyPid,
			ventana: lider.ventana,
			nombre: repeticion > 1 ? `${base} (${repeticion})` : base,
			detalle: [
				titulo ? carpeta : null,
				NOMBRES_PROGRAMA[frente.comm] ?? frente.comm,
				ventana?.escritorio ? `escritorio ${ventana.escritorio}` : null,
			]
				.filter(Boolean)
				.join(' · '),
		};
	});
}

/** Sin ventana fijada (atajo de Hyprland) vale la primera de ese kitty. */
export function idDelDestino(destino, terminales) {
	if (!destino) return null;
	const pid = pidDelSocket(destino.socket);
	return terminales.find((t) => t.kittyPid === pid && (destino.ventana === null || t.ventana === destino.ventana))?.id ?? null;
}
