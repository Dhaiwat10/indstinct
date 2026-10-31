# indstinct — build plan

An Instinct-style personal AI agent on WhatsApp, for Indians, with every token of inference running inside a NEAR AI TEE. Built in ~1 week for the NEAR hackathon (start 2026-10-31).

This document is the spec. Each day has a "done means" line; if that line isn't true by end of day, cut scope from later days rather than slipping.

---

## 0. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| WhatsApp transport | **Baileys** on a spare SIM | Proactive messages (reminders, cron) work with zero approval. Official Cloud API needs templates for anything outside a 24h window. Against ToS → never use a personal number. |
| Build | **From scratch**, TypeScript | ~2–3k lines. Own the story; judges discount config-only forks. OpenClaw is a reference/fallback only. |
| Inference | **NEAR AI Cloud**, Confidential-TEE tier only | `https://cloud-api.near.ai/v1`, OpenAI-compatible. Tier `owned_by: nearai` = NEAR's own GPUs, fully attestable. Don't use Incognito-tier (OpenAI/Anthropic/Google) models — weak story. |
| Agent runtime | **Vercel AI SDK** (`ai` + `@ai-sdk/openai-compatible`) | Tool loop, multi-step, structured output for free. Custom `fetch` lets us capture raw bytes for verification. |
| Storage | **SQLite** (`better-sqlite3`), one file | One process, one disk. No queues, no vector DB. |
| Memory retrieval | **None** — inject all of a user's memories into the system prompt | Hundreds of facts fit trivially in a 262k context. Retrieval is a Day-9 problem. |
| Hosting | One Node 22 process on a small VPS (docker compose, persistent `./data`) | Baileys needs a persistent auth dir and a long-lived socket. |

### Models (verified from `/v1/models` on 2026-10-31)

All in the Confidential-TEE tier (`owned_by: nearai`):

| Role | Model | Notes |
|---|---|---|
| Primary chat + tools | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | tools ✅ 1M ctx, no vision. **Chosen by the Day-1 benchmark** (`pnpm bench:tools`, 2026-10-31): 24/24 tool checks, p50 4.0s / p90 6.5s — vs Qwen3.8-27B 23/24, 4.8s / 10.7s; GLM-5.3-flash 23/24, 6.5s / 14.5s; Qwen3.6-35B 23/24, 6.1s / 17.9s. |
| Image turns | `Qwen/Qwen3.8-27B` | tools ✅ vision ✅ 262k ctx (`MODEL_VISION`) |
| Heavy tasks (cron research, browsing) | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | tools ✅ 1M ctx, no vision |
| Memory extraction (cheap, structured) | `Qwen/Qwen3.6-35B-A3B-FP8` | tools ✅ structured_outputs ✅ |
| Voice notes | `openai/whisper-large-v3` | Check `/v1/audio/transcriptions` works (OpenAI-compatible suggests yes). |
| Images (fallback if primary vision is weak) | `Qwen/Qwen3-VL-30B-A3B-Instruct` | vision only, no tools, 16k ctx |

Fallback if TEE-tier tool calling is unreliable: `z-ai/glm-5.3` or `moonshotai/kimi-k3` (Attested-3P tier — still TEE, still verifiable, just third-party hardware).

---

## 1. Architecture

```
                 ┌──────────────────────────────────────────────────────────────┐
  WhatsApp ◄────►│ src/wa/        Baileys socket, QR pairing, inbound → events,  │
  (spare SIM)    │                outbound send(jid, text), typing indicator,     │
                 │                media download (voice/images), 2.5s debounce    │
                 └───────────────┬──────────────────────────────────────────────┘
                                 ▼
                 ┌──────────────────────────────────────────────────────────────┐
                 │ src/agent/     buildSystemPrompt(user) + history → generateText│
                 │                tools: remember, forget, todo_*, set_reminder,  │
                 │                schedule_recurring, cancel_schedule,            │
                 │                web_search, browse, update_profile              │
                 │                post-turn: extractMemories() (async, cheap)     │
                 └───────┬────────────────────────┬─────────────────────────────┘
                         ▼                        ▼
                 ┌──────────────┐        ┌──────────────────────────────────────┐
                 │ src/nearai/  │        │ src/db/   SQLite                      │
                 │ client w/    │        │ users · messages · memories · todos   │
                 │ raw-byte     │        │ schedules · inference_log             │
                 │ capture,     │        └──────────────────────────────────────┘
                 │ /verify flow │                 ▲
                 └──────────────┘                 │
                 ┌────────────────────────────────┴─────────────────────────────┐
                 │ src/scheduler/  setInterval(30s): due schedules → send text   │
                 │                 or run agent with the stored prompt → send    │
                 └──────────────────────────────────────────────────────────────┘
```

Everything is one process: `src/index.ts` boots db → nearai client → Baileys → scheduler.

### Repo layout

```
indstinct/
  PLAN.md
  README.md
  package.json            # pnpm, Node 22, tsx for dev, tsc for build
  .env.example
  docker-compose.yml      # one service, ./data mounted
  data/                   # gitignored: indstinct.db, auth/ (Baileys creds)
  src/
    index.ts              # boot + graceful shutdown
    config.ts             # env parsing (zod)
    wa/
      socket.ts           # Baileys connect/reconnect, QR to terminal, auth state
      inbound.ts          # normalize messages (text/voice/image), debounce, allowlist
      outbound.ts         # send text (split >4000 chars), typing, WhatsApp markdown
      media.ts            # download voice/image buffers
    nearai/
      client.ts           # createOpenAICompatible + capturing fetch
      capture.ts          # store raw request/response bytes + completion id
      verify.ts           # signature fetch, EIP-191 recover, attestation match
      transcribe.ts       # whisper
    agent/
      prompt.ts           # persona, user profile, memories, time, language rules
      run.ts              # generateText loop, history window, tool wiring
      tools/              # one file per tool, each exports { name, tool }
      memory-extract.ts   # post-turn structured extraction
    scheduler/
      tick.ts             # due-job loop
      next-run.ts         # croner next occurrence in user tz
    browse/
      stagehand.ts        # plan A
      playwright-tools.ts # plan B
    db/
      schema.sql
      index.ts            # better-sqlite3, migrations on boot, typed queries
    commands.ts           # slash commands handled without the LLM
  scripts/
    bench-tools.ts        # Day-1 model tool-calling benchmark
```

---

## 2. Data model (`src/db/schema.sql`)

```sql
users        (id TEXT PK /* wa jid */, phone, name, city, language TEXT DEFAULT 'auto',
              timezone TEXT DEFAULT 'Asia/Kolkata', onboarded_at, created_at)

messages     (id PK, user_id, role 'user'|'assistant'|'tool'|'system', content TEXT,
              tool_calls JSON, tool_call_id, wa_message_id, created_at)
             -- history window = last 30 rows per user

memories     (id PK, user_id, content TEXT, category 'person'|'preference'|'fact'|'event'|'other',
              source 'explicit'|'inferred', created_at, updated_at, archived_at)

todos        (id PK, user_id, title, notes, due_at, done_at, created_at)

schedules    (id PK, user_id, kind 'reminder'|'cron', run_at, cron_expr,
              payload_kind 'text'|'agent', payload TEXT, description,
              last_run_at, next_run_at, active INTEGER DEFAULT 1, created_at)

inference_log(id PK, user_id, message_id, completion_id /* from response.id */, model,
              request_sha256, response_sha256, request_raw BLOB, response_raw BLOB,
              signature JSON /* cached /v1/signature result */, verified_at, created_at)
```

Rules:
- `run_at`/`next_run_at` stored as UTC ISO; computed from the user's `timezone`.
- `inference_log` keeps **exact bytes** — never re-serialized JSON — because NEAR AI signs `sha256(request_bytes):sha256(response_bytes)`.

---

## 3. The agent

### System prompt (`agent/prompt.ts`), assembled per turn
1. **Persona**: "You are Indstinct, a personal assistant living in WhatsApp. Warm, brief, practical. Indian context by default (IST, ₹, lakh/crore, UPI, IRCTC, cricket, festivals)."
2. **Language rule**: mirror the user — reply in the language *and script* they used (English, Hindi, Hinglish in Latin script, Gujarati, Tamil, …). Never switch unprompted.
3. **WhatsApp formatting**: `*bold*`, `_italic_`, bullets with `•`. No markdown headers, no tables, no code fences. Short paragraphs. One emoji max unless they use more.
4. **Now**: current time in the user's tz, day of week, date.
5. **User profile**: name, city, language, timezone.
6. **Memories**: all non-archived, grouped by category, newest first. (This is what makes it feel like Instinct.)
7. **Open to-dos** and **upcoming schedules** (next 5) — so it can answer "what's on today" without a tool call.
8. **Tool guidance**: when to `remember` (any durable fact about the user or their people), when to schedule vs todo, confirm times back in words ("Done — I'll ping you tomorrow at 7:30 am").

### Loop (`agent/run.ts`)
- Input: user row, normalized inbound text (voice → transcript, image → vision description or direct image part).
- History: last 30 `messages` rows for the user.
- `generateText({ model: primary, system, messages, tools, stopWhen: stepCountIs(8) })`.
- Persist user msg, tool calls/results, assistant msg. Log inference (see §5).
- Send reply. If the reply is empty after tool use, send a short confirmation.
- Fire-and-forget `extractMemories(user, lastExchange)`.

### Tools (`agent/tools/`)
| Tool | Args | Behaviour |
|---|---|---|
| `remember` | `fact, category` | Insert memory `source=explicit`. Dedupe by fuzzy match (lowercase contains) → update instead. |
| `forget` | `query` | Archive matching memories; return what was archived. |
| `add_todo` / `complete_todo` / `list_todos` | obvious | `complete_todo` matches by id or title substring. |
| `set_reminder` | `at_iso, text` | Insert `schedules(kind=reminder, payload_kind=text)`. Model converts "kal subah 7 baje" → ISO using "Now" in prompt. Reject past times. |
| `schedule_recurring` | `cron_expr, prompt, description` | `kind=cron, payload_kind=agent`. e.g. `0 8 * * *` + "Send me today's top 3 Indian startup news with links". |
| `list_schedules` / `cancel_schedule` | | |
| `web_search` | `query, recency?, news?` | Tavily, top 5 dated results + summary; the output starts with today's date. |
| `read_page` | `url` | Tavily Extract: one page as text, ≤ 8k chars. The rung between search and browse. |
| `browse` | `goal, start_url?` | Runs the browse sub-agent (§6), returns a text result. |
| `update_profile` | `name?, city?, language?, timezone?` | |

### Memory extraction (`agent/memory-extract.ts`)
After every user turn, call the cheap model with `generateObject`: input = last 2 exchanges + existing memory list; output = `{ add: [{content, category}], update: [{id, content}], none: boolean }`. Only durable facts (people, preferences, dates, places, ongoing situations) — not chit-chat. `source=inferred`. This catches "my mom's flight lands on the 4th" without the user saying "remember".

### Onboarding
First message from an unknown jid → short welcome, ask name + city + preferred language in one message, store via `update_profile`. Allowlist (`ALLOWED_NUMBERS` env, comma-separated) during the hackathon to avoid randoms burning credits.

### Slash commands (`commands.ts`, no LLM)
`/verify` (§5) · `/memories` (list with ids) · `/forget <id>` · `/todos` · `/reminders` · `/reset` (clear history, keep memories) · `/help`.

---

## 4. Scheduler (`scheduler/tick.ts`)

Every 30s:
```
SELECT * FROM schedules WHERE active=1 AND next_run_at <= now ORDER BY next_run_at LIMIT 20
```
- `payload_kind=text` → send the text (prefixed "⏰ Reminder:").
- `payload_kind=agent` → run the agent with system note *"This is a scheduled task you set up for the user: {description}. Do it now and reply with the result."* and the payload as the user message, using the heavy model. Send the reply.
- Reminder → `active=0`. Cron → `next_run_at = croner.nextRun(cron_expr, tz)`.
- Wrap each job in try/catch; log; never let one job kill the tick.
- Single-instance guard (a `running` flag) so slow jobs don't overlap ticks.

Also: a nightly 23:00 IST "archive stale done to-dos" job is cheap and keeps prompts tidy. Optional.

---

## 5. Verifiable inference (`nearai/`)

This is the hackathon differentiator — make it a demo moment, not plumbing.

### Capture (every call)
Pass a custom `fetch` to `createOpenAICompatible`:
1. Clone request body bytes → `request_raw`, `request_sha256`.
2. Send with `Accept-Encoding: identity` (or hash after decompression).
3. Read the full response as bytes **before** handing it to the SDK (`new Response(bytes, res)`) → `response_raw`, `response_sha256`.
4. Parse `id` from the response JSON → `completion_id`. Insert `inference_log` row linked to the message.
5. Non-streaming for the main loop (simplifies byte capture; latency is fine on WhatsApp).

### `/verify` (last assistant message, or `/verify <n>`)
1. `GET /v1/signature/{completion_id}?signing_algo=ecdsa` (bearer key). On 404 retry up to ~5× over 10s; cache the result in `inference_log.signature`.
2. Expected `text` for `signature_kind=provider_tee`: `"{model}:{request_sha256}:{response_sha256}"`. Check it matches our stored hashes exactly.
3. Recover the EIP-191 signer with `viem.recoverMessageAddress({ message: text, signature })`; compare to `signing_address`.
4. `GET /v1/attestation/report?model={model}` (cache 1h): confirm the report's `signing_address` equals the signer (ties the key to attested TEE hardware). Full DCAP/NRAS quote verification is **out of scope** — link to the Verification Center and the `nearai/nearai-cloud-verifier` repo for that.
5. Reply:
   ```
   🔐 *Verified private inference*
   Model: Qwen/Qwen3.8-27B (NEAR AI Confidential TEE)
   Request hash: 9f3a…c21e
   Response hash: 41d0…88b7
   Signed by: 0x7c2f…a9d1 ✅ matches TEE attestation
   Nobody — not NEAR, not us — could read this conversation in plaintext.
   Inspect: https://cloud.near.ai/verify
   ```
Edge: if signature unavailable → say so honestly ("signature not available yet, try again in a minute").

Also add `_🔒 private inference_` as an optional footer on the first reply of a session so the property is visible without a command.

---

## 6. Browser use (`browse/`)

Scope to **browser** use; call it "browse" in the product. Text-first, vision as fallback.

**Plan A — Stagehand, local browser, custom LLM client (time-box: 3 hours).** `page.act("…")`, `page.extract(schema)`, `page.observe()` against the NEAR AI OpenAI-compatible endpoint. If it works with Qwen3.8/GLM, the `browse` tool becomes a tiny sub-agent: goto → loop(observe/act/extract) ≤ 10 steps → return text.

**Plan B — raw Playwright tools** (if Stagehand fights the model): `browse_goto(url)`, `browse_read()` → `locator('body').ariaSnapshot()` trimmed to ~8k chars, `browse_click(role, name)`, `browse_type(role, name, text)`, `browse_screenshot()` → image part to the vision model. Sub-agent loop with the heavy model, ≤ 12 steps.

Demo targets (pick 2 that are login-free and stable): IRCTC/ConfirmTkt PNR status, Zomato/Swiggy restaurant menu lookup, Cricbuzz live score, Indian Railways train running status, a government form prefill. Rehearse them; sites change.

Hard limits: no logins, no payments, 60s timeout per browse, headless chromium in the container (`mcr.microsoft.com/playwright` base image).

---

## 7. The "for Indians" layer

- **Voice notes → Whisper** (TEE). Download ogg/opus via Baileys, POST to `/v1/audio/transcriptions`, feed transcript to the agent with a `🎤` prefix. Reply in the same language. Biggest crowd-pleaser; schedule it early (Day 2).
- **Hinglish / regional languages**: handled by the prompt rule + model choice; test Hindi (Devanagari), Hinglish, Gujarati, Tamil on Day 2 and keep the ones that are good.
- **IST everywhere**; "kal subah", "parso", "shaam ko" resolve correctly because "Now" is in the prompt in IST.
- **Images**: send a bill → "add ₹1,240 Swiggy to expenses" (as a memory/todo), send a ticket → auto-create a reminder for departure. Vision model does this; one demo is enough.
- **Message debounce (2.5s)**: people send 3 short messages in a row; respond once.
- **Formatting**: ₹, lakh/crore, dd/mm dates, 12-hour times.

---

## 8. Day-by-day

### Day 1 — it talks
- `pnpm init`, TS, tsx, eslint-less (prettier only), `.env.example`, `docker-compose.yml`.
- Baileys: QR pairing, `useMultiFileAuthState('data/auth')`, reconnect on close, echo bot. Allowlist.
- NEAR AI client with capturing fetch; `inference_log` written.
- `scripts/bench-tools.ts`: 10 prompts that require tool calls (set reminder, remember, search) × {Qwen3.8-27B, glm-5.3-flash, DeepSeek-V4.1-Flash}; score call correctness + latency. **Pick primary.**
- Minimal agent: persona + history + `remember` tool. `/verify` returns the signature check.
- **Done means:** from your phone, you chat with the bot, it remembers your name across restarts, and `/verify` shows a ✅ signature match.

### Day 2 — it remembers and listens
- Full memory: `remember`/`forget`, memory injection, post-turn extraction with `generateObject`.
- Onboarding flow, `update_profile`, `/memories`, `/forget`, `/reset`.
- Voice notes via Whisper. Images via vision model.
- Language tests (Hindi, Hinglish, Gujarati, Tamil); tune prompt.
- **Done means:** tell it about your sister's wedding in a voice note in Hinglish; next day (simulate) ask "what's happening in Dec?" and it knows.

### Day 3 — it pings you
- `schedules` table, tools, croner, tick loop, IST math, past-time rejection.
- Reminders (one-shot text), cron agents (recurring prompt), to-dos.
- `/reminders`, `/todos`. Prompt section listing upcoming items.
- Proactive-message hygiene: never send more than 1 unsolicited message per minute per user.
- **Done means:** "remind me to call mom at 7" fires at 7 IST; "every morning at 8 send me cricket headlines" runs the agent with web search and messages you.

### Day 4 — it does things
- Tavily `web_search`.
- Browser: Stagehand plan A (3h box) else plan B. `browse` tool + sub-agent.
- Rehearse 2 Indian demo flows end-to-end.
- **Done means:** "check PNR 1234567890" returns the real status; "what's the latest on the Bengaluru metro yellow line" returns a sourced answer.

### Day 5 — it's trustworthy and polished
- `/verify` polish: attestation-report cross-check, pretty output, edge cases, footer.
- Error handling: NEAR AI 5xx/timeouts → graceful "give me a sec" + retry; Baileys disconnect → reconnect + log; tool errors surface as plain language.
- Long-message splitting, typing indicator, debounce, rate limits.
- Persona pass: 20 real conversations, fix every awkward reply.
- **Done means:** a 10-minute unscripted conversation has zero embarrassing moments.

### Day 6 — it ships
- VPS: docker compose, `./data` volume, env, restart policy, logs. Pair the SIM there (QR over SSH terminal).
- README: what/why, architecture diagram, NEAR AI verification section with a real `/verify` screenshot, setup steps, model table, honest limitations.
- Demo video (2–3 min): onboarding → voice note in Hinglish → memory recall → reminder fires → cron morning brief → browse PNR → `/verify`. Record on a real phone screen.
- Make the repo public. Submit.
- **Done means:** submitted, with the bot still running on the VPS for judges to message.

### Day 7 — buffer
Judges' number allowlist, bug fixes, nothing new.

---

## 9. Demo script (rehearse it on Day 5)

1. New user says "hi" → onboarding in one message.
2. Voice note (Hinglish): "yaar yaad rakhna, didi ki shaadi 14 December ko Jaipur mein hai" → "Noted! 💛 Didi's wedding, 14 Dec, Jaipur."
3. Text: "remind me kal subah 8 baje to book the train" → confirmation in words.
4. "what do you know about me?" → memories read back naturally.
5. "every morning at 7:30 send me top 3 India business headlines" → scheduled; trigger one manually for the video.
6. Photo of a train ticket → it extracts PNR/date, offers a reminder.
7. "check that PNR" → browse → status.
8. `/verify` → signature ✅ card. Close on: *"Every word of this ran inside a TEE on NEAR AI. Nobody could read it — and here's the proof."*

---

## 10. Risks and the hedge for each

| Risk | Hedge |
|---|---|
| WhatsApp bans the Baileys number | Fresh SIM, warm up for a day with normal chat, no bulk sends, 1 unsolicited msg/min cap. Keep a second SIM ready. Document the official-API migration path in README. |
| Baileys API churn / breaking versions | Pin the exact version on Day 1; don't upgrade. |
| TEE-tier open models flaky at tool calling | Day-1 benchmark decides. Fallbacks: `z-ai/glm-5.3` / `kimi-k3` (Attested-3P, still verifiable). Keep tool schemas small and descriptions explicit. |
| Stagehand doesn't cooperate with the model | 3-hour time-box, then plan B. Only 2 demo flows need to work. |
| Signature not available / hash mismatch | Capture bytes at the fetch layer, non-streaming, `Accept-Encoding: identity`. Retry 404s. Show honest "unavailable" state. |
| Whisper endpoint shape differs | Check on Day 2 morning; fallback is `faster-whisper` locally (loses the TEE story for voice only). |
| Time | Days 1–3 are the product. Days 4–5 are the wow. If Day 3 slips, cut browse to plan B with one demo flow. |

---

## 11. Env (`.env.example`)

```
NEAR_AI_API_KEY=
NEAR_AI_BASE_URL=https://cloud-api.near.ai/v1
MODEL_PRIMARY=deepseek-ai/DeepSeek-V4.1-Flash-1017
MODEL_VISION=Qwen/Qwen3.8-27B
MODEL_HEAVY=deepseek-ai/DeepSeek-V4.1-Flash-1017
MODEL_EXTRACT=Qwen/Qwen3.6-35B-A3B-FP8
MODEL_WHISPER=openai/whisper-large-v3
TAVILY_API_KEY=
ALLOWED_NUMBERS=91XXXXXXXXXX,91YYYYYYYYYY   # empty = allow all
DEFAULT_TZ=Asia/Kolkata
DATA_DIR=./data
LOG_LEVEL=info
```

## 12. Prerequisites (do before Day 1)

- [ ] NEAR AI account, credits added, API key generated → `.env`
- [ ] Spare SIM in a phone with WhatsApp installed (never your personal number)
- [ ] Tavily API key (free tier)
- [ ] VPS account (Hetzner/DO/Fly) for Day 6; local laptop is fine until then
- [ ] Node 22 + pnpm; Docker for the Day-6 image

## 13. Submission checklist

- [ ] Public repo, MIT licence, clean README with architecture diagram + `/verify` screenshot
- [ ] 2–3 min video following §9
- [ ] NEAR AI usage explicit: models used, TEE tier, verification flow, link to Verification Center
- [ ] Bot live on VPS; judges' numbers allowlisted (or allowlist off)
- [ ] Honest "limitations & next steps" section (official WhatsApp API, full DCAP verification, memory retrieval at scale)

---

## 14. Email (Gmail) — added Day 5

Parity target is what Instinct does with a linked Gmail: read/search/summarise, draft and reply from the user's own address, a morning inbox rundown, daytime flags for mail that needs attention, follow-up nudges on threads waiting on a reply, unsubscribe from promos, pull files out of attachments. Reviews of Instinct complain about two things: it sent mail before the user approved the text, and disconnecting didn't delete what it had stored. Both are designed out here.

| Piece | Where | Notes |
|---|---|---|
| OAuth | `src/http/server.ts`, `src/gmail/oauth.ts` | The only HTTP surface. `/gmail` → 15-min single-use link → Google consent (`gmail.modify`, offline) → callback stores tokens in `gmail_accounts` and messages the user on WhatsApp. |
| Gmail client | `src/gmail/client.ts`, `mime.ts` | Raw REST over fetch, auto-refresh, 401 retry, `invalid_grant` → `needs_reauth`. No `googleapis` dependency. MIME is flattened to text (html→text, quoted replies stripped); nothing is cached. |
| Tools | `src/agent/tools/email.ts` | `email_search`, `email_read`, `email_draft`, `email_send`, `email_modify`, `email_unsubscribe`, `email_attachment`. Registered only when the user is connected; scheduled runs get just search+read. |
| Send guard | `email_drafts.created_ms` vs turn start | A draft can't be sent in the turn that wrote it (or rewrote it). The user always sees the text first. Drafts live in Gmail Drafts too, so they can edit there and the edited version is what goes out. |
| Morning brief | prompt guidance only | Opt-in. "Inbox brief every morning at 8" → the normal `schedule_recurring` tool with a prompt the system prompt suggests (last day's important mail + sent threads awaiting a reply). Connecting Gmail never creates a schedule. |
| Inbox watch | `src/gmail/watch.ts` | Opt-in (`email_alerts` tool or `/gmail alerts on`; the cursor starts from the moment it's enabled). Every 5 min: new Primary-inbox mail since `watch_cursor` → `MODEL_EXTRACT` triage (`purpose='triage'`, inside the TEE) → one-line flag with an offer. Caps: proactive gate (1/min), 8 flags/day. |
| Prompt injection | `email_read` output + prompt | Every body is prefixed as untrusted third-party text; the triage prompt says the same. |
| Disconnect | `disconnectGmail()` | Revokes at Google, deletes account + drafts, cancels recurring tasks that read mail, deletes flag messages, strips `email_*` tool traces from history. |

Not done: attachments *to* outgoing mail, HTML replies, Gmail push (we poll), encrypting tokens at rest in SQLite.
