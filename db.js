// db.js — Postgres connection pool
'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'vps_spinup_kit-postgres',
  port: process.env.PGPORT || 5432,
  user: process.env.PGUSER || 'alex',
  password: process.env.PGPASSWORD || 'secret',
  database: process.env.PGDATABASE || 'alexdb',
  max: 10,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
