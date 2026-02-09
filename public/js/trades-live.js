/**
 * Active Trades live updates: time every 1s, price and PnL every 10s
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
    setInterval(updatePrices, 10000);
    setTimeout(updatePrices, 1000);
    updatePrices();

    // Score checks: poll every 60s for updated trade score re-checks
    function updateScoreChecks() {
      var url = (window.location.origin || '') + '/api/trade-scores';
      fetch(url, { credentials: 'same-origin' })
        .then(function(r) {
          if (!r.ok) throw new Error('API ' + r.status);
          return r.json();
        })
        .then(function(result) {
          if (!result || !result.success || !result.scoreChecks) return;
          for (var c = 0; c < cards.length; c++) {
            var card = cards[c];
            var tradeId = card.getAttribute('data-trade-id');
            if (!tradeId) continue;
            var check = result.scoreChecks[tradeId];
            if (!check || !check.messages) continue;

            var el = card.querySelector('.score-check');
            if (!el) {
              el = document.createElement('div');
              el.className = 'score-check';
              el.setAttribute('data-trade-id', tradeId);
              var actions = card.querySelector('.trade-actions');
              if (actions) card.insertBefore(el, actions);
              else card.appendChild(el);
            }
            el.classList.remove('score-check-pending');

            var html = '<div class="score-check-header"><h4>Score Check</h4>';
            if (check.checkedAt) {
              var t = new Date(check.checkedAt);
              html += '<span class="score-check-time">' + t.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) + '</span>';
            }
            html += '</div>';
            html += '<div class="score-check-summary">';
            html += '<span>Now: <strong>' + check.currentScore + '</strong></span>';
            html += '<span>Entry: <strong>' + check.entryScore + '</strong></span>';
            if (check.scoreDiff > 0) {
              html += '<span class="score-diff score-diff-pos">+' + check.scoreDiff + '</span>';
            } else if (check.scoreDiff < 0) {
              html += '<span class="score-diff score-diff-neg">' + check.scoreDiff + '</span>';
            } else {
              html += '<span class="score-diff score-diff-neutral">0</span>';
            }
            html += '</div>';
            html += '<div class="score-check-messages">';
            for (var m = 0; m < check.messages.length; m++) {
              html += '<span class="score-msg score-msg-' + check.messages[m].type + '">' + check.messages[m].text + '</span>';
            }
            html += '</div>';

            el.innerHTML = html;
          }
        })
        .catch(function() {});
    }
    setInterval(updateScoreChecks, 60000);
    setTimeout(updateScoreChecks, 2000);
  });
})();
