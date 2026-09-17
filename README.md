# Five Unknowns

Paste what you have about your project. Get the five things you don't know about your users, ranked, with the gap in your own words. Fund a round. Real people answer a few questions in a few minutes on a link. You get a report that answers the five, one session at a time, with what it cost on the receipt.

Built on Orbio for Build Week, Sep 2026. Inference runs on an Orbio key. Funding a round buys and activates CREDIT behind one button; the founder never has to say the word.

## Run
```
pnpm install
cp .env.example .env   # add ORBIO_API_KEY, or leave empty for the mock model
pnpm dev
```
Open http://localhost:3010

## Where the money is
`src/money.ts` and `src/chain.ts`. Three calls: fund a round, read balance, pay a session.

- **Fund**: the agent wallet approves USDG and calls `exchange.buyAndActivate(usdgIn, minCreditOut, beneficiary, maxFills)` on Robinhood Chain (4663), quoting first with `getQuote`. The bought CREDIT burns straight into the wallet's API balance. Only the inference part of the round is bought; bounties are paid by hand this week and shown on the receipt.
- **Key**: the wallet signs `Orbio API key · chain 4663 · epoch N`, the signature is the key. No transaction.
- **Balance**: `GET /api/v1/key`, and every model response carries `X-Orbio-Balance`.

With `WALLET_PRIVATE_KEY` unset the layer is a stub that logs what it would do, so the flow runs without a wallet. ABIs in `abi/` are Orbio's published integration subsets.

## Deploy
Dockerfile and `fly.toml` included. SQLite lives on the `data` volume. `fly launch --copy-config`, then set the secrets from `.env.example`.

## Health
`GET /api/health` shows the model in use, the wallet's USDG / CREDIT / ETH, and the gateway balance.
