// How much of an X search is real, specific complaints? Posts nothing.
// For each product: one search, then the model labels every post. Raw results go to
// data/search-samples/<date>.json so later query changes can be compared.
// Run: pnpm exec tsx scripts/test-search-quality.ts
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gatewayBalance } from '../src/money.js';
import { init, json, MODEL } from '../src/llm.js';

const KEY = process.env.ORBIO_API_KEY;
if (!KEY) { console.error('ORBIO_API_KEY is not set in .env'); process.exit(1); }

const PRODUCTS = ['fomo', 'axiom', 'photon', 'phantom'];
const queryFor = (p: string) =>
  `${p} (slow OR broken OR failed OR stuck OR bug OR fees OR "doesn't work" OR worst OR scam OR support) -is:retweet -"use my" -"my code" -"ref" -"referral" -"% off" -"sign up" -giveaway lang:en`;

type Label = 'real_complaint' | 'referral_ad' | 'promo' | 'other';
type Verdict = { id: string; label: Label; reason: string; specific: boolean };

const SYS = `You sort X posts found by searching for complaints about a crypto product.
For each post, pick exactly one label:
- real_complaint: a person describing a problem they had with the product (it broke, was slow, failed, charged too much, support let them down). Sarcasm and frustration count.
- referral_ad: pushes a referral code, discount, affiliate link or "trade with me".
- promo: marketing, shilling, PnL flexing, news, announcements, threads selling something.
- other: anything else (questions, jokes, unrelated uses of the word, general opinions).
For real complaints only, set "specific": true if the post points at a concrete experience you could ask about with "what happened the last time?" (a failed transaction, a stuck withdrawal, a fee they paid). Vague venting ("this app sucks") is false. For every other label, "specific" is false.
Give a one-line reason in plain English, under 15 words.
Return JSON only: {"posts": [{"id": string, "label": string, "reason": string, "specific": boolean}]}, one entry per post, same ids.`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function search(query: string) {
  const res = await fetch('https://api.orbio.so/api/v1/tools/social.x.posts', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, sort: 'Latest', limit: 20, max_cost: '0.01' }),
  });
  const j: any = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, error: j?.error, credit: Number(j?.cost?.credit ?? 0), ran: j?.result?.query, tweets: (j?.result?.tweets ?? []) as any[] };
}

// X ids are bigger than JS numbers hold exactly: always read the *_str fields.
const slim = (t: any) => ({
  id: String(t.id_str),
  handle: t.user?.screen_name ?? '?',
  followers: t.user?.followers_count ?? null,
  created: t.tweet_created_at ?? null,
  replies: t.reply_count ?? 0,
  text: String(t.full_text ?? t.text ?? '').replace(/\s+/g, ' ').trim(),
});

await init();
const start = await gatewayBalance('prep');
const out: any = { run_at: new Date().toISOString(), model: MODEL, products: {} };
const summary: { product: string; n: number; real: number; specific: number; counts: Record<string, number>; credit: number }[] = [];
let toolCredit = 0;

for (const product of PRODUCTS) {
  const query = queryFor(product);
  const s = await search(query);
  toolCredit += s.credit;
  console.log(`\n=== ${product}  (HTTP ${s.status}, ${s.tweets.length} posts, ${s.credit} CREDIT)`);
  if (!s.ok) { console.log('  error:', JSON.stringify(s.error)); out.products[product] = { query, error: s.error }; continue; }

  const posts = s.tweets.map(slim);
  let verdicts: Verdict[] = [];
  if (posts.length) {
    const user = posts.map(p => `id: ${p.id}\n@${p.handle}: ${p.text}`).join('\n\n');
    const r = await json<{ posts: Verdict[] }>(SYS, `Product: ${product}\n\n${user}`,
      () => ({ posts: posts.map(p => ({ id: p.id, label: 'other' as Label, reason: 'model output unreadable', specific: false })) }), 'prep');
    verdicts = r.data.posts ?? [];
  }
  const byId = new Map(verdicts.map(v => [String(v.id), v]));
  const rows = posts.map(p => ({ ...p, ...(byId.get(p.id) ?? { label: 'other' as Label, reason: 'no label returned', specific: false }) }));

  const counts: Record<string, number> = { real_complaint: 0, referral_ad: 0, promo: 0, other: 0 };
  for (const r of rows) counts[r.label] = (counts[r.label] ?? 0) + 1;
  console.log('  ' + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · '));

  const real = rows.filter(r => r.label === 'real_complaint');
  for (const r of real) console.log(`  ${r.specific ? '[specific]' : '[vague]   '} @${r.handle} (${r.followers ?? '?'} followers) · ${r.id}\n      ${r.text.slice(0, 200)}\n      why: ${r.reason}`);
  if (!real.length) console.log('  no real complaints in this sample');

  out.products[product] = { query, ran: s.ran, credit: s.credit, counts, posts: rows };
  summary.push({ product, n: rows.length, real: real.length, specific: real.filter(r => r.specific).length, counts, credit: s.credit });
}

await sleep(3000);   // let the last charges settle before reading the balance
const end = await gatewayBalance('prep');
const total = start && end ? end.used - start.used : null;
out.cost = { tool_credit: +toolCredit.toFixed(6), total_used_delta: total == null ? null : +total.toFixed(6) };

const day = new Date().toISOString().slice(0, 10);
mkdirSync('data/search-samples', { recursive: true });
const file = `data/search-samples/${day}.json`;
writeFileSync(file, JSON.stringify(out, null, 2));

console.log('\n=== SUMMARY');
for (const s of summary) {
  const share = s.n ? Math.round((s.specific / s.n) * 100) : 0;
  console.log(`  ${s.product.padEnd(8)} ${String(s.n).padStart(2)} posts · ${s.real} real complaints · ${s.specific} specific enough to ask about (${share}% of results)`);
}
console.log(`  Cost: searches ${toolCredit.toFixed(4)} CREDIT; everything including the labelling ${total == null ? 'unknown' : total.toFixed(4)} CREDIT.`);
console.log(`  Raw results saved to ${file}. Nothing was posted.`);
