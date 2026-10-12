import { expect, test } from "bun:test";
import type { Config } from "@opencode-ai/plugin";
import type { FilePart, Part, UserMessage } from "@opencode-ai/sdk";
import { $ } from "bun";
import { VisionFallback } from "../src/index";

type PluginInput = Parameters<typeof VisionFallback>[0];
type PromptBody = {
  readonly agent?: string;
  readonly model?: unknown;
  readonly parts?: readonly unknown[];
};
type PromptRequest = { readonly body: PromptBody };

const providerFixture = {
  all: [
    {
      id: "zai",
      models: {
        "glm-4.6": { modalities: { input: ["text"], output: ["text"] } },
      },
    },
  ],
  default: {},
  connected: [],
};

function buildInput(client: object): PluginInput {
  return {
    client: client as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: "/tmp",
    worktree: "/tmp",
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost:4096"),
    $,
  };
}

function makeFilePart(overrides: Partial<FilePart> = {}): FilePart {
  return {
    id: "external-image",
    sessionID: "ses_user",
    messageID: "msg-1",
    type: "file",
    mime: "image/png",
    filename: "screenshot.png",
    url: "file:///tmp/screenshot.png",
    ...overrides,
  };
}

function makeUserMessage(parts: Part[]): { info: UserMessage; parts: Part[] } {
  return {
    info: {
      id: "user-1",
      sessionID: "ses_user",
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: { providerID: "zai", modelID: "glm-4.6" },
    },
    parts,
  };
}

function makePromptCaptureClient(
  onPrompt: (request: PromptRequest) => void,
  sessionID: string,
): object {
  return {
    provider: { list: async () => ({ data: providerFixture }) },
    session: {
      create: async () => ({ data: { id: sessionID } }),
      prompt: async (request: PromptRequest) => {
        onPrompt(request);
        return {
          data: {
            info: {},
            parts: [{ type: "text", text: "described" }],
          },
        };
      },
      delete: async () => ({ data: true }),
    },
    app: { log: async () => {} },
  };
}

test("external agent dispatch preserves the exact file payload without model override", async () => {
  let capturedBody: PromptBody | undefined;
  const client = makePromptCaptureClient((request) => {
    capturedBody = request.body;
  }, "ses_external");
  const hooks = await VisionFallback(buildInput(client), {
    agent: "multimodal-looker",
    model: "zai/glm-4.6",
  });
  const image = makeFilePart({
    mime: "image/webp",
    filename: "diagram.webp",
    url: "file:///tmp/diagram.webp?revision=2",
  });
  const output = { messages: [makeUserMessage([image])] };
  const transform = hooks["experimental.chat.messages.transform"];
  if (!transform) throw new Error("expected messages transform hook");

  await transform({}, output);

  if (!capturedBody) throw new Error("expected captured prompt body");
  expect(capturedBody.agent).toBe("multimodal-looker");
  expect(capturedBody.model).toBeUndefined();
  const capturedParts = capturedBody.parts;
  if (!capturedParts) throw new Error("expected captured prompt parts");
  expect(capturedParts[1]).toEqual({
    type: "file",
    mime: "image/webp",
    filename: "diagram.webp",
    url: "file:///tmp/diagram.webp?revision=2",
  });
});

test("external config hook preserves registered agents and does not create vision", async () => {
  const client = makePromptCaptureClient(() => {}, "ses_external_config");
  const hooks = await VisionFallback(buildInput(client), {
    agent: "multimodal-looker",
  });
  const externalAgent = { model: "openai/gpt-4o", prompt: "existing prompt" };
  const config: Config = {
    agent: {
      "multimodal-looker": externalAgent,
      reviewer: { prompt: "review" },
    },
  };
  const configHook = hooks.config;
  if (!configHook) throw new Error("expected config hook");

  await configHook(config);

  expect(config.agent).toEqual({
    "multimodal-looker": externalAgent,
    reviewer: { prompt: "review" },
  });
  const agents = config.agent;
  if (!agents) throw new Error("expected configured agents");
  expect(agents.vision).toBeUndefined();
});

test("external prompt error is surfaced without falling back to vision", async () => {
  const promptedAgents: string[] = [];
  const client = {
    provider: { list: async () => ({ data: providerFixture }) },
    session: {
      create: async () => ({ data: { id: "ses_external_error" } }),
      prompt: async (request: PromptRequest) => {
        if (!request.body.agent) throw new Error("expected prompt agent");
        promptedAgents.push(request.body.agent);
        return {
          error: { data: { message: "Agent not found: multimodal-looker" } },
        };
      },
      delete: async () => ({ data: true }),
    },
    app: { log: async () => {} },
  };
  const hooks = await VisionFallback(buildInput(client), {
    agent: "multimodal-looker",
  });
  const message = makeUserMessage([
    makeFilePart({ filename: "missing-agent.png" }),
  ]);
  const transform = hooks["experimental.chat.messages.transform"];
  if (!transform) throw new Error("expected messages transform hook");

  await transform({}, { messages: [message] });

  expect(promptedAgents).toEqual(["multimodal-looker"]);
  const replacement = message.parts[0];
  if (replacement?.type !== "text")
    throw new Error("expected text replacement");
  expect(replacement.text).toContain(
    "could not be transcribed: Agent not found: multimodal-looker",
  );
});
