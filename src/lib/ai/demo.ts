import type { DemoToolScript } from "./types";

/**
 * Recorded answers keyed by task name. Demo mode keeps live demos working when the
 * free model quota is used up, and lets tests run without a network or API key.
 * Each app adds a fixture for each AI task it defines.
 */
export const demoFixtures: Record<string, unknown> = {
  "summarize-items": {
    summary:
      "You have a few open items. The most recent ones focus on setup work; nothing looks overdue.",
    highlights: ["Setup tasks are the largest group", "No items are flagged urgent"],
  },
};

/**
 * Scripted tool loops for tasks that use `generate({ tools })`, keyed by task name. A script is a function
 * of the caller's `demoContext`; the loop runs the real handlers for each step, then `final` builds the
 * answer from their results. Keep `args` valid for the real tool schemas.
 */
export const demoToolScripts: Record<string, (ctx: unknown) => DemoToolScript> = {
  // Example for the README: an assistant that looks items up, then answers.
  "items-assistant": (ctx) => {
    const query = typeof (ctx as { query?: unknown } | undefined)?.query === "string" ? (ctx as { query: string }).query : "setup";
    return {
      steps: [{ call: { name: "search_items", args: { query } } }],
      final: (results) => {
        const found = results[0]?.ok && Array.isArray(results[0].data) ? results[0].data.length : 0;
        return { reply: `Demo assistant (recorded): I found ${found} matching item${found === 1 ? "" : "s"}.`, matches: found };
      },
    };
  },
};

export function demoAnswer(task: string): string {
  const fixture = demoFixtures[task];
  if (fixture === undefined) {
    throw new Error(`No demo fixture for AI task "${task}". Add one to src/lib/ai/demo.ts.`);
  }
  return JSON.stringify(fixture);
}
