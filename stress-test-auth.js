const autocannon = require('autocannon');
require('dotenv').config();

const token = String(process.env.TEST_JWT_TOKEN || '').trim();
if (!token) {
  console.error('TEST_JWT_TOKEN is required');
  process.exit(1);
}

const instance = autocannon({
  url: String(process.env.STRESS_BASE_URL || 'https://alphaconfluence.com'),
  connections: Number(process.env.STRESS_CONNECTIONS || 50),
  duration: Number(process.env.STRESS_DURATION || 60),
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  requests: [
    {
      method: 'POST',
      path: '/api/backtest/run',
      body: JSON.stringify({
        coin: 'ethereum',
        startDate: '2025-03-08',
        endDate: '2026-03-08',
        riskAmount: 100
      })
    }
  ]
});

autocannon.track(instance);

instance.on('done', (results) => {
  const statusCodes = results.statusCodeStats || {};
  const toNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const success2xxFromStats = Object.entries(statusCodes).reduce((sum, [code, count]) => {
    return (/^2\d\d$/.test(code) || code === '2xx' ? sum + toNumber(count) : sum);
  }, 0);
  const non2xxFromStats = Object.entries(statusCodes).reduce((sum, [code, count]) => {
    return (!/^2\d\d$/.test(code) && code !== '2xx' ? sum + toNumber(count) : sum);
  }, 0);
  const success2xx = success2xxFromStats || toNumber(results['2xx']);
  const non2xx = non2xxFromStats || (
    toNumber(results['1xx']) + toNumber(results['3xx']) + toNumber(results['4xx']) + toNumber(results['5xx'])
  );
  console.log('=== AUTHENTICATED STRESS TEST RESULTS ===');
  console.log('Avg latency:', results.latency.mean, 'ms');
  console.log('p99 latency:', results.latency.p99, 'ms');
  console.log('Requests/sec:', results.requests.mean);
  console.log('2xx responses:', success2xx);
  console.log('Non-2xx responses:', non2xx);
  console.log('Errors:', results.errors);
  console.log('Throughput:', results.throughput.mean, 'bytes/sec');
});
