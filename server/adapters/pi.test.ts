import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatModel } from "../../shared/protocol.js";
import type { ChatTranslator } from "./types.js";
import {
  createPiAdapter,
  enabledModelIds,
  piModels,
  piThinkingLevels,
} from "./pi.js";

// Pure translator tests: drive pi RPC lines through `push()` and assert the
// normalized ChatEvents, with no process/tokens. Covers the retry/settle
// message types (auto_retry_end, agent_settled) and how agent_end interacts
// with a pending automatic retry.

function translator(): ChatTranslator {
  const adapter = createPiAdapter({ enabled: true, command: "pi" });
  // Empty cwd keeps the translator off the filesystem: pi's enabledModels live
  // in the developer's own settings, which a pure test must never read.
  return adapter.createChatTranslator!({ cwd: "" });
}

/** Feed one pi RPC event as a JSONL line and return the emitted ChatEvents. */
function feed(t: ChatTranslator, line: unknown): ChatEvent[] {
  return t.push(`${JSON.stringify(line)}\n`);
}

describe("pi retry / settle events", () => {
  it("surfaces a successful auto-retry as an info notice", () => {
    const t = translator();
    expect(feed(t, { type: "auto_retry_end", success: true, attempt: 2 })).toEqual([
      { type: "notice", level: "info", text: expect.stringContaining("Recovered") },
    ]);
  });

  it("surfaces a failed auto-retry as an error notice with the final error", () => {
    const t = translator();
    const events = feed(t, {
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "529 overloaded_error: Overloaded",
    });
    expect(events).toEqual([
      {
        type: "notice",
        level: "error",
        text: expect.stringContaining("529 overloaded_error: Overloaded"),
      },
    ]);
  });

  it("clears busy on agent_settled", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    expect(feed(t, { type: "agent_settled" })).toContainEqual({
      type: "busy",
      busy: false,
    });
  });

  it("keeps busy on agent_end when a retry is pending (no idle flicker)", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    const events = feed(t, { type: "agent_end", willRetry: true, messages: [] });
    expect(events).not.toContainEqual({ type: "busy", busy: false });
  });

  it("clears busy on a final agent_end (no retry pending)", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    expect(feed(t, { type: "agent_end", messages: [] })).toContainEqual({
      type: "busy",
      busy: false,
    });
  });

  it("steers a prompt sent during the retry gap (busy still held)", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    feed(t, { type: "agent_end", willRetry: true, messages: [] });
    const { data } = t.encode({ type: "prompt", text: "hi" });
    expect(data).toContain('"streamingBehavior":"steer"');
  });

  it("sends a plain prompt once the run has settled", () => {
    const t = translator();
    feed(t, { type: "agent_start" });
    feed(t, { type: "agent_end", willRetry: true, messages: [] });
    feed(t, { type: "agent_settled" });
    const { data } = t.encode({ type: "prompt", text: "hi" });
    expect(data).not.toContain("streamingBehavior");
  });
});

describe("pi text/thinking deltas", () => {
  /** Open an assistant message so message_update events are accepted. */
  function streaming(): ChatTranslator {
    const t = translator();
    feed(t, { type: "message_start", message: { role: "assistant" } });
    return t;
  }

  const update = (event: unknown) => ({
    type: "message_update",
    assistantMessageEvent: event,
  });

  it("tags a text delta with its kind", () => {
    const t = streaming();
    expect(feed(t, update({ type: "text_delta", delta: "hi" }))).toEqual([
      { type: "part-delta", kind: "text", delta: "hi" },
    ]);
  });

  it("tags a thinking delta with its kind", () => {
    const t = streaming();
    expect(feed(t, update({ type: "thinking_delta", delta: "hmm" }))).toEqual([
      { type: "part-delta", kind: "thinking", delta: "hmm" },
    ]);
  });

  it("keeps the kind on a thinking delta that trails the text part", () => {
    // pi reads a chunk's `content` before its `reasoning*` fields, so a chunk
    // straddling </think> emits text_start/text_delta and only then the
    // thinking_delta carrying the reasoning tail. The kind is what lets the
    // reducer put that tail back in the thinking part.
    const t = streaming();
    feed(t, update({ type: "text_start" }));
    feed(t, update({ type: "text_delta", delta: "\n\nPR" }));
    expect(feed(t, update({ type: "thinking_delta", delta: ".\n" }))).toEqual([
      { type: "part-delta", kind: "thinking", delta: ".\n" },
    ]);
  });
});

// --- model switcher ---------------------------------------------------------
//
// pi answers `get_available_models` / `get_state` / `set_model` as `response`
// lines. Two facts drive the shape of these tests, both observed live:
//   - responses are NOT ordered against their requests (a `get_state` came back
//     before an earlier `set_model`), so the translator must hold the current
//     model itself rather than relying on arrival order;
//   - `set_model`'s `data` IS the Model object, while `get_state`'s nests it
//     under `data.model`.

/** A pi Model object, trimmed to the fields the menu reads. */
function model(provider: string, id: string, name?: string, extra = {}) {
  return { id, name: name ?? id, provider, contextWindow: 200000, ...extra };
}

function modelsResponse(models: unknown[]) {
  return {
    type: "response",
    command: "get_available_models",
    success: true,
    data: { models },
  };
}

describe("pi model switcher", () => {
  it("asks for the model list and current state at startup", () => {
    const t = translator();
    const init = t.init!();
    expect(init).toContain('"get_available_models"');
    expect(init).toContain('"get_state"');
    // Each query is its own JSONL line.
    expect(init.trimEnd().split("\n")).toHaveLength(3);
  });

  it("maps the model list to grouped menu entries", () => {
    // The provider rides in `group`, not the label — the UI gives it its own box.
    const t = translator();
    const events = feed(
      t,
      modelsResponse([model("anthropic", "claude-sonnet-4-20250514", "Claude Sonnet 4")]),
    );
    expect(events).toEqual([
      {
        type: "models",
        current: null,
        models: [
          {
            id: "anthropic/claude-sonnet-4-20250514",
            label: "Claude Sonnet 4",
            group: "anthropic",
            description: expect.stringContaining("200K context"),
          },
        ],
      },
    ]);
  });

  it("orders local providers first, then the rest alphabetically", () => {
    const t = translator();
    const [listed] = feed(
      t,
      modelsResponse([
        model("openai", "gpt-5"),
        model("baseten", "zai-org/GLM-5"),
        model("vllm", "local-a"),
        model("ollama", "local-b"),
        model("vllm", "local-a2"),
      ]),
    );
    expect((listed as { models: ChatModel[] }).models.map((m) => m.group)).toEqual([
      "vllm",
      "vllm",
      "ollama",
      "baseten",
      "openai",
    ]);
    // Stable within a provider: pi's own order survives.
    expect((listed as { models: ChatModel[] }).models[0].id).toBe("vllm/local-a");
  });

  it("keeps a model id that itself contains a slash addressable", () => {
    // Provider names never contain "/", but ids routinely do — so the composite
    // id splits at the FIRST slash only.
    const t = translator();
    const [listed] = feed(t, modelsResponse([model("baseten", "deepseek-ai/DeepSeek-V4-Pro")]));
    const id = (listed as { models: { id: string }[] }).models[0].id;
    expect(id).toBe("baseten/deepseek-ai/DeepSeek-V4-Pro");
    expect(t.encode({ type: "set-model", model: id }).data).toBe(
      `${JSON.stringify({
        type: "set_model",
        provider: "baseten",
        modelId: "deepseek-ai/DeepSeek-V4-Pro",
      })}\n`,
    );
  });

  it("reports the current model from get_state", () => {
    const t = translator();
    expect(
      feed(t, {
        type: "response",
        command: "get_state",
        success: true,
        data: { model: model("vllm", "Qwen3.8-Flash-Next"), thinkingLevel: "high" },
      }),
    ).toEqual([{ type: "model-changed", current: "vllm/Qwen3.8-Flash-Next" }]);
  });

  it("confirms a switch from set_model's own reply", () => {
    const t = translator();
    expect(
      feed(t, {
        type: "response",
        command: "set_model",
        success: true,
        data: model("vllm", "Qwen3.8-Flash-Next"),
      }),
    ).toEqual([{ type: "model-changed", current: "vllm/Qwen3.8-Flash-Next" }]);
  });

  it("surfaces a rejected switch as an error notice", () => {
    const t = translator();
    expect(
      feed(t, {
        type: "response",
        command: "set_model",
        success: false,
        error: "Model not found: vllm/nope",
      }),
    ).toEqual([
      { type: "notice", level: "error", text: "Model not found: vllm/nope" },
    ]);
  });

  it("carries the known current model into a later list response", () => {
    // The `models` fold overwrites currentModel wholesale, so a list arriving
    // after get_state must restate the current model or it would blank it.
    const t = translator();
    feed(t, {
      type: "response",
      command: "get_state",
      success: true,
      data: { model: model("vllm", "Qwen3.8-Flash-Next") },
    });
    const [listed] = feed(t, modelsResponse([model("vllm", "Qwen3.8-Flash-Next")]));
    expect(listed).toMatchObject({ current: "vllm/Qwen3.8-Flash-Next" });
  });

  it("does not let a late get_state revert a switch the user already made", () => {
    // Observed live: pi answered a get_state before an earlier set_model.
    const t = translator();
    feed(t, {
      type: "response",
      command: "set_model",
      success: true,
      data: model("vllm", "Qwen3.8-Flash-Next"),
    });
    expect(
      feed(t, {
        type: "response",
        command: "get_state",
        success: true,
        data: { model: model("vllm", "RedHatAI/gemma-4-31B-it-NVFP4") },
      }),
    ).toEqual([]);
  });

  it("confirms a switch that lands on the model already in use", () => {
    // Not deduped: the user asked and pi answered, so the menu must settle on
    // that. Only an unsolicited get_state echo is dropped.
    const t = translator();
    const reply = {
      type: "response",
      command: "set_model",
      success: true,
      data: model("vllm", "Qwen3.8-Flash-Next"),
    };
    feed(t, reply);
    expect(feed(t, reply)).toEqual([
      { type: "model-changed", current: "vllm/Qwen3.8-Flash-Next" },
    ]);
  });

  it("ignores a model entry missing its provider or id", () => {
    const t = translator();
    const [listed] = feed(t, modelsResponse([{ name: "orphan" }, model("vllm", "ok")]));
    expect((listed as { models: unknown[] }).models).toHaveLength(1);
  });
});

describe("pi thinking level (effort picker)", () => {
  const reasoner = (extra = {}) =>
    model("vllm", "think", undefined, { reasoning: true, ...extra });
  const state = (m: unknown, thinkingLevel?: string) => ({
    type: "response",
    command: "get_state",
    success: true,
    data: { model: m, thinkingLevel },
  });
  const ids = (e: ChatEvent) =>
    (e as { efforts: { id: string }[] }).efforts.map((x) => x.id);

  it("mirrors pi's getSupportedThinkingLevels", () => {
    expect(piThinkingLevels({})).toEqual(["off"]);
    expect(piThinkingLevels({ reasoning: true })).toEqual([
      "off", "minimal", "low", "medium", "high",
    ]);
    // xhigh/max only when mapped; a null mapping removes any level.
    expect(
      piThinkingLevels({
        reasoning: true,
        thinkingLevelMap: { minimal: null, xhigh: "x", max: null },
      }),
    ).toEqual(["off", "low", "medium", "high", "xhigh"]);
  });

  it("offers the current model's levels with get_state's level selected", () => {
    const t = translator();
    const events = feed(t, state(reasoner(), "medium"));
    const efforts = events.find((e) => e.type === "efforts")!;
    expect(ids(efforts)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(efforts).toMatchObject({ current: "medium" });
  });

  it("offers no picker for a model without reasoning", () => {
    const t = translator();
    expect(feed(t, state(model("vllm", "plain"), "off")).map((e) => e.type)).toEqual([
      "model-changed",
    ]);
  });

  it("encodes set-effort as set_thinking_level, without an optimistic echo", () => {
    const t = translator();
    expect(t.encode({ type: "set-effort", effort: "low" })).toEqual({
      data: `${JSON.stringify({ type: "set_thinking_level", level: "low" })}\n`,
      events: [],
    });
  });

  it("follows thinking_level_changed", () => {
    const t = translator();
    feed(t, state(reasoner(), "medium"));
    expect(feed(t, { type: "thinking_level_changed", level: "low" })).toEqual([
      { type: "effort-changed", current: "low" },
    ]);
  });

  it("does not let a late get_state revert a level pi already reported", () => {
    // Observed live: thinking_level_changed arrived ahead of an earlier get_state.
    const t = translator();
    feed(t, { type: "thinking_level_changed", level: "low" });
    const efforts = feed(t, state(reasoner(), "high")).find((e) => e.type === "efforts");
    expect(efforts).toMatchObject({ current: "low" });
  });

  it("swaps the level list when a switch lands on another model", () => {
    const t = translator();
    feed(t, state(reasoner(), "high"));
    const events = feed(t, {
      type: "response",
      command: "set_model",
      success: true,
      data: model("openai", "gpt", undefined, {
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh" },
      }),
    });
    expect(ids(events.find((e) => e.type === "efforts")!)).toContain("xhigh");
    // Switching to a non-reasoning model hides the picker.
    const off = feed(t, {
      type: "response",
      command: "set_model",
      success: true,
      data: model("vllm", "plain"),
    });
    expect(off.find((e) => e.type === "efforts")).toMatchObject({ efforts: [] });
  });
});

// --- enabled/disabled sections ----------------------------------------------
//
// Mirrors pi's `resolveModelScopeFromModels` precedence. Verified against its
// source: canonical `provider/id` → bare `id` (unambiguous only) → minimatch
// glob over both, with `*` not spanning a `/`.

describe("pi enabledModels matching", () => {
  const catalog = [
    model("vllm", "RedHatAI/gemma-4-31B-it-NVFP4"),
    model("baseten", "deepseek-ai/DeepSeek-V4.1-Flash"),
    model("baseten", "moonshotai/Kimi-K3"),
    model("openai", "gpt-5"),
    model("openai", "claude-sonnet-4"),
  ];
  const ids = (patterns: string[]) => [...enabledModelIds(patterns, catalog)];

  it("matches the canonical provider/id reference pi itself writes", () => {
    expect(ids(["baseten/deepseek-ai/DeepSeek-V4.1-Flash"])).toEqual([
      "baseten/deepseek-ai/DeepSeek-V4.1-Flash",
    ]);
  });

  it("is case-insensitive", () => {
    expect(ids(["VLLM/redhatai/GEMMA-4-31B-IT-NVFP4"])).toEqual([
      "vllm/RedHatAI/gemma-4-31B-it-NVFP4",
    ]);
  });

  it("matches a bare model id", () => {
    expect(ids(["gpt-5"])).toEqual(["openai/gpt-5"]);
  });

  it("ignores a trailing thinking-level suffix", () => {
    expect(ids(["openai/gpt-5:high"])).toEqual(["openai/gpt-5"]);
  });

  it("keeps a colon that isn't a thinking level", () => {
    expect(ids(["openai/gpt-5:bogus"])).toEqual([]);
  });

  it("expands a provider glob", () => {
    expect(ids(["openai/*"])).toEqual(["openai/gpt-5", "openai/claude-sonnet-4"]);
  });

  it("does not let * span a slash, as minimatch doesn't", () => {
    // "baseten/*" must not reach "baseten/moonshotai/Kimi-K3" via the full ref…
    expect(ids(["baseten/*"])).toEqual([]);
    // …while "**" does.
    expect(ids(["baseten/**"])).toHaveLength(2);
  });

  it("matches a bare-id glob against the id as well as the full reference", () => {
    expect(ids(["*sonnet*"])).toEqual(["openai/claude-sonnet-4"]);
  });

  it("unions several patterns without duplicating", () => {
    expect(ids(["openai/*", "gpt-5"])).toHaveLength(2);
  });

  it("ignores a pattern that matches nothing", () => {
    expect(ids(["nope/not-real"])).toEqual([]);
  });
});

describe("pi model sections", () => {
  const catalog = [
    model("vllm", "local-a"),
    model("vllm", "local-b"),
    model("openai", "gpt-5"),
  ];

  it("splits each provider into Enabled then Disabled", () => {
    const menu = piModels(catalog, ["vllm/local-b"]);
    expect(menu.map((m) => [m.id, m.section])).toEqual([
      ["vllm/local-b", "Enabled"],
      ["vllm/local-a", "Disabled"],
      ["openai/gpt-5", "Disabled"],
    ]);
  });

  it("leaves models unsectioned when nothing is curated", () => {
    // Calling every model "Disabled" would be a lie — pi shows them all too.
    for (const patterns of [undefined, [], ["nope/not-real"]])
      expect(piModels(catalog, patterns).every((m) => !m.section)).toBe(true);
  });
});

describe("invocation", () => {
  const adapter = createPiAdapter({ enabled: true, command: "pi" });
  it("appends co-create framing to the system prompt", () => {
    expect(adapter.appendsSystemPrompt).toBe(true);
    expect(adapter.invocation({ cwd: "", appendSystemPrompt: "edit doc.md" }).args).toEqual([
      "--mode",
      "rpc",
      "--append-system-prompt",
      "edit doc.md",
    ]);
    expect(adapter.invocation({ cwd: "" }).args).toEqual(["--mode", "rpc"]);
  });
});
