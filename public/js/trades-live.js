/**
 * Active Trades live updates: time every 1s, price and PnL every 10s,
 * trade actions and SL updates every 10s
 */
(function() {
  'use strict';

  function formatPrice(price) {
    if (price == null || isNaN(price)) return '0.00';
    var n = Number(price);
    if (n >= 1000) return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (n >= 1) return n.toFixed(2);
    if (n >= 0.01) return n.toFixed(4);
    return n.toFixed(8);
  }

  function timeHeldStr(entryTimeMs) {
    var heldMs = Date.now() - entryTimeMs;
    var totalSecs = Math.max(0, Math.floor(heldMs / 1000));
    var secs = totalSecs % 60;
    var mins = Math.floor(totalSecs / 60) % 60;
    var hours = Math.floor(totalSecs / 3600);
    var days = Math.floor(hours / 24);
    if (days > 0) return days + 'd ' + (hours % 24) + 'h';
    if (hours > 0) return hours + 'h ' + mins + 'm ' + secs + 's';
    if (mins > 0) return mins + 'm ' + secs + 's';
    return secs + 's';
  }

  function formatActionTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function runWhenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  runWhenReady(function() {
    var cards = document.querySelectorAll('.trade-card');
    if (!cards || cards.length === 0) return;

    // Time held: update every second
    function tickTime() {
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        var entryTime = card.getAttribute('data-entry-time');
        if (!entryTime) continue;
        var entryMs = new Date(entryTime).getTime();
        if (isNaN(entryMs)) continue;
        var el = card.querySelector('.trade-time');
        if (el) el.textContent = timeHeldStr(entryMs);
      }
    }
    setInterval(tickTime, 1000);
    tickTime();

    // Price & PnL: fetch every 10 seconds
    function updatePrices() {
      var url = (window.location.origin || '') + '/api/prices';
      fetch(url, { credentials: 'same-origin' })
        .then(function(r) {
          if (!r.ok) throw new Error('API ' + r.status);
          return r.json();
        })
        .then(function(result) {
          if (!result || !result.success || !result.data || !Array.isArray(result.data)) return;
          var priceMap = {};
          for (var i = 0; i < result.data.length; i++) {
            var p = result.data[i];
            if (p && p.id != null) priceMap[p.id] = Number(p.price);
          }
          for (var c = 0; c < cards.length; c++) {
            var card = cards[c];
            var coinId = card.getAttribute('data-coin-id');
            var currentPrice = priceMap[coinId];
            if (currentPrice == null || isNaN(currentPrice) || currentPrice <= 0) continue;
            var entryPrice = parseFloat(card.getAttribute('data-entry-price'));
            var positionSize = parseFloat(card.getAttribute('data-position-size'));
            var margin = parseFloat(card.getAttribute('data-margin'));
            var direction = card.getAttribute('data-direction');
            if (!margin || margin <= 0) continue;
            var pnl = direction === 'LONG'
              ? ((currentPrice - entryPrice) / entryPrice) * positionSize
              : ((entryPrice - currentPrice) / entryPrice) * positionSize;
            var pnlPct = (pnl / margin) * 100;

            var priceEl = card.querySelector('.trade-price');
            var dollarEl = card.querySelector('.trade-pnl-dollar');
            var pctEl = card.querySelector('.trade-pnl-pct');
            var levelEl = card.querySelector('.trade-current-level');
            var wrapEl = card.querySelector('.trade-pnl-wrap');

            if (priceEl) priceEl.textContent = '$' + formatPrice(currentPrice);
            if (dollarEl) dollarEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
            if (pctEl) pctEl.textContent = ' (' + pnlPct.toFixed(2) + '%)';
            if (levelEl) {
              levelEl.textContent = '$' + formatPrice(currentPrice);
              levelEl.className = 'level-value trade-current-level ' + (pnl >= 0 ? 'tp' : 'sl');
            }
            if (wrapEl) wrapEl.className = 'change trade-pnl-wrap ' + (pnl >= 0 ? 'up' : 'down');
            card.classList.remove('buy', 'sell');
            card.classList.add(pnl >= 0 ? 'buy' : 'sell');
          }
        })
        .catch(function() {});
    }

    // Fetch live trade data (actions, updated SL) every 10 seconds
    function updateTradeActions() {
      var url = (window.location.origin || '') + '/api/trades/active';
      fetch(url, { credentials: 'same-origin' })
        .then(function(r) {
          if (!r.ok) throw new Error('API ' + r.status);
          return r.json();
        })
        .then(function(result) {
          if (!result || !result.success || !Array.isArray(result.trades)) return;
          var tradeMap = {};
          for (var i = 0; i < result.trades.length; i++) {
            var t = result.trades[i];
            tradeMap[t._id] = t;
          }
          for (var c = 0; c < cards.length; c++) {
            var card = cards[c];
            var tradeId = card.getAttribute('data-trade-id');
            if (!tradeId || !tradeMap[tradeId]) continue;
            var trade = tradeMap[tradeId];

            // Update SL display if it changed
            var currentSLAttr = card.getAttribute('data-stop-loss');
            var newSL = trade.stopLoss;
            if (newSL != null && String(newSL) !== currentSLAttr) {
              card.setAttribute('data-stop-loss', String(newSL));
              var slEl = card.querySelector('.trade-sl-value');
              if (slEl) {
                var origSL = card.getAttribute('data-original-sl');
                var slChanged = origSL && String(newSL) !== origSL;
                var html = '$' + formatPrice(newSL);
                if (slChanged) {
                  html += '<div style="font-size:10px;color:#6b7280;text-decoration:line-through;">$' + formatPrice(Number(origSL)) + '</div>';
                }
                slEl.innerHTML = html;
                // Update the SL label to show (moved)
                var slLabel = slEl.parentElement ? slEl.parentElement.querySelector('.level-label') : null;
                if (slLabel) {
                  slLabel.innerHTML = slChanged
                    ? 'SL <span style="color:#3b82f6;font-size:10px;">(moved)</span>'
                    : 'SL';
                }
              }
            }

            // Update actions log
            var actionsLog = card.querySelector('.trade-actions-log');
            if (actionsLog && trade.actions && trade.actions.length > 0) {
              var html = '<h4 style="color:#93c5fd;font-size:12px;margin:0 0 6px 0;text-transform:uppercase;letter-spacing:0.5px;">Actions Taken</h4>';
              for (var a = 0; a < trade.actions.length; a++) {
                var action = trade.actions[a];
                var typeColor = action.type === 'BREAKEVEN' ? '#10b981' : '#3b82f6';
                var typeLabel = action.type === 'BREAKEVEN' ? 'BE' : 'TS';
                var timeStr = action.timestamp ? formatActionTime(action.timestamp) : '';
                html += '<div style="font-size:12px;color:#d1d5db;padding:3px 0;display:flex;align-items:center;gap:6px;">';
                html += '<span style="color:' + typeColor + ';font-size:11px;font-weight:700;">' + typeLabel + '</span>';
                html += '<span>' + action.description + '</span>';
                if (timeStr) {
                  html += '<span style="color:#6b7280;font-size:10px;margin-left:auto;white-space:nowrap;">' + timeStr + '</span>';
                }
                html += '</div>';
              }
              actionsLog.innerHTML = html;
              actionsLog.style.background = 'rgba(59,130,246,0.08)';
              actionsLog.style.borderColor = 'rgba(59,130,246,0.2)';
            }
          }
        })
        .catch(function() {});
    }

    setInterval(updatePrices, 10000);
    setInterval(updateTradeActions, 10000);
    setTimeout(function() {
      updatePrices();
      updateTradeActions();
    }, 1000);
    updatePrices();
    updateTradeActions();
  });
})();
