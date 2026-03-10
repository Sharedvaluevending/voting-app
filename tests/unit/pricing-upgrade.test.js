const fs = require('fs');
const path = require('path');

describe('pricing and upgrade wiring', () => {
  test('pricing page includes trench add-on and packs', () => {
    const viewPath = path.join(__dirname, '../../views/pricing.ejs');
    const text = fs.readFileSync(viewPath, 'utf8');
    expect(text).toContain('Trench Warfare — $5/mo');
    expect(text).toContain('MOST POPULAR');
    expect(text).toContain('Copilot Question Packs');
    expect(text).toContain('LLM Message Packs');
    expect(text).toContain('Voice Minute Packs');
    expect(text).toContain('Start Pro Trial');
    expect(text).toContain('Start Elite Trial');
  });

  test('server exposes trench upgrade + pack purchase routes', () => {
    const appPath = path.join(__dirname, '../../voting-app.js');
    const text = fs.readFileSync(appPath, 'utf8');
    expect(text).toContain("app.post('/api/stripe/add-trench'");
    expect(text).toContain("app.post('/api/stripe/buy-pack'");
    expect(text).toContain("app.get('/trench-upgrade'");
    expect(text).toContain("app.get('/api/trench/positions'");
  });
});
