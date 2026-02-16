# Crypto Trading Signals

[![CI](https://github.com/Sharedvaluevending/voting-app/actions/workflows/ci.yml/badge.svg)](https://github.com/Sharedvaluevending/voting-app/actions/workflows/ci.yml)
[![Security Audit](https://github.com/Sharedvaluevending/voting-app/actions/workflows/security.yml/badge.svg)](https://github.com/Sharedvaluevending/voting-app/actions/workflows/security.yml)
[![Deploy](https://github.com/Sharedvaluevending/voting-app/actions/workflows/deploy.yml/badge.svg)](https://github.com/Sharedvaluevending/voting-app/actions/workflows/deploy.yml)

Professional crypto trading signals with multi-strategy scoring, paper trading, learning engine, and user accounts.

## Features

- Multi-strategy signal scoring
- Paper trading simulation
- Candlestick and chart pattern recognition
- Learning engine for strategy optimization
- Real-time WebSocket price feeds
- Push notifications and email alerts
- Trade journaling and analytics

## Getting Started

```bash
npm install
npm start
```

Requires `MONGODB_URI` and `SESSION_SECRET` environment variables.

## Deployment

Deployed to [Render](https://render.com) via `render.yaml`. See the deploy workflow for CI verification before Render picks up the push.

## License

ISC
