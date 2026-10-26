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

  // Sistema de coordenadas del objeto (OCS) → universal, por el "arbitrary axis algorithm" del DXF. Devuelve f(x, y, z) → [X, Y].
  function ocs(e) {
    let nx = num(e, 210, 0), ny = num(e, 220, 0), nz = num(e, 230, 1);
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    if (Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12 && nz > 0) return null; // el normal de siempre: no hay que transformar
    let ax, ay, az;
    if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) { ax = nz; ay = 0; az = -nx; } // Wy × N
    else { ax = -ny; ay = nx; az = 0; } // Wz × N
    const La = Math.hypot(ax, ay, az); ax /= La; ay /= La; az /= La;
    const bx = ny * az - nz * ay, by = nz * ax - nx * az; // N × Ax (solo X e Y)
    return (x, y, z) => [x * ax + y * bx + z * nx, x * ay + y * by + z * ny];
  }

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

  // Muestrea la curva P(t) tramo por tramo entre los cortes (los nudos): parte cada tramo en 8 por lo menos y sigue partiendo
  // mientras alguno de 7 puntos del medio quede a más de tol del segmento (no de la recta: así se ven las vueltas en punta).
  function muestrear(P, cortes, tol) {
    const pts = [P(cortes[0])];
    const lejos = (a, b, m) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy; let t = L2 > 1e-24 ? ((m[0] - a[0]) * dx + (m[1] - a[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(m[0] - a[0] - t * dx, m[1] - a[1] - t * dy); };
    const partir = (ta, pa, tb, pb, prof) => {
      const tm = (ta + tb) / 2, pm = P(tm);
      let sigue = prof < 3 || lejos(pa, pb, pm) > tol;
      for (let j = 1; j < 8 && !sigue; j++) if (j !== 4 && lejos(pa, pb, P(ta + (tb - ta) * j / 8)) > tol) sigue = true;
      if (sigue && prof < 18) { partir(ta, pa, tm, pm, prof + 1); partir(tm, pm, tb, pb, prof + 1); }
      else pts.push(pb);
    };
    for (let i = 0; i + 1 < cortes.length; i++) { const a = cortes[i], b = cortes[i + 1]; if (b - a > 1e-12) partir(a, P(a), b, P(b), 0); }
    return pts;
  }
  // NURBS (de Boor) en el parámetro t, con pesos.
  function deBoor(k, t, nudos, ctrl, w) {
    const n = ctrl.length - 1;
    let s = k;
    for (let i = k; i < nudos.length - k - 1; i++) if (t >= nudos[i] && t < nudos[i + 1]) { s = i; break; }
    if (t >= nudos[n + 1]) s = n; // el final
    s = Math.min(Math.max(s, k), n);
    const d = [];
    for (let j = 0; j <= k; j++) { const p = ctrl[j + s - k], ww = w ? w[j + s - k] : 1; d.push([p[0] * ww, p[1] * ww, ww]); }
    for (let r = 1; r <= k; r++) for (let j = k; j >= r; j--) {
      const i = j + s - k, den = nudos[i + k - r + 1] - nudos[i];
      const a = den > 1e-14 ? (t - nudos[i]) / den : 0;
      d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
    }
    const q = d[k]; return [q[0] / q[2], q[1] / q[2]];
  }
  function spline(e, tol, avisos) {
    const k = Math.round(num(e, 71, 3)), flag = Math.round(num(e, 70, 0));
    const nudos = todos(e, 40), wts = todos(e, 41);
    const cx = todos(e, 10), cy = todos(e, 20), fx = todos(e, 11), fy = todos(e, 21);
    const ctrl = cx.map((x, i) => [x, cy[i]]);
    if (k < 1 || ctrl.length < 2 || nudos.length !== ctrl.length + k + 1) {
      if (fx.length >= 2) { const s = porAjuste(e, fx.map((x, i) => [x, fy[i]]), !!(flag & 1), tol); if (s) avisos.splineAjuste++; return s; }
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
    if (cerrar && Math.hypot(F[0][0] - F[F.length - 1][0], F[0][1] - F[F.length - 1][1]) > 1e-9) F = F.concat([F[0]]);
    const Q = [F[0]];
    for (const p of F) if (isFinite(p[0]) && isFinite(p[1]) && Math.hypot(p[0] - Q[Q.length - 1][0], p[1] - Q[Q.length - 1][1]) > 1e-9) Q.push(p);
    const n = Q.length;
    if (n < 2) return null;
    const s = [0];
    for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(Q[i][0] - Q[i - 1][0], Q[i][1] - Q[i - 1][1]));
    const tg = (c1, c2, c3) => { const x = num(e, c1, NaN), y = num(e, c2, NaN), L = Math.hypot(x, y, num(e, c3, 0)); return isFinite(L) && L > 1e-12 ? [x / L, y / L] : null; };
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
    const X = Q.map((p) => p[0]), Y = Q.map((p) => p[1]);
    const MX = segundas(X, t0 && t0[0], t1 && t1[0]), MY = segundas(Y, t0 && t0[1], t1 && t1[1]);
    let i = 0;
    const P = (t) => {
      while (i > 0 && t < s[i]) i--;
      while (i < n - 2 && t > s[i + 1]) i++;
      const h = s[i + 1] - s[i], A = (s[i + 1] - t) / h, B = (t - s[i]) / h, k = h * h / 6, a3 = A * A * A - A, b3 = B * B * B - B;
      return [A * X[i] + B * X[i + 1] + (a3 * MX[i] + b3 * MX[i + 1]) * k, A * Y[i] + B * Y[i + 1] + (a3 * MY[i] + b3 * MY[i + 1]) * k];
    };
    const pts = muestrear(P, s, tol);
    pts[0] = Q[0]; pts[pts.length - 1] = Q[n - 1];
    return { pts, cerrado: cerrar || Math.hypot(Q[0][0] - Q[n - 1][0], Q[0][1] - Q[n - 1][1]) < 1e-9 };
  }

  function elipse(e, tol) {
    const c = [num(e, 10, 0), num(e, 20, 0)], M = [num(e, 11, 0), num(e, 21, 0), num(e, 31, 0)], ra = num(e, 40, 1);
    let nx = num(e, 210, 0), ny = num(e, 220, 0), nz = num(e, 230, 1);
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    const m = [(ny * M[2] - nz * M[1]) * ra, (nz * M[0] - nx * M[2]) * ra]; // eje menor = ratio · (N × mayor), en 3D; de él, X e Y
    // parámetros fuera de [0, 2π): se llevan adentro; 0 a 2π es la elipse entera
    const p0 = num(e, 41, 0), a0 = mod(p0, 2 * Math.PI);
    let vuelta = mod(num(e, 42, 2 * Math.PI) - p0, 2 * Math.PI);
    if (vuelta < 1e-9) vuelta = 2 * Math.PI;
    const entera = Math.abs(vuelta - 2 * Math.PI) < 1e-9;
    const R = Math.hypot(M[0], M[1], M[2]), n = Math.min(MAX_TRAMOS, Math.max(entera ? 8 : 1, Math.ceil(vuelta / pasoArco(R, tol))));
    const pts = [];
    for (let i = 0; i < (entera ? n : n + 1); i++) { const t = a0 + vuelta * i / n; pts.push([c[0] + M[0] * Math.cos(t) + m[0] * Math.sin(t), c[1] + M[1] * Math.cos(t) + m[1] * Math.sin(t)]); }
    return { pts, cerrado: entera };
  }

  // Una entidad a subtrazos; null si no dibuja nada que se corte.
  function geometria(e, tol, av) {
    const T = ocs(e), tr = (pts) => (T ? pts.map(([x, y]) => T(x, y, num(e, 38, num(e, 30, 0)))) : pts);
    switch (e.tipo) {
      case 'LINE': return [{ pts: [[num(e, 10, 0), num(e, 20, 0)], [num(e, 11, 0), num(e, 21, 0)]], cerrado: false }];
      case 'ARC': {
        const cx = num(e, 10, 0), cy = num(e, 20, 0), r = num(e, 40, 0);
        if (!(r > 0)) return null;
        // ángulos fuera de [0, 360): se llevan adentro (un ARC de -30° a 400° va de 330° a 40°: 70°)
        const d0 = num(e, 50, 0), a0 = mod(d0, 360) * Math.PI / 180;
        let vuelta = mod(num(e, 51, 360) - d0, 360);
        if (vuelta < 1e-9) vuelta = 360;
        const pts = []; arco(pts, cx, cy, r, a0, a0 + vuelta * Math.PI / 180, tol, true);
        return [{ pts: tr(pts), cerrado: false }];
      }
      case 'CIRCLE': {
        const cx = num(e, 10, 0), cy = num(e, 20, 0), r = num(e, 40, 0);
        if (!(r > 0)) return null;
        const pts = []; arco(pts, cx, cy, r, 0, 2 * Math.PI, tol, true); pts.pop();
        if (pts.length < 8) { pts.length = 0; for (let i = 0; i < 8; i++) pts.push([cx + r * Math.cos(i * Math.PI / 4), cy + r * Math.sin(i * Math.PI / 4)]); }
        return [{ pts: tr(pts), cerrado: true, circulo: true }];
      }
      case 'ELLIPSE': return [elipse(e, tol)];
      case 'SPLINE': { const s = spline(e, tol, av); return s ? [s] : null; }
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
    return [{ pts: tr(pts), cerrado: cerrado && pts.length >= 3 }];
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
        if (e.tipo === 'BLOCK') { cur = { base: [num(e, 10, 0), num(e, 20, 0)], ents: [] }; bloques[uno(e, 2, '')] = cur; }
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
    // lo más que estira M (su norma espectral). Así un DXF en metros o un bloque a escala 4 también quedan a tol en mm.
    const tolEn = (M) => { const [p, q, r, t] = M, s2 = p * p + q * q + r * r + t * t, d = Math.hypot(p * p + q * q - r * r - t * t, 2 * (p * r + q * t)); return tol / (factor * Math.max(1e-9, Math.sqrt((s2 + d) / 2))); };
    const seVe = (e, capaPadre, colorPadre) => !colorDe(e, capaPadre, colorPadre).apagada;
    const recorrer = (lista, M, capaPadre, colorPadre, prof) => {
      for (let i = 0; i < lista.length; i++) {
        const e = lista[i];
        if (Math.round(num(e, 67, 0)) === 1) continue; // espacio papel
        if (e.tipo === 'POLYLINE') { // viene seguida de VERTEX... SEQEND
          const vs = []; let j = i + 1;
          for (; j < lista.length && lista[j].tipo === 'VERTEX'; j++) {
            const fv = Math.round(num(lista[j], 70, 0));
            if (fv & (16 | 64 | 128)) continue; // marco de spline, malla, cara
            vs.push({ p: [num(lista[j], 10, 0), num(lista[j], 20, 0)], b: num(lista[j], 42, 0) });
          }
          if (j < lista.length && lista[j].tipo === 'SEQEND') j++;
          i = j - 1;
          const fl = Math.round(num(e, 70, 0));
          if (fl & (16 | 64)) { otros.MALLA = (otros.MALLA || 0) + 1; continue; }
          const T = fl & 8 ? null : ocs(e), tr = (pts) => (T ? pts.map(([x, y]) => T(x, y, num(e, 30, 0))) : pts);
          const g = polilinea(vs, !!(fl & 1), tolEn(M), tr);
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
          // extrusión (0, 0, -1) queda espejada entera, no solo en X.
          const p = [num(e, 10, 0), num(e, 20, 0)];
          const T = ocs(e), W = T ? [...T(1, 0, 0), ...T(0, 1, 0), ...T(0, 0, num(e, 30, 0))] : null;
          for (let f = 0; f < nf; f++) for (let c = 0; c < nc; c++) {
            const ox = c * dc, oy = f * df;
            // local: (x - base)·escala, girado, + inserción (+ la grilla del arreglo, girada)
            const L = [sx * cs, sx * sn, -sy * sn, sy * cs, p[0] + ox * cs - oy * sn - (b.base[0] * sx * cs - b.base[1] * sy * sn), p[1] + ox * sn + oy * cs - (b.base[0] * sx * sn + b.base[1] * sy * cs)];
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
      const f = (x, y) => [(M[0] * x + M[2] * y + M[4]) * factor, (M[1] * x + M[3] * y + M[5]) * factor];
      const out = [];
      for (const s of subs) {
        const pts = s.pts.filter((p) => isFinite(p[0]) && isFinite(p[1])).map(([x, y]) => f(x, y));
        puntos += pts.length;
        if (pts.length >= 2) out.push({ pts, cerrado: s.cerrado && pts.length >= 3, circulo: !!s.circulo, ent: e.tipo });
      }
      if (puntos > MAX_PUNTOS) throw new Error('El DXF es demasiado grande para leerlo acá (más de 5 millones de puntos). Puede estar roto.');
      if (out.length) els.push({ subs: out, capa, rgb });
    };
    recorrer(entidades(ps, secciones.ENTITIES[0], secciones.ENTITIES[1]), [1, 0, 0, 1, 0, 0], '', null, 0);
    return { els, unidades: ins, unidadConocida: conocida, factor, textos, otros, avisos: av, capas: Object.keys(capas) };
  }
  // M aplicada después de L (las dos como [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f).
  function componer(L, M) {
    return [L[0] * M[0] + L[1] * M[2], L[0] * M[1] + L[1] * M[3], L[2] * M[0] + L[3] * M[2], L[2] * M[1] + L[3] * M[3], L[4] * M[0] + L[5] * M[2] + M[4], L[4] * M[1] + L[5] * M[3] + M[5]];
  }

  // ───────────── unir trazos sueltos ─────────────
  // abiertos: [{pts}] (trazos abiertos de un mismo tipo). Arma un grafo: cada trazo es una arista entre sus dos puntas (nodos).
  //  1. Las puntas prácticamente iguales (a 0,0001 mm o menos) son el mismo nodo, y los trazos repetidos (entre los mismos
  //     nodos y por el mismo camino) se toman una vez.
  //  2. Las puntas que quedan sueltas se juntan de a dos, las más cercanas primero, si están a tol o menos.
  //  3. Una punta que sigue suelta y cae a tol o menos del medio de otro trazo lo parte ahí: una T (Fusion no parte una recta
  //     cuando otra termina en su medio).
  //  4. Cada zona que encierran los trazos es una figura cerrada (las caras del dibujo): dos piezas pegadas por un lado salen
  //     como dos figuras y el lado compartido va en las dos. Un hueco que toca el borde en una punta sale aparte. No depende
  //     del orden de los trazos en el archivo.
  //  5. Lo que no encierra nada (colas, líneas sueltas, puentes entre figuras) queda abierto, en cadenas que siguen por donde
  //     va más derecho, sin pasar por las figuras.
  // Ningún trazo se tira por corto. Devuelve { cerradas: [pts], abiertas: [{pts, falta, toca}], sueltas: [[x, y]],
  // cruces: [[x, y]], repetidos, partidos, usados, nodos }. falta: lo que le falta a una abierta para cerrar; toca: sale de una
  // figura cerrada (ahí falta no es un hueco). usados: cuántos trazos forman parte de alguna figura cerrada.
  function unir(abiertos, tol) {
    tol = Math.max(1e-6, +tol || 0);
    const eps = Math.min(tol, 1e-4), d2 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]), ck = (x, y) => x + ',' + y;
    const largoDe = (p) => { let L = 0; for (let i = 1; i < p.length; i++) L += d2(p[i], p[i - 1]); return L; };
    // Aristas sin puntos repetidos seguidos (con un vértice doble no se puede medir para dónde sale). P: puntas; padre: qué
    // puntas son el mismo nodo (unión de conjuntos); cpadre: qué puntas están en el mismo dibujo conectado.
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
      E.push({ pts: p, L: largoDe(p), ia, ib, src: k });
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
    // 2. puntas sueltas: de a dos, las más cercanas primero, a tol o menos
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
    const tomada = new Set();
    for (const [, n, m] of pares) {
      if (tomada.has(n) || tomada.has(m)) continue;
      const cn = raizDe(cpadre, n), cm = raizDe(cpadre, m);
      if (cn === cm && largoComp.get(cn) <= 3 * tol) continue; // las dos puntas de un trazo cortito: cerrarlo no da una figura
      tomada.add(n); tomada.add(m);
      juntar(padre, n, m);
      if (cn !== cm) largoComp.set(juntar(cpadre, cn, cm), largoComp.get(cn) + largoComp.get(cm));
    }
    // 3. T: una punta que sigue suelta, a tol o menos del medio de otro trazo (o de su propio trazo, lejos de esa punta)
    let partidos = 0;
    gr = grados();
    // grilla de trazos: cada uno en las celdas que toca su caja (agrandada en tol) o, si la caja es grande (una recta larga en
    // diagonal), en las que tocan sus tramos; los desmedidos van aparte y se miran siempre
    const C = Math.max(4 * tol, 5), grillaE = new Map(), largas = [];
    const caja = (e) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of e.pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } e.bb = [x0, y0, x1, y1]; };
    const enCelda = (k, e) => { const l = grillaE.get(k); if (l) l.push(e); else grillaE.set(k, [e]); };
    const indexar = (e) => {
      caja(e);
      const x0 = Math.floor((e.bb[0] - tol) / C), x1 = Math.floor((e.bb[2] + tol) / C), y0 = Math.floor((e.bb[1] - tol) / C), y1 = Math.floor((e.bb[3] + tol) / C);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 64) { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) enCelda(ck(x, y), e); return; }
      if (e.L > 5000 * C) { largas.push(e); return; }
      const r = tol + C / 4, celdas = new Set(); // cada punto a tol o menos del tramo queda a r o menos de una muestra (cada C/2)
      for (let i = 1; i < e.pts.length; i++) {
        const a = e.pts[i - 1], b = e.pts[i], n = Math.max(1, Math.ceil(d2(a, b) / (C / 2)));
        for (let j = 0; j <= n; j++) {
          const x = a[0] + (b[0] - a[0]) * j / n, y = a[1] + (b[1] - a[1]) * j / n;
          for (let cx = Math.floor((x - r) / C); cx <= Math.floor((x + r) / C); cx++) for (let cy = Math.floor((y - r) / C); cy <= Math.floor((y + r) / C); cy++) celdas.add(ck(cx, cy));
        }
      }
      for (const k of celdas) enCelda(k, e);
    };
    if ([...gr.values()].some((x) => x === 1)) E.forEach(indexar);
    const grado = (i) => gr.get(nodo(i)) || 0;
    const pegar = (i, j) => { const a = grado(i), b = grado(j); gr.set(juntar(padre, i, j), a + b); };
    for (const [n0, g] of [...gr]) {
      if (g !== 1 || grado(n0) !== 1) continue; // ya no está suelta (se le pegó otra)
      const n = nodo(n0), p = P[n], cand = (grillaE.get(ck(Math.floor(p[0] / C), Math.floor(p[1] / C))) || []).concat(largas);
      let propia = null, fin = 0;
      for (const e of cand) { if (nodo(e.ia) === n) { propia = e; fin = 0; } if (nodo(e.ib) === n) { propia = e; fin = 1; } }
      if (!propia) continue;
      let mejor = null;
      for (const e of cand) {
        if (!e.bb) caja(e);
        if (p[0] < e.bb[0] - tol || p[0] > e.bb[2] + tol || p[1] < e.bb[1] - tol || p[1] > e.bb[3] + tol) continue;
        let acum = 0;
        for (let i = 1; i < e.pts.length; i++) {
          const a = e.pts[i - 1], b = e.pts[i], vx = b[0] - a[0], vy = b[1] - a[1], L2 = vx * vx + vy * vy, L = Math.sqrt(L2);
          let t = L2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2 : 0; t = Math.max(0, Math.min(1, t));
          const q = [a[0] + t * vx, a[1] + t * vy], d = d2(p, q), s = acum + t * L;
          // no cuenta: cerca de su propia punta, ni a 2·tol o menos de una punta suelta del otro trazo (eso no es una T: son dos
          // puntas que no se tocan, o se pasan una de la otra, y quedan abiertas)
          const noT = (e === propia && Math.abs(s - (fin ? e.L : 0)) <= 3 * tol) || (s <= 2 * tol && grado(e.ia) === 1) || (e.L - s <= 2 * tol && grado(e.ib) === 1);
          if (d <= tol && (!mejor || d < mejor.d) && !noT) mejor = { d, e, i, q };
          acum += L;
        }
      }
      if (!mejor) continue;
      const { e, i, q } = mejor, m = e.pts.length;
      let destino;
      if (i === 1 && d2(q, e.pts[0]) <= eps) destino = e.ia; // cae en una punta: es ese nodo
      else if (i === m - 1 && d2(q, e.pts[m - 1]) <= eps) destino = e.ib;
      else { // parte el trazo ahí
        const k = d2(q, e.pts[i - 1]) <= eps ? i - 1 : d2(q, e.pts[i]) <= eps ? i : -1;
        const A = k >= 0 ? e.pts.slice(0, k + 1) : e.pts.slice(0, i).concat([q]), B = k >= 0 ? e.pts.slice(k) : [q].concat(e.pts.slice(i));
        destino = punta(A[A.length - 1]); gr.set(destino, 2);
        const nueva = { pts: B, L: largoDe(B), ia: destino, ib: e.ib, src: e.src };
        E.push(nueva); indexar(nueva);
        Object.assign(e, { pts: A, L: largoDe(A), ib: destino, bb: null }); // queda en las celdas de antes: sobra, no falta
        partidos++;
      }
      pegar(n, destino);
    }
    if (partidos || tomada.size) sacarRepetidos();
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
    const guardar = (pts, ars) => {
      if (pts.length > 1 && d2(pts[0], pts[pts.length - 1]) <= eps) pts.pop();
      if (pts.length < 3 || !(area(pts) > 1e-6)) return; // horaria: el borde de afuera, o un hueco que toca el borde
      cerradas.push(pts);
      for (const k of ars) enFigura[k] = 1;
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
      if (n === n0 && pareja.has(h0)) { if (d2(pts[0], pts[pts.length - 1]) <= eps) pts.pop(); if (pts.length >= 3) { cerradas.push(pts); for (const k of ars) enFigura[k] = 1; return; } } // una vuelta que se cruza a sí misma (un 8): queda cerrada, como vino
      abiertas.push({ pts, falta: d2(pts[0], pts[pts.length - 1]), toca: !!(toca[n0] || toca[n]) });
    };
    salLibre.forEach((l) => { for (const h of l) if (!hecha[h >> 1] && !pareja.has(h)) camino(h); });
    salLibre.forEach((l) => { for (const h of l) if (!hecha[h >> 1]) camino(h); });
    const sueltas = [], cruces = [], usados = new Set();
    nodos.forEach((nd) => { if (nd.sal.length === 1) sueltas.push(nd.p); else if (nd.sal.length > 2) cruces.push(nd.p); });
    E.forEach((e, k) => { if (enFigura[k]) usados.add(e.src); });
    return { cerradas, abiertas, sueltas, cruces, repetidos, partidos, usados: usados.size, nodos: nodos.length };
  }

  const api = { leer, unir, aciRgb };
  raiz.NestDxf = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
