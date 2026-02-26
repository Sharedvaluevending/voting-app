/**
 * Passport config for Google OAuth
 */
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.warn('[Auth] Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable "Sign in with Google".');
}

const baseUrl = process.env.GOOGLE_CALLBACK_URL || process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || 'http://localhost:3000';
const callbackURL = (baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl).replace(/\/$/, '') + '/auth/google/callback';

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL
  }, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = (profile.emails && profile.emails[0]?.value) || null;
    const name = profile.displayName || profile.name?.givenName || 'User';
    const googleId = profile.id;

    if (!email) return done(new Error('Google did not provide email'), null);

    let user = await User.findOne({ googleId });
    if (user) return done(null, user);

    user = await User.findOne({ email: email.toLowerCase() });
    if (user) {
      user.googleId = googleId;
      await user.save();
      return done(null, user);
    }

    const baseUsername = name.replace(/\s+/g, '').toLowerCase().slice(0, 15) || 'user';
    let username = baseUsername;
    let suffix = 0;
    while (await User.findOne({ username })) {
      username = baseUsername + (++suffix);
    }

    user = await User.create({
      email: email.toLowerCase(),
      username,
      password: '',
      googleId,
      paperBalance: 10000,
      initialBalance: 10000
    });
    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));
}

passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});
