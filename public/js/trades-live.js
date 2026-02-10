/**
 * Active Trades live updates: time every 1s, price and PnL every 10s
 * Score checks with probability, heat, actions, timeline every 60s
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

  // ---- Timeline Chart Drawing ----
  function drawTimeline(canvas, history) {
    if (!canvas || !canvas.getContext || !history || history.length < 2) return;
    var ctx = canvas.getContext('2d');
    var w = canvas.width;
    var h = canvas.height;
    var pad = { top: 8, right: 8, bottom: 14, left: 28 };
    var plotW = w - pad.left - pad.right;
    var plotH = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);

    var scores = history.map(function(p) { return p.score; });
    var minS = Math.max(0, Math.min.apply(null, scores) - 5);
    var maxS = Math.min(100, Math.max.apply(null, scores) + 5);
    if (maxS - minS < 10) { minS = Math.max(0, minS - 5); maxS = Math.min(100, maxS + 5); }
    var range = maxS - minS || 1;

    // Grid lines
    ctx.strokeStyle = '#1e2a3a';
    ctx.lineWidth = 0.5;
    for (var g = 0; g <= 2; g++) {
      var gy = pad.top + (plotH * g / 2);
      ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(pad.left + plotW, gy); ctx.stroke();
      ctx.fillStyle = '#4b5563';
      ctx.font = '8px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxS - (range * g / 2)), pad.left - 3, gy + 3);
    }

    // Line + gradient
    ctx.beginPath();
    for (var i = 0; i < history.length; i++) {
      var x = pad.left + (i / (history.length - 1)) * plotW;
      var y = pad.top + plotH - ((history[i].score - minS) / range) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    // Determine line color by last heat
    var lastHeat = history[history.length - 1].heat || 'green';
    var lineColor = lastHeat === 'red' ? '#ef4444' : lastHeat === 'yellow' ? '#eab308' : '#10b981';
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Fill under line
    var grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, lineColor.replace(')', ',0.2)').replace('rgb', 'rgba').replace('#ef4444', 'rgba(239,68,68,0.2)').replace('#eab308', 'rgba(234,179,8,0.2)').replace('#10b981', 'rgba(16,185,129,0.2)'));
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    // Simpler approach: use rgba directly
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = lastHeat === 'red' ? 'rgba(239,68,68,0.15)' : lastHeat === 'yellow' ? 'rgba(234,179,8,0.15)' : 'rgba(16,185,129,0.15)';
    ctx.fill();

    // Dots at each point
    for (var j = 0; j < history.length; j++) {
      var dx = pad.left + (j / (history.length - 1)) * plotW;
      var dy = pad.top + plotH - ((history[j].score - minS) / range) * plotH;
      var dotColor = history[j].heat === 'red' ? '#ef4444' : history[j].heat === 'yellow' ? '#eab308' : '#10b981';
      ctx.beginPath();
      ctx.arc(dx, dy, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();
    }

    // Time labels (first and last)
    ctx.fillStyle = '#4b5563';
    ctx.font = '8px sans-serif';
    ctx.textAlign = 'left';
    if (history[0].checkedAt) {
      var t0 = new Date(history[0].checkedAt);
      ctx.fillText(t0.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}), pad.left, h - 2);
    }
    ctx.textAlign = 'right';
    if (history[history.length - 1].checkedAt) {
      var tN = new Date(history[history.length - 1].checkedAt);
      ctx.fillText(tN.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}), pad.left + plotW, h - 2);
    }
  }

  function drawAllTimelines() {
    var histories = window.__scoreHistories || {};
    var canvases = document.querySelectorAll('.health-timeline');
    for (var i = 0; i < canvases.length; i++) {
      var el = canvases[i];
      var tid = el.getAttribute('data-trade-id');
      var canvas = el.querySelector('.timeline-canvas');
      if (tid && histories[tid] && histories[tid].length > 1) {
        drawTimeline(canvas, histories[tid]);
      }
    }
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

    // Draw initial timelines from server data
    drawAllTimelines();

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

    // Score checks: poll every 60s for updated trade score data
    function updateScoreChecks() {
      var url = (window.location.origin || '') + '/api/trade-scores';
      fetch(url, { credentials: 'same-origin' })
        .then(function(r) {
          if (!r.ok) throw new Error('API ' + r.status);
          return r.json();
        })
        .then(function(result) {
          if (!result || !result.success || !result.scoreChecks) return;

          // Update score histories from API
          if (result.scoreHistories) {
            if (!window.__scoreHistories) window.__scoreHistories = {};
            for (var tid in result.scoreHistories) {
              window.__scoreHistories[tid] = result.scoreHistories[tid];
            }
          }

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
            if (check.heat) {
              html += '<span class="heat-dot heat-' + check.heat + '"></span>';
            }
            if (check.checkedAt) {
              var t = new Date(check.checkedAt);
              html += '<span class="score-check-time">' + t.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) + '</span>';
            }
            html += '</div>';

            // Score summary: use scoreDiffDisplay/scoreDiffFavorable when available (for SHORT-friendly display)
            var diff = check.scoreDiffDisplay != null ? check.scoreDiffDisplay : check.scoreDiff;
            var fav = check.scoreDiffFavorable != null ? check.scoreDiffFavorable : (check.scoreDiff >= 0);
            html += '<div class="score-check-summary">';
            html += '<span>Now: <strong>' + check.currentScore + '</strong></span>';
            html += '<span>Entry: <strong>' + check.entryScore + '</strong></span>';
            if (diff > 0) {
              html += '<span class="score-diff ' + (fav ? 'score-diff-pos' : 'score-diff-neg') + '">+' + diff + (fav ? ' \u2191' : '') + '</span>';
            } else if (diff < 0) {
              html += '<span class="score-diff ' + (fav ? 'score-diff-pos' : 'score-diff-neg') + '">' + diff + (fav ? ' \u2191' : '') + '</span>';
            } else {
              html += '<span class="score-diff score-diff-neutral">0</span>';
            }
            html += '</div>';

            // Probability meter
            if (check.entryProbability != null) {
              var barHeat = check.heat || 'green';
              html += '<div class="prob-meter">';
              html += '<div class="prob-row">';
              html += '<span class="prob-label">Win prob at entry</span>';
              html += '<div class="prob-bar-outer"><div class="prob-bar-inner prob-bar-entry" style="width:' + check.entryProbability + '%"></div></div>';
              html += '<span class="prob-value">' + check.entryProbability + '%</span>';
              html += '</div>';
              html += '<div class="prob-row">';
              html += '<span class="prob-label">Current probability</span>';
              html += '<div class="prob-bar-outer"><div class="prob-bar-inner prob-bar-current prob-bar-' + barHeat + '" style="width:' + check.currentProbability + '%"></div></div>';
              html += '<span class="prob-value">' + check.currentProbability + '%</span>';
              html += '</div>';
              html += '</div>';
            }

            // Messages
            html += '<div class="score-check-messages">';
            for (var m = 0; m < check.messages.length; m++) {
              html += '<span class="score-msg score-msg-' + check.messages[m].type + '">' + check.messages[m].text + '</span>';
            }
            html += '</div>';

            // What changed?
            if (check.changeReasons && check.changeReasons.length > 0) {
              html += '<div class="change-reasons">';
              html += '<div class="change-reasons-title">What changed?</div>';
              for (var r = 0; r < check.changeReasons.length; r++) {
                html += '<span class="change-reason change-reason-' + check.changeReasons[r].type + '">' + check.changeReasons[r].text + '</span>';
              }
              html += '</div>';
            }

            // Suggested action
            if (check.suggestedAction) {
              html += '<div class="action-ladder action-' + check.suggestedAction.level + '">';
              html += '<span class="action-label">Action:</span>';
              html += '<span class="action-text">' + check.suggestedAction.text + '</span>';
              html += '</div>';
            }

            // Timeline placeholder
            var history = (window.__scoreHistories && window.__scoreHistories[tradeId]) || [];
            if (history.length > 1) {
              html += '<div class="health-timeline" data-trade-id="' + tradeId + '">';
              html += '<div class="timeline-title">Trade Health Timeline</div>';
              html += '<canvas class="timeline-canvas" width="360" height="80"></canvas>';
              html += '</div>';
            }

            el.innerHTML = html;

            // Draw timeline after DOM update
            if (history.length > 1) {
              var timelineEl = el.querySelector('.health-timeline');
              if (timelineEl) {
                var canvas = timelineEl.querySelector('.timeline-canvas');
                drawTimeline(canvas, history);
              }
            }
          }
        })
        .catch(function() {});
    }
    setInterval(updateScoreChecks, 60000);
    setTimeout(updateScoreChecks, 2000);
  });
})();
