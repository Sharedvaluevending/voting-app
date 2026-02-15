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
