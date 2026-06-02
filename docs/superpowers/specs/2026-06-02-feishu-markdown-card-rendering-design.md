# Feishu Markdown Card Rendering Design

## Goal

Upgrade outgoing Feishu messages from plain text to structured card-based Markdown rendering, while preserving a reliable plain-text fallback path and keeping room for future message types such as approvals, system status, and debug output.

## Current State

- `src/feishu/FeishuGateway.ts` always sends `msg_type: "text"` with `content: { text: string }`.
- Business code currently returns plain `reply: string` values.
- Markdown-like content therefore renders as literal plain text inside Feishu.
- Recent work already introduced `ui.verbosity: normal | debug`, which changes how much information the bot chooses to reveal. Rendering must respect that mode.

## Scope

### In scope for phase 1

- Normal replies produced by `SessionManager.handleText()`
- Completion notifications
- Error notifications
- Feishu card rendering plus plain-text fallback
- A minimal structured message model that future message types can reuse

### Out of scope for phase 1

- `/tail` and `/rawtail`
- Approval interactions and button callbacks
- Full replacement of every outgoing text message in the codebase
- Rich interactive controls beyond read-only content cards

## Design Principles

1. Business code should not construct Feishu card JSON directly.
2. Outgoing messages should first become a structured internal message model.
3. Feishu card delivery is preferred, but plain-text delivery must remain available as a fallback.
4. `normal` and `debug` modes should differ in presentation structure, not only in string length.
5. Markdown support must target a documented safe subset instead of assuming full GitHub Markdown compatibility.

## Message Model

Introduce a minimal internal outbound message model, referred to here as `BotMessage`.

Suggested shape:

- `kind: "reply" | "completion" | "error"`
- `bodyMarkdown: string`
- `fallbackText: string`
- `debug?: { sessionId?: string; projectId?: string; source?: string; reason?: string; chunkInfo?: string }`

This model is intentionally small for phase 1. It is enough to decouple business logic from Feishu transport details and leaves room to add future kinds such as `approval`, `status`, or `tail`.

## Rendering Pipeline

1. Business layer produces a `BotMessage`.
2. A dedicated Feishu renderer converts it into:
   - a preferred `interactive` card payload using JSON 2.0 Markdown/rich text components
   - a plain-text fallback payload
3. Gateway sends the card first.
4. If card sending fails, gateway records the failure and retries with plain text.
5. If plain text is too large, existing chunking logic continues to apply.

## Feishu Card Strategy

Use Feishu `interactive` messages backed by card JSON 2.0.

For phase 1, the rendered card can stay simple:

- a single body region containing Markdown content
- optional extra debug section when `ui.verbosity = "debug"`

Normal mode should render only the main answer body. Debug mode should append a distinct metadata section instead of polluting the main body text.

## Supported Markdown Subset

Phase 1 guarantees support only for the subset that is both common in current bot replies and realistic to normalize safely:

- paragraphs
- bold / italic
- inline code
- fenced code blocks
- ordered and unordered lists
- block quotes
- links

Phase 1 does not promise faithful rendering for:

- tables
- nested complex lists
- raw HTML
- task list checkboxes
- arbitrary GFM extensions

The renderer should normalize message text into this safe subset before card generation.

## Verbosity Behavior

### Normal mode

- Show only meaningful content to end users
- No process-oriented success text
- Completion notifications contain only the answer body, without a `Codex 已完成：...` prefix
- Errors remain visible

### Debug mode

- Preserve verbose process messaging
- Render a separate debug area in cards with metadata such as:
  - project id
  - session id
  - observation / PTY / fallback source
  - truncation or chunk hints
  - confirmation state or error reason

## Fallback Strategy

Card sending must never become a single point of failure.

Required fallback behavior:

1. Try to send card message
2. On failure, log structured event/error metadata
3. Retry as plain text
4. If plain text itself is oversized, use existing chunking logic

This preserves correctness even if card schema, markdown support, or Feishu-side rendering has issues.

## Length and Chunking Strategy

Phase 1 should define behavior, even if the first implementation is conservative:

- short content: single card
- medium content: multiple cards sent sequentially
- very long content: summarized card plus guidance to inspect local logs or explicit commands

`/tail` and `/rawtail` are excluded from phase 1 because they are the highest-risk cases for payload size and Markdown fidelity.

## Architecture Changes

### New units

- `src/feishu/FeishuMessageRenderer.ts`
  - converts internal `BotMessage` values into Feishu card payloads and fallback text
  - owns Markdown normalization and verbosity-aware layout decisions

### Updated units

- `src/feishu/FeishuGateway.ts`
  - add card-send path
  - keep plain-text fallback path
- `src/session/SessionManager.ts`
  - stop treating all user-visible output as raw strings conceptually
  - map normal replies / completion notifications / error notifications into the new message model

Phase 1 can bridge gradually by letting business code still produce strings in many places while routing the targeted reply types through the new renderer.

## Risks

1. Feishu card Markdown support is not full GFM and may require normalization fixes.
2. Card payload size and component count limits may differ from plain-text size limits.
3. If card and fallback text diverge too much, users may see inconsistent content depending on failure mode.
4. Debug metadata can become noisy unless clearly separated from the primary body.

## Recommended Rollout

### Phase 1

- Add `BotMessage` model
- Add Feishu renderer
- Convert standard replies, completion notifications, and error notifications
- Keep plain-text fallback

### Phase 2

- Expand to `/tail`
- Add richer code-block and multi-card behavior

### Phase 3

- Expand to approvals, status, and other structured system messages

## Success Criteria

- Normal Feishu replies render Markdown-rich content instead of plain text literals.
- Debug mode retains richer context without polluting the primary message body.
- Card sending failures do not cause lost replies.
- The design provides a single outbound rendering path that future message types can reuse.
