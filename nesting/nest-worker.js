// Worker del nesting: recibe las piezas y la configuración, y trabaja hasta que se le acaba el tiempo (NestCore.trabajar: prueba
// órdenes distintos, después rehace sola la última placa y al final compacta). Cada vez que mejora, manda el resultado. Las
// máscaras quedan guardadas mientras el worker viva (seguir optimizando no las recalcula).
importScripts('nest-core.js' + self.location.search); // misma versión que el worker (?v=), para no usar un motor viejo cacheado
let piezas = null, cfg = null, cache = new Map(), est = {};
onmessage = (e) => {
  const m = e.data;
  if (m.tipo === 'datos') { piezas = m.piezas; cfg = m.cfg; cache = new Map(); est = {}; return; }
  if (m.tipo === 'correr') correr(m);
};
function correr({ semilla, segundos, base, nuevo }) {
  if (nuevo) est = {};
  // Con pocas piezas cada vuelta dura milisegundos: las vueltas se avisan de a tandas (cada 0,2 s) y cada fase corta antes si
  // 300 seguidas no mejoraron nada.
  self.NestCore.trabajar(piezas, cfg, cache, est, { semilla, segundos, base }, (tipo, x) => {
    if (tipo === 'mejor') postMessage({ tipo: 'mejor', r: x });
    else postMessage({ tipo: 'corrida', n: x });
  });
  postMessage({ tipo: 'fin' });
}
