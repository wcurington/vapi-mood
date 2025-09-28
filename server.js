// server.js — loader for versioned core (v1.3.0)
const TARGET_CORE = './server_v1.3.0.js';
try { require(TARGET_CORE); } catch (e) { console.error('Failed to load core', e); process.exit(1); }
