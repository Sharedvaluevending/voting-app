const os = require('os');

const THRESHOLDS = {
  responseTime: 3000,
  errorRate: 0.05,
  memoryUsage: 0.85,
  cpuUsage: 0.9,
  port3000Errors: 0
};

let lastCpu = null;

function getCpuUsageRatio() {
  const cpus = os.cpus();
  const totals = cpus.map((cpu) => {
    const t = cpu.times;
    const total = t.user + t.nice + t.sys + t.idle + t.irq;
    return { idle: t.idle, total };
  });

  if (!lastCpu) {
    lastCpu = totals;
    return 0;
  }

  let idleDiff = 0;
  let totalDiff = 0;
  for (let i = 0; i < totals.length; i += 1) {
    idleDiff += totals[i].idle - lastCpu[i].idle;
    totalDiff += totals[i].total - lastCpu[i].total;
  }
  lastCpu = totals;

  if (totalDiff <= 0) return 0;
  return 1 - idleDiff / totalDiff;
}

function getServerStats() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const cpuUsageRatio = getCpuUsageRatio();

  return {
    cpu: {
      usageRatio: cpuUsageRatio,
      usagePct: (cpuUsageRatio * 100).toFixed(1) + '%',
      loadAverage: os.loadavg()
    },
    memory: {
      total: (totalMem / 1024 / 1024 / 1024).toFixed(2) + 'GB',
      used: (usedMem / 1024 / 1024 / 1024).toFixed(2) + 'GB',
      free: (freeMem / 1024 / 1024 / 1024).toFixed(2) + 'GB',
      ratio: usedMem / totalMem,
      percentage: ((usedMem / totalMem) * 100).toFixed(1) + '%'
    },
    uptimeSec: os.uptime(),
    nodeMemory: process.memoryUsage()
  };
}

function printThresholdAlerts(stats) {
  const alerts = [];
  if (stats.memory.ratio > THRESHOLDS.memoryUsage) {
    alerts.push(
      `[ALERT] Memory usage exceeded ${Math.round(THRESHOLDS.memoryUsage * 100)}%`
    );
  }
  if (stats.cpu.usageRatio > THRESHOLDS.cpuUsage) {
    alerts.push(
      `[ALERT] CPU usage exceeded ${Math.round(THRESHOLDS.cpuUsage * 100)}%`
    );
  }
  if (alerts.length === 0) return;
  for (const alert of alerts) {
    console.log(alert);
  }
}

console.log('Starting server monitor (5s interval)...');
console.log('Thresholds:', THRESHOLDS);

setInterval(() => {
  const stats = getServerStats();
  console.log('=== SERVER STATS ===');
  console.log('Load avg:', stats.cpu.loadAverage.join(', '));
  console.log('CPU usage:', stats.cpu.usagePct);
  console.log('Memory:', stats.memory.percentage, 'used');
  console.log(
    'Node heap:',
    (stats.nodeMemory.heapUsed / 1024 / 1024).toFixed(1) + 'MB'
  );
  console.log('Uptime:', stats.uptimeSec + 's');
  printThresholdAlerts(stats);
  console.log('====================');
}, 5000);
