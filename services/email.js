// services/email.js - Password reset emails via nodemailer
const nodemailer = require('nodemailer');

function getTransporter() {
  const host = process.env.MAIL_HOST;
  const port = parseInt(process.env.MAIL_PORT || '587', 10);
  const user = process.env.MAIL_USER;
  const pass = process.env.MAIL_PASS;
  if (host && user && pass) {
    return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  }
  return null;
}

async function sendPasswordResetEmail(email, resetUrl) {
  const transporter = getTransporter();
  const from = process.env.MAIL_FROM || process.env.MAIL_USER || 'noreply@cryptosignals.local';
  const subject = 'Reset your AlphaConfluence password';
  const html = `
    <p>You requested a password reset. Click the link below to set a new password:</p>
    <p><a href="${resetUrl}" style="color:#3b82f6;">${resetUrl}</a></p>
    <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
  `;
  if (transporter) {
    await transporter.sendMail({ from, to: email, subject, html });
    return true;
  }
  if (process.env.NODE_ENV !== 'production') {
    console.log('[Email] No SMTP configured. Reset link (dev):', resetUrl);
  }
  return false;
}

async function sendLifecycleEmail(email, subject, message) {
  const transporter = getTransporter();
  const from = process.env.MAIL_FROM || process.env.MAIL_USER || 'noreply@cryptosignals.local';
  const html = `
    <p>${message}</p>
    <p>Manage billing: <a href="${process.env.BASE_URL || 'https://alphaconfluence.com'}/pricing">${process.env.BASE_URL || 'https://alphaconfluence.com'}/pricing</a></p>
  `;
  if (transporter) {
    await transporter.sendMail({ from, to: email, subject, html });
    return true;
  }
  if (process.env.NODE_ENV !== 'production') {
    console.log('[Email] Lifecycle email (dev):', { email, subject, message });
  }
  return false;
}

module.exports = { sendPasswordResetEmail, sendLifecycleEmail };
