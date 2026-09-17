import { json } from './llm.js';
import type { Brief, Unknown } from './db.js';

// ---------- Column 2: the prompt the founder copies into their own AI ----------
export const COPY_PROMPT = `I'm about to run short interviews with people who use (or should use) my product. Help me get my context into one plain-text paste.

Start with what you already know about me and this project from our conversations, memory, and anything I've shared here. Don't browse unless you need to. If a fact is missing, write "unknown" rather than guessing. Do not present my plans as things that already happened. Do not invent users, numbers, or outcomes. If you're unsure whether something is a belief of mine or a fact, put it under BELIEFS.

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
const BRIEF_SYS = `You turn a founder's project paste into a research brief. The founder wants to know what they don't know about their users, not to hear their pitch back.

Return JSON: {"project": string, "one_line": string, "unknowns": [{"q": string, "because": string}] (exactly 5), "dont_ask": [string] (4 to 6)}

Rules for unknowns:
- Each is one question about users' past behaviour, phrased so a short chat interview can ask it. Past tense, specific. Never "would you", never a feature check.
- Rank by how much of the founder's plan rests on it × how little evidence they gave. First = most rides on it with least evidence.
- "because" is one sentence naming the gap in what the founder gave, in plain words, addressed to the founder ("you said retention is fine but gave no number"). Never flattering.
- Prefer unknowns under WHAT I BELIEVE that have nothing under WHAT I'VE SEEN.
Rules for dont_ask:
- Questions the interviewer must not ask because they would only get politeness or a pitch check: "would you use", "how much would you pay", "do you like", anything that names a feature the user hasn't seen, anything that leads.
- Include 1 or 2 specific to this project.
Plain English, no consultancy words.`;

export function makeBrief(paste: string) {
  return json<Brief>(BRIEF_SYS, paste, () => ({
    project: 'Streamswap', one_line: 'A Solana DEX that sells a big bag over time instead of at once',
    unknowns: [
      { q: 'What did the last 20 users do after their first swap, and why did most not come back?', because: 'You said retention is "fine" and gave no number.' },
      { q: 'Who holds a bag they can\'t sell at once today, and what did they do the last time they tried?', because: 'The whole pitch rests on this person and you named none.' },
      { q: 'When a user saw the 2% gone on their receipt, what did they think it was?', because: 'You believe they understand the fee, you\'ve only seen the drop-off.' },
      { q: 'Where did the last new user hear about the DEX, and what made them try it that day?', because: 'You listed channels you post in, not channels users came from.' },
      { q: 'What made a user who left come back, if any did?', because: 'Nothing under WHAT I\'VE SEEN covers a return.' },
    ],
    dont_ask: ['Would you use a duration slider?', 'How much would you pay for lower slippage?', 'Do you like the receipt?', 'Anything that names TWAP before they do', 'Is Jupiter better?'],
  }));
}

// ---------- Column 6: the interviewer ----------
export type Turn = { role: 'agent' | 'user'; text: string; item?: number; kind?: 'main' | 'followup' | 'close' | 'open' };
export type State = { item: number; asked_followup: boolean; followups: number; skipped: number; done: boolean };

const INT_SYS = (brief: Brief, item: Unknown) => `You are interviewing one user of ${brief.project} (${brief.one_line}) in a short chat. You know the space, so you don't explain it. You ask about them, never about the product's features.

The current question you are trying to answer for the founder: "${item.q}"

You never ask: ${brief.dont_ask.map(d => `"${d}"`).join(', ')}.

Given the user's last answer, decide one of:
- "followup": the answer was short, vague, or mentioned something specific worth one more question. Quote back their words in quotes, then ask for the last time it happened or what it looked like. One question, under 25 words.
- "next": the answer already has a specific story, or a follow-up wouldn't get more. Say nothing.
- "clarify": you can't tell what they meant. One short question.

Return JSON: {"action": "followup"|"next"|"clarify", "say": string}`;

export function mainQuestion(brief: Brief, i: number) {
  return brief.unknowns[i].q;
}
export function decideFollowup(brief: Brief, i: number, lastAnswer: string, hadFollowup: boolean) {
  if (hadFollowup) return Promise.resolve({ data: { action: 'next' as const, say: '' }, cost_cents: 0, balance: null, tokens: { in: 0, out: 0 } });
  return json<{ action: 'followup' | 'next' | 'clarify'; say: string }>(INT_SYS(brief, brief.unknowns[i]), `User's answer: """${lastAnswer}"""`, () => {
    const short = lastAnswer.trim().split(/\s+/).length < 12;
    return short ? { action: 'followup', say: `You said "${lastAnswer.trim().slice(0, 40)}". When was the last time that happened, and what did you do?` } : { action: 'next', say: '' };
  });
}

// ---------- Column 9: one-session report ----------
export type Report = {
  items: { i: number; status: 'answered' | 'opened' | 'thin' | 'not_asked'; claim: string; quote: string; turn: number | null }[];
  change_if_true: string; still_open: number[];
};
const REP_SYS = (brief: Brief) => `You write a one-session research report for the founder of ${brief.project}. One interview only. Never claim more than one person said.

The five questions, in order:
${brief.unknowns.map((u, i) => `${i + 1}. ${u.q}`).join('\n')}

For each question return a status:
- "answered": the user gave a specific past event that answers it
- "opened": they said something relevant but not a full answer
- "thin": they answered in general terms, no specific event
- "not_asked": the interview never reached it or it didn't apply to them
And: "claim": one sentence, what this one person's answer says (present it as one person, e.g. "She thought the 2% was slippage"), "quote": their exact words, verbatim, shortest that carries it, "turn": the index of the transcript turn the quote comes from (integer) or null.

Then "change_if_true": one sentence, what the founder should change in the product if this one answer holds for more people. Concrete, about the product, not about research.
"still_open": the question numbers (1-based) that are thin or not asked.

Return JSON: {"items":[{"i":0,"status":"...","claim":"...","quote":"...","turn":3}, ...5], "change_if_true": "...", "still_open": [2,5]}
Plain English. No consultancy words. No praise.`;

export function makeReport(brief: Brief, transcript: Turn[]) {
  const t = transcript.map((x, i) => `[${i}] ${x.role}: ${x.text}`).join('\n');
  return json<Report>(REP_SYS(brief), `Transcript:\n${t}`, () => ({
    items: brief.unknowns.map((_, i) => {
      const ans = transcript.map((x, idx) => ({ x, idx })).filter(({ x }) => x.role === 'user' && x.item === i);
      if (!ans.length) return { i, status: 'not_asked' as const, claim: 'Not reached.', quote: '', turn: null };
      const long = ans.find(a => a.x.text.split(/\s+/).length > 12) ?? ans[0];
      const status = long.x.text.split(/\s+/).length > 12 ? 'answered' as const : 'thin' as const;
      return { i, status, claim: `One person said: ${long.x.text.slice(0, 80)}`, quote: long.x.text.slice(0, 120), turn: long.idx };
    }),
    change_if_true: 'Explain the fee on the receipt before the ticket asks for a duration.',
    still_open: brief.unknowns.map((_, i) => i + 1).filter(n => !transcript.some(x => x.role === 'user' && x.item === n - 1)),
  }));
}
