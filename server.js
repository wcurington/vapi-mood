'use strict';
/**
 * Thin loader that pins the running core to server_v1.3.2.js
 * This lets you hot-swap versions by only changing this file.
 */
try {
  require('./server_v1.3.2.js');
} catch (err) {
  console.error('FATAL: failed to start server_v1.3.2.js', err);
  process.exit(1);
}
