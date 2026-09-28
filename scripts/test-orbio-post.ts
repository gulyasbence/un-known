// Probe Orbio's social.post: what it accepts, whether a post goes live, and what it costs.
// Posts to the X account connected to the Orbio key. No reply attempt: the schema rejects any
// field it doesn't list, so replyToTweetId can't pass.
// Run: pnpm exec tsx scripts/test-orbio-post.ts
import 'dotenv/config';

const KEY = process.env.ORBIO_API_KEY;
if (!KEY) { console.error('ORBIO_API_KEY is not set in .env'); process.exit(1); }

const BASE = 'https://api.orbio.so/api/v1';
const CATALOGUE = 'https://www.orbio.so/api/v1/tools';
const headers = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

const show = (label: string, v: unknown) => console.log(`\n=== ${label}\n${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function call(tool: string, body: unknown) {
  const res = await fetch(`${BASE}/tools/${tool}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

// Find a value by key name anywhere in a response, since the exact shape isn't documented.
function find(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] != null && typeof obj[k] !== 'object') return obj[k];
  for (const v of Object.values(obj)) { const hit = find(v, keys); if (hit != null) return hit; }
  return undefined;
}
const tweetIdFrom = (s: unknown) => String(s ?? '').match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/)?.[1];
const linkIn = (obj: unknown) => JSON.stringify(obj ?? '').match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^"\s]+\/status\/\d+/)?.[0];

// ---------- Step 1: what social.post and social.post.status accept
const cat = await fetch(CATALOGUE, { headers });
const catJson: any = await cat.json().catch(() => null);
const tools: any[] = Array.isArray(catJson) ? catJson : catJson?.tools ?? catJson?.data ?? [];
const byName = (n: string) => tools.find(t => (t.name ?? t.id ?? t.slug) === n);
const postTool = byName('social.post');
const statusTool = byName('social.post.status');
show('social.post (catalogue entry)', postTool ?? `not found (catalogue HTTP ${cat.status}, ${tools.length} tools)`);
show('social.post.status (catalogue entry)', statusTool ?? 'not found');
const postSchema = postTool?.input_schema ?? postTool?.inputSchema ?? postTool?.parameters ?? postTool?.schema;
const accepted = Object.keys(postSchema?.properties ?? {});

// ---------- Step 2: one standalone post, then its status
const post = await call('social.post', { text: 'hello. testing.', platforms: ['twitter'], max_cost: '0.03' });
show(`social.post → HTTP ${post.status}`, post.json ?? post.text);
// status takes only post_id (the schema sets additionalProperties: false)
const postId = post.json?.result?.post_id;   // not the top-level id, which is the call's own id
const cost = find(post.json, ['credit']) ?? find(post.json, ['cost']);

let status: any = null, link: string | undefined = linkIn(post.json);   // the post response often carries the live URL already
if (post.ok && postId) {
  // Publishing can be async: poll status (not the post) until a link shows up.
  for (let i = 0; i < 8 && !link; i++) {
    const s = await call('social.post.status', { post_id: String(postId) });
    status = s.json ?? s.text;
    link = linkIn(s.json) ?? find(s.json, ['url', 'link', 'permalink', 'platform_url']);
    if (!link) await sleep(4000);
  }
  show('social.post.status', status);
}
const tweetId = tweetIdFrom(link);
show('extracted', { postId, link, tweetId, cost });

// ---------- Summary
console.log(`
=== SUMMARY
social.post accepts: ${accepted.length ? accepted.join(', ') : 'schema not found in the catalogue'}
first post:          ${link ? `live at ${link}` : post.ok ? 'accepted, no live link yet' : `failed (HTTP ${post.status})`}
cost:                ${cost ?? 'not reported'}
replies:             ${accepted.some(k => /reply/i.test(k)) ? 'a reply field is in the schema' : 'not possible: no reply field in the schema, and unknown fields are rejected'}`);
