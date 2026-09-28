// Sweep trader-facing crypto projects on X for recurring, specific complaints. Read-only:
// posts nothing, replies to nobody.
//   1. Pick projects: DefiLlama 7-day fees (and DEX volume), trader-facing categories, X handle from
//      DefiLlama, verified with Orbio social.x.profile. Keep the 10 most-followed active handles.
//   2. Sweep each: handle-anchored complaint search over the last 7 days (up to 3 pages) and the
//      replies under its 5 most recent posts. Stops if spend passes the budget.
//   3. Label with a cheap model, keep real + own + specific complaints, group them into themes.
// Output: data/sweeps/<date>.json. Run: pnpm exec tsx scripts/sweep-projects.ts
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gatewayBalance } from '../src/money.js';
import { init, json } from '../src/llm.js';

const KEY = process.env.ORBIO_API_KEY;
if (!KEY) { console.error('ORBIO_API_KEY is not set in .env'); process.exit(1); }

const BUDGET = 1.5;                 // CREDIT, tools + labelling; the sweep stops before passing it
const POOL = 30;                    // candidate projects before the follower cut
const KEEP = 10;
const ACTIVE_DAYS = 14;             // "active" = the handle posted in the last two weeks
const SEARCH_PAGES = 3;
const RECENT_POSTS = 5;
const THIN = 3;                     // fewer kept complaints than this: too thin for a thread
const LABEL_MODELS = ['google/gemini-2.5-flash-lite', 'openai/gpt-5-nano'];
const BATCH = 25;

// Trader-facing DefiLlama categories. Pure infra (bridges, lending, stablecoins, chains) is left out.
const CATS = new Set(['Dexs', 'Derivatives', 'Launchpad', 'Trading App', 'Telegram Bot', 'DEX Aggregator', 'Interface', 'Wallets']);
const WORDS = '(slow OR broken OR failed OR stuck OR bug OR fees OR "doesn\'t work" OR worst OR scam OR support)';
const EXCLUDE = '-is:retweet -"use my" -"my code" -"ref" -"referral" -"% off" -"sign up" -giveaway lang:en';

const LABELS = ['real_complaint', 'joke_or_banter', 'fud_or_hate', 'airdrop_or_token_price', 'referral_or_promo', 'feature_request', 'support_request', 'other'] as const;
type Label = typeof LABELS[number];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const day = (d: Date) => d.toISOString().slice(0, 10);
const now = new Date();
const since = day(new Date(now.getTime() - 7 * 864e5));

// ---------- Spend guard: the key's real "used" counter since start
await init();
const start = await gatewayBalance('prep');
if (!start) { console.error('could not read the gateway balance'); process.exit(1); }
const spent = async () => { const b = await gatewayBalance('prep'); return b ? b.used - start.used : 0; };
class Budget extends Error {}
let toolCredit = 0;

async function tool(name: string, args: Record<string, unknown>, maxCost: string) {
  const sofar = await spent();
  if (sofar + Number(maxCost) > BUDGET) throw new Budget(`stopping: ${sofar.toFixed(4)} spent, the next call could pass ${BUDGET}`);
  const res = await fetch(`https://api.orbio.so/api/v1/tools/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...args, max_cost: maxCost }),
  });
  const j: any = await res.json().catch(() => null);
  toolCredit += Number(j?.cost?.credit ?? 0);
  if (res.status === 202) console.log(`  ${name}: 202 still running, not resubmitting`);
  return { ok: res.ok, status: res.status, error: j?.error, result: j?.result };
}

// X ids are bigger than JS numbers hold exactly: always read the *_str fields.
type Post = { id: string; handle: string; followers: number | null; created: string; text: string; source: 'search' | 'replies'; reply_to_brand_post?: string };
const slim = (t: any, source: Post['source']): Post => ({
  id: String(t.id_str), handle: t.user?.screen_name ?? '?', followers: t.user?.followers_count ?? null,
  created: t.tweet_created_at ?? '', text: String(t.full_text ?? t.text ?? '').replace(/\s+/g, ' ').trim(), source,
});
const link = (p: Post) => `https://x.com/${p.handle}/status/${p.id}`;

// ---------- Step 1: pick projects
console.log('=== 1. Picking projects from DefiLlama');
const getJson = async (u: string) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u} → HTTP ${r.status}`); return r.json() as Promise<any>; };
const [fees, dexs, protocols] = await Promise.all([
  getJson('https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true'),
  getJson('https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true'),
  getJson('https://api.llama.fi/protocols'),
]);
const meta = new Map<string, any>((protocols as any[]).map(p => [String(p.id), p]));
const cexHandles = new Set((protocols as any[]).filter(p => p.category === 'CEX' && p.twitter).map(p => String(p.twitter).toLowerCase()));
const volumeById = new Map<string, number>((dexs.protocols as any[]).map(p => [String(p.defillamaId), Number(p.total7d ?? 0)]));

// Several DefiLlama entries can share one X account (pump.fun, PumpSwap, its app): merge by handle.
type Proj = { handle: string; names: string[]; categories: string[]; fees7d: number; volume7d: number };
const byHandle = new Map<string, Proj>();
for (const p of fees.protocols as any[]) {
  if (!CATS.has(p.category) || !p.total7d) continue;
  const tw = meta.get(String(p.defillamaId))?.twitter;
  if (!tw || cexHandles.has(String(tw).toLowerCase())) continue;        // exchange accounts are not one product
  const k = String(tw).toLowerCase();
  const cur = byHandle.get(k) ?? { handle: String(tw), names: [], categories: [], fees7d: 0, volume7d: 0 };
  cur.names.push(p.displayName ?? p.name);
  if (!cur.categories.includes(p.category)) cur.categories.push(p.category);
  cur.fees7d += Number(p.total7d);
  cur.volume7d += volumeById.get(String(p.defillamaId)) ?? 0;
  byHandle.set(k, cur);
}
const all = [...byHandle.values()];
const topFees = [...all].sort((a, b) => b.fees7d - a.fees7d).slice(0, POOL);
const topVol = [...all].sort((a, b) => b.volume7d - a.volume7d).slice(0, 10);
const pool = [...new Map([...topFees, ...topVol].map(p => [p.handle.toLowerCase(), p])).values()];
console.log(`  ${all.length} trader-facing handles on DefiLlama; pool of ${pool.length} by 7d fees plus top DEX volume.`);

type Picked = Proj & { name: string; followers: number; verified: boolean; latest: string; recentOwn: Post[] };
const picked: Picked[] = [];
let stopped: string | null = null;
const out: any = { run_at: now.toISOString(), since, budget: BUDGET, label_models: LABEL_MODELS, projects: [] };

try {
  const prof = await tool('social.x.profile', { handles: pool.map(p => p.handle) }, '0.02');
  const profiles: any[] = prof.result?.profiles ?? [];
  const ranked = pool
    .map(p => ({ p, f: profiles.find(x => String(x.screen_name ?? '').toLowerCase() === p.handle.toLowerCase()) }))
    .filter(x => x.f && !x.f.error && !x.f.protected)
    .sort((a, b) => (b.f.followers_count ?? 0) - (a.f.followers_count ?? 0));

  // Walk down by followers; a handle read tells us if it's active, and gives the posts to read replies under.
  for (const { p, f } of ranked) {
    if (picked.length >= KEEP) break;
    const own = await tool('social.x.posts', { handle: f.screen_name, limit: 20 }, '0.01');
    const tweets: any[] = own.result?.tweets ?? [];
    const latest = tweets.map(t => t.tweet_created_at).filter(Boolean).sort().at(-1) ?? '';
    const active = latest && (now.getTime() - new Date(latest).getTime()) < ACTIVE_DAYS * 864e5;
    if (!active) { console.log(`  skip @${f.screen_name}: last post ${latest || 'unknown'}`); continue; }
    const recentOwn = tweets
      .filter(t => !t.in_reply_to_status_id_str && !t.retweeted_status && String(t.user?.screen_name ?? '').toLowerCase() === p.handle.toLowerCase())
      .slice(0, RECENT_POSTS).map(t => slim(t, 'replies'));
    picked.push({ ...p, handle: f.screen_name, name: p.names[0], followers: f.followers_count ?? 0, verified: !!f.verified, latest, recentOwn });
  }
  console.log('\n  project                       category              7d fees     7d volume   followers  last post');
  for (const p of picked) console.log(`  ${(p.name + ' @' + p.handle).slice(0, 29).padEnd(29)} ${p.categories.join('/').slice(0, 21).padEnd(21)} $${(p.fees7d / 1e6).toFixed(2).padStart(7)}M  $${(p.volume7d / 1e9).toFixed(2).padStart(6)}B  ${String(p.followers).padStart(9)}  ${p.latest.slice(0, 10)}`);

  // ---------- Step 2: sweep
  console.log(`\n=== 2. Sweeping (search since ${since}, replies under ${RECENT_POSTS} recent posts)`);
  for (const p of picked) {
    const posts = new Map<string, Post>();
    let cursor: string | undefined, pages = 0;
    const query = `(@${p.handle} OR to:${p.handle}) ${WORDS} ${EXCLUDE} since:${since}`;
    while (pages < SEARCH_PAGES) {
      const s = await tool('social.x.posts', { query, sort: 'Latest', limit: 20, ...(cursor ? { cursor } : {}) }, '0.01');
      pages++;
      if (!s.ok) { console.log(`  @${p.handle} search error:`, JSON.stringify(s.error)); break; }
      for (const t of s.result?.tweets ?? []) { const x = slim(t, 'search'); if (x.handle.toLowerCase() !== p.handle.toLowerCase()) posts.set(x.id, x); }
      cursor = s.result?.next_cursor;
      if (!cursor || !(s.result?.tweets ?? []).length) break;
    }
    for (const root of p.recentOwn) {
      const c = await tool('social.x.posts', { conversation_id: root.id, limit: 20 }, '0.01');
      if (!c.ok) { console.log(`  @${p.handle} thread ${root.id} error:`, JSON.stringify(c.error)); continue; }
      for (const t of c.result?.tweets ?? []) {
        const x = slim(t, 'replies');
        if (x.id === root.id || x.handle.toLowerCase() === p.handle.toLowerCase() || posts.has(x.id)) continue;
        posts.set(x.id, { ...x, reply_to_brand_post: root.text.slice(0, 160) });
      }
    }
    const list = [...posts.values()];
    console.log(`  @${p.handle}: ${list.filter(x => x.source === 'search').length} from search (${pages} pages), ${list.filter(x => x.source === 'replies').length} replies under ${p.recentOwn.length} posts  ·  spent so far ${(await spent()).toFixed(4)}`);
    out.projects.push({ name: p.name, handle: p.handle, categories: p.categories, fees7d: p.fees7d, volume7d: p.volume7d, followers: p.followers, query, posts: list });
  }
} catch (e) {
  if (!(e instanceof Budget)) throw e;
  stopped = e.message;
  console.log(`\n!!! ${stopped}. Labelling what was collected.`);
}

// ---------- Step 3: label, keep, group into themes
const SYS = `You sort X posts that mention or reply to a crypto product's account. For each post:
label, exactly one of:
- real_complaint: a person describing a problem they had with the product (broke, slow, failed, stuck, charged too much, support let them down)
- joke_or_banter: jokes, memes, irony, teasing, reply-guy banter
- fud_or_hate: insults, "scam" accusations or hate without a described problem
- airdrop_or_token_price: about airdrops, points, rewards, the token's price
- referral_or_promo: referral codes, discounts, shilling, marketing, PnL flexing
- feature_request: asks for something new
- support_request: asks the company for help with no described experience to talk about
- other: anything else
own_experience: "yes" if it happened to the poster, "no" if it's about someone else, "unclear" if you can't tell.
specific: true only for a real complaint that points at a concrete moment you could ask "what happened the last time?" about. Vague venting is false.
reason: one line, under 15 words.
Return JSON only: {"posts": [{"id": string, "label": string, "own_experience": string, "specific": boolean, "reason": string}]}, one entry for EVERY post, ids copied exactly.`;

type Verdict = { id: string; label: Label; own_experience: 'yes' | 'no' | 'unclear'; specific: boolean; reason: string };
async function labelAll(product: string, posts: Post[]) {
  const ask = async (batch: Post[]) => {
    const body = batch.map(p => `id: ${p.id}\n${p.reply_to_brand_post ? `(reply under the product's post: "${p.reply_to_brand_post}")\n` : ''}@${p.handle}: ${p.text}`).join('\n\n');
    const r = await json<{ posts: Verdict[] }>(SYS, `Product: ${product}\n\n${body}`, () => ({ posts: [] }), 'prep', { models: LABEL_MODELS });
    return (r.data.posts ?? []).filter(v => LABELS.includes(v.label));
  };
  const got = new Map<string, Verdict>();
  for (let i = 0; i < posts.length; i += BATCH) for (const v of await ask(posts.slice(i, i + BATCH))) got.set(String(v.id), v);
  const missing = posts.filter(p => !got.has(p.id));
  for (let i = 0; i < missing.length; i += BATCH) for (const v of await ask(missing.slice(i, i + BATCH))) got.set(String(v.id), v);
  return posts.map(p => ({ ...p, ...(got.get(p.id) ?? { label: 'other' as Label, own_experience: 'unclear' as const, specific: false, reason: 'UNLABELLED after one retry' }) }));
}

const THEME_SYS = `You group complaints about one crypto product into recurring themes.
Each complaint goes into exactly one theme. Name each theme in plain words, the way a user would put it (e.g. "fills worse than the quoted price"), under 8 words.
A complaint that fits nothing else goes into a theme called "other".
For each theme, pick the 2 or 3 posts that describe the problem most clearly and concretely as best_ids.
Return JSON only: {"themes": [{"name": string, "post_ids": [string], "best_ids": [string]}]}. Use the ids exactly as given.`;

console.log('\n=== 3. Labelling and themes');
for (const proj of out.projects) {
  const labelled = await labelAll(proj.name, proj.posts);
  proj.posts = labelled;
  proj.kept = labelled.filter(p => p.label === 'real_complaint' && p.own_experience === 'yes' && p.specific);
  proj.counts = Object.fromEntries(LABELS.map(l => [l, labelled.filter(p => p.label === l).length]));
  proj.unlabelled = labelled.filter(p => p.reason === 'UNLABELLED after one retry').length;
  proj.themes = [];
  if (proj.kept.length) {
    const byId = new Map<string, any>(proj.kept.map((p: any) => [p.id, p]));
    const r = await json<{ themes: { name: string; post_ids: string[]; best_ids: string[] }[] }>(THEME_SYS,
      `Product: ${proj.name}\n\n` + proj.kept.map((p: any) => `id: ${p.id}\n@${p.handle}: ${p.text}`).join('\n\n'),
      () => ({ themes: [{ name: 'ungrouped', post_ids: proj.kept.map((p: any) => p.id), best_ids: [] }] }), 'prep', { models: LABEL_MODELS });
    // Quotes come from our own copy of each post, so they are verbatim by construction.
    proj.themes = (r.data.themes ?? []).map(t => {
      const ids = (t.post_ids ?? []).map(String).filter(id => byId.has(id));
      const best = (t.best_ids ?? []).map(String).filter(id => ids.includes(id)).slice(0, 3);
      return { name: t.name, count: ids.length, post_ids: ids,
        quotes: (best.length ? best : ids.slice(0, 2)).map(id => { const p = byId.get(id); return { handle: p.handle, text: p.text, link: link(p), date: p.created.slice(0, 10) }; }) };
    }).filter(t => t.count).sort((a, b) => b.count - a.count);
  }
  proj.thin = proj.kept.length < THIN;
}

// ---------- Output
await sleep(3000);
const total = await spent();
out.cost = { tool_credit: +toolCredit.toFixed(6), total_used_delta: +total.toFixed(6), stopped };
const file = `data/sweeps/${now.toLocaleDateString('en-CA')}.json`;
mkdirSync('data/sweeps', { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 2));

console.log('\n=== Results per project');
for (const p of out.projects) {
  console.log(`\n@${p.handle} (${p.name}) · ${p.posts.length} posts scanned · ${p.kept.length} kept${p.thin ? '  ·  TOO THIN FOR A THREAD' : ''}`);
  console.log('   ' + LABELS.map(l => `${l} ${p.counts[l]}`).join(' · ') + (p.unlabelled ? ` · unlabelled ${p.unlabelled}` : ''));
  for (const t of p.themes) {
    console.log(`   ▸ ${t.name} (${t.count})`);
    for (const q of t.quotes) console.log(`       "${q.text.slice(0, 220)}"\n        @${q.handle} · ${q.date} · ${q.link}`);
  }
}

const usable = out.projects.filter((p: any) => !p.thin);
console.log(`\n=== SUMMARY
Swept ${out.projects.length} projects${stopped ? ` (stopped early: ${stopped})` : ''}: ${out.projects.reduce((a: number, p: any) => a + p.posts.length, 0)} posts scanned, ${out.projects.reduce((a: number, p: any) => a + p.kept.length, 0)} kept as real, own, specific complaints.
Enough for a thread (${THIN}+ kept): ${usable.length ? usable.map((p: any) => `@${p.handle} (${p.kept.length})`).join(', ') : 'none'}.
Too thin: ${out.projects.filter((p: any) => p.thin).map((p: any) => `@${p.handle} (${p.kept.length})`).join(', ') || 'none'}.
Cost: ${total.toFixed(4)} CREDIT in total (tools ${toolCredit.toFixed(4)}, the rest labelling and themes), budget ${BUDGET}.
Saved raw and filtered posts to ${file}. Nothing was posted.`);
