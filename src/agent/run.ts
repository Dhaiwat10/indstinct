import { generateText, stepCountIs, type ModelMessage, type UserContent } from "ai";
import { db } from "../db/index.js";
import { history, saveMessage } from "../db/messages.js";
import { markOnboarded, type User } from "../db/users.js";
import { log } from "../log.js";
import { models } from "../nearai/client.js";
import { inferenceContext } from "../nearai/capture.js";
import { extractMemories } from "./memory-extract.js";
import { buildSystemPrompt } from "./prompt.js";
import { browse } from "./tools/browse.js";
import { forget } from "./tools/forget.js";
import { remember } from "./tools/remember.js";
import { cancelSchedule, listSchedules, scheduleRecurring, setReminder } from "./tools/schedule.js";
import { addTodo, completeTodo, listTodos } from "./tools/todos.js";
import { updateProfile } from "./tools/update-profile.js";
import { webSearch } from "./tools/web-search.js";

export type Turn = {
  text: string;
  images: { data: Buffer; mediaType: string }[];
  waMessageId?: string;
  /** Set when a recurring task fires: `text` is its prompt, and nobody is waiting on a chat reply. */
  scheduled?: { id: number; description: string };
};

const linkInferences = db.prepare(
  "UPDATE inference_log SET message_id = ? WHERE user_id = ? AND message_id IS NULL AND purpose = 'agent'",
);

/** Some reasoning models leak think blocks or leading blank lines into content. */
function clean(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 * History only keeps text, so an image is stored as a placeholder; the reply that
 * describes it carries the details into later turns.
 */
function stored(turn: Turn): string {
  if (turn.scheduled) return `[scheduled task #${turn.scheduled.id}: ${turn.scheduled.description}] ${turn.text}`;
  const tag = turn.images.length ? `[sent ${turn.images.length > 1 ? `${turn.images.length} photos` : "a photo"}]` : "";
  return [tag, turn.text].filter(Boolean).join(" ");
}

/** Runs one agent turn and returns the reply, persisting both sides. */
export async function runAgent(user: User, turn: Turn): Promise<string> {
  const messages: ModelMessage[] = history(user.id).map((m) => ({ role: m.role, content: m.content }));
  const content: UserContent = turn.images.length
    ? [...turn.images.map((i) => ({ type: "file" as const, data: i.data, mediaType: i.mediaType })), { type: "text" as const, text: turn.text || "(no caption)" }]
    : turn.text;
  messages.push({ role: "user", content });
  saveMessage(user.id, "user", stored(turn), turn.waMessageId);

  const tools = {
    remember: remember(user),
    forget: forget(user),
    update_profile: updateProfile(user),
    add_todo: addTodo(user),
    complete_todo: completeTodo(user),
    list_todos: listTodos(user),
    web_search: webSearch,
    browse: browse(),
    // A scheduled run can't schedule more runs.
    ...(!turn.scheduled && {
      set_reminder: setReminder(user),
      schedule_recurring: scheduleRecurring(user),
      list_schedules: listSchedules(user),
      cancel_schedule: cancelSchedule(user),
    }),
  };
  const system = turn.scheduled
    ? `${buildSystemPrompt(user)}\n\nThis is scheduled task #${turn.scheduled.id} that the user set up: "${turn.scheduled.description}". Do it now; your reply is sent to them as-is, so write it as the message itself, with no preamble. For news, scores, prices or anything live, use web_search first; never invent them.`
    : buildSystemPrompt(user);

  const t0 = Date.now();
  const result = await inferenceContext.run({ userId: user.id }, () =>
    generateText({
      // The primary model has no vision; image turns go to the vision model, tools and all.
      model: turn.images.length ? models.vision() : turn.scheduled ? models.heavy() : models.primary(),
      system,
      messages,
      tools,
      stopWhen: stepCountIs(8),
    }),
  );

  // Models often write part of the reply alongside a tool call; result.text only has the last step.
  const reply = result.steps.map((s) => clean(s.text)).filter(Boolean).join("\n\n") || "Done ✅";
  const replyId = saveMessage(user.id, "assistant", reply);
  linkInferences.run(replyId, user.id);
  markOnboarded(user.id);

  log.info(
    { user: user.id, ms: Date.now() - t0, images: turn.images.length, steps: result.steps.length, tools: result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)) },
    "agent turn",
  );

  // Short messages ("ok", "thanks") never carry new facts; skip the extra call.
  if (!turn.scheduled && stored(turn).length >= 15)
    void extractMemories(user, stored(turn), reply, replyId).catch((err) => log.warn({ err, user: user.id }, "memory extraction failed"));
  return reply;
}
