const Stripe = require('stripe');
const User = require('../models/User');
const Referral = require('../models/Referral');
const CommissionTransaction = require('../models/CommissionTransaction');
const Pack = require('../models/Pack');
const { addDiscordRole, removeDiscordRole } = require('./discord-roles');
const { sendLifecycleEmail } = require('./email');

function getStripeClient() {
  const apiKey = process.env.STRIPE_SECRET_KEY || '';
  if (!apiKey) return null;
  return new Stripe(apiKey, { apiVersion: '2026-01-28.clover' });
}

function getPriceConfig() {
  return {
    pro: process.env.STRIPE_PRO_PRICE_ID || '',
    elite: process.env.STRIPE_ELITE_PRICE_ID || '',
    trench: process.env.STRIPE_TRENCH_PRICE_ID || '',
    packs: {
      copilot: {
        50: process.env.STRIPE_PACK_COPILOT_50_PRICE_ID || '',
        200: process.env.STRIPE_PACK_COPILOT_200_PRICE_ID || '',
        500: process.env.STRIPE_PACK_COPILOT_500_PRICE_ID || ''
      },
      llm: {
        50: process.env.STRIPE_PACK_LLM_50_PRICE_ID || '',
        200: process.env.STRIPE_PACK_LLM_200_PRICE_ID || '',
        500: process.env.STRIPE_PACK_LLM_500_PRICE_ID || ''
      },
      voice: {
        30: process.env.STRIPE_PACK_VOICE_30_PRICE_ID || '',
        120: process.env.STRIPE_PACK_VOICE_120_PRICE_ID || '',
        300: process.env.STRIPE_PACK_VOICE_300_PRICE_ID || ''
      }
    }
  };
}

function resolveTierFromPriceId(priceId) {
  const cfg = getPriceConfig();
  if (priceId && cfg.elite && priceId === cfg.elite) return 'elite';
  if (priceId && cfg.pro && priceId === cfg.pro) return 'pro';
  return 'free';
}

function isTrenchAddonSubscription(subscription) {
  const cfg = getPriceConfig();
  const subPriceId = subscription?.items?.data?.[0]?.price?.id || '';
  const feature = String(subscription?.metadata?.feature || '').toLowerCase();
  return (cfg.trench && subPriceId === cfg.trench) || feature === 'trench_addon';
}

function resolvePackFromMetadata(metadata) {
  const packType = String(metadata?.packType || '').toLowerCase();
  const amountRaw = Number(metadata?.packAmount || 0);
  const packAmount = Number.isFinite(amountRaw) ? amountRaw : 0;
  if (!['copilot', 'llm', 'voice'].includes(packType)) return null;
  if (packAmount <= 0) return null;
  if (packType === 'voice') {
    return { packType, questionsAdded: 0, minutesAdded: packAmount };
  }
  return { packType, questionsAdded: packAmount, minutesAdded: 0 };
}

async function applyPackToUser(userId, paymentId, metadata) {
  const pack = resolvePackFromMetadata(metadata);
  if (!pack) return false;
  const existing = await Pack.findOne({ stripePaymentId: String(paymentId || '') }).lean();
  if (existing) return false;

  const user = await User.findById(userId);
  if (!user) return false;

  if (pack.packType === 'copilot') {
    user.copilotPackQuestions = (user.copilotPackQuestions || 0) + pack.questionsAdded;
  } else if (pack.packType === 'llm') {
    user.llmPackMessages = (user.llmPackMessages || 0) + pack.questionsAdded;
  } else if (pack.packType === 'voice') {
    user.voicePackMinutes = (user.voicePackMinutes || 0) + pack.minutesAdded;
  }
  await user.save();

  await Pack.create({
    userId: user._id,
    packType: pack.packType,
    questionsAdded: pack.questionsAdded,
    minutesAdded: pack.minutesAdded,
    stripePaymentId: String(paymentId || '')
  });
  const amt = pack.packType === 'voice' ? `${pack.minutesAdded} voice minutes` : `${pack.questionsAdded} questions`;
  await sendLifecycleEmail(user.email, 'Pack activated', `Pack activated! ${amt} added.`);
  return true;
}

async function syncDiscordRole(userId, tier) {
  const user = await User.findById(userId);
  if (!user?.discordId) return;
  await removeDiscordRole(user.discordId, 'Pro');
  await removeDiscordRole(user.discordId, 'Elite');
  await removeDiscordRole(user.discordId, 'Trial');

  if (tier === 'trial') await addDiscordRole(user.discordId, 'Trial');
  if (tier === 'pro') await addDiscordRole(user.discordId, 'Pro');
  if (tier === 'elite') await addDiscordRole(user.discordId, 'Elite');
  if (tier === 'partner') await addDiscordRole(user.discordId, 'Elite');
}

async function applyCommissionFromInvoice(invoice, user) {
  const code = String(user?.referredBy || '').trim().toUpperCase();
  if (!code) return;
  const partner = await Referral.findOne({ referralCode: code, status: 'active' });
  if (!partner) return;

  const paid = Number(invoice.amount_paid || 0);
  if (!Number.isFinite(paid) || paid <= 0) return;

  const commissionRate = Number(partner.commissionRate || 10);
  const commissionCents = Math.round((paid * commissionRate) / 100);
  partner.pendingEarnings = (partner.pendingEarnings || 0) + (commissionCents / 100);
  partner.totalEarnings = partner.totalEarnings || 0;
  await partner.save();

  await CommissionTransaction.create({
    referralCode: code,
    partnerId: partner._id,
    userId: user._id,
    stripeInvoiceId: String(invoice.id || ''),
    stripeSubscriptionId: String(invoice.subscription || ''),
    amountPaidCents: paid,
    commissionRate,
    commissionAmountCents: commissionCents,
    currency: String(invoice.currency || 'usd')
  });
}

async function handleStripeEvent(event) {
  switch (event.type) {
    case 'customer.subscription.created': {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;
      if (!userId) break;
      const user = await User.findById(userId);
      if (!user) break;

      if (isTrenchAddonSubscription(subscription)) {
        user.trenchWarfareEnabled = true;
        user.trenchWarfareSubscriptionId = String(subscription.id || user.trenchWarfareSubscriptionId || '');
        await user.save();
        break;
      }

      const priceId = subscription.items?.data?.[0]?.price?.id || '';
      const inTrial = subscription.status === 'trialing';
      const tier = inTrial ? 'trial' : resolveTierFromPriceId(priceId);
      user.subscriptionTier = tier;
      user.stripeCustomerId = String(subscription.customer || user.stripeCustomerId || '');
      user.stripeSubscriptionId = String(subscription.id || user.stripeSubscriptionId || '');
      user.trialEndsAt = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;
      user.subscriptionEndsAt = subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null;
      await user.save();
      await syncDiscordRole(user._id, tier);
      await sendLifecycleEmail(user.email, 'Welcome to AlphaConfluence Pro trial', 'Your subscription is now active.');
      break;
    }
    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      const userId = subscription.metadata?.userId;
      let user = null;
      if (userId) user = await User.findById(userId);
      if (!user && subscription.customer) {
        user = await User.findOne({ stripeCustomerId: String(subscription.customer) });
      }
      if (!user) break;

      if (isTrenchAddonSubscription(subscription)) {
        user.trenchWarfareEnabled = subscription.status !== 'canceled' && subscription.status !== 'unpaid';
        user.trenchWarfareSubscriptionId = user.trenchWarfareEnabled
          ? String(subscription.id || user.trenchWarfareSubscriptionId || '')
          : '';
        await user.save();
        break;
      }

      const priceId = subscription.items?.data?.[0]?.price?.id || '';
      const inTrial = subscription.status === 'trialing';
      const tier = user.isPartner ? 'partner' : (inTrial ? 'trial' : resolveTierFromPriceId(priceId));
      user.subscriptionTier = tier;
      user.stripeCustomerId = String(subscription.customer || user.stripeCustomerId || '');
      user.stripeSubscriptionId = String(subscription.id || user.stripeSubscriptionId || '');
      user.trialEndsAt = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;
      user.subscriptionEndsAt = subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null;
      await user.save();
      await syncDiscordRole(user._id, tier);
      break;
    }
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      let user = null;
      if (subscription.metadata?.userId) user = await User.findById(subscription.metadata.userId);
      if (!user && subscription.customer) user = await User.findOne({ stripeCustomerId: String(subscription.customer) });
      if (!user) break;

      if (isTrenchAddonSubscription(subscription)) {
        user.trenchWarfareEnabled = false;
        user.trenchWarfareSubscriptionId = '';
        await user.save();
        await sendLifecycleEmail(user.email, 'Trench Warfare deactivated', 'Trench Warfare deactivated. Reactivate anytime.');
        break;
      }

      user.subscriptionTier = 'free';
      user.trialEndsAt = null;
      user.subscriptionEndsAt = null;
      user.stripeSubscriptionId = '';
      await user.save();
      await syncDiscordRole(user._id, 'free');
      await sendLifecycleEmail(user.email, 'Subscription cancelled', 'Your account has been moved to the free tier.');
      break;
    }
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      const customerId = String(invoice.customer || '');
      const user = await User.findOne({ stripeCustomerId: customerId });
      if (!user) break;
      if (user.subscriptionTier === 'trial') {
        user.subscriptionTier = resolveTierFromPriceId(invoice.lines?.data?.[0]?.price?.id || '');
      }
      user.subscriptionEndsAt = invoice.lines?.data?.[0]?.period?.end
        ? new Date(invoice.lines.data[0].period.end * 1000)
        : user.subscriptionEndsAt;
      await user.save();
      await applyCommissionFromInvoice(invoice, user);
      break;
    }
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object;
      const userId = paymentIntent?.metadata?.userId;
      if (!userId) break;
      await applyPackToUser(userId, paymentIntent.id, paymentIntent.metadata || {});
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const customerId = String(invoice.customer || '');
      const user = await User.findOne({ stripeCustomerId: customerId });
      if (!user) break;
      const graceMs = 3 * 24 * 60 * 60 * 1000;
      user.subscriptionEndsAt = new Date(Date.now() + graceMs);
      await user.save();
      await sendLifecycleEmail(user.email, 'Payment failed', 'Please update your payment method to keep access.');
      break;
    }
    case 'customer.subscription.trial_will_end': {
      const subscription = event.data.object;
      let user = null;
      if (subscription.metadata?.userId) user = await User.findById(subscription.metadata.userId);
      if (!user && subscription.customer) user = await User.findOne({ stripeCustomerId: String(subscription.customer) });
      if (!user) break;
      await sendLifecycleEmail(user.email, 'Trial ending soon', 'Your trial ends in 3 days. Add payment details to keep access.');
      break;
    }
    default:
      break;
  }
}

module.exports = {
  getStripeClient,
  getPriceConfig,
  resolveTierFromPriceId,
  handleStripeEvent,
  syncDiscordRole
};
