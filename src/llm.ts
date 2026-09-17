import OpenAI from 'openai';
const key = process.env.ORBIO_API_KEY;
export const MODEL = process.env.ORBIO_MODEL || 'anthropic/claude-sonnet-4.5';
const client = key ? new OpenAI({ apiKey: key, baseURL: process.env.ORBIO_BASE_URL || 'https://api.orbio.so/api/v1', defaultHeaders: { 'HTTP-Referer': 'https://orbio.so/build', 'X-Title': 'Five Unknowns' } }) : null;
export const live = !!client;

export type LlmResult<T> = { data: T; cost_cents: number; balance: string | null; tokens: { in: number; out: number } };

// One call, JSON out. Cost from the balance header when Orbio sends it, else a token estimate.
export async function json<T>(system: string, user: string, mock: () => T): Promise<LlmResult<T>> {
  if (!client) return { data: mock(), cost_cents: 0, balance: null, tokens: { in: 0, out: 0 } };
  const { data: res, response } = await client.chat.completions.create({
    model: MODEL, temperature: 0.4,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
  }).withResponse();
  const text = res.choices[0]?.message?.content ?? '{}';
  const tokens = { in: res.usage?.prompt_tokens ?? 0, out: res.usage?.completion_tokens ?? 0 };
  // Sonnet-class rate as fallback: $3/M in, $15/M out
  const est = tokens.in * 0.0003 + tokens.out * 0.0015;
  const balance = response.headers.get('x-orbio-balance');
  const cost_cents = Math.max(1, Math.round(est));
  let data: T;
  try { data = JSON.parse(text.replace(/^```json\s*|```$/g, '')); } catch { data = mock(); }
  return { data, cost_cents, balance, tokens };
}
