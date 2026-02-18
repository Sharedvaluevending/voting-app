/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/unit/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/tests/backtest/'],
  collectCoverageFrom: [
    'services/**/*.js',
    '!services/backtest/**',
  ],
  coverageDirectory: 'coverage',
  verbose: true,
};
