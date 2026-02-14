// services/push-notifications.js - Web Push for trade open/close
const webpush = require('web-push');

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
  return null;
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
