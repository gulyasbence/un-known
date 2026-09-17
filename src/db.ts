import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
mkdirSync('data', { recursive: true });
export const db = new DatabaseSync('data/app.db');
db.exec(`
create table if not exists rounds (
  id text primary key, created_at text, project text, brief text,
  interviews integer, bounty_cents integer, funded_at text, tx text, balance_cents integer
);
create table if not exists sessions (
  id text primary key, round_id text, token text unique, handle text, created_at text, done_at text,
  state text, transcript text, cost_cents integer default 0, receipt text, report text, paid_at text
);
`);
export const id = () => Math.random().toString(36).slice(2, 10);
export const now = () => new Date().toISOString();
export type Unknown = { q: string; ask?: string; because: string };
export type Brief = { project: string; one_line: string; unknowns: Unknown[]; dont_ask: string[] };
export function getRound(rid: string) {
  const r = db.prepare('select * from rounds where id=?').get(rid) as any;
  if (!r) return null;
  return { ...r, brief: JSON.parse(r.brief) as Brief };
}
export function getSession(where: 'id' | 'token', v: string) {
  const s = db.prepare(`select * from sessions where ${where}=?`).get(v) as any;
  if (!s) return null;
  return { ...s, state: JSON.parse(s.state), transcript: JSON.parse(s.transcript), receipt: s.receipt ? JSON.parse(s.receipt) : null, report: s.report ? JSON.parse(s.report) : null };
}
export function saveSession(s: any) {
  db.prepare('update sessions set state=?, transcript=?, cost_cents=?, receipt=?, report=?, done_at=?, handle=?, paid_at=? where id=?')
    .run(JSON.stringify(s.state), JSON.stringify(s.transcript), s.cost_cents, s.receipt ? JSON.stringify(s.receipt) : null, s.report ? JSON.stringify(s.report) : null, s.done_at ?? null, s.handle ?? null, s.paid_at ?? null, s.id);
}
