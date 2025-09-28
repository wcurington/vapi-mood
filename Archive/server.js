/**
 * Root loader entrypoint kept for Render/Node.
 * Delegates to the versioned XXL core server implementation.
 */
'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.title = 'alex-server-loader';

// Prefer explicit port if Render provides PORT, else 3000 for local
process.env.PORT = process.env.PORT || '3000';

// Forward to the versioned implementation
require('./server_v1.2.0.js');
