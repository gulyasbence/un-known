# (un)known

Short user interviews, run by an agent, paid for with Orbio CREDIT.

Live: https://un-known.fly.dev · Built for Orbio Build Week, Sep 2026.

## What it is

A founder pastes what they already have about their project. They get back five things they don't know about their users, ranked, each with the gap written in their own words, plus a list of things the interviewer should stay away from. They fund a round and get one invite link.

Whoever opens that link answers a two-tap screener and then has a short chat with an interviewer agent. It asks about the last real time something happened, quotes the person's own words back before it probes, and moves on when an answer is thin. About five minutes, no account, no app.

Each finished session produces a writeup. The round produces a synthesis across all of them: takeaways, what to change if they are true, and where people disagreed or the evidence is still thin. Every session has a receipt with what was asked, what it cost, and what moved.

The report also hands back a block the founder copies into the AI that already knows their product, which turns the round into How Might We questions and a few small things to try next.

## The loop

```
paste  →  five unknowns  →  fund the round  →  one invite link
                                                      ↓
report  ←  round synthesis  ←  session writeup  ←  the chat
```

Founder pages: `/` (paste), `/brief`, `/round/:id`, `/round/:id/report`.
Interviewee: `/r/:id` spawns a session and redirects to `/s/:token`.

There are no accounts. The round link carries its own key (`/round/:id?key=…`), so it is the only way back to a round and its report. The invite link is the separate one the founder sends out.

## Orbio

Everything the model does runs through Orbio's OpenAI-compatible gateway: the brief, every turn of every chat, each session writeup, and the round synthesis. Claude Sonnet 5, with Sonnet 4.5 as a fallback when no provider is serving.

**The key is a wallet signature.** The agent wallet signs `Orbio API key · chain 4663 · epoch N` and the signature is the key (`src/chain.ts`, `deriveApiKey`). No transaction, nothing to store.

**Funding a round buys CREDIT on chain.** The wallet approves USDG and calls `exchange.buyAndActivate(usdgIn, minCreditOut, beneficiary, maxFills)` on Robinhood Chain (4663), quoting the order book first with `getQuote` and allowing 1% slippage. The CREDIT burns into the key's API balance in the same transaction, so one call takes a round from paid to usable.

This path has been run for real. Sep 17: 2.10 USDG in, 2.80 CREDIT out, one fill, bought and activated in a single transaction, [`0xa41bf711fc8e43c6d7583b91e5c677d6e91d862a7f1b219435f9deb2be8f28e8`](https://robinhoodchain.blockscout.com/tx/0xa41bf711fc8e43c6d7583b91e5c677d6e91d862a7f1b219435f9deb2be8f28e8). The sessions and the report on that round then spent against the balance it created.

**One key, one balance.** Funding reads the gateway balance first and buys only the shortfall, so a round that is already covered costs nothing on chain.

**Two keys.** The brief runs on the product's own key and is free to the founder; the round page says "on us". Sessions and reports run on the round's wallet-derived key, which is the balance `buyAndActivate` filled. The receipt can then say whose money paid for what.

**Spend is metered per session.** Every gateway response carries `X-Orbio-Balance`, and a session's cost is the change in the key's lifetime `used` between its first and last call. Measured on real rounds: 1 to 11 cents per session, most of them 3 to 7.

The Orbio-facing code is small and sits in two files: `src/money.ts` (fund, balance, charge, payout) and `src/chain.ts` (viem, contracts, key derivation). ABIs in `abi/` are Orbio's published integration subsets.

Contracts: CREDIT `0xe333…004c`, Exchange `0x6951…ebc0`, USDG `0x5fc5…d168`.

## What runs on what, this week

The live demo runs on the $50 Orbio allowance from Build Week. `FUND_TESTING=1` is set there, which means funding a round costs $0 and the sessions draw on that allowance instead of buying more CREDIT. The chain path above is the same code with the flag unset, and it is what produced the transaction linked above.

Two other things the UI states but worth repeating here:

- Suggested bounties are paid by hand. The round holds the amount and the receipt shows it, and nothing moves on chain to the person who answered. Paying them in CREDIT is the next loop to build.
- The round price is a budget envelope. 10 cents per interview against a measured 3 to 7, with headroom for a more expensive model. Pricing it properly needs more rounds than a week gives.

Everything else is live: the gateway, the wallet-derived key, `buyAndActivate`, per-session metering, the receipt, and the whole flow end to end with real people answering.

## Stack

Hono and TypeScript on Node 24, `node:sqlite` for storage, the OpenAI SDK pointed at Orbio, viem for the chain, plain HTML and CSS in `public/` with no build step and no framework. Deployed on Fly.

```
src/server.ts    routes, session flow, report generation
src/prompts.ts   brief, interviewer, writeup, round synthesis
src/llm.ts       gateway client, model fallback, cost from usage
src/money.ts     fund / balance / charge / payout
src/chain.ts     Robinhood Chain, Orbio contracts, key from signature
public/          six pages, no build step
```

## Run it

```
pnpm install
cp .env.example .env    # add ORBIO_API_KEY, or leave empty for the mock model
pnpm dev
```

Open http://localhost:3010. With no key the model layer is mocked, so the flow is walkable without spending anything. With `WALLET_PRIVATE_KEY` unset the money layer is a stub that logs what it would have done on chain.

## Deploy

Dockerfile and `fly.toml` included, SQLite on a mounted `data` volume.

```
fly launch --copy-config
fly secrets set ORBIO_API_KEY=… WALLET_PRIVATE_KEY=… RPC_URL=…
fly deploy
```

`GET /api/health` reports the model in use, the wallet's USDG / CREDIT / ETH and both gateway balances. It needs `Authorization: Bearer $HEALTH_TOKEN`.
