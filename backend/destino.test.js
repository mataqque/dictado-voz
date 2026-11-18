import assert from 'node:assert/strict';
import { test } from 'node:test';

import { destinoVivo, idDelDestino, leerEstadoGuardado, leerStat, listarTerminales, serializarEstado } from './destino.js';

const BASE = '/tmp/kitty-dictado';
const DESTINO = { socket: `${BASE}-123`, ventana: '1' };
const TODO_VIVO = { esSocket: () => true, procesoVivo: () => true, ventanaViva: () => true };

test('lo guardado se recupera tal cual tras reiniciar', () => {
	assert.deepEqual(leerEstadoGuardado(serializarEstado(true, DESTINO), BASE), DESTINO);
});

test('parado no se recuerda ninguna terminal', () => {
	assert.equal(leerEstadoGuardado(serializarEstado(false, DESTINO), BASE), null);
	assert.equal(leerEstadoGuardado(serializarEstado(true, null), BASE), null);
});

test('un fichero roto o manipulado no se usa', () => {
	const conDestino = (destino) => JSON.stringify({ listening: true, destino });
	assert.equal(leerEstadoGuardado('{roto', BASE), null);
	assert.equal(leerEstadoGuardado('null', BASE), null);
	assert.equal(leerEstadoGuardado(conDestino({ socket: '/tmp/otro-123' }), BASE), null);
	assert.equal(leerEstadoGuardado(conDestino({ socket: `${BASE}-abc` }), BASE), null);
	assert.equal(leerEstadoGuardado(conDestino({ socket: `${BASE}-1`, ventana: '1; rm' }), BASE), null);
	assert.equal(leerEstadoGuardado(conDestino({ socket: 5 }), BASE), null);
});

test('con el socket, el proceso y la ventana vivos, la terminal sigue abierta', () => {
	assert.equal(destinoVivo(DESTINO, TODO_VIVO), true);
});

test('sin socket la terminal está cerrada: es lo que pasa tras apagar la laptop', () => {
	assert.equal(destinoVivo(DESTINO, { ...TODO_VIVO, esSocket: () => false }), false);
});

test('un socket huérfano de un kitty muerto no cuenta como abierta', () => {
	assert.equal(destinoVivo(DESTINO, { ...TODO_VIVO, procesoVivo: () => false }), false);
});

test('cerrar la ventana cuenta aunque el kitty siga vivo con otras', () => {
	assert.equal(destinoVivo(DESTINO, { ...TODO_VIVO, ventanaViva: () => false }), false);
});

test('sin ventana fijada (atajo de Hyprland) basta con que viva el kitty', () => {
	assert.equal(destinoVivo({ socket: `${BASE}-123`, ventana: null }, { ...TODO_VIVO, ventanaViva: () => false }), true);
});

test('un socket sin pid no permite comprobar más', () => {
	assert.equal(destinoVivo({ socket: BASE, ventana: null }, { ...TODO_VIVO, procesoVivo: () => false }), true);
});

const proceso = (pid, ppid, sid, tpgid, comm, kittyPid, ventana = '1', cwd = '/home/edu/proyecto') => ({ pid, ppid, sid, tpgid, comm, cwd, kittyPid, ventana });
const CON_SOCKET = () => true;

test('leerStat aguanta espacios y paréntesis en el nombre del proceso', () => {
	const stat = leerStat('42 (npm exec (x) y) S 7 42 40 34820 99 4194304');
	assert.deepEqual(stat, { comm: 'npm exec (x) y', ppid: '7', sid: '40', tpgid: '99' });
});

test('una ventana es la sesión hija de kitty, no todo lo que hereda sus variables', () => {
	const procesos = [
		proceso('10', '5', '10', '10', 'zsh', '5'),
		proceso('11', '1', '10', '10', 'zsh', '5', '1', '/'), // demonio de zsh, huérfano
		proceso('12', '10', '12', '-1', 'zsh', '5'), // subshell con su propia sesión
	];
	assert.deepEqual(listarTerminales(procesos, CON_SOCKET).map((t) => t.id), ['5:1']);
});

test('se nombra por lo que corre en primer plano y su carpeta', () => {
	const procesos = [proceso('10', '5', '10', '20', 'zsh', '5'), proceso('20', '10', '10', '20', 'claude', '5', '1', '/home/edu/tienda')];
	const [terminal] = listarTerminales(procesos, CON_SOCKET);
	assert.equal(terminal.nombre, 'tienda');
	assert.equal(terminal.detalle, 'Claude Code');
});

test('el título de la ventana da nombre a un programa, sin su símbolo animado', () => {
	const procesos = [proceso('10', '5', '10', '20', 'zsh', '5'), proceso('20', '10', '10', '20', 'claude', '5')];
	const [terminal] = listarTerminales(procesos, CON_SOCKET, [{ pid: 5, titulo: '✳ Arreglar login', escritorio: '3' }]);
	assert.equal(terminal.nombre, 'Arreglar login');
	assert.equal(terminal.detalle, 'proyecto · Claude Code · escritorio 3');
});

test('el título de una shell es ruido: manda la carpeta', () => {
	const [terminal] = listarTerminales([proceso('10', '5', '10', '10', 'zsh', '5')], CON_SOCKET, [{ pid: 5, titulo: 'edu@Arch:~/proyecto', escritorio: '1' }]);
	assert.equal(terminal.nombre, 'proyecto');
});

test('con varias ventanas en un kitty, el título (de la pestaña activa) no se reparte', () => {
	const procesos = [proceso('10', '5', '10', '20', 'zsh', '5', '1'), proceso('20', '10', '10', '20', 'vim', '5', '1'), proceso('30', '5', '30', '30', 'zsh', '5', '2')];
	const terminales = listarTerminales(procesos, CON_SOCKET, [{ pid: 5, titulo: 'archivo.js', escritorio: '1' }]);
	assert.deepEqual(terminales.map((t) => t.nombre), ['proyecto', 'proyecto (2)']);
});

test('sin socket de control no se ofrece: no se le podría escribir', () => {
	assert.deepEqual(listarTerminales([proceso('10', '5', '10', '10', 'zsh', '5')], () => false), []);
});

test('idDelDestino encuentra la ventana elegida o, sin ventana, la primera del kitty', () => {
	const terminales = [{ id: '123:1', kittyPid: '123', ventana: '1' }, { id: '123:2', kittyPid: '123', ventana: '2' }];
	assert.equal(idDelDestino({ socket: `${BASE}-123`, ventana: '2' }, terminales), '123:2');
	assert.equal(idDelDestino({ socket: `${BASE}-123`, ventana: null }, terminales), '123:1');
	assert.equal(idDelDestino({ socket: `${BASE}-999`, ventana: '1' }, terminales), null);
	assert.equal(idDelDestino(null, terminales), null);
});
