import OpenAI from 'openai';
import { apiKey } from './money.js';
export const MODEL = process.env.ORBIO_MODEL || 'anthropic/claude-sonnet-4.5';
const BASE = process.env.ORBIO_BASE_URL || 'https://api.orbio.so/api/v1';
const mk = (key: string) => new OpenAI({ apiKey: key, baseURL: BASE, defaultHeaders: { 'HTTP-Referer': 'https://orbio.so/build', 'X-Title': 'Five Unknowns' } });

// Two keys. "prep" is the product's own key (the brief, on us). "round" is the wallet-derived key whose balance the founder funded on chain.
// Without a wallet, "round" falls back to the product key so the flow still runs.
let prep: OpenAI | null = null, round: OpenAI | null = null;
export let live = false;
export async function init() {
  const k = await apiKey('prep'); if (k) prep = mk(k);
  const r = await apiKey('round'); round = r ? mk(r) : prep;
  live = !!(prep || round);
}
export type Scope = 'prep' | 'round';
export type LlmResult<T> = { data: T; cost_cents: number; balance: string | null; tokens: { in: number; out: number } };

export async function json<T>(system: string, user: string, mock: () => T, scope: Scope = 'round'): Promise<LlmResult<T>> {
  const client = scope === 'prep' ? (prep ?? round) : (round ?? prep);
  if (!client) return { data: mock(), cost_cents: 0, balance: null, tokens: { in: 0, out: 0 } };
  const call = () => client.chat.completions.create({
    model: MODEL, temperature: 0.4,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
  }).withResponse();
  let out; try { out = await call(); } catch (e) { console.warn('[llm] retrying once:', (e as Error).message); out = await call(); }
  const { data: res, response } = out;
  const text = res.choices[0]?.message?.content ?? '{}';
  const tokens = { in: res.usage?.prompt_tokens ?? 0, out: res.usage?.completion_tokens ?? 0 };
  const est = tokens.in * 0.0003 + tokens.out * 0.0015;
  const balance = response.headers.get('x-orbio-balance');
  const cost_cents = Math.max(1, Math.round(est));
  let data: T;
  try { data = JSON.parse(text.replace(/^```json\s*|```$/g, '')); } catch { data = mock(); }
  return { data, cost_cents, balance, tokens };
}
