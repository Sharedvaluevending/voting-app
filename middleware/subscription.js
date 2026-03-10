const User = require('../models/User');

function hasTier(user, allowedTiers) {
  const tier = String(user?.subscriptionTier || 'free');
  return allowedTiers.includes(tier);
}

function getMonthlyLimits(user) {
  const tier = String(user?.subscriptionTier || 'free');
  if (tier === 'elite' || tier === 'partner') {
    return { copilot: 500, llm: 500, voice: 60 };
  }
  if (tier === 'pro' || tier === 'trial') {
    return { copilot: 100, llm: 100, voice: 0 };
  }
  return { copilot: 25, llm: 25, voice: 0 };
}

function getNextMonthlyResetDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
}

function buildLimitPayload(kind, used, monthlyLimit, packRemaining) {
  return {
    error: `${kind}_limit_reached`,
    used,
    monthlyLimit,
    packRemaining,
    resetAt: getNextMonthlyResetDate().toISOString(),
    upgradeUrl: '/pricing',
    packOptions: [50, 200, 500]
  };
}

function requirePro(req, res, next) {
  if (!hasTier(req.subscriptionUser, ['pro', 'elite', 'partner', 'trial'])) {
    return res.status(403).json({
      error: 'Pro subscription required',
      upgradeUrl: '/pricing'
    });
  }
  return next();
}

function requireElite(req, res, next) {
  if (!hasTier(req.subscriptionUser, ['elite', 'partner'])) {
    return res.status(403).json({
      error: 'Elite subscription required',
      upgradeUrl: '/pricing'
    });
  }
  return next();
}

function requireTrench(req, res, next) {
  const user = req.subscriptionUser || req.user;
  if (!user) {
    return res.status(401).json({ error: 'Login required' });
  }
  if (hasTier(user, ['elite', 'partner'])) return next();
  if (user.trenchWarfareEnabled) return next();
  return res.status(403).json({
    error: 'trench_locked',
    upgradeUrl: '/trench-upgrade'
  });
}

async function checkCopilotLimit(req, res, next) {
  try {
    const user = req.subscriptionUser;
    if (!user) {
      return res.status(401).json({ error: 'Login required' });
    }
    const monthly = getMonthlyLimits(user).copilot;
    const used = user.copilotQuestionsUsed || 0;
    const pack = user.copilotPackQuestions || 0;
    if (used >= monthly && pack <= 0) {
      return res.status(403).json({
        ...buildLimitPayload('copilot', used, monthly, pack),
        errorMessage: `You've used all ${monthly} copilot questions this month`
      });
    }
    const update = (used < monthly)
      ? { $inc: { copilotQuestionsUsed: 1 } }
      : { $set: { copilotPackQuestions: Math.max(0, pack - 1) } };
    await User.updateOne({ _id: user._id }, update);
    if (used < monthly) user.copilotQuestionsUsed = used + 1;
    else user.copilotPackQuestions = Math.max(0, pack - 1);
    return next();
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Copilot limit check failed' });
  }
}

async function checkLLMLimit(req, res, next) {
  try {
    const user = req.subscriptionUser;
    if (!user) {
      return res.status(401).json({ error: 'Login required' });
    }
    const monthly = getMonthlyLimits(user).llm;
    const used = user.llmMessagesUsed || 0;
    const pack = user.llmPackMessages || 0;
    if (used >= monthly && pack <= 0) {
      return res.status(403).json({
        ...buildLimitPayload('llm', used, monthly, pack),
        errorMessage: `You've used all ${monthly} LLM messages this month`
      });
    }
    const update = (used < monthly)
      ? { $inc: { llmMessagesUsed: 1 } }
      : { $set: { llmPackMessages: Math.max(0, pack - 1) } };
    await User.updateOne({ _id: user._id }, update);
    if (used < monthly) user.llmMessagesUsed = used + 1;
    else user.llmPackMessages = Math.max(0, pack - 1);
    return next();
  } catch (err) {
    return res.status(500).json({ error: err.message || 'LLM limit check failed' });
  }
}

async function checkVoiceLimit(req, res, next) {
  try {
    const user = req.subscriptionUser;
    if (!user) {
      return res.status(401).json({ error: 'Login required' });
    }
    const monthly = getMonthlyLimits(user).voice;
    const used = user.voiceMinutesUsed || 0;
    const pack = user.voicePackMinutes || 0;
    const total = monthly + pack;
    if (total <= 0) {
      return res.status(403).json({
        error: 'voice_locked',
        upgradeUrl: '/pricing'
      });
    }
    if (used >= total) {
      return res.status(403).json({
        error: 'voice_limit_reached',
        used,
        monthlyLimit: monthly,
        packRemaining: Math.max(0, total - used),
        resetAt: getNextMonthlyResetDate().toISOString(),
        upgradeUrl: '/pricing'
      });
    }
    return next();
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Voice limit check failed' });
  }
}

module.exports = {
  requirePro,
  requireElite,
  requireTrench,
  checkCopilotLimit,
  checkLLMLimit,
  checkVoiceLimit,
  getMonthlyLimits
};
