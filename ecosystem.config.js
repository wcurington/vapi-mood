module.exports = {
  apps: [
    {
      name: "alex-backend",
      script: "server.js",               // always promote to server.js
      cwd: "/opt/vps_spinup_kit",        // project root
      instances: 1,                      // single instance for voice
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: 3000                       // Node now runs on internal port 3000
      }
    }
  ]
};
