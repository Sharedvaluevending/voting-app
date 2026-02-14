#!/usr/bin/env node
// Generate VAPID keys for push notifications. Add to .env:
// VAPID_PUBLIC_KEY=...
// VAPID_PRIVATE_KEY=...
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('Add these to your .env or environment:');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
