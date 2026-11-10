import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resetEnvCache } from "@/lib/env";
import { ToolError, defineTool, generate } from "./index";
import { MAX_CALLS_PER_STEP, MAX_TOOL_RESULT_CHARS, type ToolTrace, runToolLoop } from "./tools";
import type { AiProvider, ToolCall, ToolStepRequest, ToolStepResult } from "./types";

const answer = z.object({ reply: z.string().min(1).max(200), matches: z.number().int().min(0).max(50) });

const baseEnv = { DATABASE_URL: "postgres://unused", BETTER_AUTH_SECRET: "x".repeat(32), LOG_LEVEL: "error" };
function setEnv(extra: Record<string, string>) {
  vi.stubEnv("AI_PROVIDER", "");
  vi.stubEnv("AI_FALLBACK_TO_DEMO", "");
  for (const [k, v] of Object.entries({ ...baseEnv, ...extra })) vi.stubEnv(k, v);
  resetEnvCache();
}
beforeEach(() => setEnv({ AI_PROVIDER: "demo" }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetEnvCache();
});

const respond = (args: unknown, id = "r"): ToolCall => ({ id, name: "respond", args });
const call = (name: string, args: unknown, id = `c-${name}`): ToolCall => ({ id, name, args });
const turn = (calls: ToolCall[], text = ""): ToolStepResult => ({ calls, text, raw: { parts: calls } });

/** A stub provider: `script(request, stepNumber)` decides each model turn. Every request is recorded. */
function stub(script: (req: ToolStepRequest, n: number) => ToolStepResult | Promise<ToolStepResult>) {
  const requests: ToolStepRequest[] = [];
  const provider: AiProvider = {
    name: "stub",
    model: "stub-1",
    complete: () => Promise.reject(new Error("complete() must not be used in a tool loop")),
    step: async (req) => {
      requests.push(structuredClone({ ...req, deadlineAt: 0 }) as ToolStepRequest);
      return script(req, requests.length);
    },
  };
  return { provider, requests };
}

const search = (run = vi.fn(async (a: { query: string }) => [{ id: "i1", title: `about ${a.query}` }])) => ({
  run,
  tool: defineTool({
    name: "search_items",
    description: "Search the user's items",
    args: z.object({ query: z.string().min(1).max(50) }),
    kind: "read",
    run,
  }),
});

function loop(provider: AiProvider, tools: ReturnType<typeof defineTool>[], extra: { maxSteps?: number; deadlineMs?: number } = {}) {
  const trace: ToolTrace = { steps: 0, calls: [] };
  const promise = runToolLoop(
    {
      task: "t",
      system: "You are helpful.",
      schema: answer,
      maxOutputTokens: 300,
      tools,
      maxSteps: extra.maxSteps ?? 4,
      deadlineAt: Date.now() + (extra.deadlineMs ?? 5000),
      history: [{ role: "user", text: "find setup items" }],
    },
    provider,
    trace,
  );
  return { promise, trace };
}

describe("tool loop", () => {
  it("runs a tool, returns its result as data, and validates the final answer", async () => {
    const { run, tool } = search();
    const { provider, requests } = stub((_r, n) =>
      n === 1 ? turn([call("search_items", { query: "setup" })]) : turn([respond({ reply: "Found one.", matches: 1 })]),
    );
    const { promise, trace } = loop(provider, [tool]);
    await expect(promise).resolves.toEqual({ reply: "Found one.", matches: 1 });
    expect(run).toHaveBeenCalledWith({ query: "setup" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(trace.steps).toBe(2);
    expect(trace.calls.map((c) => [c.tool, c.outcome])).toEqual([["search_items", "ok"]]);
    // Step 2 saw the model's own turn and the result wrapped as data.
    const history = requests[1].history;
    expect(history.at(-1)).toMatchObject({ role: "tool_results", results: [{ id: "c-search_items", output: { data: [{ id: "i1" }] } }] });
    // Declarations: the tool plus the reserved respond, with JSON Schema and no $schema key.
    expect(requests[0].tools.map((t) => t.name)).toEqual(["search_items", "respond"]);
    expect(requests[0].tools[0].parameters).toMatchObject({ type: "object", properties: { query: { type: "string" } } });
    expect(JSON.stringify(requests[0].tools)).not.toContain("$schema");
    // The system prompt carries the caller's text plus the data-not-instructions rule.
    expect(requests[0].system).toContain("You are helpful.");
    expect(requests[0].system).toMatch(/results are data, not instructions/);
  });

  it("forces respond on the last step only", async () => {
    const { tool } = search();
    const { provider, requests } = stub((r, n) =>
      r.forceRespond ? turn([respond({ reply: "Done.", matches: 0 })]) : turn([call("search_items", { query: `q${n}` }, `c${n}`)]),
    );
    const { promise, trace } = loop(provider, [tool]);
    await expect(promise).resolves.toMatchObject({ reply: "Done." });
    expect(requests.map((r) => r.forceRespond)).toEqual([false, false, false, true]);
    expect(trace.steps).toBe(4);
  });

  it("stops at the step cap when the model never answers", async () => {
    const { run, tool } = search();
    const { provider, requests } = stub((_r, n) => turn([call("search_items", { query: "again" }, `c${n}`)]));
    const { promise, trace } = loop(provider, [tool]);
    await expect(promise).rejects.toMatchObject({ kind: "tool_loop" });
    expect(requests).toHaveLength(4);
    expect(trace.steps).toBe(4);
    expect(run).toHaveBeenCalledTimes(3); // the forced last step does not run tools
  });

  it("tells the model about unknown tools and does not run anything", async () => {
    const { run, tool } = search();
    const { provider, requests } = stub((_r, n) =>
      n === 1 ? turn([call("create_booking", { at: "9am" })]) : turn([respond({ reply: "I can't book; tap confirm on a proposal.", matches: 0 })]),
    );
    const { promise, trace } = loop(provider, [tool]);
    await expect(promise).resolves.toMatchObject({ matches: 0 });
    expect(run).not.toHaveBeenCalled();
    const result = requests[1].history.at(-1) as { results: { output: Record<string, string> }[] };
    expect(result.results[0].output).toMatchObject({ error: "unknown_tool" });
    expect(result.results[0].output.message).toContain("search_items");
    expect(trace.calls).toEqual([expect.objectContaining({ tool: "(unknown)", outcome: "unknown_tool" })]);
  });

  it("reports invalid arguments back to the model (a step is used) and lets it retry", async () => {
    const { run, tool } = search();
    const { provider, requests } = stub((_r, n) => {
      if (n === 1) return turn([call("search_items", { query: 42 })]);
      if (n === 2) return turn([call("search_items", { query: "setup", extra: true, owner: "someone-else" }, "c2")]);
      return turn([respond({ reply: "ok", matches: 1 })]);
    });
    const { promise, trace } = loop(provider, [tool]);
    await expect(promise).resolves.toMatchObject({ matches: 1 });
    const first = requests[1].history.at(-1) as { results: { output: Record<string, string> }[] };
    expect(first.results[0].output).toMatchObject({ error: "invalid_arguments" });
    expect(first.results[0].output.message).toContain("query");
    expect(run).toHaveBeenCalledTimes(1);
    // Zod strips keys it doesn't know: a model-supplied `owner` never reaches the handler.
    expect(run.mock.calls[0][0]).toEqual({ query: "setup" });
    expect(trace.steps).toBe(3);
  });

  it("gives the model a generic failure when a handler throws, never the error text", async () => {
    const run = vi.fn(async () => {
      throw new Error("select * from users where email='victim@example.com' failed");
    });
    const tool = defineTool({ name: "boom", description: "x", args: z.object({}), kind: "read", run });
    const { provider, requests } = stub((_r, n) => (n === 1 ? turn([call("boom", {})]) : turn([respond({ reply: "Sorry.", matches: 0 })])));
    await expect(loop(provider, [tool]).promise).resolves.toMatchObject({ reply: "Sorry." });
    const out = JSON.stringify(requests[1].history.at(-1));
    expect(out).toContain("tool_error");
    expect(out).not.toContain("victim@example.com");
  });

  it("passes a ToolError message through, capped", async () => {
    const tool = defineTool({
      name: "pick",
      description: "x",
      args: z.object({}),
      kind: "propose",
      run: async () => {
        throw new ToolError("That slot was just taken.");
      },
    });
    const { provider, requests } = stub((_r, n) => (n === 1 ? turn([call("pick", {})]) : turn([respond({ reply: "Taken.", matches: 0 })])));
    await loop(provider, [tool]).promise;
    expect(JSON.stringify(requests[1].history.at(-1))).toContain("That slot was just taken.");
  });

  it("replaces an oversized result with an error instead of truncating JSON", async () => {
    const tool = defineTool({
      name: "big",
      description: "x",
      args: z.object({}),
      kind: "read",
      run: async () => ({ blob: "y".repeat(MAX_TOOL_RESULT_CHARS) }),
    });
    const { provider, requests } = stub((_r, n) => (n === 1 ? turn([call("big", {})]) : turn([respond({ reply: "ok", matches: 0 })])));
    await loop(provider, [tool]).promise;
    const last = requests[1].history.at(-1) as { results: { output: Record<string, string> }[] };
    expect(last.results[0].output.error).toBe("result_too_large");
    expect(JSON.stringify(last)).not.toContain("yyyy");
  });

  it(`runs at most ${MAX_CALLS_PER_STEP} calls per step and answers the rest with an error`, async () => {
    const { run, tool } = search();
    const { provider, requests } = stub((_r, n) =>
      n === 1
        ? turn([1, 2, 3, 4, 5].map((i) => call("search_items", { query: `q${i}` }, `c${i}`)))
        : turn([respond({ reply: "ok", matches: 0 })]),
    );
    await loop(provider, [tool]).promise;
    expect(run).toHaveBeenCalledTimes(MAX_CALLS_PER_STEP);
    const last = requests[1].history.at(-1) as { results: { id: string; output: Record<string, string> }[] };
    expect(last.results.map((r) => r.id)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(last.results[3].output.error).toBe("too_many_calls");
  });

  it("does not accept respond mixed with other calls before tool results are in", async () => {
    const { run, tool } = search();
    const { provider, requests } = stub((_r, n) =>
      n === 1
        ? turn([call("search_items", { query: "a" }), respond({ reply: "guess", matches: 9 })])
        : turn([respond({ reply: "real", matches: 1 })]),
    );
    await expect(loop(provider, [tool]).promise).resolves.toMatchObject({ reply: "real" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(requests[1].history.at(-1))).toContain("invalid_final_answer");
  });

  it("feeds an invalid early final answer back; an invalid forced one is invalid_output", async () => {
    const { tool } = search();
    const first = stub((_r, n) => (n === 1 ? turn([respond({ reply: "", matches: 1 })]) : turn([respond({ reply: "fine", matches: 1 })])));
    await expect(loop(first.provider, [tool]).promise).resolves.toMatchObject({ reply: "fine" });
    expect(JSON.stringify(first.requests[1].history.at(-1))).toContain("did not match the schema");

    const bad = stub(() => turn([respond({ nope: true })]));
    await expect(loop(bad.provider, [tool], { maxSteps: 1 }).promise).rejects.toMatchObject({ kind: "invalid_output" });
  });

  it("nudges a plain-text answer toward respond", async () => {
    const { tool } = search();
    const { provider, requests } = stub((_r, n) => (n === 1 ? turn([], "Here you go: ...") : turn([respond({ reply: "ok", matches: 0 })])));
    await expect(loop(provider, [tool]).promise).resolves.toMatchObject({ reply: "ok" });
    expect(requests[1].history.slice(-2)).toMatchObject([{ role: "assistant" }, { role: "user", text: expect.stringContaining("respond") }]);
  });

  it("ends with tool_loop/timeout when a handler outlives the deadline, even if it ignores the signal", async () => {
    const tool = defineTool({ name: "slow", description: "x", args: z.object({}), kind: "read", run: () => new Promise(() => {}) });
    const { provider } = stub(() => turn([call("slow", {})]));
    const started = Date.now();
    await expect(loop(provider, [tool], { deadlineMs: 80 }).promise).rejects.toMatchObject({ kind: "tool_loop", status: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("ends with tool_loop/timeout when the deadline passes between steps", async () => {
    const { tool } = search();
    const { provider } = stub(async (_r, n) => {
      await new Promise((r) => setTimeout(r, 60));
      return turn([call("search_items", { query: "x" }, `c${n}`)]);
    });
    await expect(loop(provider, [tool], { deadlineMs: 100 }).promise).rejects.toMatchObject({ kind: "tool_loop", status: "timeout" });
  });

  it("treats a native timeout at the deadline (e.g. a stalled response body) as tool_loop/timeout", async () => {
    const { tool } = search();
    const { provider } = stub(async () => {
      await new Promise((r) => setTimeout(r, 70));
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    await expect(loop(provider, [tool], { deadlineMs: 60 }).promise).rejects.toMatchObject({ kind: "tool_loop", status: "timeout" });
  });

  it("rejects bad tool definitions before any model call", async () => {
    const { provider, requests } = stub(() => turn([]));
    const mk = (name: string) => defineTool({ name, description: "x", args: z.object({}), kind: "read", run: async () => null });
    await expect(loop(provider, [mk("respond")]).promise).rejects.toThrow(/reserved/);
    await expect(loop(provider, [mk("a"), mk("a")]).promise).rejects.toThrow(/duplicate/);
    await expect(loop(provider, [mk("Bad Name")]).promise).rejects.toThrow(/invalid tool name/);
    await expect(loop(provider, []).promise).rejects.toThrow(/1 to/);
    expect(requests).toHaveLength(0);
  });

  it("round-trips the provider's raw model turn untouched (thought signatures)", async () => {
    const { tool } = search();
    const raw = { parts: [{ functionCall: { name: "search_items", args: { query: "a" } }, thoughtSignature: "opaque-sig-123" }] };
    const seen: unknown[] = [];
    const provider: AiProvider = {
      name: "stub",
      model: "m",
      complete: () => Promise.reject(new Error("no")),
      step: async (req) => {
        seen.push(req.history.find((h) => h.role === "model_calls"));
        return req.history.length === 1
          ? { calls: [call("search_items", { query: "a" })], text: "", raw }
          : turn([respond({ reply: "ok", matches: 0 })]);
      },
    };
    await loop(provider, [tool]).promise;
    expect(seen[1]).toMatchObject({ role: "model_calls", raw: { parts: [{ thoughtSignature: "opaque-sig-123" }] } });
    expect((seen[1] as { raw: unknown }).raw).toBe(raw); // same object: never cloned, edited or reordered
  });
});

describe("generate() with tools", () => {
  const items = () => search();

  it("answers from the demo script in demo mode, running the real handler", async () => {
    const { run, tool } = items();
    const result = await generate({
      task: "items-assistant",
      system: "s",
      prompt: "any setup items?",
      schema: answer,
      tools: [tool],
      demoContext: { query: "setup" },
    });
    expect(result).toMatchObject({ demo: true, provider: "demo", data: { matches: 1 } });
    expect(result.data.reply).toContain("Demo assistant");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("validates demo script calls like live ones (allow-list and args)", async () => {
    const { run, tool } = items();
    const result = await generate({
      task: "items-assistant",
      system: "s",
      prompt: "p",
      schema: answer,
      tools: [tool],
      demoContext: { query: "" }, // min(1): the script's call is rejected, so no handler run
    });
    expect(run).not.toHaveBeenCalled();
    expect(result.data.matches).toBe(0);
  });

  it("explains a missing demo script", async () => {
    const { tool } = items();
    await expect(generate({ task: "no-script", system: "s", prompt: "p", schema: answer, tools: [tool] })).rejects.toThrow(/demoToolScripts/);
  });

  it("validates input: one of prompt/messages, size, step and deadline limits", async () => {
    const { tool } = items();
    const base = { task: "items-assistant", system: "s", schema: answer, tools: [tool] };
    const bad = async (extra: object) =>
      expect(generate({ ...base, ...extra } as never)).rejects.toMatchObject({ kind: "input_rejected" });
    await bad({});
    await bad({ prompt: "p", messages: [{ role: "user", content: "p" }] });
    await bad({ messages: [] });
    await bad({ messages: [{ role: "assistant", content: "hi" }] });
    await bad({ messages: [{ role: "user", content: "x".repeat(12_001) }] });
    await bad({ prompt: "p", maxSteps: 7 });
    await bad({ prompt: "p", maxSteps: 0 });
    await bad({ prompt: "p", deadlineMs: 60_001 });
  });

  it("drives Gemini through a tool loop and sends the thought signature back verbatim", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "test-key", AI_FALLBACK_TO_DEMO: "false" });
    const { run, tool } = items();
    const modelParts = [
      { text: "thinking...", thought: true },
      { functionCall: { name: "search_items", args: { query: "setup" } }, thoughtSignature: "SIG-A" },
      { functionCall: { name: "search_items", args: { query: "other" } } },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: modelParts } }] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "respond", args: { reply: "Two.", matches: 2 } } }] } }] }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await generate({
      task: "items-assistant",
      system: "sys",
      messages: [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "find setup" },
      ],
      schema: answer,
      tools: [tool],
    });
    expect(result).toMatchObject({ demo: false, provider: "gemini", data: { matches: 2 } });
    expect(run).toHaveBeenCalledTimes(2);

    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(first.generationConfig.responseMimeType).toBeUndefined();
    expect(first.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(first.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(first.tools[0].functionDeclarations.map((d: { name: string }) => d.name)).toEqual(["search_items", "respond"]);
    expect(first.systemInstruction.parts[0].text).toContain("not instructions");

    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    const modelTurn = second.contents[3];
    expect(modelTurn).toEqual({ role: "model", parts: modelParts }); // verbatim, signature included
    const responses = second.contents[4];
    expect(responses.role).toBe("user");
    expect(responses.parts).toHaveLength(2); // parallel calls answered together, in order
    expect(responses.parts[0].functionResponse).toMatchObject({ name: "search_items", response: { data: [{ id: "i1" }] } });
    expect(responses.parts[0].functionResponse.id).toBeUndefined(); // the model gave no id
    expect(second.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
  });

  it("forces respond on the last Gemini step", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", AI_FALLBACK_TO_DEMO: "false" });
    const { tool } = items();
    const toolTurn = () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "search_items", args: { query: "q" } } }] } }] }));
    const fetchMock = vi.fn().mockImplementation(async () => toolTurn());
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      generate({ task: "items-assistant", system: "s", prompt: "p", schema: answer, tools: [tool], maxSteps: 2 }),
    ).rejects.toMatchObject({ kind: "tool_loop" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["respond"] },
    });
  });

  it("drives Anthropic through a tool loop with tool_choice forcing", async () => {
    setEnv({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", AI_FALLBACK_TO_DEMO: "false" });
    const { tool } = items();
    const blocks = [{ type: "tool_use", id: "tu_1", name: "search_items", input: { query: "setup" } }];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: blocks })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: "tool_use", id: "tu_2", name: "respond", input: { reply: "One.", matches: 1 } }] })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const result = await generate({ task: "items-assistant", system: "s", prompt: "p", schema: answer, tools: [tool], maxSteps: 2 });
    expect(result.data.matches).toBe(1);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(second.tool_choice).toEqual({ type: "tool", name: "respond" });
    expect(second.messages[1]).toEqual({ role: "assistant", content: blocks });
    expect(second.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1" });
    expect(second.system).not.toContain("JSON only");
  });

  it("maps provider errors like generate() does and falls back to the demo script", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", AI_FALLBACK_TO_DEMO: "false" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 429 })));
    const { tool } = items();
    const req = { task: "items-assistant", system: "s", prompt: "p", schema: answer, tools: [tool] };
    await expect(generate(req)).rejects.toMatchObject({ kind: "quota", status: 429 });

    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    const result = await generate(req);
    expect(result.demo).toBe(true);
  });

  it("maps a response body that stalls past the deadline to tool_loop/timeout, with no demo fallback", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    const { run, tool } = items();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () => new Promise((_, reject) => setTimeout(() => reject(new DOMException("timeout", "TimeoutError")), 80)),
      }),
    );
    await expect(
      generate({ task: "items-assistant", system: "s", prompt: "p", schema: answer, tools: [tool], deadlineMs: 60 }),
    ).rejects.toMatchObject({ kind: "tool_loop", status: "timeout" });
    expect(run).not.toHaveBeenCalled();
  });

  it("shares one deadline with the demo fallback", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" }); // fallback on
    const run = vi.fn(() => new Promise<unknown[]>((r) => setTimeout(() => r([]), 150)));
    const tool = defineTool({ name: "search_items", description: "x", args: z.object({ query: z.string().min(1) }), kind: "read", run });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 100));
        return new Response("{}", { status: 500 });
      }),
    );
    const started = Date.now();
    // 100 ms in the live attempt + a 150 ms handler in the demo path must not fit a 200 ms budget.
    await expect(
      generate({ task: "items-assistant", system: "s", prompt: "p", schema: answer, tools: [tool], deadlineMs: 200 }),
    ).rejects.toMatchObject({ kind: "tool_loop", status: "timeout" });
    expect(Date.now() - started).toBeLessThan(260);
  });

  it("never falls back to the demo after a propose handler ran: the error surfaces, handler ran once", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" }); // fallback on
    const run = vi.fn(async () => ({ proposalId: "p1" }));
    const tool = defineTool({ name: "propose_x", description: "x", args: z.object({}), kind: "propose", run });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "propose_x", args: {} } }] } }] })),
      )
      .mockResolvedValue(new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      generate({ task: "items-assistant", system: "s", prompt: "p", schema: answer, tools: [tool] }),
    ).rejects.toMatchObject({ kind: "provider", status: 503 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("throws a bad tool definition as a plain error before any model call or fallback", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const bad = defineTool({ name: "respond", description: "x", args: z.object({}), kind: "read", run: async () => null });
    await expect(generate({ task: "items-assistant", system: "s", prompt: "p", schema: answer, tools: [bad] })).rejects.toThrow(/reserved/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a throwing (async) arg schema into a tool error", async () => {
    const run = vi.fn();
    const tool = defineTool({
      name: "asyncy",
      description: "x",
      args: z.object({ a: z.string().refine(async () => true) }),
      kind: "read",
      run,
    });
    const { provider, requests } = stub((_r, n) => (n === 1 ? turn([call("asyncy", { a: "x" })]) : turn([respond({ reply: "ok", matches: 0 })])));
    await expect(loop(provider, [tool]).promise).resolves.toMatchObject({ reply: "ok" });
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(requests[1].history.at(-1))).toContain("tool_error");
  });

  it("does not fall back to the demo when the loop itself is exhausted", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" }); // fallback defaults on
    const { tool } = items();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "search_items", args: { query: "q" } } }] } }] })),
      ),
    );
    await expect(
      generate({ task: "items-assistant", system: "s", prompt: "p", schema: answer, tools: [tool], maxSteps: 2 }),
    ).rejects.toMatchObject({ kind: "tool_loop" });
  });

  it("logs tool names, steps and latency but never arguments, results or prompts", async () => {
    setEnv({ AI_PROVIDER: "demo", LOG_LEVEL: "info" });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(String(l)));
    const run = vi.fn(async () => [{ title: "SECRET-RESULT-TEXT" }]);
    const tool = defineTool({ name: "search_items", description: "x", args: z.object({ query: z.string() }), kind: "read", run });
    await generate({
      task: "items-assistant",
      system: "SECRET-SYSTEM",
      prompt: "SECRET-PROMPT",
      schema: answer,
      tools: [tool],
      demoContext: { query: "SECRET-ARG" },
    });
    const entry = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "ai.tool_loop");
    expect(entry).toMatchObject({ task: "items-assistant", demo: true, outcome: "ok", steps: 2, calls: [{ tool: "search_items", outcome: "ok" }] });
    expect(typeof entry.calls[0].ms).toBe("number");
    for (const secret of ["SECRET-RESULT-TEXT", "SECRET-ARG", "SECRET-PROMPT", "SECRET-SYSTEM"]) {
      expect(lines.join("\n")).not.toContain(secret);
    }
  });
});

describe("generate() without tools", () => {
  it("sends exactly the request it always did", async () => {
    setEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", AI_TIMEOUT_MS: "20000" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"summary":"s","highlights":[]}' }] } }] })));
    vi.stubGlobal("fetch", fetchMock);
    await generate({ task: "summarize-items", system: "SYS", prompt: "PROMPT", schema: z.object({ summary: z.string(), highlights: z.array(z.string()) }) });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      systemInstruction: { parts: [{ text: "SYS" }] },
      contents: [{ role: "user", parts: [{ text: "PROMPT" }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 800, thinkingConfig: { thinkingLevel: "low" } },
    });
  });
});

