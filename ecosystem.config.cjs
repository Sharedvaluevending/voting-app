module.exports = {
  apps: [
    {
      name: 'alphaconfluence',
      script: 'voting-app.js',
      cwd: '/root/voting-app',
      exec_mode: 'cluster',
      instances: 'max',
      autorestart: true,
      max_memory_restart: '1500M',
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,
      exp_backoff_restart_delay: 200,
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        // Runtime tuning defaults
        REFRESH_INTERVAL_MS: '180000',
        BACKTEST_QUEUE_CONCURRENCY: '10',
        BACKTEST_QUEUE_MAX_WAITING: '50',
        MAX_BACKTEST_COINS: '10',
        MAX_SMC_BACKTEST_COINS: '12',
        MONGO_MAX_POOL_SIZE: '50',
        MONGO_MIN_POOL_SIZE: '5',
        MONGO_WAIT_QUEUE_TIMEOUT_MS: '12000',
        API_UNAUTH_LIMIT: '20',
        API_AUTH_LIMIT: '500',
        API_BACKTEST_PER_MIN: '3',
        SLOW_HTTP_MS: '1200',
        SLOW_DB_MS: '300'
      }
    }
  ]
};
