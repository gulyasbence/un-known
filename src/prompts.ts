import { json } from './llm.js';
import type { Brief, Unknown } from './db.js';

// ---------- Column 2: the prompt the founder copies into their own AI ----------
export const COPY_PROMPT = `I'm about to run short interviews with people who use (or should use) my product. Help me get my context into one plain-text paste.

Start with what you already know about me and this project from our conversations, memory, and anything I've shared here. Don't browse unless you need to. If a fact is missing, write "unknown" rather than guessing. Do not present my plans as things that already happened. Do not invent users, numbers, or outcomes. If you're unsure whether something is a belief of mine or a fact, put it under WHAT I BELIEVE.

Return only the paste, plain text, these labels, nothing else:

PROJECT: one line, what it is and for whom
STAGE: what's live, what's not
WHO USES IT: who has actually used it, how many if known, how you know
WHAT THEY DO: the two or three things a user does with it, in order
WHAT I BELIEVE: 3 to 6 things I assume about users that I have not verified
WHAT I'VE SEEN: 3 to 6 things I've actually observed (support messages, drop-offs, quotes, numbers), each with where it came from
WHAT I WANT TO DECIDE NEXT: the next product decision this research should inform
DON'T KNOW: anything the above needed that you couldn't fill

Keep every line short. No headings other than these labels. No advice.`;

// ---------- Column 3: paste in, five unknowns out ----------
const BRIEF_SYS = `You turn a founder's project paste into a research brief for short chat interviews with users. The founder wants to find out what they don't know about their users. They do not want their pitch read back to them.

Return JSON:
{"project": string, "one_line": string,
 "screener": [{"q": string, "options": [string]}] (exactly 2),
 "opener": string,
 "unknowns": [{"q": string, "ask": string, "because": string}] (exactly 5),
 "dont_ask": [string] (4 to 6)}

Two layers. "q" is what the founder wants to learn, written for the founder. "ask" is what the interviewer says to a user, one level lower, written for the user. They are not the same sentence.

one_line: what the product is and for whom, one sentence from the paste. Not a diagnosis.

screener: two closed questions the user taps before the chat, so the founder knows who answered. Each has 3 to 5 short options. The first is about how long or how deep they are in this world (e.g. "How long have you been trading on-chain?"). The second is about recent behaviour in the product's area (e.g. "Last week, what did you do on-chain?"), not about the product itself. Options are plain, no jargon the user might not know.

opener: one open question that starts the chat. Life first, not the product. It zooms out: how this world fits into their week, when they do the thing the product is about, what they're paying attention to right now. Example: "How does trading fit into your week? When do you open your wallet, and what makes you go on-chain?" It must not name the product.

unknowns, the "q" side:
- One thing the founder doesn't know about their users, phrased as a question about past behaviour, not about the product's features.
- Rank by how much of the founder's plan rests on it × how little evidence the paste gives. First = most rides on it, least behind it. Prefer items under WHAT I BELIEVE that have nothing under WHAT I'VE SEEN.
- Order them so the interview zooms in: the first two are about their behaviour in this area in general, the later ones get closer to the product and to the decision the founder wants to make.
- "because" is one sentence naming the gap in what the founder gave, in plain words, to the founder ("you said retention is fine but gave no number"). Never flattering.

unknowns, the "ask" side, the rules that matter most:
- Open, past tense, anchored in a real event: "Think of the last time you… Walk me through what happened." Never "would you", never "how often do you", never "how common do you think", never "do you like".
- It must not be answerable in one word. "When did you last…?" invites "yesterday". Ask for the story: what they were doing, what they did, what happened next.
- It must not assume anything about them: not that they used the product, came back, liked it, or hold a position. It has to work for someone who used it once or never.
- Plain and casual, the way a person asks in a chat. Under 30 words. No textbook phrasing, no "can you describe your experience with".
- It must not reveal what the founder hopes to hear or what the founder is building next.
- Do not name a feature the user hasn't mentioned.
- The five asks must anchor on five different moments. Not "the last time you sold" five times. Vary the anchor: the first time, the most recent time, a time it went wrong, a time you decided not to, the last few times side by side. If two asks would pull the same story, rewrite one.

dont_ask: questions the interviewer must never ask, because they only get politeness or a pitch check: "would you use", "how much would you pay", "do you like", "would it help if", anything that names a feature the user hasn't brought up, anything that leads. Include one or two specific to this project.

Plain English throughout. No consultancy words. Everything short.`;

export function makeBrief(paste: string) {
  return json<Brief>(BRIEF_SYS, paste, () => ({
    project: 'Streamswap', one_line: 'A Solana DEX that sells a big bag over time instead of at once, for traders holding more than the pool can absorb',
    screener: [
      { q: 'How long have you been trading on-chain?', options: ['Under a year', '1 to 3 years', 'Longer'] },
      { q: 'Last week, what did you do on-chain?', options: ['Nothing', 'A swap or two', 'Traded most days', 'Moved a big position'] },
    ],
    opener: 'How does trading fit into your week? When do you open your wallet, and what makes you go on-chain?',
    unknowns: [
      { q: 'What do traders do today when a position is bigger than the pool can take?', ask: 'Think of the last time you had a bag that was too big to sell in one go. What did you do with it, start to finish?', because: 'The whole pitch rests on this person and you named none.' },
      { q: 'What did the last new users do after their first swap, and why did most not come back?', ask: 'Think of a DEX you tried once and didn\'t go back to. What happened on that first swap, and what did you do after?', because: 'You said retention is "fine" and gave no number.' },
      { q: 'What did traders think the 2% on the receipt was?', ask: 'Last time you got less than the quote said on a sell, what did you think had happened? What did you do next?', because: 'You believe they understand the fee. You\'ve only seen the drop-off.' },
      { q: 'Where did the last new user hear about the DEX, and what made them try it that day?', ask: 'The last new DEX you tried, how did you hear about it, and what made you actually try it that day?', because: 'You listed channels you post in, not channels users came from.' },
      { q: 'What brings a user back after they left?', ask: 'Ever gone back to a DEX you\'d dropped? What happened that made you go back?', because: 'Nothing under WHAT I\'VE SEEN covers a return.' },
    ],
    dont_ask: ['Would you use a duration slider?', 'How much would you pay for lower slippage?', 'Do you like the receipt?', 'Anything that names TWAP before they do', 'Is Jupiter better?'],
  }), 'prep');
}

// ---------- Column 6: the interviewer ----------
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
  You may open with a short callback to their own words in quotes, then the probe. Under 20 words in total.
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

// ---------- Column 9: one-session report ----------
export type Report = {
  who: string;
  items: { i: number; status: 'answered' | 'opened' | 'thin' | 'not_asked'; claim: string; quote: string; turn: number | null }[];
  surprising: string; change_if_true: string; still_open: number[];
};
const REP_SYS = (brief: Brief) => `You write a one-session research report for the founder of ${brief.project}. One interview, one person. You never say more than one person said. You separate what they said from what you make of it, and you base every line on the transcript or you leave it out.

The five questions the founder wanted answered, in order (i = zero-based index):
${brief.unknowns.map((u, i) => `i=${i} (question ${i + 1}): ${u.q}`).join('\n')}

Return JSON:
{"who": string, "items": [{"i": 0, "status": "...", "claim": "...", "quote": "...", "turn": 3}, ... exactly 5], "surprising": string, "change_if_true": string, "still_open": [numbers]}

who: one line, who this person is from what they said, third person, they/them or no pronoun, under 20 words.
For each question:
- status: "answered" = a specific past event that answers it; "opened" = something relevant but not a full answer; "thin" = general terms only, no specific event; "not_asked" = never reached, or didn't apply to them.
- claim: one sentence, what this one person's answer says. "They" or nothing, never a guessed gender. Not a lesson, not a fix. If status is thin or not_asked, say so plainly.
- quote: their exact words, verbatim, the shortest span that carries it. Empty if none.
- turn: the transcript turn index the quote is from (integer), or null.
surprising: one sentence on anything surprising or contradictory in what they said, or "Nothing that contradicts the paste." Base it on the transcript.
change_if_true: one sentence. If this one answer holds for more people, what the founder should change in the product. Concrete, about the product, not about research. Only if the transcript supports it; otherwise "Too thin to say."
still_open: 1-based numbers of the questions that are thin or not asked.

Plain English. Short. No consultancy words. No praise, no "validates", no "confirms". One person is one person.`;

export async function makeReport(brief: Brief, transcript: Turn[], who: string) {
  const t = transcript.map((x, i) => `[${i}] ${x.role}: ${x.text}`).join('\n');
  const r = await json<Report>(REP_SYS(brief), `Who: ${who || 'unknown'}\nTranscript:\n${t}`, () => ({
    who: who || 'unknown',
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
  r.data.items = items.map(x => ({ ...x, claim: x.claim ?? '', quote: x.quote ?? '' }));
  r.data.who = r.data.who || who;
  return r;
}
