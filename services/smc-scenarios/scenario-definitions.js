// services/smc-scenarios/scenario-definitions.js
// ====================================================
// SMC TRADE SCENARIO DEFINITIONS
// All setups with phases and short versions for quick filtering
// ====================================================

const TRADE_SCENARIOS = {
  // === FVG + LIQUIDITY (Full) ===
  fvg_liquidity_long: {
    id: 'fvg_liquidity_long',
    name: 'FVG + Liquidity Long',
    description: 'Liquidity below, structure shift, POI in discount, sell-side draw, price taps zone, entry, target at buy-side liquidity.',
    direction: 'LONG',
    category: 'fvg_liquidity',
    phases: [
      { id: 'liquidity_below', name: 'Sell-side liquidity pool identified below (stops below lows)', check: 'liquidityClusterBelow' },
      { id: 'structure_shift', name: 'Structure shift (BOS/CHoCH bullish)', check: 'structureShiftBull' },
      { id: 'poi', name: 'POI (OB or FVG) in discount zone', check: 'poiInDiscount' },
      { id: 'sell_side_draw', name: 'Sell-side draw (liquidity sweep below)', check: 'liquiditySweepBelow' },
      { id: 'price_taps_zone', name: 'Price taps the zone', check: 'priceAtPOI' },
      { id: 'entry_taken', name: 'Entry taken (confirmation candle)', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at buy-side liquidity above', check: 'targetAtLiquidityAbove' }
    ],
    shortVersion: ['poi', 'sell_side_draw', 'price_taps_zone', 'entry_taken']
  },

  fvg_liquidity_short: {
    id: 'fvg_liquidity_short',
    name: 'FVG + Liquidity Short',
    description: 'Liquidity above, structure shift, POI in premium, buy-side draw, price taps zone, entry, target at sell-side liquidity.',
    direction: 'SHORT',
    category: 'fvg_liquidity',
    phases: [
      { id: 'liquidity_above', name: 'Sell-side liquidity identified above', check: 'liquidityClusterAbove' },
      { id: 'structure_shift', name: 'Structure shift (BOS/CHoCH bearish)', check: 'structureShiftBear' },
      { id: 'poi', name: 'POI (OB or FVG) in premium zone', check: 'poiInPremium' },
      { id: 'buy_side_draw', name: 'Buy-side draw (liquidity sweep above)', check: 'liquiditySweepAbove' },
      { id: 'price_taps_zone', name: 'Price taps the zone', check: 'priceAtPOI' },
      { id: 'entry_taken', name: 'Entry taken', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at sell-side liquidity below', check: 'targetAtLiquidityBelow' }
    ],
    shortVersion: ['poi', 'buy_side_draw', 'price_taps_zone', 'entry_taken']
  },

  // === ACCUMULATION ===
  accumulation_long: {
    id: 'accumulation_long',
    name: 'Accumulation Long',
    description: 'Range identified, manipulation sweep below, inverse FVG forms, entry on retest.',
    direction: 'LONG',
    category: 'accumulation',
    phases: [
      { id: 'identified', name: 'Accumulation identified (range, low vol)', check: 'accumulationIdentified' },
      { id: 'manipulation', name: 'Manipulation (sweep below range)', check: 'manipulationSweep' },
      { id: 'inverse_fvg', name: 'Inverse FVG / value gap forms', check: 'inverseFVGAfterSweep' },
      { id: 'entry', name: 'Entry on retest of FVG', check: 'entryAtFVG' },
      { id: 'target', name: 'Target at liquidity above', check: 'targetAtLiquidityAbove' }
    ],
    shortVersion: ['manipulation', 'inverse_fvg', 'entry']
  },

  // === DISTRIBUTION ===
  distribution_short: {
    id: 'distribution_short',
    name: 'Distribution Short',
    description: 'Range identified, manipulation sweep above, bearish FVG forms, entry on retest.',
    direction: 'SHORT',
    category: 'distribution',
    phases: [
      { id: 'identified', name: 'Distribution identified (range, low vol)', check: 'distributionIdentified' },
      { id: 'manipulation', name: 'Manipulation (sweep above range)', check: 'manipulationSweepUp' },
      { id: 'inverse_fvg', name: 'Bearish FVG / value gap forms', check: 'bearishFVGAfterSweep' },
      { id: 'entry', name: 'Entry on retest of FVG', check: 'entryAtBearFVG' },
      { id: 'target', name: 'Target at liquidity below', check: 'targetAtLiquidityBelow' }
    ],
    shortVersion: ['manipulation', 'inverse_fvg', 'entry']
  },

  // === FVG GAP (simplified) ===
  fvg_gap_long: {
    id: 'fvg_gap_long',
    name: 'FVG Gap Long',
    description: 'Bullish FVG in discount zone, price taps zone, entry confirmation.',
    direction: 'LONG',
    category: 'fvg',
    phases: [
      { id: 'fvg_bull', name: 'Bullish FVG present', check: 'fvgBullPresent' },
      { id: 'in_discount', name: 'FVG in discount zone', check: 'fvgInDiscount' },
      { id: 'price_taps', name: 'Price taps FVG zone', check: 'priceAtBullFVG' },
      { id: 'entry', name: 'Entry confirmation', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at resistance or liquidity', check: 'targetAtLiquidityAbove' }
    ],
    shortVersion: ['fvg_bull', 'price_taps', 'entry']
  },

  fvg_gap_short: {
    id: 'fvg_gap_short',
    name: 'FVG Gap Short',
    description: 'Bearish FVG in premium zone, price taps zone, entry confirmation.',
    direction: 'SHORT',
    category: 'fvg',
    phases: [
      { id: 'fvg_bear', name: 'Bearish FVG present', check: 'fvgBearPresent' },
      { id: 'in_premium', name: 'FVG in premium zone', check: 'fvgInPremium' },
      { id: 'price_taps', name: 'Price taps FVG zone', check: 'priceAtBearFVG' },
      { id: 'entry', name: 'Entry confirmation', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at support or liquidity', check: 'targetAtLiquidityBelow' }
    ],
    shortVersion: ['fvg_bear', 'price_taps', 'entry']
  },

  // === ORDER BLOCK ===
  order_block_long: {
    id: 'order_block_long',
    name: 'Order Block Long',
    description: 'Bullish OB at support, structure bullish, price taps OB, entry.',
    direction: 'LONG',
    category: 'order_block',
    phases: [
      { id: 'ob_bull', name: 'Bullish order block present', check: 'obBullPresent' },
      { id: 'structure', name: 'Structure bullish or break up', check: 'structureShiftBull' },
      { id: 'price_taps', name: 'Price taps OB zone', check: 'priceAtBullOB' },
      { id: 'entry', name: 'Entry confirmation', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at resistance', check: 'targetAtLiquidityAbove' }
    ],
    shortVersion: ['ob_bull', 'price_taps', 'entry']
  },

  order_block_short: {
    id: 'order_block_short',
    name: 'Order Block Short',
    description: 'Bearish OB at resistance, structure bearish, price taps OB, entry.',
    direction: 'SHORT',
    category: 'order_block',
    phases: [
      { id: 'ob_bear', name: 'Bearish order block present', check: 'obBearPresent' },
      { id: 'structure', name: 'Structure bearish or break down', check: 'structureShiftBear' },
      { id: 'price_taps', name: 'Price taps OB zone', check: 'priceAtBearOB' },
      { id: 'entry', name: 'Entry confirmation', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at support', check: 'targetAtLiquidityBelow' }
    ],
    shortVersion: ['ob_bear', 'price_taps', 'entry']
  },

  // === LIQUIDITY SWEEP ===
  liquidity_sweep_long: {
    id: 'liquidity_sweep_long',
    name: 'Liquidity Sweep Long',
    description: 'Price sweeps liquidity below, reverses, entry on reversal.',
    direction: 'LONG',
    category: 'liquidity_sweep',
    phases: [
      { id: 'liq_below', name: 'Liquidity cluster below', check: 'liquidityClusterBelow' },
      { id: 'sweep', name: 'Price sweeps below then reverses', check: 'liquiditySweepBelow' },
      { id: 'reversal', name: 'Reversal candle (bullish)', check: 'reversalCandleBull' },
      { id: 'entry', name: 'Entry on confirmation', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at liquidity above', check: 'targetAtLiquidityAbove' }
    ],
    shortVersion: ['sweep', 'reversal', 'entry']
  },

  liquidity_sweep_short: {
    id: 'liquidity_sweep_short',
    name: 'Liquidity Sweep Short',
    description: 'Price sweeps liquidity above, reverses, entry on reversal.',
    direction: 'SHORT',
    category: 'liquidity_sweep',
    phases: [
      { id: 'liq_above', name: 'Liquidity cluster above', check: 'liquidityClusterAbove' },
      { id: 'sweep', name: 'Price sweeps above then reverses', check: 'liquiditySweepAbove' },
      { id: 'reversal', name: 'Reversal candle (bearish)', check: 'reversalCandleBear' },
      { id: 'entry', name: 'Entry on confirmation', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at liquidity below', check: 'targetAtLiquidityBelow' }
    ],
    shortVersion: ['sweep', 'reversal', 'entry']
  },

  // === INDUCEMENT (trap) ===
  inducement_short: {
    id: 'inducement_short',
    name: 'Inducement Short',
    description: 'Liquidity above, price sweeps above (trap longs), reverses down for short.',
    direction: 'SHORT',
    category: 'inducement',
    phases: [
      { id: 'liq_above', name: 'Liquidity cluster above', check: 'liquidityClusterAbove' },
      { id: 'sweep_up', name: 'Price sweeps above (trap)', check: 'liquiditySweepAbove' },
      { id: 'reversal', name: 'Bearish reversal', check: 'reversalCandleBear' },
      { id: 'entry', name: 'Entry on confirmation', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at liquidity below', check: 'targetAtLiquidityBelow' }
    ],
    shortVersion: ['sweep_up', 'reversal', 'entry']
  },

  inducement_long: {
    id: 'inducement_long',
    name: 'Inducement Long',
    description: 'Liquidity below, price sweeps below (trap shorts), reverses up for long.',
    direction: 'LONG',
    category: 'inducement',
    phases: [
      { id: 'liq_below', name: 'Liquidity cluster below', check: 'liquidityClusterBelow' },
      { id: 'sweep_down', name: 'Price sweeps below (trap)', check: 'liquiditySweepBelow' },
      { id: 'reversal', name: 'Bullish reversal', check: 'reversalCandleBull' },
      { id: 'entry', name: 'Entry on confirmation', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at liquidity above', check: 'targetAtLiquidityAbove' }
    ],
    shortVersion: ['sweep_down', 'reversal', 'entry']
  },

  // === FVG + OB STACK ===
  fvg_ob_stack_long: {
    id: 'fvg_ob_stack_long',
    name: 'FVG + OB Stack Long',
    description: 'FVG and OB overlap in discount zone, high confluence long.',
    direction: 'LONG',
    category: 'confluence',
    phases: [
      { id: 'fvg_bull', name: 'Bullish FVG present', check: 'fvgBullPresent' },
      { id: 'ob_bull', name: 'Bullish OB present', check: 'obBullPresent' },
      { id: 'stack', name: 'FVG and OB overlap in zone', check: 'fvgObStackBull' },
      { id: 'price_taps', name: 'Price taps stacked zone', check: 'priceAtPOI' },
      { id: 'entry', name: 'Entry confirmation', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at liquidity', check: 'targetAtLiquidityAbove' }
    ],
    shortVersion: ['stack', 'price_taps', 'entry']
  },

  fvg_ob_stack_short: {
    id: 'fvg_ob_stack_short',
    name: 'FVG + OB Stack Short',
    description: 'FVG and OB overlap in premium zone, high confluence short.',
    direction: 'SHORT',
    category: 'confluence',
    phases: [
      { id: 'fvg_bear', name: 'Bearish FVG present', check: 'fvgBearPresent' },
      { id: 'ob_bear', name: 'Bearish OB present', check: 'obBearPresent' },
      { id: 'stack', name: 'FVG and OB overlap in zone', check: 'fvgObStackBear' },
      { id: 'price_taps', name: 'Price taps stacked zone', check: 'priceAtPOI' },
      { id: 'entry', name: 'Entry confirmation', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at liquidity', check: 'targetAtLiquidityBelow' }
    ],
    shortVersion: ['stack', 'price_taps', 'entry']
  },

  // === PREMIUM/DISCOUNT (simple) ===
  discount_bounce_long: {
    id: 'discount_bounce_long',
    name: 'Discount Bounce Long',
    description: 'Price in discount zone (< 50% range), POI present, bounce entry.',
    direction: 'LONG',
    category: 'premium_discount',
    phases: [
      { id: 'in_discount', name: 'Price in discount zone', check: 'priceInDiscount' },
      { id: 'poi', name: 'POI (OB/FVG) in zone', check: 'poiInDiscount' },
      { id: 'bounce', name: 'Bounce / reversal candle', check: 'reversalCandleBull' },
      { id: 'entry', name: 'Entry confirmation', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at equilibrium or premium', check: 'targetAtLiquidityAbove' }
    ],
    shortVersion: ['in_discount', 'poi', 'entry']
  },

  premium_reject_short: {
    id: 'premium_reject_short',
    name: 'Premium Reject Short',
    description: 'Price in premium zone (> 50% range), POI present, rejection entry.',
    direction: 'SHORT',
    category: 'premium_discount',
    phases: [
      { id: 'in_premium', name: 'Price in premium zone', check: 'priceInPremium' },
      { id: 'poi', name: 'POI (OB/FVG) in zone', check: 'poiInPremium' },
      { id: 'reject', name: 'Rejection / reversal candle', check: 'reversalCandleBear' },
      { id: 'entry', name: 'Entry confirmation', check: 'entryConfirmation' },
      { id: 'target', name: 'Target at equilibrium or discount', check: 'targetAtLiquidityBelow' }
    ],
    shortVersion: ['in_premium', 'poi', 'entry']
  }
};

function getAllScenarios() {
  return Object.values(TRADE_SCENARIOS);
}

function getScenario(id) {
  return TRADE_SCENARIOS[id] || null;
}

function getScenariosByDirection(direction) {
  return getAllScenarios().filter(s => s.direction === direction);
}

function getScenariosByCategory(category) {
  return getAllScenarios().filter(s => s.category === category);
}

module.exports = {
  TRADE_SCENARIOS,
  getAllScenarios,
  getScenario,
  getScenariosByDirection,
  getScenariosByCategory
};
