// Rectas y arcos para el DXF del nesting (Gaspar 28-oct-2026: "cuando exporto me sale lleno de puntos rojos y eso me perjudica
// a la hora del corte"). Las curvas llegan como polilíneas con un punto cada poquito (las Bézier del PDF pasadas a tramos
// rectos de TOL_CURVA, los arcos de un DXF igual): Aspire muestra cada punto como un nodo y la máquina corta a los saltos.
// ajustar() rearma cada polilínea como una sucesión de rectas y arcos (el bulge del VERTEX, código 42, que Aspire y casi todos
// los CAM leen como arco) que quedan a tol o menos de la original, en las dos direcciones: cada punto y cada tramo de la
// original queda a tol o menos de su recta o arco, y el arco no se sale de esa franja.
// - Las puntas de cada recta o arco son puntos de la original: el contorno empieza donde empezaba, va en el mismo sentido y las
//   esquinas quedan exactas.
// - Ajuste codicioso: desde cada punta, la recta o el arco que llega más lejos (búsqueda a saltos y después binaria). Si la
//   recta entra, va recta: así las rectas partidas en tramitos se funden.
// - Sin radios absurdos: un arco casi recto (más de R_MAX de radio, o que se aparta menos de 0,5° de su cuerda) va como recta
//   si la recta entra; si no entra, como mucho con R_MAX de radio.
// - Tangentes: en una unión suave (quiebre de menos de QUIEBRE grados) el arco sale con la tangente con que llegó el anterior,
//   a G1 grados o menos, si así llega por lo menos a CON_G1 del largo del arco libre; si no, el arco libre que menos quiebra.
//   Así la máquina no frena en cada unión. Las esquinas de verdad quedan como esquinas (ahí va el arco de menor desvío).
// - Cada arco barre 180° como mucho (bulge entre -1 y 1): un círculo cerrado sale en dos o tres arcos.
// - Las coordenadas se redondean a 0,001 mm antes de ajustar, como se escriben, y el ajuste deja ese margen: el desvío contra
//   la polilínea sin redondear queda a tol o menos.
// Solo cambia la salida DXF: la geometría de las piezas, el motor y el código G no lo usan.
(function (raiz) {
  'use strict';

  const QUIEBRE = 20 * Math.PI / 180; // una unión que quiebra menos que esto se toma como suave; más, como esquina
  const G1 = 0.1 * Math.PI / 180;     // tangente de salida de un arco en una unión suave: a esto o menos de la de llegada
  const CON_G1 = 0.3;                 // el arco con la tangente tiene que llegar a esta fracción del largo del libre
  const R_MAX = 10000;                // mm: un arco de más radio es una recta (los controladores se marean con radios enormes)
  const CASI_RECTA = Math.tan(0.25 * Math.PI / 180); // bulge de un arco que se aparta menos de 0,5° de su cuerda: si la recta entra, va recta
  const R3 = (v) => Math.round(v * 1000) / 1000 || 0; // como se escribe en el DXF
  const vuelta = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI)); // ángulo a (-π, π]

  // Bulge del arco de (-1, 0) a (1, 0) que pasa por (u, v), entre -1 y 1. Positivo: se curva hacia v < 0 (antihorario).
  function bulge3(u, v) {
    if (Math.abs(v) < 1e-12) return 0;
    const K = (u * u + v * v - 1) / (2 * Math.abs(v)), s = Math.sqrt(K * K + 1);
    const a = K >= 0 ? s + K : 1 / (s - K);
    return Math.max(-1, Math.min(1, v < 0 ? a : -a));
  }

  // pts: [[x, y], ...] en mm; cerrado: si el contorno cierra; tol: desvío máximo en mm. Devuelve [[x, y, bulge], ...]: cada
  // vértice con el bulge del tramo que sale de él (tan(ángulo/4), positivo antihorario, como en el DXF y en dxf.js). En una
  // abierta el último lleva 0; en una cerrada, el del tramo que vuelve al primero.
  function ajustar(pts, cerrado, tol) {
    tol = tol > 0 ? tol : 0.05;
    const tolA = Math.max(tol / 2, tol - 0.001); // lo que se puede usar después de redondear a 0,001
    const X = [], Y = [];
    for (const p of pts) {
      if (!isFinite(p[0]) || !isFinite(p[1])) continue;
      const x = R3(p[0]), y = R3(p[1]), k = X.length;
      if (k && X[k - 1] === x && Y[k - 1] === y) continue;
      X.push(x); Y.push(y);
    }
    if (cerrado) while (X.length > 1 && X[X.length - 1] === X[0] && Y[Y.length - 1] === Y[0]) { X.pop(); Y.pop(); }
    if (X.length < 3) return X.map((x, k) => [x, Y[k], 0]);
    if (cerrado) { X.push(X[0]); Y.push(Y[0]); }
    const M = X.length - 1; // tramos a cubrir: de 0 a M (en una cerrada, M vuelve al primero)
    const S = new Float64Array(M + 1); // largo acumulado
    for (let k = 1; k <= M; k++) S[k] = S[k - 1] + Math.hypot(X[k] - X[k - 1], Y[k] - Y[k - 1]);
    const U = new Float64Array(M + 1), V = new Float64Array(M + 1); // el candidato en su sistema: A = (-1, 0), B = (1, 0)
    let H = 0, F = 0, G = 0, Bok = 0, tang = 0;

    // Pasa los puntos de i a j al sistema del candidato (unidades de media cuerda). Devuelve la media cuerda, o 0.
    const local = (i, j) => {
      const dx = X[j] - X[i], dy = Y[j] - Y[i], c = Math.hypot(dx, dy);
      if (c < 1e-9) return 0;
      const h = c / 2, mx = (X[i] + X[j]) / 2, my = (Y[i] + Y[j]) / 2, ex = dx / (c * h), ey = dy / (c * h);
      for (let k = i + 1; k < j; k++) { const px = X[k] - mx, py = Y[k] - my; U[k] = px * ex + py * ey; V[k] = py * ex - px * ey; }
      U[i] = -1; V[i] = 0; U[j] = 1; V[j] = 0;
      return (H = h);
    };
    // Desvíos del arco de bulge b contra los puntos y los tramos de i a j (ya en local), en unidades de media cuerda: F = lo
    // más que queda algo del lado hacia donde se curva una b positiva, G = del otro lado. Un punto fuera del barrido del arco
    // cuenta su distancia a la punta más cercana en los dos. Corta apenas F y G pasan los dos de lim.
    const desvio = (b, i, j, lim) => {
      const q = 1 - b * b, w = 1 + b * b, cy = b !== 0 ? q / (2 * b) : 0;
      let f = 0, g = 0;
      const punto = (u, v) => {
        if (q * (1 - Math.abs(u)) - 2 * b * v < 0) { // fuera del barrido
          const d = Math.min(Math.hypot(u + 1, v), Math.hypot(u - 1, v));
          if (d > f) f = d; if (d > g) g = d; return;
        }
        const s = (2 * b * (u * u + v * v - 1) - 2 * v * q) / (Math.hypot(2 * b * u, 2 * b * v - q) + w);
        if (s > f) f = s; else if (-s > g) g = -s;
      };
      for (let k = i + 1; k < j && !(f > lim && g > lim); k++) punto(U[k], V[k]);
      // Lo más hacia el centro de cada tramo está en el pie de la perpendicular desde el centro (en una recta, en las puntas).
      if (b !== 0) for (let k = i; k < j && !(f > lim && g > lim); k++) {
        const pu = U[k], pv = V[k], du = U[k + 1] - pu, dv = V[k + 1] - pv, L2 = du * du + dv * dv;
        if (L2 < 1e-30) continue;
        const t = (-pu * du + (cy - pv) * dv) / L2;
        if (t > 0 && t < 1) punto(pu + t * du, pv + t * dv);
      }
      F = f; G = g;
    };
    const entra = (b, i, j, t) => { desvio(b, i, j, t); return F <= t && G <= t; };
    // Busca entre lo y hi una bulge que entre a t (F baja y G sube con b), desde b. La deja en Bok.
    const buscar = (b, lo, hi, i, j, t) => {
      for (let it = 0; it < 64; it++) {
        desvio(b, i, j, t);
        const fo = F > t, go = G > t;
        if (!fo && !go) { Bok = b; return true; }
        if ((fo && go) || hi - lo < 1e-12) return false;
        if (fo) lo = b; else hi = b;
        b = (lo + hi) / 2;
      }
      return false;
    };
    // Sin radios absurdos: un arco casi recto (radio de más de R_MAX, o que se aparta menos de 0,5° de la cuerda) va recto si la
    // recta entra; si no, con radio R_MAX si entra. b ya entra; devuelve la bulge que queda, o NaN si ninguna entra.
    const sano = (b, i, j, t) => {
      if (b === 0) return 0;
      const bmin = H / (R_MAX + Math.sqrt(R_MAX * R_MAX - H * H)); // radio = R_MAX
      if (Math.abs(b) >= bmin && Math.abs(b) >= CASI_RECTA) return b;
      if (entra(0, i, j, t)) return 0;
      if (Math.abs(b) >= bmin) return b;
      const r = Math.sign(b) * bmin;
      return entra(r, i, j, t) ? r : NaN;
    };
    // ¿Entra una recta o un arco de i a j? Desde el arco por el punto del medio.
    const sirve = (i, j) => {
      const h = local(i, j);
      if (!h) return false;
      Bok = 0;
      if (j === i + 1) return true;
      const t = tolA / h, m = (i + j) >> 1;
      if (h < 2 * tolA) return entra(0, i, j, t); // cuerda de menos de 0,2 mm: solo recta
      if (!buscar(bulge3(U[m], V[m]), -1, 1, i, j, t)) return false;
      Bok = sano(Bok, i, j, t);
      return Bok === Bok;
    };
    // ¿Entra un arco de i a j que sale con la tangente tang (± G1)?
    const sirveG1 = (i, j) => {
      const h = local(i, j);
      if (!h || (h < 2 * tolA && j > i + 1)) return false;
      const a = vuelta(Math.atan2(Y[j] - Y[i], X[j] - X[i]) - tang); // sale girado -2·atan(b) de la cuerda
      if (Math.abs(a) > Math.PI / 2 - G1) return false;
      const lo = Math.tan((a - G1) / 2), hi = Math.tan((a + G1) / 2), t = tolA / h;
      desvio(hi, i, j, t); if (F > t) return false;
      desvio(lo, i, j, t); if (G > t) return false;
      if (!buscar(Math.tan(a / 2), lo, hi, i, j, t)) return false;
      Bok = sano(Bok, i, j, t);
      return Bok === Bok;
    };
    // El j más lejos desde i que pasa la prueba: a saltos (1, 2, 4...) y después binaria.
    const alcance = (i, prueba) => {
      let ok = i, mal = M + 1;
      for (let d = 1; ; d *= 2) {
        const j = i + d;
        if (j >= M) { if (prueba(i, M)) ok = M; else mal = M; break; }
        if (prueba(i, j)) ok = j; else { mal = j; break; }
      }
      while (mal - ok > 1) { const j = (ok + mal) >> 1; if (prueba(i, j)) ok = j; else mal = j; }
      return ok;
    };

    const out = [];
    let hayTang = false;
    for (let i = 0; i < M;) {
      let j = alcance(i, sirve);
      sirve(i, j);
      const t = tolA / H, ch = Math.atan2(Y[j] - Y[i], X[j] - X[i]);
      let b = 0;
      if (j > i + 1 && !entra(0, i, j, t)) {
        // Los arcos que entran van de bL a bR: cada punta por bisección desde Bok.
        const b0 = Bok, jL = j;
        let lo = -1, hi = b0;
        if (entra(lo, i, j, t)) hi = lo; else for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (entra(m, i, j, t)) hi = m; else lo = m; }
        const bL = hi;
        lo = b0; hi = 1;
        if (entra(hi, i, j, t)) lo = hi; else for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (entra(m, i, j, t)) lo = m; else hi = m; }
        const bR = lo;
        // Quiebre con el tramo anterior: sale girado -2·atan(b) de la cuerda; con a = cuerda - tang, sin quiebre si b = tan(a/2).
        const a = hayTang ? vuelta(ch - tang) : NaN, pL = 2 * Math.atan(bL), pR = 2 * Math.atan(bR);
        const kmin = hayTang ? (a < pL ? pL - a : a > pR ? a - pR : 0) : Infinity;
        if (kmin === 0) b = Math.tan(a / 2);
        else if (kmin < QUIEBRE) {
          const jT = alcance(i, sirveG1);
          if (jT > i && S[jT] - S[i] >= CON_G1 * (S[j] - S[i]) && sirveG1(i, jT)) { b = Bok; j = jT; }
          else b = Math.tan(Math.max(pL, Math.min(pR, a)) / 2); // el libre que menos quiebra
        } else { // esquina (o el primero): el de menor desvío, donde F y G se cruzan
          lo = bL; hi = bR;
          for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; desvio(m, i, j, Infinity); if (F > G) lo = m; else hi = m; }
          b = (lo + hi) / 2;
        }
        local(i, j);
        b = entra(b, i, j, tolA / H) ? sano(b, i, j, tolA / H) : NaN; // verificado
        if (b !== b) { j = jL; local(i, j); b = b0; } // si no entra, el libre que encontró la búsqueda
      }
      out.push([X[i], Y[i], b]);
      tang = Math.atan2(Y[j] - Y[i], X[j] - X[i]) + 2 * Math.atan(b); hayTang = true;
      i = j;
    }
    if (!cerrado) out.push([X[M], Y[M], 0]);
    return out;
  }

  const api = { ajustar };
  raiz.NestArcos = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
