// The money layer. Everything the product needs from Orbio / CREDIT goes through here.
// Live when WALLET_PRIVATE_KEY is set (and the wallet holds USDG + a little ETH on Robinhood Chain). Otherwise a stub that logs what it would do.
//   fund(round)      -> approve USDG, exchange.buyAndActivate(usdgIn, minCreditOut, beneficiary, maxFills); key = wallet signature
//   balance()        -> GET /api/v1/key
//   payout(session)  -> by hand this week; the receipt carries the line
import { db, now } from './db.js';
import * as chain from './chain.js';

export const live = !!chain.account;
export type Fund = { tx: string; balance_cents: number; explorer?: string; note: string };

export function priceRound(interviews: number, bounty_cents: number) {
  const inference_cents = Math.round(interviews * 42); // placeholder until measured from the balance header on real sessions
  const bounties_cents = interviews * bounty_cents;
  const fee_cents = 0;
  return { inference_cents, bounties_cents, fee_cents, total_cents: inference_cents + bounties_cents + fee_cents };
}

export async function apiKey(): Promise<string | null> {
  if (process.env.ORBIO_API_KEY) return process.env.ORBIO_API_KEY;
  if (chain.account) return chain.deriveApiKey();
  return null;
}
export async function gatewayBalance(): Promise<{ available: number; used: number } | null> {
  const key = await apiKey(); if (!key) return null;
  const r = await fetch((process.env.ORBIO_BASE_URL || 'https://api.orbio.so/api/v1') + '/key', { headers: { authorization: `Bearer ${key}` } });
  if (!r.ok) return null;
  const j: any = await r.json();
  return { available: Number(j.balance?.available ?? 0), used: Number(j.balance?.used ?? 0) };
}

export async function fund(roundId: string, interviews: number, bounty_cents: number): Promise<Fund> {
  const p = priceRound(interviews, bounty_cents);
  if (!live) {
    console.log(`[money] stub: would approve USDG and buyAndActivate ${(p.inference_cents / 100).toFixed(2)} for the round, bounties ${(p.bounties_cents / 100).toFixed(2)} held for hand-pay`);
    db.prepare('update rounds set funded_at=?, tx=?, balance_cents=? where id=?').run(now(), 'stub', p.total_cents, roundId);
    return { tx: 'stub', balance_cents: p.total_cents, note: 'stub, no wallet configured' };
  }
  // Only the inference part is bought and activated. Bounties are paid by hand this week and shown on the receipt.
  const r = await chain.buyAndActivate(p.inference_cents / 100);
  if (r.status !== 'success') throw new Error('buyAndActivate reverted: ' + r.tx);
  const gb = await gatewayBalance();
  const balance_cents = Math.round(((gb?.available ?? r.quoted_credit) * 100)) + p.bounties_cents;
  db.prepare('update rounds set funded_at=?, tx=?, balance_cents=? where id=?').run(now(), r.tx, balance_cents, roundId);
  return { tx: r.tx, balance_cents, explorer: r.explorer, note: `bought ${r.quoted_credit.toFixed(2)} CREDIT for ${r.quoted_usdg.toFixed(2)} USDG and activated it` };
}
export function charge(roundId: string, cents: number) {
  db.prepare('update rounds set balance_cents = balance_cents - ? where id=?').run(cents, roundId);
}
export async function payout(sessionId: string, bounty_cents: number) {
  console.log(`[money] bounty ${(bounty_cents / 100).toFixed(2)} for session ${sessionId}: paid by hand this week`);
  return { ref: 'by hand' };
}
