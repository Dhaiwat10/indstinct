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
<li>Your WhatsApp number and profile name.</li>
<li>Your most recent 30 messages with the assistant, so it can follow the conversation. Older messages are deleted automatically.</li>
<li>Things you ask it to remember or that it notes from conversation (for example a birthday), your open reminders, recurring tasks and to-dos, and the name, city, language and timezone you give it. A memory you forget, a to-do you finish and a reminder that has fired or been cancelled are deleted, not hidden.</li>
<li>For a task the assistant does on a website for you (for example a web check-in): its goal, a short log of its steps without page content, and the final message it sent you. The details it needed, such as a booking reference, are deleted when the task ends. Files it fetches for you, like boarding passes, are sent to you and never stored. A one-time code you send for a task is not kept in the conversation.</li>
<li>For each AI inference, a fingerprint (SHA-256 hash) of the request and response, so replies can be cryptographically verified with <code>/verify</code>. The request and response themselves are not kept.</li>
</ul>
<p>This is stored in a database on our server and used only to provide the assistant to you. Our logs record timings and counts, never what you or the assistant wrote. Deleted data is overwritten on disk.</p>
<p>To be clear about the limits: while the model calls run in a trusted execution environment, our server is an ordinary one, so whoever runs it has technical access to the data above. We keep as little as possible for that reason.</p>

<h2>Gmail data</h2>
<p>If you connect Gmail, indstinct asks Google for the <code>gmail.modify</code> permission, which lets it read, search, label, draft and send email. It uses that access only to do what you ask in the chat, for example "what did Riya say about the interview?", "draft a reply", "unsubscribe me from this list", or "send me that attachment", and, only if you turn it on, to flag important new mail.</p>
<ul>
<li><strong>Read live, not copied.</strong> Email is fetched from Google when needed. indstinct does not keep a copy of your mailbox.</li>
<li><strong>What is kept:</strong> your Google access tokens; the drafts the assistant writes (recipient, subject, body) until they are sent, after which their text is deleted; short excerpts of email that appeared in your conversation with the assistant, so it can follow up in context; and, if you enabled alerts, the one-line notes it sent you about new mail.</li>
<li><strong>Nothing is sent without you.</strong> Every email is drafted first and shown to you in WhatsApp. It is only sent after you approve it in a later message.</li>
<li><strong>Disconnecting deletes it.</strong> <code>/gmail disconnect</code> revokes indstinct's access at Google and deletes the tokens, drafts, email excerpts, alert notes and any recurring task that reads mail.</li>
</ul>
<p>indstinct's use and transfer of information received from Google APIs to any other app will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Gmail data is not used to train AI models, is not sold, and is not used for advertising.</p>

<h2>Who else processes your data</h2>
<ul>
<li><strong>NEAR AI</strong> runs the language models that read your messages, and email you ask about, to write replies. This happens inside a trusted execution environment, so NEAR AI cannot read the content.</li>
<li><strong>Google</strong>, when you connect Gmail, to perform the actions you ask for.</li>
<li><strong>Tavily</strong> receives web search queries the assistant makes to answer questions about live information.</li>
<li><strong>Browserbase</strong> runs the web browser the assistant uses to look things up on websites and to do tasks for you, such as a web check-in. It sees the pages the assistant opens, including what the assistant types into them for you, such as a booking reference, your name or a one-time code.</li>
<li><strong>WhatsApp</strong> carries the messages between you and the assistant.</li>
</ul>
<p>We do not share your data with anyone else.</p>

<h2>Deleting your data</h2>
<p>In the chat: <code>/forget</code> deletes a memory, <code>/reset</code> deletes the conversation history, <code>/gmail disconnect</code> removes everything related to Gmail, and <code>/delete everything</code> deletes all of your data at once, including your Gmail link. You can also email <a href="mailto:${CONTACT}">${CONTACT}</a> from any address and include your WhatsApp number; we will delete it within 7 days.</p>

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
