require('dotenv').config();
const Stripe = require('stripe');

async function upsertPlan(stripe, cfg) {
  const products = await stripe.products.list({ active: true, limit: 100 });
  let product = products.data.find((p) => p.name === cfg.name);
  if (!product) {
    product = await stripe.products.create({
      name: cfg.name,
      description: cfg.description,
      metadata: { app: 'alphaconfluence', tier: cfg.tier }
    });
  }

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find((p) => p.unit_amount === cfg.amount && p.recurring?.interval === 'month');
  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: cfg.amount,
      currency: 'usd',
      recurring: { interval: 'month' },
      nickname: `${cfg.name} Monthly`
    });
  }
  return { product, price };
}

async function upsertOneTimePack(stripe, cfg) {
  const products = await stripe.products.list({ active: true, limit: 100 });
  let product = products.data.find((p) => p.name === cfg.name);
  if (!product) {
    product = await stripe.products.create({
      name: cfg.name,
      description: cfg.description,
      metadata: { app: 'alphaconfluence', kind: 'pack', packType: cfg.packType, packAmount: String(cfg.amountLabel) }
    });
  }

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  let price = prices.data.find((p) => p.unit_amount === cfg.amount && !p.recurring);
  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: cfg.amount,
      currency: 'usd',
      nickname: `${cfg.name} One-time`
    });
  }
  return { product, price };
}

async function main() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is missing in .env');
  }
  if (!process.env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    throw new Error('Use a Stripe test key (sk_test_) for sandbox setup');
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-01-28.clover' });
  const plans = [
    { tier: 'pro', name: 'AlphaConfluence Pro', description: 'Pro monthly plan', amount: 4900 },
    { tier: 'elite', name: 'AlphaConfluence Elite', description: 'Elite monthly plan', amount: 9900 },
    { tier: 'trench', name: 'Trench Warfare Add-on', description: 'Trench Warfare add-on for Pro users', amount: 500 }
  ];
  const packs = [
    { env: 'STRIPE_PACK_COPILOT_50_PRICE_ID', name: 'Copilot Pack 50', description: '50 copilot questions', amount: 299, packType: 'copilot', amountLabel: 50 },
    { env: 'STRIPE_PACK_COPILOT_200_PRICE_ID', name: 'Copilot Pack 200', description: '200 copilot questions', amount: 799, packType: 'copilot', amountLabel: 200 },
    { env: 'STRIPE_PACK_COPILOT_500_PRICE_ID', name: 'Copilot Pack 500', description: '500 copilot questions', amount: 1499, packType: 'copilot', amountLabel: 500 },
    { env: 'STRIPE_PACK_LLM_50_PRICE_ID', name: 'LLM Pack 50', description: '50 LLM messages', amount: 299, packType: 'llm', amountLabel: 50 },
    { env: 'STRIPE_PACK_LLM_200_PRICE_ID', name: 'LLM Pack 200', description: '200 LLM messages', amount: 799, packType: 'llm', amountLabel: 200 },
    { env: 'STRIPE_PACK_LLM_500_PRICE_ID', name: 'LLM Pack 500', description: '500 LLM messages', amount: 1499, packType: 'llm', amountLabel: 500 },
    { env: 'STRIPE_PACK_VOICE_30_PRICE_ID', name: 'Voice Pack 30', description: '30 voice minutes', amount: 299, packType: 'voice', amountLabel: 30 },
    { env: 'STRIPE_PACK_VOICE_120_PRICE_ID', name: 'Voice Pack 120', description: '120 voice minutes', amount: 799, packType: 'voice', amountLabel: 120 },
    { env: 'STRIPE_PACK_VOICE_300_PRICE_ID', name: 'Voice Pack 300', description: '300 voice minutes', amount: 1499, packType: 'voice', amountLabel: 300 }
  ];

  const out = {};
  for (const p of plans) {
    out[p.tier] = await upsertPlan(stripe, p);
  }
  for (const p of packs) {
    out[p.env] = await upsertOneTimePack(stripe, p);
  }

  console.log('Stripe sandbox setup complete:');
  console.log('STRIPE_PRO_PRICE_ID=' + out.pro.price.id);
  console.log('STRIPE_ELITE_PRICE_ID=' + out.elite.price.id);
  console.log('STRIPE_TRENCH_PRICE_ID=' + out.trench.price.id);
  for (const p of packs) {
    console.log(p.env + '=' + out[p.env].price.id);
  }
}

main().catch((err) => {
  console.error('[setup-stripe-products] failed:', err.message);
  process.exit(1);
});
