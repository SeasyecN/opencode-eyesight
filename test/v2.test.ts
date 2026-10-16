import { expect, spyOn, test } from "bun:test";
import { Media } from "@opencode/ai";
import type { Message } from "@opencode/ai";
import type { Plugin } from "@opencode/plugin";
import type { SessionRequest } from "@opencode/plugin/promise/session";
import { OpenCode, type SessionMessageInfo } from "@opencode/client";
import plugin from "../src/index";
import { VISION_FALLBACK_NOTICE } from "../src/config";

const image = (uri = "data:image/png;base64,cGljdHVyZQ==") => ({
  type: "media" as const,
  media: new Media.Asset({ source: { type: "url", url: uri, mediaType: "image/png" } }),
  filename: "screen.png",
});
const request = (content: Message["content"] = [image()], id = "parent"): SessionRequest => ({
  sessionID: id as any, model: { providerID: "text", id: "model" } as any,
  messages: [{ role: "user", content: [{ type: "text", text: "Compare the buttons" }, ...content] }],
  system: [], options: {},
});

async function fixture(
  options: Record<string, unknown> = { model: "vision/model" },
  existing?: any,
  api: Partial<Plugin.Context["session"]> = {},
) {
  const hooks = new Map<string, (event: SessionRequest) => Promise<void> | void>();
  const agents = new Map(existing ? [["vision", existing]] : []);
  const calls = { create: [] as any[], prompt: [] as any[], remove: [] as any[], wait: [] as any[], context: [] as any[], get: [] as any[], models: [] as any[] };
  let capable = false;
  let promptImpl: undefined | ((input: any, opts: any) => Promise<void>);
  let createImpl: undefined | (() => Promise<void>);
  let waitImpl: undefined | ((input: any, opts: any) => Promise<void>);
  let removeImpl: undefined | (() => Promise<void>);
  let response: SessionMessageInfo[] = [{ type: "assistant", content: [{ type: "text", text: "A blue button" }] } as SessionMessageInfo];
  let directory = "/fixture/project";
  let wake: (() => void) | undefined;
  const queue: any[] = [];
  const ctx = {
    location: { directory: "/fixture/project" }, options,
    model: { list: async (...args: any[]) => {
      calls.models.push(args);
      return { location: {}, data: [{ providerID: "text", id: "model", capabilities: { input: capable ? ["text", "image"] : ["text"] } }] };
    } },
    agent: { transform: async (edit: any) => {
      const editor = { get: (id: string) => agents.get(id), update: (id: string, f: any) => {
        const agent = agents.get(id) ?? {};
        f(agent); agents.set(id, agent);
      } };
      edit(editor); edit(editor); // registry replay must be harmless
    } },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      while (!signal.aborted) {
        if (queue.length) { yield queue.shift(); continue; }
        await new Promise<void>((resolve) => {
          const finish = () => { signal.removeEventListener("abort", finish); resolve(); };
          wake = finish;
          signal.addEventListener("abort", finish, { once: true });
        });
      }
    } },
    session: {
      hook: async (kind: string, hook: any) => { hooks.set(kind, hook); },
      get: async (...args: any[]) => { calls.get.push(args); return { location: { directory } }; },
      create: async (input: any) => {
        calls.create.push(input);
        const id = `internal-${calls.create.length}`;
        await createImpl?.();
        return { id };
      },
      prompt: async (input: any, opts: any) => { calls.prompt.push([input, opts]); await promptImpl?.(input, opts); return { type: "user" }; },
      wait: async (input: any, opts: any) => { calls.wait.push([input, opts]); await waitImpl?.(input, opts); },
      context: async (input: any, opts: any) => {
        calls.context.push([input, opts]);
        return response;
      },
      remove: async (input: any, opts: any) => { calls.remove.push([input, opts]); await removeImpl?.(); },
      ...api,
    },
  };
  const cleanup = await plugin.setup(ctx as unknown as Plugin.Context);
  return { ctx, calls, hooks, agents, cleanup: async () => { if (cleanup) await cleanup(); },
    capable: (value: boolean) => { capable = value; },
    onPrompt: (f: typeof promptImpl) => { promptImpl = f; },
    onCreate: (f: typeof createImpl) => { createImpl = f; },
    onWait: (f: typeof waitImpl) => { waitImpl = f; },
    onRemove: (f: typeof removeImpl) => { removeImpl = f; },
    response: (value: SessionMessageInfo[]) => { response = value; },
    move: (value: string) => { directory = value; },
    idle: (sessionID: string) => { queue.push({ type: "session.idle", data: { sessionID } }); wake?.(); },
    deleted: (sessionID: string) => { queue.push({ type: "session.deleted", data: { sessionID } }); wake?.(); },
  };
}

test("V2 setup registers every outgoing request hook, not durable prompt admission", async () => {
  const f = await fixture();
  try {
    expect([...f.hooks.keys()]).toEqual(["context", "generate", "compaction", "title"]);
    for (const hook of f.hooks.values()) {
      const event = request();
      const original = event.messages;
      await hook(event);
      expect(JSON.stringify(event.messages)).toContain("A blue button");
      expect(original[0].content[1].type).toBe("media");
      expect(event.system[0].text).toBe(VISION_FALLBACK_NOTICE);
    }
    expect(f.calls.create).toHaveLength(1); // cache across request kinds
    expect(f.calls.prompt[0][0]).toEqual({ sessionID: "internal-1", text: expect.stringContaining("context only"), files: [{ uri: "data:image/png;base64,cGljdHVyZQ==", name: "screen.png" }] });
    expect(f.calls.create[0].agent).toBe("vision");
    expect(f.calls.create[0].permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
    expect(f.calls.wait).toHaveLength(1);
    expect(f.calls.context).toHaveLength(1);
    expect(f.calls.remove).toEqual([[{ sessionID: "internal-1" }, undefined]]);
  } finally { await f.cleanup(); }
});

test("V2 text-only messages do not transcribe; image-capable models pass through", async () => {
  const f = await fixture();
  try {
    await f.hooks.get("context")!(request([]));
    const text = request([]);
    const textMessages = text.messages;
    await f.hooks.get("context")!(text);
    expect(text.messages).toBe(textMessages);
    f.capable(true);
    const event = request();
    const original = event.messages;
    await f.hooks.get("context")!(event);
    expect(event.messages).toBe(original);
    expect(event.system).toEqual([]);
    expect(f.calls.create).toHaveLength(0);
  } finally { await f.cleanup(); }
});

test("V2 external agent option, multiple images, tool content and non-image preservation", async () => {
  const f = await fixture({ agent: "multimodal-looker", model: "ignored/model" });
  try {
    const event = request([image("file:///fixture/a.png"), image("https://example.invalid/b.png")]);
    event.messages.push({ role: "tool", content: [{ type: "tool-result", id: "call", name: "screen", result: { type: "content", value: [
      { type: "text", text: "Original output" },
      { type: "file", uri: "file:///fixture/c.png", mime: "image/png" },
      { type: "file", uri: "file:///fixture/a.pdf", mime: "application/pdf" },
    ] } }] });
    await f.hooks.get("context")!(event);
    expect(f.calls.create).toHaveLength(3);
    expect(f.calls.create.every((call) => call.agent === "multimodal-looker" && call.model === undefined)).toBe(true);
    expect(f.agents.size).toBe(0);
    expect(JSON.stringify(event.messages)).toContain("attached image 2");
    expect(JSON.stringify(event.messages)).toContain("Original output");
    expect(JSON.stringify(event.messages)).toContain("application/pdf");
    expect(f.calls.prompt.map(([input]) => input.files[0].uri)).toEqual(["file:///fixture/a.png", "https://example.invalid/b.png", "file:///fixture/c.png"]);
    expect(f.calls.remove).toHaveLength(3);
  } finally { await f.cleanup(); }
});

test("V2 internal session recursion is skipped for all request kinds", async () => {
  const f = await fixture();
  try {
    f.onPrompt(async ({ sessionID }) => {
      for (const hook of f.hooks.values()) {
        const inner = request(undefined, sessionID);
        await hook(inner);
        expect(inner.messages[0].content[1].type).toBe("media");
        expect(inner.system).toEqual([]);
      }
    });
    await f.hooks.get("context")!(request());
    expect(f.calls.create).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test("V2 agent transform adds defaults without overwriting any user-owned item", async () => {
  const owned = { model: { providerID: "custom", id: "custom" }, system: "User prompt", permissions: [{ action: "read", effect: "allow", resource: "*" }] };
  const existing = await fixture(undefined, owned);
  try { expect(existing.agents.get("vision")).toBe(owned); expect(owned.system).toBe("User prompt"); }
  finally { await existing.cleanup(); }
  const f = await fixture();
  try {
    expect(f.agents.get("vision").model).toEqual({ providerID: "vision", id: "model" });
    expect(f.agents.get("vision").permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
  } finally { await f.cleanup(); }
});

test("V2 failures clean up, redact provider details, and do not poison success cache", async () => {
  const f = await fixture();
  try {
    f.onPrompt(async () => { throw new Error("SECRET_KEY image data prompt"); });
    const event = request();
    await f.hooks.get("context")!(event);
    expect(JSON.stringify(event.messages)).toContain("could not be transcribed");
    expect(JSON.stringify(event.messages)).not.toContain("SECRET_KEY");
    expect(f.calls.remove).toHaveLength(1);
    f.onPrompt(undefined);
    const retry = request();
    await f.hooks.get("context")!(retry);
    expect(JSON.stringify(retry.messages)).toContain("A blue button");
    expect(f.calls.create).toHaveLength(2);
  } finally { await f.cleanup(); }
});

for (const mode of ["idle", "deleted", "unload"] as const) {
  test(`V2 ${mode} cancellation propagates to client work and cleans every image session`, async () => {
    const f = await fixture();
    const event = request([image("file:///fixture/a.png"), image("file:///fixture/b.png")]);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    let count = 0;
    f.onPrompt(async (_, { signal }) => {
      if (++count === 2) ready();
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const work = f.hooks.get("context")!(event) as Promise<void>;
    const result = work.then(() => undefined, (error) => error);
    await started;
    if (mode === "idle") f.idle("parent");
    if (mode === "deleted") f.deleted("parent");
    if (mode === "unload") await f.cleanup();
    expect(await result).toBeInstanceOf(Error);
    expect(f.calls.remove).toHaveLength(2);
    expect(f.calls.remove.every(([, opts]) => opts === undefined)).toBe(true);
    expect(event.messages[0].content[1].type).toBe("media");
    await f.cleanup();
  });
}

test("V2 duplicate images in one request share work, but changed user context is re-described", async () => {
  const f = await fixture();
  try {
    await f.hooks.get("context")!(request([image(), image()]));
    expect(f.calls.create).toHaveLength(1);
    const event = request();
    event.messages[0] = { role: "user", content: [{ type: "text", text: "Read the small text" }, image()] };
    await f.hooks.get("context")!(event);
    expect(f.calls.create).toHaveLength(2);
  } finally { await f.cleanup(); }
});

test("V2 source session location controls model lookup, worker location and cache isolation", async () => {
  const f = await fixture();
  try {
    await f.hooks.get("context")!(request());
    f.move("/fixture/moved");
    await f.hooks.get("generate")!(request());
    expect(f.calls.models[1][0]).toEqual({ location: { directory: "/fixture/moved" } });
    expect(f.calls.create[1].location).toEqual({ directory: "/fixture/moved" });
    expect(f.calls.create).toHaveLength(2);
  } finally { await f.cleanup(); }
});

test("V2 media source boundaries: inline conversion, exact URI forwarding, no plugin downloads", async () => {
  const f = await fixture();
  const network = spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("Unexpected network");
  }) as unknown as typeof fetch);
  try {
    const event = request([
      { type: "media", filename: "inline.png", media: Media.bytes(Buffer.from("picture"), "image/png") },
      { type: "media", filename: "inline.png", media: Media.base64("cGljdHVyZQ==", "image/png") },
      image("file:///fixture/a%20b.webp?revision=2"),
      image("https://example.invalid/image?token=FIXTURE"),
      { type: "media", media: Media.ref("provider", "image-id", "image/png") },
      { type: "media", media: Media.url("https://example.invalid/private", { mediaType: "image/png", headers: { authorization: "SECRET" } }) },
      { type: "media", media: Media.bytes(new Uint8Array([1]), "application/pdf") },
    ]);
    const original = event.messages;
    await f.hooks.get("context")!(event);
    expect(f.calls.prompt.map(([input]) => input.files[0].uri)).toEqual([
      "data:image/png;base64,cGljdHVyZQ==", "file:///fixture/a%20b.webp?revision=2", "https://example.invalid/image?token=FIXTURE",
    ]);
    expect(f.calls.create).toHaveLength(3);
    expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(event.messages)).not.toContain("SECRET");
    expect(JSON.stringify(event.messages)).toContain("provider-only reference or credentialed image URL");
    expect(event.messages[0].content.at(-1)).toBe(original[0].content.at(-1));
    expect(original[0].content.filter((part) => part.type === "media")).toHaveLength(7);
  } finally { network.mockRestore(); await f.cleanup(); }
});

test("V2 tool images retain ordering, numbering, most recent user framing and non-image content", async () => {
  const f = await fixture();
  try {
    const event = request([]);
    event.messages.push({ role: "user", content: [{ type: "text", text: "Read errors" }] });
    event.messages.push({ role: "tool", content: [{ type: "tool-result", id: "call", name: "screens", result: { type: "content", value: [
      { type: "file", uri: "file:///fixture/one.png", mime: "image/png" },
      { type: "text", text: "Between" },
      { type: "file", uri: "file:///fixture/two.png", mime: "image/png" },
      { type: "file", uri: "file:///fixture/data.pdf", mime: "application/pdf" },
    ] } }] });
    await f.hooks.get("context")!(event);
    expect(f.calls.prompt.every(([input]) => input.text.includes("Read errors") && !input.text.includes("Compare the buttons"))).toBe(true);
    const output = JSON.stringify(event.messages[2]);
    expect(output).toContain("attached image 1");
    expect(output).toContain("[/Vision model description 2]");
    expect(output).toContain("Between");
    expect(output).toContain("data.pdf");
    expect(output).not.toContain("one.png");
  } finally { await f.cleanup(); }
});

test("V2 transformed registry defaults preserve unrelated agents and all user overrides", async () => {
  const f = await fixture();
  try {
    const vision = f.agents.get("vision");
    expect(vision.id).toBe("vision");
    expect(vision.hidden).toBe(true);
    expect(vision.system).toContain("You have no tools");
    expect(vision.request).toEqual({ settings: {}, headers: {}, body: {} });
    // The transform must be synchronous and safe to replay on a fresh registry.
    const owned = { hidden: false, mode: "primary", system: "User", model: { providerID: "custom", id: "model", variant: "high" } };
    const keep = await fixture(undefined, owned);
    try { expect(keep.agents.get("vision")).toEqual(owned); }
    finally { await keep.cleanup(); }
  } finally { await f.cleanup(); }
});

test("V2 pre-supplied auxiliary results and internal sessions do not call the model catalog", async () => {
  const f = await fixture();
  try {
    const event = { ...request(), result: "Title supplied by another plugin" };
    await f.hooks.get("title")!(event);
    expect(f.calls.get).toHaveLength(0);
    expect(f.calls.models).toHaveLength(0);
    expect(f.calls.create).toHaveLength(0);
    expect(event.system).toEqual([]);
  } finally { await f.cleanup(); }
});

test("V2 create failures do not prompt, remove unknown sessions, or cache an error", async () => {
  const f = await fixture({ agent: "missing-agent" });
  try {
    f.onCreate(async () => { throw new Error("Agent missing: PRIVATE_PROMPT"); });
    const event = request();
    await f.hooks.get("context")!(event);
    expect(JSON.stringify(event.messages)).toContain("could not be transcribed");
    expect(JSON.stringify(event.messages)).not.toContain("PRIVATE_PROMPT");
    expect(f.calls.prompt).toHaveLength(0);
    expect(f.calls.remove).toHaveLength(0);
    f.onCreate(undefined);
    await f.hooks.get("context")!(request());
    expect(f.calls.create).toHaveLength(2);
  } finally { await f.cleanup(); }
});

for (const mode of ["empty", "idle-error", "assistant-error", "filter"] as const) {
  test(`V2 ${mode} is a transcription failure, not a successful cached result`, async () => {
    const f = await fixture();
    try {
      f.response(mode === "empty" ? [] : mode === "idle-error"
        ? [{ type: "idle", outcome: "interrupted" } as SessionMessageInfo]
        : [{ type: "assistant", content: [{ type: "text", text: "Partial response" }],
          ...(mode === "filter" ? { finish: "content-filter" } : { error: { message: "SECRET_PROVIDER_ERROR" } }),
        } as SessionMessageInfo]);
      for (let i = 0; i < 2; i++) {
        const event = request();
        await f.hooks.get("context")!(event);
        expect(JSON.stringify(event.messages)).toContain("could not be transcribed");
        expect(JSON.stringify(event.messages)).not.toContain("SECRET_PROVIDER_ERROR");
      }
      expect(f.calls.create).toHaveLength(2);
      expect(f.calls.remove).toHaveLength(2);
    } finally { await f.cleanup(); }
  });
}

test("V2 unload waits for late creation and removes the obtained ID without admitting a prompt", async () => {
  const f = await fixture();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let release!: () => void;
  f.onCreate(async () => { ready(); await new Promise<void>((resolve) => { release = resolve; }); });
  const work = Promise.resolve(f.hooks.get("context")!(request())).catch((error) => error);
  await started;
  let closed = false;
  const closing = f.cleanup().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await closing;
  expect(await work).toBeInstanceOf(Error);
  expect(f.calls.prompt).toHaveLength(0);
  expect(f.calls.remove).toEqual([[{ sessionID: "internal-1" }, undefined]]);
});

test("V2 cancellation while waiting removes only the cancelled session's workers", async () => {
  const f = await fixture();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  f.onWait(async ({ sessionID }, { signal }) => {
    if (sessionID !== "internal-1") return;
    ready();
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  try {
    const stopped = Promise.resolve(f.hooks.get("context")!(request())).catch((error) => error);
    await started;
    const other = request([image("file:///fixture/other.png")], "other-parent");
    const running = f.hooks.get("context")!(other);
    f.idle("parent");
    expect(await stopped).toBeInstanceOf(Error);
    await running;
    expect(JSON.stringify(other.messages)).toContain("A blue button");
    expect(f.calls.remove).toHaveLength(2);
  } finally { await f.cleanup(); }
});

test("V2 failed cleanup fails closed, redacts transport errors and retains ownership for unload", async () => {
  const f = await fixture();
  f.onRemove(async () => { throw new Error("SECRET_KEY image prompt"); });
  const event = request();
  await expect(f.hooks.get("context")!(event)).rejects.toThrow("Eyesight request transformation failed");
  expect(event.messages[0].content[1].type).toBe("media");
  f.onRemove(undefined);
  await f.hooks.get("context")!(request());
  expect(f.calls.create).toHaveLength(2); // no success cached before cleanup
  await f.cleanup();
  expect(f.calls.remove.map(([input]) => input.sessionID)).toEqual(["internal-1", "internal-2", "internal-1"]);
});

test("V2 actual 2.0.30 Promise client serializes the registered hook's worker lifecycle", async () => {
  const requests: Array<{ path: string; method: string; body?: any }> = [];
  const client = OpenCode.make({
    baseUrl: "https://fixture.invalid",
    fetch: (async (input, init) => {
      const req = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const path = new URL(req.url).pathname;
      requests.push({ path, method: req.method, ...(req.body ? { body: await req.json() } : {}) });
      // HTTP envelopes are unwrapped by the real V2 client, not by the plugin.
      if (path === "/api/session/parent") return Response.json({ data: { id: "parent", location: { directory: "/wire/project" } } });
      if (path === "/api/session" && req.method === "POST") return Response.json({ data: { id: "wire-worker" } });
      if (path.endsWith("/prompt")) return Response.json({ data: { id: "admission", type: "user" } });
      if (path.endsWith("/context")) return Response.json({ data: [{ type: "assistant", content: [{ type: "text", text: "Wire description" }] }] });
      if (path.endsWith("/wait") || req.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected fixture route: ${req.method} ${path}`);
    }) as typeof fetch,
  });
  const f = await fixture({ agent: "multimodal-looker" }, undefined, client.session);
  try {
    const event = request();
    await f.hooks.get("context")!(event);
    expect(JSON.stringify(event.messages)).toContain("Wire description");
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /api/session/parent", "POST /api/session", "POST /api/session/wire-worker/prompt",
      "POST /api/experimental/session/wire-worker/wait", "GET /api/session/wire-worker/context", "DELETE /api/session/wire-worker",
    ]);
    expect(requests[1].body).toEqual({ title: "vision-fallback", agent: "multimodal-looker", location: { directory: "/wire/project" }, permissions: [{ action: "*", resource: "*", effect: "deny" }] });
    expect(requests[2].body).toEqual({ text: expect.stringContaining("context only"), files: [{ uri: "data:image/png;base64,cGljdHVyZQ==", name: "screen.png" }] });
  } finally { await f.cleanup(); }
});
