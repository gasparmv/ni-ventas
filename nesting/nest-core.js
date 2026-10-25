// Motor de nesting de Neon Infinito (Gaspar 25-oct-2026): acomoda los contornos de las bases en placas (por defecto 2440 × 1220 mm)
// con separación entre piezas (6,5 mm: fresa de 6 mm), margen al borde (5 a 8 mm) y rotación en pasos (5°). Trabaja sobre una grilla (res mm por celda):
//  · cada pieza rotada se pasa a una "máscara" conservadora (filas de tramos de celdas que la cubren entera);
//  · lo ya colocado se guarda en la placa agrandado por la separación (un disco), así la pieza nueva solo tiene que no pisarlo;
//  · se coloca cada pieza donde su borde derecho quede lo más a la izquierda posible (y lo más abajo), probando todas las
//    rotaciones y las placas en orden; si no entra en ninguna, abre otra.
//  · varias corridas con distinto orden de piezas; gana la que usa menos placas y deja la última más corta.
// Sin dependencias: sirve en un Worker (importScripts) y en Node (require) para las pruebas.
(function (raiz) {
  'use strict';
  function bbox(pts) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; } return { x0, y0, x1, y1 }; }
  function area(pts) { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a / 2); }
  function rotar(pts, ang) { const c = Math.cos(ang), s = Math.sin(ang); return pts.map(([x, y]) => [x * c - y * s, x * s + y * c]); }
  // Cruces de la línea horizontal y con el polígono (par-impar), ordenados.
  function cruces(p, y, xs) {
    xs.length = 0;
    for (let i = 0, n = p.length, j = n - 1; i < n; j = i++) {
      const y1 = p[j][1], y2 = p[i][1];
      if ((y1 <= y && y < y2) || (y2 <= y && y < y1)) xs.push(p[j][0] + (y - y1) * (p[i][0] - p[j][0]) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    return xs;
  }
  // Une tramos [a,b] (enteros, inclusivos) que se tocan o se pisan; recorta a [lo, hi].
  function unir(tr, lo, hi) {
    if (!tr.length) return tr;
    tr.sort((u, v) => u[0] - v[0]);
    const out = [];
    for (const [a0, b0] of tr) {
      const a = Math.max(lo, a0), b = Math.min(hi, b0);
      if (a > b) continue;
      const u = out[out.length - 1];
      if (u && a <= u[1] + 1) { if (b > u[1]) u[1] = b; } else out.push([a, b]);
    }
    return out;
  }
  // Douglas-Peucker (tolerancia en mm): el contorno de Illustrator viene con cientos de puntos y para acomodar alcanza con
  // ~1/4 mm (la grilla ya deja margen de sobra).
  function simplificar(pts, tol) {
    const n = pts.length; if (n < 5) return pts.slice();
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const pila = [[0, n - 1]], t2 = tol * tol;
    while (pila.length) {
      const [i, j] = pila.pop(); const [ax, ay] = pts[i], [bx, by] = pts[j]; const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      let mx = -1, mi = -1;
      for (let k = i + 1; k < j; k++) {
        const [px, py] = pts[k];
        let d;
        if (!L) d = (px - ax) ** 2 + (py - ay) ** 2;
        else { const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)); d = (px - ax - u * dx) ** 2 + (py - ay - u * dy) ** 2; }
        if (d > mx) { mx = d; mi = k; }
      }
      if (mx > t2) { keep[mi] = 1; pila.push([i, mi], [mi, j]); }
    }
    const out = []; for (let k = 0; k < n; k++) if (keep[k]) out.push(pts[k]);
    return out.length >= 3 ? out : pts.slice();
  }
  // Máscara de la pieza rotada: en cada fila (franja de res mm) las celdas que la pieza toca, como tramos en un arreglo plano
  // (ini[j]..ini[j+1] en dat, de a pares). Lo que la pieza toca dentro de una franja = los tramos de adentro sobre la línea
  // de abajo de la franja + lo que recorre cada arista dentro de la franja (desde cualquier punto de la pieza se baja derecho
  // hasta esa línea sin salir, o se cruza el borde antes). Es exacta a nivel de celda: no agrega relleno de más.
  function mascara(poly, ang, res) {
    const p = rotar(poly, ang), b = bbox(p);
    const ox = b.x0 - res, oy = b.y0 - res;
    const w = Math.ceil((b.x1 - b.x0) / res) + 3, h = Math.ceil((b.y1 - b.y0) / res) + 3;
    const filas = new Array(h); for (let j = 0; j < h; j++) filas[j] = [];
    const cx = (x) => Math.floor((x - ox) / res);
    for (let i = 0, n = p.length, q = n - 1; i < n; q = i++) {
      let xa = p[q][0], ya = p[q][1], xb = p[i][0], yb = p[i][1];
      if (ya > yb) { const tx = xa, ty = ya; xa = xb; ya = yb; xb = tx; yb = ty; }
      const j0 = Math.floor((ya - oy) / res), j1 = Math.floor((yb - oy) / res);
      if (j0 === j1) { filas[j0].push([cx(Math.min(xa, xb)), cx(Math.max(xa, xb))]); continue; }
      const pend = (xb - xa) / (yb - ya);
      for (let j = j0; j <= j1; j++) {
        const x1 = xa + (Math.max(ya, oy + j * res) - ya) * pend, x2 = xa + (Math.min(yb, oy + (j + 1) * res) - ya) * pend;
        filas[j].push(x1 < x2 ? [cx(x1), cx(x2)] : [cx(x2), cx(x1)]);
      }
    }
    // Tramos de adentro sobre la línea de abajo de cada franja (barrido con aristas activas, ordenadas por su y más baja).
    const ar = [], xs = [];
    for (let i = 0, n = p.length, q = n - 1; i < n; q = i++) { const a = p[q], c = p[i]; if (a[1] !== c[1]) ar.push(a[1] < c[1] ? [a[1], c[1], a[0], c[0]] : [c[1], a[1], c[0], a[0]]); }
    ar.sort((u, v) => u[0] - v[0]);
    let sig = 0; const act = [];
    for (let j = 0; j < h; j++) {
      const y = oy + j * res + res * 1e-6;
      while (sig < ar.length && ar[sig][0] <= y) act.push(ar[sig++]);
      xs.length = 0;
      for (let z = act.length - 1; z >= 0; z--) { const e = act[z]; if (e[1] <= y) { act.splice(z, 1); continue; } xs.push(e[2] + (y - e[0]) * (e[3] - e[2]) / (e[1] - e[0])); }
      xs.sort((u, v) => u - v);
      for (let k = 0; k + 1 < xs.length; k += 2) filas[j].push([cx(xs[k]), cx(xs[k + 1])]);
    }
    const ini = new Int32Array(h + 1);
    let total = 0, c0 = Infinity, c1 = -Infinity, r0 = -1, r1 = -1;
    for (let j = 0; j < h; j++) {
      const f = filas[j] = unir(filas[j], 0, w - 1);
      total += f.length;
      if (f.length) { if (r0 < 0) r0 = j; r1 = j; if (f[0][0] < c0) c0 = f[0][0]; if (f[f.length - 1][1] > c1) c1 = f[f.length - 1][1]; }
    }
    const dat = new Int32Array(total * 2);
    let k = 0;
    for (let j = 0; j < h; j++) { ini[j] = k; for (const [a, bb] of filas[j]) { dat[k++] = a; dat[k++] = bb; } }
    ini[h] = k;
    let celdas = 0; for (let z = 0; z < k; z += 2) celdas += dat[z + 1] - dat[z] + 1;
    return { w, h, ini, dat, ox, oy, ang, celdas, c0, c1, r0, r1 };
  }
  // Separación en la grilla: alrededor de cada celda ocupada se bloquean las celdas donde algún punto podría quedar a menos de
  // S celdas (entre dos celdas el hueco real mínimo es |dx|-1 y |dy|-1 celdas). dx[d + Rv] = cuántas celdas se bloquean a
  // cada lado en la fila d (-1: ninguna).
  function disco(S) {
    const Rv = Math.ceil(S), dx = [];
    for (let d = -Rv; d <= Rv; d++) { const g = Math.max(0, Math.abs(d) - 1); dx.push(g >= S ? -1 : Math.ceil(Math.sqrt(S * S - g * g) + 1) - 1); }
    return { Rv, dx };
  }
  function nuevaHoja(W, H) { const filas = new Array(H); for (let j = 0; j < H; j++) filas[j] = []; return { W, H, filas, usado: 0, ocupadas: 0 }; }
  // Primer tramo ocupado de la fila cuyo fin es >= x (los tramos están ordenados y no se pisan).
  function primeroConFin(occ, x) { let lo = 0, hi = occ.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (occ[mid][1] < x) lo = mid + 1; else hi = mid; } return lo; }
  // La x más a la izquierda (>= x0) donde la máscara entra en la fila gy sin pisar nada; null si pasa de xlim.
  function masIzq(hoja, m, gy, x0, xlim) {
    let x = x0;
    const ini = m.ini, dat = m.dat, filas = hoja.filas;
    for (let vuelta = 0; vuelta < 100000; vuelta++) {
      let movido = false;
      for (let i = m.r0; i <= m.r1; i++) {
        const occ = filas[gy + i];
        if (!occ.length) continue;
        for (let k = ini[i]; k < ini[i + 1]; k += 2) {
          const a = dat[k], b = dat[k + 1];
          const q = primeroConFin(occ, x + a);
          if (q < occ.length && occ[q][0] <= x + b) { x = occ[q][1] + 1 - a; movido = true; if (x > xlim) return null; }
        }
      }
      if (!movido) return x;
    }
    return null;
  }
  // Mejor lugar para la máscara en la hoja: borde derecho (gx + c1) mínimo, después gy mínimo. maxP = puntaje a superar.
  // Lo ocupado de la máscara (columnas c0..c1, filas r0..r1) tiene que quedar a M celdas o más de cada borde de la placa.
  function buscar(hoja, m, M, maxP, paso) {
    const gx0 = M - m.c0, gxmax = hoja.W - 1 - M - m.c1, gy0 = M - m.r0, gymax = hoja.H - 1 - M - m.r1;
    if (gxmax < gx0 || gymax < gy0) return null;
    paso = paso || 1;
    let mejor = null;
    let xlim = Math.min(gxmax, maxP == null ? gxmax : maxP - m.c1 - 1);
    const probar = (gy) => { if (xlim < gx0) return; const gx = masIzq(hoja, m, gy, gx0, xlim); if (gx !== null && (!mejor || gx < mejor.gx || (gx === mejor.gx && gy < mejor.gy))) { mejor = { gx, gy, p: gx + m.c1 }; xlim = gx - 1; } };
    for (let gy = gy0; gy <= gymax; gy += paso) { probar(gy); if (mejor && mejor.gx === gx0) break; }
    if (paso > 1) {
      // Si no entró en ninguna fila de la pasada gruesa, se prueban todas (un hueco justo puede caer entre dos filas).
      if (!mejor) { for (let gy = gy0; gy <= gymax; gy++) if ((gy - gy0) % paso) { probar(gy); if (mejor && mejor.gx === gx0) break; } }
      else { const c = mejor.gy; xlim = mejor.gx; for (let gy = Math.max(gy0, c - paso + 1); gy <= Math.min(gymax, c + paso - 1); gy++) if (gy !== c) probar(gy); }
    }
    return mejor;
  }
  // Coloca la máscara en (gx, gy) agrandada por la separación (las celdas que bloquea el disco).
  function colocar(hoja, m, gx, gy, dsc) {
    const R = dsc.Rv, dx = dsc.dx;
    const nuevos = new Map();
    for (let i = m.r0; i <= m.r1; i++) {
      for (let k = m.ini[i]; k < m.ini[i + 1]; k += 2) {
        const a = m.dat[k] + gx, b = m.dat[k + 1] + gx;
        for (let d = -R; d <= R; d++) {
          const fy = gy + i + d; if (fy < 0 || fy >= hoja.H) continue;
          const e = dx[d + R]; if (e < 0) continue;
          (nuevos.get(fy) || nuevos.set(fy, []).get(fy)).push([a - e, b + e]);
        }
      }
    }
    for (const [fy, tr] of nuevos) { const antes = hoja.filas[fy]; let c0 = 0; for (const [a, b] of antes) c0 += b - a + 1; const f = unir(antes.concat(tr), 0, hoja.W - 1); let c1 = 0; for (const [a, b] of f) c1 += b - a + 1; hoja.filas[fy] = f; hoja.ocupadas += c1 - c0; }
    hoja.usado = Math.max(hoja.usado, gx + m.c1 + 1);
  }
  function angulos(paso) { const out = []; for (let g = 0; g < 360; g += paso) out.push(g * Math.PI / 180); return out; }
  // Una corrida completa con un orden de piezas. cache: Map de máscaras (pieza|ángulo).
  function corrida(piezas, orden, cfg, cache) {
    const res = cfg.res, W = Math.floor(cfg.largo / res), H = Math.floor(cfg.ancho / res);
    // El contorno simplificado se aparta del real hasta tol mm (0,05): la separación suma 2·tol (una por pieza) y el margen,
    // tol. Con la fresa de 6 mm la separación pedida es 6,5 mm (Gaspar 25-oct) y el margen al borde, entre 5 y 8 mm.
    const tol = cfg.tol || 0.05;
    const M = Math.ceil((cfg.margen + tol) / res - 1e-9), dsc = disco((cfg.sep + 2 * tol) / res + (cfg.holgura || 0));
    const angs = angulos(cfg.paso);
    const rapido = cfg.rapido !== false, paso3 = Math.max(1, Math.round(15 / cfg.paso)); // rotaciones gruesas cada ~15°
    const hojas = [], coloc = [], sinLugar = [];
    for (const idx of orden) {
      const pz = piezas[idx];
      let elegido = null;
      for (let s = 0; s <= hojas.length; s++) {
        const hoja = s < hojas.length ? hojas[s] : nuevaHoja(W, H);
        if (s < hojas.length && (W * H - hoja.ocupadas) < pz.celdas) continue; // no le queda lugar ni contando todo lo libre
        let mejor = null;
        const vistos = new Set(), puntos = [];
        const probarAng = (a) => {
          a = ((a % angs.length) + angs.length) % angs.length;
          if (vistos.has(a)) return; vistos.add(a);
          const clave = idx + '|' + a;
          let m = cache.get(clave);
          if (!m) { m = mascara(pz.simple || (pz.simple = simplificar(pz.poly, tol)), angs[a], res); cache.set(clave, m); if (!pz.celdas || m.celdas < pz.celdas) pz.celdas = m.celdas; }
          const r = buscar(hoja, m, M, mejor ? mejor.p : null, rapido ? 3 : 1);
          if (r) puntos.push([r.p, a]);
          if (r && (!mejor || r.p < mejor.p || (r.p === mejor.p && r.gy < mejor.gy))) mejor = { gx: r.gx, gy: r.gy, p: r.p, m, a };
        };
        if (!rapido || paso3 <= 1) { for (let a = 0; a < angs.length; a++) probarAng(a); }
        else {
          for (let a = 0; a < angs.length; a += paso3) probarAng(a);
          // Afinar alrededor de las dos mejores rotaciones gruesas (los vecinos de a un paso, 5°).
          const top = puntos.slice().sort((u, v) => u[0] - v[0]).slice(0, 2).map(x => x[1]);
          for (const a0 of top) for (let d = 1; d < paso3; d++) { probarAng(a0 + d); probarAng(a0 - d); }
        }
        if (mejor) {
          if (s === hojas.length) hojas.push(hoja);
          colocar(hoja, mejor.m, mejor.gx, mejor.gy, dsc);
          elegido = { hoja: s, ...mejor };
          break;
        }
        if (s === hojas.length) break; // no entra ni en una placa vacía
      }
      if (elegido) coloc.push({ id: pz.id, hoja: elegido.hoja, grados: elegido.a * cfg.paso, dx: elegido.gx * res - elegido.m.ox, dy: elegido.gy * res - elegido.m.oy });
      else sinLugar.push(pz.id);
    }
    const ult = hojas.length ? hojas[hojas.length - 1].usado * res : 0;
    return { coloc, sinLugar, hojas: hojas.length, ultimoLargo: ult, puntaje: sinLugar.length * 1e9 + hojas.length * 1e6 + ult };
  }
  // Órdenes para probar: por área, por lado mayor, por ancho, y después variantes al azar del mejor.
  function rng(sem) { let s = sem >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  function ordenesBase(piezas) {
    const idx = piezas.map((_, i) => i);
    const lado = p => { const b = bbox(p.poly); return Math.max(b.x1 - b.x0, b.y1 - b.y0); };
    return [
      idx.slice().sort((a, b) => piezas[b].area - piezas[a].area),
      idx.slice().sort((a, b) => lado(piezas[b]) - lado(piezas[a])),
    ];
  }
  function variar(orden, azar) {
    const o = orden.slice(), n = o.length; if (n < 2) return o;
    const k = 1 + Math.floor(azar() * Math.min(4, n));
    for (let t = 0; t < k; t++) { const i = Math.floor(azar() * n), j = Math.min(n - 1, Math.max(0, i + Math.floor((azar() - 0.5) * 6))); const x = o[i]; o[i] = o[j]; o[j] = x; }
    return o;
  }
  raiz.NestCore = { bbox, area, rotar, simplificar, mascara, disco, corrida, ordenesBase, variar, rng, angulos };
  if (typeof module !== 'undefined' && module.exports) module.exports = raiz.NestCore;
})(typeof self !== 'undefined' ? self : this);
