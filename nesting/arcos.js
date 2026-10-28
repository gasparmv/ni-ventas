// Rectas y arcos para el DXF del nesting (Gaspar 28-oct-2026: "cuando exporto me sale lleno de puntos rojos y eso me perjudica
// a la hora del corte"). Las curvas llegan como polilíneas con un punto cada poquito (las Bézier del PDF pasadas a tramos
// rectos de TOL_CURVA, los arcos de un DXF igual): Aspire muestra cada punto como un nodo y la máquina corta a los saltos.
// ajustar() rearma cada polilínea como una sucesión de rectas y arcos (el bulge del VERTEX, código 42, que Aspire y casi todos
// los CAM leen como arco) que quedan a tol o menos de la original, en las dos direcciones: cada punto y cada tramo de la
// original queda a tol o menos de su recta o arco, y el arco no se sale de esa franja.
// - Las puntas de cada recta o arco son puntos de la original: el contorno empieza donde empezaba, va en el mismo sentido y las
//   esquinas quedan exactas.
// - Ajuste codicioso: desde cada punta, la recta o el arco que llega más lejos (búsqueda a saltos y después binaria). Si la
//   recta llega a RECTA del largo del arco o más, va recta: así las rectas partidas en tramitos se funden y un lado recto no se
//   vuelve un arco chato por comerse el redondeo chiquito de la esquina.
// - Sin radios absurdos: un arco casi recto (más de R_MAX de radio, o que se aparta menos de 0,5° de su cuerda) va como recta
//   si la recta entra; si no entra, como mucho con R_MAX de radio.
// - Tangentes: en una unión suave (quiebre de menos de QUIEBRE grados) el arco sale con la tangente con que llegó el anterior,
//   a G1 grados o menos, si así llega por lo menos a CON_G1 del largo del arco libre, más lejos que la recta (si no, curvaría
//   una recta de la original) y sin terminar más torcido que la original en esa punta; si no, el arco libre que menos quiebra.
//   Así la máquina no frena en cada unión. Las esquinas de verdad quedan como esquinas (ahí va el arco de menor desvío).
// - Cada arco barre 180° como mucho (bulge entre -1 y 1): un círculo cerrado sale en dos o tres arcos.
// - Una cerrada que quedaría sin área o dada vuelta (una astilla de menos de 0,1 mm de ancho) sale con sus puntos tal cual.
// - Separación y margen (op.afuera): en cada tramo, cuánto se puede salir el arco hacia afuera del material (hacia la pieza
//   vecina o el borde) sin achicar la separación ni el margen que dejó el motor; holguras() lo calcula para una lámina.
// - Las coordenadas se redondean a 0,001 mm antes de ajustar, como se escriben, y el ajuste deja ese margen: el desvío contra
//   la polilínea sin redondear queda a tol o menos.
// Solo cambia la salida DXF: la geometría de las piezas, el motor y el código G no lo usan.
(function (raiz) {
  'use strict';

  const QUIEBRE = 20 * Math.PI / 180; // una unión que quiebra menos que esto se toma como suave; más, como esquina
  const G1 = 0.1 * Math.PI / 180;     // tangente de salida de un arco en una unión suave: a esto o menos de la de llegada
  const CON_G1 = 0.3;                 // el arco con la tangente tiene que llegar a esta fracción del largo del libre
  const PEOR_G1 = 1 * Math.PI / 180;  // el arco con la tangente no puede terminar más torcido que esto fuera de la original
  const RECTA = 0.9;                  // si la recta llega a esta fracción del largo del arco libre, va recta
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

  // Área con signo (positiva antihoraria) de una cerrada de [x, y, bulge]: el polígono más el segmento circular de cada arco.
  function areaB(vs) {
    if (!vs.length) return 0;
    const x0 = vs[0][0], y0 = vs[0][1]; // desde el primero, para no perder decimales lejos del origen
    let s = 0;
    for (let k = 0; k < vs.length; k++) {
      const [ax, ay, b] = vs[k], [bx, by] = vs[(k + 1) % vs.length];
      s += ((ax - x0) * (by - y0) - (bx - x0) * (ay - y0)) / 2;
      if (b) { const c = Math.hypot(bx - ax, by - ay), th = 4 * Math.atan(Math.abs(b)), R = c * (1 + b * b) / (4 * Math.abs(b)); s += Math.sign(b) * R * R / 2 * (th - Math.sin(th)); }
    }
    return s;
  }

  // pts: [[x, y], ...] en mm; cerrado: si el contorno cierra; tol: desvío máximo en mm. Devuelve [[x, y, bulge], ...]: cada
  // vértice con el bulge del tramo que sale de él (tan(ángulo/4), positivo antihorario, como en el DXF y en dxf.js). En una
  // abierta el último lleva 0; en una cerrada, el del tramo que vuelve al primero.
  // op (opcional): { afuera: holgura en mm de cada tramo de pts (de k a k+1; en una cerrada el último vuelve al primero), lado: 1
  // si afuera del material queda a la derecha del avance, -1 si a la izquierda }. Hacia afuera, el arco se aparta de la
  // original como mucho la holgura del tramo (sin pasar de tol); hacia adentro, tol.
  function ajustar(pts, cerrado, tol, op) {
    tol = tol > 0 ? tol : 0.05;
    const tolA = Math.max(tol / 2, tol - 0.001); // lo que se puede usar después de redondear a 0,001
    const X = [], Y = [], O = []; // O: índice en pts de cada punto que queda
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
      const x = R3(p[0]), y = R3(p[1]), n = X.length;
      if (n && X[n - 1] === x && Y[n - 1] === y) continue;
      X.push(x); Y.push(y); O.push(k);
    }
    if (cerrado) while (X.length > 1 && X[X.length - 1] === X[0] && Y[Y.length - 1] === Y[0]) { X.pop(); Y.pop(); O.pop(); }
    if (X.length < 3) return X.map((x, k) => [x, Y[k], 0]);
    const N0 = X.length;
    const tal = () => X.slice(0, N0).map((x, k) => [x, Y[k], 0]); // los puntos tal cual (como antes)
    if (cerrado) { X.push(X[0]); Y.push(Y[0]); }
    const M = X.length - 1; // tramos a cubrir: de 0 a M (en una cerrada, M vuelve al primero)
    const S = new Float64Array(M + 1); // largo acumulado
    for (let k = 1; k <= M; k++) S[k] = S[k - 1] + Math.hypot(X[k] - X[k - 1], Y[k] - Y[k - 1]);
    // Límites (1 / mm) de cada punto (iF, iG) y de cada tramo (sF, sG). F: la original queda a la derecha del arco (el arco, a
    // su izquierda); G: al revés.
    const iF = new Float64Array(M + 1).fill(1 / tolA), iG = new Float64Array(M + 1).fill(1 / tolA);
    const sF = new Float64Array(M).fill(1 / tolA), sG = new Float64Array(M).fill(1 / tolA);
    const af = op && op.afuera;
    if (af && af.length) {
      const n = pts.length, der = !(op.lado < 0), hs = new Float64Array(M);
      for (let k = 0; k < M; k++) { // el tramo k cubre los tramos de pts de O[k] a O[k + 1] (el último de una cerrada, hasta O[0])
        const a = O[k], b = k + 1 < N0 ? O[k + 1] : O[0] + n;
        let m = Infinity;
        for (let q = a; q < b; q++) { const v = af[q % n]; if (v < m) m = v; }
        hs[k] = m;
      }
      const lim = (h) => 1 / Math.min(tolA, Math.max(1e-6, h - 0.001)); // 0,001 para el redondeo
      for (let k = 0; k < M; k++) { if (der) sG[k] = lim(hs[k]); else sF[k] = lim(hs[k]); }
      for (let k = 0; k <= M; k++) {
        const h = Math.min(k > 0 ? hs[k - 1] : cerrado ? hs[M - 1] : Infinity, k < M ? hs[k] : cerrado ? hs[0] : Infinity);
        if (der) iG[k] = lim(h); else iF[k] = lim(h);
      }
    }
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
    // Desvíos del arco de bulge b contra los puntos y los tramos de i a j (ya en local), como fracción de su límite: F = lo
    // más que queda algo del lado hacia donde se curva una b positiva, G = del otro lado; entra si los dos dan 1 o menos. Un
    // punto fuera del barrido del arco cuenta su distancia a la punta más cercana en los dos. Corta apenas F y G pasan los dos
    // de lim.
    const desvio = (b, i, j, lim) => {
      const q = 1 - b * b, w = 1 + b * b, cy = b !== 0 ? q / (2 * b) : 0;
      let f = 0, g = 0;
      const punto = (u, v, lf, lg) => {
        if (q * (1 - Math.abs(u)) - 2 * b * v < 0) { // fuera del barrido
          const d = Math.min(Math.hypot(u + 1, v), Math.hypot(u - 1, v)) * H;
          if (d * lf > f) f = d * lf; if (d * lg > g) g = d * lg; return;
        }
        const s = (2 * b * (u * u + v * v - 1) - 2 * v * q) / (Math.hypot(2 * b * u, 2 * b * v - q) + w) * H;
        if (s > 0) { if (s * lf > f) f = s * lf; } else if (-s * lg > g) g = -s * lg;
      };
      for (let k = i + 1; k < j && !(f > lim && g > lim); k++) punto(U[k], V[k], iF[k], iG[k]);
      // Lo más hacia el centro de cada tramo está en el pie de la perpendicular desde el centro (en una recta, en las puntas).
      if (b !== 0) for (let k = i; k < j && !(f > lim && g > lim); k++) {
        const pu = U[k], pv = V[k], du = U[k + 1] - pu, dv = V[k + 1] - pv, L2 = du * du + dv * dv;
        if (L2 < 1e-30) continue;
        const t = (-pu * du + (cy - pv) * dv) / L2;
        if (t > 0 && t < 1) punto(pu + t * du, pv + t * dv, sF[k], sG[k]);
      }
      F = f; G = g;
    };
    const entra = (b, i, j) => { desvio(b, i, j, 1); return F <= 1 && G <= 1; };
    // Busca entre lo y hi una bulge que entre (F baja y G sube con b), desde b. La deja en Bok.
    const buscar = (b, lo, hi, i, j) => {
      for (let it = 0; it < 64; it++) {
        desvio(b, i, j, 1);
        const fo = F > 1, go = G > 1;
        if (!fo && !go) { Bok = b; return true; }
        if ((fo && go) || hi - lo < 1e-12) return false;
        if (fo) lo = b; else hi = b;
        b = (lo + hi) / 2;
      }
      return false;
    };
    // Sin radios absurdos: un arco casi recto (radio de más de R_MAX, o que se aparta menos de 0,5° de la cuerda) va recto si la
    // recta entra; si no, con radio R_MAX si entra. b ya entra; devuelve la bulge que queda, o NaN si ninguna entra.
    const sano = (b, i, j) => {
      if (b === 0) return 0;
      const bmin = H / (R_MAX + Math.sqrt(R_MAX * R_MAX - H * H)); // radio = R_MAX
      if (Math.abs(b) >= bmin && Math.abs(b) >= CASI_RECTA) return b;
      if (entra(0, i, j)) return 0;
      if (Math.abs(b) >= bmin) return b;
      const r = Math.sign(b) * bmin;
      return entra(r, i, j) ? r : NaN;
    };
    // ¿Entra una recta o un arco de i a j? Desde el arco por el punto del medio.
    const sirve = (i, j) => {
      const h = local(i, j);
      if (!h) return false;
      Bok = 0;
      if (j === i + 1) return true;
      const m = (i + j) >> 1;
      if (h < 2 * tolA) return entra(0, i, j); // cuerda de menos de 0,2 mm: solo recta
      if (!buscar(bulge3(U[m], V[m]), -1, 1, i, j)) return false;
      Bok = sano(Bok, i, j);
      return Bok === Bok;
    };
    // ¿Entra la recta de i a j?
    const recta = (i, j) => j === i + 1 || (local(i, j) > 0 && entra(0, i, j));
    // ¿Entra un arco de i a j que sale con la tangente tang (± G1)?
    const sirveG1 = (i, j) => {
      const h = local(i, j);
      if (!h || (h < 2 * tolA && j > i + 1)) return false;
      const a = vuelta(Math.atan2(Y[j] - Y[i], X[j] - X[i]) - tang); // sale girado -2·atan(b) de la cuerda
      if (Math.abs(a) > Math.PI / 2 - G1) return false;
      const lo = Math.tan((a - G1) / 2), hi = Math.tan((a + G1) / 2);
      desvio(hi, i, j, 1); if (F > 1) return false;
      desvio(lo, i, j, 1); if (G > 1) return false;
      if (!buscar(Math.tan(a / 2), lo, hi, i, j)) return false;
      Bok = sano(Bok, i, j);
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
    // Cuánto queda torcida (en radianes) la tangente t de llegada a j fuera de lo que gira la original ahí (entre la dirección
    // del tramo que llega a j y la del que sale). En la punta de una abierta, contra el tramo que llega.
    const torcida = (j, t) => {
      const d1 = Math.atan2(Y[j] - Y[j - 1], X[j] - X[j - 1]);
      const n = j < M ? j + 1 : cerrado ? 1 : -1;
      const g = n < 0 ? 0 : vuelta(Math.atan2(Y[n] - Y[j], X[n] - X[j]) - d1), e = vuelta(t - d1);
      return g >= 0 ? (e < 0 ? -e : e > g ? e - g : 0) : (e > 0 ? e : e < g ? g - e : 0);
    };

    const out = [];
    let hayTang = false;
    for (let i = 0; i < M;) {
      let j = alcance(i, sirve);
      sirve(i, j);
      let b = 0;
      if (j > i + 1 && !entra(0, i, j)) {
        const b0 = Bok, jL = j, ch = Math.atan2(Y[j] - Y[i], X[j] - X[i]);
        const jS = alcance(i, recta); // hasta dónde llega la recta
        if (S[jS] - S[i] >= RECTA * (S[j] - S[i])) j = jS;
        else {
          local(i, j);
          // Los arcos que entran van de bL a bR: cada punta por bisección desde Bok.
          let lo = -1, hi = b0;
          if (entra(lo, i, j)) hi = lo; else for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (entra(m, i, j)) hi = m; else lo = m; }
          const bL = hi;
          lo = b0; hi = 1;
          if (entra(hi, i, j)) lo = hi; else for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (entra(m, i, j)) lo = m; else hi = m; }
          const bR = lo;
          // Quiebre con el tramo anterior: sale girado -2·atan(b) de la cuerda; con a = cuerda - tang, sin quiebre si b = tan(a/2).
          const a = hayTang ? vuelta(ch - tang) : NaN, pL = 2 * Math.atan(bL), pR = 2 * Math.atan(bR);
          const kmin = hayTang ? (a < pL ? pL - a : a > pR ? a - pR : 0) : Infinity;
          if (kmin === 0) b = Math.tan(a / 2);
          else if (kmin < QUIEBRE) {
            // El arco con la tangente, solo si llega lejos, si ahí no entraba una recta (si entra, el arco con la tangente
            // curvaría una recta de la original: va el libre, que llega hasta donde la recta no entra) y si no termina torcido.
            const jT = alcance(i, sirveG1);
            let g1 = false;
            if (jT > jS && S[jT] - S[i] >= CON_G1 * (S[j] - S[i]) && sirveG1(i, jT)) {
              const bT = Bok, tFin = Math.atan2(Y[jT] - Y[i], X[jT] - X[i]) + 2 * Math.atan(bT);
              if (torcida(jT, tFin) <= PEOR_G1) { b = bT; j = jT; g1 = true; }
            }
            if (!g1) b = Math.tan(Math.max(pL, Math.min(pR, a)) / 2); // el libre que menos quiebra
          } else { // esquina (o el primero): el de menor desvío, donde F y G se cruzan
            lo = bL; hi = bR;
            for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; desvio(m, i, j, Infinity); if (F > G) lo = m; else hi = m; }
            b = (lo + hi) / 2;
          }
          local(i, j);
          b = entra(b, i, j) ? sano(b, i, j) : NaN; // verificado
          if (b !== b) { j = jL; local(i, j); b = b0; } // si no entra, el libre que encontró la búsqueda
        }
      }
      out.push([X[i], Y[i], b]);
      tang = Math.atan2(Y[j] - Y[i], X[j] - X[i]) + 2 * Math.atan(b); hayTang = true;
      i = j;
    }
    if (!cerrado) out.push([X[M], Y[M], 0]);
    // Una astilla cerrada (menos de 0,1 mm de ancho) puede quedar en ida y vuelta por la misma recta, sin área, o dada vuelta.
    else if ((out.length < 3 && !out.some((v) => v[2])) || Math.sign(areaB(out)) !== Math.sign(areaB(tal()))) return tal();
    return out;
  }

  // Holgura hacia afuera de cada tramo de los cortes cerrados de una lámina, para que los arcos no achiquen la separación entre
  // piezas ni el margen al borde que dejó el motor: (distancia a la pieza más cercana - sep) / 2 (la mitad para cada una) y
  // distancia al borde - margen, entre 0 y tol. cs: [{ pts, pieza }] (contornos y huecos; pieza: la que es dueña);
  // op: { sep, margen, tol, bordes: [anillo de la lámina, ...] }. Devuelve, por contorno, la holgura de cada tramo (de k a k+1,
  // el último vuelve al primero).
  function holguras(cs, op) {
    const tol = op.tol > 0 ? op.tol : 0.05, sep = +op.sep || 0, mg = +op.margen || 0;
    const R = Math.max(sep + 2 * tol, mg + tol) + 0.01; // más lejos que esto, la holgura es tol
    const AX = [], AY = [], BX = [], BY = [], DU = []; // tramos: puntas y dueño (-1: borde)
    const meter = (P, d) => { const n = P.length; for (let k = 0; k < n; k++) { const a = P[k], b = P[(k + 1) % n]; AX.push(+a[0]); AY.push(+a[1]); BX.push(+b[0]); BY.push(+b[1]); DU.push(d); } };
    const ini = [];
    cs.forEach((c, i) => { ini.push(AX.length); meter(c.pts, c.pieza); });
    for (const rg of op.bordes || []) meter(rg, -1);
    const NT = AX.length, C = R, celdas = new Map();
    const clave = (ix, iy) => ix * 4194304 + iy;
    const caja = (t, f) => { // las celdas de cada pedazo de C de largo del tramo t, agrandado en m
      const ax = AX[t], ay = AY[t], bx = BX[t], by = BY[t], L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / C));
      for (let p = 0; p < n; p++) {
        const x0 = ax + (bx - ax) * p / n, y0 = ay + (by - ay) * p / n, x1 = ax + (bx - ax) * (p + 1) / n, y1 = ay + (by - ay) * (p + 1) / n;
        f(Math.floor(Math.min(x0, x1) / C), Math.floor(Math.min(y0, y1) / C), Math.floor(Math.max(x0, x1) / C), Math.floor(Math.max(y0, y1) / C));
      }
    };
    for (let t = 0; t < NT; t++) {
      if (!isFinite(AX[t] + AY[t] + BX[t] + BY[t])) continue;
      caja(t, (i0, j0, i1, j1) => { for (let ix = i0; ix <= i1; ix++) for (let iy = j0; iy <= j1; iy++) { const k = clave(ix, iy); let a = celdas.get(k); if (!a) celdas.set(k, (a = [])); if (a[a.length - 1] !== t) a.push(t); } });
    }
    const dPS = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let s = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; s = s < 0 ? 0 : s > 1 ? 1 : s; return Math.hypot(px - ax - s * dx, py - ay - s * dy); };
    const cruz = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    const dSS = (t, u) => {
      const ax = AX[t], ay = AY[t], bx = BX[t], by = BY[t], cx = AX[u], cy = AY[u], dx = BX[u], dy = BY[u];
      const o1 = cruz(ax, ay, bx, by, cx, cy), o2 = cruz(ax, ay, bx, by, dx, dy), o3 = cruz(cx, cy, dx, dy, ax, ay), o4 = cruz(cx, cy, dx, dy, bx, by);
      if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return 0;
      return Math.min(dPS(ax, ay, cx, cy, dx, dy), dPS(bx, by, cx, cy, dx, dy), dPS(cx, cy, ax, ay, bx, by), dPS(dx, dy, ax, ay, bx, by));
    };
    const visto = new Int32Array(NT).fill(-1);
    return cs.map((c, i) => {
      const n = c.pts.length, h = new Float64Array(n), t0 = ini[i];
      for (let k = 0; k < n; k++) {
        const t = t0 + k;
        let dG = Infinity, dB = Infinity;
        if (isFinite(AX[t] + AY[t] + BX[t] + BY[t])) {
          caja(t, (i0, j0, i1, j1) => {
            for (let ix = i0 - 1; ix <= i1 + 1; ix++) for (let iy = j0 - 1; iy <= j1 + 1; iy++) {
              const a = celdas.get(clave(ix, iy));
              if (a) for (const u of a) {
                if (visto[u] === t) continue;
                visto[u] = t;
                const du = DU[u];
                if (du === c.pieza) continue;
                const d = dSS(t, u);
                if (du === -1) { if (d < dB) dB = d; } else if (d < dG) dG = d;
              }
            }
          });
        } else dG = dB = 0;
        h[k] = Math.max(0, Math.min(tol, (dG - sep) / 2, dB - mg));
      }
      return h;
    });
  }

  const api = { ajustar, holguras, areaB };
  raiz.NestArcos = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
