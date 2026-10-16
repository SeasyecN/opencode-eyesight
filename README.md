# @seasyecn/opencode-eyesight

OpenCode plugin that lets text-only models work with user-provided and tool-returned images by sending each image through an image-description agent, then replacing the image with a text description.

> **Provenance Note:** Forked from [chriswritescode-dev/opencode-eyesight](https://github.com/chriswritescode-dev/opencode-eyesight) with added external-agent support.

**Requires OpenCode 2.x** (built and tested against OpenCode 2.0.30 with `@opencode/plugin@2.0.30`). The plugin registers through the OpenCode V2 plugin API: a `Plugin.define({ id, setup })` entrypoint, `ctx.session.hook("context")` request hooks for every request kind (`context`, `compaction`, `generate`, `title`), and `ctx.agent.transform` for the built-in agent. It never rewrites prompts at the durable prompt-admission layer, so session history keeps the original images. The legacy OpenCode 1 plugin API (`@opencode-ai/plugin`) is not supported.

By default, Eyesight uses its built-in `vision` agent. Set `agent` to the name of an external agent available in the final merged OpenCode agent configuration of the same OpenCode process when Eyesight dispatches an image.

## Installation

Add the package to the `plugins` list in `opencode.json(c)`. Options use the V2 object form:

```jsonc
{
  "plugins": [
    {
      "package": "@seasyecn/opencode-eyesight",
      "options": { "model": "Provider/Model", "promptFile": "/path/to/prompt.md" }
    }
  ]
}
```

A plain string entry (no options) is also valid:

```jsonc
{
  "plugins": ["@seasyecn/opencode-eyesight"]
}
```

### Built-in `vision` mode

Built-in mode is the default when `agent` is omitted or set to `vision`. Set the vision model that the built-in `vision` agent should use for image descriptions:

```jsonc
{
  "plugins": [
    {
      "package": "@seasyecn/opencode-eyesight",
      "options": { "model": "lmstudio/Qwen3.6-27B", "promptFile": "./image-prompt.md" }
    }
  ]
}
```

For local development before publishing, replace the `package` value with the local project path:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/opencode-eyesight",
      "options": { "model": "lmstudio/Qwen3.6-27B", "promptFile": "./image-prompt.md" }
    }
  ]
}
```

A `model` value must use OpenCode's provider/model format:

```text
ProviderID/ModelID
```

Use a model that supports image input. Your active chat model can be text-only; `opencode-eyesight` registers a read-only `vision` subagent using the configured model and uses it only to describe images.

To customize the built-in agent, define `vision` in `~/.config/opencode/agents/vision.md` or `.opencode/agents/vision.md`. Your agent fields override the plugin defaults, including its model, prompt, tools, and permissions.

### External-agent mode

Set `agent` to a non-empty name other than `vision` to send image descriptions through an external agent. That agent does not need to be registered before Eyesight initializes, but it must exist in the final merged OpenCode agent configuration of the same OpenCode process by the time Eyesight dispatches an image. Eyesight does not bundle external agents or configure their model, prompt, or variant.

For example, use OMO's `multimodal-looker` agent by loading OMO and selecting the registered agent for Eyesight:

```jsonc
{
  "plugins": [
    "oh-my-openagent@latest",
    {
      "package": "@seasyecn/opencode-eyesight",
      "options": { "agent": "multimodal-looker" }
    }
  ]
}
```

Configure an external agent's model, prompt, and variant in its OMO or OpenCode agent configuration, not in Eyesight's plugin options. If the named external agent is missing or fails, Eyesight inserts the existing image-transcription error into the request. It does not fall back to the built-in `vision` agent.

## Usage

1. Select a text-only model in OpenCode.
2. Paste or attach an image.
3. Send your message.

If the active model does not support image input, the plugin sends the image to the configured image-description agent and substitutes the generated description for the image in the request sent to the active model. The substitution happens per request, so the original image is preserved in your session history and is sent as-is if you later switch to a vision-capable model.

If the active model already supports image input, the plugin leaves the image untouched.

Images returned by MCP or tool calls (e.g. screenshots) are handled the same way: when the active model is text-only, the description is appended to the tool's output text and the image attachment is removed from the request, while non-image attachments are preserved. Both pasted images and tool images share a process-lifetime cache, so repeated identical images with the same user context are described only once.

When you send a pasted image with an accompanying message, that message is included in the request to the image-description agent so the description is tailored to it. For images returned by MCP or tool calls, the most recent user message is used as context for the description, providing relevant framing.

A text-only active model is also told in its system prompt that images are transcribed for it, so it can ask for screenshots and use image-returning tools instead of avoiding them. Image-capable models receive no such notice.

## Options

| Option | Required | Description |
| --- | --- | --- |
| `agent` | No | Image-description agent name. Defaults to `vision`, which uses built-in mode. Any other non-empty name selects a registered external agent. |
| `model` | Yes, built-in `vision` mode only | Vision-capable OpenCode model for the built-in `vision` agent, in `ProviderID/ModelID` format. Not used in external-agent mode. |
| `promptFile` | No, built-in `vision` mode only | Markdown file containing the built-in agent's prompt. Relative paths resolve from the OpenCode project directory. Not used in external-agent mode. |
| `prompt` | No, built-in `vision` mode only | Inline prompt for the built-in agent. Takes precedence over `promptFile`. Not used in external-agent mode. |

In built-in `vision` mode, the model can also be supplied through `OPENCODE_VISION_FALLBACK_MODEL`. A user-defined `vision` agent takes precedence over the corresponding built-in defaults.

## Development

```bash
bun install --frozen-lockfile
bun run build
bun test
bun run typecheck
bun pm pack --dry-run
```

CI publishes on GitHub releases with Bun (`bun install --frozen-lockfile`, typecheck, test, build) and relies on `bun.lock` as the only lockfile; `prepack` rebuilds `dist/` before packing.
