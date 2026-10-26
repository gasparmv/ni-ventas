// Código G para el corte (Gaspar 25-oct-2026). Con la geometría de una lámina ya acomodada arma los recorridos de la fresa
// como en Aspire y escribe un archivo G-code (mm, coordenadas absolutas, solo G0/G1, avance en mm/min):
//  · calado: sobre la línea que dibujó Emma (el centro del surco), a su profundidad;
//  · agujeros: taladrado en el centro (baja de una y sube) si el agujero mide como la fresa; si es más grande, se corta por
//    dentro como un corte de adentro;
//  · cortes de adentro (huecos de una pieza): por dentro, corridos el radio de la fresa;
//  · contornos: por fuera, corridos el radio de la fresa (si no, la pieza sale más chica); al final, para que la pieza se
//    suelte cuando ya está todo hecho.
// Los desplazamientos los hace Clipper (Angus Johnson). El cero: X0 Y0 en la esquina de abajo a la izquierda de la lámina,
// Z0 arriba del material.
(function (raiz) {
  'use strict';
  const C = raiz.ClipperLib || (typeof require === 'function' ? require('./clipper.js') : null);
  const ESC = 1000; // Clipper trabaja con enteros: micrones
  const PERFIL_DEF = {
    fresa: 6, seguridad: 5, inicio: 20, sentido: 'trepado', ext: 'nc', aire: 0, vacio: 100, acel: 500, ajuste: 100,
    corte: { avance: 200, bajada: 10, rpm: 18000, inicial: 0, final: 3, pasada: 3 },
    calado: { avance: 300, bajada: 10, rpm: 18000, inicial: 0, final: 1, pasada: 1 },
    agujero: { avance: 200, bajada: 10, rpm: 18000, inicial: 0, final: 3, pasada: 3 },
  };
  const areaSig = (p) => { let s = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) s += (p[j][0] - p[i][0]) * (p[j][1] + p[i][1]); return s / 2; };
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  // Desplaza un contorno cerrado d mm (d > 0 hacia afuera, d < 0 hacia adentro) con esquinas redondas. Devuelve los lazos que
  // resultan, con su orientación de Clipper: los de afuera antihorarios y los huecos horarios.
  function desplazar(pts, d) {
    const p = pts.map(([x, y]) => ({ X: Math.round(x * ESC), Y: Math.round(y * ESC) }));
    const co = new C.ClipperOffset(2, 0.005 * ESC);
    co.AddPath(p, C.JoinType.jtRound, C.EndType.etClosedPolygon);
    const sol = [];
    co.Execute(sol, d * ESC);
    return sol.map((q) => q.map((v) => [v.X / ESC, v.Y / ESC])).filter((q) => q.length >= 3);
  }
  function circulo(pts) {
    if (pts.length < 8) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let rmin = Infinity, rmax = 0;
    for (const [x, y] of pts) { const r = Math.hypot(x - cx, y - cy); if (r < rmin) rmin = r; if (r > rmax) rmax = r; }
    const r = (rmin + rmax) / 2;
    return r > 0.2 && rmax - rmin <= Math.max(0.03, 0.01 * r) ? { cx, cy, r } : null;
  }
  // Sentido de un lazo: trepado con el husillo horario (M3) = el material a la izquierda del avance.
  function orientar(pts, materialAdentro, trepado) {
    const antihorario = materialAdentro === trepado;
    return (areaSig(pts) > 0) === antihorario ? pts : pts.slice().reverse();
  }
  // Recorridos de una lámina: geos = piezas colocadas ({ poly, huecos, abiertos, calados, agujeros }).
  function recorridos(geos, perfil) {
    const r = perfil.fresa / 2, trepado = perfil.sentido !== 'convencional';
    const ops = { calado: [], taladros: [], agujeros: [], huecos: [], contornos: [] };
    const av = { huecosChicos: 0, agujerosChicos: 0, agujerosGrandes: 0 };
    for (const g of geos) {
      for (const s of g.calados) ops.calado.push({ pts: s.pts, cerrado: s.cerrado });
      for (const s of g.agujeros) {
        const ci = s.cerrado ? circulo(s.pts) : null;
        if (ci && 2 * ci.r <= perfil.fresa + 0.5) { ops.taladros.push([ci.cx, ci.cy]); if (2 * ci.r < perfil.fresa - 0.5) av.agujerosChicos++; continue; }
        if (!s.cerrado) { ops.agujeros.push({ pts: s.pts, cerrado: false }); continue; }
        const lazos = desplazar(s.pts, -r);
        if (!lazos.length) { ops.taladros.push(centro(s.pts)); av.agujerosChicos++; continue; }
        av.agujerosGrandes++;
        for (const l of lazos) ops.agujeros.push({ pts: orientar(l, false, trepado), cerrado: true });
      }
      for (const h of g.huecos) {
        const lazos = desplazar(h, -r);
        if (!lazos.length) { av.huecosChicos++; continue; }
        for (const l of lazos) ops.huecos.push({ pts: orientar(l, false, trepado), cerrado: true });
      }
      for (const p of g.abiertos) ops.huecos.push({ pts: p, cerrado: false });
      for (const l of desplazar(g.poly, r)) ops.contornos.push({ pts: orientar(l, areaSig(l) > 0, trepado), cerrado: true });
    }
    return { ops, avisos: av };
  }
  function centro(pts) { let x = 0, y = 0; for (const p of pts) { x += p[0]; y += p[1]; } return [x / pts.length, y / pts.length]; }
  // Orden de vecino más cercano; en un lazo arranca por el vértice más cercano y en una línea abierta, por la punta más cercana.
  function ordenar(caminos, desde) {
    const quedan = caminos.slice(), out = [];
    let pos = desde;
    while (quedan.length) {
      let mejor = -1, md = Infinity;
      for (let i = 0; i < quedan.length; i++) {
        const c = quedan[i], p = c.pts;
        let d;
        if (!c.cerrado) d = Math.min(d2(pos, p[0]), d2(pos, p[p.length - 1]));
        else { d = Infinity; const paso = Math.max(1, Math.floor(p.length / 24)); for (let k = 0; k < p.length; k += paso) { const e = d2(pos, p[k]); if (e < d) d = e; } }
        if (d < md) { md = d; mejor = i; }
      }
      const c = quedan.splice(mejor, 1)[0];
      let pts = c.pts;
      if (!c.cerrado) { if (d2(pos, pts[pts.length - 1]) < d2(pos, pts[0])) pts = pts.slice().reverse(); }
      else { let k0 = 0, dk = Infinity; for (let k = 0; k < pts.length; k++) { const e = d2(pos, pts[k]); if (e < dk) { dk = e; k0 = k; } } pts = pts.slice(k0).concat(pts.slice(0, k0)); }
      out.push({ pts, cerrado: c.cerrado });
      pos = c.cerrado ? pts[0] : pts[pts.length - 1];
    }
    return { caminos: out, pos };
  }
  function profundidades(o) {
    const ini = Math.max(0, +o.inicial || 0), fin = Math.max(ini, +o.final || 0), paso = +o.pasada > 0 ? +o.pasada : fin - ini;
    if (fin <= ini) return [];
    const z = [];
    for (let d = ini + paso; d < fin - 1e-6; d += paso) z.push(d);
    z.push(fin);
    return z;
  }
  // Escribe el archivo. meta: { titulo, largo, ancho }. Devuelve { texto, segundos, avisos }.
  function escribir(rec, perfil, meta) {
    const L = [], f3 = (v) => (Math.round(v * 1000) / 1000 || 0).toFixed(3), aire = +perfil.aire || 0;
    const Z = (z) => f3(z + aire), seg = +perfil.seguridad, home = Math.max(seg, +perfil.inicio), vacio = Math.max(1, +perfil.vacio || 100);
    let x = 0, y = 0, z = home, F = null, rpm = null, t = 0;
    const g0 = (nx, ny, nz) => {
      const p = [];
      if (nx != null && (nx !== x || ny !== y)) { t += Math.hypot(nx - x, ny - y) / vacio; x = nx; y = ny; p.push('X' + f3(x), 'Y' + f3(y)); }
      if (nz != null && nz !== z) { t += Math.abs(nz - z) / vacio; z = nz; p.push('Z' + Z(z)); }
      if (p.length) L.push('G0 ' + p.join(' '));
    };
    const g1 = (nx, ny, nz, vel) => {
      const p = [], fmin = Math.round(vel * 60), dist = Math.hypot((nx == null ? x : nx) - x, (ny == null ? y : ny) - y, (nz == null ? z : nz) - z);
      if (nx != null && (nx !== x || ny !== y)) { p.push('X' + f3(nx), 'Y' + f3(ny)); x = nx; y = ny; }
      if (nz != null && nz !== z) { p.push('Z' + Z(nz)); z = nz; }
      if (!p.length) return;
      if (fmin !== F) { p.push('F' + fmin); F = fmin; }
      t += dist / Math.max(0.1, vel);
      L.push('G1 ' + p.join(' '));
    };
    const husillo = (v) => { if (v !== rpm) { L.push('S' + Math.round(v) + ' M3'); rpm = v; } };
    const caminar = (pts, o, cerrado, profs) => {
      g0(null, null, seg); g0(pts[0][0], pts[0][1], null);
      let ida = true;
      for (const d of profs) {
        g1(null, null, -d, o.bajada);
        const seq = cerrado ? pts.concat([pts[0]]) : (ida ? pts : pts.slice().reverse());
        for (let k = 1; k < seq.length; k++) g1(seq[k][0], seq[k][1], null, o.avance);
        if (!cerrado) ida = !ida;
      }
      g0(null, null, seg);
    };
    const mm = (v) => String(Math.round(v * 10) / 10);
    // Comentarios solo en ASCII: algunos controladores se traban con tildes.
    const ascii = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '').replace(/[()]/g, '');
    L.push('(Neon Infinito - nesting: ' + ascii(meta.titulo) + ')');
    L.push('(Lamina ' + mm(meta.largo) + ' x ' + mm(meta.ancho) + ' mm - fresa recta de ' + mm(perfil.fresa) + ' mm)');
    L.push('(Cero: X0 Y0 abajo a la izquierda, Z0 arriba del material)');
    if (aire) L.push('(PRUEBA EN EL AIRE: todo ' + mm(aire) + ' mm mas arriba)');
    L.push('G90 G21 G17');
    L.push('G0 Z' + Z(home)); z = home;
    L.push('G0 X0.000 Y0.000');
    let pos = [0, 0];
    const op = (titulo, caminos, o) => {
      if (!caminos.length) return;
      const profs = profundidades(o); if (!profs.length) return;
      const ord = ordenar(caminos, pos); pos = ord.pos;
      L.push('(' + titulo + ': ' + caminos.length + ' recorrido' + (caminos.length === 1 ? '' : 's') + ', ' + mm(profs[profs.length - 1]) + ' mm de profundidad)');
      husillo(o.rpm);
      for (const c of ord.caminos) caminar(c.pts, o, c.cerrado, profs);
    };
    op('Calado', rec.ops.calado, perfil.calado);
    if (rec.ops.taladros.length) {
      const o = perfil.agujero, prof = Math.max(0, +o.final || 0);
      if (prof > 0) {
        const ord = ordenar(rec.ops.taladros.map((p) => ({ pts: [p], cerrado: false })), pos); pos = ord.pos;
        L.push('(Agujeros: ' + ord.caminos.length + ' taladro' + (ord.caminos.length === 1 ? '' : 's') + ', ' + mm(prof) + ' mm de profundidad)');
        husillo(o.rpm);
        for (const c of ord.caminos) { g0(null, null, seg); g0(c.pts[0][0], c.pts[0][1], null); g1(null, null, -prof, o.bajada); g0(null, null, seg); }
      }
    }
    op('Agujeros grandes', rec.ops.agujeros, { ...perfil.agujero });
    op('Cortes de adentro', rec.ops.huecos, perfil.corte);
    op('Contornos', rec.ops.contornos, perfil.corte);
    g0(null, null, home);
    L.push('M5');
    g0(0, 0, null);
    L.push('M30');
    return { texto: L.join('\r\n') + '\r\n', segundos: t, avisos: rec.avisos };
  }
  // Lee un G-code y devuelve los tramos en orden: { a, b, rapido, f (mm/min), op }. Entiende G0/G1 y arcos G2/G3 con I J
  // (los pasa a tramos rectos); op sale de los comentarios de sección que escribe escribir() ("(Calado: ...)", etc.).
  function leer(texto) {
    const tramos = [], num = '([-+]?(?:\\d+\\.?\\d*|\\.\\d+))';
    let x = 0, y = 0, z = 0, modo = 0, f = 0, op = '';
    for (const crudo of texto.split(/\r?\n/)) {
      const com = crudo.match(/\((Calado|Agujeros grandes|Agujeros|Cortes de adentro|Contornos)\b/i);
      if (com) op = com[1];
      const l = crudo.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim().toUpperCase();
      if (!l) continue;
      const g = l.match(/G0*([0-3])(?!\d)/); if (g) modo = +g[1];
      const v = (k) => { const m = l.match(new RegExp(k + num)); return m ? parseFloat(m[1]) : null; };
      const nf = v('F'); if (nf != null) f = nf;
      const nx = v('X'), ny = v('Y'), nz = v('Z');
      if (nx == null && ny == null && nz == null) continue;
      const a = [x, y, z], bx = nx != null ? nx : x, by = ny != null ? ny : y, bz = nz != null ? nz : z;
      if (modo >= 2) {
        // arco en XY: centro = inicio + (I, J); horario con G2
        const cx = x + (v('I') || 0), cy = y + (v('J') || 0), r = Math.hypot(x - cx, y - cy);
        let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(by - cy, bx - cx);
        if (modo === 2) { while (a1 >= a0) a1 -= 2 * Math.PI; } else { while (a1 <= a0) a1 += 2 * Math.PI; }
        const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) * r / 0.5));
        let p = a;
        for (let k = 1; k <= n; k++) { const ang = a0 + (a1 - a0) * k / n, q = [cx + r * Math.cos(ang), cy + r * Math.sin(ang), z + (bz - z) * k / n]; tramos.push({ a: p, b: q, rapido: false, f, op }); p = q; }
      } else tramos.push({ a, b: [bx, by, bz], rapido: modo === 0, f, op });
      x = bx; y = by; z = bz;
    }
    return tramos;
  }
  // Tiempo de máquina: simula el planificador de un controlador. Cada tramo va hasta su velocidad (avance o vacío) con
  // aceleración acel; en una cadena de cortes en XY la velocidad de paso por cada vértice se limita por el ángulo (desvío de
  // unión, como GRBL), y en los movimientos en vacío, subidas y bajadas la máquina arranca y termina parada.
  // Devuelve { tramos (con t0 y t1 en segundos), total }.
  function simular(texto, maq) {
    const tr = leer(texto), a = Math.max(10, +maq.acel || 500), dj = 0.02, vR = Math.max(1, +maq.vacio || 100), n = tr.length;
    for (const t of tr) {
      const dx = t.b[0] - t.a[0], dy = t.b[1] - t.a[1], dz = t.b[2] - t.a[2];
      t.L = Math.hypot(dx, dy, dz); t.v = t.rapido ? vR : Math.max(0.1, t.f / 60); t.xy = !t.rapido && Math.abs(dz) < 1e-9 && t.L > 0;
    }
    const vin = new Float64Array(n + 1);
    for (let i = 1; i < n; i++) {
      const t = tr[i], p = tr[i - 1];
      if (!t.xy || !p.xy) continue;
      const cos = -(((p.b[0] - p.a[0]) * (t.b[0] - t.a[0]) + (p.b[1] - p.a[1]) * (t.b[1] - t.a[1])) / (p.L * t.L));
      let vj;
      if (cos <= -0.999999) vj = Infinity; else if (cos >= 0.999999) vj = 0;
      else { const s = Math.sqrt(0.5 * (1 - cos)); vj = Math.sqrt(a * dj * s / (1 - s)); }
      vin[i] = Math.min(vj, t.v, p.v);
    }
    for (let i = n - 1; i >= 0; i--) vin[i] = Math.min(vin[i], Math.sqrt(vin[i + 1] * vin[i + 1] + 2 * a * tr[i].L));
    for (let i = 0; i < n; i++) vin[i + 1] = Math.min(vin[i + 1], Math.sqrt(vin[i] * vin[i] + 2 * a * tr[i].L));
    let T = 0;
    for (let i = 0; i < n; i++) {
      const t = tr[i], v0 = vin[i], v1 = vin[i + 1], vm = t.v, L = t.L;
      let dt = 0;
      if (L > 0) {
        const vp2 = (2 * a * L + v0 * v0 + v1 * v1) / 2;
        if (vp2 >= vm * vm) dt = (vm - v0) / a + (vm - v1) / a + Math.max(0, L - (vm * vm - v0 * v0) / (2 * a) - (vm * vm - v1 * v1) / (2 * a)) / vm;
        else { const vp = Math.sqrt(vp2); dt = (vp - v0) / a + (vp - v1) / a; }
      }
      t.t0 = T; T += dt; t.t1 = T;
    }
    return { tramos: tr, total: T };
  }
  const api = { PERFIL_DEF, desplazar, recorridos, escribir, leer, simular, profundidades };
  raiz.NestGcode = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
