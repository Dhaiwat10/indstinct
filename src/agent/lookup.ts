// The quick-lookup allowance. Inside a reply the agent may search and read pages a little; past
// that, the work moves to a background task instead of keeping the user on "typing…". This is
// enforced here, in code, not just asked for in the prompt.

/** Steps that called web_search, and read_page calls, allowed inside one reply. */
export const ALLOWANCE = { searchRounds: 2, pageReads: 2 };

type Step = { toolCalls: { toolName: string }[] };

export function used(steps: Step[]): { searchRounds: number; pageReads: number } {
  return {
    searchRounds: steps.filter((s) => s.toolCalls.some((c) => c.toolName === "web_search")).length,
    pageReads: steps.flatMap((s) => s.toolCalls).filter((c) => c.toolName === "read_page").length,
  };
}

/**
 * Which tools the next step may use, and a note for the model once the allowance is spent.
 * `canStartTask` is false for scheduled runs, which answer with what they found instead.
 */
export function nextStep(steps: Step[], toolNames: string[], canStartTask: boolean): { activeTools: string[]; note?: string } {
  const u = used(steps);
  const noSearch = u.searchRounds >= ALLOWANCE.searchRounds;
  const noRead = u.pageReads >= ALLOWANCE.pageReads;
  const activeTools = toolNames.filter((n) => !(noSearch && n === "web_search") && !(noRead && n === "read_page"));
  if (!noSearch || !noRead) return { activeTools };
  const note = canStartTask
    ? "You've used the quick lookup for this message (two rounds of search, two page reads). If what you found answers the question, answer now. If it doesn't, call start_task: put what you've already found in found_so_far, then tell the user in one line that you're on it and will message them."
    : "You've used the quick lookup for this run. Answer now with what you found, and say plainly if something couldn't be confirmed.";
  return { activeTools, note };
}
