import type { z } from "zod";

export type AiImage = {
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif";
  /** Base64 of the raw bytes: no `data:` prefix, no line breaks. */
  data: string;
};

type GenerateBase<T> = {
  /** Stable name for this AI feature, e.g. "summarize-items". Used for demo fixtures and logs. */
  task: string;
  system: string;
  /** Output is parsed as JSON and validated; invalid output is an error, never shown raw. */
  schema: z.ZodType<T>;
  maxOutputTokens?: number;
};

/** One turn of server-built conversation history. The client never supplies these. */
export type ChatMessage = { role: "user" | "assistant"; content: string };

/**
 * What a tool handler is told. Deliberately NOT the acting user: handlers close over the actor and
 * call `assertCan()` / owner checks themselves, so nothing the model says can change who is acting.
 */
export type ToolContext = { signal: AbortSignal };

export type ToolDef<A = unknown, R = unknown> = {
  /** `^[a-z][a-z0-9_]{0,39}$`; `respond` is reserved for the final answer. */
  name: string;
  description: string;
  /** Validated on every call; the model's JSON Schema is generated from it. */
  args: z.ZodType<A>;
  /** "read" looks things up; "propose" records something a human must confirm. Nothing here may change money or data on its own. */
  kind: "read" | "propose";
  run(args: A, ctx: ToolContext): Promise<R>;
};

/** What `tools` accepts (see `defineTool` for inference). */
export type AnyToolDef = ToolDef<unknown, unknown>;

/** Throw this from a handler to tell the model something safe to read. Any other error becomes a generic failure. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message.slice(0, 200));
    this.name = "ToolError";
  }
}

/** The outcome of one tool call, as given to a demo script's `final()` (and its `call` functions). */
export type DemoToolResult = { name: string; ok: boolean; data: unknown };

export type DemoToolCall = { name: string; args: unknown };
export type DemoToolScript = {
  /** Calls to make, in order, one per step. A function sees the results so far. */
  steps: { call: DemoToolCall | ((previous: DemoToolResult[]) => DemoToolCall) }[];
  /** Builds the final answer; it is validated against the request's schema like a live one. */
  final: (results: DemoToolResult[]) => unknown;
};

type ToolFields = {
  /** The allow-list for this call: a model can only invoke tools listed here. Max 10. */
  tools: AnyToolDef[];
  /** Model calls, including the forced final one. Default 4, max 6. */
  maxSteps?: number;
  /** Wall-clock budget for the whole loop in ms. Default 24,000, max 60,000. */
  deadlineMs?: number;
  /** Passed to `demoToolScripts[task]` in demo mode (e.g. the data the scripted calls need). */
  demoContext?: unknown;
};

export type GenerateRequest<T> = GenerateBase<T> &
  (
    | {
        prompt: string;
        /** Optional images (max 4, 5 MB each, 10 MB total). Demo mode ignores them and answers from the fixture. */
        images?: AiImage[];
        tools?: undefined;
        messages?: undefined;
      }
    // Tool-use loop. Exactly one of `prompt` / `messages`; images are not supported here.
    | (ToolFields & { prompt: string; messages?: undefined; images?: undefined })
    | (ToolFields & { messages: ChatMessage[]; prompt?: undefined; images?: undefined })
  );

export type GenerateResult<T> = {
  data: T;
  provider: string;
  model: string;
  /** True when the answer came from recorded demo data instead of a live model. */
  demo: boolean;
  latencyMs: number;
};

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Returns raw model text, expected to be JSON. */
  complete(req: { system: string; prompt: string; maxOutputTokens: number; images?: AiImage[] }): Promise<string>;
  /** One model turn of a tool loop. Providers without it can't serve `tools` requests. */
  step?(req: ToolStepRequest): Promise<ToolStepResult>;
}

export type ToolDeclaration = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { id: string; name: string; args: unknown };

/** Provider-neutral conversation for a tool loop. `raw` is the provider's own representation of a model turn. */
export type ToolHistoryItem =
  | { role: "user" | "assistant"; text: string }
  /** A model turn that requested calls. `raw` is opaque to the loop and returned to the provider verbatim (Gemini thought signatures). */
  | { role: "model_calls"; calls: ToolCall[]; raw: unknown }
  | { role: "tool_results"; results: { id: string; name: string; output: Record<string, unknown> }[] };

export type ToolStepRequest = {
  system: string;
  history: ToolHistoryItem[];
  /** Includes the reserved `respond` declaration (its parameters are the final answer's schema). */
  tools: ToolDeclaration[];
  /** True on the last step: the provider must force a `respond` call. */
  forceRespond: boolean;
  maxOutputTokens: number;
  /** Absolute epoch ms by which the provider call must finish. */
  deadlineAt: number;
};

export type ToolStepResult = {
  calls: ToolCall[];
  text: string;
  /** Provider-specific model turn, kept verbatim and sent back on the next step. */
  raw: unknown;
};

export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: "quota" | "provider" | "invalid_output" | "input_rejected" | "tool_loop",
    /** HTTP status from the provider, or "timeout"; safe to log (never the response body). */
    readonly status?: number | "timeout",
  ) {
    super(message);
    this.name = "AiError";
  }
}

export type EmbedRequest = {
  /** Stable name for the caller, e.g. "embed-note". Used in logs. */
  task: string;
  texts: string[];
  /** "document" for content being indexed, "query" for a search question. */
  kind: "document" | "query";
};

export type EmbedResult = {
  /** One L2-normalized vector per input text, in order. */
  vectors: number[][];
  provider: string;
  /** Callers must store this with the vector and only compare vectors with the same model. */
  model: string;
  dims: number;
  demo: boolean;
  latencyMs: number;
};
