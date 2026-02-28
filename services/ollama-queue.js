/**
 * Serializes all LLM requests to avoid overwhelming Ollama/concurrency limits.
 * Ollama returns 429 when multiple requests hit at once.
 * This queue ensures only one LLM request runs at a time.
 */
let _tail = Promise.resolve();

function enqueue(fn) {
  const prev = _tail;
  const p = prev.then(() => fn(), () => fn());
  _tail = p.catch(() => {}); // absorb rejection so next request can proceed
  return p;
}

module.exports = { enqueue };
