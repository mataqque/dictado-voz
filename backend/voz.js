/**
 * Convierte una respuesta de Claude (markdown) en algo que tenga sentido oír.
 * Puro, sin efectos, como comandos.js.
 */

/**
 * Es ruta si el último trozo tiene extensión (page.tsx) o hay al menos tres
 * trozos (src/app/page). Dos trozos sin extensión son texto: «y/o», «km/h».
 */
function acortarRuta(coincidencia) {
	const trozos = coincidencia.replace(/:\d+$/, '').split('/').filter(Boolean);
	const ultimo = trozos.at(-1);
	const esRuta = /\.\w{1,6}$/.test(ultimo) || trozos.length >= 3;
	return esRuta ? ultimo : coincidencia;
}

/**
 * Leer código, tablas o URLs en voz alta no sirve: se sustituyen por un aviso
 * corto o se quitan. El resto del markdown se queda en texto plano.
 */
export function limpiarParaVoz(markdown, maxCaracteres = 1200) {
	let texto = markdown
		// Bloques de código: se anuncian, no se leen.
		.replace(/```[\s\S]*?```/g, ' (bloque de código) ')
		// Tablas: el grupo de filas que empiezan por «|» se anuncia una vez.
		.replace(/(?:^[ \t]*\|.*\|[ \t]*(?:\n|$))+/gm, ' (tabla) \n')
		.replace(/^\s*\((bloque de código|tabla)\)\s*$/gm, '($1)')
		// Enlaces [texto](url) → texto; URLs sueltas → «enlace».
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/https?:\/\/\S+/g, 'enlace')
		// Rutas tipo src/app/page.tsx:12 → solo el nombre del archivo. Solo si
		// parece una ruta: «y/o» o «km/h» se quedan como están.
		.replace(/(?<![\w/])\/?(?:[\w.-]+\/)+[\w.-]+(?::\d+)?/g, acortarRuta)
		// El marcador del bloque hablado no se pronuncia.
		.replace(/🔊\s*/gu, '')
		// Encabezados, viñetas, citas, negritas, separadores.
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/^\s*[-*+]\s+/gm, '')
		.replace(/^\s*>\s?/gm, '')
		// Sin cruzar «`»: lo que va entre comillas invertidas es código y se respeta.
		.replace(/(\*\*|\*|~~)([^`]+?)\1/g, '$2')
		// Con «_» solo si no está pegado a letras: snake_case no es cursiva.
		.replace(/(?<![\w`])(__|_)(?=[^\s`])([^`]+?)(?<=[^\s`])\1(?![\w`])/g, '$2')
		// Código en línea: ya a salvo de lo anterior, se lee sin las comillas.
		.replace(/`([^`]*)`/g, '$1')
		.replace(/^\s*[-*_]{3,}\s*$/gm, '')
		// Espacios.
		.replace(/\n{2,}/g, '. ')
		.replace(/\s*\n\s*/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.replace(/(\.\s*){2,}/g, '. ')
		.trim();

	if (texto.length > maxCaracteres) {
		// Cortamos en el último final de frase antes del límite, no a media palabra.
		const corte = texto.lastIndexOf('. ', maxCaracteres);
		texto = `${texto.slice(0, corte > maxCaracteres / 2 ? corte + 1 : maxCaracteres)} El resto está en la terminal.`;
	}
	return texto;
}

/**
 * Bloque hablado: el párrafo que empieza por «🔊» (puede ir tras «>» o «**»),
 * hasta la siguiente línea vacía. Claude lo escribe en modo voz como resumen
 * para oír (skill modo-voz). Si hay varios, se leen todos, en orden.
 * @returns {string | null} el texto de los bloques, o null si no hay ninguno.
 */
export function extraerBloqueHablado(markdown) {
	const bloques = [];
	let actual = null;
	for (const linea of markdown.split('\n')) {
		if (/^\s*(?:>\s*)?(?:\*\*)?🔊/u.test(linea)) {
			if (actual) bloques.push(actual.join('\n'));
			actual = [linea];
		} else if (actual && linea.trim()) {
			actual.push(linea);
		} else if (actual) {
			bloques.push(actual.join('\n'));
			actual = null;
		}
	}
	if (actual) bloques.push(actual.join('\n'));
	return bloques.length ? bloques.join('\n\n') : null;
}

/** La respuesta sin sus bloques hablados: lo que «más detalle» lee. */
export function quitarBloqueHablado(markdown) {
	const bloque = extraerBloqueHablado(markdown);
	if (!bloque) return markdown;
	return bloque.split('\n\n').reduce((texto, parte) => texto.replace(parte, ''), markdown);
}

/**
 * Qué se lee al terminar una respuesta: su bloque hablado si lo trae (sin
 * aviso de «el resto está en la terminal»: ya es el resumen) o, si no, la
 * respuesta entera limpia y cortada como siempre.
 */
export function textoParaLeer(markdown, maxCaracteres = 1200) {
	const bloque = extraerBloqueHablado(markdown);
	return limpiarParaVoz(bloque ?? markdown, maxCaracteres);
}

/**
 * ¿Esta parada del hook Stop debe leerse? No si es la continuación que otro hook
 * Stop forzó (`stop_hook_active`), como el aviso de commit: no es una respuesta
 * para ti y, como cada lectura cancela la anterior, cortaría la que sí lo era.
 */
export function debeLeerseLaParada(entrada) {
	return entrada?.stop_hook_active !== true;
}
