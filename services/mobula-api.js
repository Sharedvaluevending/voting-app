// services/mobula-api.js
// ====================================================
// MOBULA API - Trending, Pulse, Swap
// Meta Trendings: CoinGecko + CoinMarketCap + LamboTrendings
// Swap: Quote + Send (Solana)
// ====================================================

const fetch = require('node-fetch');

const BASE_URL = process.env.MOBULA_API_KEY
  ? 'https://api.mobula.io/api'
  : 'https://demo-api.mobula.io/api';

const SOL_MINT = 'So11111111111111111111111111111111111111111';

function getHeaders() {
  const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
  if (process.env.MOBULA_API_KEY) {
    headers['Authorization'] = process.env.MOBULA_API_KEY;
  }
  return headers;
}

// ====================================================
// META TRENDINGS - CoinGecko, CMC, LamboTrendings
// ====================================================
function mapTrendingItem(item) {
  const solanaContract = (item.contracts || []).find((c) =>
    (c.blockchain || '').toLowerCase() === 'solana'
  );
  return {
    id: item.id,
    name: item.name || '',
    symbol: item.symbol || '',
    price: typeof item.price === 'number' ? item.price : 0,
    priceChange24h: typeof item.price_change_24h === 'number' ? item.price_change_24h : 0,
    trendingScore: typeof item.trending_score === 'number' ? item.trending_score : 0,
    logo: item.logo || '',
    platforms: item.platforms || [],
    contracts: item.contracts || [],
    tokenAddress: solanaContract ? solanaContract.address : null,
    pair: item.pair || null
  };
}

async function fetchMetaTrendings(blockchain = 'solana', platform) {
  const params = new URLSearchParams({ blockchain });
  if (platform) params.set('platform', platform);
  const url = `${BASE_URL}/1/metadata/trendings?${params.toString()}`;
  const res = await fetch(url, { headers: getHeaders(), timeout: 15000 });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mobula trendings: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map(mapTrendingItem);
}

// Fetch from multiple platforms and merge (Dexscreener = DEX gainers, LamboTrendings = memecoins)
async function fetchMetaTrendingsMulti(blockchain = 'solana') {
  const platforms = ['Dexscreener', 'LamboTrendings', 'CoinGecko'];
  const seen = new Map();
  const merged = [];
  for (const platform of platforms) {
    try {
      const data = await fetchMetaTrendings(blockchain, platform);
      for (const t of data) {
        if (t.tokenAddress && !seen.has(t.tokenAddress)) {
          seen.set(t.tokenAddress, true);
          merged.push(t);
        }
      }
      if (!process.env.MOBULA_API_KEY) await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      console.warn(`[Mobula] ${platform} trendings failed:`, e.message);
    }
  }
  if (merged.length === 0) {
    const fallback = await fetchMetaTrendings(blockchain);
    return fallback;
  }
  return merged.sort((a, b) => (b.trendingScore || 0) - (a.trendingScore || 0));
}

// ====================================================
// SWAP QUOTE (Solana: SOL -> token)
// ====================================================
async function getSwapQuote(chainId, tokenIn, tokenOut, amount, walletAddress, opts = {}) {
  const slippage = opts.slippage ?? 5;
  const onlyRouters = opts.onlyRouters || 'jupiter';
  const priorityFee = opts.priorityFee || 'high';
  const params = new URLSearchParams({
    chainId,
    tokenIn,
    tokenOut,
    amount: String(amount),
    walletAddress,
    slippage: String(slippage),
    onlyRouters,
    priorityFee
  });
  const url = `${BASE_URL}/2/swap/quoting?${params.toString()}`;
  const res = await fetch(url, {
    headers: getHeaders(),
    timeout: 20000
  });
  const json = await res.json();
  if (!res.ok) {
    const err = json.error || json.message || `HTTP ${res.status}`;
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }
  return json;
}

// ====================================================
// TOKEN MARKETS (liquidity, holder distribution)
// ====================================================
async function getTokenMarkets(blockchain, tokenAddress) {
  const params = new URLSearchParams({
    blockchain: blockchain || 'solana',
    address: tokenAddress,
    limit: '1'
  });
  const url = `${BASE_URL}/2/token/markets?${params.toString()}`;
  const res = await fetch(url, { headers: getHeaders(), timeout: 10000 });
  const json = await res.json();
  if (!res.ok) return null;
  const arr = json.data;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const m = arr[0];
  const base = m.base || m;
  const top10 = (() => { const v = base.top10HoldingsPercentage ?? base.top_10_holdings_percentage ?? 100; return v <= 1 ? v * 100 : v; })();
  const devPct = base.devHoldingsPercentage ?? base.dev_holdings_percentage ?? 0;
  const insidersPct = base.insidersHoldingsPercentage ?? base.insiders_holdings_percentage ?? 0;
  const devPctNorm = (typeof devPct === 'number' && devPct <= 1) ? devPct * 100 : devPct;
  const insidersPctNorm = (typeof insidersPct === 'number' && insidersPct <= 1) ? insidersPct * 100 : insidersPct;
  const buy1h = m.volumeBuy1hUSD ?? m.volumeBuy1h ?? 0;
  const sell1h = m.volumeSell1hUSD ?? m.volumeSell1h ?? 0;
  return {
    liquidityUSD: base.liquidityUSD || base.liquidity || m.liquidityUSD || 0,
    top10HoldingsPercentage: top10,
    volume24h: base.volume24h || m.volume24hUSD || m.volume24h || 0,
    marketCap: base.marketCapUSD || base.market_cap || 0,
    priceChange1hPercentage: m.priceChange1hPercentage ?? m.priceChange1h ?? 0,
    volumeBuy1hUSD: buy1h,
    volumeSell1hUSD: sell1h,
    volume1hUSD: (buy1h + sell1h) || m.volume1hUSD || 0,
    insidersCount: base.insidersCount ?? base.insiders_count ?? 0,
    bundlersCount: base.bundlersCount ?? base.bundlers_count ?? 0,
    snipersCount: base.snipersCount ?? base.snipers_count ?? 0,
    devHoldingsPercentage: devPctNorm,
    insidersHoldingsPercentage: insidersPctNorm
  };
}

// ====================================================
// SWAP SEND (broadcast signed tx)
// ====================================================
async function sendSwapTransaction(chainId, signedTransactionBase64) {
  const url = `${BASE_URL}/2/swap/send`;
  const res = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      chainId,
      signedTransaction: signedTransactionBase64
    }),
    timeout: 30000
  });
  const json = await res.json();
  if (!res.ok) {
    const err = json.error || json.message || `HTTP ${res.status}`;
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }
  return json;
}

module.exports = {
  fetchMetaTrendings,
  fetchMetaTrendingsMulti,
  getSwapQuote,
  sendSwapTransaction,
  getTokenMarkets,
  SOL_MINT
};
