// services/notifications.js
// ====================================================
// Push notifications for trades and action badges
// Web Push (free, works on mobile) + optional SMS via email-to-SMS
// ====================================================

const webpush = require('web-push');
const User = require('../models/User');

let vapidConfigured = false;
function ensureVapid() {
  if (vapidConfigured) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (publicKey && privateKey) {
    webpush.setVapidDetails(
      process.env.VAPID_MAILTO || 'mailto:support@cryptosignals.local',
      publicKey,
      privateKey
    );
    vapidConfigured = true;
    return true;
  }
  return false;
}

/**
 * Send push notification to user's subscribed devices
 * @param {string} userId - User ID
 * @param {string} title - Notification title
 * @param {Object} options - { body?, tag?, url?, data? }
 */
async function sendPushNotification(userId, title, options = {}) {
  if (!ensureVapid()) {
    if (process.env.NODE_ENV !== 'production') {
      console.log('[Notifications] VAPID not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.');
    }
    return;
  }
  const user = await User.findById(userId).select('pushSubscriptions').lean();
  if (!user?.pushSubscriptions?.length) return;

  const payload = JSON.stringify({
    title,
    body: options.body || '',
    tag: options.tag || 'trade',
    url: options.url || '/trades',
    data: options.data || {}
  });

  const results = await Promise.allSettled(
    user.pushSubscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          payload,
          { TTL: 3600 }
        );
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await User.updateOne(
            { _id: userId },
            { $pull: { pushSubscriptions: { endpoint: sub.endpoint } } }
          );
        }
        throw e;
      }
    })
  );

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0 && process.env.NODE_ENV !== 'production') {
    console.warn('[Notifications] Some push sends failed:', failed.map((f) => f.reason?.message));
  }
}

/**
 * Send SMS via email-to-SMS (free, US carriers)
 * User provides phoneSmsEmail e.g. 5551234567@vtext.com (Verizon)
 * @param {string} phoneSmsEmail - number@carrier-gateway.com
 * @param {string} message - SMS body (keep short)
 */
async function sendSmsViaEmail(phoneSmsEmail, message) {
  if (!phoneSmsEmail || !message) return;
  const nodemailer = require('nodemailer');
  const host = process.env.MAIL_HOST;
  const port = parseInt(process.env.MAIL_PORT || '587', 10);
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASS;
  if (!host || !user || !pass) return;
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  if (!transport) return;
  const from = process.env.MAIL_FROM || process.env.MAIL_USER || 'noreply@cryptosignals.local';
  try {
    await transport.sendMail({
      from,
      to: phoneSmsEmail,
      subject: 'AlphaConfluence',
      text: message.slice(0, 160)
    });
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[Notifications] SMS email failed:', e.message);
    }
  }
}

/**
 * Send trade/action notification to user (push + optional SMS)
 * Respects user settings: notifyTradeOpen, notifyTradeClose, notifyActionBadges
 */
async function notifyUser(userId, type, title, body, userSettings = null) {
  const user = userSettings || (await User.findById(userId).select('settings pushSubscriptions phoneSmsEmail').lean());
  if (!user) return;

  const s = user.settings || {};
  const wantPush = user.pushSubscriptions?.length > 0;
  const wantSms = !!user.phoneSmsEmail;

  if (!wantPush && !wantSms) return;

  const checkNotify = () => {
    if (type === 'trade_open') return s.notifyTradeOpen !== false;
    if (type === 'trade_close') return s.notifyTradeClose !== false;
    if (type === 'action_badge') return s.notifyActionBadges === true;
    return true;
  };
  if (!checkNotify()) return;

  if (wantPush) {
    await sendPushNotification(userId, title, { body, tag: type, url: '/trades' });
  }
  if (wantSms) {
    await sendSmsViaEmail(user.phoneSmsEmail, `${title}${body ? ': ' + body.slice(0, 80) : ''}`);
  }
}

module.exports = {
  sendPushNotification,
  sendSmsViaEmail,
  notifyUser,
  ensureVapid
};
