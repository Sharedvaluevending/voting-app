// services/push-notifications.js - Web Push for trade open/close
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const VAPID_FILE = path.join(__dirname, '..', '.vapid-keys.json');

let vapidKeys = null;
function getVapidKeys() {
  if (vapidKeys) return vapidKeys;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (pub && priv) {
    vapidKeys = { publicKey: pub, privateKey: priv };
    webpush.setVapidDetails('mailto:support@cryptosignals.local', pub, priv);
    return vapidKeys;
  }
  // Auto-generate and persist if not in env
  try {
    if (fs.existsSync(VAPID_FILE)) {
      const data = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      if (data.publicKey && data.privateKey) {
        vapidKeys = { publicKey: data.publicKey, privateKey: data.privateKey };
        webpush.setVapidDetails('mailto:support@cryptosignals.local', vapidKeys.publicKey, vapidKeys.privateKey);
        console.log('[Push] Loaded VAPID keys from .vapid-keys.json');
        return vapidKeys;
      }
    }
    const generated = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_FILE, JSON.stringify({ publicKey: generated.publicKey, privateKey: generated.privateKey }, null, 2));
    vapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    webpush.setVapidDetails('mailto:support@cryptosignals.local', vapidKeys.publicKey, vapidKeys.privateKey);
    console.log('[Push] Generated and saved VAPID keys to .vapid-keys.json');
    return vapidKeys;
  } catch (e) {
    console.warn('[Push] Could not load/generate VAPID keys:', e.message);
    return null;
  }
}

async function sendPushToUser(user, title, body) {
  const keys = getVapidKeys();
  if (!keys || !user || !Array.isArray(user.pushSubscriptions) || user.pushSubscriptions.length === 0) return;
  const payload = JSON.stringify({ title, body });
  const dead = [];
  for (const sub of user.pushSubscriptions) {
    try {
      if (sub && sub.endpoint) {
        await webpush.sendNotification(sub, payload, { TTL: 60 });
      }
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) dead.push(sub);
    }
  }
  if (dead.length > 0 && user._id) {
    const User = require('../models/User');
    const u = await User.findById(user._id);
    if (u && Array.isArray(u.pushSubscriptions)) {
      u.pushSubscriptions = u.pushSubscriptions.filter(s => !dead.includes(s));
      await u.save();
    }
  }
}

module.exports = { sendPushToUser, getVapidKeys };
