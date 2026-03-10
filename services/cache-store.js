const { createClient } = require('redis');

const memCache = new Map();
let redisClient = null;
let redisInitStarted = false;

function nowMs() {
  return Date.now();
}

function cleanupMemCache() {
  const now = nowMs();
  for (const [k, v] of memCache.entries()) {
    if (!v || v.expiresAt <= now) memCache.delete(k);
  }
}

const cleanupTimer = setInterval(cleanupMemCache, 60 * 1000);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

async function initRedisIfNeeded() {
  if (redisInitStarted) return redisClient;
  redisInitStarted = true;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn('[CacheStore] REDIS_URL not set — using in-memory cache. Set REDIS_URL for production scalability.');
    return null;
  }

  try {
    redisClient = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (retries) => Math.min(retries * 500, 5000)
      }
    });
    redisClient.on('error', (err) => {
      console.warn('[CacheStore] Redis error:', err.message);
    });
    redisClient.on('reconnecting', () => {
      console.log('[CacheStore] Redis reconnecting...');
    });
    await redisClient.connect();
    console.log('[CacheStore] Redis connected');
  } catch (err) {
    console.warn('[CacheStore] Redis unavailable, using in-memory cache:', err.message);
    redisClient = null;
  }
  return redisClient;
}

async function getJsonCache(key) {
  const client = await initRedisIfNeeded();
  if (client) {
    try {
      const raw = await client.get(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  const entry = memCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= nowMs()) {
    memCache.delete(key);
    return null;
  }
  return entry.value;
}

async function setJsonCache(key, value, ttlSeconds) {
  const ttl = Math.max(1, Number(ttlSeconds) || 1);
  const client = await initRedisIfNeeded();
  if (client) {
    try {
      await client.setEx(key, ttl, JSON.stringify(value));
      return;
    } catch (err) {
      // fallback below
    }
  }
  memCache.set(key, { value, expiresAt: nowMs() + ttl * 1000 });
}

async function deleteCache(key) {
  const client = await initRedisIfNeeded();
  if (client) {
    try { await client.del(key); } catch (_) {}
  }
  memCache.delete(key);
}

function cacheResponse(keyPrefix, ttlSeconds) {
  const responseCache = new Map();
  return function(req, res, next) {
    const cacheKey = `${keyPrefix}:${req.originalUrl}`;
    const cached = responseCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < ttlSeconds * 1000) {
      res.set('X-Cache', 'HIT');
      res.status(cached.status).set(cached.headers).send(cached.body);
      return;
    }
    const origSend = res.send.bind(res);
    res.send = function(body) {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        responseCache.set(cacheKey, {
          body,
          status: res.statusCode,
          headers: { 'content-type': res.get('content-type') || 'text/html' },
          at: Date.now()
        });
        if (responseCache.size > 200) {
          const oldest = responseCache.keys().next().value;
          responseCache.delete(oldest);
        }
      }
      res.set('X-Cache', 'MISS');
      return origSend(body);
    };
    next();
  };
}

module.exports = {
  getJsonCache,
  setJsonCache,
  deleteCache,
  cacheResponse,
  initRedisIfNeeded
};
