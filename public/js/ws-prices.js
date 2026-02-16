/**
 * Shared WebSocket client for real-time prices across all pages.
 * Updates: ticker strip, signal cards, trade cards, nav PnL.
 * Fallback: pages still poll /api/prices; server merges WS prices.
 */
(function() {
  'use strict';

  window.__wsPrices = window.__wsPrices || {};

  function formatPrice(price) {
    if (price == null || isNaN(price)) return '0.00';
    var n = Number(price);
    if (n >= 1000) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (n >= 1) return n.toFixed(2);
    if (n >= 0.01) return n.toFixed(4);
    return n.toFixed(8);
  }

  function updateTicker(coinId, price, change24h) {
    var priceEl = document.querySelector('.ticker[data-coin-id="' + coinId + '"] [data-price]');
    if (priceEl) priceEl.textContent = '$' + formatPrice(price);
    var changeEl = document.querySelector('.ticker[data-coin-id="' + coinId + '"] [data-change]');
    if (changeEl && change24h != null) {
      changeEl.textContent = (change24h >= 0 ? '+' : '') + Number(change24h).toFixed(2) + '%';
      changeEl.className = 'ticker-change ' + (change24h >= 0 ? 'up' : 'down');
    }
  }

  function updateSignalCards(coinId, price, change24h) {
    var cardPrice = document.querySelector('.signal-card[data-coin-id="' + coinId + '"] .card-price');
    if (cardPrice) cardPrice.textContent = '$' + formatPrice(price);
    var cardChange = document.querySelector('.signal-card[data-coin-id="' + coinId + '"] .card-change');
    if (cardChange && change24h != null) {
      cardChange.textContent = (change24h >= 0 ? '+' : '') + Number(change24h).toFixed(2) + '%';
      cardChange.className = 'change card-change ' + (change24h >= 0 ? 'up' : 'down');
    }
    var block = document.querySelector('.coin-detail-price-block[data-coin-id="' + coinId + '"]');
    if (block) {
      var priceEl = block.querySelector('.coin-detail-price');
      if (priceEl) priceEl.textContent = '$' + formatPrice(price);
      var changeEl = block.querySelector('.coin-detail-change');
      if (changeEl && change24h != null) {
        changeEl.textContent = (change24h >= 0 ? '+' : '') + Number(change24h).toFixed(2) + '% (24h)';
        changeEl.className = 'coin-detail-change ' + (change24h >= 0 ? 'up' : 'down');
      }
    }
  }

  function updateTradeCards(coinId, price) {
    var cards = document.querySelectorAll('.trade-card[data-coin-id="' + coinId + '"], .signal-card.trade-card[data-coin-id="' + coinId + '"]');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var entryPrice = parseFloat(card.getAttribute('data-entry-price'));
      var positionSize = parseFloat(card.getAttribute('data-position-size'));
      var partialPnl = parseFloat(card.getAttribute('data-partial-pnl')) || 0;
      var margin = parseFloat(card.getAttribute('data-margin'));
      var originalMargin = parseFloat(card.getAttribute('data-original-margin')) || margin;
      var direction = card.getAttribute('data-direction') || 'LONG';
      if (!originalMargin || originalMargin <= 0 || !Number.isFinite(originalMargin)) continue;

      var unrealizedPnl = direction === 'LONG'
        ? ((price - entryPrice) / entryPrice) * positionSize
        : ((entryPrice - price) / entryPrice) * positionSize;
      var pnl = partialPnl + unrealizedPnl;
      var pnlPct = (pnl / originalMargin) * 100;

      var priceEl = card.querySelector('.trade-price');
      var dollarEl = card.querySelector('.trade-pnl-dollar');
      var pctEl = card.querySelector('.trade-pnl-pct');
      var levelEl = card.querySelector('.trade-current-level');
      var wrapEl = card.querySelector('.trade-pnl-wrap');

      if (priceEl) priceEl.textContent = '$' + formatPrice(price);
      if (dollarEl) dollarEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
      if (pctEl) pctEl.textContent = ' (' + pnlPct.toFixed(2) + '%)';
      if (levelEl) {
        levelEl.textContent = '$' + formatPrice(price);
        levelEl.className = 'level-value trade-current-level ' + (pnl >= 0 ? 'tp' : 'sl');
      }
      if (wrapEl) wrapEl.className = 'change trade-pnl-wrap ' + (pnl >= 0 ? 'up' : 'down');
      card.classList.remove('buy', 'sell');
      card.classList.add(pnl >= 0 ? 'buy' : 'sell');
    }
  }

  function onPriceUpdate(coinId, price, change24h) {
    if (!coinId || price == null || !Number.isFinite(price) || price <= 0) return;
    window.__wsPrices[coinId] = { price: price, change24h: change24h != null ? change24h : 0 };
    updateTicker(coinId, price, change24h);
    updateSignalCards(coinId, price, change24h);
    updateTradeCards(coinId, price);
    window.dispatchEvent(new CustomEvent('ws-price-update', { detail: { coinId: coinId, price: price, change24h: change24h } }));
  }

  var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var wsUrl = protocol + '//' + location.host + '/ws/prices';
  var ws = null;
  var reconnectDelay = 3000;

  function connect() {
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = function(ev) {
        try {
          var msg = JSON.parse(ev.data);
          if (msg.type === 'price' && msg.coinId && msg.price != null) {
            onPriceUpdate(msg.coinId, msg.price, msg.change24h);
          }
        } catch (e) {}
      };
      ws.onclose = function() { setTimeout(connect, reconnectDelay); };
      ws.onerror = function() {};
    } catch (e) {}
  }
  connect();
})();
