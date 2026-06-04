# Feishu Card Selectors Design

## Goal

Add interactive Feishu card selectors for commands where users should choose from bot-known options instead of typing exact identifiers.

The first supported selectors are:

- `/model`: choose Codex model and reasoning from dropdowns, then confirm.
- `/projects`: choose a configured project from a dropdown, then confirm.

The text commands remain available as fallback and direct-entry paths:

- `/model <model> [reasoning]`
- `/use <project>`

## Non-Goals

- Do not add a new `/project` command.
- Do not remove the existing text command behavior.
- Do not claim a runtime model switched until `/status` or observation confirms it.
- Do not make `/projects` stop or replace a running session.
- Do not implement unrelated card actions beyond model and project selection.

## Current Context

The bot can already send Feishu interactive cards through `RenderedFeishuMessage`, and `FeishuGateway.sendRenderedMessage` falls back to text when card sending fails.

Current inbound handling only processes text message events. It does not handle Feishu card action events. To support dropdowns and confirm buttons, the gateway needs a new card action input path that is separate from text message parsing.

The current `/model <model> [reasoning]` behavior already validates Codex's local model catalog, saves a per-chat/per-project default, and sends native `/model ...` to a running Codex session when one exists. The card action path should reuse that behavior instead of duplicating it.

## User-Facing Behavior

### `/model`

With no arguments, `/model` should prefer returning a Feishu card instead of a plain text model list.

The card shows:

- current project, when selected
- current observed model and reasoning, when status data is available
- saved default model and reasoning for the current chat/project, when available
- Codex client version and model cache fetched time, when available
- model dropdown populated from visible models in Codex's local `models_cache.json`
- reasoning dropdown populated from the selected model's supported reasoning levels
- a confirm button

On confirm:

- save the selected model and reasoning as the current chat/project default
- if there is a running Codex session, send native `/model <model> <reasoning>`
- if there is no running session, only save the default for future `/new` and `/resume`

This matches the existing text command semantics.

If card sending fails, the bot should fall back to the existing text model list.

### `/projects`

`/projects` should prefer returning a Feishu card instead of only a text project list.

The card shows:

- current selected project, when available
- current running session project, when available
- project dropdown populated from configured projects
- a confirm button

On confirm:

- apply the same behavior as `/use <project>`
- update the chat's current project
- preserve any running session behavior already defined by `/use`

If a session is running and the user selects another project, the card action must not stop or replace the running session. It should follow the existing `/use` behavior and explain the session remains current/stoppable when relevant.

If card sending fails, the bot should fall back to the existing text project list.

## Card Action Data

Card actions should carry explicit structured payloads. The action kind determines which handler runs.

Model selector confirm action:

```json
{
  "kind": "model_select",
  "model": "<model-slug>",
  "reasoning": "<reasoning-level>"
}
```

Project selector confirm action:

```json
{
  "kind": "project_select",
  "projectId": "<project-id>"
}
```

Malformed, missing, or unknown action payloads should be ignored or answered with a short unsupported-action message, depending on what Feishu card action response APIs allow in long-connection mode.

## Architecture

### Gateway Input Path

Extend `FeishuGateway` with a card action handler path. The gateway should parse Feishu card action events into a bot-owned action type that includes:

- `chatId`
- `chatType`, when available
- `userId`
- `messageId`, when available
- `action`

The action payload should stay structured. Do not turn card clicks into synthetic text commands at the gateway layer.

### Session Manager Dispatch

Add a `SessionManager.handleCardAction(...)` entry point.

It should:

- run the same authorization checks as text messages
- serialize work through the same per-chat queue used by text handling
- dispatch by `action.kind`
- call shared model/project selection methods

The shared model method should be used by both:

- `/model <model> [reasoning]`
- `model_select` card action

The shared project method should be used by both:

- `/use <project>`
- `project_select` card action

This keeps card actions and text commands behaviorally aligned.

### Card Rendering

Introduce focused card builders instead of growing the generic markdown renderer:

- `ModelSelectorCard`
- `ProjectSelectorCard`

Each builder should return a `RenderedFeishuMessage` pair with:

- preferred interactive card payload
- text fallback matching the existing command output

The existing generic `renderFeishuMessage` can remain dedicated to markdown/status/completion cards.

## Error Handling

### Card Rendering

- Missing, invalid, or empty model catalog: return the existing text error instead of an empty card.
- Missing project for `/model`: card may still show model options, but confirm should return a clear error asking the user to run `/use <project>` or `/new <project>` first.
- Status/current model unavailable: render the card without current observed model.
- Project list empty: return a text empty-state message.

### Card Confirm

- Unauthorized user or chat: reject using existing authorization behavior.
- Unknown model: return an error and list available model slugs.
- Unsupported reasoning: return an error and list supported reasoning levels for that model.
- Unknown project: return an error and list valid project IDs.
- No running session for model selection: save default only and say the next `/new` or `/resume` will use it.
- Runtime model switch send failure: keep the saved default and report that runtime switch failed.

## Testing

Add focused tests for:

- `/model` with no args returns a card when model catalog is available.
- `/model` card fallback text still matches the existing model list.
- `model_select` action validates and saves model plus reasoning.
- `model_select` action sends native `/model <model> <reasoning>` to a running session.
- `model_select` action saves only when no session is running.
- `model_select` action rejects unsupported reasoning.
- `/projects` returns a project selector card.
- `project_select` action follows `/use <project>` behavior.
- `project_select` action does not stop or replace a running session.
- Feishu gateway routes card action events to the new action handler.
- Malformed or unsupported card actions are handled without throwing.

## Rollout

Implement in two phases:

1. Add the common Feishu card action pipeline and `/model` selector card.
2. Add the `/projects` selector card using the same action pipeline.

Both phases should keep text command fallbacks working so the bot remains usable if Feishu card rendering or card action handling is unavailable.
