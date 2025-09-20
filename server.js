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
