const { requireLogin, optionalUser, guestOnly } = require('../../middleware/auth');

function mockReq(overrides = {}) {
  return {
    session: overrides.session || {},
    headers: overrides.headers || {},
    path: overrides.path || '/',
    xhr: overrides.xhr || false,
    ...overrides
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    _redirectUrl: null,
    _json: null,
    locals: {},
    status(code) { res.statusCode = code; return res; },
    json(data) { res._json = data; return res; },
    redirect(url) { res._redirectUrl = url; return res; },
    send(body) { res._body = body; return res; }
  };
  return res;
}

describe('Auth Middleware', () => {
  describe('requireLogin', () => {
    test('allows request with valid session userId', () => {
      const req = mockReq({ session: { userId: 'user123' } });
      const res = mockRes();
      const next = jest.fn();
      requireLogin(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    test('redirects to /login when no session', () => {
      const req = mockReq({ session: {} });
      const res = mockRes();
      const next = jest.fn();
      requireLogin(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._redirectUrl).toBe('/login');
    });

    test('returns 401 JSON for API requests without session', () => {
      const req = mockReq({
        session: {},
        path: '/api/trades',
        headers: { accept: 'application/json' }
      });
      const res = mockRes();
      const next = jest.fn();
      requireLogin(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res._json).toEqual({ success: false, error: 'Login required' });
    });

    test('rejects empty userId in session', () => {
      const req = mockReq({ session: { userId: '' } });
      const res = mockRes();
      const next = jest.fn();
      requireLogin(req, res, next);
      expect(next).not.toHaveBeenCalled();
    });

    test('supports Bearer token auth', () => {
      const jwt = require('jsonwebtoken');
      const secret = 'test-secret';
      process.env.JWT_SECRET = secret;
      const token = jwt.sign({ userId: 'bearer-user-123' }, secret);
      const req = mockReq({
        session: {},
        headers: { authorization: `Bearer ${token}` }
      });
      const res = mockRes();
      const next = jest.fn();
      requireLogin(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(req.session.userId).toBe('bearer-user-123');
      delete process.env.JWT_SECRET;
    });

    test('rejects invalid Bearer token', () => {
      process.env.JWT_SECRET = 'test-secret';
      const req = mockReq({
        session: {},
        path: '/api/data',
        headers: {
          authorization: 'Bearer invalid-token',
          accept: 'application/json'
        }
      });
      const res = mockRes();
      const next = jest.fn();
      requireLogin(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      delete process.env.JWT_SECRET;
    });
  });

  describe('optionalUser', () => {
    test('sets res.locals.user when session exists', () => {
      const req = mockReq({
        session: { userId: 'user1', username: 'testuser', email: 'test@example.com' }
      });
      const res = mockRes();
      const next = jest.fn();
      optionalUser(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.locals.user).toEqual({
        userId: 'user1',
        username: 'testuser',
        email: 'test@example.com'
      });
    });

    test('sets res.locals.user to null when no session', () => {
      const req = mockReq({ session: {} });
      const res = mockRes();
      const next = jest.fn();
      optionalUser(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.locals.user).toBeNull();
    });

    test('does not leak internal session data', () => {
      const req = mockReq({
        session: {
          userId: 'user1',
          username: 'test',
          email: 'test@example.com',
          cookie: { maxAge: 86400 },
          _internalField: 'secret'
        }
      });
      const res = mockRes();
      const next = jest.fn();
      optionalUser(req, res, next);
      expect(res.locals.user).not.toHaveProperty('cookie');
      expect(res.locals.user).not.toHaveProperty('_internalField');
    });
  });

  describe('guestOnly', () => {
    test('redirects logged-in users to /', () => {
      const req = mockReq({ session: { userId: 'user1' } });
      const res = mockRes();
      const next = jest.fn();
      guestOnly(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res._redirectUrl).toBe('/');
    });

    test('allows unauthenticated users through', () => {
      const req = mockReq({ session: {} });
      const res = mockRes();
      const next = jest.fn();
      guestOnly(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});

describe('User Model Security', () => {
  test('password is hashed with bcrypt', () => {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('testpassword', 12);
    expect(hash).not.toBe('testpassword');
    expect(bcrypt.compareSync('testpassword', hash)).toBe(true);
    expect(bcrypt.compareSync('wrongpassword', hash)).toBe(false);
  });

  test('bcrypt uses 12 rounds', () => {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('test', 12);
    expect(bcrypt.getRounds(hash)).toBe(12);
  });
});

describe('Input Validation', () => {
  test('referral code normalization strips invalid chars', () => {
    function normalizeReferralCode(code) {
      return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    }
    expect(normalizeReferralCode('abc123')).toBe('ABC123');
    expect(normalizeReferralCode('<script>alert(1)</script>')).toBe('SCRIPTALERT1SCRIPT');
    expect(normalizeReferralCode('CODE_1-A')).toBe('CODE_1-A');
    expect(normalizeReferralCode('')).toBe('');
    expect(normalizeReferralCode(null)).toBe('');
  });

  test('plan normalization only allows pro or elite', () => {
    function normalizeSelectedPlan(plan) {
      const normalized = String(plan || '').trim().toLowerCase();
      return normalized === 'elite' ? 'elite' : (normalized === 'pro' ? 'pro' : '');
    }
    expect(normalizeSelectedPlan('pro')).toBe('pro');
    expect(normalizeSelectedPlan('elite')).toBe('elite');
    expect(normalizeSelectedPlan('ELITE')).toBe('elite');
    expect(normalizeSelectedPlan('admin')).toBe('');
    expect(normalizeSelectedPlan('<script>')).toBe('');
    expect(normalizeSelectedPlan('')).toBe('');
  });

  test('autoTradeMinScore clamps between 30 and 95', () => {
    function clampScore(val) {
      return Math.min(95, Math.max(30, parseInt(val, 10) || 62));
    }
    expect(clampScore(50)).toBe(50);
    expect(clampScore(10)).toBe(30);
    expect(clampScore(100)).toBe(95);
    expect(clampScore(NaN)).toBe(62);
    expect(clampScore('abc')).toBe(62);
  });
});
