// Motor de nesting de Neon Infinito (Gaspar 25-oct-2026): acomoda los contornos de las bases en placas (por defecto 2440 × 1220 mm)
// con separación entre piezas (6,5 mm: fresa de 6 mm), margen al borde (5 a 8 mm) y rotación en pasos (5°). Trabaja sobre una grilla (res mm por celda):
//  · cada pieza rotada se pasa a una "máscara" conservadora (filas de tramos de celdas que la cubren entera);
//  · lo ya colocado se guarda en la placa agrandado por la separación (un disco), así la pieza nueva solo tiene que no pisarlo;
//  · se coloca cada pieza donde su borde derecho quede lo más a la izquierda posible (y lo más abajo), probando todas las
//    rotaciones y las placas en orden; si no entra en ninguna, abre otra.
//  · varias corridas con distinto orden de piezas; gana la que usa menos placas y deja la última más corta.
//  · recortes del taller (cfg.recortes, con cualquier forma): se llenan primero y después se abren placas enteras.
//  · pieza dentro de pieza (Gaspar 26-oct): si la pieza trae huecos (pz.huecos, ya simplificados), su máscara los deja libres
//    y la búsqueda mete ahí otras piezas (adentro de una O), a la separación del borde del hueco como entre piezas.
//  · comparando con Nest&Cut (Gaspar 26-oct, 55 % contra 49 % en el mismo trabajo):
//    - al final se rehace sola la última placa (sus piezas no dependen del resto) con muchas vueltas baratas (mejorarUltima);
//    - y se compacta con la geometría exacta (compactar): cada pieza se corre a la izquierda y abajo hasta quedar a la
//      separación justa de las vecinas, sin que la grilla deje aire de más.
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
  // huecos (opcional, Gaspar 26-oct): cortes de adentro de la pieza que quedan libres para meter otras piezas (adentro de una
  // O, por ejemplo). Se toman par-impar con el contorno: lo de adentro de un hueco no es pieza, y las celdas que toca su borde
  // sí (al colocar, el disco de la separación también agranda el borde del hueco hacia adentro). Sin huecos, como siempre.
  function mascara(poly, ang, res, huecos) {
    const p = rotar(poly, ang), anillos = [p];
    if (huecos) for (const hu of huecos) anillos.push(rotar(hu, ang));
    const b = bbox(anillos.length > 1 ? [].concat(...anillos) : p);
    const ox = b.x0 - res, oy = b.y0 - res;
    const w = Math.ceil((b.x1 - b.x0) / res) + 3, h = Math.ceil((b.y1 - b.y0) / res) + 3;
    const filas = new Array(h); for (let j = 0; j < h; j++) filas[j] = [];
    const cx = (x) => Math.floor((x - ox) / res);
    for (const p of anillos) for (let i = 0, n = p.length, q = n - 1; i < n; q = i++) {
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
    // Tramos de adentro sobre la línea de abajo de cada franja (barrido con aristas activas, ordenadas por su y más baja;
    // con huecos, las aristas de todos los anillos y los cruces de a pares).
    const ar = [], xs = [];
    for (const p of anillos) for (let i = 0, n = p.length, q = n - 1; i < n; q = i++) { const a = p[q], c = p[i]; if (a[1] !== c[1]) ar.push(a[1] < c[1] ? [a[1], c[1], a[0], c[0]] : [c[1], a[1], c[0], a[0]]); }
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
    // Los dos tramos más largos (en filas distintas: i1 e i2, desde a1 y a2): en esas filas de la placa tiene que haber un
    // hueco libre así de largo (buscar descarta filas y masIzq salta directo al primero que sirve).
    let l1 = 0, i1 = -1, a1 = 0, l2 = 0, i2 = -1, a2 = 0;
    for (let j = 0; j < h; j++) {
      let lm = 0, am = 0;
      for (let z = ini[j]; z < ini[j + 1]; z += 2) if (dat[z + 1] - dat[z] + 1 > lm) { lm = dat[z + 1] - dat[z] + 1; am = dat[z]; }
      if (lm > l1) { l2 = l1; i2 = i1; a2 = a1; l1 = lm; i1 = j; a1 = am; } else if (lm > l2) { l2 = lm; i2 = j; a2 = am; }
    }
    return { w, h, ini, dat, ox, oy, ang, celdas, c0, c1, r0, r1, l1, i1, a1, l2, i2, a2 };
  }
  // Separación en la grilla: alrededor de cada celda ocupada se bloquean las celdas donde algún punto podría quedar a menos de
  // S celdas (entre dos celdas el hueco real mínimo es |dx|-1 y |dy|-1 celdas). dx[d + Rv] = cuántas celdas se bloquean a
  // cada lado en la fila d (-1: ninguna).
  function disco(S) {
    const Rv = Math.ceil(S), dx = [];
    for (let d = -Rv; d <= Rv; d++) { const g = Math.max(0, Math.abs(d) - 1); dx.push(g >= S ? -1 : Math.ceil(Math.sqrt(S * S - g * g) + 1) - 1); }
    return { Rv, dx };
  }
  // libre[j] = el hueco libre más largo de la fila j (para descartar filas donde la pieza no entra ni mirando un solo tramo).
  // run[j] = la fila j celda por celda (null si está vacía), para ver en un paso si un tramo entra: si la celda x está libre,
  // cuántas libres siguen desde ahí (> 0); si está ocupada, -(última ocupada de ese tramo + 1). Las filas de un recorte se
  // comparten con su copia guardada hasta que se escriben (propia[j]).
  function nuevaHoja(W, H) { const filas = new Array(H); for (let j = 0; j < H; j++) filas[j] = []; return { W, H, filas, usado: 0, ocupadas: 0, libre: new Int32Array(H).fill(W), run: new Array(H).fill(null), propia: new Uint8Array(H) }; }
  function libreMax(f, W) { let x = 0, m = 0; for (const [a, b] of f) { if (a - x > m) m = a - x; x = b + 1; } return Math.max(m, W - x); }
  function filaRun(hoja, j) {
    const f = hoja.filas[j], W = hoja.W;
    if (!f.length) { hoja.run[j] = null; return; }
    let v = hoja.run[j];
    if (!v || !hoja.propia[j]) { v = hoja.run[j] = W < 32000 ? new Int16Array(W) : new Int32Array(W); hoja.propia[j] = 1; }
    let x = 0;
    for (const [a, b] of f) { for (let c = x; c < a; c++) v[c] = a - c; v.fill(-(b + 1), a, b + 1); x = b + 1; }
    for (let c = x; c < W; c++) v[c] = W - c;
  }
  function rehacerLibre(hoja) {
    hoja.libre = new Int32Array(hoja.H); hoja.run = new Array(hoja.H).fill(null); hoja.propia = new Uint8Array(hoja.H);
    for (let j = 0; j < hoja.H; j++) { hoja.libre[j] = libreMax(hoja.filas[j], hoja.W); filaRun(hoja, j); }
  }
  // Tramos ordenados y sin pisarse: A menos B, y lo que falta de [0, W-1].
  function restar(A, B) {
    const out = []; let k = 0;
    for (const [a0, b0] of A) {
      let a = a0;
      while (k < B.length && B[k][1] < a) k++;
      for (let q = k; q < B.length && B[q][0] <= b0; q++) { if (B[q][0] > a) out.push([a, B[q][0] - 1]); a = Math.max(a, B[q][1] + 1); }
      if (a <= b0) out.push([a, b0]);
    }
    return out;
  }
  function complemento(sp, W) { const out = []; let x = 0; for (const [a, b] of sp) { if (a > x) out.push([x, a - 1]); x = b + 1; } if (x <= W - 1) out.push([x, W - 1]); return out; }
  // Lámina con forma (un recorte del taller): rings = contornos en mm con la esquina de su caja en (0, 0), par-impar (el borde
  // y sus huecos). Queda ocupado todo lo que no es lámina entera: las celdas de afuera y las que toca el borde. Con dsc, eso
  // se agranda por el margen (las piezas quedan a margen mm o más del borde del recorte).
  function hojaLamina(rec, res, dsc) {
    const W = Math.ceil(rec.largo / res) + 1, H = Math.ceil(rec.ancho / res) + 1;
    const borde = new Array(H); for (let j = 0; j < H; j++) borde[j] = [];
    const cx = (x) => Math.floor(x / res), fila = (y) => Math.min(H - 1, Math.max(0, Math.floor(y / res)));
    const ar = [];
    for (const p of rec.rings) for (let i = 0, n = p.length, q = n - 1; i < n; q = i++) {
      let xa = p[q][0], ya = p[q][1], xb = p[i][0], yb = p[i][1];
      if (ya > yb) { const tx = xa, ty = ya; xa = xb; ya = yb; xb = tx; yb = ty; }
      const j0 = fila(ya), j1 = fila(yb);
      if (j0 === j1) borde[j0].push([cx(Math.min(xa, xb)), cx(Math.max(xa, xb))]);
      else {
        const pend = (xb - xa) / (yb - ya);
        for (let j = j0; j <= j1; j++) { const x1 = xa + (Math.max(ya, j * res) - ya) * pend, x2 = xa + (Math.min(yb, (j + 1) * res) - ya) * pend; borde[j].push(x1 < x2 ? [cx(x1), cx(x2)] : [cx(x2), cx(x1)]); }
      }
      if (ya !== yb) ar.push([ya, yb, xa, xb]);
    }
    ar.sort((u, v) => u[0] - v[0]);
    const hoja = nuevaHoja(W, H), act = [], xs = [];
    let sig = 0, total = 0;
    const afuera = new Array(H);
    for (let j = 0; j < H; j++) {
      const y = j * res + res * 1e-6;
      while (sig < ar.length && ar[sig][0] <= y) act.push(ar[sig++]);
      xs.length = 0;
      for (let z = act.length - 1; z >= 0; z--) { const e = act[z]; if (e[1] <= y) { act.splice(z, 1); continue; } xs.push(e[2] + (y - e[0]) * (e[3] - e[2]) / (e[1] - e[0])); }
      xs.sort((u, v) => u - v);
      const dentro = [];
      for (let k = 0; k + 1 < xs.length; k += 2) { const a = Math.ceil(xs[k] / res - 1e-9), b = Math.floor(xs[k + 1] / res + 1e-9) - 1; if (a <= b) dentro.push([a, b]); }
      afuera[j] = complemento(restar(unir(dentro, 0, W - 1), unir(borde[j], 0, W - 1)), W);
      total += afuera[j].length;
    }
    if (!dsc) { for (let j = 0; j < H; j++) { hoja.filas[j] = afuera[j]; for (const [a, b] of afuera[j]) hoja.ocupadas += b - a + 1; } rehacerLibre(hoja); return hoja; }
    const ini = new Int32Array(H + 1), dat = new Int32Array(total * 2);
    let k = 0;
    for (let j = 0; j < H; j++) { ini[j] = k; for (const [a, b] of afuera[j]) { dat[k++] = a; dat[k++] = b; } }
    ini[H] = k;
    colocar(hoja, { h: H, ini, dat, r0: 0, r1: H - 1, c1: -1 }, 0, 0, dsc);
    hoja.usado = 0;
    rehacerLibre(hoja);
    return hoja;
  }
  // La x más a la izquierda (>= x0) donde la máscara entra en la fila gy sin pisar nada; null si pasa de xlim.
  // Antes de cada pasada salta, en las filas de los dos tramos más largos, al primer hueco libre donde ese tramo entra entero
  // (cualquier x que sirva lo cumple): da la misma x que ir de obstáculo en obstáculo, en muchas menos pasadas.
  // Con hoja.run cada tramo se mira en uno o dos pasos (antes, búsqueda binaria en los tramos ocupados de la fila).
  function masIzq(hoja, m, gy, x0, xlim) {
    let x = x0;
    const ini = m.ini, dat = m.dat, run = hoja.run;
    const saltar = (v, a, len) => { while (x <= xlim) { const c = x + a; let t = v[c]; if (t >= len) return; if (t > 0) t = v[c + t]; x = -t - a; } };
    for (let vuelta = 0; vuelta < 100000; vuelta++) {
      let movido = false;
      if (m.i1 >= 0) {
        const v1 = run[gy + m.i1]; if (v1) saltar(v1, m.a1, m.l1);
        if (m.i2 >= 0 && x <= xlim) { const v2 = run[gy + m.i2]; if (v2) saltar(v2, m.a2, m.l2); }
        if (x > xlim) return null;
      }
      for (let i = m.r0; i <= m.r1; i++) {
        const v = run[gy + i];
        if (!v) continue;
        for (let k = ini[i]; k < ini[i + 1]; k += 2) {
          const a = dat[k], c = x + a;
          let t = v[c];
          if (t > dat[k + 1] - a) continue; // entra el tramo entero
          if (t > 0) t = v[c + t]; // el primer obstáculo, más adelante dentro del tramo
          x = -t - a; movido = true; if (x > xlim) return null; // justo después de que termina
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
    const lib = hoja.libre, podar = lib && m.i1 >= 0;
    const probar = (gy) => { if (xlim < gx0) return; if (podar && (lib[gy + m.i1] < m.l1 || (m.i2 >= 0 && lib[gy + m.i2] < m.l2))) return; const gx = masIzq(hoja, m, gy, gx0, xlim); if (gx !== null && (!mejor || gx < mejor.gx || (gx === mejor.gx && gy < mejor.gy))) { mejor = { gx, gy, p: gx + m.c1 }; xlim = gx - 1; } };
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
    for (const [fy, tr] of nuevos) { const antes = hoja.filas[fy]; let c0 = 0; for (const [a, b] of antes) c0 += b - a + 1; const f = unir(antes.concat(tr), 0, hoja.W - 1); let c1 = 0; for (const [a, b] of f) c1 += b - a + 1; hoja.filas[fy] = f; hoja.ocupadas += c1 - c0; if (hoja.libre) hoja.libre[fy] = libreMax(f, hoja.W); if (hoja.run) filaRun(hoja, fy); }
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
    // Los recortes del taller van primero (en el orden que vienen); después, placas enteras de largo × ancho si hacen falta
    // (cfg.soloRecortes: no se abren placas y lo que no entra queda sin lugar).
    const recs = cfg.recortes || [], dscM = recs.length ? disco((cfg.margen + tol) / res) : null;
    const hojas = recs.map((rc, k) => {
      const clave = 'lamina|' + k;
      let base = cache.get(clave);
      if (!base) { base = hojaLamina(rc, res, dscM); cache.set(clave, base); }
      return { W: base.W, H: base.H, filas: base.filas.slice(), usado: 0, ocupadas: base.ocupadas, libre: base.libre.slice(), run: base.run.slice(), propia: new Uint8Array(base.H) };
    });
    const R = hojas.length, coloc = [], sinLugar = [];
    // Piezas repetidas (la misma letra varias veces): si una no entró en una lámina, la copia tampoco va a entrar (la lámina
    // solo se llena más y la búsqueda es la misma), así que no se vuelve a probar. Va por una firma de la forma.
    const noEntra = new Set();
    for (const idx of orden) {
      const pz = piezas[idx];
      if (!pz.simple) pz.simple = simplificar(pz.poly, tol);
      if (pz.firma == null) { const b = bbox(pz.simple); pz.firma = [pz.simple.length, (pz.huecos || []).length, Math.round(area(pz.simple) * 10), Math.round((b.x1 - b.x0) * 100), Math.round((b.y1 - b.y0) * 100)].join(':'); }
      let elegido = null;
      for (let s = 0; s <= hojas.length; s++) {
        if (s === hojas.length && cfg.soloRecortes) break;
        const hoja = s < hojas.length ? hojas[s] : nuevaHoja(W, H);
        if (s < hojas.length && (hoja.W * hoja.H - hoja.ocupadas) < pz.celdas) continue; // no le queda lugar ni contando todo lo libre
        if (s < hojas.length && noEntra.has(pz.firma + '|' + s)) continue;
        let mejor = null;
        const masc = (a) => {
          // La clave va por el id de la pieza (no por su lugar en el arreglo): mejorarUltima corre con un subconjunto.
          const clave = 'p' + pz.id + '|' + a;
          let m = cache.get(clave);
          if (!m) { m = mascara(pz.simple, angs[a], res, pz.huecos); cache.set(clave, m); if (!pz.celdas || m.celdas < pz.celdas) pz.celdas = m.celdas; }
          return m;
        };
        const vistos = new Set(), puntos = [];
        const probarAng = (a) => {
          a = ((a % angs.length) + angs.length) % angs.length;
          if (vistos.has(a)) return; vistos.add(a);
          const m = masc(a);
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
        noEntra.add(pz.firma + '|' + s);
      }
      if (elegido) coloc.push({ id: pz.id, hoja: elegido.hoja, grados: elegido.a * cfg.paso, dx: elegido.gx * res - elegido.m.ox, dy: elegido.gy * res - elegido.m.oy });
      else sinLugar.push(pz.id);
    }
    // Puntaje: menos piezas sin lugar, menos placas enteras y la última más corta; si alcanzó con recortes, usar menos.
    const nuevas = hojas.length - R, usadas = [];
    hojas.forEach((h, k) => { if (k >= R || h.usado > 0) usadas.push(k); });
    const recUsados = usadas.filter((k) => k < R);
    const ult = nuevas ? hojas[hojas.length - 1].usado * res : 0, ultRec = recUsados.length ? hojas[recUsados[recUsados.length - 1]].usado * res : 0;
    return { coloc, sinLugar, hojas: hojas.length, nRec: R, nuevas, usadas, ultimoLargo: ult, puntaje: sinLugar.length * 1e9 + nuevas * 1e6 + (nuevas ? ult : recUsados.length * 1e4 + ultRec) };
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
  // Fase 2 (Gaspar 26-oct): rehace sola la última placa entera. Sus piezas no dependen del resto (las otras láminas quedan
  // como están), así que cada vuelta con esas piezas solas cuesta una fracción de una corrida completa: se prueban órdenes
  // nuevos y gana el que deja la placa más corta. Nunca empeora: si no encuentra nada mejor, devuelve r: null. r.orden (el de
  // la corrida) se conserva para "Seguir". Corta a la hora fin, tras maxVueltas o tras 300 vueltas seguidas sin mejorar.
  // alVuelta (opcional) se llama en cada vuelta (para contarlas en la página).
  function mejorarUltima(piezas, r, cfg, cache, azar, fin, maxVueltas, alVuelta) {
    if (!r || !r.nuevas || r.sinLugar.length) return { r: null, vueltas: 0 };
    const ult = r.usadas[r.usadas.length - 1], ids = new Set();
    for (const c of r.coloc) if (c.hoja === ult) ids.add(c.id);
    const sub = piezas.filter((p) => ids.has(p.id));
    if (sub.length < 2) return { r: null, vueltas: 0 };
    const cfg2 = { ...cfg, recortes: [], soloRecortes: false }, pos = new Map(sub.map((p, i) => [p.id, i]));
    const bases = ordenesBase(sub);
    if (r.orden) bases.unshift(r.orden.filter((i) => ids.has(piezas[i].id)).map((i) => pos.get(piezas[i].id))); // da la misma placa
    let mejor = null, k = 0, ultimaMejora = 0;
    const probar = (ord) => {
      const q = corrida(sub, ord, cfg2, cache); k++; if (alVuelta) alVuelta();
      if (q.nuevas === 1 && !q.sinLugar.length && (!mejor || q.ultimoLargo < mejor.q.ultimoLargo)) { mejor = { q, ord }; ultimaMejora = k; }
    };
    for (const b of bases) { if (Date.now() >= fin) break; probar(b); }
    while (mejor && Date.now() < fin && k < (maxVueltas || Infinity) && k - ultimaMejora < 300) probar(variar(mejor.ord, azar));
    if (!mejor || mejor.q.ultimoLargo >= r.ultimoLargo) return { r: null, vueltas: k };
    const coloc = r.coloc.filter((c) => c.hoja !== ult).concat(mejor.q.coloc.map((c) => ({ ...c, hoja: ult })));
    return { r: { ...r, coloc, ultimoLargo: mejor.q.ultimoLargo, puntaje: r.puntaje - r.ultimoLargo + mejor.q.ultimoLargo }, vueltas: k };
  }
  // Primer contacto de un punto que avanza (p + t·u, t >= 0, u unitario) con la "cápsula" de radio rr alrededor del segmento ab
  // (los puntos a menos de rr de él): el t más chico, o Infinity si no la toca.
  function contacto(px, py, ux, uy, ax, ay, bx, by, rr) {
    let t = Infinity;
    for (let e = 0; e < 2; e++) {
      const wx = px - (e ? bx : ax), wy = py - (e ? by : ay), B = ux * wx + uy * wy, C = wx * wx + wy * wy - rr * rr;
      if (C <= 0) { if (B < 0) return 0; continue; } // ya en el borde: solo cuenta si se acerca
      const D = B * B - C;
      if (B < 0 && D >= 0) { const s = -B - Math.sqrt(D); if (s < t) t = s; }
    }
    const vx = bx - ax, vy = by - ay, L = Math.sqrt(vx * vx + vy * vy);
    if (L > 1e-12) {
      const nx = -vy / L, ny = vx / L, dn = nx * (px - ax) + ny * (py - ay), un = nx * ux + ny * uy;
      let s = -1;
      if (dn >= rr - 1e-9 && un < 0) s = (rr - dn) / un;
      else if (dn <= -rr + 1e-9 && un > 0) s = (-rr - dn) / un;
      else if (Math.abs(dn) < rr - 1e-9 && dn * un < 0) { const w0 = ((px - ax) * vx + (py - ay) * vy) / L; if (w0 >= 0 && w0 <= L) return 0; } // ya adentro (no debería pasar): no acercarse más
      if (s >= -1e-9) { if (s < 0) s = 0; const w = ((px + s * ux - ax) * vx + (py + s * uy - ay) * vy) / L; if (w >= 0 && w <= L && s < t) t = s; }
    }
    return t;
  }
  // Compactación exacta (Gaspar 26-oct): la grilla deja entre pieza y pieza 1 a 3 mm más de lo pedido. Con la colocación ya
  // hecha, cada pieza se desliza sin girar a la izquierda y después abajo (varias pasadas) hasta tocar la separación justa de
  // lo que tiene alrededor o el margen del borde. Se mide con los contornos simplificados y sus huecos libres, como el motor:
  // entre piezas sep + 2·tol, al borde margen + tol. El avance es el primer contacto exacto (cada vértice contra las cápsulas
  // de los segmentos de la otra pieza, y al revés), así que puede resbalar a lo largo de una vecina y nunca la cruza ni se le
  // acerca de más. Solo en placas enteras (un recorte con forma no tiene el borde recto); la última placa primero. Corta a la
  // hora fin y lo hecho hasta ahí vale igual. Devuelve un resultado nuevo (r no se toca).
  function compactar(piezas, r, cfg, fin) {
    const tol = cfg.tol || 0.05, req = cfg.sep + 2 * tol + 1e-3, marg = cfg.margen + tol + 1e-3, BK = 8;
    const porId = new Map(piezas.map((p) => [p.id, p]));
    const out = { ...r, coloc: r.coloc.map((c) => ({ ...c })) };
    const nRec = r.nRec || 0, laminas = r.usadas.filter((s) => s >= nRec).reverse();
    let movido = 0;
    for (const s of laminas) {
      // Cada pieza: segmentos y vértices girados (sin trasladar), y los segmentos repartidos en franjas de BK mm por y y por x
      // (agrandadas por req) para buscar rápido los que puede tocar un punto que avanza en horizontal o en vertical.
      const gs = out.coloc.filter((c) => c.hoja === s).map((c) => {
        const pz = porId.get(c.id), t = c.grados * Math.PI / 180;
        const anillos = [pz.simple || simplificar(pz.poly, tol)].concat(pz.huecos || []).map((q) => rotar(q, t));
        let n = 0; for (const q of anillos) n += q.length;
        const seg = new Float64Array(n * 4), ver = new Float64Array(n * 2);
        let k = 0, v = 0;
        for (const q of anillos) for (let i = 0, j = q.length - 1; i < q.length; j = i++) { seg[k++] = q[j][0]; seg[k++] = q[j][1]; seg[k++] = q[i][0]; seg[k++] = q[i][1]; ver[v++] = q[i][0]; ver[v++] = q[i][1]; }
        const bb = bbox(anillos[0]);
        const franjas = (eje) => {
          const lo = eje ? bb.y0 : bb.x0, nb = Math.floor(((eje ? bb.y1 : bb.x1) - lo + 2 * req) / BK) + 1, f = new Array(nb);
          for (let b = 0; b < nb; b++) f[b] = [];
          for (let z = 0; z < n; z++) {
            const a = seg[z * 4 + eje], b2 = seg[z * 4 + 2 + eje];
            const b0 = Math.floor((Math.min(a, b2) - lo) / BK), b1 = Math.floor((Math.max(a, b2) - lo + 2 * req) / BK);
            for (let b = Math.max(0, b0); b <= Math.min(nb - 1, b1); b++) f[b].push(z);
          }
          return { lo: lo - req, f };
        };
        return { c, seg, ver, n, bb, fy: franjas(1), fx: franjas(0) };
      });
      // Cuánto puede avanzar A en la dirección (ux, uy) hasta tocar a B (a lo sumo lim).
      const avance = (A, B, ux, uy, lim) => {
        let t = lim;
        const eje = ux ? 1 : 0; // al moverse en x, importan los segmentos de la misma franja de y (y al revés)
        for (const [P, Q, sx, sy] of [[A, B, ux, uy], [B, A, -ux, -uy]]) {
          const ox = P.c.dx - Q.c.dx, oy = P.c.dy - Q.c.dy, fr = eje ? Q.fy : Q.fx;
          for (let v = 0; v < P.n; v++) {
            const px = P.ver[v * 2] + ox, py = P.ver[v * 2 + 1] + oy, b = Math.floor(((eje ? py : px) - fr.lo) / BK);
            if (b < 0 || b >= fr.f.length) continue;
            for (const z of fr.f[b]) {
              const k = z * 4, ax = Q.seg[k], ay = Q.seg[k + 1], bx = Q.seg[k + 2], by = Q.seg[k + 3];
              // descarte rápido: el segmento (agrandado por req) tiene que quedar adelante del punto, a menos de t
              if (sx < 0 ? Math.max(ax, bx) + req < px - t || Math.min(ax, bx) - req > px : sx > 0 ? Math.min(ax, bx) - req > px + t || Math.max(ax, bx) + req < px
                : sy < 0 ? Math.max(ay, by) + req < py - t || Math.min(ay, by) - req > py : Math.min(ay, by) - req > py + t || Math.max(ay, by) + req < py) continue;
              const d = contacto(px, py, sx, sy, ax, ay, bx, by, req);
              if (d < t) { t = d; if (t <= 0) return 0; }
            }
          }
        }
        return t;
      };
      const caja = (g) => [g.bb.x0 + g.c.dx, g.bb.y0 + g.c.dy, g.bb.x1 + g.c.dx, g.bb.y1 + g.c.dy];
      let corto = false;
      for (let pasada = 0; pasada < 8 && !corto; pasada++) {
        let mov = 0;
        for (const [ux, uy] of [[-1, 0], [0, -1]]) {
          const orden = gs.slice().sort((a, b) => (ux ? caja(a)[0] - caja(b)[0] : caja(a)[1] - caja(b)[1]));
          for (const A of orden) {
            if (Date.now() >= fin) { corto = true; break; }
            for (let tramo = 0; tramo < 50; tramo++) {
              const ca = caja(A), pared = ux ? ca[0] - marg : ca[1] - marg, lim = Math.min(pared, 60);
              if (lim <= 1e-3) break;
              let t = lim;
              for (const B of gs) {
                if (B === A) continue;
                const cb = caja(B);
                // solo las que quedan en el camino (la caja de A barrida lim mm, agrandada por req)
                if (ux ? (cb[2] < ca[0] - lim - req || cb[0] > ca[2] + req || cb[3] < ca[1] - req || cb[1] > ca[3] + req)
                  : (cb[3] < ca[1] - lim - req || cb[1] > ca[3] + req || cb[2] < ca[0] - req || cb[0] > ca[2] + req)) continue;
                t = avance(A, B, ux, uy, t);
                if (t <= 0) break;
              }
              const d = Math.max(0, t - 1e-6);
              if (d <= 1e-3) break;
              A.c.dx += ux * d; A.c.dy += uy * d; mov += d;
              if (t < lim) break; // tocó algo
            }
          }
          if (corto) break;
        }
        movido += mov;
        if (mov < 0.5) break;
      }
      if (s === r.usadas[r.usadas.length - 1] && r.nuevas) {
        let xm = 0; for (const g of gs) xm = Math.max(xm, g.bb.x1 + g.c.dx);
        const ult = Math.min(r.ultimoLargo, Math.ceil(xm - 1e-9));
        out.puntaje = r.puntaje - r.ultimoLargo + ult; out.ultimoLargo = ult;
      }
      if (Date.now() >= fin) break;
    }
    out.compactado = Math.round(movido);
    // A igual largo, la compactada gana el empate (la página y el worker se quedan con el puntaje más bajo).
    if (movido > 0) out.puntaje -= 1e-3;
    return out;
  }
  // Lo que hace cada worker en una ronda (nest-worker.js; las pruebas en Node lo llaman igual). Hasta la mitad del tiempo prueba
  // órdenes (fase 1: el primero, el de base o el que siguió, y después variantes del mejor); hasta casi el final rehace sola la
  // última placa (fase 2, mejorarUltima) y al final compacta (fase 3). est = { mejor: el mejor crudo de la fase 1 (su orden
  // sigue en "Seguir" y en la ronda siguiente), final: el último mandado }. avisar('mejor', r) cada vez que mejora lo mandado
  // y avisar('corrida', n) de a tandas (cada 0,2 s). o = { semilla, segundos, base, vueltas, vueltas2, parte1 } (para las
  // pruebas: topes de vueltas de cada fase y la parte del tiempo de la fase 1).
  function trabajar(piezas, cfg, cache, est, o, avisar) {
    const azar = rng(o.semilla * 7919 + 13), bases = ordenesBase(piezas), w = (o.semilla - 1) % 100;
    const t0 = Date.now(), T = o.segundos * 1000, fin1 = t0 + T * (o.parte1 || 0.5), fin = t0 + T, fin2 = fin - Math.min(3000, T * 0.1);
    let sinAvisar = 0, tAviso = Date.now();
    const contar = () => { sinAvisar++; if (Date.now() - tAviso > 200) { avisar('corrida', sinAvisar); sinAvisar = 0; tAviso = Date.now(); } };
    const mandar = (r) => { if (!est.final || r.puntaje < est.final.puntaje) { est.final = r; avisar('mejor', r); } };
    // Fase 1. Los workers que no tienen un orden de base propio (hay 2 y suelen ser 3 o 4) arrancan de una variante, para no
    // repetir la misma primera vuelta.
    const inicio = o.base || (est.mejor && est.mejor.orden) || (w < bases.length ? bases[w] : variar(bases[w % bases.length], azar));
    let k = 0, ultimaMejora = 0;
    while (k === 0 || (Date.now() < fin1 && k < (o.vueltas || Infinity) && k - ultimaMejora < 300)) {
      const orden = k === 0 ? inicio : variar(est.mejor ? est.mejor.orden : inicio, azar);
      const r = { ...corrida(piezas, orden, cfg, cache), orden };
      k++; contar();
      if (!est.mejor || r.puntaje < est.mejor.puntaje) { est.mejor = r; ultimaMejora = k; mandar(r); }
    }
    // Fase 2 y 3 sobre el mejor crudo (la fase 2 rinde más que seguir con la 1: va la mitad del tiempo a cada una).
    const f2 = mejorarUltima(piezas, est.mejor, cfg, cache, azar, fin2, o.vueltas2, contar);
    const r = compactar(piezas, f2.r || est.mejor, cfg, fin);
    mandar(r);
    if (sinAvisar) avisar('corrida', sinAvisar);
    return { vueltas: k, vueltas2: f2.vueltas, ms: Date.now() - t0 };
  }
  raiz.NestCore = { bbox, area, rotar, simplificar, mascara, disco, corrida, ordenesBase, variar, rng, angulos, nuevaHoja, hojaLamina, colocar, mejorarUltima, compactar, contacto, trabajar };
  if (typeof module !== 'undefined' && module.exports) module.exports = raiz.NestCore;
})(typeof self !== 'undefined' ? self : this);
