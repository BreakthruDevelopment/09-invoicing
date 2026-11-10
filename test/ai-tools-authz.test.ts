// Tool handlers authorize on the server with assertCan(), using the actor they closed over, never anything
// the model supplied. This is the pattern README "Tool use" tells apps to copy; no database needed.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "@/lib/ai";
import { type ToolTrace, runToolLoop } from "@/lib/ai/tools";
import type { AiProvider, ToolStepRequest } from "@/lib/ai/types";
import { type Actor, assertCan } from "@/lib/auth/rbac";

const docs: Record<string, { ownerId: string; title: string }> = {
  mine: { ownerId: "user-a", title: "My note" },
  theirs: { ownerId: "user-b", title: "VICTIM-PRIVATE-TITLE" },
};

/** The factory an app writes: the actor is bound here, per request. */
function readDocTool(actor: Actor) {
  const ctxKeys: string[][] = [];
  const tool = defineTool({
    name: "read_doc",
    description: "Read one of your documents",
    args: z.object({ id: z.string().max(40) }),
    kind: "read",
    async run({ id }, ctx) {
      ctxKeys.push(Object.keys(ctx));
      const doc = docs[id];
      if (!doc) throw new Error("not found");
      assertCan(actor, "read", { ownerId: doc.ownerId });
      return { title: doc.title };
    },
  });
  return { tool, ctxKeys };
}

async function run(actor: Actor, askFor: string) {
  const { tool, ctxKeys } = readDocTool(actor);
  const seen: ToolStepRequest[] = [];
  const provider: AiProvider = {
    name: "stub",
    model: "m",
    complete: () => Promise.reject(new Error("no")),
    step: async (req) => {
      seen.push(structuredClone({ ...req, deadlineAt: 0 }));
      return seen.length === 1
        ? { calls: [{ id: "1", name: "read_doc", args: { id: askFor, actorId: "user-b", role: "admin" } }], text: "", raw: {} }
        : { calls: [{ id: "2", name: "respond", args: { reply: "done" } }], text: "", raw: {} };
    },
  };
  const trace: ToolTrace = { steps: 0, calls: [] };
  await runToolLoop(
    { task: "t", system: "s", schema: z.object({ reply: z.string() }), maxOutputTokens: 100, tools: [tool], maxSteps: 4, deadlineAt: Date.now() + 2000, history: [{ role: "user", text: "hi" }] },
    provider,
    trace,
  );
  return { toolResult: JSON.stringify(seen[1].history.at(-1)), trace, ctxKeys };
}

describe("tool authorization", () => {
  const userA: Actor = { id: "user-a", role: "user" };

  it("lets the owner read their own document", async () => {
    const r = await run(userA, "mine");
    expect(r.toolResult).toContain("My note");
  });

  it("refuses a foreign id: the model sees a generic failure and none of the data", async () => {
    const r = await run(userA, "theirs");
    expect(r.toolResult).toContain("tool_error");
    expect(r.toolResult).not.toContain("VICTIM-PRIVATE-TITLE");
    expect(r.toolResult).not.toContain("permission"); // no oracle for "exists but forbidden"
    expect(r.trace.calls).toEqual([expect.objectContaining({ tool: "read_doc", outcome: "tool_error" })]);
  });

  it("ignores an actor or role the model puts in its arguments", async () => {
    const r = await run(userA, "theirs"); // args also carry actorId: user-b, role: admin
    expect(r.toolResult).not.toContain("VICTIM-PRIVATE-TITLE");
  });

  it("hands handlers only a signal, never the actor", async () => {
    const r = await run(userA, "mine");
    expect(r.ctxKeys).toEqual([["signal"]]);
  });
});
