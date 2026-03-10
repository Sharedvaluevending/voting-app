const {
  requireTrench,
  checkCopilotLimit,
  checkLLMLimit,
  getMonthlyLimits
} = require('../../middleware/subscription');

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.payload = obj;
      return this;
    }
  };
}

describe('subscription monetization middleware', () => {
  test('requireTrench allows elite, partner, or trench add-on', () => {
    const res = makeRes();
    let called = 0;
    requireTrench({ subscriptionUser: { subscriptionTier: 'elite' } }, res, () => { called += 1; });
    requireTrench({ subscriptionUser: { subscriptionTier: 'partner' } }, res, () => { called += 1; });
    requireTrench({ subscriptionUser: { subscriptionTier: 'pro', trenchWarfareEnabled: true } }, res, () => { called += 1; });
    expect(called).toBe(3);
  });

  test('requireTrench blocks locked users with trench_locked', () => {
    const res = makeRes();
    let called = 0;
    requireTrench({ subscriptionUser: { subscriptionTier: 'pro', trenchWarfareEnabled: false } }, res, () => { called += 1; });
    expect(called).toBe(0);
    expect(res.statusCode).toBe(403);
    expect(res.payload.error).toBe('trench_locked');
  });

  test('checkCopilotLimit uses monthly first then pack credits', async () => {
    const user = {
      subscriptionTier: 'pro',
      copilotQuestionsUsed: 100,
      copilotPackQuestions: 2,
      save: jest.fn().mockResolvedValue(true)
    };
    const req = { subscriptionUser: user };
    const res = makeRes();
    let called = 0;
    await checkCopilotLimit(req, res, () => { called += 1; });
    expect(called).toBe(1);
    expect(user.copilotQuestionsUsed).toBe(100);
    expect(user.copilotPackQuestions).toBe(1);
  });

  test('checkLLMLimit returns llm_limit_reached when exhausted', async () => {
    const user = {
      subscriptionTier: 'free',
      llmMessagesUsed: 25,
      llmPackMessages: 0,
      save: jest.fn().mockResolvedValue(true)
    };
    const req = { subscriptionUser: user };
    const res = makeRes();
    await checkLLMLimit(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.payload.error).toBe('llm_limit_reached');
  });

  test('getMonthlyLimits maps tiers correctly', () => {
    expect(getMonthlyLimits({ subscriptionTier: 'free' })).toEqual({ copilot: 25, llm: 25, voice: 0 });
    expect(getMonthlyLimits({ subscriptionTier: 'pro' })).toEqual({ copilot: 100, llm: 100, voice: 0 });
    expect(getMonthlyLimits({ subscriptionTier: 'elite' })).toEqual({ copilot: 500, llm: 500, voice: 60 });
  });
});
