// Public pages Google requires before an OAuth app can be published: a home page and a privacy
// policy on an authorized domain, plus short terms. Plain HTML, no assets.
const CONTACT = "dhaiwatpandya@gmail.com";
const UPDATED = "31 October 2026";

const shell = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{--fg:#1a1a1a;--muted:#555;--bg:#fff;--accent:#128c7e;--line:#e5e5e5}
@media (prefers-color-scheme:dark){:root{--fg:#ececec;--muted:#a8a8a8;--bg:#121212;--accent:#25d3b8;--line:#2a2a2a}}
body{font-family:-apple-system,system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1.25rem;line-height:1.6;color:var(--fg);background:var(--bg)}
h1{font-size:1.6rem;margin-bottom:.25rem}h2{font-size:1.1rem;margin-top:2rem}p,li{color:var(--muted)}
a{color:var(--accent)}nav{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--line);font-size:.9rem}
.meta{font-size:.85rem;color:var(--muted)}
</style></head><body>
${body}
<nav><a href="/">Home</a> · <a href="/privacy">Privacy policy</a> · <a href="/terms">Terms</a> · <a href="mailto:${CONTACT}">${CONTACT}</a></nav>
</body></html>`;

export const homePage = shell(
  "indstinct",
  `<h1>indstinct</h1>
<p>A personal assistant that lives in WhatsApp, built for India. It remembers what you tell it, sets reminders and to-dos, answers questions with live web search, and, if you choose to connect Gmail, summarises your inbox and drafts replies that you approve before anything is sent.</p>
<p>Every model call runs on <a href="https://near.ai">NEAR AI</a>'s confidential inference inside a trusted execution environment (TEE), and any reply can be checked with <code>/verify</code> in the chat.</p>
<h2>Gmail</h2>
<p>Connecting Gmail is optional. Send <code>/gmail</code> in the chat and sign in with Google. You can disconnect at any time with <code>/gmail disconnect</code>, which revokes access and deletes what indstinct kept. See the <a href="/privacy">privacy policy</a> for exactly what is accessed and stored.</p>
<p>indstinct is a hackathon project for the NEAR AI hackathon.</p>`,
);

export const privacyPage = shell(
  "indstinct · Privacy policy",
  `<h1>Privacy policy</h1>
<p class="meta">Last updated ${UPDATED}</p>

<h2>What indstinct stores</h2>
<ul>
<li>Your WhatsApp number and profile name, and the messages you exchange with the assistant.</li>
<li>Things you ask it to remember or that it notes from conversation (for example a birthday), your reminders, recurring tasks and to-dos, and the name, city, language and timezone you give it.</li>
<li>Records of each AI inference (the request and response), kept so that replies can be cryptographically verified with <code>/verify</code>.</li>
</ul>
<p>This is stored in a database on our server and used only to provide the assistant to you.</p>

<h2>Gmail data</h2>
<p>If you connect Gmail, indstinct asks Google for the <code>gmail.modify</code> permission, which lets it read, search, label, draft and send email. It uses that access only to do what you ask in the chat, for example "what did Riya say about the interview?", "draft a reply", "unsubscribe me from this list", or "send me that attachment", and, only if you turn it on, to flag important new mail.</p>
<ul>
<li><strong>Read live, not copied.</strong> Email is fetched from Google when needed. indstinct does not keep a copy of your mailbox.</li>
<li><strong>What is kept:</strong> your Google access tokens; the drafts the assistant writes (recipient, subject, body); short excerpts of email that appeared in your conversation with the assistant, so it can follow up in context; and, if you enabled alerts, the one-line notes it sent you about new mail.</li>
<li><strong>Nothing is sent without you.</strong> Every email is drafted first and shown to you in WhatsApp. It is only sent after you approve it in a later message.</li>
<li><strong>Disconnecting deletes it.</strong> <code>/gmail disconnect</code> revokes indstinct's access at Google and deletes the tokens, drafts, email excerpts, alert notes and any recurring task that reads mail.</li>
</ul>
<p>indstinct's use and transfer of information received from Google APIs to any other app will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Gmail data is not used to train AI models, is not sold, and is not used for advertising.</p>

<h2>Who else processes your data</h2>
<ul>
<li><strong>NEAR AI</strong> runs the language models that read your messages, and email you ask about, to write replies. This happens inside a trusted execution environment, so the content is not readable in plaintext by NEAR AI or by us.</li>
<li><strong>Google</strong>, when you connect Gmail, to perform the actions you ask for.</li>
<li><strong>Tavily</strong> receives web search queries the assistant makes to answer questions about live information.</li>
<li><strong>WhatsApp</strong> carries the messages between you and the assistant.</li>
</ul>
<p>We do not share your data with anyone else.</p>

<h2>Deleting your data</h2>
<p>In the chat: <code>/forget</code> removes a memory, <code>/reset</code> clears the conversation history, and <code>/gmail disconnect</code> removes everything related to Gmail. To have all of your data deleted, email <a href="mailto:${CONTACT}">${CONTACT}</a> from any address and include your WhatsApp number; we will delete it within 7 days.</p>

<h2>Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>`,
);

export const termsPage = shell(
  "indstinct · Terms",
  `<h1>Terms of service</h1>
<p class="meta">Last updated ${UPDATED}</p>
<p>indstinct is an experimental assistant built for a hackathon and provided as is, without warranty. It can make mistakes: check reminders, summaries and drafts before relying on them. You are responsible for emails you approve for sending.</p>
<p>Use it only for lawful, personal purposes and only with accounts you own. We may change or stop the service at any time. Your data is handled as described in the <a href="/privacy">privacy policy</a>.</p>
<p>Questions: <a href="mailto:${CONTACT}">${CONTACT}</a></p>`,
);
