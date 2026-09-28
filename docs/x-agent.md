# X agent: work log

Ongoing work after Build Week on moving (un)known to X, where crypto users already complain in public. The plan is in the README under "Next: interviews where the complaints already are". This file records what was tested and what it changed, newest entries at the top.

## 2026-09-28

What we ran: `scripts/test-orbio-post.ts` (one real post) and `scripts/test-orbio-read.ts` (read-only), plus one mentions check after a reply to the test post.

- Posting works. A post through `social.post` went live from @un_known_tool immediately, at 0.0187 CREDIT.
- `social.post` accepts only `text`, `platforms` and `max_cost`, and rejects any other field. So no replies, threads or links through Orbio today.
- The reported `cost.credit` matched the real drop in the key's balance on every call.
- Search is billed per page, about 0.0044 CREDIT, and was noisy in our sample: about 3 of 20 posts were real complaints, most of the rest were fomo referral ads.
- Thread reads (`conversation_id`) return nested replies too, not only direct ones, and are billed per post returned.
- `mentions_of` returned a reply to the agent within minutes, billed per result. That's how the agent sees answers.
- The new account's own posts aren't findable by search yet. Likely X holding back new accounts; unverified.

Next:

- Tighten the search query to cut the referral noise.
- Decide the reply route: Zernio directly or the X API.
- Ask Orbio about reply support in `social.post`.
