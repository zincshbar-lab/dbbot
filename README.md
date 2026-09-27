# NEAR Trading Bot

A multi-user Telegram bot for trading NEAR tokens. Cloned in spirit from a
personal sniper bot, but the **sniper is removed** — no creator snipes, no
snipe-all, no on-chain sniper contract, no auto-deposit. What remains is clean,
professional manual trading with per-user wallets and admin access control.

## Features

- **Admin access control** — admins (from `ADMIN_TELEGRAM_IDS`) grant/revoke
  which Telegram ids may use the bot. Everyone else is ignored.
- **Per-user wallets** — each user **creates** a fresh NEAR wallet or **imports**
  one (private key + address, verified on chain). Keys are stored AES-256-GCM
  encrypted, never shown back or logged.
- **Manual trading** — paste any token contract to get a professional info card
  and buy/sell buttons. Curve tokens (pride.j1.gay) trade in JAMBO; graduated /
  other tokens route through the Intear aggregator in NEAR. shards.market,
  chipfi.fun and umbrapad coins are supported, with holder-dividend claims.
- **Token info card** — market cap, price, supply, curve liquidity, your
  position (entry MC → current MC, cost, PnL), and contract / chart links.
- **Positions & PnL** — cost basis, live value, realised + unrealised PnL.
- **Wallet** — NEAR/JAMBO balances and NEAR↔JAMBO swaps.
- **meme.cooking presales** — deposit, withdraw early, and claim manually.

No bot fees — only network gas and each launchpad's own fees.

## Security

- Only admins and allow-listed ids can use the bot.
- Each user's private key is encrypted with AES-256-GCM (scrypt-derived key,
  random per-record salt); the raw key is never displayed or logged. Imported
  keys are deleted from chat on arrival.
- Use a dedicated hot wallet with only what you're willing to trade. Run on a
  host you control and mount `/data` on a private volume.

## Setup

```bash
cp .env.example .env      # fill in the values
npm install
npm run dev
```

Generate `ENCRYPTION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Then message the bot `/start`.

## Environment

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From @BotFather. |
| `ADMIN_TELEGRAM_IDS` | Comma-separated admin ids (find yours with @userinfobot). |
| `ENCRYPTION_SECRET` | Long random secret used to encrypt stored keys. |
| `NEAR_RPC_URLS` | Comma-separated RPC endpoints (reads fall back through them). |
| `ROUTER_URL` | Intear aggregator base URL. |
| `DATA_DIR` | Where state is stored (default `./data`). |

## Deploy

Docker / Railway: mount a **volume at `/data`**, set the env vars (seal
`ENCRYPTION_SECRET` and `TELEGRAM_BOT_TOKEN`), keep **1 replica**.

```bash
docker build -t nearbot . && docker run -d --restart=always --env-file .env -v $PWD/data:/data nearbot
```

## Layout

```
src/
  index.ts            wiring
  config.ts           env validation
  accounts.ts         admin allowlist + encrypted per-user key records
  wallets.ts          per-user Trader/session manager
  store.ts            per-user positions & settings
  trade.ts            buy/sell on curves or via router, JAMBO swaps, ledger
  lib/crypto.ts       AES-256-GCM encryption
  lib/amount-plan.ts  amount parsing + gaypad buy-size chunking
  near/…              RPC, signer, router, tokens, key verification
  gaypad|shards|chipfi|umbra|memecooking/…  launchpad adapters
  bot/index.ts        Telegram UI: access, wallets, trading, presales, admin
```
