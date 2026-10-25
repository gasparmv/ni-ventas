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
  let k = 0;
  while (k === 0 || Date.now() < fin) {
    const orden = k === 0 ? inicio : N.variar(mejorPropio ? mejorPropio.orden : inicio, azar);
    const r = N.corrida(piezas, orden, cfg, cache);
    k++;
    if (!mejorPropio || r.puntaje < mejorPropio.puntaje) {
      mejorPropio = { ...r, orden };
      postMessage({ tipo: 'mejor', r: mejorPropio });
    }
    postMessage({ tipo: 'corrida' });
  }
  postMessage({ tipo: 'fin' });
}
