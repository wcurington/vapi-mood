/**
 * server.js (loader) — Alex v1.3.1
 * Purpose: Minimal loader that forwards to the versioned XXL server.
 * NOTE: keep this file stable; swap versions by changing the require path below.
 */
"use strict";

/* Hard safety: bail fast if double-loaded */
if (global.__ALEX_SERVER_LOADER__) {
  console.warn("server.js loader already initialized; skipping duplicate load.");
} else {
  global.__ALEX_SERVER_LOADER__ = true;
}

try {
  // Version switchboard
  require("./server_v1.3.1.js");
} catch (err) {
  console.error("Failed to load server_v1.3.1.js:", err);
  process.exit(1);
}
