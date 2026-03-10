module.exports = {
  apps: [
    {
      name: 'alphaconfluence',
      script: 'voting-app.js',
      instances: 'max',
      exec_mode: 'cluster',
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,
      max_memory_restart: '1500M',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
