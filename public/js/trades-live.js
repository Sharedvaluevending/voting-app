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
  // Plot win probability (0-100): "up" = healthier for BOTH LONG and SHORT. No direction transform needed.
  function drawTimeline(canvas, history, direction) {
    if (!canvas || !canvas.getContext || !history || history.length < 2) return;
    var ctx = canvas.getContext('2d');
    var w = canvas.width;
    var h = canvas.height;
    var pad = { top: 8, right: 8, bottom: 14, left: 28 };
    var plotW = w - pad.left - pad.right;
    var plotH = h - pad.top - pad.bottom;

    ctx.clearRect(0, 0, w, h);

    var isShort = (direction || '').toUpperCase() === 'SHORT';
    var scores = history.map(function(p) {
      if (p.probability != null) return p.probability;
      var s = p.score != null ? p.score : 0;
      return isShort ? (100 - s) : s;
    });
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
      var plotVal = history[i].probability != null ? history[i].probability : (isShort ? (100 - (history[i].score || 0)) : (history[i].score || 0));
      var x = pad.left + (i / (history.length - 1)) * plotW;
      var y = pad.top + plotH - ((plotVal - minS) / range) * plotH;
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
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = lastHeat === 'red' ? 'rgba(239,68,68,0.15)' : lastHeat === 'yellow' ? 'rgba(234,179,8,0.15)' : 'rgba(16,185,129,0.15)';
    ctx.fill();

    // Dots at each point
    for (var j = 0; j < history.length; j++) {
      var plotVal = history[j].probability != null ? history[j].probability : (isShort ? (100 - (history[j].score || 0)) : (history[j].score || 0));
      var dx = pad.left + (j / (history.length - 1)) * plotW;
      var dy = pad.top + plotH - ((plotVal - minS) / range) * plotH;
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
      var direction = el.getAttribute('data-direction') || 'LONG';
      var canvas = el.querySelector('.timeline-canvas');
      if (tid && histories[tid] && histories[tid].length > 1) {
        drawTimeline(canvas, histories[tid], direction);
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

    // Active trades data (actions, stopLoss, originalStopLoss): poll every 5s
    function updateActiveTrades() {
      var url = (window.location.origin || '') + '/api/trades/active';
      fetch(url, { credentials: 'same-origin' })
        .then(function(r) {
          if (!r.ok) throw new Error('API ' + r.status);
          return r.json();
        })
        .then(function(result) {
          if (!result || !result.success || !result.trades) return;
          for (var c = 0; c < cards.length; c++) {
            var card = cards[c];
            var tradeId = card.getAttribute('data-trade-id');
            if (!tradeId) continue;
            var t = result.trades[tradeId];
            if (!t) continue;

            var slEl = card.querySelector('.level-value.sl');
            if (slEl && t.stopLoss != null) {
              var slHtml = '$' + formatPrice(t.stopLoss);
              if (t.originalStopLoss && t.originalStopLoss !== t.stopLoss) {
                slHtml += ' <span style="font-size:11px;color:#6b7280;">(<s>$' + formatPrice(t.originalStopLoss) + '</s> moved)</span>';
              }
              slEl.innerHTML = slHtml;
            }

            // Update position size, margin & partial PnL if changed (after partial closes)
            if (t.positionSize != null) {
              card.setAttribute('data-position-size', t.positionSize);
              card.setAttribute('data-margin', t.margin || t.positionSize);
              if (t.partialPnl != null) card.setAttribute('data-partial-pnl', t.partialPnl);
              var origMargin = (t.originalPositionSize || t.positionSize) / (t.leverage || 1);
              card.setAttribute('data-original-margin', origMargin);
              var sizeEl = card.querySelector('.signal-meta');
              if (sizeEl) {
                var sizeSpans = sizeEl.querySelectorAll('span');
                for (var s = 0; s < sizeSpans.length; s++) {
                  if (sizeSpans[s].textContent.indexOf('Size:') >= 0) {
                    var sizeHtml = 'Size: <strong>$' + t.positionSize.toFixed(2) + '</strong>';
                    if (t.originalPositionSize && t.originalPositionSize > t.positionSize) {
                      sizeHtml += ' <span style="font-size:11px;color:#6b7280;">(of $' + t.originalPositionSize.toFixed(2) + ')</span>';
                    }
                    sizeSpans[s].innerHTML = sizeHtml;
                    break;
                  }
                }
              }
            }

            // Update LIVE badge if trade became live
            if (t.isLive && card.getAttribute('data-is-live') !== 'true') {
              card.setAttribute('data-is-live', 'true');
              var coinInfo = card.querySelector('.coin-info');
              if (coinInfo && !coinInfo.querySelector('.live-badge')) {
                var liveBadge = document.createElement('span');
                liveBadge.className = 'live-badge';
                liveBadge.style.cssText = 'font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.3);margin-left:4px;letter-spacing:0.5px;';
                liveBadge.textContent = 'LIVE';
                coinInfo.appendChild(liveBadge);
              }
            }

            if (t.actions && t.actions.length > 0) {
              var actionsWrap = card.querySelector('.trade-actions-taken');
              if (!actionsWrap) {
                actionsWrap = document.createElement('div');
                actionsWrap.className = 'trade-actions-taken';
                var levels = card.querySelector('.levels');
                if (levels) card.insertBefore(actionsWrap, levels);
                else card.appendChild(actionsWrap);
              }
              var latestByType = {};
              t.actions.forEach(function(a) { if (a.type) latestByType[a.type] = a; });
              var deduped = Object.keys(latestByType).map(function(k) { return latestByType[k]; });
              var badges = deduped.map(function(a) {
                var displayVal = '';
                if (['BE','TS','LOCK'].indexOf(a.type) >= 0 && a.newValue != null) {
                  displayVal = ' $' + formatPrice(a.newValue);
                } else if (a.type === 'EXIT' && a.marketPrice != null) {
                  displayVal = ' @$' + formatPrice(a.marketPrice);
                } else if (['PP','RP'].indexOf(a.type) >= 0 && a.marketPrice != null) {
                  displayVal = ' @$' + formatPrice(a.marketPrice);
                }
                var label = (a.type || '?') + displayVal + (a.timestamp ? ' ' + new Date(a.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '');
                var cls = 'action-badge action-' + (a.type || '').toLowerCase();
                return '<span class="' + cls + '" title="' + (a.description || '').replace(/"/g, '&quot;') + '">' + label + '</span>';
              }).join('');
              // Only update the badges div — don't wipe the R-progress section below it
              var badgesDiv = actionsWrap.querySelector('.actions-badges');
              if (badgesDiv) {
                badgesDiv.innerHTML = badges;
              } else {
                // First time: add h4 + badges before any existing content (R-progress)
                if (!actionsWrap.querySelector('h4')) {
                  var h4 = document.createElement('h4');
                  h4.textContent = 'Actions Taken';
                  actionsWrap.insertBefore(h4, actionsWrap.firstChild);
                }
                badgesDiv = document.createElement('div');
                badgesDiv.className = 'actions-badges';
                badgesDiv.innerHTML = badges;
                var h4El = actionsWrap.querySelector('h4');
                if (h4El) h4El.insertAdjacentElement('afterend', badgesDiv);
                else actionsWrap.insertBefore(badgesDiv, actionsWrap.firstChild);
              }
            }
          }
        })
        .catch(function() {});
    }
    setInterval(updateActiveTrades, 5000);
    setTimeout(updateActiveTrades, 3000);

    // Price & PnL: fetch every 5 seconds
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
            var partialPnl = parseFloat(card.getAttribute('data-partial-pnl')) || 0;
            var originalMargin = parseFloat(card.getAttribute('data-original-margin')) || margin;
            var direction = card.getAttribute('data-direction');
            if (!originalMargin || originalMargin <= 0) continue;
            var unrealizedPnl = direction === 'LONG'
              ? ((currentPrice - entryPrice) / entryPrice) * positionSize
              : ((entryPrice - currentPrice) / entryPrice) * positionSize;
            var pnl = partialPnl + unrealizedPnl;
            var pnlPct = (pnl / originalMargin) * 100;

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
    setInterval(updatePrices, 5000);
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
            var direction = card.getAttribute('data-direction') || 'LONG';
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

            // Score summary: for SHORT, show 100-score so "up" = number goes up when favorable
            var isShort = (direction || '').toUpperCase() === 'SHORT';
            var nowVal = isShort ? (100 - (check.currentScore || 0)) : (check.currentScore || 0);
            var entryVal = isShort ? (100 - (check.entryScore || 0)) : (check.entryScore || 0);
            var diff = check.scoreDiffDisplay != null ? check.scoreDiffDisplay : check.scoreDiff;
            var fav = check.scoreDiffFavorable != null ? check.scoreDiffFavorable : (isShort ? (check.scoreDiff <= 0) : (check.scoreDiff >= 0));
            html += '<div class="score-check-summary">';
            html += '<span>Now: <strong>' + nowVal + '</strong></span>';
            html += '<span>Entry: <strong>' + entryVal + '</strong></span>';
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
              var autoOn = window.__autoExecuteActions || false;
              html += '<div class="action-ladder action-' + check.suggestedAction.level + '">';
              html += '<span class="action-label">Action:</span>';
              html += '<span class="action-text">' + check.suggestedAction.text + '</span>';
              if (autoOn) {
                html += '<span style="font-size:9px;padding:2px 5px;border-radius:3px;background:rgba(16,185,129,0.15);color:#10b981;margin-left:6px;font-weight:600;">AUTO</span>';
              } else {
                html += '<span style="font-size:9px;padding:2px 5px;border-radius:3px;background:rgba(234,179,8,0.15);color:#eab308;margin-left:6px;font-weight:600;">SUGGESTION</span>';
              }
              html += '</div>';
              if (check.lastActionDetails) {
                html += '<div class="action-details" style="background:rgba(16,185,129,0.08);border-left:2px solid #10b981;padding:4px 8px;margin-top:4px;border-radius:4px;font-size:11px;color:#d1d5db;">';
                html += '<span style="color:#10b981;font-weight:600;">Executed:</span> ' + check.lastActionDetails;
                html += '</div>';
              }
              if (!autoOn && ['consider_exit','reduce_position','take_partial','tighten_stop','lock_in_profit'].indexOf(check.suggestedAction.actionId) >= 0) {
                html += '<div style="font-size:10px;color:#6b7280;margin-top:3px;">Enable "Auto-execute" in <a href="/performance" style="color:#3b82f6;">Settings</a> to act on this automatically</div>';
              }
            }


            // Timeline placeholder (pass direction so SHORT shows up=favorable)
            var history = (window.__scoreHistories && window.__scoreHistories[tradeId]) || [];
            if (history.length > 1) {
              html += '<div class="health-timeline" data-trade-id="' + tradeId + '" data-direction="' + direction + '">';
              html += '<div class="timeline-title">Trade Health Timeline</div>';
              html += '<canvas class="timeline-canvas" width="360" height="80"></canvas>';
              html += '</div>';
            }

            // Only update DOM if content actually changed (prevents flash on repaint)
            if (el.innerHTML !== html) {
              el.innerHTML = html;
            }

            // Draw timeline after DOM update
            if (history.length > 1) {
              var timelineEl = el.querySelector('.health-timeline');
              if (timelineEl) {
                var canvas = timelineEl.querySelector('.timeline-canvas');
                drawTimeline(canvas, history, direction);
              }
            }
          }
        })
        .catch(function() {});
    }
    setInterval(updateScoreChecks, 60000);
    setTimeout(updateScoreChecks, 5000);
  });
})();
