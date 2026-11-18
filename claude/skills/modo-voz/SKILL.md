---
name: modo-voz
description: Cómo responder cuando el usuario dicta por voz y oye la respuesta en voz alta (proyecto dictado-voz). Úsala siempre que el contexto diga «MODO VOZ ACTIVO», o cuando el usuario pida respuestas para oír, un resumen hablado, o diga que no puede leer la terminal. Define el párrafo «🔊», que es lo único que el backend lee en voz alta.
---

# Modo voz

El usuario dicta con `dictado-voz` y Chrome le lee la respuesta. Puede estar haciendo
otra cosa, sin mirar la pantalla. **Solo se lee el párrafo que empieza por `🔊`**; todo lo
demás se queda en la terminal para cuando pueda leerlo. Si no lo escribes, se lee la
respuesta entera desde el principio y cortada: lo peor de los dos mundos.

El hook `dictado-modo` añade el aviso «MODO VOZ ACTIVO» cuando está dictando a esta
terminal. Sin ese aviso, responde como siempre.

## El formato

Termina **cada** respuesta con **un único párrafo** que empiece por `🔊 ` (emoji + espacio):

```
🔊 Ya está: el lector solo lee este resumen y tiene una orden nueva, «más detalle». Los
tests pasan. Falta reiniciar el contenedor. ¿Lo reinicio ahora?
```

- **Excepción:** lo que respondes a un hook `Stop` (el aviso de commit) no lleva `🔊`: no
  se lee, y al usuario no le interesa oír nada sobre commits.
- Va **al final**, después de todo, también de los apartados que exija el proyecto.
- Es **un párrafo**: termina en la primera línea vacía. Nada de viñetas dentro.
- El resto de la respuesta se escribe normal (puede llevar tablas, código, rutas):
  quien lee la terminal lo agradece. Pero sé más breve que de costumbre; el usuario
  puede pedir el resto diciendo «más detalle».

## Cómo escribir el párrafo hablado

Se escribe para el oído, no para la vista:

1. **La conclusión primero.** Qué pasó o qué decides, en la primera frase. Ni
   preámbulos («He revisado…») ni repetir la pregunta.
2. **Dos a cuatro frases, unas 60 palabras.** Si no cabe, lo que sobra está en la terminal.
3. **Español hablado y natural.** Frases cortas, sujeto y verbo. Una idea por frase.
4. **Nada que no se pueda decir:** sin rutas, extensiones, nombres de funciones,
   `camelCase`, comandos, URLs, tablas, símbolos ni listas. Nómbralo por lo que es:
   «el lector de voz», no `voz.js`; «la prueba del carrito», no `cart.test.ts:42`.
5. **Números a la manera hablada:** «unos cuarenta segundos», «tres archivos», no «40 s».
6. **Si algo falló, dilo claro**, no lo escondas detrás de lo que sí salió.
7. **Si necesitas al usuario, acaba con una pregunta concreta y que se responda de
   palabra**, a poder ser sí/no o entre dos opciones con nombre: «¿Lo subo a develop o
   espero?». Nunca «¿qué opinas?» ni «¿alguna otra cosa?».
8. **No digas que hay un resumen** ni anuncies el párrafo («En resumen…»). Ya lo es.

## Lo que el usuario puede decir después

- «más detalle» / «lee todo»: el backend lee el resto de la respuesta (sin el 🔊).
- «cállate» / «basta»: corta la lectura.
- «open» … «enter»: dicta el siguiente prompt.

Las tablas y los bloques de código del resto de la respuesta, si se leen con «más
detalle», solo se anuncian («tabla», «bloque de código»): nunca se recitan.
