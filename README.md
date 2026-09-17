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
`src/money.ts`. Three calls: fund a round, read balance, pay a session. Stubbed now, logs what it would do. The real thing: `buyAndActivate` on Robinhood Chain, a key from a wallet signature, `X-Orbio-Balance` on every response.
