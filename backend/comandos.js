/**
 * Comandos de voz: decide si una frase dictada es texto, una orden, o texto
 * seguido de una orden («crea un componente enter»).
 *
 * Puro, sin efectos: devuelve qué hacer y server.js lo ejecuta. Así se puede
 * probar a mano con node sin kitty ni Chrome.
 */

/**
 * Órdenes que pueden ir AL FINAL de una frase, tras texto normal. Solo al final:
 * «enter» en medio de una frase («pulsa enter dos veces») es texto.
 */
const SUFIJOS = [
	// En inglés: en español no choca con nada (a diferencia de «entre»).
	{ palabras: ['enter'], accion: 'enviar' }, // además deja de enviar
	// «estop»: así lo transcribe a menudo el motor en español.
	{ palabras: ['stop', 'estop'], accion: 'parar' },
	{ palabras: ['nueva linea', 'salto de linea'], accion: 'nueva-linea' },
];

/** Órdenes que solo valen como frase completa: borrar por error sale caro. */
const FRASES = [
	{ palabras: ['borrar eso', 'borra eso'], accion: 'borrar-ultima' },
	{ palabras: ['borrar todo', 'borra todo'], accion: 'borrar-todo' },
];

/** Minúsculas, sin tildes ni puntuación: el motor escribe «Enter.» o «enter». */
function normalizar(texto) {
	return texto
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.replace(/[^\p{L}\p{N}\s]/gu, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * @returns {{ texto: string, accion: string | null }}
 *   texto: lo que hay que escribir (puede ser '' si la frase era solo la orden)
 *   accion: 'enviar' | 'parar' | 'nueva-linea' | 'borrar-ultima' | 'borrar-todo' | null
 */
export function interpretar(frase) {
	const limpia = normalizar(frase);

	for (const { palabras, accion } of FRASES) {
		if (palabras.includes(limpia)) return { texto: '', accion };
	}

	for (const { palabras, accion } of SUFIJOS) {
		for (const orden of palabras) {
			if (limpia !== orden && !limpia.endsWith(` ${orden}`)) continue;
			// Recortamos sobre el texto original para conservar mayúsculas y tildes:
			// quitamos tantas palabras como tenga la orden.
			const palabrasOriginales = frase.trim().split(/\s+/);
			const resto = palabrasOriginales.slice(0, -orden.split(' ').length).join(' ');
			return { texto: resto.replace(/[\s,;:]+$/, ''), accion };
		}
	}

	return { texto: frase.trim(), accion: null };
}

/** Palabras que abren el envío. Puede ir en cualquier punto de la frase. */
const APERTURA = ['open'];

/**
 * Busca la palabra de apertura en una frase dicha mientras no se envía nada.
 * @returns {string | null} lo dicho DESPUÉS de «open» (puede ser ''), o null
 *   si la frase no la contiene y hay que ignorarla.
 */
export function buscarApertura(frase) {
	const palabras = frase.trim().split(/\s+/);
	const indice = palabras.findIndex((palabra) => APERTURA.includes(normalizar(palabra)));
	if (indice === -1) return null;
	return palabras
		.slice(indice + 1)
		.join(' ')
		.replace(/^[\s,;:.]+/, '');
}

/**
 * Órdenes que, en espera, piden leer el resto de la última respuesta de Claude
 * (la parte que no es el resumen hablado). Solo como frase completa, para que
 * «dame más detalle del error» dictado tras «open» siga siendo texto.
 */
const DETALLE = ['mas detalle', 'mas detalles', 'lee todo', 'leelo todo', 'leer todo'];

export function pideDetalle(frase) {
	return DETALLE.includes(normalizar(frase));
}
