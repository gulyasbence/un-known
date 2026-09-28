// Read-only probe of Orbio's X tools, for the X agent. Posts nothing.
// Tests: real balance change per call, search quality, conversation_id depth,
// mentions of @un_known_tool, profiles, narrow vs full-page cost.
// Run: pnpm exec tsx scripts/test-orbio-read.ts
import 'dotenv/config';
import { gatewayBalance } from '../src/money.js';

const KEY = process.env.ORBIO_API_KEY;
if (!KEY) { console.error('ORBIO_API_KEY is not set in .env'); process.exit(1); }

const BASE = (process.env.ORBIO_BASE_URL || 'https://api.orbio.so/api/v1') + '/tools';
const ACCOUNT = 'un_known_tool';
const TEST_TWEET = '2104662314729279982';          // the "hello. testing." post
const SEARCH = 'fomo (slow OR broken OR execution OR fees) -is:retweet';
const READ_CAP = '0.03';                           // a full page of 100 is 0.022
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Row = { test: string; charged: string; costStatus: string; usedDelta: number | null; availDelta: number | null; httpStatus: number };
const ledger: Row[] = [];

// One tool call, with the key's balance read before and after.
async function tool(test: string, name: string, args: Record<string, unknown>) {
  const before = await gatewayBalance('prep');
  const res = await fetch(`${BASE}/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch {}
  await sleep(3000);                               // cost can report "settling"; give it a moment
  const after = await gatewayBalance('prep');
  const usedDelta = before && after ? +(after.used - before.used).toFixed(6) : null;
  const availDelta = before && after ? +(after.available - before.available).toFixed(6) : null;
  const row: Row = { test, charged: json?.cost?.credit ?? '-', costStatus: json?.cost?.status ?? 'final', usedDelta, availDelta, httpStatus: res.status };
  ledger.push(row);
  console.log(`\n=== ${test}  (${name}, HTTP ${res.status})`);
  console.log(`  balance before ${before?.available ?? '?'}  after ${after?.available ?? '?'}  |  cost.credit ${row.charged}${json?.cost?.status ? ` (${json.cost.status})` : ''}  |  used went up by ${usedDelta ?? '?'}`);
  if (res.status === 202) console.log('  202 running: not resubmitting.');
  if (!res.ok) console.log('  error:', json?.error ?? text.slice(0, 400));
  return { ok: res.ok, status: res.status, json };
}

// The tweet shape isn't documented, so read fields by several likely names.
const pick = (o: any, ...names: string[]) => { for (const n of names) { const v = n.split('.').reduce((a, k) => a?.[k], o); if (v != null) return v; } return undefined; };
// X ids are bigger than JS numbers hold exactly: always read the *_str fields.
const tid = (t: any) => String(pick(t, 'id_str', 'tweet_id') ?? '');
const author = (t: any) => pick(t, 'author.userName', 'author.username', 'author.handle', 'user.screen_name', 'username', 'author_handle') ?? '?';
const when = (t: any) => pick(t, 'tweet_created_at', 'created_at') ?? '?';
const replies = (t: any) => Number(pick(t, 'replyCount', 'reply_count', 'public_metrics.reply_count', 'metrics.replies') ?? 0);
const inReplyTo = (t: any) => pick(t, 'in_reply_to_status_id_str');
const oneLine = (t: any) => String(pick(t, 'text', 'full_text') ?? '').replace(/\s+/g, ' ').slice(0, 140);
const tweets = (j: any): any[] => j?.result?.tweets ?? [];
const printTweets = (list: any[], n = 20) => list.slice(0, n).forEach((t, i) =>
  console.log(`  ${String(i + 1).padStart(2)}. @${author(t)} · ${when(t)} · ${replies(t)} replies · ${tid(t)}\n      ${oneLine(t)}`));

// ---------- Test 2: search quality
const search = await tool('2. search', 'social.x.posts', { query: SEARCH, sort: 'Latest', limit: 20, max_cost: READ_CAP });
const found = tweets(search.json);
console.log(`  query run: ${search.json?.result?.query ?? '?'}  |  ${found.length} posts  |  next_cursor: ${search.json?.result?.next_cursor ? 'yes' : 'no'}`);
if (found[0]) console.log('  fields on a tweet:', Object.keys(found[0]).join(', '));
printTweets(found);

// ---------- Test 3: conversation_id depth (use the most-replied post from the search)
const busiest = [...found].sort((a, b) => replies(b) - replies(a))[0];
let convSummary = 'skipped: no post with replies in the search';
if (busiest && replies(busiest) > 0) {
  const root = String(pick(busiest, 'conversation_id_str') ?? tid(busiest));
  const conv = await tool('3. conversation page 1', 'social.x.posts', { conversation_id: root, limit: 20, max_cost: READ_CAP });
  const page1 = tweets(conv.json);
  const nested = page1.filter(t => inReplyTo(t) && String(inReplyTo(t)) !== root);
  console.log(`  root ${root} (@${author(busiest)}, ${replies(busiest)} replies claimed)  |  page 1 returned ${page1.length}  |  replies to replies: ${nested.length}  |  next_cursor: ${conv.json?.result?.next_cursor ? 'yes' : 'no'}`);
  printTweets(page1, 8);
  let depth = `page 1: ${page1.length}`;
  const cursor = conv.json?.result?.next_cursor;
  if (cursor) {
    const conv2 = await tool('3. conversation page 2', 'social.x.posts', { conversation_id: root, limit: 20, cursor, max_cost: READ_CAP });
    depth += `, page 2: ${tweets(conv2.json).length}`;
  }
  convSummary = `${depth} of ${replies(busiest)} claimed; ${nested.length ? `${nested.length} nested replies came back` : 'only direct replies came back'}`;
}

// ---------- Test 4: mentions of the agent account
const ment = await tool('4. mentions', 'social.x.posts', { mentions_of: ACCOUNT, limit: 20, max_cost: READ_CAP });
const mentions = tweets(ment.json);
const onTestTweet = mentions.filter(t => String(inReplyTo(t)) === TEST_TWEET);
console.log(`  ${mentions.length} mentions of @${ACCOUNT}  |  replies to the test tweet: ${onTestTweet.length}`);
printTweets(mentions, 10);

// ---------- Test 5: profiles for up to 3 authors from the search
const handles = [...new Set(found.map(author).filter((h: string) => h && h !== '?'))].slice(0, 3) as string[];
let profSummary = 'skipped: no handles from the search';
if (handles.length) {
  const prof = await tool('5. profiles', 'social.x.profile', { handles, max_cost: '0.01' });
  const profiles: any[] = prof.json?.result?.profiles ?? [];
  if (profiles[0]) console.log('  fields on a profile:', Object.keys(profiles[0]).join(', '));
  for (const p of profiles) console.log(`  @${pick(p, 'screen_name') ?? '?'} · ${pick(p, 'followers', 'followers_count') ?? '?'} followers · joined ${pick(p, 'created_at') ?? '?'} · verified ${pick(p, 'verified') ?? '?'}\n      ${String(pick(p, 'description', 'bio') ?? '').replace(/\s+/g, ' ').slice(0, 120)}`);
  profSummary = `${profiles.length} of ${handles.length} profiles returned`;
}

// ---------- Test 6: narrow search vs a small limit on a broad search
const narrow = await tool('6a. narrow search (from the agent)', 'social.x.posts', { query: `from:${ACCOUNT}`, limit: 5, max_cost: READ_CAP });
console.log(`  returned ${tweets(narrow.json).length} posts`);
const broad = await tool('6b. broad search, limit 5', 'social.x.posts', { query: SEARCH, sort: 'Latest', limit: 5, max_cost: READ_CAP });
console.log(`  returned ${tweets(broad.json).length} posts`);

// ---------- Test 1 + summary
console.log('\n=== Ledger (test 1: reported cost vs real balance change)');
for (const r of ledger) console.log(`  ${r.test.padEnd(36)} HTTP ${r.httpStatus}  cost.credit ${String(r.charged).padEnd(8)} ${r.costStatus.padEnd(8)} used +${r.usedDelta ?? '?'}  available ${r.availDelta ?? '?'}`);
const reported = ledger.reduce((a, r) => a + (Number(r.charged) || 0), 0);
const real = ledger.reduce((a, r) => a + (r.usedDelta ?? 0), 0);
const matches = ledger.every(r => r.usedDelta == null || r.charged === '-' || Math.abs(Number(r.charged) - r.usedDelta) < 0.0001);

console.log(`
=== SUMMARY
Cost: ${ledger.length} calls reported ${reported.toFixed(4)} CREDIT; the key's "used" rose ${real.toFixed(4)}. ${matches ? 'Each call matched its reported cost.' : 'Some calls did not match their reported cost (see the ledger; one may still have been settling).'}
Search: ${found.length} posts for "${SEARCH}". Read the list above to judge whether they are real, recent complaints.
Replies under a post: ${convSummary}.
Mentions: ${mentions.length} found for @${ACCOUNT}; ${onTestTweet.length} are replies to the test tweet.
Profiles: ${profSummary}.
Page billing: a search matching few posts cost ${ledger.find(r => r.test.startsWith('6a'))?.charged ?? '?'}, a broad search at limit 5 cost ${ledger.find(r => r.test.startsWith('6b'))?.charged ?? '?'}.
Nothing was posted.`);
