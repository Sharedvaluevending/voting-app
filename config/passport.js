/**
 * Passport config for Google OAuth
 */
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const crypto = require('crypto');
const User = require('../models/User');

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  console.warn('[Auth] Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable "Sign in with Google".');
}

const baseUrl = process.env.GOOGLE_CALLBACK_URL || process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || 'http://localhost:3000';
const callbackURL = (baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl).replace(/\/$/, '') + '/auth/google/callback';

function getClientIp(req) {
  const xff = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req?.ip || req?.connection?.remoteAddress || 'unknown';
}

function hashIp(ip) {
  const cleanIp = String(ip || '').trim();
  if (!cleanIp) return '';
  return crypto.createHash('sha256').update(cleanIp).digest('hex');
}

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL,
    passReqToCallback: true
  }, async (req, accessToken, refreshToken, profile, done) => {
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

    const clientIp = getClientIp(req);
    const registrationIpHash = hashIp(clientIp);
    const ipDuplicateFilters = [];
    if (registrationIpHash) {
      ipDuplicateFilters.push({ registrationIpHash, trialGrantedAt: { $ne: null } });
    }
    if (clientIp && clientIp !== 'unknown') {
      ipDuplicateFilters.push({ 'legal.acceptedIp': clientIp, trialEndsAt: { $ne: null } });
    }
    if (ipDuplicateFilters.length > 0) {
      const existingTrialFromIp = await User.exists({ $or: ipDuplicateFilters });
      if (existingTrialFromIp) {
        return done(new Error('A free trial has already been used from this network. Please log in to your existing account or contact support.'), null);
      }
    }

    const SystemConfig = require('../models/SystemConfig');
    const betaDoc = await SystemConfig.findOne({ key: 'beta_config' }).lean();
    if (betaDoc?.value?.enabled) {
      return done(new Error('Registration is closed during beta. Please sign up with a beta access code instead.'), null);
    }

    user = await User.create({
      email: email.toLowerCase(),
      username,
      password: '',
      googleId,
      paperBalance: 10000,
      initialBalance: 10000,
      subscriptionTier: 'trial',
      trialGrantedAt: new Date(),
      registrationIpHash,
      trialEndsAt: new Date(Date.now() + (14 * 24 * 60 * 60 * 1000)),
      subscriptionEndsAt: new Date(Date.now() + (14 * 24 * 60 * 60 * 1000))
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
