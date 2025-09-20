/*
  Simple backend Express + Turso (libSQL)
  - Lee variables desde .env
  - Expone endpoints REST para probar la BD
*/

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { createClient } = require('@libsql/client');

// Cargar variables de entorno
dotenv.config();

const PORT = process.env.PORT || 3000;
const TURSO_URL = process.env.TURSO_URL; // p.ej: libsql://...turso.io
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN; // token JWT

if (!TURSO_URL || !TURSO_AUTH_TOKEN) {
  console.warn('[WARN] TURSO_URL o TURSO_AUTH_TOKEN no definidos en .env');
}

// Cliente libSQL/Turso
const db = createClient({
  url: TURSO_URL,
  authToken: TURSO_AUTH_TOKEN,
});

const app = express();
app.use(cors());
app.use(express.json());

// Endpoints
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'cursoflujo-backend', time: new Date().toISOString() });
});

app.get('/api/version', async (req, res) => {
  try {
    const rs = await db.execute('select sqlite_version() as version');
    const version = rs.rows?.[0]?.version ?? null;
    res.json({ ok: true, version });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Inicializa una tabla de ejemplo (id, title)
app.post('/api/init', async (req, res) => {
  const sql = `
    create table if not exists notes (
      id integer primary key,
      title text not null,
      created_at text default (datetime('now'))
    );
  `;
  try {
    await db.execute(sql);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Inicializa tabla para clientes por día
app.post('/api/init-clients', async (req, res) => {
  try {
    await db.execute("create table if not exists clients (id integer primary key, day text not null, name text not null, created_at text default (datetime('now')))");
    await db.execute("create index if not exists idx_clients_day on clients(day)");
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Inserta una nota de ejemplo
app.post('/api/notes', async (req, res) => {
  const { title } = req.body ?? {};
  if (!title) return res.status(400).json({ ok: false, error: 'title requerido' });
  try {
    const rs = await db.execute({
      sql: 'insert into notes (title) values (?) returning id, title, created_at',
      args: [title],
    });
    res.json({ ok: true, row: rs.rows?.[0] ?? null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Lista notas
app.get('/api/notes', async (req, res) => {
  try {
    const rs = await db.execute('select id, title, created_at from notes order by id desc');
    res.json({ ok: true, rows: rs.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Crear cliente para una fecha (solo Lun-Vie, máx 10)
app.post('/api/clients', async (req, res) => {
  const { day, name } = req.body ?? {};
  if (!day || !name) return res.status(400).json({ ok: false, error: 'day y name requeridos' });
  try {
    // Validar fecha YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return res.status(400).json({ ok: false, error: 'Formato de day inválido. Usa YYYY-MM-DD' });
    }
    // Determinar día de la semana en UTC: 0=Dom ... 6=Sab
    const d = new Date(day + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({ ok: false, error: 'Fecha inválida' });
    }
    const weekday = d.getUTCDay();
    if (weekday === 0 || weekday === 6) {
      return res.status(400).json({ ok: false, error: 'Solo se permiten clientes de lunes a viernes' });
    }
    // Contar existentes
    const cnt = await db.execute({ sql: 'select count(*) as c from clients where day = ?', args: [day] });
    const c = Number(cnt.rows?.[0]?.c ?? 0);
    if (c >= 10) {
      return res.status(400).json({ ok: false, error: 'Máximo 10 clientes por día' });
    }
    // Insertar
    const rs = await db.execute({ sql: 'insert into clients (day, name) values (?, ?) returning id, day, name, created_at', args: [day, name] });
    res.json({ ok: true, row: rs.rows?.[0] ?? null, remaining: 9 - c });
  } catch (err) {
    console.error(err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Listar clientes de un día concreto
app.get('/api/clients', async (req, res) => {
  const { day } = req.query;
  if (!day) return res.status(400).json({ ok: false, error: 'query param day requerido (YYYY-MM-DD)' });
  try {
    const rs = await db.execute({
      sql: 'select id, name, day, created_at from clients where day = ? order by id asc',
      args: [day]
    });
    res.json({ ok: true, rows: rs.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Eliminar cliente por id
app.delete('/api/clients/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
  try {
    const rs = await db.execute({ sql: 'delete from clients where id = ? returning id', args: [id] });
    const deleted = rs.rows?.[0]?.id != null;
    if (!deleted) return res.status(404).json({ ok: false, error: 'Cliente no encontrado' });
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Resumen por mes: conteo de clientes por día (YYYY, MM 1-12)
app.get('/api/clients/summary', async (req, res) => {
  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10); // 1..12
  if (!year || !month) return res.status(400).json({ ok: false, error: 'year y month requeridos' });
  const yyyy = String(year).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const start = `${yyyy}-${mm}-01`;
  // último día del mes: usar truco sumando un mes y restando un día
  const nextMonth = month === 12 ? `${year + 1}-01-01` : `${yyyy}-${String(month + 1).padStart(2, '0')}-01`;
  try {
    const rs = await db.execute({
      sql: `
        select day, count(*) as count
        from clients
        where day >= ? and day < ?
        group by day
      `,
      args: [start, nextMonth]
    });
    res.json({ ok: true, rows: rs.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Endpoint genérico para ejecutar SQL (uso con cuidado)
app.post('/api/exec', async (req, res) => {
  const { sql, params } = req.body ?? {};
  if (!sql) return res.status(400).json({ ok: false, error: 'sql requerido' });
  try {
    const rs = await db.execute({ sql, args: params || [] });
    res.json({ ok: true, rows: rs.rows, cols: rs.columns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[server] escuchando en http://localhost:${PORT}`);
});
