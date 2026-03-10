const jwt = require('jsonwebtoken');

function resolveBearerUser(req) {
  const authHeader = String(req.headers.authorization || '');
  if (!authHeader.toLowerCase().startsWith('bearer ')) return null;
  const token = authHeader.slice(7).trim();
  const secret = String(process.env.JWT_SECRET || process.env.SESSION_SECRET || '').trim();
  if (!token || !secret) return null;
  try {
    const payload = jwt.verify(token, secret);
    const userId = payload?.userId || payload?.sub || payload?.id;
    if (!userId) return null;
    return {
      userId: String(userId),
      username: payload?.username || payload?.email || 'jwt-user',
      email: payload?.email || ''
    };
  } catch (_) {
    return null;
  }
}

function requireLogin(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  const bearerUser = resolveBearerUser(req);
  if (bearerUser) {
    req.session = req.session || {};
    req.session.userId = bearerUser.userId;
    req.session.username = bearerUser.username;
    req.session.email = bearerUser.email;
    return next();
  }
  const wantsJson = req.path?.startsWith('/api/')
    || req.xhr
    || req.headers.accept?.includes('application/json')
    || req.headers['content-type']?.includes('application/json');
  if (wantsJson) {
    return res.status(401).json({ success: false, error: 'Login required' });
  }
  res.redirect('/login');
}

function optionalUser(req, res, next) {
  // Only expose safe session fields to templates — prevents leaking internal session data
  if (req.session?.userId) {
    res.locals.user = {
      userId: req.session.userId,
      username: req.session.username,
      email: req.session.email
    };
  } else {
    res.locals.user = null;
  }
  next();
}

function guestOnly(req, res, next) {
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  next();
}

module.exports = { requireLogin, optionalUser, guestOnly };
