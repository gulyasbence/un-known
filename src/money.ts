// The money layer. Everything the product needs from Orbio / CREDIT goes through here.
// This week: a stub that logs what it would do. Later: viem + api.orbio.so behind the same three calls.
//   fund(round)      -> buyAndActivate(usdgIn, minCreditOut, beneficiary, maxFills) + key from wallet signature
//   balance()        -> GET /api/v1/key, or the X-Orbio-Balance header on the last response
//   payout(session)  -> CREDIT transfer or an off-ramp claim link to the interviewee
import { db, now } from './db.js';

export type Fund = { tx: string; balance_cents: number; key_hint: string };
export function priceRound(interviews: number, bounty_cents: number) {
  const inference_cents = Math.round(interviews * 42); // ~$0.42 per 6-minute session at Sonnet rates, measured later from the balance header
  const bounties_cents = interviews * bounty_cents;
  const fee_cents = 0;
  return { inference_cents, bounties_cents, fee_cents, total_cents: inference_cents + bounties_cents + fee_cents };
}
export async function fund(roundId: string, interviews: number, bounty_cents: number): Promise<Fund> {
  const p = priceRound(interviews, bounty_cents);
  const tx = 'stub:buyAndActivate:' + roundId;
  console.log(`[money] would buyAndActivate usdgIn=${(p.total_cents / 100).toFixed(2)} beneficiary=<founder wallet> ; would sign "Orbio API key · chain 4663 · epoch N"`);
  db.prepare('update rounds set funded_at=?, tx=?, balance_cents=? where id=?').run(now(), tx, p.total_cents, roundId);
  return { tx, balance_cents: p.total_cents, key_hint: 'sk-orb-…stub' };
}
export function charge(roundId: string, cents: number) {
  db.prepare('update rounds set balance_cents = balance_cents - ? where id=?').run(cents, roundId);
}
export async function payout(sessionId: string, bounty_cents: number) {
  console.log(`[money] would transfer ${(bounty_cents / 100).toFixed(2)} CREDIT (or off-ramp) to interviewee of session ${sessionId}`);
  return { ref: 'stub:payout:' + sessionId };
}
