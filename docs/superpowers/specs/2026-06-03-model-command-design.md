# `/model` Command Design

## Goal

Add a `/model` command that lets Feishu users see the models currently supported by the installed Codex CLI, switch the active Codex session model, and save the selected model as the default for future sessions in the same bot context.

The command should use Codex's own model cache as the source of truth. It should not introduce a hand-maintained model allowlist in code_bot.

## Non-Goals

- Do not edit `~/.codex/config.toml`.
- Do not maintain a static list of supported models in code_bot.
- Do not scrape arbitrary TUI screen output to discover the model list.
- Do not try to provide account-specific entitlement explanations beyond what Codex reports in its model cache.
- Do not replace `/status`; `/status` remains the way to verify the currently observed runtime model.

## Current Context

code_bot already starts Codex sessions with project-specific `codexArgs` and shared `codex.defaultArgs`. Existing project configs can pass `--model`, but users cannot change the model from Feishu after a chat has started.

Codex CLI `0.136.0` does not expose a public `codex models` or `codex model --json` command. It does maintain a structured local cache at:

```text
~/.codex/models_cache.json
```

The cache contains `fetched_at`, `client_version`, and a `models` array. Visible user-selectable models have `visibility: "list"`. On the current machine, that cache lists:

- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.3-codex-spark`

Each model entry also carries display name, description, priority, default reasoning level, and supported reasoning levels.

## User-Facing Behavior

### `/model`

Shows:

- currently supported Codex models from `models_cache.json`
- the currently observed model for the active Codex session, when available
- the saved default model for the current chat/project, when available
- cache metadata: fetched time and Codex client version

Models should be sorted by ascending `priority`, then by `slug`.

Example:

```text
Current model: gpt-5.5
Saved default: gpt-5.4 high
Codex models (client 0.136.0, fetched 2026-06-03T13:26:06Z)

- gpt-5.5: GPT-5.5 - Frontier model for complex coding, research, and real-world work. Reasoning: low, medium, high, xhigh
- gpt-5.4: GPT-5.4 - Strong model for everyday coding. Reasoning: low, medium, high, xhigh
- gpt-5.4-mini: GPT-5.4-Mini - Small, fast, and cost-efficient model for simpler coding tasks. Reasoning: low, medium, high, xhigh
- gpt-5.3-codex-spark: GPT-5.3-Codex-Spark - Ultra-fast coding model. Reasoning: low, medium, high, xhigh
```

### `/model <slug>`

Validates `<slug>` against the visible models from Codex's cache.

If valid:

- saves the selected model as the default for the current chat/project
- if a Codex session is running, sends the native command `/model <slug>` into that session
- replies with separate lines for saved default and runtime switch status

If there is no running session, it only saves the default and explains that the next `/new` or `/resume` will use it.

### `/model <slug> <reasoning>`

Validates both model slug and reasoning level. The reasoning value must be one of the model's `supported_reasoning_levels[].effort`.

If valid:

- saves model plus reasoning effort as the default for the current chat/project
- if a Codex session is running, sends `/model <slug> <reasoning>` into that session
- uses the saved reasoning effort when starting future sessions only if Codex exposes a stable startup argument for it

The first implementation should support reasoning because Codex's cache already exposes per-model supported reasoning levels, and users naturally expect `/model gpt-5.5 high` to work.

## Data Model

Add a small model selection record to bot-owned state. The preferred scope is current chat plus current project, because the same Feishu chat can move between configured projects.

```ts
export interface SavedModelSelection {
  model: string;
  reasoningEffort?: string;
  updatedAt: string;
}
```

The store can attach this to the chat record as a project-keyed map:

```ts
modelSelectionsByProject?: Record<string, SavedModelSelection>;
```

If no project is selected, `/model <slug>` should return a clear error asking the user to run `/use <project>` or `/new <project>` first. This avoids ambiguous global behavior.

## Model Cache Reader

Introduce a small reader module, for example `src/models/CodexModelCatalog.ts`.

Responsibilities:

- read `${CODEX_HOME ?? HOME/.codex}/models_cache.json`
- parse JSON defensively
- return only entries with `visibility === "list"`
- normalize fields used by the command:
  - `slug`
  - `displayName`
  - `description`
  - `priority`
  - `defaultReasoningLevel`
  - `supportedReasoningLevels`
- expose cache metadata:
  - `fetchedAt`
  - `clientVersion`

Failures should be explicit:

- missing file: "Codex model cache not found. Open Codex once or run a Codex command that refreshes models, then try `/model` again."
- invalid JSON: "Codex model cache is unreadable."
- no visible models: "Codex model cache contains no selectable models."

## Session Integration

### Starting or Resuming Sessions

When `SessionManager` starts or resumes Codex, it should merge the saved model selection into the effective Codex args for that session.

Rules:

- saved selection should override `--model` already present in project `codexArgs`
- saved selection should not mutate config objects
- the merge should remove existing `--model <value>` / `-m <value>` pairs before appending the saved model
- if reasoning support maps to an existing Codex CLI argument, use that argument for future session startup
- if there is no stable CLI argument for reasoning, store it for `/model` runtime switching only and do not invent one

The implementation plan must verify the current Codex CLI argument for reasoning before adding startup args. If no supported startup flag exists, future sessions start with model only, and users can still set reasoning through runtime `/model <slug> <reasoning>` once the session is active.

### Running Sessions

For a running session, `SessionManager` should send the native Codex TUI command to the current PTY:

```text
/model <slug>
/model <slug> <reasoning>
```

The reply should distinguish dispatch from confirmation:

```text
Saved default model: gpt-5.5 high
Sent runtime switch to current Codex session. Use /status to confirm the observed model.
```

code_bot should not claim the runtime model changed until observation or `/status` shows the new model.

## Command Routing

Add `model` to `CommandName` and `SessionManager.handleTextQueued`.

The parser can keep normal whitespace argument splitting:

- `/model`
- `/model gpt-5.5`
- `/model gpt-5.5 high`

Unknown extra arguments should return usage text.

## Error Handling

- Unknown model: show a concise error and list available slugs.
- Unsupported reasoning: show supported reasoning levels for that model.
- No project selected: ask the user to select or start a project first.
- No current session: save default only.
- Runner send failure: keep the saved default and report that runtime switch failed.
- Cache missing or unreadable: do not allow switching, because the command cannot validate the model against Codex's current cache.

## Formatting

Use a dedicated formatter if the `/model` response grows beyond a short plain-text reply. It can return the same `{ bodyMarkdown, fallbackText }` shape used by `/status` so Feishu cards stay readable.

The initial implementation can use plain text if it stays concise, but tests should assert both successful and degraded replies.

## Tests

Add focused test coverage for:

- model cache reader parses visible models and ignores hidden models
- model cache reader returns clear failures for missing, invalid, or empty cache
- `/model` with no args lists models sorted by priority
- `/model unknown` rejects the model and shows available slugs
- `/model gpt-5.5 high` saves the selection
- `/model gpt-5.5 high` sends native `/model gpt-5.5 high` to a running session
- `/model gpt-5.5` without a running session saves default only
- `/new` and `/resume` use saved model selection when building Codex args
- saved selection overrides model flags already present in project `codexArgs`

## Open Verification Item

Before implementation, verify whether Codex CLI supports a stable startup argument for reasoning effort. The design supports reasoning at runtime because native `/model <slug> <reasoning>` is the target interaction, but future-session startup reasoning should only be implemented if the CLI has a supported flag.
