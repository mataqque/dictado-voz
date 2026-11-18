import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pideDetalle } from './comandos.js';

test('«más detalle» y variantes piden el detalle, con o sin tildes', () => {
	for (const frase of ['Más detalle.', 'mas detalles', 'Léelo todo', 'lee todo']) assert.ok(pideDetalle(frase), frase);
});

test('solo como frase completa: dictado normal sigue siendo texto', () => {
	assert.ok(!pideDetalle('dame más detalle del error'));
	assert.ok(!pideDetalle('open más detalle'));
});
