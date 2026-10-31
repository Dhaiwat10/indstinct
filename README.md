# indstinct

An Instinct-style AI assistant on WhatsApp, built for Indians — powered by private, verifiable AI inference from NEAR AI. Built for the NEAR hackathon.

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

The `data` volume holds the SQLite database and the WhatsApp session, so `docker compose up -d --build` after a `git pull` keeps everything. Back it up with `docker run --rm -v indstinct_data:/data -v "$PWD":/out alpine tar czf /out/indstinct-data.tgz -C / data`. Pair the server fresh rather than copying a laptop's `data/auth` across while the laptop bot is still running; two live sessions on one number fight each other. `curl https://bot.example.com/health` should say `ok`.

**Continuous deploy.** `.github/workflows/deploy.yml` runs typecheck and `pnpm test:gmail` on every PR, and on every push to `main` it SSHes into the droplet and runs `/usr/local/bin/indstinct-deploy` (fetch main, `docker compose up -d --build`, wait for `/health`). That script lives on the server, and the CI key in the `DROPLET_SSH_KEY` repo secret is pinned to it with a `command=` entry in `authorized_keys`, so the key can't open a shell. To re-run a deploy by hand: Actions → CI and deploy → Run workflow. No domain? `bot.<server-ip>.sslip.io` resolves without any DNS setup and Caddy will get a certificate for it.

## Gmail (optional)

Connect a Gmail account with `/gmail` and the bot handles email the way Instinct does: ask "anything important in my inbox?", "what did Riya say about the interview?", "reply saying yes, Tuesday works", "unsubscribe me from Myntra", "send me the invoice from that email". Replies go out from the user's own address; every send is drafted first, shown in WhatsApp, and only sent when the user says so in a later message (the `email_send` tool refuses anything else). Nothing proactive happens unless asked: "flag important emails as they come in" turns on inbox alerts (new Primary-inbox mail triaged inside the TEE, at most one unsolicited message a minute, 8 a day), and "inbox brief every morning at 8" sets up a brief through the normal recurring-task tool. `/gmail disconnect` revokes the Google grant and deletes every trace: tokens, drafts, flags, email tool results from chat history, and any recurring task that reads mail. Mail is read live from Google and never stored.

Setup:

1. Google Cloud → APIs & Services → enable the **Gmail API**.
2. OAuth consent screen: External, add yourself (and the judges) as test users. Scope: `gmail.modify`.
3. Credentials → OAuth client ID → **Web application**; authorised redirect URI `${PUBLIC_URL}/gmail/callback`, e.g. `https://bot.example.com/gmail/callback`. (Locally the link is opened on your phone, so `localhost` won't do; deploy first, or use a tunnel and register its URL.)
4. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `PUBLIC_URL` in `.env` and restart. Without them the bot runs with Gmail off.

While the consent screen is in Testing status only listed test users can connect and refresh tokens expire after 7 days (the bot then asks them to `/gmail` again). Publishing needs Google's review because `gmail.modify` is a restricted scope.

`pnpm test:gmail` runs the OAuth round trip, tools, send guard and disconnect against a stubbed Google, no network needed.
