const { getJsonCache, setJsonCache, deleteCache, cacheResponse } = require('../../services/cache-store');

describe('Cache Store', () => {
  afterEach(async () => {
    await deleteCache('test-key');
    await deleteCache('test-obj');
  });

  test('set and get JSON value', async () => {
    await setJsonCache('test-key', { foo: 'bar' }, 10);
    const result = await getJsonCache('test-key');
    expect(result).toEqual({ foo: 'bar' });
  });

  test('returns null for missing key', async () => {
    const result = await getJsonCache('nonexistent-key-12345');
    expect(result).toBeNull();
  });

  test('respects TTL expiration', async () => {
    await setJsonCache('test-key', 'value', 1);
    await new Promise(resolve => setTimeout(resolve, 1200));
    const result = await getJsonCache('test-key');
    expect(result).toBeNull();
  }, 5000);

  test('handles complex objects', async () => {
    const complex = {
      nested: { array: [1, 2, 3] },
      date: '2026-01-01',
      num: 42.5,
      bool: true
    };
    await setJsonCache('test-obj', complex, 10);
    const result = await getJsonCache('test-obj');
    expect(result).toEqual(complex);
  });

  test('deleteCache removes entry', async () => {
    await setJsonCache('test-key', 'to-delete', 60);
    await deleteCache('test-key');
    const result = await getJsonCache('test-key');
    expect(result).toBeNull();
  });
});

describe('cacheResponse middleware', () => {
  function mockReq(url) {
    return { originalUrl: url };
  }

  function mockRes() {
    const res = {
      statusCode: 200,
      _headers: {},
      _body: null,
      set(key, val) {
        if (typeof key === 'object') Object.assign(res._headers, key);
        else res._headers[key] = val;
        return res;
      },
      get(key) { return res._headers[key]; },
      status(code) { res.statusCode = code; return res; },
      send(body) { res._body = body; return res; }
    };
    return res;
  }

  test('caches response on first call', () => {
    const middleware = cacheResponse('test', 60);
    const req = mockReq('/test-page');
    const res = mockRes();
    const next = jest.fn();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();

    res.send('<html>cached content</html>');
    expect(res._headers['X-Cache']).toBe('MISS');
  });

  test('returns cached response on second call', () => {
    const middleware = cacheResponse('test2', 60);

    const req1 = mockReq('/cached-page');
    const res1 = mockRes();
    middleware(req1, res1, jest.fn());
    res1.send('<html>cached</html>');

    const req2 = mockReq('/cached-page');
    const res2 = mockRes();
    const next2 = jest.fn();
    middleware(req2, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2._headers['X-Cache']).toBe('HIT');
    expect(res2._body).toBe('<html>cached</html>');
  });

  test('does not cache error responses', () => {
    const middleware = cacheResponse('test3', 60);

    const req1 = mockReq('/error-page');
    const res1 = mockRes();
    res1.statusCode = 500;
    middleware(req1, res1, jest.fn());
    res1.send('error');

    const req2 = mockReq('/error-page');
    const res2 = mockRes();
    const next2 = jest.fn();
    middleware(req2, res2, next2);
    expect(next2).toHaveBeenCalled();
  });
});
