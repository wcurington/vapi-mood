module.exports = {
  apps: [
    {
      name: "alex-backend",
      script: "server_v2.5.4.js",   // your main server file
      cwd: "/opt/vapi-render-webhook", // working directory
      instances: 1,                 // keep single instance (voice agents don’t like race conditions)
      autorestart: true,
      watch: false,                 // set true if you want auto-restart on file changes
      max_memory_restart: "512M",   // restart if memory > 512 MB
      env: {
        NODE_ENV: "production",
        PORT: 8880,
        OPENAI_API_KEY: "sk-xxxxxxxxxxxxxxxxxxxxxxxx",   // better: load from /etc/environment or .env
        DATABASE_URL: "postgres://alex:secret@localhost:5432/alexdb",
        REDIS_URL: "redis://127.0.0.1:6379/0",
        MODEL_MAIN: "gpt-4.1",
        MODEL_SUMMARY: "gpt-4.1-mini",
        USE_WHISPER: "true",
        CARRIER_ADAPTER: "signalwire"
      }
    }
  ]
};
