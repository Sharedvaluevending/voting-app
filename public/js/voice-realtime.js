(function() {
  'use strict';

  function wsUrlFor(path) {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return protocol + '//' + location.host + path;
  }

  function blobToBase64(blob) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function() {
        var val = String(reader.result || '');
        var idx = val.indexOf(',');
        resolve(idx >= 0 ? val.slice(idx + 1) : val);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function VoiceRealtimeGateway(path) {
    this.path = path || '/ws/voice';
    this.ws = null;
    this.connected = false;
    this.pending = null;
    this.handlers = {};
  }

  VoiceRealtimeGateway.prototype.on = function(eventName, fn) {
    this.handlers[eventName] = fn;
  };

  VoiceRealtimeGateway.prototype._emit = function(eventName, data) {
    if (typeof this.handlers[eventName] === 'function') this.handlers[eventName](data);
  };

  VoiceRealtimeGateway.prototype.connect = function() {
    var self = this;
    return new Promise(function(resolve, reject) {
      try {
        self.ws = new WebSocket(wsUrlFor(self.path));
        self.ws.onopen = function() {
          self.connected = true;
          resolve();
        };
        self.ws.onerror = function() {
          reject(new Error('Voice gateway connection failed'));
        };
        self.ws.onclose = function() {
          self.connected = false;
          self._emit('close', {});
        };
        self.ws.onmessage = function(ev) {
          var msg = null;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }
          if (!msg || !msg.type) return;
          if (msg.type === 'voice_status') self._emit('status', msg);
          if (msg.type === 'voice_error') self._emit('error', msg);
          if (self.pending) {
            if (msg.type === 'voice_transcript') self.pending.transcript = msg;
            if (msg.type === 'voice_response') self.pending.response = msg;
            if (msg.type === 'voice_audio') self.pending.audio = msg;
            if (msg.type === 'voice_done') {
              var out = self.pending;
              self.pending = null;
              out.done = msg;
              out.resolve(out);
            }
            if (msg.type === 'voice_error' && !self.pending.finished) {
              self.pending.finished = true;
              var fail = self.pending;
              self.pending = null;
              fail.reject(new Error(msg.error || 'Voice gateway error'));
            }
          }
        };
      } catch (err) {
        reject(err);
      }
    });
  };

  VoiceRealtimeGateway.prototype.disconnect = function() {
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
    }
    this.ws = null;
    this.connected = false;
  };

  VoiceRealtimeGateway.prototype.sendJson = function(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Voice gateway not connected');
    this.ws.send(JSON.stringify(payload));
  };

  VoiceRealtimeGateway.prototype.start = function(mode, mimeType, meta) {
    this.sendJson({ type: 'voice_start', mode: mode || 'llm', mimeType: mimeType || 'audio/webm', meta: meta || {} });
  };

  VoiceRealtimeGateway.prototype.sendChunkBlob = async function(blob) {
    if (!blob || blob.size === 0) return;
    var b64 = await blobToBase64(blob);
    this.sendJson({ type: 'voice_chunk', data: b64 });
  };

  VoiceRealtimeGateway.prototype.stopAndAwait = function() {
    var self = this;
    if (self.pending) throw new Error('Voice request already in progress');
    return new Promise(function(resolve, reject) {
      self.pending = { resolve: resolve, reject: reject, transcript: null, response: null, audio: null, done: null, finished: false };
      self.sendJson({ type: 'voice_stop' });
    });
  };

  VoiceRealtimeGateway.prototype.cancel = function() {
    try { this.sendJson({ type: 'voice_cancel' }); } catch (e) {}
    this.pending = null;
  };

  window.VoiceRealtimeGateway = VoiceRealtimeGateway;
})();
