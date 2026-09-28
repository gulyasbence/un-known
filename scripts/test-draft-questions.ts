// Would the agent reply, and what would it ask? Posts nothing, replies to nobody.
// Input: the real, specific complaints from one search-quality sample. For each post,
// Sonnet 5 first checks whether it's the poster's own experience, then decides reply or skip
// and drafts the one question. One reply per conversation. Compared against Bence's own calls
// (never sent to the model) and against the previous run's drafts.
// v1 (commit fe0b940) wrote data/draft-tests/2026-09-28.json; this version writes -v2.
// Run: pnpm exec tsx scripts/test-draft-questions.ts
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gatewayBalance } from '../src/money.js';
import { init, json, MODEL } from '../src/llm.js';

const KEY = process.env.ORBIO_API_KEY;
if (!KEY) { console.error('ORBIO_API_KEY is not set in .env'); process.exit(1); }

const SAMPLE = 'data/search-samples/2026-09-28-20-52-handles.json';
const PREVIOUS = 'data/draft-tests/2026-09-28.json';
const OUT = 'data/draft-tests/2026-09-28-v2.json';
const MAX_AGE_HOURS = 48;
const MAX_CHARS = 200;

// Bence's calls, keyed by handle. Never sent to the model.
const HUMAN: Record<string, 'reply' | 'maybe' | 'skip'> = {
  va1ag: 'reply', Donaxbt: 'reply', mxxivist: 'reply', CryptoInducer: 'reply', AthreeFams: 'reply',
  OfficialTrollX: 'maybe', yourgamerva: 'maybe', Hoshi3dFX: 'maybe',
  broitsravi: 'skip', '66CORE66': 'skip', gafarWeb3: 'skip', LSS0L: 'skip', PictureDays: 'skip',
  HackerKritik: 'skip', '2ctv': 'skip', StitchHQ: 'skip', G3ngarX: 'skip', pminusq: 'skip',
};

const SKIP_REASONS = ['not_their_experience', 'too_vague', 'feature_request', 'support_request', 'too_old', 'joke_or_quip', 'security_or_legal', 'non_english', 'hostile_tone', 'other'] as const;
type Draft = { own_experience: 'yes' | 'no' | 'unclear'; decision: 'reply' | 'skip'; skip_reason: string | null; question: string | null; moment: string | null; confidence: number; why: string };

const SYS = `You are an interviewer agent on X. You read one public post where someone complains about a crypto product, and decide whether to reply with a single question that gets them to tell you what they did.

Step 1, before anything else: own_experience. Is the poster describing something that happened to them?
- "yes": it happened to them.
- "no": it's about someone else's problem, commentary on others, or a reaction to someone else's post.
- "unclear": you can't tell.
If "no" or "unclear": decision = "skip", skip_reason = "not_their_experience", and stop there.
If the person says they tried to fix it themselves and it still happens ("turned it off and still getting them"), that is their own experience, not a support request.

Step 2: reply only when you can ask about a specific, recent moment in their own experience.
Ask about what they did or decided in that moment, not facts about it. Not what they were trading, not whose it was, not app vs website.
Bad: "what were you trading last time the fill came in 10% above real price?"
Good: "when a fill came in 10% off, did you keep trading or change something?"
Bad: "what were you trading when you first noticed the fees jump 10x?"
Good: "what was the moment you decided to stop using it?"
Bad: "what was the last perp noti you got from someone you don't follow, whose was it?"
Good: "when one of those comes in, what do you do with it?"

The question:
- one question, under ${MAX_CHARS} characters
- plain, casual English, the way a curious person would ask
- no pitch, no links, no mention of research, interviews, surveys or payment
- no "sorry to hear", no sympathy phrases, no emojis

Skip, with the matching reason, when the post is:
- too_old: older than ${MAX_AGE_HOURS} hours at the time of reading
- feature_request: asks for something new rather than describing a problem that happened
- support_request: they want help or a fix from the company, not a conversation (but see the tried-to-fix-it rule above)
- joke_or_quip: a joke, meme, one-liner or banter
- security_or_legal: vulnerability disclosures, hacks, lawsuits, anything legal
- non_english: not in English
- hostile_tone: abusive, slur-heavy or threatening
- too_vague: there is no concrete moment to ask about. Being vague is a skip, not a guess.
- other: anything else, say what in "why"

Confidence: 1 (coin flip) to 5 (clearly right).
"why": one line, under 15 words, on why this post is or isn't worth replying to.

Return JSON only:
{"own_experience": "yes" | "no" | "unclear", "decision": "reply" | "skip", "skip_reason": string | null, "question": string | null, "moment": string | null, "confidence": number, "why": string}
"question" and "moment" are null when you skip; "skip_reason" is null when you reply. "moment" names the moment the question is about, in a few words.`;

type Row = { product: string; source: string; handle: string; followers: number | null; id: string; created: string; age_hours: number; text: string; context?: string; conversation_id: string | null };

// ---------- Input: the same 18 posts, with their conversation where the saved data knows it
const sample = JSON.parse(readFileSync(SAMPLE, 'utf8'));
const now = new Date();
const rows: Row[] = [];
for (const [product, v] of Object.entries<any>(sample.products)) {
  for (const source of ['search', 'replies'] as const) {
    for (const p of v[source]?.posts ?? []) {
      if (p.label !== 'real_complaint' || !p.specific) continue;
      // replies-source posts came from reading a root's thread: that root is their conversation
      const root = source === 'replies' ? (v.replies.roots ?? []).find((r: any) => r.text === p.context) : null;
      rows.push({ product, source, handle: p.handle, followers: p.followers, id: p.id, created: p.created, text: p.text, context: p.context,
        conversation_id: p.conversation_id ?? root?.id ?? null,
        age_hours: Math.round((now.getTime() - new Date(p.created).getTime()) / 36e5 * 10) / 10 });
    }
  }
}
const previous: Map<string, any> = existsSync(PREVIOUS)
  ? new Map((JSON.parse(readFileSync(PREVIOUS, 'utf8')).results ?? []).map((r: any) => [r.id, r])) : new Map();

await init();
const start = await gatewayBalance('prep');

// ---------- Draft each post
type Result = Row & Draft & { flags: string[]; human: string; match: boolean; prev_decision?: string; prev_question?: string | null };
const results: Result[] = [];
for (const r of rows) {
  const user = [
    `Product: ${r.product}`,
    `Read at: ${now.toISOString()}`,
    `Posted: ${r.created} (${r.age_hours} hours ago)`,
    r.context ? `This post is a reply under the product's own post: "${r.context.slice(0, 200)}"` : null,
    `Post by @${r.handle}:`,
    r.text,
  ].filter(Boolean).join('\n');
  const res = await json<Draft>(SYS, user,
    () => ({ own_experience: 'unclear', decision: 'skip', skip_reason: 'other', question: null, moment: null, confidence: 1, why: 'model output unreadable' }), 'prep');
  const d = res.data;
  // Step 1 is binding: not their own experience means skip, whatever else came back.
  if (d.own_experience !== 'yes' && d.decision === 'reply') Object.assign(d, { decision: 'skip', skip_reason: 'not_their_experience', question: null, moment: null });

  const flags: string[] = [];
  if (d.decision === 'reply') {
    const q = d.question ?? '';
    if (!q) flags.push('no question');
    if (q.length > MAX_CHARS) flags.push(`${q.length} chars`);
    if (/https?:\/\/|www\./i.test(q)) flags.push('link');
    if (/\p{Extended_Pictographic}/u.test(q)) flags.push('emoji');
    if (/research|survey|interview|paid|payment|bounty/i.test(q)) flags.push('mentions research/payment');
    if (/sorry to hear/i.test(q)) flags.push('sympathy phrase');
    if ((q.match(/\?/g) ?? []).length > 1) flags.push('more than one question');
  } else if (!SKIP_REASONS.includes(d.skip_reason as any)) flags.push(`unknown skip_reason ${d.skip_reason}`);

  const prev = previous.get(r.id);
  results.push({ ...r, ...d, flags, human: HUMAN[r.handle] ?? 'unknown', match: false, prev_decision: prev?.decision, prev_question: prev?.question ?? null });
  process.stdout.write('.');
}
console.log();

// ---------- One reply per conversation
// Search-source posts don't carry their conversation in the saved data: look it up, read-only,
// only for posts the agent would reply to (the only ones that can collide).
let lookupCost = 0;
for (const r of results.filter(x => x.decision === 'reply' && !x.conversation_id)) {
  const res = await fetch('https://api.orbio.so/api/v1/tools/social.x.posts', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ handle: r.handle, limit: 20, max_cost: '0.01' }),
  });
  const j: any = await res.json().catch(() => null);
  lookupCost += Number(j?.cost?.credit ?? 0);
  const hit = (j?.result?.tweets ?? []).find((t: any) => String(t.id_str) === r.id);
  r.conversation_id = hit?.conversation_id_str ?? null;
  if (!hit) r.flags.push('conversation not found in their recent posts');
}
const specificity = (r: Result) => (r.text.match(/\d/g)?.length ?? 0) + r.text.length / 100;   // tie-break: numbers and detail
const byConv = new Map<string, Result[]>();
for (const r of results.filter(x => x.decision === 'reply' && x.conversation_id)) byConv.set(r.conversation_id!, [...(byConv.get(r.conversation_id!) ?? []), r]);
for (const group of byConv.values()) {
  if (group.length < 2) continue;
  const keep = [...group].sort((a, b) => b.confidence - a.confidence || specificity(b) - specificity(a))[0];
  for (const r of group) if (r !== keep) Object.assign(r, { decision: 'skip', skip_reason: 'same_conversation', why: `same thread as @${keep.handle}, which ranks higher` });
}
for (const r of results) r.match = r.human === 'maybe' || r.human === r.decision;

await new Promise(s => setTimeout(s, 3000));
const end = await gatewayBalance('prep');
const cost = start && end ? +(end.used - start.used).toFixed(6) : null;

// ---------- Output
const ranked = [...results].sort((a, b) =>
  (a.decision === b.decision ? 0 : a.decision === 'reply' ? -1 : 1) || b.confidence - a.confidence || a.age_hours - b.age_hours);

console.log('\n=== 1. Ranking');
console.log('rank  handle           product  own      agent  skip_reason           conf  human  match');
ranked.forEach((r, i) => console.log(
  `${String(i + 1).padStart(4)}  ${('@' + r.handle).padEnd(16)} ${r.product.padEnd(8)} ${r.own_experience.padEnd(8)} ${r.decision.padEnd(6)} ${String(r.skip_reason ?? '').padEnd(21)} ${String(r.confidence).padStart(4)}  ${r.human.padEnd(6)} ${r.match ? 'yes' : 'NO'}\n      ${r.why}`));

console.log('\n=== 2. Drafted questions, as they would appear (last run beside it)');
for (const r of ranked.filter(x => x.decision === 'reply')) {
  console.log(`\n@${r.handle} (${r.product}, ${r.age_hours}h ago, ${r.followers ?? '?'} followers) · https://x.com/${r.handle}/status/${r.id}`);
  console.log(`  post:      ${r.text}`);
  console.log(`  reply now: ${r.question}`);
  console.log(`  last run:  ${r.prev_question ?? `(${r.prev_decision ?? 'not in last run'})`}`);
  console.log(`  about:     ${r.moment} · confidence ${r.confidence}${r.flags.length ? ` · FLAGS: ${r.flags.join(', ')}` : ''}`);
}
const droppedFromLast = results.filter(r => r.prev_decision === 'reply' && r.decision !== 'reply');
for (const r of droppedFromLast) console.log(`\n@${r.handle}: replied last run ("${r.prev_question}"), now skip (${r.skip_reason}). ${r.why}`);

const agree = results.filter(r => r.match).length;
const disagree = results.filter(r => !r.match);
console.log('\n=== 3. Agreement with your calls ("maybe" counts either way)');
console.log(`  ${agree} of ${results.length} agree (last run: ${[...previous.values()].filter((p: any) => p.match).length} of ${previous.size}).`);
for (const r of disagree) console.log(`  @${r.handle}: you said ${r.human}, agent said ${r.decision}${r.skip_reason ? ` (${r.skip_reason})` : ''}. ${r.why}`);

console.log(`\n=== 4. Cost: ${cost ?? '?'} CREDIT in total on ${MODEL}, of which conversation lookups ${lookupCost.toFixed(4)}.`);

mkdirSync('data/draft-tests', { recursive: true });
writeFileSync(OUT, JSON.stringify({ run_at: now.toISOString(), model: MODEL, sample: SAMPLE, previous: PREVIOUS, cost, lookup_cost: lookupCost, agreement: { agree, of: results.length }, results: ranked }, null, 2));

const replies = results.filter(r => r.decision === 'reply');
const flagged = replies.filter(r => r.flags.length);
console.log(`\n=== SUMMARY
The agent would reply to ${replies.length} of ${results.length} posts (last run: ${[...previous.values()].filter((p: any) => p.decision === 'reply').length}).
${results.filter(r => r.own_experience !== 'yes').length} posts were judged not clearly the poster's own experience; ${results.filter(r => r.skip_reason === 'same_conversation').length} were dropped as a second reply in the same thread.
It agrees with your calls on ${agree} of ${results.length}${disagree.length ? `; it disagrees on ${disagree.map(r => '@' + r.handle).join(', ')}` : ''}.
${flagged.length ? `${flagged.length} drafted questions broke a mechanical rule or had a lookup problem (see FLAGS).` : 'Every drafted question passed the mechanical checks.'}
Cost ${cost ?? '?'} CREDIT. Saved to ${OUT}; last run's output is untouched. Nothing was posted.`);
