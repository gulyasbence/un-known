// How much of what we can read on X is real, specific complaints? Posts nothing.
// Two sources per product, both anchored to the product's own X account:
//   search:  posts that tag the account or reply to it, filtered for complaint words
//   replies: the reply threads under the account's 3 most recent posts
// A cheap model labels every post. Raw results go to data/search-samples/ for comparing runs.
// Run: pnpm exec tsx scripts/test-search-quality.ts
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gatewayBalance } from '../src/money.js';
import { init, json } from '../src/llm.js';

const KEY = process.env.ORBIO_API_KEY;
if (!KEY) { console.error('ORBIO_API_KEY is not set in .env'); process.exit(1); }

const PRODUCTS = [
  { name: 'fomo', handle: 'fomo' },
  { name: 'axiom', handle: 'AxiomExchange' },
  { name: 'photon', handle: 'tradewithPhoton' },
  { name: 'phantom', handle: 'phantom' },
];
const WORDS = '(slow OR broken OR failed OR stuck OR bug OR fees OR "doesn\'t work" OR worst OR scam OR support)';
const EXCLUDE = '-is:retweet -"use my" -"my code" -"ref" -"referral" -"% off" -"sign up" -giveaway lang:en';
const queryFor = (h: string) => `(@${h} OR to:${h}) ${WORDS} ${EXCLUDE}`;
const RECENT_POSTS = 3;

// Cheapest models the gateway actually serves with JSON output (checked Sep 28: deepseek-v4-flash and
// qwen3.7-flash listed but not served that way). The second is the fallback if the first isn't served.
const LABEL_MODELS = ['google/gemini-2.5-flash-lite', 'openai/gpt-5-nano'];

const LABELS = ['real_complaint', 'referral_ad', 'promo', 'joke_or_banter', 'other'] as const;
type Label = typeof LABELS[number];
type Verdict = { id: string; label: Label; reason: string; specific: boolean };

const SYS = `You sort X posts that mention or reply to a crypto product's account.
For each post, pick exactly one label:
- real_complaint: a person describing a problem they had with the product (it broke, was slow, failed, charged too much, support let them down). Genuine frustration counts, even if phrased sharply.
- referral_ad: pushes a referral code, discount, affiliate link or "trade with me".
- promo: marketing, shilling, PnL flexing, news, announcements, threads selling something.
- joke_or_banter: jokes, memes, irony, teasing, reply-guy banter, even when it names a bug or fee, unless there is a real problem underneath.
- other: anything else (questions, praise, unrelated uses of the word, general opinions).
For real complaints only, set "specific": true if the post points at a concrete experience you could ask about with "what happened the last time?" (a failed transaction, a stuck withdrawal, a fee they paid). Vague venting ("this app sucks") is false. For every other label, "specific" is false.
Give a one-line reason in plain English, under 15 words.
Return JSON only: {"posts": [{"id": string, "label": string, "reason": string, "specific": boolean}]}, one entry for EVERY post given, ids copied exactly.`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function tool(name: string, args: Record<string, unknown>) {
  const res = await fetch(`https://api.orbio.so/api/v1/tools/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const j: any = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, error: j?.error, credit: Number(j?.cost?.credit ?? 0), result: j?.result };
}

// X ids are bigger than JS numbers hold exactly: always read the *_str fields.
type Post = { id: string; handle: string; followers: number | null; created: string | null; text: string; context?: string };
const slim = (t: any, context?: string): Post => ({
  id: String(t.id_str),
  handle: t.user?.screen_name ?? '?',
  followers: t.user?.followers_count ?? null,
  created: t.tweet_created_at ?? null,
  text: String(t.full_text ?? t.text ?? '').replace(/\s+/g, ' ').trim(),
  ...(context ? { context } : {}),
});

// Label a batch with the cheap model; ask again once for any post it skipped.
async function label(product: string, posts: Post[]): Promise<(Post & Verdict & { retried?: boolean })[]> {
  if (!posts.length) return [];
  const ask = async (batch: Post[]) => {
    const body = batch.map(p => `id: ${p.id}\n${p.context ? `(reply to the product's post: "${p.context.slice(0, 160)}")\n` : ''}@${p.handle}: ${p.text}`).join('\n\n');
    const r = await json<{ posts: Verdict[] }>(SYS, `Product: ${product}\n\n${body}`, () => ({ posts: [] }), 'prep', { models: LABEL_MODELS });
    return (r.data.posts ?? []).filter(v => LABELS.includes(v.label));
  };
  const got = new Map((await ask(posts)).map(v => [String(v.id), v]));
  const missing = posts.filter(p => !got.has(p.id));
  if (missing.length) for (const v of await ask(missing)) got.set(String(v.id), { ...v, retried: true } as any);
  return posts.map(p => ({ ...p, ...(got.get(p.id) ?? { id: p.id, label: 'other' as Label, reason: 'UNLABELLED after one retry', specific: false }) }));
}

// Real balance change around a step, so each source gets its true cost (tools + labelling).
async function metered<T>(fn: () => Promise<T>): Promise<[T, number | null]> {
  const b = await gatewayBalance('prep');
  const v = await fn();
  await sleep(3000);
  const a = await gatewayBalance('prep');
  return [v, a && b ? +(a.used - b.used).toFixed(6) : null];
}

const countOf = (rows: { label: Label }[]) => Object.fromEntries(LABELS.map(l => [l, rows.filter(r => r.label === l).length])) as Record<Label, number>;
function printSource(title: string, rows: (Post & Verdict & { retried?: boolean })[], cost: number | null) {
  const c = countOf(rows);
  const real = rows.filter(r => r.label === 'real_complaint');
  console.log(`\n  -- ${title}: ${rows.length} posts, ${cost ?? '?'} CREDIT`);
  console.log('     ' + LABELS.map(l => `${l} ${c[l]}`).join(' · '));
  for (const r of real) console.log(`     ${r.specific ? '[specific]' : '[vague]   '} @${r.handle} (${r.followers ?? '?'} followers) · ${r.id}\n         ${r.text.slice(0, 200)}\n         why: ${r.reason}`);
  const unlabelled = rows.filter(r => r.reason === 'UNLABELLED after one retry').length;
  const retried = rows.filter(r => r.retried).length;
  if (retried || unlabelled) console.log(`     labelling: ${retried} needed the retry, ${unlabelled} still unlabelled`);
}

await init();
const runStart = await gatewayBalance('prep');
const out: any = { run_at: new Date().toISOString(), label_models: LABEL_MODELS, products: {} };
type Tot = { n: number; real: number; specific: number; cost: number };
const table: { product: string; search: Tot; replies: Tot }[] = [];
const tot = (rows: any[], cost: number | null): Tot => ({ n: rows.length, real: rows.filter(r => r.label === 'real_complaint').length, specific: rows.filter(r => r.label === 'real_complaint' && r.specific).length, cost: cost ?? 0 });

// ---------- Check the handles exist
const [prof, profCost] = await metered(() => tool('social.x.profile', { handles: PRODUCTS.map(p => p.handle), max_cost: '0.01' }));
console.log(`=== handles (${profCost ?? '?'} CREDIT)`);
const profiles: any[] = prof.result?.profiles ?? [];
for (const p of PRODUCTS) {
  const f = profiles.find(x => String(x.screen_name ?? '').toLowerCase() === p.handle.toLowerCase());
  console.log(f ? `  @${f.screen_name} · ${f.name} · ${f.followers_count} followers · verified ${f.verified} · ${String(f.description ?? '').replace(/\s+/g, ' ').slice(0, 90)}`
               : `  @${p.handle}: NOT FOUND ${JSON.stringify(profiles.find(x => x.error) ?? '')}`);
}
out.profiles = profiles;

for (const p of PRODUCTS) {
  console.log(`\n=== ${p.name} (@${p.handle})`);

  // ---- Source 1: search anchored to the handle
  const query = queryFor(p.handle);
  const [searchRows, searchCost] = await metered(async () => {
    const s = await tool('social.x.posts', { query, sort: 'Latest', limit: 20, max_cost: '0.01' });
    if (!s.ok) { console.log('  search error:', JSON.stringify(s.error)); return []; }
    return label(p.name, (s.result?.tweets ?? []).map((t: any) => slim(t)));
  });
  printSource('search', searchRows, searchCost);

  // ---- Source 2: replies under the account's most recent posts
  let roots: Post[] = [];
  const [replyRows, replyCost] = await metered(async () => {
    const own = await tool('social.x.posts', { handle: p.handle, limit: 20, max_cost: '0.01' });
    if (!own.ok) { console.log('  handle read error:', JSON.stringify(own.error)); return []; }
    // their own original posts only: not replies, not retweets
    roots = (own.result?.tweets ?? [])
      .filter((t: any) => !t.in_reply_to_status_id_str && !t.retweeted_status && String(t.user?.screen_name ?? '').toLowerCase() === p.handle.toLowerCase())
      .slice(0, RECENT_POSTS).map((t: any) => slim(t));
    const seen = new Set<string>(); const replies: Post[] = [];
    for (const root of roots) {
      const c = await tool('social.x.posts', { conversation_id: root.id, limit: 20, max_cost: '0.01' });
      if (!c.ok) { console.log(`  thread ${root.id} error:`, JSON.stringify(c.error)); continue; }
      for (const t of c.result?.tweets ?? []) {
        const r = slim(t, root.text);
        if (r.id === root.id || r.handle.toLowerCase() === p.handle.toLowerCase() || seen.has(r.id)) continue;   // skip the post itself and the account's own replies
        seen.add(r.id); replies.push(r);
      }
    }
    return label(p.name, replies);
  });
  console.log(`\n  their ${roots.length} most recent posts:`);
  for (const r of roots) console.log(`     ${r.id} · ${r.created} · ${r.text.slice(0, 90)}`);
  printSource('replies under their posts', replyRows, replyCost);

  out.products[p.name] = { handle: p.handle, search: { query, cost: searchCost, posts: searchRows }, replies: { roots, cost: replyCost, posts: replyRows } };
  table.push({ product: p.name, search: tot(searchRows, searchCost), replies: tot(replyRows, replyCost) });
}

await sleep(2000);
const runEnd = await gatewayBalance('prep');
const runCost = runStart && runEnd ? +(runEnd.used - runStart.used).toFixed(6) : null;
out.cost = { total_used_delta: runCost };

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
mkdirSync('data/search-samples', { recursive: true });
const file = `data/search-samples/${stamp}-handles.json`;
writeFileSync(file, JSON.stringify(out, null, 2));

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
console.log('\n=== SUMMARY: real complaints specific enough to ask about, by source');
console.log('  product    search (posts, real, specific, %, CREDIT)      replies under their posts (same)');
for (const r of table) {
  const f = (t: Tot) => `${String(t.n).padStart(2)} posts · ${t.real} real · ${t.specific} specific · ${String(pct(t.specific, t.n)).padStart(2)}% · ${t.cost.toFixed(4)}`;
  console.log(`  ${r.product.padEnd(9)}  ${f(r.search)}     ${f(r.replies)}`);
}
const sum = (k: 'search' | 'replies') => table.reduce((a, r) => ({ n: a.n + r[k].n, specific: a.specific + r[k].specific, cost: a.cost + r[k].cost }), { n: 0, specific: 0, cost: 0 });
const S = sum('search'), R = sum('replies');
console.log(`  all        search: ${S.specific} of ${S.n} usable (${pct(S.specific, S.n)}%), ${S.cost.toFixed(4)} CREDIT     replies: ${R.specific} of ${R.n} usable (${pct(R.specific, R.n)}%), ${R.cost.toFixed(4)} CREDIT`);
console.log(`  Labelled with ${LABEL_MODELS[0]} (fallback ${LABEL_MODELS[1]}). Whole run: ${runCost ?? '?'} CREDIT, including the handle check.`);
console.log(`  Raw results saved to ${file}. Nothing was posted.`);
