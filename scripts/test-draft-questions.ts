// Would the agent reply, and what would it ask? Posts nothing, replies to nobody.
// Input: the real, specific complaints from one search-quality sample. For each post,
// Sonnet 5 decides reply or skip and drafts the one question it would post.
// At the end the decisions are compared against Bence's own calls, which the model never sees.
// Run: pnpm exec tsx scripts/test-draft-questions.ts
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gatewayBalance } from '../src/money.js';
import { init, json, MODEL } from '../src/llm.js';

const SAMPLE = 'data/search-samples/2026-09-28-20-52-handles.json';
const MAX_AGE_HOURS = 48;
const MAX_CHARS = 200;

// Bence's calls, keyed by handle. Never sent to the model.
const HUMAN: Record<string, 'reply' | 'maybe' | 'skip'> = {
  va1ag: 'reply', Donaxbt: 'reply', mxxivist: 'reply', CryptoInducer: 'reply', AthreeFams: 'reply',
  OfficialTrollX: 'maybe', yourgamerva: 'maybe', Hoshi3dFX: 'maybe',
  broitsravi: 'skip', '66CORE66': 'skip', gafarWeb3: 'skip', LSS0L: 'skip', PictureDays: 'skip',
  HackerKritik: 'skip', '2ctv': 'skip', StitchHQ: 'skip', G3ngarX: 'skip', pminusq: 'skip',
};

const SKIP_REASONS = ['too_vague', 'feature_request', 'support_request', 'not_their_experience', 'too_old', 'joke_or_quip', 'security_or_legal', 'non_english', 'hostile_tone', 'other'] as const;
type Draft = { decision: 'reply' | 'skip'; skip_reason: string | null; question: string | null; moment: string | null; confidence: number; why: string };

const SYS = `You are an interviewer agent on X. You read one public post where someone complains about a crypto product, and decide whether to reply with a single question that gets them to tell you what actually happened.

Reply only when you can ask about a specific, recent moment in this person's own experience. Good: "the last time a fill came in above the price, what were you trading?" The question is about one real past moment, not their opinion, not a hypothetical, not "would you".

The question:
- one question, under ${MAX_CHARS} characters
- plain, casual English, the way a curious person would ask
- no pitch, no links, no mention of research, interviews, surveys or payment
- no "sorry to hear", no sympathy phrases, no emojis
- anchored on what they said, in their words where it helps

Skip, with the matching reason, when the post is:
- too_old: older than ${MAX_AGE_HOURS} hours at the time of reading
- feature_request: asks for something new rather than describing a problem that happened
- support_request: they want help or a fix from the company, not a conversation
- not_their_experience: about someone else's problem, or commentary on others
- joke_or_quip: a joke, meme, one-liner or banter
- security_or_legal: vulnerability disclosures, hacks, lawsuits, anything legal
- non_english: not in English
- hostile_tone: abusive, slur-heavy or threatening
- too_vague: there is no concrete moment to ask about. Being vague is a skip, not a guess.
- other: anything else, say what in "why"

Confidence: 1 (coin flip) to 5 (clearly right).
"why": one line, under 15 words, on why this post is or isn't worth replying to.

Return JSON only:
{"decision": "reply" | "skip", "skip_reason": string | null, "question": string | null, "moment": string | null, "confidence": number, "why": string}
"question" and "moment" are null when you skip; "skip_reason" is null when you reply. "moment" names the moment the question is about, in a few words.`;

type Row = { product: string; source: string; handle: string; followers: number | null; id: string; created: string; age_hours: number; text: string; context?: string };

const sample = JSON.parse(readFileSync(SAMPLE, 'utf8'));
const now = new Date();
const rows: Row[] = [];
for (const [product, v] of Object.entries<any>(sample.products)) {
  for (const source of ['search', 'replies'] as const) {
    for (const p of v[source]?.posts ?? []) {
      if (p.label !== 'real_complaint' || !p.specific) continue;
      rows.push({ product, source, handle: p.handle, followers: p.followers, id: p.id, created: p.created, text: p.text, context: p.context,
        age_hours: Math.round((now.getTime() - new Date(p.created).getTime()) / 36e5 * 10) / 10 });
    }
  }
}

await init();
const start = await gatewayBalance('prep');
const results: (Row & Draft & { flags: string[]; human: string; match: boolean })[] = [];

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
    () => ({ decision: 'skip', skip_reason: 'other', question: null, moment: null, confidence: 1, why: 'model output unreadable' }), 'prep');
  const d = res.data;

  // Mechanical checks on the draft; flagged, never fixed.
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

  const human = HUMAN[r.handle] ?? 'unknown';
  const match = human === 'maybe' || human === d.decision;
  results.push({ ...r, ...d, flags, human, match });
  process.stdout.write('.');
}
console.log();

await new Promise(s => setTimeout(s, 3000));
const end = await gatewayBalance('prep');
const cost = start && end ? +(end.used - start.used).toFixed(6) : null;

// Rank: replies first, then by confidence, then newest.
const ranked = [...results].sort((a, b) =>
  (a.decision === b.decision ? 0 : a.decision === 'reply' ? -1 : 1) || b.confidence - a.confidence || a.age_hours - b.age_hours);

console.log('\n=== 1. Ranking');
console.log('rank  handle           product  agent  skip_reason           conf  human  match');
ranked.forEach((r, i) => console.log(
  `${String(i + 1).padStart(4)}  ${('@' + r.handle).padEnd(16)} ${r.product.padEnd(8)} ${r.decision.padEnd(6)} ${String(r.skip_reason ?? '').padEnd(21)} ${String(r.confidence).padStart(4)}  ${r.human.padEnd(6)} ${r.match ? 'yes' : 'NO'}\n      ${r.why}`));

console.log('\n=== 2. Drafted questions, as they would appear');
for (const r of ranked.filter(x => x.decision === 'reply')) {
  console.log(`\n@${r.handle} (${r.product}, ${r.age_hours}h ago, ${r.followers ?? '?'} followers) · https://x.com/${r.handle}/status/${r.id}`);
  console.log(`  post:  ${r.text}`);
  console.log(`  reply: ${r.question}`);
  console.log(`  about: ${r.moment} · confidence ${r.confidence}${r.flags.length ? ` · FLAGS: ${r.flags.join(', ')}` : ''}`);
}

const agree = results.filter(r => r.match).length;
const disagree = results.filter(r => !r.match);
console.log('\n=== 3. Agreement with your calls ("maybe" counts either way)');
console.log(`  ${agree} of ${results.length} agree.`);
for (const r of disagree) console.log(`  @${r.handle}: you said ${r.human}, agent said ${r.decision}${r.skip_reason ? ` (${r.skip_reason})` : ''}. ${r.why}`);

console.log(`\n=== 4. Cost: ${cost ?? '?'} CREDIT for ${results.length} drafts on ${MODEL}.`);

const day = now.toISOString().slice(0, 10);
mkdirSync('data/draft-tests', { recursive: true });
const file = `data/draft-tests/${day}.json`;
writeFileSync(file, JSON.stringify({ run_at: now.toISOString(), model: MODEL, sample: SAMPLE, max_age_hours: MAX_AGE_HOURS, cost, agreement: { agree, of: results.length }, results: ranked }, null, 2));

const replies = results.filter(r => r.decision === 'reply');
const flagged = replies.filter(r => r.flags.length);
console.log(`\n=== SUMMARY
The agent would reply to ${replies.length} of ${results.length} posts and skip ${results.length - replies.length}.
It agrees with your calls on ${agree} of ${results.length}${disagree.length ? `; it disagrees on ${disagree.map(r => '@' + r.handle).join(', ')}` : ''}.
${flagged.length ? `${flagged.length} drafted questions broke a mechanical rule (see FLAGS).` : 'Every drafted question passed the mechanical checks (length, links, emojis, one question, no research or payment talk).'}
Cost ${cost ?? '?'} CREDIT. Saved to ${file}. Nothing was posted.`);
