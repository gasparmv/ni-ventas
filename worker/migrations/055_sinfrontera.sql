-- 055 — Sin Frontera (usuario externo, 15-oct-2026): fabrican nuestros corpóreos y nos compran neón.
-- El estado de producción de cada corpóreo lo ponen ellos en pedidos.prod_estado (en_diseno / en_impresion / en_ensamble /
-- listo / entregado; '' = por empezar) con historial en pedido_prod_log (campo 'estado'): columnas de la 053.
-- Sus pedidos = los de sus números (kv sinfrontera_tels) + los que Gaspar vincula a mano acá.
-- El usuario 'sinfrontera' (users_panel, rol 'sinfrontera') lo crea POST /admin/sinfrontera/password: no se siembra sin hash.
-- El worker también lo asegura con ensureSinFronteraSchema().
--   wrangler d1 execute ni-ventas --remote --config wrangler.toml --file=migrations/055_sinfrontera.sql
CREATE TABLE IF NOT EXISTS sinfrontera_pedidos (pedido_id INTEGER PRIMARY KEY, por TEXT, at TEXT);
