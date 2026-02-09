function requireLogin(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ success: false, error: 'Login required' });
  }
  res.redirect('/login');
}

function optionalUser(req, res, next) {
  res.locals.user = req.session?.userId ? req.session : null;
  next();
}

function guestOnly(req, res, next) {
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  next();
}

module.exports = { requireLogin, optionalUser, guestOnly };
