const jwt = require('jsonwebtoken');
require('dotenv').config();

const secret = String(process.env.JWT_SECRET || process.env.SESSION_SECRET || '').trim();
if (!secret) {
  console.error('JWT_SECRET (or SESSION_SECRET) must be set to generate a test token.');
  process.exit(1);
}

const userId = String(process.env.TEST_USER_ID || 'stress-test-user');
const email = String(process.env.TEST_USER_EMAIL || 'stress@test.local');
const expiresIn = String(process.env.TEST_JWT_EXPIRES || '2h');

const token = jwt.sign(
  { userId, email, role: 'pro' },
  secret,
  { expiresIn }
);

console.log(token);
