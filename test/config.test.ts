import { test, expect } from "bun:test";
import type { Config } from "@opencode-ai/plugin";
import type { AgentConfig } from "@opencode-ai/sdk";
import {
  type BuiltInVisionConfig,
  type VisionFallbackConfig,
  parseModel,
  registerVisionAgent,
  resolveConfig,
  DEFAULT_PROMPT,
  VISION_AGENT_NAME,
} from "../src/config";

function requireBuiltIn(
  config: VisionFallbackConfig | undefined,
): BuiltInVisionConfig {
  expect(config?.mode).toBe("built-in");
  if (config?.mode !== "built-in") throw new Error("expected built-in config");
  return config;
}

test("parseModel splits on first slash", () => {
  expect(parseModel("openai/gpt-4o")).toEqual({
    providerID: "openai",
    modelID: "gpt-4o",
  });
});

test("parseModel preserves extra slashes in modelID", () => {
  expect(parseModel("openrouter/anthropic/claude-3")).toEqual({
    providerID: "openrouter",
    modelID: "anthropic/claude-3",
  });
});

test("parseModel returns undefined when no slash", () => {
  expect(parseModel("nodash")).toBeUndefined();
});

test("parseModel returns undefined when left side is empty", () => {
  expect(parseModel("/x")).toBeUndefined();
});

test("parseModel returns undefined when right side is empty", () => {
  expect(parseModel("x/")).toBeUndefined();
});

test("resolveConfig uses options.model", async () => {
  const config = requireBuiltIn(
    await resolveConfig({ model: "openai/gpt-4o" }, {}),
  );
  expect(config.agentName).toBe(VISION_AGENT_NAME);
  expect(config.providerID).toBe("openai");
  expect(config.modelID).toBe("gpt-4o");
  expect(config.prompt).toBe(DEFAULT_PROMPT);
  expect(config.mimePrefixes).toEqual(["image/"]);
});

test("resolveConfig treats explicit vision agent as built-in mode", async () => {
  const config = await resolveConfig(
    { agent: VISION_AGENT_NAME, model: "openai/gpt-4o" },
    {},
  );

  expect(config).toMatchObject({
    mode: "built-in",
    agentName: VISION_AGENT_NAME,
    providerID: "openai",
    modelID: "gpt-4o",
  });
});

test("resolveConfig selects a non-empty external agent without a model", async () => {
  let promptFileRead = false;

  const config = await resolveConfig(
    { agent: "multimodal-looker", promptFile: "unused.md" },
    {},
    async () => {
      promptFileRead = true;
      return "unused";
    },
  );

  expect(config).toEqual({
    mode: "external",
    agentName: "multimodal-looker",
    mimePrefixes: ["image/"],
  });
  expect(promptFileRead).toBe(false);
});

test("resolveConfig trims surrounding whitespace from an external agent", async () => {
  const config = await resolveConfig({ agent: "  multimodal-looker  " }, {});

  expect(config).toEqual({
    mode: "external",
    agentName: "multimodal-looker",
    mimePrefixes: ["image/"],
  });
});

test("resolveConfig rejects invalid explicit agent values", async () => {
  expect(
    await resolveConfig({ agent: "", model: "openai/gpt-4o" }, {}),
  ).toBeUndefined();
  expect(
    await resolveConfig({ agent: 123, model: "openai/gpt-4o" }, {}),
  ).toBeUndefined();
  expect(
    await resolveConfig({ agent: undefined, model: "openai/gpt-4o" }, {}),
  ).toBeUndefined();
  expect(
    await resolveConfig({ agent: "   ", model: "openai/gpt-4o" }, {}),
  ).toBeUndefined();
});

test("resolveConfig uses custom prompt from options", async () => {
  const config = requireBuiltIn(
    await resolveConfig({ model: "openai/gpt-4o", prompt: "custom" }, {}),
  );
  expect(config.prompt).toBe("custom");
});

test("resolveConfig falls back to env var for model", async () => {
  const config = requireBuiltIn(
    await resolveConfig(undefined, {
      OPENCODE_VISION_FALLBACK_MODEL: "x/y",
    }),
  );
  expect(config.providerID).toBe("x");
  expect(config.modelID).toBe("y");
});

test("resolveConfig uses promptFile when provided", async () => {
  const config = requireBuiltIn(
    await resolveConfig(
      { model: "openai/gpt-4o", promptFile: "prompt.md" },
      {},
      async (path) => {
        expect(path).toBe("prompt.md");
        return "\nmarkdown prompt\n";
      },
    ),
  );

  expect(config.prompt).toBe("markdown prompt");
});

test("resolveConfig prefers prompt over promptFile", async () => {
  const config = requireBuiltIn(
    await resolveConfig(
      { model: "openai/gpt-4o", prompt: "inline", promptFile: "prompt.md" },
      {},
      async () => "file",
    ),
  );

  expect(config.prompt).toBe("inline");
});

test("resolveConfig returns undefined when no model resolved", async () => {
  expect(await resolveConfig(undefined, {})).toBeUndefined();
});

test("registerVisionAgent supplies the default vision agent", async () => {
  const resolved = requireBuiltIn(
    await resolveConfig({ model: "openai/gpt-4o" }, {}),
  );
  const config = {} as Config;

  registerVisionAgent(config, resolved);

  expect(config.agent?.[VISION_AGENT_NAME]).toEqual({
    description: "Analyzes attached images for models that cannot process image input. Use only when the active model lacks vision capabilities.",
    mode: "subagent",
    model: "openai/gpt-4o",
    prompt: DEFAULT_PROMPT,
    permission: { "*": "deny" } as AgentConfig["permission"],
  });
});

test("registerVisionAgent preserves user vision-agent overrides", async () => {
  const resolved = requireBuiltIn(
    await resolveConfig({ model: "openai/gpt-4o" }, {}),
  );
  const config = {
    agent: {
      vision: {
        model: "custom/vision-model",
        prompt: "custom prompt",
        tools: { read: true },
        permission: { edit: "allow" },
      },
      reviewer: { prompt: "review" },
    },
  } as Config;

  registerVisionAgent(config, resolved);

  expect(config.agent?.vision?.model).toBe("custom/vision-model");
  expect(config.agent?.vision?.prompt).toBe("custom prompt");
  expect(config.agent?.vision?.tools).toEqual({ read: true });
  expect(config.agent?.vision?.permission).toEqual({
    "*": "deny",
    edit: "allow",
  } as AgentConfig["permission"]);
  expect(Object.keys(config.agent!.vision!.permission!)).toEqual(["*", "edit"]);
  expect(config.agent?.reviewer?.prompt).toBe("review");
});

test("resolveConfig returns undefined for non-string model option", async () => {
  const config = await resolveConfig({ model: 123 as unknown }, {});
  expect(config).toBeUndefined();
});
