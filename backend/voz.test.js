import assert from 'node:assert/strict';
import { test } from 'node:test';

import { debeLeerseLaParada, extraerBloqueHablado, limpiarParaVoz, quitarBloqueHablado, textoParaLeer } from './voz.js';

const RESPUESTA = `He cambiado el lector.

| archivo | cambio |
|---|---|
| voz.js | bloque |

**Decisiones:** ninguna.

🔊 Ya está. Solo se lee este resumen.
¿Lo pruebo ahora?`;

test('con bloque 🔊 se lee solo el bloque, sin el emoji', () => {
	assert.equal(textoParaLeer(RESPUESTA), 'Ya está. Solo se lee este resumen. ¿Lo pruebo ahora?');
});

test('sin bloque 🔊 se lee la respuesta entera, como antes', () => {
	assert.equal(textoParaLeer('Hola **mundo**.'), 'Hola mundo.');
});

test('el bloque acaba en la primera línea vacía', () => {
	assert.equal(extraerBloqueHablado('🔊 uno\ndos\n\ntres'), '🔊 uno\ndos');
});

test('el bloque admite «>» y negrita delante', () => {
	assert.equal(extraerBloqueHablado('x\n\n> **🔊 hola**'), '> **🔊 hola**');
	assert.equal(textoParaLeer('x\n\n> **🔊 hola**'), 'hola');
});

test('sin bloque devuelve null', () => {
	assert.equal(extraerBloqueHablado('nada que oír'), null);
});

test('el detalle es la respuesta sin el bloque', () => {
	const detalle = limpiarParaVoz(quitarBloqueHablado(RESPUESTA));
	assert.ok(!detalle.includes('Ya está'));
	assert.ok(detalle.startsWith('He cambiado el lector.'));
});

test('una tabla se anuncia una sola vez, no se recita', () => {
	const texto = limpiarParaVoz(RESPUESTA);
	assert.equal(texto.match(/\(tabla\)/g)?.length, 1);
	assert.ok(!texto.includes('archivo'));
});

test('el resumen hablado no se corta con el aviso de la terminal si cabe', () => {
	assert.ok(!textoParaLeer(RESPUESTA, 1200).includes('El resto está en la terminal'));
});

test('la continuación forzada por otro hook Stop no se lee: cortaría la respuesta en curso', () => {
	assert.equal(debeLeerseLaParada({ stop_hook_active: true }), false);
});

test('una parada normal sí se lee', () => {
	assert.equal(debeLeerseLaParada({ stop_hook_active: false }), true);
	assert.equal(debeLeerseLaParada({}), true);
});
