// Read-only sweep: fomo slippage, fills and execution on X, merged with the 12 fomo complaints we
// already kept on Sep 28. Posts nothing, replies to nobody.
//   1. Search the last 14 days: posts tagging @fomo, and posts saying fomo plus slippage words.
//   2. Read posts by @outputlayer and @atarashi about fomo or Relay, and the replies under them,
//      plus the replies under @_jasonmaier's post. Also fomo's own posts on the subject.
//   3. Label everything with a cheap model, re-check the kept ones with Sonnet (Sonnet's answer is final).
//   4. Collect every post that states a slippage number for fomo, with proof flags (image, link).
// Stops if total spend passes 1 CREDIT.
// Output: data/sweeps/2026-09-29-fomo-slippage.json and .md. Run: pnpm exec tsx scripts/sweep-fomo-slippage.ts
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gatewayBalance } from '../src/money.js';
import { init, json, MODEL } from '../src/llm.js';

const KEY = process.env.ORBIO_API_KEY;
if (!KEY) { console.error('ORBIO_API_KEY is not set in .env'); process.exit(1); }

const BUDGET = 1;                   // CREDIT, tools + models; stops before passing it
const SEARCH_PAGES = 5;
const THREAD_PAGES = 2;
const LABEL_MODELS = ['google/gemini-2.5-flash-lite', 'openai/gpt-5-nano'];
const BATCH = 20;
const PRIOR = 'data/sweeps/2026-09-28-fomo-phantom.json';
const OUT = 'data/sweeps/2026-09-29-fomo-slippage';
const JASON_POST = '2104705827890438291';
const WATCH = ['outputlayer', 'atarashi'];

const now = new Date();
const day = (d: Date) => d.toISOString().slice(0, 10);
const since = day(new Date(now.getTime() - 14 * 864e5));
const leakSince = '2026-09-12';     // the Relay leak window starts here
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const WORDS = '(slippage OR fill OR filled OR execution OR sandwich OR sandwiched OR MEV OR frontrun OR "front-run" OR "front run" OR "45%" OR "price impact" OR settings OR desktop OR mobile)';
const NOISE = '-is:retweet -"use my" -"my code" -"referral" -"% off" -"sign up" -giveaway';
const QUERIES = [
  { name: 'tags @fomo', q: `(@fomo OR to:fomo) ${WORDS} ${NOISE} since:${since}` },
  { name: 'says fomo', q: `fomo (slippage OR sandwich OR sandwiched OR MEV OR frontrun OR "front-run" OR "45%" OR "price impact" OR "filled at") ${NOISE} since:${since}` },
  { name: 'fomo account', q: `from:fomo (slippage OR fill OR execution OR mobile OR desktop OR relay OR sandwich OR MEV OR settings) since:${since}` },
  ...WATCH.map(h => ({ name: `@${h} on fomo/Relay`, q: `from:${h} (fomo OR relay OR RelayProtocol OR sandwich OR sandwiched) since:${leakSince}` })),
];

// ---------- Spend guard: the key's real "used" counter since start
await init();
const start = await gatewayBalance('prep');
if (!start) { console.error('could not read the gateway balance'); process.exit(1); }
const spent = async () => { const b = await gatewayBalance('prep'); return b ? b.used - start.used : 0; };
class Budget extends Error {}
const guard = async (next: number) => { const s = await spent(); if (s + next > BUDGET) throw new Budget(`stopping: ${s.toFixed(4)} spent, the next call could pass ${BUDGET}`); };
let toolCredit = 0;

async function tool(name: string, args: Record<string, unknown>, maxCost: string) {
  await guard(Number(maxCost));
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
type Post = {
  id: string; handle: string; followers: number | null; created: string; text: string; source: string;
  in_reply_to: string | null; conversation: string | null; bio: string; media: string[]; urls: string[]; quoted: string | null;
};
const mediaOf = (t: any): string[] => [...(t.extended_entities?.media ?? t.entities?.media ?? t.media ?? [])].map((m: any) => m.type ?? 'media');
const urlsOf = (t: any): string[] => (t.entities?.urls ?? []).map((u: any) => u.expanded_url ?? u.url).filter(Boolean);
const slim = (t: any, source: string): Post => ({
  id: String(t.id_str), handle: t.user?.screen_name ?? '?', followers: t.user?.followers_count ?? null,
  created: t.tweet_created_at ?? '', text: String(t.full_text ?? t.text ?? '').replace(/\s+/g, ' ').trim(), source,
  in_reply_to: t.in_reply_to_status_id_str ?? null, conversation: t.conversation_id_str ?? null,
  bio: String(t.user?.description ?? '').replace(/\s+/g, ' ').trim(), media: mediaOf(t), urls: urlsOf(t),
  quoted: t.quoted_status ? String(t.quoted_status.full_text ?? t.quoted_status.text ?? '').replace(/\s+/g, ' ').trim() : null,
});
const link = (p: { handle: string; id: string }) => `https://x.com/${p.handle}/status/${p.id}`;

const posts = new Map<string, Post>();
const add = (p: Post) => { const cur = posts.get(p.id); posts.set(p.id, cur ? { ...cur, source: cur.source.includes(p.source) ? cur.source : `${cur.source}, ${p.source}` } : p); };
const log: string[] = [];
let stopped: string | null = null;
let fieldsShown = false;

async function search(name: string, q: string) {
  let cursor: string | undefined, pages = 0, n = 0;
  while (pages < SEARCH_PAGES) {
    const s = await tool('social.x.posts', { query: q, sort: 'Latest', limit: 20, ...(cursor ? { cursor } : {}) }, '0.01');
    pages++;
    if (!s.ok) { console.log(`  ${name} search error:`, JSON.stringify(s.error)); break; }
    const tw: any[] = s.result?.tweets ?? [];
    if (tw[0] && !fieldsShown) { console.log('  fields on a tweet:', Object.keys(tw[0]).join(', ')); fieldsShown = true; }
    for (const t of tw) { add(slim(t, `search: ${name}`)); n++; }
    cursor = s.result?.next_cursor;
    if (!cursor || !tw.length) break;
  }
  const line = `${name}: ${n} posts, ${pages} pages`;
  log.push(line); console.log(`  ${line}  ·  spent ${(await spent()).toFixed(4)}`);
}

async function thread(root: string, label: string) {
  let cursor: string | undefined, pages = 0, n = 0;
  while (pages < THREAD_PAGES) {
    const c = await tool('social.x.posts', { conversation_id: root, limit: 20, ...(cursor ? { cursor } : {}) }, '0.01');
    pages++;
    if (!c.ok) { console.log(`  thread ${root} error:`, JSON.stringify(c.error)); break; }
    const tw: any[] = c.result?.tweets ?? [];
    for (const t of tw) { add(slim(t, `replies: ${label}`)); n++; }
    cursor = c.result?.next_cursor;
    if (!cursor || !tw.length) break;
  }
  const line = `replies under ${label} (${root}): ${n} posts, ${pages} pages`;
  log.push(line); console.log(`  ${line}  ·  spent ${(await spent()).toFixed(4)}`);
}

// ---------- 1 + 2: collect
console.log(`=== Collecting (since ${since}; @outputlayer/@atarashi since ${leakSince})`);
try {
  for (const { name, q } of QUERIES) await search(name, q);
  // Their recent posts too, in case search misses one; keep only fomo/Relay ones.
  for (const h of WATCH) {
    const r = await tool('social.x.posts', { handle: h, limit: 40 }, '0.02');
    const hits = (r.result?.tweets ?? []).map((t: any) => slim(t, `@${h} timeline`)).filter((p: Post) => /fomo|relay|sandwich/i.test(p.text + ' ' + (p.quoted ?? '')));
    hits.forEach(add);
    log.push(`@${h} timeline: ${hits.length} posts about fomo/Relay`);
  }
  // Replies under the watched accounts' fomo/Relay posts (top-level posts only), and under Jason's post.
  const roots = [...posts.values()].filter(p => WATCH.includes(p.handle.toLowerCase()) && !p.in_reply_to);
  for (const r of roots) await thread(r.id, `@${r.handle}`);
  await thread(JASON_POST, '@_jasonmaier');
} catch (e) {
  if (!(e instanceof Budget)) throw e;
  stopped = e.message; console.log(`\n!!! ${stopped}. Labelling what was collected.`);
}

// ---------- Merge the 12 kept on Sep 28 (not re-searched, only re-labelled on the new fields)
const prior = JSON.parse(readFileSync(PRIOR, 'utf8')).projects.find((p: any) => p.handle.toLowerCase() === 'fomo');
const priorKept = (prior?.checked ?? []).filter((c: any) => c.keep);
let priorNew = 0;
for (const c of priorKept) {
  if (posts.has(c.id)) { add({ ...posts.get(c.id)!, source: 'Sep 28 sweep' }); continue; }
  priorNew++;
  add({ id: c.id, handle: c.handle, followers: c.followers ?? null, created: c.created, text: c.text, source: 'Sep 28 sweep',
    in_reply_to: null, conversation: null, bio: '', media: [], urls: [], quoted: null });
}
log.push(`Sep 28 sweep: ${priorKept.length} kept fomo complaints merged (${priorKept.length - priorNew} also came back in this sweep)`);
const all = [...posts.values()];
console.log(`  ${all.length} unique posts in total`);

// ---------- 3: label
const TOPICS = ['slippage_setting', 'bad_fill', 'sandwich_mev', 'fees', 'other'] as const;
type Topic = typeof TOPICS[number];
type Verdict = {
  id: string; about: 'fomo' | 'relay' | 'both' | 'unrelated'; topic: Topic; own_experience: 'yes' | 'no'; has_numbers: 'yes' | 'no'; numbers: string;
  mentions_mobile_vs_desktop: 'yes' | 'no'; slippage_number: string; team_explanation: 'yes' | 'no'; reason: string;
};
const SYS = `You label X posts for a research sweep on fomo (@fomo), a mobile-first crypto trading app that routes trades through Relay (@RelayProtocol). Relay had an API leak (Sep 12-26) that let bots sandwich trades. For each post:
- about: "fomo" if it's about the fomo app, "relay" if about Relay or the leak/sandwich bots without naming fomo, "both", or "unrelated" (fomo meaning fear of missing out, other apps, spam, promo).
- topic, exactly one: slippage_setting (what slippage is set to, whether you can change it, where the setting is) | bad_fill (got a worse price than shown or expected) | sandwich_mev (sandwiched, MEV, front-run, bots, the Relay leak) | fees | other
- own_experience: "yes" only if the poster says it happened to them.
- has_numbers: "yes" if it gives an entry or fill price, a % or a $ amount about a trade or a setting.
- numbers: those numbers as written in the post, short; "" if none.
- mentions_mobile_vs_desktop: "yes" if it mentions a difference between the mobile app and desktop/web, or a setting missing on one of them.
- slippage_number: a slippage % the post says fomo uses, defaults to or allows (e.g. "45%"); "" if none.
- team_explanation: "yes" only if the post is by fomo or someone on its team (see the bio) explaining slippage, fills, execution, the mobile limit or the Relay issue.
- reason: one line, under 15 words.
Return JSON only: {"posts": [{"id": string, "about": string, "topic": string, "own_experience": string, "has_numbers": string, "numbers": string, "mentions_mobile_vs_desktop": string, "slippage_number": string, "team_explanation": string, "reason": string}]}, one entry for EVERY post, ids copied exactly.`;

const fmt = (p: Post) => [`id: ${p.id}`, `@${p.handle}${p.bio ? ` (bio: ${p.bio.slice(0, 120)})` : ''}: ${p.text}`, p.quoted ? `(quoting: ${p.quoted.slice(0, 280)})` : null].filter(Boolean).join('\n');
const ok = (v: any) => v && TOPICS.includes(v.topic);

async function labelAll(list: Post[], models?: string[], batch = BATCH) {
  const ask = async (b: Post[]) => {
    await guard(models ? 0.02 : 0.08);
    const r = await json<{ posts: Verdict[] }>(SYS, b.map(fmt).join('\n\n'), () => ({ posts: [] }), 'prep', models ? { models } : {});
    return (r.data.posts ?? []).filter(ok);
  };
  const got = new Map<string, Verdict>();
  for (let i = 0; i < list.length; i += batch) for (const v of await ask(list.slice(i, i + batch))) got.set(String(v.id), v);
  const missing = list.filter(p => !got.has(p.id));
  for (let i = 0; i < missing.length; i += batch) for (const v of await ask(missing.slice(i, i + batch))) got.set(String(v.id), v);
  return got;
}

// The 45% check is done in code, so the quote is verbatim by construction.
const FORTY5 = /\b45\s*(%|percent|pct)/i;
const quote45 = (p: Post) => { const s = [p.text, p.quoted ?? ''].join(' '); const m = s.split(/(?<=[.!?])\s+/).find(x => FORTY5.test(x)); return m ?? null; };
const SLIP_NUM = /slippage[^.!?]{0,60}?\d+(\.\d+)?\s*%|\d+(\.\d+)?\s*%[^.!?]{0,40}?slippage/i;

const final = new Map<string, Verdict & { checked_by: string }>();
let cheapCount = 0, recheckCount = 0;
try {
  console.log(`\n=== Labelling ${all.length} posts (${LABEL_MODELS[0]})`);
  const cheap = await labelAll(all, LABEL_MODELS);
  cheapCount = cheap.size;
  for (const [id, v] of cheap) final.set(id, { ...v, checked_by: LABEL_MODELS[0] });
  const kept = all.filter(p => { const v = cheap.get(p.id); if (!v) return false;
    return (v.about !== 'unrelated' && (v.topic !== 'other' || !!v.slippage_number || v.team_explanation === 'yes')) || FORTY5.test(p.text) || p.source.includes('Sep 28'); });
  console.log(`  kept ${kept.length} for the Sonnet re-check`);
  const sonnet = await labelAll(kept, undefined, 10);
  recheckCount = sonnet.size;
  for (const [id, v] of sonnet) final.set(id, { ...v, checked_by: MODEL });
} catch (e) {
  if (!(e instanceof Budget)) throw e;
  stopped = stopped ?? e.message; console.log(`\n!!! ${e.message}`);
}

type Row = Post & Partial<Verdict> & { link: string; mentions_45_percent: 'yes' | 'no'; quote_45: string | null; kept: boolean; checked_by?: string };
const rows: Row[] = all.map(p => {
  const v = final.get(p.id);
  const q = quote45(p);
  return { ...p, ...(v ?? {}), link: link(p), mentions_45_percent: q ? 'yes' : 'no', quote_45: q,
    kept: !!v && v.checked_by === MODEL && v.about !== 'unrelated' && (v.topic !== 'other' || !!v.slippage_number || v.team_explanation === 'yes' || !!q) };
});
const kept = rows.filter(r => r.kept);

// ---------- 4: slippage numbers, 45%, team, most specific
const slipRows = rows.filter(r => r.about !== 'unrelated' && (r.slippage_number || SLIP_NUM.test(r.text) || r.quote_45))
  .sort((a, b) => a.created.localeCompare(b.created));
const team = rows.filter(r => r.handle.toLowerCase() === 'fomo' || (r.team_explanation === 'yes' && r.checked_by === MODEL));
const counts = Object.fromEntries(TOPICS.map(t => [t, kept.filter(r => r.topic === t).length]));

let specific: Row[] = [];
const own = kept.filter(r => r.own_experience === 'yes');
if (own.length) {
  try {
    await guard(0.05);
    const r = await json<{ ids: string[] }>(
      `From these X posts about the fomo app, pick the 5 to 8 that describe the poster's own trade most specifically: concrete numbers (entry, fill, %, $), what they did, what happened. Rank most specific first. Return JSON only: {"ids": [string]}, ids copied exactly.`,
      own.map(fmt).join('\n\n'), () => ({ ids: [] }), 'prep');
    const byId = new Map(own.map(o => [o.id, o]));
    specific = (r.data.ids ?? []).map(String).filter(id => byId.has(id)).slice(0, 8).map(id => byId.get(id)!);
  } catch (e) { if (!(e instanceof Budget)) throw e; stopped = stopped ?? e.message; }
}

// ---------- Output
await sleep(3000);
const total = await spent();
const out = {
  run_at: now.toISOString(), since, leak_since: leakSince, budget: BUDGET, label_models: LABEL_MODELS, recheck_model: MODEL,
  queries: QUERIES, collected: log, stopped, counts_kept_by_topic: counts,
  totals: { unique_posts: rows.length, cheap_labelled: cheapCount, sonnet_rechecked: recheckCount, kept: kept.length, own_experience_kept: own.length },
  most_specific_ids: specific.map(s => s.id), slippage_number_posts: slipRows.map(r => r.id), team_posts: team.map(r => r.id),
  cost: { tool_credit: +toolCredit.toFixed(6), total_used_delta: +total.toFixed(6) },
  posts: rows,
};
mkdirSync('data/sweeps', { recursive: true });
writeFileSync(`${OUT}.json`, JSON.stringify(out, null, 2));

const proof = (r: Row) => [r.media.length ? `image/video attached (${r.media.join(', ')})` : null, r.urls.length ? `links: ${r.urls.join(' ')}` : null].filter(Boolean).join('; ') || 'no image or link';
const md: string[] = [
  `# fomo slippage sweep, ${day(now)}`, '',
  `Read-only. Search window ${since} to ${day(now)}; @outputlayer and @atarashi from ${leakSince}. Nothing was posted.`, '',
  '## What was read', '', ...log.map(l => `- ${l}`),
  `- ${rows.length} unique posts; ${cheapCount} labelled by ${LABEL_MODELS[0]}, ${recheckCount} re-checked by ${MODEL}; ${kept.length} kept after the re-check.`,
  stopped ? `- Stopped early: ${stopped}` : '', '',
  '## Kept posts by topic', '', ...TOPICS.map(t => `- ${t}: ${counts[t]}`),
  `- own experience: ${own.length} · with numbers: ${kept.filter(r => r.has_numbers === 'yes').length} · mobile vs desktop: ${kept.filter(r => r.mentions_mobile_vs_desktop === 'yes').length} · mention 45%: ${kept.filter(r => r.mentions_45_percent === 'yes').length}`, '',
  '## Most specific own-experience posts', '',
  ...specific.flatMap(r => [`- "${r.text}"`, `  @${r.handle} · ${r.created.slice(0, 10)} · ${r.link}`, `  topic: ${r.topic} · numbers: ${r.numbers || 'none'}${r.mentions_mobile_vs_desktop === 'yes' ? ' · mentions mobile vs desktop' : ''}`, '']),
  specific.length ? '' : '- none', '',
  '## Every post stating a slippage number for fomo (oldest first)', '',
  ...slipRows.flatMap(r => [`- ${r.created.slice(0, 10)} · @${r.handle} · ${r.link}`, `  number: ${r.slippage_number || '(regex match)'}${r.quote_45 ? ` · 45% quote: "${r.quote_45}"` : ''}`, `  "${r.text}"${r.quoted ? `\n  quoting: "${r.quoted}"` : ''}`, `  proof: ${proof(r)}`, '']),
  slipRows.length ? '' : '- none', '',
  '## fomo team replies or explanations', '',
  ...team.flatMap(r => [`- @${r.handle} · ${r.created.slice(0, 10)} · ${r.link}${r.bio ? `\n  bio: ${r.bio}` : ''}`, `  "${r.text}"`, '']),
  team.length ? '' : '- none found', '',
  '## Cost', '', `- ${total.toFixed(4)} CREDIT in total (tools ${toolCredit.toFixed(4)}, the rest labelling and re-check), budget ${BUDGET}.`, '',
];
writeFileSync(`${OUT}.md`, md.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'));

console.log(`\n=== SUMMARY
${rows.length} unique posts read, ${kept.length} kept after the Sonnet re-check (${own.length} own experience).
By topic: ${TOPICS.map(t => `${t} ${counts[t]}`).join(', ')}.
${slipRows.length} posts state a slippage number for fomo; ${rows.filter(r => r.mentions_45_percent === 'yes').length} mention 45%.
${team.length} posts from fomo or its team on the subject.
Cost: ${total.toFixed(4)} CREDIT (tools ${toolCredit.toFixed(4)}), budget ${BUDGET}.${stopped ? ` Stopped early: ${stopped}` : ''}
Saved to ${OUT}.json and ${OUT}.md. Nothing was posted.`);
