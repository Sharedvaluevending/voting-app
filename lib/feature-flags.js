/**
 * Feature flags — tools-posthog skill inspired.
 * Wired to PostHog when POSTHOG_KEY env is set; otherwise uses env-based overrides.
 * @example
 *   const isEnabled = require('./lib/feature-flags').isEnabled('featureThemeDetector');
 */
const POSTHOG_KEY = process.env.POSTHOG_KEY || process.env.NEXT_PUBLIC_POSTHOG_KEY;

function isEnabled(flagName) {
  const envKey = `FLAG_${flagName.toUpperCase().replace(/-/g, '_')}`;
  const envVal = process.env[envKey];
  if (envVal !== undefined) return envVal === '1' || envVal === 'true';
  // Default: no PostHog, no env override — caller uses app defaults
  return null;
}

module.exports = { isEnabled, POSTHOG_KEY };
