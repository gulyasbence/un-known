import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { db, id, secret, now, getRound, getSession, saveSession, type Brief } from './db.js';
import { fund, priceRound, charge, payout, releaseBounty, fundTesting, live as moneyLive, gatewayBalance } from './money.js';
import { COPY_PROMPT, makeBrief, mainQuestion, openerQuestion, decideFollowup, makeReport, makeRoundReport, makeWho, type Turn, type State } from './prompts.js';
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
app.get('/s/:token', page('session.html'));
app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: p => p.replace(/^\/static/, '') }));

function checkKey(c: any, r: any) {
  if (!r.secret) return true; // legacy rounds without a secret
  const k = new URL(c.req.url, 'http://x').searchParams.get('key');
  return k === r.secret;
}

app.get('/api/meta', c => c.json({ live, model: MODEL, money_live: moneyLive, copy_prompt: COPY_PROMPT }));
app.get('/api/health', async c => {
  const auth = c.req.header('authorization');
  if (auth !== `Bearer ${process.env.HEALTH_TOKEN || 'local'}`) return c.json({ error: 'unauthorized' }, 403);
  return c.json({ model: live ? MODEL : 'mock', wallet: await balances().catch(e => ({ error: String(e) })), round_key: await gatewayBalance('round').catch(() => null), prep_key: await gatewayBalance('prep').catch(() => null) });
});
// One invite link per round. Opening it spawns a session.
app.get('/r/:id', async c => {
  const r = getRound(c.req.param('id'));
  if (!r || !r.funded_at) return c.text('This round is not live.', 404);
  if (r.balance_cents <= 0) return c.text('This round is out of budget.', 410);
  const sid = id(), token = id() + id();
  const gb = await gatewayBalance('round').catch(() => null);
  const state: State = { item: -1, asked_followup: false, followups: 0, skipped: 0, done: false, used_at_start: gb?.used ?? null, screener: [], who: '' };
  const transcript: Turn[] = [{ role: 'agent', text: openerQuestion(r.brief), item: -1, kind: 'open' }];
  db.prepare('insert into sessions (id, round_id, token, created_at, state, transcript) values (?,?,?,?,?,?)').run(sid, r.id, token, now(), JSON.stringify(state), JSON.stringify(transcript));
  return c.redirect('/s/' + token);
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
  const rid = id(), key = secret();
  db.prepare('insert into rounds (id, created_at, project, brief, interviews, bounty_cents, balance_cents, paste, prep_cents, secret) values (?,?,?,?,?,?,0,?,?,?)')
    .run(rid, now(), brief.project, JSON.stringify(brief), interviews, bounty_cents, paste ?? null, prep_cents ?? 0, key);
  return c.json({ id: rid, key, price: priceRound(interviews, bounty_cents) });
});
const ABANDON_MS = 30 * 60000;
function sweepRound(roundId: string) {
  const cutoff = new Date(Date.now() - ABANDON_MS).toISOString();
  db.prepare(`delete from sessions where round_id=? and done_at is null and created_at < ? and transcript not like '%"role":"user"%'`).run(roundId, cutoff);
  const stale = db.prepare(`select id from sessions where round_id=? and done_at is null and created_at < ?`).all(roundId, cutoff) as any[];
  for (const { id: sid } of stale) {
    const s = getSession('id', sid)!; const r = getRound(roundId)!;
    s.state.done = true; s.state.abandoned = true; s.done_at = now();
    s.receipt = { ...receipt(s, r, s.transcript, s.state), bounty_cents: 0, abandoned: true };
    saveSession(s);
  }
}
function sweepAll() {
  const rounds = db.prepare('select id from rounds where funded_at is not null').all() as any[];
  for (const r of rounds) sweepRound(r.id);
}
setInterval(sweepAll, 5 * 60000);
app.get('/api/rounds/:id', async c => {
  const r0 = getRound(c.req.param('id'));
  if (!r0) return c.json({ error: 'not found' }, 404);
  if (!checkKey(c, r0)) return c.json({ error: 'unauthorized' }, 403);
  const r = r0;
  const sessions = (db.prepare('select * from sessions where round_id=? order by created_at').all(r.id) as any[])
    .map(s => ({ id: s.id, token: s.token, handle: s.handle, created_at: s.created_at, done_at: s.done_at, cost_cents: s.cost_cents, receipt: s.receipt ? JSON.parse(s.receipt) : null, paid_at: s.paid_at, has_report: !!s.report, abandoned: !!JSON.parse(s.state).abandoned }));
  const spent_cents = sessions.reduce((a, s) => a + (s.cost_cents || 0), 0);
  const key = r.funded_at ? await gatewayBalance('round').catch(() => null) : null;
  return c.json({ ...r, price: priceRound(r.interviews, r.bounty_cents), sessions, spent_cents, key_balance_cents: key ? Math.round(key.available * 100) : null, fund_testing: fundTesting || !moneyLive, model: MODEL, synthesis_stale: synthesisStale(r, sessions.filter(x => x.done_at).map(x => x.id)) });
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
  const r = getRound(s.round_id)!;
  const { text, handle, screener } = await c.req.json();
  if (handle) s.handle = handle;
  const st: State = s.state; const tr: Turn[] = s.transcript;
  if (Array.isArray(screener) && screener.length) st.screener = screener;
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
      st.done = true; s.done_at = now();
      tr.push({ role: 'agent', text: `That's all. Thank you for your time.`, kind: 'close' });
      s.receipt = receipt(s, r, tr, st);
      await payout(s.id, r.bounty_cents); s.paid_at = now();
      releaseBounty(r.id, r.bounty_cents);
      saveSession(s); writeReport(s.id).catch(e => console.error('[report]', e));
    } else {
      tr.push({ role: 'agent', text: mainQuestion(r.brief, st.item), item: st.item, kind: 'main' });
    }
  }
  saveSession(s);
  return c.json({ state: st, transcript: tr, receipt: s.receipt ?? null });
});
app.post('/api/s/:token/stop', async c => {
  const s = getSession('token', c.req.param('token'));
  if (!s || s.state.done) return c.json({ ok: false });
  const r = getRound(s.round_id)!;
  s.state.done = true; s.done_at = now();
  s.transcript.push({ role: 'agent', text: `Thanks for your time.`, kind: 'close' });
  s.receipt = receipt(s, r, s.transcript, s.state);
  await payout(s.id, r.bounty_cents); s.paid_at = now(); releaseBounty(r.id, r.bounty_cents);
  saveSession(s); writeReport(s.id).catch(e => console.error('[report]', e));
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
  const rep = await makeReport(r.brief, s.transcript, s.state.who ?? '');
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
  return c.json(await writeReport(c.req.param('id')));
});
app.post('/api/rounds/:id/synthesis', async c => {
  const r = getRound(c.req.param('id'));
  if (!r) return c.json({ error: 'not found' }, 404);
  if (!checkKey(c, r)) return c.json({ error: 'unauthorized' }, 403);
  try {
    const syn = await writeSynthesis(c.req.param('id'));
    if (!syn) return c.json({ error: 'No finished sessions yet.' }, 400);
    return c.json(syn);
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
  return c.json({ ...s, brief: r.brief, round_id: r.id });
});

const port = Number(process.env.PORT || 3010);
serve({ fetch: app.fetch, port });
console.log(`(un)known on http://localhost:${port} · model ${live ? MODEL : 'mock (no key)'} · money ${moneyLive ? 'live on chain 4663' : 'stub'}`);
