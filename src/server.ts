import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { db, id, now, getRound, getSession, saveSession, type Brief } from './db.js';
import { fund, priceRound, charge, payout } from './money.js';
import { COPY_PROMPT, makeBrief, mainQuestion, openerQuestion, decideFollowup, makeReport, makeWho, type Turn, type State } from './prompts.js';
import { live, MODEL, init } from './llm.js';
import { live as moneyLive, gatewayBalance } from './money.js';
import { balances } from './chain.js';
await init();

const app = new Hono();
const page = (f: string) => (c: any) => c.html(readFileSync(`public/${f}`, 'utf8'));

app.get('/', page('index.html'));
app.get('/round/:id', page('round.html'));
app.get('/round/:id/report', page('report.html'));
app.get('/s/:token', page('session.html'));
app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: p => p.replace(/^\/static/, '') }));

app.get('/api/meta', c => c.json({ live, model: MODEL, money_live: moneyLive, copy_prompt: COPY_PROMPT }));
app.get('/api/health', async c => c.json({ model: live ? MODEL : 'mock', wallet: await balances().catch(e => ({ error: String(e) })), gateway: await gatewayBalance().catch(() => null) }));
// One invite link per round. Opening it spawns a session.
app.get('/r/:id', async c => {
  const r = getRound(c.req.param('id'));
  if (!r || !r.funded_at) return c.text('This round is not live.', 404);
  if (r.balance_cents <= 0) return c.text('This round is out of budget.', 410);
  const sid = id(), token = id() + id();
  const gb = await gatewayBalance().catch(() => null);
  const state: State = { item: -1, asked_followup: false, followups: 0, skipped: 0, done: false, used_at_start: gb?.used ?? null, screener: [], who: '' };
  const transcript: Turn[] = [{ role: 'agent', text: openerQuestion(r.brief), item: -1, kind: 'open' }];
  db.prepare('insert into sessions (id, round_id, token, created_at, state, transcript) values (?,?,?,?,?,?)').run(sid, r.id, token, now(), JSON.stringify(state), JSON.stringify(transcript));
  return c.redirect('/s/' + token);
});

// Column 3
app.post('/api/brief', async c => {
  const { paste } = await c.req.json();
  const r = await makeBrief(paste || '');
  return c.json({ brief: r.data, cost_cents: r.cost_cents, balance: r.balance });
});

// Column 4
app.post('/api/rounds', async c => {
  const { brief, interviews, bounty_cents, paste } = await c.req.json() as { brief: Brief; interviews: number; bounty_cents: number; paste?: string };
  const rid = id();
  db.prepare('insert into rounds (id, created_at, project, brief, interviews, bounty_cents, balance_cents, paste) values (?,?,?,?,?,?,0,?)')
    .run(rid, now(), brief.project, JSON.stringify(brief), interviews, bounty_cents, paste ?? null);
  return c.json({ id: rid, price: priceRound(interviews, bounty_cents) });
});
app.get('/api/rounds/:id', c => {
  const r = getRound(c.req.param('id'));
  if (!r) return c.json({ error: 'no round' }, 404);
  const sessions = (db.prepare('select * from sessions where round_id=? order by created_at').all(r.id) as any[])
    .map(s => ({ id: s.id, token: s.token, handle: s.handle, created_at: s.created_at, done_at: s.done_at, cost_cents: s.cost_cents, receipt: s.receipt ? JSON.parse(s.receipt) : null, paid_at: s.paid_at, has_report: !!s.report }));
  return c.json({ ...r, price: priceRound(r.interviews, r.bounty_cents), sessions });
});
app.post('/api/rounds/:id/fund', async c => {
  const r = getRound(c.req.param('id'));
  if (!r) return c.json({ error: 'no round' }, 404);
  const f = await fund(r.id, r.interviews, r.bounty_cents);
  // one open invite link per round; each opener gets their own session
  return c.json(f);
});

// Column 6: interviewee
app.post('/api/rounds/:id/sessions', async c => {
  const r = getRound(c.req.param('id'));
  if (!r || !r.funded_at) return c.json({ error: 'round not live' }, 400);
  const sid = id(), token = id() + id();
  const state: State = { item: 0, asked_followup: false, followups: 0, skipped: 0, done: false };
  const transcript: Turn[] = [{ role: 'agent', text: mainQuestion(r.brief, 0), item: 0, kind: 'main' }];
  db.prepare('insert into sessions (id, round_id, token, created_at, state, transcript) values (?,?,?,?,?,?)')
    .run(sid, r.id, token, now(), JSON.stringify(state), JSON.stringify(transcript));
  return c.json({ token });
});
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
      tr.push({ role: 'agent', text: `That's all five. Thank you. $${(r.bounty_cents / 100).toFixed(2)} is on its way.`, kind: 'close' });
      s.receipt = receipt(s, r, tr, st);
      await payout(s.id, r.bounty_cents); s.paid_at = now();
      charge(r.id, r.bounty_cents);
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
  s.transcript.push({ role: 'agent', text: `Thanks for the time. $${(r.bounty_cents / 100).toFixed(2)} is on its way.`, kind: 'close' });
  s.receipt = receipt(s, r, s.transcript, s.state);
  await payout(s.id, r.bounty_cents); s.paid_at = now(); charge(r.id, r.bounty_cents);
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

// Column 9: one-session report, written when the session ends
async function writeReport(sid: string) {
  const s = getSession('id', sid)!; const r = getRound(s.round_id)!;
  const rep = await makeReport(r.brief, s.transcript, s.state.who ?? '');
  s.cost_cents += rep.cost_cents; charge(r.id, rep.cost_cents);
  s.report = { ...rep.data, generated_at: now(), cost_cents: rep.cost_cents };
  // true up from the gateway: what this session actually cost, brief to report
  const gb = await gatewayBalance().catch(() => null);
  if (gb && s.state.used_at_start != null) {
    const real = Math.max(1, Math.round((gb.used - s.state.used_at_start) * 100));
    charge(r.id, real - s.cost_cents); s.cost_cents = real;
  }
  if (s.receipt) s.receipt.inference_cents = s.cost_cents;
  saveSession(s); return s.report;
}
app.post('/api/sessions/:id/report', async c => c.json(await writeReport(c.req.param('id'))));
app.get('/api/sessions/:id', c => {
  const s = getSession('id', c.req.param('id'));
  if (!s) return c.json({ error: 'no session' }, 404);
  const r = getRound(s.round_id)!;
  return c.json({ ...s, brief: r.brief, round_id: r.id });
});

const port = Number(process.env.PORT || 3010);
serve({ fetch: app.fetch, port });
console.log(`five unknowns on http://localhost:${port} · model ${live ? MODEL : 'mock (no key)'} · money ${moneyLive ? 'live on chain 4663' : 'stub'}`);
