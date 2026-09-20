import { json } from './llm.js';
import type { Brief, Unknown } from './db.js';

// ---------- The prompt the founder copies into their own AI ----------
export const COPY_PROMPT = `I'm about to run short interviews with people who use (or should use) my product. Help me get my context into one plain-text paste.

These chats are for things I can't learn by reading analytics, group chats, or comments. I need a person's story about something they did.

Start with what you already know about me and this project from our conversations, memory, and anything I've shared here. Don't browse unless you need to. If a fact is missing, write "unknown" rather than guessing. Do not present my plans as things that already happened. Do not invent users, numbers, or outcomes. If you're unsure whether something is a belief of mine or a fact, put it under WHAT I BELIEVE.

Return only the paste, plain text, these labels, nothing else:

PROJECT: one line, what it is and for whom
STAGE: what's live, what's not
WHO USES IT: who has actually used it, how many if known, how you know
WHAT THEY DO: the two or three things a user does with it, in order
WHAT I BELIEVE: 3 to 6 things I assume about users that I have not verified
WHAT I'VE SEEN: 3 to 6 things I've actually observed (support messages, drop-offs, quotes, numbers), each with where it came from
WHAT I WANT TO DECIDE NEXT: one concrete product decision this week that a few user stories should inform, not a vague direction
DON'T KNOW: anything the above needed that you couldn't fill

Keep every line short. No headings other than these labels. No advice.`;

// ---------- Paste in, the five unknowns out ----------
const BRIEF_SYS = `You turn a founder's project paste into a research brief for short chat interviews with users. The founder wants to find out what they don't know about their users. They do not want their pitch read back to them.

These interviews are for things you cannot learn from analytics, on-chain data, support logs, or public chat without asking a person. If an unknown can be answered by watching public behavior alone, do not include it.

If the paste is not real project context — it's the prompt itself pasted back, or spam, or gibberish, or a one-line joke with no product behind it — return ONLY:
{"reject": "a short, honest reason this isn't enough to build a brief from"}
Do not invent a project from thin air. Do not fill gaps with fiction.

Otherwise return JSON:
{"project": string, "one_line": string,
 "screener": [{"q": string, "options": [string]}] (exactly 2),
 "opener": string,
 "unknowns": [{"q": string, "ask": string, "because": string}] (exactly 5),
 "dont_ask": [string] (4 to 6)}

Two layers. "q" is what the founder wants to learn, written for the founder. "ask" is what the interviewer says to a user, one level lower, written for the user. They are not the same sentence.

one_line: what the product is and for whom, one sentence from the paste. Not a diagnosis.

screener: two closed questions the user taps before the chat, so the founder knows who answered. Each has 3 to 5 short options. The second one is multi-select (they tap all that apply), so its options must be things that can be true at the same time. The first is about how long or how deep they are in this world (e.g. "How long have you been trading on-chain?"). The second is about recent behaviour in the product's area (e.g. "Last week, what did you do on-chain?"), not about the product itself. Options are plain, no jargon the user might not know.

opener: one open question that starts the chat. Life first, not the product. It zooms out: how this world fits into their week, when they do the thing the product is about, what they're paying attention to right now. Example: "How does trading fit into your week? When do you open your wallet, and what makes you go on-chain?" It must not name the product.

unknowns, the "q" side:
- One thing the founder doesn't know about their users that needs a person's story. Past behaviour, not product features, not market landscape.
- Prefer surprises: beliefs that, if wrong, would change the next decision. Prefer WHAT I BELIEVE items with nothing under WHAT I'VE SEEN.
- Rank by how much of the founder's plan rests on it × how little evidence the paste gives. First = most rides on it, least behind it.
- Order them so the interview zooms in: the first two are about behaviour in this area in general, the later ones get closer to the product and to WHAT I WANT TO DECIDE NEXT.
- "because" is one sentence naming the gap in what the founder gave, in plain words, to the founder ("you said retention is fine but gave no number"). Never flattering. If the paste tries to answer this with analytics or public chat alone, say that in because and still rewrite it as an interviewable story question.

unknowns, the "ask" side:
- Open, past tense, anchored in a real event: "Think of the last time you… Walk me through what happened." Never "would you", "how often", "how common", "do you like".
- Must pull a story (what they were doing, what they did, what happened next), not a one-word answer.
- Must not assume they used the product, opened any app, came back, liked it, or hold a position. Works for someone who never heard of the product.
- Plain chat voice, under 30 words. No textbook phrasing.
- Must not reveal what the founder hopes to hear or is building next. Do not name a feature the user hasn't mentioned.
- Five different moment anchors (first time, most recent, went wrong, decided not to, last few side by side). If two asks would pull the same story, rewrite one.

dont_ask: questions that only get politeness or a pitch check: "would you use", "how much would you pay", "do you like", "would it help if", naming a feature they haven't brought up, anything that leads. Include one or two specific to this project.

Plain English. No consultancy words. Everything short.`;

export async function makeBrief(paste: string) {
  const r = await json<Brief & { reject?: string }>(BRIEF_SYS, paste, () => { throw new Error('Could not generate a brief from this paste. Try again.'); }, 'prep');
  if (r.data.reject) throw new Error(r.data.reject);
  return r;
}

// ---------- The interviewer ----------
export type Turn = { role: 'agent' | 'user'; text: string; item?: number; kind?: 'open' | 'main' | 'followup' | 'close' };
export type State = { item: number; asked_followup: boolean; followups: number; skipped: number; done: boolean; used_at_start?: number | null; screener?: string[]; who?: string; abandoned?: boolean };

// The interviewer is told the topic of the unknown, never the founder's belief or the "because" line.
const INT_SYS = (brief: Brief, item: Unknown | null, who: string, earlier: string) => `You are running a short chat interview with one user for ${brief.project} (${brief.one_line}). You know this world, so you don't explain it and you don't sound like a textbook. You ask about their life and what they did, never about the product's features, and you never pitch.

Who you're talking to, from what they've said so far: ${who || 'not known yet'}
${earlier ? `What they told you earlier, in short:\n${earlier}` : ''}
${item ? `What you are trying to learn now: "${item.q}"` : 'You are still on the opening question, getting a picture of how this fits their week.'}

You never ask: ${brief.dont_ask.map(d => `"${d}"`).join(', ')}. Never a "would you", never "how often", never "do you like", never a question about the future.

Read their last answer and choose one. The default is "next". A follow-up costs the user a turn, so it has to earn it.
- "next": the answer already has a specific past event, what they did, and what came of it. Or it's clear they have no story here. Say nothing, move on. Silence is fine; don't rescue.
- "followup": ONLY if the answer was short, or general ("usually", "I never", "it's fine"), or if it named something specific that the next question will not reach. Then ask ONE plain probe, in their words. Use one of these shapes and nothing fancier:
  "What happened next?" · "When was the last time that happened?" · "Tell me an example." · "Walk me through exactly what happened." · "Help me understand that better." · "Why do you think that is?"
  If their answer was short or general, START with a quote-back of two to six of their exact words in quotes, then the probe: "You said \"figuring out if I could\". What told you yes or no?" Vary the probe; don't use "walk me through" twice in a row. Under 20 words in total.
- "clarify": you can't tell what they meant. One short question.

Return JSON: {"action": "followup"|"next"|"clarify", "say": string}`;

export function openerQuestion(brief: Brief) { return brief.opener; }
export function mainQuestion(brief: Brief, i: number) { return brief.unknowns[i].ask || brief.unknowns[i].q; }

function earlierSummary(transcript: Turn[], upto: number) {
  // the user's earlier answers, one line each, so the interviewer can call back
  return transcript.filter(t => t.role === 'user' && (t.item ?? -1) < upto).map(t => `- (${t.item === -1 || t.item == null ? 'opener' : 'q' + ((t.item ?? 0) + 1)}) ${t.text.slice(0, 140)}`).join('\n');
}

export function decideFollowup(brief: Brief, i: number, transcript: Turn[], lastAnswer: string, hadFollowup: boolean, who: string) {
  if (hadFollowup) return Promise.resolve({ data: { action: 'next' as const, say: '' }, cost_cents: 0, balance: null, tokens: { in: 0, out: 0 } });
  const item = i >= 0 ? brief.unknowns[i] : null;
  return json<{ action: 'followup' | 'next' | 'clarify'; say: string }>(INT_SYS(brief, item, who, earlierSummary(transcript, i)), `Their last answer: """${lastAnswer}"""`, () => {
    const words = lastAnswer.trim().split(/\s+/).length;
    return words < 14 ? { action: 'followup', say: 'What happened next?' } : { action: 'next', say: '' };
  });
}

// ---------- Who this was: one line from screener + opener ----------
const WHO_SYS = `From a user's screener answers and their answer to an opening question, write one line describing who they are, in plain words, third person, no name, no guessed gender, under 20 words. Facts they gave only. Return JSON: {"who": string}`;
export function makeWho(screener: { q: string; a: string }[], openerAnswer: string) {
  return json<{ who: string }>(WHO_SYS, `Screener:\n${screener.map(s => `${s.q} → ${s.a}`).join('\n')}\nOpening answer: """${openerAnswer}"""`, () => ({ who: screener.map(s => s.a).join(', ') + (openerAnswer ? `; ${openerAnswer.slice(0, 60)}` : '') }));
}

// ---------- One-session report ----------
export type Report = {
  who: string; takeaways?: string[];
  items: { i: number; status: 'answered' | 'opened' | 'thin' | 'not_asked'; claim: string; quote: string; turn: number | null }[];
  surprising: string; change_if_true: string; still_open: number[];
};
const REP_SYS = (brief: Brief) => `You write a one-session research report for the founder of ${brief.project}. One interview, one person. You never say more than one person said. You separate what they said from what you make of it, and you base every line on the transcript or you leave it out.

The goal of this report is that the founder thinks: "huh, I didn't think of that. I should have done this earlier." Not "validated." Not a thorough summary deck.

The five questions the founder wanted answered, in order (i = zero-based index):
${brief.unknowns.map((u, i) => `i=${i} (question ${i + 1}): ${u.q}`).join('\n')}

Return JSON:
{"who": string, "takeaways": [string, string, string], "items": [{"i": 0, "status": "...", "claim": "...", "quote": "...", "turn": 3}, ... exactly 5], "surprising": string, "change_if_true": string, "still_open": [numbers]}

who: one line, who this person is from what they said, third person, they/them or no pronoun, under 20 words.
takeaways: the three things the founder should walk away with from this one person, each under 15 words, plain, specific. Aim for "I hadn't thought of that." Not a restatement of the five questions. If nothing surprising showed up, say so in one takeaway instead of padding.
For each question:
- status: "answered" = a specific past event that answers it; "opened" = something relevant but not a full answer; "thin" = general terms only, no specific event; "not_asked" = never reached, or didn't apply to them.
- claim: one short sentence, under 18 words, what this one person's answer says. The quote carries the detail, the claim doesn't repeat it. "They" or nothing, never a guessed gender. Not a lesson, not a fix. If status is thin or not_asked, say so plainly.
- quote: their exact words, verbatim, the shortest span that carries it. Empty if none.
- turn: the transcript turn index the quote is from (integer), or null.
surprising: one sentence on anything surprising or contradictory, or "Nothing surprising in this session." Base it on the transcript. Do not invent tension.
change_if_true: one sentence they would regret not hearing before shipping. Concrete, about the product, not about research. Only if the transcript supports it; otherwise "Too thin to say." Never "validates the direction."
still_open: 1-based numbers of the questions that are thin or not asked.

Plain English. Short. No consultancy words. No praise, no "validates", no "confirms". One person is one person.`;

export async function makeReport(brief: Brief, transcript: Turn[], who: string) {
  const t = transcript.map((x, i) => `[${i}] ${x.role}: ${x.text}`).join('\n');
  const r = await json<Report>(REP_SYS(brief), `Who: ${who || 'unknown'}\nTranscript:\n${t}`, () => ({
    who: who || 'unknown', takeaways: [],
    items: brief.unknowns.map((_, i) => {
      const ans = transcript.map((x, idx) => ({ x, idx })).filter(({ x }) => x.role === 'user' && x.item === i);
      if (!ans.length) return { i, status: 'not_asked' as const, claim: 'Not reached.', quote: '', turn: null };
      const long = ans.find(a => a.x.text.split(/\s+/).length > 12) ?? ans[0];
      const status = long.x.text.split(/\s+/).length > 12 ? 'answered' as const : 'thin' as const;
      return { i, status, claim: `They said: ${long.x.text.slice(0, 80)}`, quote: long.x.text.slice(0, 120), turn: long.idx };
    }),
    surprising: 'Nothing that contradicts the paste.',
    change_if_true: 'Too thin to say.',
    still_open: brief.unknowns.map((_, i) => i + 1).filter(n => !transcript.some(x => x.role === 'user' && x.item === n - 1)),
  }));
  const items = r.data.items ?? [];
  if (items.length && !items.some(x => x.i === 0) && items.some(x => x.i === brief.unknowns.length)) items.forEach(x => x.i -= 1);
  items.sort((a, b) => a.i - b.i);

  // Ground-truth validation: transcript item tags are set by server, not the LLM
  const answered = new Set<number>();
  for (const turn of transcript) if (turn.role === 'user' && turn.item != null && turn.item >= 0) answered.add(turn.item);
  for (const it of items) {
    if (it.status === 'not_asked' && answered.has(it.i)) it.status = 'opened';
    if (it.status === 'answered' && !answered.has(it.i)) it.status = 'not_asked';
  }
  // Fill any missing indices the LLM skipped
  for (let i = 0; i < brief.unknowns.length; i++) {
    if (!items.some(x => x.i === i)) {
      items.push({ i, status: answered.has(i) ? 'opened' : 'not_asked', claim: answered.has(i) ? 'See transcript.' : 'Not reached.', quote: '', turn: null });
    }
  }
  items.sort((a, b) => a.i - b.i);

  r.data.items = items.map(x => ({ ...x, claim: x.claim ?? '', quote: x.quote ?? '' }));
  r.data.still_open = items.filter(x => x.status === 'thin' || x.status === 'not_asked').map(x => x.i + 1);
  r.data.who = r.data.who || who;
  return r;
}

// ---------- Round synthesis (the product deliverable) ----------
export type RoundSynthesis = {
  takeaways: string[];
  change_if_true: string;
  disagree_or_thin: string;
};

const ROUND_SYS = (brief: Brief, n: number) => `You write the round research report for the founder of ${brief.project} (${brief.one_line}). This is the product: a synthesis across ${n} interview${n===1?'':'s'}, not a stack of session summaries.

They wanted to learn:
${brief.unknowns.map((u, i) => `${i + 1}. ${u.q}`).join('\n')}

You are given one pack per finished session (who, takeaways, surprising, change_if_true, and short claims per question). Synthesize across them.

Return JSON only:
{"takeaways": [string, string, string, string?, string?], "change_if_true": string, "disagree_or_thin": string}

takeaways: 3 to 5 things the founder should walk away with from the round as a whole. Each under 18 words, plain, specific. Aim for "I hadn't thought of that." Not a restatement of the questions. Not "users want X" fluff. If only one session, say what that one person forced into view — do not pretend you have a sample.
change_if_true: one concrete product sentence they would regret not hearing before shipping. About the product, not about research. If too thin: "Too thin to say."
disagree_or_thin: where people disagreed, or which questions are still thin / unanswered across the round. Short paragraph or a few short sentences. If nothing: "Nothing clear yet — need more sessions." or "No disagreement; still thin on …" as fits. Do not invent conflict.

Plain English. Short. No consultancy words. No "validates". No praise.`;

export async function makeRoundReport(
  brief: Brief,
  packs: { handle: string; who: string; takeaways: string[]; surprising: string; change_if_true: string; items: { i: number; status: string; claim: string }[] }[],
) {
  const body = packs.map((p, n) => {
    const claims = (p.items || []).map(it => `  Q${it.i + 1} [${it.status}]: ${it.claim}`).join('\n');
    return `Session ${n + 1} · ${p.handle}${p.who ? ` · ${p.who}` : ''}
Takeaways: ${(p.takeaways || []).join(' | ') || '(none)'}
Surprising: ${p.surprising || '(none)'}
If true, change: ${p.change_if_true || '(none)'}
Claims:
${claims || '  (none)'}`;
  }).join('\n\n');

  return json<RoundSynthesis>(ROUND_SYS(brief, packs.length), body, () => ({
    takeaways: packs.flatMap(p => p.takeaways || []).slice(0, 3).length
      ? packs.flatMap(p => p.takeaways || []).slice(0, 5)
      : ['Too thin to synthesize yet.'],
    change_if_true: packs.map(p => p.change_if_true).find(x => x && x !== 'Too thin to say.') || 'Too thin to say.',
    disagree_or_thin: packs.length < 2 ? 'Only one session so far, nothing to cross-check.' : 'Nothing clear yet, need more sessions.',
  }), 'round');
}
