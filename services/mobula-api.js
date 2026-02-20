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
// META TRENDINGS
// ====================================================
async function fetchMetaTrendings(blockchain = 'solana') {
  const url = `${BASE_URL}/1/metadata/trendings?blockchain=${encodeURIComponent(blockchain)}`;
  const res = await fetch(url, {
    headers: getHeaders(),
    timeout: 15000
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mobula trendings: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map((item) => {
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
  });
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
  getSwapQuote,
  sendSwapTransaction,
  SOL_MINT
};
