// Lector de DXF para el nesting (Gaspar 26-oct-2026). Lee un DXF de texto (R12 a 2018: Fusion 360, AutoCAD, Illustrator,
// Inkscape) y devuelve los dibujos en milímetros, con Y para arriba, como los del PDF: { subs: [{pts, cerrado}], clave,
// capa, rgb }. Pasa a tramos rectos LINE, ARC, CIRCLE, ELLIPSE, SPLINE (NURBS o por puntos de paso), LWPOLYLINE y POLYLINE
// (con sus curvas) y abre los bloques (INSERT). Cuenta los textos que se ven y lo que no lee. No une nada: los trazos sueltos
// los une unir().
// También está unir(): junta trazos abiertos cuyas puntas se tocan (a una tolerancia) en figuras cerradas, como "Unir" de
// Illustrator. Fusion 360 exporta cada línea, arco y curva por separado, sin unir.
(function (raiz) {
  'use strict';

  const mod = (a, m) => ((a % m) + m) % m; // resto sin negativos

  // Paleta ACI del AutoCAD. Del 10 al 249: 24 tonos (cada 15°) × 10 variantes (las pares saturadas, las impares a media
  // saturación; el brillo baja de a pares: 255, 165, 127, 76, 38). Del 250 al 255, grises.
  const ACI = { 1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255], 5: [0, 0, 255], 6: [255, 0, 255], 7: [255, 255, 255], 8: [128, 128, 128], 9: [192, 192, 192] };
  function aciRgb(n) {
    n = Math.abs(n | 0);
    if (ACI[n]) return ACI[n];
    if (n >= 250 && n <= 255) { const g = Math.round(51 + (n - 250) * 40.8); return [g, g, g]; }
    if (n >= 10 && n <= 249) {
      const h = Math.floor((n - 10) / 10) * 15, s = (n - 10) % 10, V = [255, 165, 127, 76, 38][s >> 1], m = s & 1 ? V / 2 : 0;
      const f = (k) => { const x = (k + h / 60) % 6; return Math.floor(V - (V - m) * Math.max(0, Math.min(1, x, 4 - x))); }; // HSV → RGB
      return [f(5), f(3), f(1)];
    }
    return [255, 255, 255];
  }
  // $INSUNITS → milímetros por unidad. Las que no están (17 a 20: gigámetros, unidades astronómicas, años luz y pársecs) se
  // toman en milímetros y la página lo avisa.
  const UNIDADES = { 0: 1, 1: 25.4, 2: 304.8, 3: 1609344, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 0.0000254, 9: 0.0254, 10: 914.4, 11: 1e-7, 12: 1e-6, 13: 0.001, 14: 100, 15: 1e4, 16: 1e5, 21: 304.8006096, 22: 25.4000508, 23: 914.4018288, 24: 1609347.2187 };
  // Topes para un DXF roto o desmedido: que dé un error en castellano y no cuelgue la página.
  const MAX_PUNTOS = 5e6, MAX_COPIAS = 2e5, MAX_ARREGLO = 1e4, MAX_TRAMOS = 1e5;

  // Pares (código, valor) del archivo. Los fines de línea pueden ser LF, CRLF, CR o CR CR LF (un CRLF reescrito en modo texto).
  function pares(texto) {
    const l = texto.split(/\r*\n|\r/), out = [];
    for (let i = 0; i + 1 < l.length; i += 2) {
      const c = parseInt(l[i], 10);
      if (!isFinite(c)) { i--; continue; } // una línea en blanco de más: se resincroniza
      out.push([c, l[i + 1].trim()]);
    }
    return out;
  }
  // Entidades de una sección, agrupadas: { tipo, g: [[código, valor]...] }.
  function entidades(ps, i0, fin) {
    const out = []; let cur = null;
    for (let i = i0; i < fin; i++) {
      const [c, v] = ps[i];
      if (c === 0) { cur = { tipo: v.toUpperCase(), g: [] }; out.push(cur); continue; }
      if (cur) cur.g.push([c, v]);
    }
    return out;
  }
  const uno = (e, c, def) => { for (const [k, v] of e.g) if (k === c) return v; return def; };
  const num = (e, c, def) => { const v = parseFloat(uno(e, c, '')); return isFinite(v) ? v : def; };
  const todos = (e, c) => e.g.filter(([k]) => k === c).map(([, v]) => parseFloat(v));

  // Sistema de coordenadas del objeto (OCS) → universal, por el "arbitrary axis algorithm" del DXF. Devuelve f(x, y, z) →
  // [X, Y, Z]: la Z hace falta adentro de un bloque insertado inclinado, que la proyecta en el plano XY.
  function ocs(e) {
    let nx = num(e, 210, 0), ny = num(e, 220, 0), nz = num(e, 230, 1);
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    if (Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12 && nz > 0) return null; // el normal de siempre: no hay que transformar
    let ax, ay, az;
    if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) { ax = nz; ay = 0; az = -nx; } // Wy × N
    else { ax = -ny; ay = nx; az = 0; } // Wz × N
    const La = Math.hypot(ax, ay, az); ax /= La; ay /= La; az /= La;
    const bx = ny * az - nz * ay, by = nz * ax - nx * az, bz = nx * ay - ny * ax; // N × Ax
    return (x, y, z) => [x * ax + y * bx + z * nx, x * ay + y * by + z * ny, x * az + y * bz + z * nz];
  }
  // Puntos (x, y) del OCS de la entidad, a la altura z (su elevación), en el universal; con el normal de siempre solo se les
  // pone la z (si no es 0).
  const enOcs = (T, z) => (pts) => (T ? pts.map(([x, y]) => T(x, y, z)) : z ? pts.map(([x, y]) => [x, y, z]) : pts);

  // Ángulo de cada tramo recto para que la cuerda quede a tol o menos de un arco de radio r (2·acos(1 - tol/r), escrito de
  // forma que no se pierda con radios enormes).
  const pasoArco = (r, tol) => (r > tol ? Math.max(1e-6, 4 * Math.asin(Math.sqrt(tol / (2 * r)))) : Math.PI / 2);
  // Arco de circunferencia a tramos rectos con error de cuerda <= tol. Ángulos en radianes, a1 > a0 (antihorario).
  function arco(out, cx, cy, r, a0, a1, tol, conInicio) {
    const n = Math.min(MAX_TRAMOS, Math.max(1, Math.ceil((a1 - a0) / pasoArco(r, tol))));
    for (let i = conInicio ? 0 : 1; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  }
  // Tramo con bulge (LWPOLYLINE/POLYLINE): de p a q, bulge = tan(ángulo/4), positivo antihorario.
  function bulge(out, p, q, b, tol) {
    if (!b || Math.abs(b) < 1e-9) { out.push(q); return; }
    const dx = q[0] - p[0], dy = q[1] - p[1], c = Math.hypot(dx, dy);
    if (c < 1e-12) { out.push(q); return; }
    const th = 4 * Math.atan(b), r = c / (2 * Math.abs(Math.sin(th / 2)));
    const s = (1 - b * b) / (4 * b); // centro = punto medio + s·(perpendicular izquierda de la cuerda)
    const cx = (p[0] + q[0]) / 2 - s * dy, cy = (p[1] + q[1]) / 2 + s * dx;
    const a0 = Math.atan2(p[1] - cy, p[0] - cx);
    const n = Math.min(MAX_TRAMOS, Math.max(1, Math.ceil(Math.abs(th) / pasoArco(r, tol))));
    for (let i = 1; i < n; i++) { const a = a0 + th * i / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    out.push(q); // la punta exacta: así no se abre por redondeo
  }

  // Muestrea la curva P(t) tramo por tramo entre los cortes (los nudos): parte cada tramo en 8 por lo menos (salvo que sea
  // corto: su cuerda de menos de 8·tol) y sigue partiendo mientras alguno de 7 puntos del medio quede a más de tol del
  // segmento (no de la recta: así se ven las vueltas en punta).
  function muestrear(P, cortes, tol) {
    const pts = [P(cortes[0])];
    const lejos = (a, b, m) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy; let t = L2 > 1e-24 ? ((m[0] - a[0]) * dx + (m[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(m[0] - a[0] - t * dx, m[1] - a[1] - t * dy); };
    const partir = (ta, pa, tb, pb, prof) => {
      const tm = (ta + tb) / 2, pm = P(tm);
      let sigue = (prof < 3 && Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) >= 8 * tol) || lejos(pa, pb, pm) > tol;
      for (let j = 1; j < 8 && !sigue; j++) if (j !== 4 && lejos(pa, pb, P(ta + (tb - ta) * j / 8)) > tol) sigue = true;
      if (sigue && prof < 18) { partir(ta, pa, tm, pm, prof + 1); partir(tm, pm, tb, pb, prof + 1); }
      else pts.push(pb);
    };
    for (let i = 0; i + 1 < cortes.length; i++) { const a = cortes[i], b = cortes[i + 1]; if (b - a > 1e-12) partir(a, P(a), b, P(b), 0); }
    return pts;
  }
  // NURBS (de Boor) en el parámetro t, con pesos; los puntos de control y lo que devuelve van en 3D [x, y, z].
  function deBoor(k, t, nudos, ctrl, w) {
    const n = ctrl.length - 1;
    // tramo de nudos: el último s entre k y n con nudos[s] <= t (por bisección: recorrer la lista hacía que una curva de miles
    // de puntos de control tardara segundos)
    let s = k, hi = n;
    while (s < hi) { const m = (s + hi + 1) >> 1; if (nudos[m] <= t) s = m; else hi = m - 1; }
    const d = [];
    for (let j = 0; j <= k; j++) { const p = ctrl[j + s - k], ww = w ? w[j + s - k] : 1; d.push([p[0] * ww, p[1] * ww, p[2] * ww, ww]); }
    for (let r = 1; r <= k; r++) for (let j = k; j >= r; j--) {
      const i = j + s - k, den = nudos[i + k - r + 1] - nudos[i];
      const a = den > 1e-14 ? (t - nudos[i]) / den : 0, u = d[j - 1], v = d[j];
      d[j] = [(1 - a) * u[0] + a * v[0], (1 - a) * u[1] + a * v[1], (1 - a) * u[2] + a * v[2], (1 - a) * u[3] + a * v[3]];
    }
    const q = d[k]; return [q[0] / q[3], q[1] / q[3], q[2] / q[3]];
  }
  function spline(e, tol, avisos) {
    const k = Math.round(num(e, 71, 3)), flag = Math.round(num(e, 70, 0));
    const nudos = todos(e, 40), wts = todos(e, 41);
    const cx = todos(e, 10), cy = todos(e, 20), cz = todos(e, 30), fx = todos(e, 11), fy = todos(e, 21), fz = todos(e, 31);
    const ctrl = cx.map((x, i) => [x, cy[i], cz[i] || 0]);
    if (k < 1 || ctrl.length < k + 1 || nudos.length !== ctrl.length + k + 1) { // de grado k hacen falta k + 1 puntos de control
      if (fx.length >= 2) { const s = porAjuste(e, fx.map((x, i) => [x, fy[i], fz[i] || 0]), !!(flag & 1), tol); if (s) avisos.splineAjuste++; return s; }
      return null;
    }
    const w = wts.length === ctrl.length && wts.some((x) => Math.abs(x - 1) > 1e-12) ? wts : null;
    const t1 = nudos[ctrl.length];
    const pts = muestrear((t) => deBoor(k, Math.min(t, t1), nudos, ctrl, w), nudos.slice(k, ctrl.length + 1), tol);
    if (nudos[0] === nudos[k]) pts[0] = ctrl[0];
    if (nudos[nudos.length - 1] === nudos[nudos.length - 1 - k]) pts[pts.length - 1] = ctrl[ctrl.length - 1];
    const cerrado = !!(flag & 1) || Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9;
    return { pts, cerrado };
  }
  // SPLINE que trae solo puntos de paso: la cúbica que pasa por ellos con el parámetro = largo de cuerda, como AutoCAD, con
  // curvatura 0 en las puntas o, si vienen, con las tangentes del principio y del final (12/22 y 13/23).
  function porAjuste(e, F, cerrar, tol) {
    const d3 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (cerrar && d3(F[0], F[F.length - 1]) > 1e-9) F = F.concat([F[0]]);
    const Q = [F[0]];
    for (const p of F) if (isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]) && d3(p, Q[Q.length - 1]) > 1e-9) Q.push(p);
    const n = Q.length;
    if (n < 2) return null;
    const s = [0];
    for (let i = 1; i < n; i++) s.push(s[i - 1] + d3(Q[i], Q[i - 1]));
    const tg = (c1, c2, c3) => { const x = num(e, c1, NaN), y = num(e, c2, NaN), z = num(e, c3, 0), L = Math.hypot(x, y, z); return isFinite(L) && L > 1e-12 ? [x / L, y / L, z / L] : null; };
    const t0 = tg(12, 22, 32), t1 = tg(13, 23, 33);
    // segundas derivadas de una coordenada: sistema tridiagonal (Thomas)
    const segundas = (y, d0, d1) => {
      const a = new Array(n).fill(0), b = new Array(n).fill(1), c = new Array(n).fill(0), d = new Array(n).fill(0);
      for (let i = 1; i < n - 1; i++) { const h0 = s[i] - s[i - 1], h1 = s[i + 1] - s[i]; a[i] = h0; b[i] = 2 * (h0 + h1); c[i] = h1; d[i] = 6 * ((y[i + 1] - y[i]) / h1 - (y[i] - y[i - 1]) / h0); }
      if (d0 != null) { const h = s[1] - s[0]; b[0] = 2 * h; c[0] = h; d[0] = 6 * ((y[1] - y[0]) / h - d0); }
      if (d1 != null) { const h = s[n - 1] - s[n - 2]; a[n - 1] = h; b[n - 1] = 2 * h; d[n - 1] = 6 * (d1 - (y[n - 1] - y[n - 2]) / h); }
      for (let i = 1; i < n; i++) { const w = a[i] / b[i - 1]; b[i] -= w * c[i - 1]; d[i] -= w * d[i - 1]; }
      const M = new Array(n); M[n - 1] = d[n - 1] / b[n - 1];
      for (let i = n - 2; i >= 0; i--) M[i] = (d[i] - c[i] * M[i + 1]) / b[i];
      return M;
    };
    const X = Q.map((p) => p[0]), Y = Q.map((p) => p[1]), Z = Q.map((p) => p[2]);
    const MX = segundas(X, t0 && t0[0], t1 && t1[0]), MY = segundas(Y, t0 && t0[1], t1 && t1[1]), MZ = segundas(Z, t0 && t0[2], t1 && t1[2]);
    let i = 0;
    const P = (t) => {
      while (i > 0 && t < s[i]) i--;
      while (i < n - 2 && t > s[i + 1]) i++;
      const h = s[i + 1] - s[i], A = (s[i + 1] - t) / h, B = (t - s[i]) / h, k = h * h / 6, a3 = A * A * A - A, b3 = B * B * B - B;
      return [A * X[i] + B * X[i + 1] + (a3 * MX[i] + b3 * MX[i + 1]) * k, A * Y[i] + B * Y[i + 1] + (a3 * MY[i] + b3 * MY[i + 1]) * k, A * Z[i] + B * Z[i + 1] + (a3 * MZ[i] + b3 * MZ[i + 1]) * k];
    };
    const pts = muestrear(P, s, tol);
    pts[0] = Q[0]; pts[pts.length - 1] = Q[n - 1];
    return { pts, cerrado: cerrar || Math.hypot(Q[0][0] - Q[n - 1][0], Q[0][1] - Q[n - 1][1]) < 1e-9 };
  }

  function elipse(e, tol) {
    const c = [num(e, 10, 0), num(e, 20, 0), num(e, 30, 0)], M = [num(e, 11, 0), num(e, 21, 0), num(e, 31, 0)], ra = num(e, 40, 1);
    let nx = num(e, 210, 0), ny = num(e, 220, 0), nz = num(e, 230, 1);
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    const m = [(ny * M[2] - nz * M[1]) * ra, (nz * M[0] - nx * M[2]) * ra, (nx * M[1] - ny * M[0]) * ra]; // eje menor = ratio · (N × mayor), en 3D
    // parámetros fuera de [0, 2π): se llevan adentro; 0 a 2π es la elipse entera
    const p0 = num(e, 41, 0), a0 = mod(p0, 2 * Math.PI);
    let vuelta = mod(num(e, 42, 2 * Math.PI) - p0, 2 * Math.PI);
    if (vuelta < 1e-9) vuelta = 2 * Math.PI;
    const entera = Math.abs(vuelta - 2 * Math.PI) < 1e-9;
    const R = Math.hypot(M[0], M[1], M[2]), n = Math.min(MAX_TRAMOS, Math.max(entera ? 8 : 1, Math.ceil(vuelta / pasoArco(R, tol))));
    const pts = [];
    for (let i = 0; i < (entera ? n : n + 1); i++) { const t = a0 + vuelta * i / n, co = Math.cos(t), si = Math.sin(t); pts.push([c[0] + M[0] * co + m[0] * si, c[1] + M[1] * co + m[1] * si, c[2] + M[2] * co + m[2] * si]); }
    return { pts, cerrado: entera };
  }

  // Una entidad a subtrazos (puntos [x, y] o [x, y, z] del universal del bloque); null si no dibuja nada que se corte. curva:
  // si es una curva pasada a tramos rectos (un arco corto puede quedar en un solo tramo) o son tramos exactos (LINE, una
  // polilínea sin curvas): unir() lo usa para la tolerancia de una T.
  function geometria(e, tol, av) {
    const tr = enOcs(ocs(e), num(e, 38, num(e, 30, 0))); // ARC, CIRCLE y LWPOLYLINE: en su OCS, a su elevación
    switch (e.tipo) {
      case 'LINE': return [{ pts: [[num(e, 10, 0), num(e, 20, 0), num(e, 30, 0)], [num(e, 11, 0), num(e, 21, 0), num(e, 31, 0)]], cerrado: false }];
      case 'ARC': {
        const cx = num(e, 10, 0), cy = num(e, 20, 0), r = num(e, 40, 0);
        if (!(r > 0)) return null;
        // ángulos fuera de [0, 360): se llevan adentro (un ARC de -30° a 400° va de 330° a 40°: 70°)
        const d0 = num(e, 50, 0), a0 = mod(d0, 360) * Math.PI / 180;
        let vuelta = mod(num(e, 51, 360) - d0, 360);
        if (vuelta < 1e-9) vuelta = 360;
        const pts = []; arco(pts, cx, cy, r, a0, a0 + vuelta * Math.PI / 180, tol, true);
        return [{ pts: tr(pts), cerrado: false, curva: true }];
      }
      case 'CIRCLE': {
        const cx = num(e, 10, 0), cy = num(e, 20, 0), r = num(e, 40, 0);
        if (!(r > 0)) return null;
        const pts = []; arco(pts, cx, cy, r, 0, 2 * Math.PI, tol, true); pts.pop();
        if (pts.length < 8) { pts.length = 0; for (let i = 0; i < 8; i++) pts.push([cx + r * Math.cos(i * Math.PI / 4), cy + r * Math.sin(i * Math.PI / 4)]); }
        return [{ pts: tr(pts), cerrado: true, circulo: true, curva: true }];
      }
      case 'ELLIPSE': return [Object.assign(elipse(e, tol), { curva: true })];
      case 'SPLINE': { const s = spline(e, tol, av); return s ? [Object.assign(s, { curva: true })] : null; }
      case 'LWPOLYLINE': {
        const flag = Math.round(num(e, 70, 0)), vs = [];
        let v = null;
        for (const [c, val] of e.g) {
          if (c === 10) { v = { p: [parseFloat(val), 0], b: 0 }; vs.push(v); }
          else if (c === 20 && v) v.p[1] = parseFloat(val);
          else if (c === 42 && v) v.b = parseFloat(val) || 0;
        }
        return polilinea(vs, !!(flag & 1), tol, tr);
      }
    }
    return null;
  }
  function polilinea(vs, cerrado, tol, tr) {
    if (vs.length < 2) return null;
    const pts = [vs[0].p];
    for (let i = 1; i < vs.length; i++) bulge(pts, vs[i - 1].p, vs[i].p, vs[i - 1].b, tol);
    if (cerrado) { bulge(pts, vs[vs.length - 1].p, vs[0].p, vs[vs.length - 1].b, tol); pts.pop(); }
    return [{ pts: tr(pts), cerrado: cerrado && pts.length >= 3, curva: vs.some((v) => Math.abs(v.b) >= 1e-9) }];
  }

  // Lee el DXF. tol = error máximo de las curvas, en mm. Devuelve { els, unidades, unidadConocida, factor, textos,
  // otros: {tipo: n}, avisos: { splineAjuste, profundo }, capas }.
  function leer(texto, tol) {
    tol = tol || 0.05;
    if (/^AutoCAD Binary DXF/.test(texto)) throw new Error('Es un DXF binario. Exportalo como DXF de texto (ASCII).');
    const ps = pares(texto);
    const secciones = {};
    for (let i = 0; i < ps.length; i++) {
      if (ps[i][0] === 0 && ps[i][1] === 'SECTION' && ps[i + 1] && ps[i + 1][0] === 2) {
        const nom = ps[i + 1][1].toUpperCase(); let j = i + 2;
        while (j < ps.length && !(ps[j][0] === 0 && ps[j][1] === 'ENDSEC')) j++;
        secciones[nom] = [i + 2, j]; i = j;
      }
    }
    if (!secciones.ENTITIES) throw new Error('No encontré dibujos en el DXF (no tiene sección ENTITIES).');
    // Encabezado: unidades
    let ins = 0;
    if (secciones.HEADER) { const [a, b] = secciones.HEADER; for (let i = a; i < b; i++) if (ps[i][0] === 9 && ps[i][1] === '$INSUNITS' && ps[i + 1]) ins = parseInt(ps[i + 1][1], 10) || 0; }
    const conocida = UNIDADES[ins] != null, factor = conocida ? UNIDADES[ins] : 1;
    // Capas: color, si está apagada (color negativo) o congelada (bit 1). Sin prototipo: una capa puede llamarse "constructor".
    const capas = Object.create(null);
    if (secciones.TABLES) {
      const [a, b] = secciones.TABLES;
      for (const e of entidades(ps, a, b)) if (e.tipo === 'LAYER') {
        const nom = uno(e, 2, '0'), col = Math.round(num(e, 62, 7)), fl = Math.round(num(e, 70, 0)), tc = uno(e, 420, null);
        capas[nom] = { color: col, rgb: tc != null ? [(+tc >> 16) & 255, (+tc >> 8) & 255, +tc & 255] : aciRgb(col), apagada: col < 0 || !!(fl & 1), congelada: !!(fl & 1) };
      }
    }
    // Bloques
    const bloques = Object.create(null);
    if (secciones.BLOCKS) {
      const [a, b] = secciones.BLOCKS, es = entidades(ps, a, b);
      let cur = null;
      for (const e of es) {
        if (e.tipo === 'BLOCK') { cur = { base: [num(e, 10, 0), num(e, 20, 0), num(e, 30, 0)], ents: [] }; bloques[uno(e, 2, '')] = cur; }
        else if (e.tipo === 'ENDBLK') cur = null;
        else if (cur) cur.ents.push(e);
      }
    }
    const av = { splineAjuste: 0, profundo: 0 };
    const otros = Object.create(null), els = [];
    let textos = 0, puntos = 0, copias = 0;
    const sinCapa = { color: 7, rgb: [255, 255, 255], apagada: false, congelada: false };
    const colorDe = (e, capaPadre, colorPadre) => {
      let capa = uno(e, 8, '0');
      if (capa === '0' && capaPadre) capa = capaPadre; // lo de la capa 0 adentro de un bloque toma la capa del bloque
      const info = capas[capa] || sinCapa;
      const tc = uno(e, 420, null);
      let col = Math.round(num(e, 62, 256)), rgb;
      if (tc != null) rgb = [(+tc >> 16) & 255, (+tc >> 8) & 255, +tc & 255];
      else if (col === 0) rgb = colorPadre || info.rgb;         // BYBLOCK
      else if (col === 256 || isNaN(col)) rgb = info.rgb;      // BYLAYER
      else rgb = aciRgb(col);
      return { capa, rgb, apagada: info.apagada || col < 0, congelada: info.congelada };
    };
    // Tolerancia de las curvas en unidades del dibujo para la matriz M: tol (mm) dividido por el factor de las unidades y por
    // lo más que estira M al proyectarla en el plano XY (la norma espectral de sus dos primeras filas). Así un DXF en metros o
    // un bloque a escala 4 también quedan a tol en mm.
    const tolEn = (M) => {
      const a = M[0] * M[0] + M[3] * M[3] + M[6] * M[6], b = M[0] * M[1] + M[3] * M[4] + M[6] * M[7], c = M[1] * M[1] + M[4] * M[4] + M[7] * M[7];
      return tol / (factor * Math.max(1e-9, Math.sqrt((a + c + Math.hypot(a - c, 2 * b)) / 2)));
    };
    const seVe = (e, capaPadre, colorPadre) => !colorDe(e, capaPadre, colorPadre).apagada;
    const recorrer = (lista, M, capaPadre, colorPadre, prof) => {
      for (let i = 0; i < lista.length; i++) {
        const e = lista[i];
        if (Math.round(num(e, 67, 0)) === 1) continue; // espacio papel
        if (e.tipo === 'POLYLINE') { // viene seguida de VERTEX... SEQEND
          const vs = [], vz = []; let j = i + 1;
          for (; j < lista.length && lista[j].tipo === 'VERTEX'; j++) {
            const fv = Math.round(num(lista[j], 70, 0));
            if (fv & (16 | 64 | 128)) continue; // marco de spline, malla, cara
            vs.push({ p: [num(lista[j], 10, 0), num(lista[j], 20, 0)], b: num(lista[j], 42, 0) }); vz.push(num(lista[j], 30, 0));
          }
          if (j < lista.length && lista[j].tipo === 'SEQEND') j++;
          i = j - 1;
          const fl = Math.round(num(e, 70, 0));
          if (fl & (16 | 64)) { otros.MALLA = (otros.MALLA || 0) + 1; continue; }
          // 2D: en su OCS, a la elevación de la POLYLINE; 3D (8): cada vértice con su z, en el universal
          const tr = fl & 8 ? (pts) => pts : enOcs(ocs(e), num(e, 30, 0));
          const g = polilinea(fl & 8 ? vs.map((v, k) => ({ p: [v.p[0], v.p[1], vz[k]], b: 0 })) : vs, !!(fl & 1), tolEn(M), tr);
          if (g) emitir(e, g, M, capaPadre, colorPadre);
          continue;
        }
        if (e.tipo === 'INSERT') {
          // los ATTRIB que la siguen (hasta el SEQEND) son los textos de esta referencia
          const atr = []; let j = i + 1;
          for (; j < lista.length && lista[j].tipo === 'ATTRIB'; j++) atr.push(lista[j]);
          if (atr.length && j < lista.length && lista[j].tipo === 'SEQEND') j++;
          i = j - 1;
          const { capa, rgb, congelada } = colorDe(e, capaPadre, colorPadre);
          if (congelada) continue; // en una capa congelada no se ve nada del bloque, ni lo que tiene en otras capas
          for (const at of atr) if (!(Math.round(num(at, 70, 0)) & 1) && seVe(at, capaPadre, colorPadre)) textos++; // 70 & 1: invisible
          const b = bloques[uno(e, 2, '')];
          if (!b) continue;
          if (prof > 8) { av.profundo++; continue; }
          const sx = num(e, 41, 1), sy = num(e, 42, 1), rot = num(e, 50, 0) * Math.PI / 180, cs = Math.cos(rot), sn = Math.sin(rot);
          const nc = Math.max(1, Math.round(num(e, 70, 1))), nf = Math.max(1, Math.round(num(e, 71, 1))), dc = num(e, 44, 0), df = num(e, 45, 0);
          if (nc * nf > MAX_ARREGLO) throw new Error(`El DXF tiene un bloque repetido ${nc} × ${nf} veces: parece roto. Revisalo en el programa de dibujo.`);
          copias += nc * nf;
          if (copias > MAX_COPIAS) throw new Error('El DXF tiene más de 200.000 copias de bloques: parece roto o es demasiado grande para leerlo acá.');
          // La referencia se arma en su OCS (inserción, giro, escala y grilla del arreglo) y después pasa al universal: con
          // extrusión (0, 0, -1) queda espejada entera, no solo en X; inclinada, la z de lo de adentro también corre el dibujo.
          const p = [num(e, 10, 0), num(e, 20, 0), num(e, 30, 0)], sz = num(e, 43, 1);
          const T = ocs(e), W = T ? [...T(1, 0, 0), ...T(0, 1, 0), ...T(0, 0, 1), 0, 0, 0] : null;
          for (let f = 0; f < nf; f++) for (let c = 0; c < nc; c++) {
            const ox = c * dc, oy = f * df;
            // local: (x - base)·escala, girado, + inserción (+ la grilla del arreglo, girada)
            const L = [sx * cs, sx * sn, 0, -sy * sn, sy * cs, 0, 0, 0, sz, p[0] + ox * cs - oy * sn - (b.base[0] * sx * cs - b.base[1] * sy * sn), p[1] + ox * sn + oy * cs - (b.base[0] * sx * sn + b.base[1] * sy * cs), p[2] - b.base[2] * sz];
            recorrer(b.ents, componer(W ? componer(L, W) : L, M), capa, rgb, prof + 1);
          }
          continue;
        }
        if (e.tipo === 'TEXT' || e.tipo === 'MTEXT' || e.tipo === 'ATTDEF' || e.tipo === 'ATTRIB') {
          // se cuentan los que se ven: no los de capas apagadas o congeladas, ni las definiciones de atributo de un bloque (en
          // la referencia se ve su ATTRIB), ni los atributos invisibles
          const invisible = e.tipo === 'ATTRIB' && (Math.round(num(e, 70, 0)) & 1);
          if (!(e.tipo === 'ATTDEF' && prof > 0) && !invisible && seVe(e, capaPadre, colorPadre)) textos++;
          continue;
        }
        if (e.tipo === 'VERTEX' || e.tipo === 'SEQEND' || e.tipo === 'ENDBLK' || e.tipo === 'BLOCK') continue;
        const g = geometria(e, tolEn(M), av);
        if (!g) { if (!['POINT', 'VIEWPORT', 'DIMENSION', 'LEADER', 'MLEADER'].includes(e.tipo)) otros[e.tipo] = (otros[e.tipo] || 0) + 1; continue; }
        emitir(e, g, M, capaPadre, colorPadre);
      }
    };
    const emitir = (e, subs, M, capaPadre, colorPadre) => {
      const { capa, rgb, apagada } = colorDe(e, capaPadre, colorPadre);
      if (apagada) return;
      const f = (x, y, z) => [(M[0] * x + M[3] * y + M[6] * z + M[9]) * factor, (M[1] * x + M[4] * y + M[7] * z + M[10]) * factor];
      const out = [];
      for (const s of subs) {
        const pts = s.pts.filter((p) => isFinite(p[0]) && isFinite(p[1])).map(([x, y, z]) => f(x, y, isFinite(z) ? z : 0));
        puntos += pts.length;
        if (pts.length >= 2) out.push({ pts, cerrado: s.cerrado && pts.length >= 3, circulo: !!s.circulo, curva: !!s.curva, ent: e.tipo });
      }
      if (puntos > MAX_PUNTOS) throw new Error('El DXF es demasiado grande para leerlo acá (más de 5 millones de puntos). Puede estar roto.');
      if (out.length) els.push({ subs: out, capa, rgb });
    };
    recorrer(entidades(ps, secciones.ENTITIES[0], secciones.ENTITIES[1]), [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], '', null, 0);
    return { els, unidades: ins, unidadConocida: conocida, factor, textos, otros, avisos: av, capas: Object.keys(capas) };
  }
  // Matrices de los bloques: afines en 3D, por columnas [a, b, c, d, e, f, g, h, i, tx, ty, tz]: x' = a·x + d·y + g·z + tx,
  // y' = b·x + e·y + h·z + ty, z' = c·x + f·y + i·z + tz. La z importa: un bloque insertado inclinado proyecta en el plano
  // XY la z de lo que tiene adentro (la elevación de una polilínea, la z de un círculo o de una línea).
  // componer(L, M): M aplicada después de L.
  function componer(L, M) {
    const ap = (x, y, z) => [M[0] * x + M[3] * y + M[6] * z, M[1] * x + M[4] * y + M[7] * z, M[2] * x + M[5] * y + M[8] * z];
    const t = ap(L[9], L[10], L[11]);
    return [...ap(L[0], L[1], L[2]), ...ap(L[3], L[4], L[5]), ...ap(L[6], L[7], L[8]), t[0] + M[9], t[1] + M[10], t[2] + M[11]];
  }

  // ───────────── unir trazos sueltos ─────────────
  // abiertos: [{pts, curva}] (trazos abiertos de un mismo tipo; curva: si es una curva pasada a tramos rectos; si no viene, es
  // curva el trazo de más de dos puntos). Arma un grafo: cada trazo es una arista entre sus dos puntas (nodos).
  //  1. Las puntas prácticamente iguales (a 0,0001 mm o menos) son el mismo nodo, y los trazos repetidos (entre los mismos
  //     nodos y por el mismo camino) se toman una vez.
  //  2. Las puntas que quedan sueltas se juntan por grupos, las más cercanas primero: un grupo son puntas que están todas a tol
  //     o menos entre sí (dos puntas que no se tocan, o tres o cuatro brazos que llegan casi al centro de una cruz).
  //  3. Una punta que cae a tol o menos del medio de otro trazo lo parte ahí: una T (Fusion no parte una recta cuando otra
  //     termina en su medio). Si cae a tol o menos de una punta de ese trazo donde ya se juntan otros, se pega a ese nodo (no
  //     deja un pedacito). Vale también para un nodo donde ya se juntan dos o más trazos (un "+": dos trazos que terminan en el
  //     mismo punto del medio de una recta entera), y dos nodos así del mismo dibujo, de cadenas distintas, a tol o menos son
  //     uno. Contra una curva vale tol + curva (el error de cuerda con el que se pasó a tramos rectos): la punta está sobre la
  //     curva de verdad, no sobre los tramos.
  //  4. Las puntas de los trazos van al lugar de su nodo (así salen todos del mismo punto, sin cruces microscópicos) y se
  //     vuelven a buscar los repetidos. Cada zona que encierran los trazos es una figura cerrada (las caras del dibujo): dos
  //     piezas pegadas por un lado salen como dos figuras y el lado compartido va en las dos. Un hueco que toca el borde en
  //     una punta sale aparte. No depende del orden de los trazos en el archivo.
  //  5. Lo que no encierra nada (colas, líneas sueltas, puentes entre figuras) queda abierto, en cadenas que siguen por donde
  //     va más derecho, sin pasar por las figuras.
  //  6. Dos trazos que se cruzan sin una punta ahí no se parten solos. Solo si son del mismo dibujo conectado y uno de los dos
  //     va de un nodo a otro distinto (una divisoria, como las dos rectas enteras de una ventana pegadas al borde): ahí hace
  //     falta para cerrar las figuras. Dos letras superpuestas (dibujos aparte, o contornos que se tocan en un punto) o una
  //     línea suelta que cruza una pieza siguen enteras, y el cruce se marca (cruzan).
  // Ningún trazo se tira por corto (sí uno que queda entero adentro del nodo donde se juntaron sus dos puntas). Devuelve {
  // cerradas: [pts], abiertas: [{pts, falta, toca}], sueltas: [[x, y]], cruces: [[x, y]], cruzan: [[x, y]], repetidos,
  // partidos, cruzadas, usados, nodos, cerradasPorPartir, crucesSinBuscar, finas }. falta: lo que le falta a una abierta para cerrar;
  // toca: sale de una figura cerrada (ahí falta no es un hueco). cruces: nodos donde se juntan más de dos trazos; cruzan:
  // cruces que no se partieron; cruzadas: cruces que se partieron. usados: cuántos trazos forman parte de alguna figura
  // cerrada. cerradasPorPartir: figuras cerradas que usan un pedazo de un trazo partido (por una T o un cruce).
  // crucesSinBuscar: el dibujo es demasiado grande y los cruces no se buscaron. finas: figuras cerradas más finas que tol (2 ×
  // área / perímetro: el ancho, en una tira; en una astilla en punta, la mitad), como el lado de una pieza dibujado dos veces,
  // corrido más de 0,5 mm: conviene mirarlas.
  function unir(abiertos, tol, curva) {
    tol = Math.max(1e-6, +tol || 0); curva = Math.max(0, +curva || 0);
    const eps = Math.min(tol, 1e-4), d2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]), ck = (x, y) => x + ',' + y;
    const largoDe = (p) => { let L = 0; for (let i = 1; i < p.length; i++) L += d2(p[i], p[i - 1]); return L; };
    // Aristas sin puntos repetidos seguidos (con un vértice doble no se puede medir para dónde sale). P: puntas; padre: qué
    // puntas son el mismo nodo (unión de conjuntos); cpadre: qué puntas están en el mismo dibujo conectado.
    const esCurva = (e) => (e.curva != null ? !!e.curva : e.pts.length > 2);
    let E = [];
    const P = [], padre = [], cpadre = [];
    const punta = (p) => { P.push(p); padre.push(P.length - 1); cpadre.push(P.length - 1); return P.length - 1; };
    const raizDe = (u, i) => { while (u[i] !== i) { u[i] = u[u[i]]; i = u[i]; } return i; };
    const juntar = (u, i, j) => { i = raizDe(u, i); j = raizDe(u, j); if (i < j) u[j] = i; else if (j < i) u[i] = j; return Math.min(i, j); };
    const nodo = (i) => raizDe(padre, i);
    abiertos.forEach((s, k) => {
      const p0 = s && s.pts;
      if (!p0 || p0.length < 2) return;
      const p = [p0[0]];
      for (let i = 1; i < p0.length; i++) if (d2(p0[i], p[p.length - 1]) > 1e-9) p.push(p0[i]);
      if (p.length < 2) return; // un punto: no dibuja nada
      const ia = punta(p[0]), ib = punta(p[p.length - 1]);
      juntar(cpadre, ia, ib);
      E.push({ pts: p, L: largoDe(p), ia, ib, src: k, curva: s.curva });
    });
    // 1. puntas prácticamente iguales (grilla de celdas de eps; en cada celda queda una punta por nodo)
    const celdas = new Map();
    for (let i = 0; i < P.length; i++) {
      const p = P[i], cx = Math.floor(p[0] / eps), cy = Math.floor(p[1] / eps);
      let junto = false;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const l = celdas.get(ck(cx + dx, cy + dy));
        if (l) for (const j of l) if (d2(P[j], p) <= eps) { juntar(padre, i, j); juntar(cpadre, i, j); junto = true; }
      }
      if (!junto) { const k = ck(cx, cy), l = celdas.get(k); if (l) l.push(i); else celdas.set(k, [i]); }
    }
    // repetidos: los mismos nodos y el mismo camino (cada punto de uno cerca del otro, en los dos sentidos)
    let repetidos = 0;
    const umbral = Math.min(0.5, Math.max(0.12, tol));
    const aPoli = (q, p) => {
      let m = Infinity;
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1], vx = p[i][0] - a[0], vy = p[i][1] - a[1], L2 = vx * vx + vy * vy;
        let t = L2 > 0 ? ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / L2 : 0; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(q[0] - a[0] - t * vx, q[1] - a[1] - t * vy); if (d < m) m = d;
      }
      return m;
    };
    const muestras = (e, k) => { // k puntos repartidos por el largo
      const out = [], p = e.pts; let acum = 0, i = 1;
      for (let j = 1; j <= k; j++) {
        const s = e.L * j / (k + 1);
        while (i < p.length - 1 && acum + d2(p[i], p[i - 1]) < s) { acum += d2(p[i], p[i - 1]); i++; }
        const L = d2(p[i], p[i - 1]), t = L > 0 ? Math.min(1, (s - acum) / L) : 0;
        out.push([p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t]);
      }
      return out;
    };
    const mismo = (A, B) => Math.abs(A.L - B.L) <= 2 * umbral + 0.02 * Math.max(A.L, B.L) && muestras(A, 9).every((q) => aPoli(q, B.pts) <= umbral) && muestras(B, 9).every((q) => aPoli(q, A.pts) <= umbral);
    const sacarRepetidos = () => {
      const grupos = new Map(), quedan = [];
      for (const e of E) {
        const a = nodo(e.ia), b = nodo(e.ib), k = a < b ? a + ',' + b : b + ',' + a, g = grupos.get(k);
        if (g && g.length < 64 && g.some((o) => mismo(o, e))) { repetidos++; continue; }
        if (g) g.push(e); else grupos.set(k, [e]);
        quedan.push(e);
      }
      E = quedan;
    };
    sacarRepetidos();
    const grados = () => { const g = new Map(); for (const e of E) for (const n of [nodo(e.ia), nodo(e.ib)]) g.set(n, (g.get(n) || 0) + 1); return g; };
    // 2. puntas sueltas: por grupos, las más cercanas primero; en un grupo están todas a tol o menos entre sí
    let gr = grados();
    const largoComp = new Map();
    for (const e of E) { const c = raizDe(cpadre, e.ia); largoComp.set(c, (largoComp.get(c) || 0) + e.L); }
    const sueltas0 = [], porCelda = new Map();
    for (const [n, g] of gr) if (g === 1) {
      sueltas0.push(n);
      const k = ck(Math.floor(P[n][0] / tol), Math.floor(P[n][1] / tol)), l = porCelda.get(k);
      if (l) l.push(n); else porCelda.set(k, [n]);
    }
    const pares = [];
    for (const n of sueltas0) {
      const p = P[n], cx = Math.floor(p[0] / tol), cy = Math.floor(p[1] / tol);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const l = porCelda.get(ck(cx + dx, cy + dy));
        if (l) for (const m of l) if (m > n) { const d = d2(P[m], p); if (d <= tol) pares.push([d, n, m]); }
      }
    }
    pares.sort((u, v) => u[0] - v[0] || u[1] - v[1] || u[2] - v[2]);
    const grupo = new Map(); // nodo → las puntas sueltas que junta
    for (const n of sueltas0) grupo.set(n, [n]);
    for (const [, n, m] of pares) {
      const a = nodo(n), b = nodo(m);
      if (a === b) continue;
      const cn = raizDe(cpadre, n), cm = raizDe(cpadre, m);
      if (cn === cm && largoComp.get(cn) <= 3 * tol) continue; // las dos puntas de un trazo cortito: cerrarlo no da una figura
      const A = grupo.get(a), B = grupo.get(b);
      if (A.length * B.length > 4096 || !A.every((i) => B.every((j) => d2(P[i], P[j]) <= tol))) continue;
      const r = juntar(padre, a, b); grupo.set(r, A.concat(B)); grupo.delete(r === a ? b : a);
      if (cn !== cm) largoComp.set(juntar(cpadre, cn, cm), largoComp.get(cn) + largoComp.get(cm));
    }
    // Cadenas: los trazos seguidos por nodos donde se juntan solo dos (e.cad). Devuelve, de cada cadena, los nodos de sus
    // puntas (los de grado distinto de 2: una T, un cruce, una punta suelta); un contorno cerrado suelto no tiene.
    const cadenas = () => {
      const llegan = new Map(), puntas = new Map(), cad = E.map((_, k) => k);
      E.forEach((e, k) => { for (const n of [nodo(e.ia), nodo(e.ib)]) { const l = llegan.get(n); if (l) l.push(k); else llegan.set(n, [k]); } });
      for (const [, l] of llegan) if (l.length === 2 && l[0] !== l[1]) juntar(cad, l[0], l[1]);
      E.forEach((e, k) => { e.cad = raizDe(cad, k); });
      for (const [n, l] of llegan) if (l.length !== 2) for (const k of l) { const s = puntas.get(E[k].cad); if (s) s.add(n); else puntas.set(E[k].cad, new Set([n])); }
      return puntas;
    };
    // 3. T: una punta (suelta, o un nodo donde ya se juntan trazos) a tol o menos del medio de otro trazo, o de su propio
    //    trazo lejos de esa punta; o, si es un nodo donde se juntan trazos, a tol o menos de otro nodo así
    let partidos = 0;
    gr = grados();
    // grilla de trazos: cada uno en las celdas que toca su caja (agrandada en tolT) o, si la caja es grande (una recta larga
    // en diagonal), en las que tocan sus tramos; los desmedidos van aparte y se miran siempre
    const tolT = tol + curva, C = Math.max(4 * tolT, 5), grillaE = new Map(), largas = [];
    const caja = (e) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of e.pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } e.bb = [x0, y0, x1, y1]; };
    const enCelda = (k, e) => { const l = grillaE.get(k); if (l) l.push(e); else grillaE.set(k, [e]); };
    const indexar = (e) => {
      caja(e);
      const x0 = Math.floor((e.bb[0] - tolT) / C), x1 = Math.floor((e.bb[2] + tolT) / C), y0 = Math.floor((e.bb[1] - tolT) / C), y1 = Math.floor((e.bb[3] + tolT) / C);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 64) { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) enCelda(ck(x, y), e); return; }
      if (e.L > 5000 * C) { largas.push(e); return; }
      const r = tolT + C / 4, celdas = new Set(); // cada punto a tolT o menos del tramo queda a r o menos de una muestra (cada C/2)
      for (let i = 1; i < e.pts.length; i++) {
        const a = e.pts[i - 1], b = e.pts[i], n = Math.max(1, Math.ceil(d2(a, b) / (C / 2)));
        for (let j = 0; j <= n; j++) {
          const x = a[0] + (b[0] - a[0]) * j / n, y = a[1] + (b[1] - a[1]) * j / n;
          for (let cx = Math.floor((x - r) / C); cx <= Math.floor((x + r) / C); cx++) for (let cy = Math.floor((y - r) / C); cy <= Math.floor((y + r) / C); cy++) celdas.add(ck(cx, cy));
        }
      }
      for (const k of celdas) enCelda(k, e);
    };
    E.forEach(indexar);
    const grado = (i) => gr.get(nodo(i)) || 0;
    const pegar = (i, j) => { const a = grado(i), b = grado(j); gr.set(juntar(padre, i, j), a + b); juntar(cpadre, i, j); };
    // Primero las puntas sueltas; después los nodos donde ya se juntan trazos, pero solo contra otra cadena del mismo dibujo
    // conectado (el "+" de un panel ya está pegado al borde por sus otras puntas): un círculo o una letra aparte que pasa por
    // encima de una recta no se pega a ella, aunque una de sus uniones caiga justo sobre la recta, y la unión de dos tramos
    // de un contorno no se pega a otra parte del mismo contorno que pasa cerca (el trazo fino de una letra).
    const mirados = new Set();
    const buscarT = (n) => {
      const g = grado(n), p = P[n], cand = (grillaE.get(ck(Math.floor(p[0] / C), Math.floor(p[1] / C))) || []).concat(largas);
      const comp = raizDe(cpadre, n), propias = g > 1 ? new Set(cand.filter((e) => nodo(e.ia) === n || nodo(e.ib) === n).map((e) => e.cad)) : null;
      let mejor = null;
      for (const e of cand) {
        if (!e.bb) caja(e);
        const lim = tol + (esCurva(e) ? curva : 0); // un tramo recto (LINE) es exacto; una curva pasada a tramos, no
        if (p[0] < e.bb[0] - lim || p[0] > e.bb[2] + lim || p[1] < e.bb[1] - lim || p[1] > e.bb[3] + lim) continue;
        if (g > 1 && (raizDe(cpadre, e.ia) !== comp || propias.has(e.cad))) continue;
        // un nodo donde se juntan trazos a tol o menos de la punta de otra cadena del mismo dibujo (un nodo que no está en sus
        // cadenas): es el mismo nodo (los cuatro brazos de una cruz que se juntaron de a dos)
        if (g > 1) for (const [j, q] of [[e.ia, e.pts[0]], [e.ib, e.pts[e.pts.length - 1]]]) {
          const m = nodo(j), d = d2(p, q);
          if (m !== n && d <= tol && (!mejor || d < mejor.d) && !cand.some((o) => (nodo(o.ia) === m || nodo(o.ib) === m) && propias.has(o.cad))) mejor = { d, m };
        }
        const llegaA = nodo(e.ia) === n, llegaB = nodo(e.ib) === n;
        let acum = 0;
        for (let i = 1; i < e.pts.length; i++) {
          const a = e.pts[i - 1], b = e.pts[i], vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy, L = Math.sqrt(L2);
          let t = L2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2 : 0; t = Math.max(0, Math.min(1, t));
          const q = [a[0] + t * vx, a[1] + t * vy], d = d2(p, q), s = acum + t * L;
          // no cuenta: a 3·lim o menos (por el trazo) de la punta del trazo que llega a este nodo (es esa misma punta). Para una
          // punta suelta, tampoco a 2·lim o menos de una punta suelta del otro trazo (son dos puntas que no se tocan, o se pasan
          // una de la otra, y quedan abiertas); para un nodo donde ya se juntan trazos, a 2·lim o menos de cualquier punta del
          // otro (una esquina cerca de otra esquina no es una T)
          const noT = (llegaA && s <= 3 * lim) || (llegaB && e.L - s <= 3 * lim) || (g === 1
            ? (s <= 2 * lim && grado(e.ia) === 1) || (e.L - s <= 2 * lim && grado(e.ib) === 1)
            : s <= 2 * lim || e.L - s <= 2 * lim);
          if (d <= lim && (!mejor || d < mejor.d) && !noT) mejor = { d, e, i, q, lim };
          acum += L;
        }
      }
      if (!mejor) return;
      let destino;
      if (mejor.m != null) destino = mejor.m; // otro nodo
      else {
        const { e, i, q, lim } = mejor, m = e.pts.length;
        // cae en una punta, o una punta suelta cae a lim o menos de una punta donde ya se juntan trazos: es ese nodo (partir
        // ahí dejaría un pedacito, y el lado de una pieza dibujado dos veces no se tomaría como repetido)
        if ((i === 1 && d2(q, e.pts[0]) <= eps) || (g === 1 && grado(e.ia) > 1 && d2(q, e.pts[0]) <= lim)) destino = e.ia;
        else if ((i === m - 1 && d2(q, e.pts[m - 1]) <= eps) || (g === 1 && grado(e.ib) > 1 && d2(q, e.pts[m - 1]) <= lim)) destino = e.ib;
        else { // parte el trazo ahí
          const k = d2(q, e.pts[i - 1]) <= eps ? i - 1 : d2(q, e.pts[i]) <= eps ? i : -1;
          const A = k >= 0 ? e.pts.slice(0, k + 1) : e.pts.slice(0, i).concat([q]), B = k >= 0 ? e.pts.slice(k) : [q].concat(e.pts.slice(i));
          destino = punta(A[A.length - 1]); gr.set(destino, 2); juntar(cpadre, destino, e.ia);
          const cv = esCurva(e), nueva = { pts: B, L: largoDe(B), ia: destino, ib: e.ib, src: e.src, cad: e.cad, curva: cv, partido: true };
          E.push(nueva); indexar(nueva);
          Object.assign(e, { pts: A, L: largoDe(A), ib: destino, bb: null, curva: cv, partido: true }); // queda en las celdas de antes: sobra, no falta
          partidos++;
        }
      }
      pegar(n, destino); mirados.add(nodo(n));
    };
    for (const pasada of [1, 2]) {
      if (pasada === 2) cadenas();
      for (const [n0] of [...gr]) {
        const n = nodo(n0);
        if (mirados.has(n) || (pasada === 1) !== (grado(n) === 1)) continue; // ya se miró (o se le pegó otra), o no le toca
        mirados.add(n);
        buscarT(n);
      }
    }
    // Las puntas de cada trazo van al lugar de su nodo (donde coinciden más puntas: en una T, el punto del trazo partido; en una
    // esquina con una punta corrida, la esquina; si no coinciden ningunas, el promedio) y se sacan los puntos del trazo que
    // quedan a 2·r o menos del nodo (r: lo más lejos que estaba una punta). Así todos salen del mismo punto en su dirección de
    // verdad: puntas que no coincidían dejaban cruces microscópicos que desordenaban las caras. Un trazo que queda entero
    // adentro del nodo se saca.
    const asentar = () => {
      const llegan = new Map();
      for (const e of E) for (const [i, q] of [[e.ia, e.pts[0]], [e.ib, e.pts[e.pts.length - 1]]]) { const n = nodo(i), l = llegan.get(n); if (l) l.push(q); else llegan.set(n, [q]); }
      const lugar = new Map();
      for (const [n, l] of llegan) {
        if (l.every((q) => d2(q, l[0]) <= 1e-9)) continue; // coinciden: no se toca
        let c = null, k0 = 1;
        if (l.length <= 64) for (const a of l) { let k = 0; for (const b of l) if (d2(a, b) <= eps) k++; if (k > k0) { k0 = k; c = a; } }
        if (!c) { let x = 0, y = 0; for (const q of l) { x += q[0]; y += q[1]; } c = [x / l.length, y / l.length]; }
        let r = 0; for (const q of l) r = Math.max(r, d2(q, c));
        lugar.set(n, { c, R: 2 * r });
      }
      if (!lugar.size) return;
      E = E.filter((e) => {
        const a = lugar.get(nodo(e.ia)), b = lugar.get(nodo(e.ib));
        if (!a && !b) return true;
        let p = e.pts;
        if (a) { let k = 1; while (k < p.length - 1 && d2(p[k], a.c) <= a.R) k++; p = [a.c].concat(p.slice(k)); }
        if (b) { let k = p.length - 2; while (k > 0 && d2(p[k], b.c) <= b.R) k--; p = p.slice(0, k + 1).concat([b.c]); }
        const q = [p[0]];
        for (let i = 1; i < p.length; i++) if (d2(p[i], q[q.length - 1]) > 1e-9) q.push(p[i]);
        if (q.length < 2) return false; // quedó adentro del nodo
        Object.assign(e, { pts: q, L: largoDe(q), bb: null });
        return true;
      });
    };
    asentar();
    sacarRepetidos();
    const caras = () => {
      // 4. caras. Por cada nodo, los trazos que salen ordenados por ángulo; cada cara se recorre dejándola a la izquierda: al
      // llegar a un nodo se sigue por el trazo que sale justo antes (en sentido horario) del que vuelve por donde se llegó.
      const idDe = new Map(), nodos = [];
      const id = (i) => { const r = nodo(i); let k = idDe.get(r); if (k == null) { k = nodos.length; idDe.set(r, k); nodos.push({ p: P[r], sal: [] }); } return k; };
      const nE = E.length;
      E.forEach((e, k) => { e.na = id(e.ia); e.nb = id(e.ib); nodos[e.na].sal.push(2 * k); nodos[e.nb].sal.push(2 * k + 1); });
      // media arista h: la arista h >> 1 recorrida de na a nb (h par) o de nb a na (h impar)
      const origen = (h) => (h & 1 ? E[h >> 1].nb : E[h >> 1].na), destinoDe = (h) => (h & 1 ? E[h >> 1].na : E[h >> 1].nb);
      const angulo = (h, j) => { const p = E[h >> 1].pts, m = p.length, a = h & 1 ? p[m - 1] : p[0], b = h & 1 ? p[Math.max(0, m - 1 - j)] : p[Math.min(m - 1, j)]; return Math.atan2(b[1] - a[1], b[0] - a[0]); };
      const agregar = (pts, h) => { // los puntos de la media arista h, sin repetir el primero si coincide con el último
        const p = E[h >> 1].pts, m = p.length;
        for (let j = 0; j < m; j++) { const q = h & 1 ? p[m - 1 - j] : p[j]; if (j === 0 && pts.length && d2(q, pts[pts.length - 1]) <= eps) continue; pts.push(q); }
      };
      // colas: se sacan de a una las aristas con una punta suelta; lo que queda (las que están en algún lazo) arma las caras
      const fuera = new Uint8Array(nE), g = nodos.map((nd) => nd.sal.length), cola = [];
      g.forEach((x, n) => { if (x === 1) cola.push(n); });
      while (cola.length) {
        const n = cola.pop();
        if (g[n] !== 1) continue;
        for (const h of nodos[n].sal) {
          const k = h >> 1; if (fuera[k]) continue;
          fuera[k] = 1; g[n]--; const o = destinoDe(h); g[o]--; if (g[o] === 1) cola.push(o);
          break;
        }
      }
      const pos = new Int32Array(2 * nE);
      for (const nd of nodos) {
        nd.giro = nd.sal.filter((h) => !fuera[h >> 1]).map((h) => { const a1 = angulo(h, 1); let a2 = angulo(h, 2) - a1; if (a2 > Math.PI) a2 -= 2 * Math.PI; if (a2 <= -Math.PI) a2 += 2 * Math.PI; return { h, a1, a2 }; });
        nd.giro.sort((u, v) => (Math.abs(u.a1 - v.a1) > 1e-9 ? u.a1 - v.a1 : u.a2 - v.a2)); // dos que salen igual: desempata la curvatura
        nd.giro.forEach((x, i) => { pos[x.h] = i; });
      }
      const sig = (h) => { const t = h ^ 1, gi = nodos[origen(t)].giro; return gi[(pos[t] - 1 + gi.length) % gi.length].h; };
      const area = (p) => { let s = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return s / 2; };
      const vista = new Uint8Array(2 * nE), enFigura = new Uint8Array(nE), cerradas = [];
      let porPartir = 0;
      const guardar = (pts, ars) => {
        if (pts.length > 1 && d2(pts[0], pts[pts.length - 1]) <= eps) pts.pop();
        if (pts.length < 3 || !(area(pts) > 1e-6)) return; // horaria: el borde de afuera, o un hueco que toca el borde
        cerradas.push(pts);
        for (const k of ars) enFigura[k] = 1;
        if (ars.some((k) => E[k].partido)) porPartir++;
      };
      for (let h0 = 0; h0 < 2 * nE; h0++) {
        if (vista[h0] || fuera[h0 >> 1]) continue;
        // si la cara pasa dos veces por un nodo, lo del medio es otra vuelta (un hueco que toca el borde, una figura pegada por
        // una punta, un puente): se separa con una pila de los nodos por los que va pasando
        const pts = [], ars = [], pila = [{ n: origen(h0), ip: 0, ia: 0 }], enPila = new Map([[origen(h0), 0]]);
        let h = h0;
        do {
          vista[h] = 1;
          if (!pts.length) pts.push(h & 1 ? E[h >> 1].pts[E[h >> 1].pts.length - 1] : E[h >> 1].pts[0]);
          agregar(pts, h); ars.push(h >> 1);
          const n = destinoDe(h);
          if (enPila.has(n)) {
            const k0 = enPila.get(n), b = pila[k0];
            guardar(pts.slice(b.ip), ars.slice(b.ia));
            pts.length = b.ip + 1; ars.length = b.ia;
            while (pila.length > k0 + 1) enPila.delete(pila.pop().n);
          } else { enPila.set(n, pila.length); pila.push({ n, ip: pts.length - 1, ia: ars.length }); }
          h = sig(h);
        } while (h !== h0 && !vista[h]);
      }
      // 5. lo que no está en ninguna figura queda abierto: cadenas que siguen por los nodos que no tocan figuras, de a pares de
      // trazos (en un cruce, los que van más derecho)
      const toca = new Uint8Array(nodos.length), salLibre = nodos.map(() => []);
      E.forEach((e, k) => { if (enFigura[k]) { toca[e.na] = 1; toca[e.nb] = 1; } else { salLibre[e.na].push(2 * k); salLibre[e.nb].push(2 * k + 1); } });
      const pareja = new Map();
      salLibre.forEach((l, n) => {
        if (toca[n] || l.length < 2 || l.length > 12) return; // en un nodo de muchos (una estrella) cada uno queda por su lado
        if (l.length === 2) { pareja.set(l[0], l[1]); pareja.set(l[1], l[0]); return; }
        const dir = l.map((h) => { const a = angulo(h, 1); return [Math.cos(a), Math.sin(a)]; }), cand = [];
        for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) cand.push([dir[i][0] * dir[j][0] + dir[i][1] * dir[j][1], i, j]);
        cand.sort((u, v) => u[0] - v[0]);
        for (const [c, i, j] of cand) if (c < -0.5 && !pareja.has(l[i]) && !pareja.has(l[j])) { pareja.set(l[i], l[j]); pareja.set(l[j], l[i]); }
      });
      const hecha = new Uint8Array(nE), abiertas = [];
      const camino = (h0) => {
        const pts = [], n0 = origen(h0), ars = [];
        let h = h0, n = n0;
        while (h != null && !hecha[h >> 1]) {
          hecha[h >> 1] = 1; agregar(pts, h); ars.push(h >> 1); n = destinoDe(h);
          h = pareja.get(h ^ 1); // sigue por la pareja del que vuelve
        }
        if (largoDe(pts) <= 2 * eps) return; // un punto: no dibuja nada
        if (n === n0 && pareja.has(h0)) { if (d2(pts[0], pts[pts.length - 1]) <= eps) pts.pop(); if (pts.length >= 3) { cerradas.push(pts); for (const k of ars) enFigura[k] = 1; if (ars.some((k) => E[k].partido)) porPartir++; return; } } // una vuelta que se cruza a sí misma (un 8): queda cerrada, como vino
        abiertas.push({ pts, falta: d2(pts[0], pts[pts.length - 1]), toca: !!(toca[n0] || toca[n]) });
      };
      salLibre.forEach((l) => { for (const h of l) if (!hecha[h >> 1] && !pareja.has(h)) camino(h); });
      salLibre.forEach((l) => { for (const h of l) if (!hecha[h >> 1]) camino(h); });
      const sueltas = [], cruces = [], usados = new Set();
      nodos.forEach((nd) => { if (nd.sal.length === 1) sueltas.push(nd.p); else if (nd.sal.length > 2) cruces.push(nd.p); });
      E.forEach((e, k) => { if (enFigura[k]) usados.add(e.src); });
      return { cerradas, abiertas, sueltas, cruces, usados: usados.size, nodos: nodos.length, enFigura, porPartir, abLargo: abiertas.reduce((s, o) => s + largoDe(o.pts), 0) };
    };
    let R = caras(), cruzadas = 0, partidas = new Set(), sinBuscar = false;
    // 6. cruces: dos tramos de trazos distintos que se cruzan lejos de sus puntas (a más de 2·tol: si no, es una T o una
    //    esquina) y en un ángulo de 15° o más (más cerrado son dos trazos casi encimados, como la misma curva pasada dos veces
    //    a tramos rectos de distinto largo, que se cruzan a cada rato). Grilla de tramos de C de lado; cada cruce se cuenta en
    //    la celda donde cae. Con un dibujo desmedido no se buscan y se avisa (sinBuscar).
    const cruzamientos = () => {
      const celdas = new Map(), out = [];
      let total = 0; for (const e of E) total += e.pts.length;
      if (total > 4e5) { sinBuscar = true; return out; } // demasiado grande para buscarlos
      let pares = 3e6; // como mucho (una estrella de miles de rayos cae entera en una celda): si no alcanza, no se buscan
      const anotar = (key, r) => { const l = celdas.get(key); if (l) l.push(r); else celdas.set(key, [r]); };
      E.forEach((e, k) => {
        let acum = 0;
        for (let i = 1; i < e.pts.length; i++) {
          const a = e.pts[i - 1], b = e.pts[i], L = d2(a, b), r = { k, i, s0: acum, L };
          acum += L;
          if (!(L > 0)) continue;
          const x0 = Math.floor(Math.min(a[0], b[0]) / C), x1 = Math.floor(Math.max(a[0], b[0]) / C), y0 = Math.floor(Math.min(a[1], b[1]) / C), y1 = Math.floor(Math.max(a[1], b[1]) / C);
          if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 4) { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) anotar(ck(x, y), r); continue; }
          const n = Math.ceil(L / (C / 2)), vistas = new Set(); // las celdas por las que pasa: muestras cada C/2, con C/4 de margen
          for (let j = 0; j <= n; j++) {
            const x = a[0] + (b[0] - a[0]) * j / n, y = a[1] + (b[1] - a[1]) * j / n;
            for (let cx = Math.floor((x - C / 4) / C); cx <= Math.floor((x + C / 4) / C); cx++) for (let cy = Math.floor((y - C / 4) / C); cy <= Math.floor((y + C / 4) / C); cy++) vistas.add(ck(cx, cy));
          }
          for (const key of vistas) anotar(key, r);
        }
      });
      for (const [key, l] of celdas) {
        if (l.length < 2) continue;
        const coma = key.indexOf(','), cx = +key.slice(0, coma), cy = +key.slice(coma + 1);
        for (let u = 0; u < l.length; u++) for (let v = u + 1; v < l.length; v++) {
          const A = l[u], B = l[v];
          if (A.k === B.k) continue;
          if (--pares < 0) { sinBuscar = true; return []; } // partir solo algunos dejaría el dibujo a medias (y tarda mucho más)
          const ea = E[A.k], eb = E[B.k], p = ea.pts[A.i - 1], p2 = ea.pts[A.i], q = eb.pts[B.i - 1], q2 = eb.pts[B.i];
          const rx = p2[0] - p[0], ry = p2[1] - p[1], sx = q2[0] - q[0], sy = q2[1] - q[1], den = rx * sy - ry * sx;
          if (Math.abs(den) < 0.2588 * A.L * B.L) continue; // |sen| < sen 15°: paralelos o casi encimados, no es un cruce
          const wx = q[0] - p[0], wy = q[1] - p[1], t = (wx * sy - wy * sx) / den, w = (wx * ry - wy * rx) / den;
          if (t < 0 || t >= 1 || w < 0 || w >= 1) continue;
          const x = p[0] + t * rx, y = p[1] + t * ry;
          if (Math.floor(x / C) !== cx || Math.floor(y / C) !== cy) continue; // se cuenta en otra celda
          const sa = A.s0 + t * A.L, sb = B.s0 + w * B.L;
          if (sa <= 2 * tol || ea.L - sa <= 2 * tol || sb <= 2 * tol || eb.L - sb <= 2 * tol) continue;
          out.push({ x: [x, y], a: A.k, ia: A.i, b: B.k, ib: B.i });
        }
      }
      return out;
    };
    const cr = cruzamientos();
    if (cr.length) {
      // dibujos conectados por los nodos (comp) y cadenas: los trazos seguidos por nodos donde se juntan solo dos. Una cadena
      // es una cuerda si sus dos puntas son nodos distintos (de grado distinto de 2: una T, un cruce, una punta suelta), como
      // las dos rectas de una ventana; si no, es un lazo (un contorno cerrado, o que sale de un nodo y vuelve al mismo, como
      // dos letras superpuestas que se tocan en un punto). Se parte un cruce del mismo dibujo con una cuerda: sin el nodo ahí,
      // las caras de ese dibujo no tienen sentido (no se puede recorrer cada zona por su borde).
      const cp = P.map((_, i) => i), comp = (e) => raizDe(cp, nodo(e.ia));
      for (const e of E) juntar(cp, nodo(e.ia), nodo(e.ib));
      const puntas = cadenas(), cuerda = (k) => { const s = puntas.get(E[k].cad); return !!s && s.size >= 2; };
      const aPartir = cr.filter((c) => comp(E[c.a]) === comp(E[c.b]) && (cuerda(c.a) || cuerda(c.b)));
      if (aPartir.length) {
        const cortes = new Map(), enCruce = new Map();
        // un nodo por cruce (dos cruces en el mismo punto, el mismo nodo)
        const nodoCruce = (x) => {
          const cx = Math.floor(x[0] / eps), cy = Math.floor(x[1] / eps);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const j = enCruce.get(ck(cx + dx, cy + dy)); if (j != null && d2(P[j], x) <= eps) return j; }
          const j = punta(x); enCruce.set(ck(cx, cy), j); return j;
        };
        for (const c of aPartir) {
          const n = nodoCruce(c.x);
          for (const [k, i] of [[c.a, c.ia], [c.b, c.ib]]) { const l = cortes.get(k); const o = { i, x: c.x, n }; if (l) l.push(o); else cortes.set(k, [o]); }
        }
        // cada trazo se parte de la punta para atrás (así los índices de lo que queda antes no cambian)
        for (const [k, l] of cortes) {
          const e = E[k], p0 = e.pts;
          l.sort((u, v) => v.i - u.i || d2(v.x, p0[v.i - 1]) - d2(u.x, p0[u.i - 1]));
          for (const { i, x, n } of l) {
            const pts = e.pts, m = pts.length;
            if (d2(x, pts[m - 1]) <= eps) { juntar(padre, n, e.ib); continue; }
            if (d2(x, pts[0]) <= eps) { juntar(padre, n, e.ia); continue; }
            const j = d2(x, pts[i - 1]) <= eps ? i - 1 : i < m && d2(x, pts[i]) <= eps ? i : -1;
            const A = j >= 0 ? pts.slice(0, j + 1) : pts.slice(0, i).concat([x]), B = j >= 0 ? pts.slice(j) : [x].concat(pts.slice(i)), cv = esCurva(e);
            E.push({ pts: B, L: largoDe(B), ia: n, ib: e.ib, src: e.src, curva: cv, partido: true });
            Object.assign(e, { pts: A, L: largoDe(A), ib: n, bb: null, curva: cv, partido: true });
          }
        }
        asentar(); R = caras(); cruzadas = aPartir.length; partidas = new Set(aPartir);
      }
    }
    const cruzan = cr.filter((c) => !partidas.has(c)).map((c) => c.x);
    const fina = (p) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return Math.abs(a) < tol * (largoDe(p) + d2(p[0], p[p.length - 1])); };
    return { cerradas: R.cerradas, abiertas: R.abiertas, sueltas: R.sueltas, cruces: R.cruces, cruzan, repetidos, partidos, cruzadas, usados: R.usados, nodos: R.nodos, cerradasPorPartir: R.porPartir, crucesSinBuscar: sinBuscar, finas: R.cerradas.filter(fina) };
  }

  const api = { leer, unir, aciRgb };
  raiz.NestDxf = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
