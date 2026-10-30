// Lector de SVG para el nesting (Gaspar 30-oct-2026: "hacé que el nesting me acepte svg también"). Lee un SVG (Illustrator,
// Inkscape, CorelDRAW…) y devuelve los dibujos en milímetros, con Y para arriba, como los del PDF: { subs: [{pts, cerrado,
// curva}], trazo, relleno, sc, fc, lw }. Pasa a tramos rectos path (M L H V C S Q T A Z, relativos y absolutos), line,
// polyline, polygon, rect (con esquinas redondeadas), circle y ellipse, con sus transform (matrix, translate, scale, rotate,
// skewX, skewY) anidados y los <use> que apuntan adentro del mismo archivo. Los colores salen de stroke y fill: del atributo,
// del style o de las clases de un <style> del archivo (selectores simples: .clase, etiqueta, #id). Cuenta los textos sin pasar
// a curvas y las imágenes.
// Seguridad: el SVG es un archivo del usuario. Se lee con DOMParser como XML y NUNCA se mete en la página: no corre <script>,
// no carga imágenes ni hojas de estilo (un href que no empieza con # no se sigue), y foreignObject, los eventos (onload…) y
// las reglas @ del <style> (@import, @font-face) no se miran.
(function (raiz) {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg', XLINK = 'http://www.w3.org/1999/xlink';
  // Topes para un SVG roto o desmedido: que dé un error en castellano y no cuelgue la página.
  const MAX_PUNTOS = 5e6, MAX_ELEMENTOS = 5e5, MAX_USOS = 2e5, MAX_TRAMOS = 1e5, MAX_PROF = 200;
  // Milímetros por unidad. El px va aparte: 96 por pulgada (CSS, Inkscape), salvo en los de Illustrator, que son 72 (para
  // Illustrator un px es un punto: un rectángulo de 100 mm lo escribe de 283,46).
  const MM = { mm: 1, cm: 10, q: 0.25, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6 };
  const NO_DIBUJA = new Set(['defs', 'symbol', 'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'filter', 'style', 'script', 'title', 'desc', 'metadata', 'foreignObject', 'font', 'font-face', 'cursor', 'view']);
  const PROPS = ['fill', 'stroke', 'stroke-width', 'display', 'visibility', 'opacity', 'fill-opacity', 'stroke-opacity', 'color', 'clip-path', 'mask'];
  const HEREDA = ['fill', 'stroke', 'stroke-width', 'visibility', 'color', 'fill-opacity', 'stroke-opacity'];
  const NOMBRES = { black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], lime: [0, 255, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], aqua: [0, 255, 255], magenta: [255, 0, 255], fuchsia: [255, 0, 255], gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192], maroon: [128, 0, 0], navy: [0, 0, 128], olive: [128, 128, 0], purple: [128, 0, 128], teal: [0, 128, 128], orange: [255, 165, 0] };

  const RE_NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
  const numeros = (s) => (String(s == null ? '' : s).match(RE_NUM) || []).map(Number);
  // '100mm' → { n: 100, u: 'mm' } (sin unidad: px); null si no es un largo
  function largo(v) {
    const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z%]*)\s*$/.exec(String(v == null ? '' : v));
    return m ? { n: parseFloat(m[1]), u: m[2].toLowerCase() || 'px' } : null;
  }

  // ───────────── matrices [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f ─────────────
  const mul = (m, k) => [m[0] * k[0] + m[2] * k[1], m[1] * k[0] + m[3] * k[1], m[0] * k[2] + m[2] * k[3], m[1] * k[2] + m[3] * k[3], m[0] * k[4] + m[2] * k[5] + m[4], m[1] * k[4] + m[3] * k[5] + m[5]];
  function transformar(t) {
    let m = [1, 0, 0, 1, 0, 0];
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi, rad = Math.PI / 180;
    let x;
    while ((x = re.exec(t))) {
      const v = numeros(x[2]), f = x[1].toLowerCase();
      let k = null;
      if (f === 'matrix') { if (v.length >= 6) k = v.slice(0, 6); }
      else if (f === 'translate') k = [1, 0, 0, 1, v[0] || 0, v[1] || 0];
      else if (f === 'scale') { const sx = v.length ? v[0] : 1; k = [sx, 0, 0, v.length > 1 ? v[1] : sx, 0, 0]; }
      else if (f === 'rotate') {
        const a = (v[0] || 0) * rad, c = Math.cos(a), s = Math.sin(a), cx = v[1] || 0, cy = v[2] || 0;
        k = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
      }
      else if (f === 'skewx') k = [1, 0, Math.tan((v[0] || 0) * rad), 1, 0, 0];
      else if (f === 'skewy') k = [1, Math.tan((v[0] || 0) * rad), 0, 1, 0, 0];
      if (k && k.every(isFinite)) m = mul(m, k);
    }
    return m;
  }
  // viewBox [x, y, w, h] puesto en un lugar de W × H, según preserveAspectRatio (por defecto xMidYMid meet)
  function verCaja(vb, par, W, H) {
    const sx = W / vb[2], sy = H / vb[3], p = String(par || '').replace(/^\s*defer\s+/, '').trim().split(/\s+/), al = p[0] || 'xMidYMid';
    if (al === 'none') return [sx, 0, 0, sy, -vb[0] * sx, -vb[1] * sy];
    const s = p[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
    const ax = /xMid/.test(al) ? 0.5 : /xMax/.test(al) ? 1 : 0, ay = /YMid/.test(al) ? 0.5 : /YMax/.test(al) ? 1 : 0;
    return [s, 0, 0, s, -vb[0] * s + (W - vb[2] * s) * ax, -vb[1] * s + (H - vb[3] * s) * ay];
  }
  function cajaVista(el) { const v = numeros(el.getAttribute('viewBox')); return v.length === 4 && v[2] > 0 && v[3] > 0 ? v : null; }

  // ───────────── curvas a tramos rectos ─────────────
  // Bézier cúbica (subdivisión adaptativa, como la del PDF: la suma de las distancias de los puntos de control a la cuerda <= tol).
  function bezier(out, x0, y0, x1, y1, x2, y2, x3, y3, tol, prof) {
    const dx = x3 - x0, dy = y3 - y0, L2 = dx * dx + dy * dy;
    let plano;
    if (L2 < 1e-12) plano = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x0, y2 - y0) <= tol;
    else { const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx), d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx); plano = (d1 + d2) * (d1 + d2) <= tol * tol * L2; }
    if (plano || prof >= 16) { out.push([x3, y3]); return; }
    const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2, x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2, x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
    const xa = (x01 + x12) / 2, ya = (y01 + y12) / 2, xb = (x12 + x23) / 2, yb = (y12 + y23) / 2, xm = (xa + xb) / 2, ym = (ya + yb) / 2;
    bezier(out, x0, y0, x01, y01, xa, ya, xm, ym, tol, prof + 1);
    bezier(out, xm, ym, xb, yb, x23, y23, x3, y3, tol, prof + 1);
  }
  // Arco de elipse (centro cx, cy y semiejes rx, ry en unidades del SVG, girada phi) de t0 a t0 + dt, ya en mm (M): agrega los
  // puntos que siguen al de inicio. La flecha de un tramo de ángulo h es <= h² · a / 8, con a el semieje mayor en mm: con
  // h = √(8 tol / a) la cuerda queda a tol o menos del arco. Se parte en los cuartos de la elipse (t múltiplo de 90°): ahí
  // están sus puntas, y con un punto en cada una la medida da justa (un estadio de 100 × 50 da 100, no 99,9). fin: la punta
  // exacta, para que no se corra. entera: una vuelta entera (al menos dos tramos por cuarto).
  function arcoElipse(out, M, cx, cy, rx, ry, phi, t0, dt, tol, fin, entera) {
    const c = Math.cos(phi), s = Math.sin(phi);
    const ux = (M[0] * c + M[2] * s) * rx, uy = (M[1] * c + M[3] * s) * rx, vx = (M[2] * c - M[0] * s) * ry, vy = (M[3] * c - M[1] * s) * ry;
    const S2 = ux * ux + uy * uy + vx * vx + vy * vy, det = ux * vy - uy * vx;
    const a = Math.sqrt((S2 + Math.sqrt(Math.max(0, S2 * S2 - 4 * det * det))) / 2);
    const paso = a > tol ? Math.sqrt(8 * tol / a) : Math.PI / 2;
    const X = M[0] * cx + M[2] * cy + M[4], Y = M[1] * cx + M[3] * cy + M[5];
    const Q = Math.PI / 2, sg = dt < 0 ? -1 : 1, t1 = t0 + dt, cortes = [];
    for (let k = sg > 0 ? Math.floor(t0 / Q + 1e-9) + 1 : Math.ceil(t0 / Q - 1e-9) - 1; sg > 0 ? k * Q < t1 - 1e-9 : k * Q > t1 + 1e-9; k += sg) cortes.push(k * Q);
    cortes.push(t1);
    let ta = t0;
    for (const tb of cortes) {
      const n = Math.min(MAX_TRAMOS, Math.max(entera ? 2 : 1, Math.ceil(Math.abs(tb - ta) / paso)));
      for (let i = 1; i <= n; i++) { const t = ta + (tb - ta) * i / n, co = Math.cos(t), si = Math.sin(t); out.push([X + ux * co + vx * si, Y + uy * co + vy * si]); }
      ta = tb;
    }
    if (fin) out[out.length - 1] = fin;
  }
  // Arma los subtrazos de una figura en mm (M: unidades del SVG → mm). El punto actual (ux, uy) va en unidades del SVG.
  function trazador(M, tol) {
    const subs = [];
    let cur = null, ux = 0, uy = 0;
    const T = (x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
    const t = {
      subs,
      mover(x, y) { cur = { pts: [T(x, y)], cerrado: false, curva: false }; subs.push(cur); ux = x; uy = y; },
      seguir() { if (!cur || cur.cerrado) t.mover(ux, uy); }, // después de un Z, lo que sigue arranca donde empezó
      linea(x, y) { t.seguir(); cur.pts.push(T(x, y)); ux = x; uy = y; },
      cubica(x1, y1, x2, y2, x, y) {
        t.seguir();
        const p0 = T(ux, uy), p1 = T(x1, y1), p2 = T(x2, y2), p3 = T(x, y);
        bezier(cur.pts, p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1], tol, 0);
        cur.curva = true; ux = x; uy = y;
      },
      cuadratica(qx, qy, x, y) { t.cubica(ux + 2 / 3 * (qx - ux), uy + 2 / 3 * (qy - uy), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y); },
      // arco del path (de la punta al centro: SVG 1.1, apéndice F.6.5)
      arco(rx, ry, giro, grande, horario, x, y) {
        const x1 = ux, y1 = uy;
        if (x1 === x && y1 === y) return; // mismo punto: no dibuja nada
        rx = Math.abs(rx); ry = Math.abs(ry);
        if (!rx || !ry) { t.linea(x, y); return; }
        const phi = (giro || 0) * Math.PI / 180, c = Math.cos(phi), s = Math.sin(phi);
        const dx = (x1 - x) / 2, dy = (y1 - y) / 2, xp = c * dx + s * dy, yp = -s * dx + c * dy;
        const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
        if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k; }
        const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp, den = rx * rx * yp * yp + ry * ry * xp * xp;
        let co = den > 0 ? Math.sqrt(Math.max(0, num / den)) : 0;
        if (grande === horario) co = -co;
        const cxp = co * rx * yp / ry, cyp = -co * ry * xp / rx;
        const cx = c * cxp - s * cyp + (x1 + x) / 2, cy = s * cxp + c * cyp + (y1 + y) / 2;
        const ang = (ax, ay, bx, by) => Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
        const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
        let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
        if (!horario && dt > 0) dt -= 2 * Math.PI; else if (horario && dt < 0) dt += 2 * Math.PI;
        t.seguir();
        arcoElipse(cur.pts, M, cx, cy, rx, ry, phi, t1, dt, tol, T(x, y));
        cur.curva = true; ux = x; uy = y;
      },
      // circle y ellipse: una vuelta entera, cerrada, desde el punto de la derecha
      elipse(cx, cy, rx, ry) {
        t.mover(cx + rx, cy);
        arcoElipse(cur.pts, M, cx, cy, rx, ry, 0, 0, 2 * Math.PI, tol, null, true);
        cur.pts.pop(); cur.cerrado = true; cur.curva = true;
      },
      // esquina redondeada de un rect: un cuarto de elipse de t0 a t0 + 90°
      esquina(cx, cy, rx, ry, t0) {
        const a = t0 * Math.PI / 180, b = a + Math.PI / 2;
        t.seguir(); arcoElipse(cur.pts, M, cx, cy, rx, ry, 0, a, Math.PI / 2, tol, T(cx + rx * Math.cos(b), cy + ry * Math.sin(b)));
        cur.curva = true; ux = cx + rx * Math.cos(b); uy = cy + ry * Math.sin(b);
      },
      cerrar(sx, sy) { if (cur) cur.cerrado = true; ux = sx; uy = sy; },
    };
    return t;
  }
  // El atributo d de un path. Un error corta ahí: se dibuja lo que venía bien, como en los navegadores.
  function camino(d, tr) {
    const n = d.length, RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
    let i = 0;
    const sep = () => { while (i < n) { const c = d.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 44) i++; else break; } };
    const num = () => { sep(); RE.lastIndex = i; const m = RE.exec(d); if (!m) return NaN; i = RE.lastIndex; return +m[0]; };
    const bandera = () => { sep(); const c = d[i]; if (c === '0' || c === '1') { i++; return c === '1'; } return null; };
    const lee = (k) => { const v = []; for (let j = 0; j < k; j++) { const x = num(); if (!isFinite(x)) return null; v.push(x); } return v; };
    let cmd = '', x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, ult = ''; // cx, cy: el último punto de control (para S y T)
    for (;;) {
      sep();
      if (i >= n) break;
      const ch = d[i];
      if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) { cmd = ch; i++; }
      else if (!cmd || cmd === 'Z' || cmd === 'z' || !/[0-9+\-.]/.test(ch)) break; // basura, o números de más después de un Z
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? x : 0, oy = rel ? y : 0;
      let v;
      if (C === 'Z') { tr.cerrar(sx, sy); x = sx; y = sy; ult = 'Z'; continue; }
      if (C === 'M') {
        if (!(v = lee(2))) break;
        x = ox + v[0]; y = oy + v[1]; sx = x; sy = y; tr.mover(x, y);
        cmd = rel ? 'l' : 'L'; ult = 'M'; continue; // los pares que siguen a un M son L
      }
      if (C === 'L') { if (!(v = lee(2))) break; x = ox + v[0]; y = oy + v[1]; tr.linea(x, y); }
      else if (C === 'H') { if (!(v = lee(1))) break; x = ox + v[0]; tr.linea(x, y); }
      else if (C === 'V') { if (!(v = lee(1))) break; y = oy + v[0]; tr.linea(x, y); }
      else if (C === 'C' || C === 'S') {
        let x1, y1;
        if (C === 'C') { if (!(v = lee(6))) break; x1 = ox + v[0]; y1 = oy + v[1]; v = v.slice(2); }
        else { if (!(v = lee(4))) break; if (ult === 'C') { x1 = 2 * x - cx; y1 = 2 * y - cy; } else { x1 = x; y1 = y; } }
        cx = ox + v[0]; cy = oy + v[1];
        const nx = ox + v[2], ny = oy + v[3];
        tr.cubica(x1, y1, cx, cy, nx, ny); x = nx; y = ny; ult = 'C'; continue;
      }
      else if (C === 'Q' || C === 'T') {
        if (C === 'Q') { if (!(v = lee(4))) break; cx = ox + v[0]; cy = oy + v[1]; v = v.slice(2); }
        else { if (!(v = lee(2))) break; if (ult === 'Q') { cx = 2 * x - cx; cy = 2 * y - cy; } else { cx = x; cy = y; } }
        const nx = ox + v[0], ny = oy + v[1];
        tr.cuadratica(cx, cy, nx, ny); x = nx; y = ny; ult = 'Q'; continue;
      }
      else if (C === 'A') {
        const rx = num(), ry = num(), giro = num(), grande = bandera(), horario = bandera(), ax = num(), ay = num();
        if (![rx, ry, giro, ax, ay].every(isFinite) || grande == null || horario == null) break;
        x = ox + ax; y = oy + ay; tr.arco(rx, ry, giro, grande, horario, x, y);
      }
      ult = C;
    }
  }

  // ───────────── estilos ─────────────
  // Declaraciones "a: b; c: d" de las propiedades que importan.
  function declaraciones(s) {
    const out = {};
    for (const parte of String(s || '').split(';')) {
      const k = parte.indexOf(':'); if (k < 0) continue;
      const p = parte.slice(0, k).trim().toLowerCase();
      if (PROPS.includes(p)) out[p] = parte.slice(k + 1).replace(/!\s*important/i, '').trim();
    }
    return out;
  }
  // Fuera las reglas @ (con o sin bloque): @import, @font-face {…}, @media {… {…}}.
  function sinArroba(css) {
    let out = '', i = 0;
    while (i < css.length) {
      const a = css.indexOf('@', i);
      if (a < 0) { out += css.slice(i); break; }
      out += css.slice(i, a);
      let j = a;
      while (j < css.length && css[j] !== ';' && css[j] !== '{') j++;
      if (j >= css.length || css[j] === ';') { i = j + 1; continue; }
      for (let k = 0; j < css.length; j++) { if (css[j] === '{') k++; else if (css[j] === '}' && --k === 0) break; }
      i = j + 1;
    }
    return out;
  }
  // Reglas de los <style> del archivo, de menor a mayor peso: solo selectores simples (etiqueta, .clase, #id, combinados sin
  // espacios, y *); los que tienen espacios, >, +, ~, [ ] o : no se aplican.
  function hojas(doc, esSvg) {
    const out = [];
    for (const st of doc.getElementsByTagName('style')) {
      if (!esSvg(st)) continue;
      const css = sinArroba(String(st.textContent || '').replace(/\/\*[\s\S]*?\*\//g, ''));
      const re = /([^{}]+)\{([^{}]*)\}/g;
      let m;
      while ((m = re.exec(css))) {
        const decl = declaraciones(m[2]);
        if (!Object.keys(decl).length) continue;
        for (const s of m[1].split(',')) {
          const x = /^(\*|[A-Za-z][\w-]*)?((?:[#.][\w-]+)*)$/.exec(s.trim());
          if (!x || !s.trim()) continue;
          const tag = x[1] && x[1] !== '*' ? x[1] : null, partes = x[2].match(/[#.][\w-]+/g) || [];
          const id = (partes.find((p) => p[0] === '#') || '').slice(1) || null, clases = partes.filter((p) => p[0] === '.').map((p) => p.slice(1));
          out.push({ tag, id, clases, peso: (id ? 1e4 : 0) + clases.length * 100 + (tag ? 1 : 0), orden: out.length, decl });
        }
      }
    }
    return out.sort((a, b) => a.peso - b.peso || a.orden - b.orden);
  }
  // Color CSS → [r, g, b]; null si no se entiende.
  let lienzo = null;
  function color(v) {
    v = String(v || '').trim().toLowerCase();
    let m = /^#([0-9a-f]{3,8})$/.exec(v);
    if (m) {
      const h = m[1];
      if (h.length === 3 || h.length === 4) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16));
      if (h.length === 6 || h.length === 8) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      return null;
    }
    if ((m = /^rgba?\(([^)]*)\)$/.exec(v))) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
      if (p.length < 3) return null;
      return p.map((x) => Math.max(0, Math.min(255, /%$/.test(x) ? parseFloat(x) * 2.55 : parseFloat(x))) || 0);
    }
    if (NOMBRES[v]) return NOMBRES[v];
    // hsl(), los demás nombres de CSS…: que los traduzca un canvas suelto (no va a la página)
    try {
      if (!lienzo) lienzo = (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')).getContext('2d');
      lienzo.fillStyle = '#010203'; lienzo.fillStyle = v;
      const r = String(lienzo.fillStyle);
      if (r === '#010203') return null;
      if (r[0] === '#') return color(r);
      if ((m = /^rgba?\(([^)]*)\)$/.exec(r))) return color(r);
    } catch (_) {}
    return null;
  }

  // ───────────── lectura ─────────────
  // Lee el SVG. tol = error máximo de las curvas, en mm. Devuelve { els, textos, imagenes, unidad: { de, ppp, programa, ancho,
  // alto }, avisos: { recortes, degradados, externos } }. de: la unidad de la medida del archivo ('mm', 'cm', 'in', 'pt', 'pc',
  // 'q'); 'px' si sale de los px (ppp: cuántos px por pulgada se tomaron).
  function leer(texto, tol) {
    tol = tol || 0.05;
    if (typeof DOMParser === 'undefined') throw new Error('Este navegador no puede leer SVG.');
    texto = String(texto || '').replace(/^\s+</, '<'); // \s también saca la marca de orden de bytes (U+FEFF)
    const doc = new DOMParser().parseFromString(texto, 'image/svg+xml');
    const raizSvg = doc && doc.documentElement;
    if (!raizSvg || doc.getElementsByTagName('parsererror').length) throw new Error('El SVG está roto: no se pudo leer. Abrilo en el programa de dibujo y guardalo de nuevo.');
    if (raizSvg.localName !== 'svg') throw new Error('No es un SVG.');
    const ns = raizSvg.namespaceURI, esSvg = (el) => el.namespaceURI === SVGNS || el.namespaceURI === ns;

    // De qué programa viene: Illustrator escribe su px a 72 por pulgada. "Guardar como" deja su comentario Generator;
    // "Exportar como", data-name en el svg y las clases cls-1, cls-2…
    const cab = texto.slice(0, 6000);
    const programa = /Adobe Illustrator|ns\.adobe\.com\/AdobeIllustrator|&ns_ai;|\.cls-\d+\s*[{,]/i.test(cab) || raizSvg.hasAttribute('data-name') ? 'Illustrator'
      : /inkscape/i.test(cab) ? 'Inkscape' : /CorelDRAW/i.test(cab) ? 'CorelDRAW' : '';
    const ppp = programa === 'Illustrator' ? 72 : 96, pxMm = 25.4 / ppp;
    const aMm = (L) => (!L || L.u === '%' || !(L.n > 0) ? null : L.u === 'px' ? L.n * pxMm : MM[L.u] != null ? L.n * MM[L.u] : L.u === 'em' ? L.n * 16 * pxMm : L.u === 'ex' ? L.n * 8 * pxMm : null);
    const lw = largo(raizSvg.getAttribute('width')), lh = largo(raizSvg.getAttribute('height'));
    let W = aMm(lw), H = aMm(lh);
    const vb = cajaVista(raizSvg), fisica = [lw, lh].find((L) => L && MM[L.u] != null && L.n > 0);
    let base;
    if (vb) {
      if (W == null && H == null) { W = vb[2] * pxMm; H = vb[3] * pxMm; }
      else if (W == null) W = H * vb[2] / vb[3];
      else if (H == null) H = W * vb[3] / vb[2];
      base = verCaja(vb, raizSvg.getAttribute('preserveAspectRatio'), W, H);
    } else base = [pxMm, 0, 0, pxMm, 0, 0]; // sin viewBox, la unidad del dibujo es el px
    // Y para arriba (como el PDF y el DXF), con el origen abajo a la izquierda de la hoja
    base = mul([1, 0, 0, -1, 0, H || 0], base);
    const unidad = { de: vb && fisica ? fisica.u : 'px', ppp, programa, ancho: W, alto: H };

    const porId = new Map();
    for (const el of doc.getElementsByTagName('*')) { const id = el.getAttribute('id'); if (id && !porId.has(id)) porId.set(id, el); }
    const reglas = hojas(doc, esSvg);
    const avisos = { recortes: 0, degradados: 0, externos: 0 };
    const els = [];
    let textos = 0, imagenes = 0, vistos = 0, usos = 0, puntos = 0;

    // Estilo de un elemento: lo heredado del padre, después los atributos, las reglas del <style> y el style.
    function estilo(el, padre) {
      const e = {};
      for (const k of HEREDA) if (padre[k] != null) e[k] = padre[k];
      const fijar = (d) => { for (const k in d) e[k] = d[k] === 'inherit' ? padre[k] : d[k]; };
      for (const k of PROPS) { const v = el.getAttribute(k); if (v != null) fijar({ [k]: v.trim() }); }
      if (reglas.length) {
        const cls = String(el.getAttribute('class') || '').trim().split(/\s+/), id = el.getAttribute('id');
        for (const r of reglas) if ((!r.tag || r.tag === el.localName) && (!r.id || r.id === id) && r.clases.every((c) => cls.includes(c))) fijar(r.decl);
      }
      const st = el.getAttribute('style'); if (st) fijar(declaraciones(st));
      return e;
    }
    // Primer color de un degradado (siguiendo su href a otro degradado); un motivo (pattern) da gris.
    function degradado(id, vueltas) {
      const g = porId.get(id);
      if (!g || vueltas > 8) return null;
      if (g.localName === 'pattern') return [128, 128, 128];
      if (g.localName !== 'linearGradient' && g.localName !== 'radialGradient') return null;
      for (const s of g.children) if (s.localName === 'stop') {
        const v = /stop-color\s*:\s*([^;]+)/i.exec(s.getAttribute('style') || '');
        return color((v && v[1]) || s.getAttribute('stop-color') || 'black') || [0, 0, 0];
      }
      const h = (g.getAttribute('href') || g.getAttributeNS(XLINK, 'href') || '').trim();
      return h[0] === '#' ? degradado(h.slice(1), (vueltas || 0) + 1) : null;
    }
    // stroke o fill → [r, g, b], o null si no pinta
    function pintura(v, e) {
      v = String(v == null ? '' : v).trim();
      if (!v || v === 'none' || v === 'transparent') return null;
      const u = /^url\(\s*(['"]?)([^'")]*)\1\s*\)\s*(.*)$/i.exec(v);
      if (u) {
        const ref = u[2].trim();
        if (ref[0] === '#') { const c = degradado(ref.slice(1), 0); if (c) { avisos.degradados++; return c; } }
        else if (ref) avisos.externos++;
        return u[3] ? pintura(u[3], e) : null;
      }
      if (v.toLowerCase() === 'currentcolor') return color(e.color || 'black');
      return color(v);
    }
    const opacidad = (v) => { const x = parseFloat(v); return isFinite(x) ? x : 1; };
    // Largo de un atributo en unidades del SVG (ref: contra qué se toma un %)
    const medida = (v, ref) => {
      const L = largo(v); if (!L) return 0;
      if (L.u === '%') return L.n / 100 * (ref || 0);
      if (L.u === 'px') return L.n;
      return MM[L.u] != null ? L.n * MM[L.u] * 96 / 25.4 : L.u === 'em' ? L.n * 16 : L.u === 'ex' ? L.n * 8 : L.n;
    };
    const vista = vb || [0, 0, (W || 0) / pxMm, (H || 0) / pxMm];
    const refX = vista[2], refY = vista[3], refR = Math.sqrt((refX * refX + refY * refY) / 2);
    const at = (el, k, ref) => medida(el.getAttribute(k), ref);

    // Un dibujo: sus subtrazos con el color de trazo y relleno (como un pintar del PDF).
    function pintar(subs, e, M, sinRelleno) {
      if (!subs.length || e.visibility === 'hidden' || e.visibility === 'collapse') return;
      const sc = pintura(e.stroke, e), fc = sinRelleno ? null : pintura(e.fill == null ? 'black' : e.fill, e);
      const sw = e['stroke-width'] == null ? 1 : medida(e['stroke-width'], refR);
      const trazo = !!sc && sw > 0 && opacidad(e['stroke-opacity']) > 0, relleno = !!fc && opacidad(e['fill-opacity']) > 0;
      if (!trazo && !relleno) return;
      for (const s of subs) puntos += s.pts.length;
      if (puntos > MAX_PUNTOS) throw new Error('El SVG es demasiado grande para leerlo acá (más de 5 millones de puntos). Puede estar roto.');
      els.push({ subs, trazo, relleno, sc: sc || [0, 0, 0], fc: fc || [0, 0, 0], lw: trazo ? sw * Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2])) : 0 });
    }
    function figura(el, e, M) {
      const tr = trazador(M, tol), tag = el.localName;
      if (tag === 'path') camino(String(el.getAttribute('d') || ''), tr);
      else if (tag === 'rect') {
        const x = at(el, 'x', refX), y = at(el, 'y', refY), w = at(el, 'width', refX), h = at(el, 'height', refY);
        if (!(w > 0 && h > 0)) return;
        const hayRx = largo(el.getAttribute('rx')), hayRy = largo(el.getAttribute('ry'));
        let rx = hayRx ? at(el, 'rx', refX) : null, ry = hayRy ? at(el, 'ry', refY) : null;
        if (rx == null) rx = ry; if (ry == null) ry = rx;
        rx = Math.min(Math.max(0, rx || 0), w / 2); ry = Math.min(Math.max(0, ry || 0), h / 2);
        if (!rx || !ry) { tr.mover(x, y); tr.linea(x + w, y); tr.linea(x + w, y + h); tr.linea(x, y + h); tr.cerrar(x, y); }
        else {
          tr.mover(x + rx, y);
          tr.linea(x + w - rx, y); tr.esquina(x + w - rx, y + ry, rx, ry, -90);
          tr.linea(x + w, y + h - ry); tr.esquina(x + w - rx, y + h - ry, rx, ry, 0);
          tr.linea(x + rx, y + h); tr.esquina(x + rx, y + h - ry, rx, ry, 90);
          tr.linea(x, y + ry); tr.esquina(x + rx, y + ry, rx, ry, 180);
          tr.cerrar(x + rx, y);
        }
      }
      else if (tag === 'circle') { const r = at(el, 'r', refR); if (r > 0) tr.elipse(at(el, 'cx', refX), at(el, 'cy', refY), r, r); }
      else if (tag === 'ellipse') { const rx = at(el, 'rx', refX), ry = at(el, 'ry', refY); if (rx > 0 && ry > 0) tr.elipse(at(el, 'cx', refX), at(el, 'cy', refY), rx, ry); }
      else if (tag === 'line') { tr.mover(at(el, 'x1', refX), at(el, 'y1', refY)); tr.linea(at(el, 'x2', refX), at(el, 'y2', refY)); }
      else if (tag === 'polyline' || tag === 'polygon') {
        const v = numeros(el.getAttribute('points'));
        if (v.length < 4) return;
        tr.mover(v[0], v[1]);
        for (let i = 2; i + 1 < v.length; i += 2) tr.linea(v[i], v[i + 1]);
        if (tag === 'polygon') tr.cerrar(v[0], v[1]);
      }
      pintar(tr.subs.filter((s) => s.pts.length >= 2), e, M, tag === 'line');
    }
    // enUso: los elementos que se están recorriendo (los de arriba y los use de por medio). Un use que apunta a uno de ellos se
    // usaría a sí mismo: no se dibuja, como en los navegadores.
    function hijos(el, M, e, prof, enUso) {
      enUso.add(el);
      for (const h of el.children) visitar(h, M, e, prof + 1, enUso);
      enUso.delete(el);
    }
    function visitar(el, M, padre, prof, enUso) {
      if (++vistos > MAX_ELEMENTOS) throw new Error('El SVG tiene demasiados elementos para leerlo acá (más de 500.000). Puede estar roto.');
      if (prof > MAX_PROF || !esSvg(el)) return; // lo de Illustrator e Inkscape (i:pgf, sodipodi:namedview…) va en otro espacio de nombres
      const tag = el.localName;
      if (NO_DIBUJA.has(tag)) return;
      const e = estilo(el, padre);
      if (e.display === 'none' || opacidad(e.opacity) <= 0) return;
      if ((e['clip-path'] && e['clip-path'] !== 'none') || (e.mask && e.mask !== 'none')) avisos.recortes++;
      const t = el.getAttribute('transform');
      if (t) M = mul(M, transformar(t));
      switch (tag) {
        case 'g': case 'a': hijos(el, M, e, prof, enUso); break;
        case 'svg': { // un svg adentro de otro: su lugar y su viewBox
          const x = at(el, 'x', refX), y = at(el, 'y', refY), w = el.hasAttribute('width') ? at(el, 'width', refX) : refX, h = el.hasAttribute('height') ? at(el, 'height', refY) : refY;
          let m = mul(M, [1, 0, 0, 1, x, y]);
          const v = cajaVista(el);
          if (v && w > 0 && h > 0) m = mul(m, verCaja(v, el.getAttribute('preserveAspectRatio'), w, h));
          hijos(el, m, e, prof, enUso); break;
        }
        case 'switch': { // el primero que vale (Illustrator pone primero un foreignObject con lo suyo)
          const h = [...el.children].find((c) => esSvg(c) && c.localName !== 'foreignObject' && !c.hasAttribute('requiredExtensions'));
          if (h) visitar(h, M, e, prof + 1, enUso);
          break;
        }
        case 'use': {
          const href = String(el.getAttribute('href') || el.getAttributeNS(XLINK, 'href') || '').trim();
          if (href[0] !== '#') { if (href) avisos.externos++; break; } // a otro archivo: no se sigue
          const ref = porId.get(href.slice(1));
          if (!ref || enUso.has(ref)) break; // no está, o se usa a sí mismo
          if (++usos > MAX_USOS) throw new Error('El SVG tiene más de 200.000 copias (use): parece roto o es demasiado grande para leerlo acá.');
          let m = mul(M, [1, 0, 0, 1, at(el, 'x', refX), at(el, 'y', refY)]);
          enUso.add(el);
          if (ref.localName === 'symbol') {
            const v = cajaVista(ref), w = el.hasAttribute('width') ? at(el, 'width', refX) : ref.hasAttribute('width') ? at(ref, 'width', refX) : 0;
            const h = el.hasAttribute('height') ? at(el, 'height', refY) : ref.hasAttribute('height') ? at(ref, 'height', refY) : 0;
            if (v && w > 0 && h > 0) m = mul(m, verCaja(v, ref.getAttribute('preserveAspectRatio'), w, h));
            const es = estilo(ref, e);
            if (es.display !== 'none') hijos(ref, m, es, prof, enUso);
          } else visitar(ref, m, e, prof + 1, enUso); // lo usado hereda el estilo del use, no el de donde está
          enUso.delete(el);
          break;
        }
        case 'text': case 'flowRoot':
          if (e.visibility !== 'hidden' && e.visibility !== 'collapse' && String(el.textContent || '').trim()) textos++;
          break;
        case 'image':
          if (e.visibility !== 'hidden' && e.visibility !== 'collapse') imagenes++;
          break;
        case 'path': case 'rect': case 'circle': case 'ellipse': case 'line': case 'polyline': case 'polygon':
          figura(el, e, M); break;
      }
    }
    const e0 = estilo(raizSvg, {});
    if (e0.display !== 'none') hijos(raizSvg, base, e0, 0, new Set());
    return { els, textos, imagenes, unidad, avisos };
  }

  const api = { leer, transformar, camino, trazador };
  raiz.NestSvg = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
