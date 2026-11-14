# indstinct

A personal assistant on WhatsApp, built for India, where every AI call runs inside a NEAR AI trusted execution environment (TEE) and any reply can be checked with `/verify`.

Built at NEAR HACKATHON (November 2026). Tracks: Privacy & Private AI, Open Innovation.

**Live bot:** WhatsApp `+91 __________` · site `https://__________`

## The problem

A useful personal assistant needs your most sensitive data: your email, your voice notes, your family's names and dates. With an ordinary assistant, all of it is sent in plaintext to whichever AI company runs the model, and you have no way to check what happened to it.

indstinct sends every model call to NEAR AI Cloud's confidential tier, where the model runs inside a TEE and the provider cannot read the prompt or the reply. The proof is not a promise in a policy page. Send `/verify` and the bot checks the cryptographic evidence for its last reply, in the chat.

## What it does

- **Chat and memory.** Remembers what you tell it (and what it picks up from conversation), in English, Hindi or Hinglish. `/memories` shows everything it holds.
- **Voice notes and images.** Voice notes are transcribed with Whisper; photos go to a vision model. Neither the audio nor the image is stored.
- **Reminders, recurring tasks, to-dos.** "Remind me to call mom at 7", "cricket headlines every morning at 8". Nothing proactive happens unless you ask for it.
- **Live information.** Web search and page reading, with a browser as the last resort.
- **Browser tasks.** Multi-step jobs on websites (a PNR check, a web check-in) that run in the background and stop to ask before anything risky.
- **Gmail (optional).** Search, read and summarise mail, draft replies from your own address, unsubscribe, fetch attachments. A draft can never be sent in the turn that wrote it, so you always see the text first.
- **Deletes that delete.** `/forget`, `/reset`, `/gmail disconnect` and `/delete everything` remove rows, they do not hide them.

Commands: `/verify`, `/gmail`, `/memories`, `/forget <id>`, `/reminders`, `/cancel <id>`, `/todos`, `/done <id>`, `/reset`, `/delete`, `/help`.

## How NEAR fits: private, verifiable inference

Every model call goes to NEAR AI Cloud (`https://cloud-api.near.ai/v1`). No other AI provider is used anywhere in the code; the only client is `src/nearai/client.ts`.

| Role | Model | Env var |
|---|---|---|
| Chat and tool calling | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | `MODEL_PRIMARY` |
| Turns with an image | `Qwen/Qwen3.8-27B` | `MODEL_VISION` |
| Scheduled runs and browser tasks | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | `MODEL_HEAVY` |
| Memory extraction, email triage, page extraction | `Qwen/Qwen3.6-35B-A3B-FP8` | `MODEL_EXTRACT` |
| Voice transcription | `openai/whisper-large-v3` | `MODEL_WHISPER` |

All five were listed in NEAR AI's Confidential TEE tier (`owned_by: nearai`) when checked against `/v1/models` on 2026-10-31. The primary model was picked by a tool-calling benchmark across the TEE-tier models (`pnpm bench:tools`).

### What `/verify` checks

The client hashes the exact bytes of every request and response at the fetch layer (`src/nearai/capture.ts`) and stores only the two SHA-256 hashes. `/verify` (`src/nearai/verify.ts`) then runs four checks on the model call behind the bot's last reply:

1. **The signature covers exactly these bytes.** NEAR AI's signed text for the completion equals `model:sha256(request):sha256(response)` using our own hashes.
2. **The signature is valid.** The ECDSA signature recovers to the signing address NEAR AI reports.
3. **The key belongs to the attested TEE.** A fresh attestation report, requested with a new random 32-byte nonce, lists that signing address for the model.
4. **The hardware quote commits to that key.** The Intel TDX quote's `report_data` contains the signing address and our nonce, so the quote was produced for this request and not replayed.

The reply also links to NEAR AI's Verification Center with the receipt in the URL fragment, for independent hardware verification. What `/verify` does not do itself is listed under [Limitations](#limitations-and-next-steps).

## What is private and what is not

| | |
|---|---|
| **Proven** | Every model call (chat, images, memory extraction, email triage, browser tasks) runs in a NEAR AI TEE, and the call behind any reply is checkable with `/verify`. NEAR AI cannot read your messages or your mail. |
| **Not proven** | The bot's own server is an ordinary VPS, not a TEE. It stores what a memory assistant has to store, and whoever runs the server has technical access to it. |
| **What the server stores** | Your number and profile, your last 30 messages, your memories, to-dos and reminders, and Gmail tokens if you connect Gmail. Schema: `src/db/schema.ts`. |
| **What it never stores** | Prompts and replies sent to the model (hashes only), voice notes, images, your mailbox (read live from Google), files fetched for you. Logs record timings and counts, never content. |
| **Your controls** | `/memories` shows what is held. `/forget <id>`, `/reset`, `/gmail disconnect` and `/delete everything` delete it. |

Other services that see part of your data: WhatsApp carries the messages, Google serves Gmail if you connect it, Tavily receives web search queries, and Browserbase (when configured; otherwise a local headless Chromium) runs the browser and sees the pages it opens. None of them is an AI provider. The bot's public `/privacy` page says the same in plain language.

## Try it

### On WhatsApp

Message the live bot at the number above. In order:

| Do | See |
|---|---|
| Send `hi` | A reply and a two-line welcome |
| Send `my sister Riya's wedding is on 12 December` | An acknowledgement; the fact is saved |
| Send `/memories` | A numbered list that includes the wedding |
| Send `remind me in 2 minutes to drink water` | A confirmation, then the reminder 2 minutes later |
| Send a voice note in Hindi or Hinglish | A reply in the same language |
| Send `/verify` | "Verified private inference", the model, the two hashes, the signer, four ✅ lines and a Verification Center link |
| Send `/forget <id>` with a number from `/memories` | "Forgotten"; `/memories` no longer lists it |
| Send `/delete everything` | Everything about you is deleted |

Gmail needs your Google account added as a test user first (see [Gmail](#gmail-optional)).

### Without WhatsApp

Requires Node 22 and pnpm.

| Do | See |
|---|---|
| `pnpm install && pnpm test` | 69 offline tests pass (reminders, recurring tasks, to-dos, memory, commands, Gmail). No keys, no network; the model is stubbed. |
| `NEAR_AI_API_KEY=<key> pnpm smoke:nearai` | One real completion through the capturing client, the logged hashes, NEAR AI's signature, and `✅ signed text matches our hashes` |
| `NEAR_AI_API_KEY=<key> pnpm eval:chat` | Scripted multi-turn chats through the real agent on a throwaway database, with pass/fail checks on replies and saved state |

## Architecture

```
  WhatsApp (spare SIM)
        │  text · images · voice notes
        ▼
┌─ one Node 22 process on a VPS ──────────────────────────────────┐
│ src/wa/         Baileys socket, pairing, debounce, media         │
│ src/agent/      system prompt + memories + history → tool loop   │
│ src/scheduler/  reminders and recurring tasks                    │
│ src/tasks/      background browser tasks with approvals          │
│ src/browse/     Playwright browser tools                         │
│ src/gmail/      OAuth, Gmail REST client, opt-in inbox watch     │
│ src/http/       /health, public pages, Gmail OAuth callback      │
│ src/db/         SQLite, one file                                 │
│ src/nearai/     client that hashes exact bytes; /verify          │
└──────────────┬───────────────────────────────────────────────────┘
               │ every model call
               ▼
     NEAR AI Cloud, Confidential TEE tier
     signature + attestation per completion
```

About 3,900 lines of TypeScript, written from scratch. One process, one SQLite file, no queue and no vector database: all of a user's memories are put into the system prompt.

## Run it locally

```bash
pnpm install
cp .env.example .env    # set NEAR_AI_API_KEY; TAVILY_API_KEY turns on web search
pnpm dev
```

Scan the QR code printed in the terminal from WhatsApp on a spare SIM (Linked devices), or set `WA_PAIR_NUMBER` to pair with an 8-character code instead. Use a spare number, never a personal one. Browser features need `npx playwright install chromium` unless `BROWSERBASE_API_KEY` is set.

## Deploy (VPS + Docker)

One small VPS (2 GB RAM is plenty) with a domain or subdomain pointed at it. Caddy handles TLS, which the Gmail OAuth callback needs.

```bash
# on the server, once
curl -fsSL https://get.docker.com | sh
git clone https://github.com/Dhaiwat10/indstinct && cd indstinct
cp .env.example .env && nano .env   # NEAR_AI_API_KEY, TAVILY_API_KEY, WA_PAIR_NUMBER, DOMAIN=bot.example.com, PUBLIC_URL=https://bot.example.com
docker compose up -d --build
docker compose logs -f bot          # shows the 8-char WhatsApp pairing code; enter it on the SIM's phone under Linked devices
```

After editing `.env` on the server, apply it with `docker compose up -d --force-recreate bot`. The `data` volume holds the SQLite database and the WhatsApp session, so `docker compose up -d --build` after a `git pull` keeps everything. Back it up with `docker run --rm -v indstinct_data:/data -v "$PWD":/out alpine tar czf /out/indstinct-data.tgz -C / data`. Pair the server fresh rather than copying a laptop's `data/auth` across while the laptop bot is still running; two live sessions on one number fight each other. `curl https://bot.example.com/health` should say `ok`.

**CI and continuous deploy** (`.github/workflows/deploy.yml`):

- **check** (every PR and push): typecheck plus `pnpm test`, which runs the offline tests: reminders, recurring tasks, to-dos, memory and commands (`scripts/test-core.ts`), and Gmail (`scripts/test-gmail.ts`). The model is stubbed, so these are fast and deterministic. A red check blocks the deploy.
- **eval** (PRs only): the live chat eval (`pnpm eval:chat`) against NEAR AI, posted as a PR comment. Model replies vary, so this is a warning to read before merging, not a blocker.
- **deploy** (push to `main`, after check): SSHes into the droplet with the `DROPLET_SSH_KEY` secret and runs `/usr/local/bin/indstinct-deploy`. The key is pinned to that script with a `command=` entry in `authorized_keys`, so it can't open a shell. The script fetches main, builds, restarts, and requires `/health` to stay up for 20 seconds with no container restart. If the build fails or the new version doesn't stay up, it rolls back to the previous commit and the CI run goes red.

The server script's source is `deploy/indstinct-deploy`. After changing it, copy it to the droplet with `scp deploy/indstinct-deploy root@<ip>:/usr/local/bin/`. Repo secrets needed: `DROPLET_SSH_KEY`, `NEAR_AI_API_KEY`, `TAVILY_API_KEY`.

## Gmail (optional)

Connect a Gmail account with `/gmail` and the bot handles email the way Instinct does: ask "anything important in my inbox?", "what did Riya say about the interview?", "reply saying yes, Tuesday works", "unsubscribe me from Myntra", "send me the invoice from that email". Replies go out from the user's own address; every send is drafted first, shown in WhatsApp, and only sent when the user says so in a later message (the `email_send` tool refuses anything else). Nothing proactive happens unless asked: "flag important emails as they come in" turns on inbox alerts (new Primary-inbox mail triaged inside the TEE, at most one unsolicited message a minute, 8 a day), and "inbox brief every morning at 8" sets up a brief through the normal recurring-task tool. `/gmail disconnect` revokes the Google grant and deletes every trace: tokens, drafts, flags, email tool results from chat history, and any recurring task that reads mail. Mail is read live from Google and never stored.

Setup:

1. Google Cloud → APIs & Services → enable the **Gmail API**.
2. OAuth consent screen: External, add yourself (and the judges) as test users. Scope: `gmail.modify`.
3. Credentials → OAuth client ID → **Web application**; authorised redirect URI `${PUBLIC_URL}/gmail/callback`, e.g. `https://bot.example.com/gmail/callback`. (Locally the link is opened on your phone, so `localhost` won't do; deploy first, or use a tunnel and register its URL.)
4. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `PUBLIC_URL` in `.env`, then `docker compose up -d --force-recreate bot`. Plain `docker compose up -d` can keep the old container and miss `.env` edits. Without these values the bot runs with Gmail off.

While the consent screen is in Testing status only listed test users can connect and refresh tokens expire after 7 days (the bot then asks them to `/gmail` again). Publishing needs Google's review because `gmail.modify` is a restricted scope.

`pnpm test:gmail` runs the OAuth round trip, tools, send guard and disconnect against a stubbed Google, no network needed.

## Limitations and next steps

- **The server is not in a TEE.** Only inference is. The operator can read the SQLite database, including Gmail tokens, which are not encrypted at rest. Next step: run the whole bot in a confidential VM so its code and storage are attested too.
- **`/verify` stops at the quote's contents.** It does not validate Intel's certificate chain over the TDX quote, the NVIDIA GPU attestation, the gateway attestation or image provenance. It links to NEAR AI's Verification Center for hardware verification. Next step: full local verification of the quote.
- **Voice transcription is not covered by `/verify`.** The Whisper call goes to NEAR AI, but `/verify` checks the chat completion that follows it, not the transcription call.
- **WhatsApp access is unofficial.** The bot uses Baileys on a spare SIM, which is against WhatsApp's terms and can be banned. The official Cloud API is the migration path; it requires approved templates for proactive messages.
- **Search and browsing leave the TEE boundary.** Tavily sees search queries and Browserbase sees the pages a browser task opens.
- **Gmail is in Google's Testing status.** Only listed test users can connect, and refresh tokens expire after 7 days.
- **No on-chain component.** NEAR's role here is NEAR AI Cloud's private inference and attestation.
- **Memory does not scale.** Every memory goes into every prompt; there is no retrieval.

## Hackathon disclosure

- All code was written during the hackathon window. The first commit is dated 2026-10-31.
- The product idea is inspired by Instinct, a WhatsApp assistant. No code is shared with it.
- Written with AI assistance (Claude Code).
- Libraries: `ai` and `@ai-sdk/openai-compatible` (Vercel AI SDK), `baileys`, `better-sqlite3`, `croner`, `pino`, `playwright`, `qrcode-terminal`, `viem`, `zod`.
- External services: NEAR AI Cloud (all inference), Tavily (search), Browserbase (optional hosted browser), Gmail API (optional).

## License

MIT. See [LICENSE](LICENSE).
