// The agent way in, the two close questions, and MVA's token (PO, Oct 22). Mock model, no wallet, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set before the server loads so dotenv leaves them alone: empty key = mock model, empty wallet = stub money.
Object.assign(process.env, {
  DB_PATH: join(mkdtempSync(join(tmpdir(), 'unknown-test-')), 'app.db'), UNKNOWN_NO_LISTEN: '1',
  ORBIO_API_KEY: '', WALLET_PRIVATE_KEY: '', FUND_TESTING: '', TEST_ON_PREP_KEY: '', PUBLIC_URL: '',
  UNKNOWN_MVA_TOKEN: 'test-mva-token',
});
globalThis.fetch = (async (u: any) => { throw new Error('network in test: ' + u); }) as any;
const { app } = await import('../src/server.ts');
const { CLOSE_QS } = await import('../src/prompts.ts');

const brief = {
  project: 'TEST project', one_line: 'A test product for test people.',
  screener: [{ q: 'How long have you been at it?', options: ['new', 'a year', 'years'] }, { q: 'Last week, what did you do?', options: ['a', 'b', 'c'] }],
  opener: 'How does this fit into your week?',
  unknowns: [0, 1, 2, 3, 4].map(i => ({ q: `founder question ${i}`, ask: `Think of the last time ${i}. Walk me through it.`, because: 'gap' })),
  dont_ask: ['would you use it'],
};
const AUTH = { authorization: 'Bearer test-mva-token' };
const LONG = 'Last Tuesday I opened the app after work, looked at the numbers, sent some to a friend, and then closed it again because it was late.';
// app.request answers synchronously for sync handlers; always treat it as a promise.
const req = (path: string, init?: RequestInit) => Promise.resolve(app.request(path, init));
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const createRound = (headers: Record<string, string> = {}) =>
  req('/api/rounds', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ brief, interviews: 5, bounty_cents: 0 }) }).then(r => r.json() as any);
const txt = (path: string, headers: Record<string, string> = {}) => req(path, { headers }).then(async r => ({ status: r.status, body: await r.text() }));
const tokenOf = (body: string) => body.match(/\/s\/([a-z0-9]+)\.txt/)![1];

test('a round without the MVA token is not live until funded, as before', async () => {
  for (const h of [{}, { authorization: 'Bearer wrong' }]) {
    const r = await createRound(h);
    assert.equal(r.invite_url, undefined);
    assert.equal((await txt(`/r/${r.id}.txt`)).status, 404);
    assert.equal((await req(`/api/rounds/${r.id}`, { headers: AUTH })).status, 403, 'token does not open rounds it did not create');
  }
});

test('MVA token: round is live at once, readable with the token, links returned', async () => {
  const r = await createRound(AUTH);
  assert.equal(r.invite_url, `http://localhost/r/${r.id}`);
  assert.equal(r.agent_url, `http://localhost/r/${r.id}.txt`);
  const R = await req(`/api/rounds/${r.id}`, { headers: AUTH }).then(x => x.json() as any);
  assert.equal(R.owner, 'mva'); assert.equal(R.tx, 'mva'); assert.equal(R.balance_cents, 125);
  assert.equal((await req(`/api/rounds/${r.id}`, { headers: { authorization: 'Bearer nope' } })).status, 403);
  assert.equal((await req(`/api/rounds/${r.id}?key=${r.key}`)).status, 200, 'the round key still works');
});

test('/r/:id.txt explains without starting a session; text also on Accept or ?format=text; HTML still redirects', async () => {
  const r = await createRound(AUTH);
  const h = await txt(`/r/${r.id}.txt`);
  assert.equal(h.status, 200);
  for (const s of [`/r/${r.id}/start.txt`, '/answer.txt?text=', 'status: done', 's1=', 'How long have you been at it?', `/api/r/${r.id}/start`]) assert.ok(h.body.includes(s), s);
  assert.ok((await txt(`/r/${r.id}`, { accept: 'text/plain' })).body.includes('/start.txt'));
  assert.ok((await txt(`/r/${r.id}?format=text`)).body.includes('/start.txt'));
  const R = await req(`/api/rounds/${r.id}`, { headers: AUTH }).then(x => x.json() as any);
  assert.equal(R.sessions.length, 0, 'reading the how-to costs nothing');
  const html = await req(`/r/${r.id}`);
  assert.equal(html.status, 302); assert.match(html.headers.get('location')!, /^\/s\/[a-z0-9]+$/);
});

test('a whole session over GET text links: five unknowns, then the two close questions, stored and shown to the owner', async () => {
  const r = await createRound(AUTH);
  let t = await txt(`/r/${r.id}/start.txt`);
  assert.ok(t.body.includes('Interviewer: How does this fit into your week?'));
  const tok = tokenOf(t.body);
  t = await txt(`/s/${tok}/answer.txt?text=${encodeURIComponent(LONG)}&handle=tester&s1=years&s2=a%2C%20b`);
  assert.ok(t.body.includes('question 1 of 5'));
  for (let i = 0; i < 5; i++) t = await txt(`/s/${tok}/answer.txt?text=${encodeURIComponent(LONG)}`);
  assert.ok(t.body.includes('closing question 1 of 2')); assert.ok(t.body.includes(CLOSE_QS[0]));
  t = await txt(`/s/${tok}/answer.txt?text=${encodeURIComponent('send it to 0x1111111111111111111111111111111111111111 thanks')}`);
  assert.ok(t.body.includes(CLOSE_QS[1]));
  t = await txt(`/s/${tok}/answer.txt?text=${encodeURIComponent('yes, but anonymous please')}`);
  assert.ok(t.body.includes('status: done'));
  assert.ok((await txt(`/s/${tok}`, { accept: 'text/plain' })).body.includes('status: done'));
  await wait(50); // the writeup runs after the reply

  const R = await req(`/api/rounds/${r.id}`, { headers: AUTH }).then(x => x.json() as any);
  const s = R.sessions[0];
  assert.equal(s.handle, 'tester'); assert.ok(s.done_at); assert.equal(s.abandoned, false);
  assert.equal(s.wallet, '0x1111111111111111111111111111111111111111'); assert.equal(s.publish, 'anonymous');
  assert.equal(s.receipt.asked, 5, 'the five unknowns all asked');
  const full = await req(`/api/sessions/${s.id}`, { headers: AUTH }).then(x => x.json() as any);
  assert.equal(full.wallet, s.wallet); assert.equal(full.publish, 'anonymous');
  assert.deepEqual(full.state.screener, ['years', 'a, b']);
  assert.equal(full.report.items.length, 5);
  // no follow-up, no model call on the close answers: each close question follows straight on
  const closeTurns = full.transcript.filter((x: any) => x.kind === 'closeq').map((x: any) => x.role);
  assert.deepEqual(closeTurns, ['agent', 'user', 'agent', 'user']);
});

test('JSON flow: start by POST, short answers get the follow-up as before, short close answers are taken', async () => {
  const r = await createRound(AUTH);
  const st = await req(`/api/r/${r.id}/start`, { method: 'POST' }).then(x => x.json() as any);
  assert.equal(st.question, brief.opener); assert.equal(st.text_url, `http://localhost/s/${st.token}.txt`);
  const post = (text: string) => req(`/api/s/${st.token}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).then(x => x.json() as any);
  let a = await post('not much really');
  assert.equal(a.transcript.at(-1).kind, 'followup', 'the interview itself is unchanged: thin answer, one probe');
  a = await post(LONG);
  for (let i = 0; i < 5; i++) a = await post(LONG);
  assert.equal(a.state.close, 0);
  a = await post('no thanks');
  assert.equal(a.state.close, 1);
  a = await post('no');
  assert.equal(a.state.done, true);
  const s = (await req(`/api/rounds/${r.id}`, { headers: AUTH }).then(x => x.json() as any)).sessions[0];
  assert.equal(s.wallet, 'no thanks'); assert.equal(s.publish, 'no');
});

test('publish consent: anything unclear is stored as no; ENS is pulled out of a sentence', async () => {
  const r = await createRound(AUTH);
  const run = async (wallet: string, publish: string) => {
    const st = await req(`/api/r/${r.id}/start`, { method: 'POST' }).then(x => x.json() as any);
    for (let i = 0; i < 6; i++) await txt(`/s/${st.token}/answer.txt?text=${encodeURIComponent(LONG)}`);
    await txt(`/s/${st.token}/answer.txt?text=${encodeURIComponent(wallet)}`);
    await txt(`/s/${st.token}/answer.txt?text=${encodeURIComponent(publish)}`);
  };
  await run('pay me at bence.eth please', 'maybe, ask me later');
  await run('nah', 'Yes');
  const S = (await req(`/api/rounds/${r.id}`, { headers: AUTH }).then(x => x.json() as any)).sessions;
  assert.deepEqual(S.map((s: any) => [s.wallet, s.publish]), [['bence.eth', 'no'], ['no thanks', 'yes']]);
});

test('text links on a missing session or round say so', async () => {
  assert.equal((await txt('/s/nosuchtoken0000000000.txt')).status, 404);
  assert.equal((await txt('/r/nosuchround.txt')).status, 404);
  assert.equal((await txt('/r/nosuchround/start.txt')).status, 404);
});
