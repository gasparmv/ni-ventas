// Worker del nesting: recibe las piezas y la configuración, y prueba órdenes distintos hasta que se le acaba el tiempo. Cada vez que
// mejora, manda el resultado. Las máscaras quedan guardadas mientras el worker viva (seguir optimizando no las recalcula).
importScripts('nest-core.js');
let piezas = null, cfg = null, cache = new Map(), mejorPropio = null;
onmessage = (e) => {
  const m = e.data;
  if (m.tipo === 'datos') { piezas = m.piezas; cfg = m.cfg; cache = new Map(); mejorPropio = null; return; }
  if (m.tipo === 'correr') correr(m);
};
function correr({ semilla, segundos, base, nuevo }) {
  if (nuevo) mejorPropio = null;
  const N = self.NestCore, azar = N.rng(semilla * 7919 + 13);
  const bases = N.ordenesBase(piezas);
  const fin = Date.now() + segundos * 1000;
  const inicio = base || (mejorPropio && mejorPropio.orden) || bases[(semilla - 1) % bases.length];
  // Con pocas piezas cada vuelta dura milisegundos: las vueltas se avisan de a tandas (cada 0,2 s) y se corta antes si
  // 300 seguidas no mejoraron nada.
  let k = 0, ultimaMejora = 0, sinAvisar = 0, tAviso = Date.now();
  while (k === 0 || (Date.now() < fin && k - ultimaMejora < 300)) {
    const orden = k === 0 ? inicio : N.variar(mejorPropio ? mejorPropio.orden : inicio, azar);
    const r = N.corrida(piezas, orden, cfg, cache);
    k++;
    if (!mejorPropio || r.puntaje < mejorPropio.puntaje) {
      mejorPropio = { ...r, orden };
      ultimaMejora = k;
      postMessage({ tipo: 'mejor', r: mejorPropio });
    }
    sinAvisar++;
    if (Date.now() - tAviso > 200) { postMessage({ tipo: 'corrida', n: sinAvisar }); sinAvisar = 0; tAviso = Date.now(); }
  }
  if (sinAvisar) postMessage({ tipo: 'corrida', n: sinAvisar });
  postMessage({ tipo: 'fin' });
}
