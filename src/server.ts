import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { db, id, secret, now, getRound, getSession, saveSession, type Brief } from './db.js';
import { fund, priceRound, charge, payout, releaseBounty, fundTesting, live as moneyLive, gatewayBalance } from './money.js';
import { COPY_PROMPT, CLOSE_QS, makeBrief, mainQuestion, openerQuestion, decideFollowup, makeReport, makeRoundReport, makeWho, type Turn, type State } from './prompts.js';
import { live, MODEL, init } from './llm.js';
import { balances } from './chain.js';
await init();

const app = new Hono();
const page = (f: string) => (c: any) => c.html(readFileSync(`public/${f}`, 'utf8'));

app.get('/', page('index.html'));
app.get('/brief', page('brief.html'));
app.get('/round/:id', page('round.html'));
app.get('/round/:id/report', page('report.html'));
app.get('/round/:id/s/:sid', page('session-read.html'));
// Agents that only fetch URLs get the same session as plain text (PO, Oct 22). Registered before the HTML routes so "x.txt" isn't read as a token.
app.get('/s/:file{[a-z0-9]+\\.txt}', c => sessionText(c, c.req.param('file').slice(0, -4)));
app.get('/s/:token/answer.txt', async c => {
  const s = getSession('token', c.req.param('token'));
  if (!s) return c.text('No such session. Start one from the invite link.', 404);
  const q = new URL(c.req.url, 'http://x').searchParams;
  const text = (q.get('text') || '').trim();
  if (!text && !s.state.done) return c.text('Add your answer as ?text=… (URL-encoded).', 400);
  const screener = [q.get('s1'), q.get('s2')].filter((x): x is string => !!x);
  if (!s.state.done) await answer(s, { text, handle: q.get('handle') || undefined, screener });
  return sessionText(c, s.token);
});
app.get('/s/:token', c => wantsText(c) ? sessionText(c, c.req.param('token')) : page('session.html')(c));
app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: p => p.replace(/^\/static/, '') }));

// MVA's server-side token (PO, Oct 22): creates unfunded rounds and reads the rounds it created. Nothing else.
const MVA_TOKEN = process.env.UNKNOWN_MVA_TOKEN || '';
function isMva(c: any) {
  const got = Buffer.from(c.req.header('authorization') || ''), want = Buffer.from(`Bearer ${MVA_TOKEN}`);
  return !!MVA_TOKEN && got.length === want.length && timingSafeEqual(got, want);
}
function checkKey(c: any, r: any) {
  if (r.owner === 'mva' && isMva(c)) return true;
  if (!r.secret) return true; // legacy rounds without a secret
  const k = new URL(c.req.url, 'http://x').searchParams.get('key');
  return k === r.secret;
}

// A finished round to show visitors, and which rounds are demos. Both from env so no round key lives in the repo.
const DEMO_URL = process.env.DEMO_URL || null;
const DEMO_IDS = (process.env.DEMO_ROUND_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
// What leaves the server about a round. The stored paste is the founder's raw context and no page needs it back;
// the secret is already in the caller's URL; the "because" lines quote the paste. None of it is returned.
function publicBrief(b: Brief) { return { ...b, unknowns: b.unknowns.map(({ because, ...u }) => u) }; }
function publicRound(r: any) { const { paste, secret, ...rest } = r; return { ...rest, brief: publicBrief(r.brief) }; }
// Demo rounds can rename the people in them (handles, and mentions inside writeups) without touching stored data.
const DEMO_ALIASES: [RegExp, string][] = Object.entries(JSON.parse(process.env.DEMO_ALIASES || '{}') as Record<string, string>)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([from, to]) => [new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), to]);
function aliased<T>(rid: string, obj: T): T {
  if (!DEMO_IDS.includes(rid) || !DEMO_ALIASES.length) return obj;
  let s = JSON.stringify(obj);
  for (const [re, to] of DEMO_ALIASES) s = s.replace(re, to);
  return JSON.parse(s);
}
app.get('/api/meta', c => c.json({ live, model: MODEL, money_live: moneyLive, copy_prompt: COPY_PROMPT, demo_url: DEMO_URL }));
app.get('/api/health', async c => {
  const auth = c.req.header('authorization');
  if (auth !== `Bearer ${process.env.HEALTH_TOKEN || 'local'}`) return c.json({ error: 'unauthorized' }, 403);
  return c.json({ model: live ? MODEL : 'mock', wallet: await balances().catch(e => ({ error: String(e) })), round_key: await gatewayBalance('round').catch(() => null), prep_key: await gatewayBalance('prep').catch(() => null) });
});
// One invite link per round. Opening it spawns a session.
function liveRound(rid: string): { r?: any; err?: [string, 404 | 410] } {
  const r = getRound(rid);
  if (!r || !r.funded_at) return { err: ['This round is not live.', 404] };
  if (r.balance_cents <= 0) return { err: ['This round is out of budget.', 410] };
  return { r };
}
async function startSession(r: any) {
  const sid = id(), token = id() + id();
  const gb = await gatewayBalance('round').catch(() => null);
  const state: State = { item: -1, asked_followup: false, followups: 0, skipped: 0, done: false, used_at_start: gb?.used ?? null, screener: [], who: '' };
  const transcript: Turn[] = [{ role: 'agent', text: openerQuestion(r.brief), item: -1, kind: 'open' }];
  db.prepare('insert into sessions (id, round_id, token, created_at, state, transcript) values (?,?,?,?,?,?)').run(sid, r.id, token, now(), JSON.stringify(state), JSON.stringify(transcript));
  return token;
}
// Text for agents (PO, Oct 22). /r/:id.txt only explains, it never starts a session, so link previews and re-reads cost nothing.
const wantsText = (c: any) => new URL(c.req.url, 'http://x').searchParams.get('format') === 'text' || (/text\/plain/.test(c.req.header('accept') || '') && !/text\/html/.test(c.req.header('accept') || ''));
const base = (c: any) => process.env.PUBLIC_URL || `${c.req.header('x-forwarded-proto') || new URL(c.req.url).protocol.replace(':', '')}://${c.req.header('host') || 'localhost'}`;
function howTo(c: any, r: any) {
  const b = base(c), sc = r.brief.screener ?? [];
  return `(un)known · a short interview for ${r.brief.project}
${r.brief.one_line}

One opening question, ${r.brief.unknowns.length} questions about things you actually did, then two closing questions: where to pay you, and whether your answers can be published. About 5 minutes. Answer about what really happened, in your own words.

How to take part with plain URL fetches:

1. Start a session (once):
   GET ${b}/r/${r.id}/start.txt
   The reply has your session link and the first question. Keep the session link, it is the only way back.

2. Answer the current question:
   GET ${b}/s/<token>/answer.txt?text=<your answer, URL-encoded>
   On the first answer you can also say who you are: &handle=<your name or handle>${sc.length ? '&s1=<answer to 1 below>&s2=<answers to 2 below>' : ''}
   The reply is the next question.

3. Check where you are at any time:
   GET ${b}/s/<token>.txt

4. It is finished when the reply says "status: done". Nothing else to do after that.
${sc.length ? `
Two quick ones before the chat (pass them as s1 and s2 on your first answer):
${sc.map((q: { q: string; options: string[] }, i: number) => `   ${i + 1}. ${q.q}  [${i === 1 ? 'all that apply' : 'pick one'}: ${(q.options ?? []).join(' / ')}]`).join('\n')}
` : ''}
If you can POST JSON instead:
   POST ${b}/api/r/${r.id}/start                 -> {"token", "session_url", "text_url", "question"}
   GET  ${b}/api/s/<token>                        -> state and transcript
   POST ${b}/api/s/<token>/answer   {"text": "...", "handle": "...", "screener": ["...", "..."]}

People: open ${b}/r/${r.id} in a browser instead.
`;
}
function currentQuestion(s: any) {
  return [...s.transcript].reverse().find((t: Turn) => t.role === 'agent')?.text ?? '';
}
function sessionText(c: any, token: string) {
  const s = getSession('token', token);
  if (!s) return c.text('No such session. Start one from the invite link.', 404);
  const r = getRound(s.round_id)!, b = base(c), st: State = s.state, n = r.brief.unknowns.length;
  const where = st.close != null ? `closing question ${st.close + 1} of 2` : st.item < 0 ? 'opening question' : `question ${st.item + 1} of ${n}`;
  const tape = s.transcript.map((t: Turn) => `${t.role === 'agent' ? 'Interviewer' : 'You'}: ${t.text}`).join('\n');
  return c.text(`(un)known · ${r.brief.project}
status: ${st.done ? 'done' : `in progress · ${where}`}
session: ${b}/s/${s.token}.txt

${st.done ? 'Thanks, everything is saved. Nothing more to do.' : `Interviewer: ${currentQuestion(s)}

Answer: GET ${b}/s/${s.token}/answer.txt?text=<your answer, URL-encoded>`}

So far:
${tape}
`);
}
app.get('/r/:file{[a-z0-9]+\\.txt}', c => {
  const { r, err } = liveRound(c.req.param('file').slice(0, -4));
  return err ? c.text(err[0], err[1]) : c.text(howTo(c, r));
});
app.get('/r/:id/start.txt', async c => {
  const { r, err } = liveRound(c.req.param('id'));
  if (err) return c.text(err[0], err[1]);
  return sessionText(c, await startSession(r));
});
app.post('/api/r/:id/start', async c => {
  const { r, err } = liveRound(c.req.param('id'));
  if (err) return c.json({ error: err[0] }, err[1]);
  const token = await startSession(r), b = base(c);
  return c.json({ token, session_url: `${b}/s/${token}`, text_url: `${b}/s/${token}.txt`, question: openerQuestion(r.brief) });
});
app.get('/r/:id', async c => {
  const { r, err } = liveRound(c.req.param('id'));
  if (err) return c.text(err[0], err[1]);
  if (wantsText(c)) return c.text(howTo(c, r));
  return c.redirect('/s/' + await startSession(r));
});

const PASTE_MAX = 8000;
const BRIEFS_PER_IP_HOUR = 10, BRIEFS_PER_DAY = 50, MAX_INTERVIEWS = 20;
const briefHits: { ip: string; at: number }[] = [];
function briefAllowed(ip: string) {
  const now = Date.now();
  while (briefHits.length && now - briefHits[0].at > 864e5) briefHits.shift();
  if (briefHits.length >= BRIEFS_PER_DAY) return 'The app has hit its brief limit for today. Try again tomorrow.';
  if (briefHits.filter(h => h.ip === ip && now - h.at < 36e5).length >= BRIEFS_PER_IP_HOUR)
    return 'Too many briefs from here in the last hour. Try again later.';
  briefHits.push({ ip, at: now });
  return null;
}
const clientIp = (c: any) => c.req.header('fly-client-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';

// Brief: paste in, five unknowns out
app.post('/api/brief', async c => {
  let paste = '';
  try { ({ paste } = await c.req.json()); } catch { return c.json({ error: 'Bad request.' }, 400); }
  if (!paste?.trim()) return c.json({ error: 'Paste your project context first.' }, 400);
  if (paste.length > PASTE_MAX) return c.json({ error: `That paste is ${Math.round(paste.length / 1000)}k characters. Keep it under ${PASTE_MAX / 1000}k, the useful parts only.` }, 400);
  const limited = briefAllowed(clientIp(c));
  if (limited) return c.json({ error: limited }, 429);
  if (/^I'm about to run short interviews|Return only the paste, plain text/i.test(paste.trim()))
    return c.json({ error: 'That\'s the prompt itself. Paste it into the AI that knows your project, then paste back what it gives you.' }, 400);
  try {
    const r = await makeBrief(paste);
    const b = r.data as any;
    // The brief-maker answers {"reject": "..."} when the paste isn't enough to build a brief from.
    if (b?.reject) return c.json({ error: String(b.reject) }, 422);
    if (!Array.isArray(b?.unknowns) || !b.unknowns.length || !Array.isArray(b?.screener))
      return c.json({ error: 'The brief came back incomplete. Try again, or add a bit more about your project.' }, 502);
    return c.json({ brief: r.data, cost_cents: r.cost_cents, balance: r.balance, model: r.model });
  } catch (e) {
    console.error('[brief]', e);
    const msg = (e as Error)?.message || String(e);
    if (/model_not_available|No provider/i.test(msg))
      return c.json({ error: 'Model unavailable on Orbio right now. Try again in a minute.' }, 502);
    return c.json({ error: msg || 'Brief failed. Try again.' }, 400);
  }
});

// Round: create, price, fund
app.post('/api/rounds', async c => {
  const body = await c.req.json() as { brief: Brief; interviews: number; bounty_cents: number; paste?: string; prep_cents?: number };
  const { brief, bounty_cents, paste, prep_cents } = body;
  const interviews = Math.min(Math.max(Math.round(Number(body.interviews) || 1), 1), MAX_INTERVIEWS);
  if (!brief?.project || !Array.isArray(brief?.unknowns)) return c.json({ error: 'Bad request.' }, 400);
  const rid = id(), key = secret(), mva = isMva(c);
  db.prepare('insert into rounds (id, created_at, project, brief, interviews, bounty_cents, balance_cents, paste, prep_cents, secret, owner) values (?,?,?,?,?,?,0,?,?,?,?)')
    .run(rid, now(), brief.project, JSON.stringify(brief), interviews, bounty_cents ?? 0, paste ?? null, prep_cents ?? 0, key, mva ? 'mva' : null);
  if (mva) {
    // MVA's rounds go live without a funding step and buy nothing on chain: inference spends the key the server already runs on,
    // and MVA pays people by hand. The budget envelope is 25¢ a session because the round synthesis re-runs after each one.
    db.prepare('update rounds set funded_at=?, tx=?, balance_cents=?, bounty_held_cents=0 where id=?').run(now(), 'mva', interviews * 25, rid);
    const b = base(c);
    return c.json({ id: rid, key, price: priceRound(interviews, bounty_cents ?? 0), invite_url: `${b}/r/${rid}`, agent_url: `${b}/r/${rid}.txt` });
  }
  return c.json({ id: rid, key, price: priceRound(interviews, bounty_cents) });
});
const ABANDON_MS = 30 * 60000;
function sweepRound(roundId: string) {
  const cutoff = new Date(Date.now() - ABANDON_MS).toISOString();
  db.prepare(`delete from sessions where round_id=? and done_at is null and created_at < ? and transcript not like '%"role":"user"%'`).run(roundId, cutoff);
  const stale = db.prepare(`select id from sessions where round_id=? and done_at is null and created_at < ?`).all(roundId, cutoff) as any[];
  for (const { id: sid } of stale) {
    const s = getSession('id', sid)!; const r = getRound(roundId)!;
    // Gone during the close questions: the interview itself is complete, so it finishes with a writeup, not as abandoned.
    if (s.state.close != null) { finish(s, r, `Thanks for your time.`); continue; }
    s.state.done = true; s.state.abandoned = true; s.done_at = now();
    s.receipt = { ...receipt(s, r, s.transcript, s.state), bounty_cents: 0, abandoned: true };
    saveSession(s);
  }
}
function sweepAll() {
  const rounds = db.prepare('select id from rounds where funded_at is not null').all() as any[];
  for (const r of rounds) sweepRound(r.id);
}
setInterval(sweepAll, 5 * 60000).unref();
app.get('/api/rounds/:id', async c => {
  const r0 = getRound(c.req.param('id'));
  if (!r0) return c.json({ error: 'not found' }, 404);
  if (!checkKey(c, r0)) return c.json({ error: 'unauthorized' }, 403);
  const r = r0;
  const sessions = (db.prepare('select * from sessions where round_id=? order by created_at').all(r.id) as any[])
    .map(s => ({ id: s.id, token: s.token, handle: s.handle, created_at: s.created_at, done_at: s.done_at, cost_cents: s.cost_cents, receipt: s.receipt ? JSON.parse(s.receipt) : null, paid_at: s.paid_at, has_report: !!s.report, abandoned: !!JSON.parse(s.state).abandoned, wallet: s.wallet ?? null, publish: s.publish ?? null }));
  const spent_cents = sessions.reduce((a, s) => a + (s.cost_cents || 0), 0);
  return c.json(aliased(r.id, { ...publicRound(r), price: priceRound(r.interviews, r.bounty_cents), sessions, spent_cents, fund_testing: fundTesting || !moneyLive, model: MODEL, demo: DEMO_IDS.includes(r.id), synthesis_stale: synthesisStale(r, sessions.filter(x => x.done_at).map(x => x.id)) }));
});
app.post('/api/rounds/:id/fund', async c => {
  const r = getRound(c.req.param('id'));
  if (!r) return c.json({ error: 'not found' }, 404);
  if (!checkKey(c, r)) return c.json({ error: 'unauthorized' }, 403);
  const f = await fund(r.id, r.interviews, r.bounty_cents);
  // one open invite link per round; each opener gets their own session
  return c.json(f);
});

// Interviewee. Sessions are spawned by opening /r/:id (one link per round).
app.get('/api/s/:token', c => {
  const s = getSession('token', c.req.param('token'));
  if (!s) return c.json({ error: 'no session' }, 404);
  const r = getRound(s.round_id)!;
  return c.json({ project: r.brief.project, one_line: r.brief.one_line, n: r.brief.unknowns.length + 1, screener: r.brief.screener, bounty_cents: r.bounty_cents, minutes: 5, state: s.state, transcript: s.transcript, handle: s.handle, receipt: s.receipt });
});
app.post('/api/s/:token/answer', async c => {
  const s = getSession('token', c.req.param('token'));
  if (!s) return c.json({ error: 'no session' }, 404);
  if (s.state.done) return c.json({ state: s.state, transcript: s.transcript });
  return c.json(await answer(s, await c.req.json()));
});
// One answer, from the chat page, the JSON API, or the text links: all three run this.
async function answer(s: any, { text, handle, screener }: { text: string; handle?: string; screener?: string[] }) {
  const r = getRound(s.round_id)!;
  if (handle) s.handle = handle;
  const st: State = s.state; const tr: Turn[] = s.transcript;
  if (Array.isArray(screener) && screener.length) st.screener = screener;
  if (st.close != null) {
    // The close questions: stored as given, no model call, then the session ends as it always did.
    tr.push({ role: 'user', text, kind: 'closeq' });
    if (st.close === 0) { s.wallet = walletAnswer(text); st.close = 1; tr.push({ role: 'agent', text: CLOSE_QS[1], kind: 'closeq' }); saveSession(s); }
    else { s.publish = publishAnswer(text); finish(s, r, `That's all. Thank you for your time.`); }
    return { state: st, transcript: tr, receipt: s.receipt ?? null };
  }
  const i = st.item;
  tr.push({ role: 'user', text, item: i });
  const d = await decideFollowup(r.brief, i, tr, text, st.asked_followup, st.who ?? '');
  s.cost_cents += d.cost_cents; charge(r.id, d.cost_cents);
  if ((d.data.action === 'followup' || d.data.action === 'clarify') && d.data.say) {
    st.asked_followup = true; st.followups++;
    tr.push({ role: 'agent', text: d.data.say, item: i, kind: 'followup' });
  } else {
    if (!st.asked_followup && i >= 0) st.skipped++;
    if (i === -1) {
      // leaving the opener: write the one-line "who" from screener + opener answers
      const openerAnswers = tr.filter(t => t.role === 'user' && t.item === -1).map(t => t.text).join(' ');
      const w = await makeWho((r.brief.screener ?? []).map((q: { q: string }, k: number) => ({ q: q.q, a: st.screener?.[k] ?? "" })), openerAnswers);
      s.cost_cents += w.cost_cents; charge(r.id, w.cost_cents); st.who = w.data.who;
    }
    st.item++; st.asked_followup = false;
    if (st.item >= r.brief.unknowns.length) {
      st.close = 0;
      tr.push({ role: 'agent', text: CLOSE_QS[0], kind: 'closeq' });
    } else {
      tr.push({ role: 'agent', text: mainQuestion(r.brief, st.item), item: st.item, kind: 'main' });
    }
  }
  saveSession(s);
  return { state: st, transcript: tr, receipt: s.receipt ?? null };
}
// The end of a session, however it ends: receipt, the by-hand bounty line, the writeup.
function finish(s: any, r: any, closing: string) {
  s.state.done = true; s.done_at = now();
  s.transcript.push({ role: 'agent', text: closing, kind: 'close' });
  s.receipt = receipt(s, r, s.transcript, s.state);
  payout(s.id, r.bounty_cents); s.paid_at = now(); releaseBounty(r.id, r.bounty_cents);
  saveSession(s); writeReport(s.id).catch(e => console.error('[report]', e));
}
// Kept as given, trimmed. An address or ENS name inside a sentence is pulled out; a refusal is stored as "no thanks".
function walletAnswer(text: string) {
  const t = text.trim();
  const addr = t.match(/0x[a-fA-F0-9]{40}/)?.[0] || t.match(/\b[a-z0-9-]+(\.[a-z0-9-]+)*\.eth\b/i)?.[0];
  if (addr) return addr;
  if (/^(no|nope|none|nah|n\/a)\b|no thanks|don'?t pay|not needed/i.test(t)) return 'no thanks';
  return t.slice(0, 200);
}
// yes / anonymous / no. Anything that isn't a clear yes or anonymous is a no: nothing is published on a guess.
function publishAnswer(text: string) {
  const t = text.trim().toLowerCase();
  if (/anon/.test(t)) return 'anonymous';
  if (/^(no|nope|nah|don'?t|do not)\b/.test(t)) return 'no';
  if (/^(yes|yep|yeah|sure|ok|okay|fine|go ahead|y)\b/.test(t)) return 'yes';
  return 'no';
}
app.post('/api/s/:token/stop', async c => {
  const s = getSession('token', c.req.param('token'));
  if (!s || s.state.done) return c.json({ ok: false });
  const r = getRound(s.round_id)!;
  finish(s, r, `Thanks for your time.`);
  return c.json({ ok: true, receipt: s.receipt });
});

// The receipt: the atom both legs share
function receipt(s: any, r: any, tr: Turn[], st: State) {
  const asked = new Set(tr.filter(t => t.role === 'agent' && t.kind === 'main').map(t => t.item)).size;
  const answered = new Set(tr.filter(t => t.role === 'user' && (t.item ?? -1) >= 0).map(t => t.item));
  const mins = Math.max(1, Math.round((Date.parse(s.done_at ?? now()) - Date.parse(s.created_at)) / 60000));
  return {
    session: s.id, handle: s.handle ?? 'anon', who: st.who ?? '', minutes: mins,
    asked, followed_up: st.followups, skipped: st.skipped,
    inference_cents: s.cost_cents, bounty_cents: r.bounty_cents,
    moved: r.brief.unknowns.map((_: any, i: number) => ({ i, touched: answered.has(i) })),
  };
}

// One-session report, written when the session ends
async function writeReport(sid: string) {
  const s = getSession('id', sid)!; const r = getRound(s.round_id)!;
  const rep = await makeReport(r.brief, s.transcript.filter((t: Turn) => t.kind !== 'closeq'), s.state.who ?? '');
  s.cost_cents += rep.cost_cents; charge(r.id, rep.cost_cents);
  s.report = { ...rep.data, generated_at: now(), cost_cents: rep.cost_cents, model: rep.model };
  // true up from the gateway: what this session actually cost, brief to report
  const gb = await gatewayBalance('round').catch(() => null);
  if (gb && s.state.used_at_start != null) {
    const real = Math.max(1, Math.round((gb.used - s.state.used_at_start) * 100));
    charge(r.id, real - s.cost_cents); s.cost_cents = real;
  }
  if (s.receipt) s.receipt.inference_cents = s.cost_cents;
  saveSession(s);
  writeSynthesis(r.id).catch(e => console.error('[synthesis]', e));
  return s.report;
}

const _synLock = new Map<string, Promise<any>>();
async function writeSynthesis(roundId: string) {
  const running = _synLock.get(roundId);
  if (running) return running;
  const p = _writeSynthesisInner(roundId).finally(() => _synLock.delete(roundId));
  _synLock.set(roundId, p);
  return p;
}
async function _writeSynthesisInner(roundId: string) {
  const r = getRound(roundId)!;
  const rows = db.prepare('select * from sessions where round_id=? and done_at is not null order by created_at').all(roundId) as any[];
  const packs = rows.map(row => {
    const s = getSession('id', row.id)!;
    if (!s.report) return null;
    const rep = s.report;
    return {
      handle: s.handle || s.receipt?.handle || 'someone',
      who: rep.who || s.receipt?.who || s.state?.who || '',
      takeaways: rep.takeaways || [],
      surprising: rep.surprising || '',
      change_if_true: rep.change_if_true || '',
      items: (rep.items || []).map((it: any) => ({ i: it.i, status: it.status, claim: it.claim })),
    };
  }).filter(Boolean) as any[];
  if (!packs.length) return null;
  const syn = await makeRoundReport(r.brief, packs);
  charge(r.id, syn.cost_cents);
  const ids = rows.map(x => x.id);
  const payload = { ...syn.data, generated_at: now(), cost_cents: syn.cost_cents, session_count: packs.length };
  db.prepare('update rounds set synthesis=?, synthesis_at=?, synthesis_session_ids=? where id=?')
    .run(JSON.stringify(payload), now(), JSON.stringify(ids), roundId);
  return payload;
}

function synthesisStale(r: any, doneIds: string[]) {
  if (!r.synthesis) return doneIds.length > 0;
  const had: string[] = r.synthesis_session_ids || [];
  if (had.length !== doneIds.length) return true;
  return doneIds.some(id => !had.includes(id));
}

app.post('/api/sessions/:id/report', async c => {
  const s = getSession('id', c.req.param('id'));
  if (!s) return c.json({ error: 'not found' }, 404);
  const r = getRound(s.round_id);
  if (!r || !checkKey(c, r)) return c.json({ error: 'unauthorized' }, 403);
  return c.json(aliased(r.id, await writeReport(c.req.param('id'))));
});
app.post('/api/rounds/:id/synthesis', async c => {
  const r = getRound(c.req.param('id'));
  if (!r) return c.json({ error: 'not found' }, 404);
  if (!checkKey(c, r)) return c.json({ error: 'unauthorized' }, 403);
  try {
    const syn = await writeSynthesis(c.req.param('id'));
    if (!syn) return c.json({ error: 'No finished sessions yet.' }, 400);
    return c.json(aliased(r.id, syn));
  } catch (e) {
    console.error('[synthesis]', e);
    return c.json({ error: 'Synthesis failed. Try again.' }, 502);
  }
});
app.get('/api/sessions/:id', c => {
  const s = getSession('id', c.req.param('id'));
  if (!s) return c.json({ error: 'not found' }, 404);
  const r = getRound(s.round_id)!;
  if (!checkKey(c, r)) return c.json({ error: 'unauthorized' }, 403);
  return c.json(aliased(r.id, { ...s, brief: publicBrief(r.brief), round_id: r.id }));
});

export { app };
const port = Number(process.env.PORT || 3010);
if (process.env.UNKNOWN_NO_LISTEN !== '1') serve({ fetch: app.fetch, port });
console.log(`(un)known on http://localhost:${port} · model ${live ? MODEL : 'mock (no key)'} · money ${moneyLive ? 'live on chain 4663' : 'stub'}`);
