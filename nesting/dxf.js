// Lector de DXF para el nesting (Gaspar 26-oct-2026). Lee un DXF de texto (R12 a 2018: Fusion 360, AutoCAD, Illustrator,
// Inkscape) y devuelve los dibujos en milímetros, con Y para arriba, como los del PDF: { subs: [{pts, cerrado}], clave,
// capa, rgb }. Pasa a tramos rectos LINE, ARC, CIRCLE, ELLIPSE, SPLINE (NURBS), LWPOLYLINE y POLYLINE (con sus curvas) y
// abre los bloques (INSERT). Cuenta los textos y lo que no lee. No une nada: los trazos sueltos los une unir().
// También está unir(): junta trazos abiertos cuyas puntas se tocan (a una tolerancia) en figuras cerradas, como "Unir" de
// Illustrator. Fusion 360 exporta cada línea, arco y curva por separado, sin unir.
(function (raiz) {
  'use strict';

  // Colores del AutoCAD (ACI) más usados; el resto se aproxima por la rueda de 24 tonos de la paleta.
  const ACI = { 1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255], 5: [0, 0, 255], 6: [255, 0, 255], 7: [255, 255, 255], 8: [128, 128, 128], 9: [192, 192, 192] };
  function aciRgb(n) {
    n = Math.abs(n | 0);
    if (ACI[n]) return ACI[n];
    if (n >= 250 && n <= 255) { const g = Math.round(51 + (n - 250) * 40.8); return [g, g, g]; }
    if (n >= 10 && n <= 249) {
      const h = ((n - 10) >> 3) * 15, f = (n - 10) & 7, v = f & 2 ? 0.65 : 1, s = f & 1 ? 0.5 : 1, oscuro = f >= 4 ? 0.55 : 1;
      const c = v * oscuro, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = c * (1 - s);
      const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
      return [Math.round((r * s + m) * 255), Math.round((g * s + m) * 255), Math.round((b * s + m) * 255)];
    }
    return [255, 255, 255];
  }
  const UNIDADES = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4, 13: 0.001, 14: 100 };

  // Pares (código, valor) del archivo.
  function pares(texto) {
    const l = texto.split(/\r\n|\r|\n/), out = [];
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

  // Arco de circunferencia a tramos rectos con error de cuerda <= tol. Ángulos en radianes, a1 > a0 (antihorario).
  function arco(out, cx, cy, r, a0, a1, tol, conInicio) {
    const paso = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 2;
    const n = Math.max(1, Math.ceil((a1 - a0) / Math.max(1e-6, paso)));
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
    const a0 = Math.atan2(p[1] - cy, p[0] - cx), paso = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 2;
    const n = Math.max(1, Math.ceil(Math.abs(th) / paso));
    for (let i = 1; i < n; i++) { const a = a0 + th * i / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    out.push(q); // la punta exacta: así no se abre por redondeo
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
    if (ctrl.length < 2 || nudos.length !== ctrl.length + k + 1) {
      if (fx.length >= 2) { avisos.splineAprox++; return { pts: fx.map((x, i) => [x, fy[i]]), cerrado: !!(flag & 1) }; } // solo puntos de ajuste: se unen con rectas
      return null;
    }
    const w = wts.length === ctrl.length && wts.some((x) => Math.abs(x - 1) > 1e-12) ? wts : null;
    const t0 = nudos[k], t1 = nudos[ctrl.length];
    const P = (t) => deBoor(k, Math.min(t, t1), nudos, ctrl, w);
    const pts = [P(t0)];
    const lejos = (a, b, m) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); return L < 1e-12 ? Math.hypot(m[0] - a[0], m[1] - a[1]) : Math.abs((m[0] - a[0]) * dy - (m[1] - a[1]) * dx) / L; };
    const partir = (ta, pa, tb, pb, prof) => {
      const tm = (ta + tb) / 2, pm = P(tm), q1 = P(ta + (tb - ta) / 4), q3 = P(ta + 3 * (tb - ta) / 4);
      if (prof < 18 && (prof < 2 || lejos(pa, pb, pm) > tol || lejos(pa, pb, q1) > tol || lejos(pa, pb, q3) > tol)) { partir(ta, pa, tm, pm, prof + 1); partir(tm, pm, tb, pb, prof + 1); }
      else pts.push(pb);
    };
    for (let i = k; i < ctrl.length; i++) { // tramo por tramo entre nudos distintos
      const a = nudos[i], b = nudos[i + 1];
      if (b - a > 1e-12) partir(a, P(a), b, P(b), 0);
    }
    if (nudos[0] === nudos[k]) pts[0] = ctrl[0];
    if (nudos[nudos.length - 1] === nudos[nudos.length - 1 - k]) pts[pts.length - 1] = ctrl[ctrl.length - 1];
    const cerrado = !!(flag & 1) || Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9;
    return { pts, cerrado };
  }

  function elipse(e, tol) {
    const c = [num(e, 10, 0), num(e, 20, 0)], M = [num(e, 11, 0), num(e, 21, 0)], ra = num(e, 40, 1);
    let nz = num(e, 230, 1); nz = nz < 0 ? -1 : 1;
    const m = [-M[1] * ra * nz, M[0] * ra * nz]; // eje menor = ratio · (N × mayor)
    let a0 = num(e, 41, 0), a1 = num(e, 42, 2 * Math.PI);
    while (a1 <= a0 + 1e-12) a1 += 2 * Math.PI;
    const entera = Math.abs(a1 - a0 - 2 * Math.PI) < 1e-9;
    const R = Math.hypot(M[0], M[1]), paso = R > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / R)) : Math.PI / 2;
    const n = Math.max(entera ? 8 : 1, Math.ceil((a1 - a0) / paso));
    const pts = [];
    for (let i = 0; i <= n; i++) { if (entera && i === n) break; const t = a0 + (a1 - a0) * i / n; pts.push([c[0] + M[0] * Math.cos(t) + m[0] * Math.sin(t), c[1] + M[1] * Math.cos(t) + m[1] * Math.sin(t)]); }
    return { pts, cerrado: entera };
  }

  // Una entidad a subtrazos; null si no dibuja nada que se corte.
  function geometria(e, tol, av) {
    const T = ocs(e), tr = (pts) => (T ? pts.map(([x, y]) => T(x, y, num(e, 38, num(e, 30, 0)))) : pts);
    switch (e.tipo) {
      case 'LINE': return [{ pts: [[num(e, 10, 0), num(e, 20, 0)], [num(e, 11, 0), num(e, 21, 0)]], cerrado: false }];
      case 'ARC': {
        const cx = num(e, 10, 0), cy = num(e, 20, 0), r = num(e, 40, 0);
        let a0 = num(e, 50, 0) * Math.PI / 180, a1 = num(e, 51, 360) * Math.PI / 180;
        while (a1 <= a0 + 1e-12) a1 += 2 * Math.PI;
        if (!(r > 0)) return null;
        const pts = []; arco(pts, cx, cy, r, a0, a1, tol, true);
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

  // Lee el DXF. tol = error máximo de las curvas (mm). Devuelve { els, unidades, textos, otros: {tipo: n}, avisos }.
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
    const factor = UNIDADES[ins] != null ? UNIDADES[ins] : 1;
    // Capas: color y si está apagada (color negativo) o congelada (bit 1)
    const capas = {};
    if (secciones.TABLES) {
      const [a, b] = secciones.TABLES;
      for (const e of entidades(ps, a, b)) if (e.tipo === 'LAYER') {
        const nom = uno(e, 2, '0'), col = Math.round(num(e, 62, 7)), fl = Math.round(num(e, 70, 0)), tc = uno(e, 420, null);
        capas[nom] = { color: col, rgb: tc != null ? [(+tc >> 16) & 255, (+tc >> 8) & 255, +tc & 255] : aciRgb(col), apagada: col < 0 || !!(fl & 1) };
      }
    }
    // Bloques
    const bloques = {};
    if (secciones.BLOCKS) {
      const [a, b] = secciones.BLOCKS, es = entidades(ps, a, b);
      let cur = null;
      for (const e of es) {
        if (e.tipo === 'BLOCK') { cur = { base: [num(e, 10, 0), num(e, 20, 0)], ents: [] }; bloques[uno(e, 2, '')] = cur; }
        else if (e.tipo === 'ENDBLK') cur = null;
        else if (cur) cur.ents.push(e);
      }
    }
    const av = { splineAprox: 0, tresD: 0, profundo: 0 };
    const otros = {}, els = [];
    let textos = 0;
    const colorDe = (e, capaPadre, colorPadre) => {
      let capa = uno(e, 8, '0');
      if (capa === '0' && capaPadre) capa = capaPadre; // lo de la capa 0 adentro de un bloque toma la capa del bloque
      const info = capas[capa] || { color: 7, rgb: [255, 255, 255], apagada: false };
      const tc = uno(e, 420, null);
      let col = Math.round(num(e, 62, 256)), rgb;
      if (tc != null) rgb = [(+tc >> 16) & 255, (+tc >> 8) & 255, +tc & 255];
      else if (col === 0) rgb = colorPadre || info.rgb;         // BYBLOCK
      else if (col === 256 || isNaN(col)) rgb = info.rgb;      // BYLAYER
      else rgb = aciRgb(col);
      return { capa, rgb, apagada: info.apagada || col < 0 };
    };
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
          const g = polilinea(vs, !!(fl & 1), tol, tr);
          if (g) emitir(e, g, M, capaPadre, colorPadre);
          continue;
        }
        if (e.tipo === 'INSERT') {
          const b = bloques[uno(e, 2, '')];
          if (!b) continue;
          if (prof > 8) { av.profundo++; continue; }
          const sx = num(e, 41, 1), sy = num(e, 42, 1), rot = num(e, 50, 0) * Math.PI / 180, cs = Math.cos(rot), sn = Math.sin(rot);
          const nc = Math.max(1, Math.round(num(e, 70, 1))), nf = Math.max(1, Math.round(num(e, 71, 1))), dc = num(e, 44, 0), df = num(e, 45, 0);
          let p = [num(e, 10, 0), num(e, 20, 0)];
          const T = ocs(e); if (T) p = T(p[0], p[1], num(e, 30, 0));
          const { capa, rgb } = colorDe(e, capaPadre, colorPadre);
          for (let f = 0; f < nf; f++) for (let c = 0; c < nc; c++) {
            const ox = c * dc, oy = f * df;
            // local: (x - base)·escala, girado, + inserción (+ la grilla del arreglo, girada)
            const L = [sx * cs, sx * sn, -sy * sn, sy * cs, p[0] + ox * cs - oy * sn - (b.base[0] * sx * cs - b.base[1] * sy * sn), p[1] + ox * sn + oy * cs - (b.base[0] * sx * sn + b.base[1] * sy * cs)];
            if (T) { L[0] = T(L[0], L[1], 0)[0] - T(0, 0, 0)[0]; } // (extrusiones raras en bloques: se aproxima)
            recorrer(b.ents, componer(L, M), capa, rgb, prof + 1);
          }
          continue;
        }
        if (e.tipo === 'TEXT' || e.tipo === 'MTEXT' || e.tipo === 'ATTRIB' || e.tipo === 'ATTDEF') { textos++; continue; }
        if (e.tipo === 'VERTEX' || e.tipo === 'SEQEND' || e.tipo === 'ENDBLK' || e.tipo === 'BLOCK') continue;
        const g = geometria(e, tol, av);
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
        if (pts.length >= 2) out.push({ pts, cerrado: s.cerrado && pts.length >= 3, circulo: !!s.circulo, ent: e.tipo });
      }
      if (out.length) els.push({ subs: out, capa, rgb });
    };
    recorrer(entidades(ps, secciones.ENTITIES[0], secciones.ENTITIES[1]), [1, 0, 0, 1, 0, 0], '', null, 0);
    return { els, unidades: ins, factor, textos, otros, avisos: av, capas: Object.keys(capas) };
  }
  // M aplicada después de L (las dos como [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f).
  function componer(L, M) {
    return [L[0] * M[0] + L[1] * M[2], L[0] * M[1] + L[1] * M[3], L[2] * M[0] + L[3] * M[2], L[2] * M[1] + L[3] * M[3], L[4] * M[0] + L[5] * M[2] + M[4], L[4] * M[1] + L[5] * M[3] + M[5]];
  }

  // ───────────── unir trazos sueltos ─────────────
  // abiertos: [{pts}] (trazos abiertos de un mismo tipo). Las puntas a tol o menos se toman como el mismo punto (nodo).
  // Recorre cada cadena de trazos que se tocan punta con punta: si vuelve al nodo donde arrancó es una figura cerrada; si no,
  // queda abierta con sus dos puntas sueltas. Donde se juntan más de dos trazos (un cruce) sigue por el más derecho.
  // Devuelve { cerradas: [pts], abiertas: [{pts, falta}], sueltas: [[x, y]], cruces: [[x, y]], repetidos, usados }.
  function unir(abiertos, tol) {
    const segs = [];
    let repetidos = 0;
    for (const s of abiertos) {
      const p = s.pts; if (!p || p.length < 2) continue;
      let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      if (L <= tol) continue; // un punto: no dibuja nada
      segs.push({ pts: p, L, a: p[0], b: p[p.length - 1], m: p[Math.floor(p.length / 2)] });
    }
    // repetidos: mismas puntas (en cualquier sentido), mismo largo y mismo punto del medio
    const vistos = new Map(), unicos = [];
    const kq = (p) => Math.round(p[0] / Math.max(tol, 0.01)) + ',' + Math.round(p[1] / Math.max(tol, 0.01));
    const cercaP = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1]) <= Math.max(tol, 0.01) * 2;
    for (const s of segs) {
      const k = [kq(s.a), kq(s.b)].sort().join('|') + '|' + Math.round(s.L / Math.max(tol, 0.01));
      const l = vistos.get(k) || [];
      if (l.some((o) => Math.abs(o.L - s.L) <= Math.max(tol, 0.01) * 2 && ((cercaP(o.a, s.a) && cercaP(o.b, s.b)) || (cercaP(o.a, s.b) && cercaP(o.b, s.a))) && (o.pts.length < 3 || cercaP(o.m, s.m) || cercaP(o.pts[o.pts.length - 1 - Math.floor(o.pts.length / 2)], s.m)))) { repetidos++; continue; }
      l.push(s); vistos.set(k, l); unicos.push(s);
    }
    // nodos: las puntas a tol o menos son el mismo nodo (grilla de celdas de tamaño tol)
    const nodos = [], grilla = new Map(), celda = Math.max(tol, 1e-6);
    const nodoDe = (p) => {
      const cx = Math.floor(p[0] / celda), cy = Math.floor(p[1] / celda);
      let mejor = -1, md = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const l = grilla.get((cx + dx) + ',' + (cy + dy)); if (!l) continue;
        for (const n of l) { const d = Math.hypot(nodos[n].p[0] - p[0], nodos[n].p[1] - p[1]); if (d <= tol && d < md) { md = d; mejor = n; } }
      }
      if (mejor >= 0) return mejor;
      nodos.push({ p, ady: [] }); const k = cx + ',' + cy; (grilla.get(k) || grilla.set(k, []).get(k)).push(nodos.length - 1);
      return nodos.length - 1;
    };
    unicos.forEach((s, i) => { s.na = nodoDe(s.a); s.nb = nodoDe(s.b); nodos[s.na].ady.push(i); nodos[s.nb].ady.push(i); });
    const usado = new Uint8Array(unicos.length), cerradas = [], abiertas = [];
    const otroNodo = (s, n) => (s.na === n ? s.nb : s.na);
    const orientado = (s, desde) => (s.na === desde ? s.pts : s.pts.slice().reverse());
    const dir = (pts, alFinal) => { const n = pts.length; const a = alFinal ? pts[n - 2] : pts[1], b = alFinal ? pts[n - 1] : pts[0]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return alFinal ? [(b[0] - a[0]) / L, (b[1] - a[1]) / L] : [(a[0] - b[0]) / L, (a[1] - b[1]) / L]; };
    const siguiente = (n, llegada) => { // el trazo libre que sale de n más derecho respecto de la dirección de llegada
      let mejor = -1, mc = -Infinity;
      for (const i of nodos[n].ady) {
        if (usado[i]) continue;
        const d = dir(orientado(unicos[i], n), false), c = llegada ? llegada[0] * d[0] + llegada[1] * d[1] : 0;
        if (c > mc) { mc = c; mejor = i; }
      }
      return mejor;
    };
    const lazo = (p) => { if (p.length > 2 && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) <= tol) p.pop(); if (p.length >= 3) cerradas.push(p); };
    const cadena = (i0, n0) => { // arranca en el nodo n0 con el trazo i0
      let pts = []; let n = n0, i = i0;
      const visto = new Map([[n0, 0]]); // nodo → posición en pts
      while (i >= 0) {
        usado[i] = 1;
        const o = orientado(unicos[i], n);
        for (let k = pts.length ? 1 : 0; k < o.length; k++) pts.push(o[k]);
        n = otroNodo(unicos[i], n);
        if (n === n0 && !abiertaIni) return { pts, cerrada: true };
        if (visto.has(n)) { // volvió a pasar por acá: lo del medio es un lazo cerrado y la cadena sigue desde este nodo
          const k0 = visto.get(n); lazo(pts.slice(k0));
          pts = pts.slice(0, k0 + 1);
          for (const [nn, kk] of [...visto]) if (kk > k0) visto.delete(nn);
        } else visto.set(n, pts.length - 1);
        i = siguiente(n, pts.length > 1 ? dir(pts, true) : null);
      }
      return { pts, cerrada: false, fin: n };
    };
    let abiertaIni = false;
    // primero las cadenas que empiezan en una punta suelta (nodo con un solo trazo), después los lazos
    const orden = nodos.map((nd, n) => n).sort((u, v) => (nodos[u].ady.length === 1 ? 0 : 1) - (nodos[v].ady.length === 1 ? 0 : 1));
    for (const n of orden) {
      for (;;) {
        const i = siguiente(n, null); if (i < 0) break;
        abiertaIni = nodos[n].ady.length === 1; // desde una punta suelta no se vuelve: lo que cierre es un lazo de la cola
        const c = cadena(i, n);
        if (c.cerrada) lazo(c.pts);
        else if (c.pts.length >= 2) abiertas.push({ pts: c.pts, falta: Math.hypot(c.pts[0][0] - c.pts[c.pts.length - 1][0], c.pts[0][1] - c.pts[c.pts.length - 1][1]) });
      }
    }
    const sueltas = [], cruces = [];
    nodos.forEach((nd) => { if (nd.ady.length === 1) sueltas.push(nd.p); else if (nd.ady.length > 2) cruces.push(nd.p); });
    return { cerradas, abiertas, sueltas, cruces, repetidos, usados: unicos.length, nodos: nodos.length };
  }

  const api = { leer, unir, aciRgb };
  raiz.NestDxf = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
