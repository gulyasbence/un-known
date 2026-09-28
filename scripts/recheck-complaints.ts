// Re-check the kept complaints for named projects with Sonnet 5, then put each surviving post in
// exactly one theme. Read-only: posts nothing, replies to nobody.
// Run: pnpm exec tsx scripts/recheck-complaints.ts --from data/sweeps/a.json:phantom,data/sweeps/b.json:fomo --out data/sweeps/x.json
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { gatewayBalance } from '../src/money.js';
import { init, json, MODEL } from '../src/llm.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const FROM = (arg('from') ?? '').split(',').filter(Boolean).map(s => { const [file, handle] = s.split(':'); return { file, handle }; });
const OUT = arg('out');
if (!FROM.length || !OUT) { console.error('usage: --from file:handle[,file:handle] --out file.json'); process.exit(1); }

type Kept = { id: string; handle: string; created: string; text: string; source: string; reply_to_brand_post?: string };
type Check = { own_experience: 'yes' | 'no'; about_product: 'yes' | 'no'; english: 'yes' | 'no'; keep: boolean; reason: string };

const CHECK_SYS = `You check one X post that was flagged as a complaint about a crypto product. Answer three questions strictly:
- own_experience: "yes" only if the poster describes something that happened to them. Commentary on someone else's problem, news, reviews or general takes are "no".
- about_product: "yes" only if it's about the product itself (the app, wallet, trading, fees, support, bugs). Token price, tokenomics, airdrops, news, the team's politics, other platforms, or someone else's issue are "no".
- english: "yes" if the post is written in English.
keep: true only if all three are "yes".
reason: one line, under 15 words, on why it's kept or dropped.
Return JSON only: {"own_experience": "yes" | "no", "about_product": "yes" | "no", "english": "yes" | "no", "keep": boolean, "reason": string}`;

const THEME_SYS = `You group complaints about one crypto product into recurring themes.
Assign EVERY post to exactly one theme. Name themes in plain words, the way a user would put it (e.g. "app slow or freezing"), under 8 words.
Prefer a few broad themes over many single-post ones; a post that fits nothing goes to a theme called "other".
Return JSON only: {"assignments": [{"id": string, "theme": string}]}, one entry per post, ids copied exactly.`;

const link = (p: Kept) => `https://x.com/${p.handle}/status/${p.id}`;

await init();
const start = await gatewayBalance('prep');
const out: any = { run_at: new Date().toISOString(), model: MODEL, projects: [] };

for (const { file, handle } of FROM) {
  const sweep = JSON.parse(readFileSync(file, 'utf8'));
  const proj = sweep.projects.find((p: any) => String(p.handle).toLowerCase() === handle.toLowerCase());
  if (!proj) { console.log(`@${handle}: not found in ${file}`); continue; }
  const kept: Kept[] = proj.kept ?? [];
  console.log(`\n=== @${proj.handle}: re-checking ${kept.length} kept complaints from ${file}`);

  // ---- Re-check each post
  const checked: (Kept & Check)[] = [];
  for (const k of kept) {
    const user = [`Product: ${proj.name} (@${proj.handle})`, k.reply_to_brand_post ? `This post is a reply under the product's own post: "${k.reply_to_brand_post}"` : null, `Post by @${k.handle}:`, k.text].filter(Boolean).join('\n');
    const r = await json<Check>(CHECK_SYS, user, () => ({ own_experience: 'no', about_product: 'no', english: 'no', keep: false, reason: 'model output unreadable' }), 'prep');
    const c = r.data;
    c.keep = c.own_experience === 'yes' && c.about_product === 'yes' && c.english === 'yes';   // the rule, not the model's say-so
    checked.push({ ...k, ...c });
    process.stdout.write(c.keep ? '+' : '-');
  }
  console.log();
  const keep = checked.filter(c => c.keep);

  // ---- One theme per post, enforced in code
  let themes: { name: string; count: number; posts: any[] }[] = [];
  if (keep.length) {
    const r = await json<{ assignments: { id: string; theme: string }[] }>(THEME_SYS,
      `Product: ${proj.name}\n\n` + keep.map(k => `id: ${k.id}\n@${k.handle}: ${k.text}`).join('\n\n'),
      () => ({ assignments: [] }), 'prep');
    const themeOf = new Map<string, string>();
    for (const a of r.data.assignments ?? []) if (!themeOf.has(String(a.id))) themeOf.set(String(a.id), a.theme || 'other');   // first assignment wins
    const groups = new Map<string, (Kept & Check)[]>();
    for (const k of keep) { const t = themeOf.get(k.id) ?? 'other'; groups.set(t, [...(groups.get(t) ?? []), k]); }
    themes = [...groups.entries()].map(([name, ps]) => ({ name, count: ps.length,
      posts: ps.map(p => ({ handle: p.handle, date: p.created.slice(0, 10), link: link(p), text: p.text, source: p.source })) }))
      .sort((a, b) => b.count - a.count);
  }
  out.projects.push({ handle: proj.handle, name: proj.name, source_file: file, checked, themes });

  console.log(`  kept ${keep.length} of ${checked.length}`);
  for (const c of checked.filter(x => !x.keep)) console.log(`  drop @${c.handle}: ${c.reason}  [own ${c.own_experience} · product ${c.about_product} · english ${c.english}]`);
  for (const t of themes) {
    console.log(`\n  ▸ ${t.name} (${t.count})`);
    for (const p of t.posts) console.log(`     "${p.text}"\n      @${p.handle} · ${p.date} · ${p.link}`);
  }
}

await new Promise(s => setTimeout(s, 3000));
const end = await gatewayBalance('prep');
const cost = start && end ? +(end.used - start.used).toFixed(6) : null;
out.cost = { recheck_and_themes: cost };
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`\n=== SUMMARY`);
for (const p of out.projects) console.log(`  @${p.handle}: ${p.themes.reduce((a: number, t: any) => a + t.count, 0)} of ${p.checked.length} kept, in ${p.themes.length} themes: ${p.themes.map((t: any) => `${t.name} (${t.count})`).join('; ') || 'none'}`);
console.log(`  Re-check and themes cost ${cost ?? '?'} CREDIT on ${MODEL}. Saved to ${OUT}. Nothing was posted.`);
