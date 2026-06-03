# `/status` Markdown Layout Design

## Goal

Improve the `/status` message layout so it is easier to scan inside Feishu Markdown cards, while preserving the existing status data, fallback behavior, and plain-text compatibility.

The change should make `/status` feel intentionally structured in Feishu instead of looking like plain text that happens to be transported through a Markdown card.

## Non-Goals

- Do not change how `/status` fetches Codex native status.
- Do not change live, cached, or observation fallback semantics.
- Do not redesign the global Feishu renderer.
- Do not change `/tail`, `/rawtail`, completion notifications, or unrelated reply types.
- Do not remove plain-text fallback behavior.

## Problem Statement

The current `/status` implementation now includes useful Codex information, but it still renders as a plain line-by-line text block:

- local session fields are shown as raw lines
- Codex fields are shown as raw lines
- raw Codex status is appended as more raw lines

Feishu renders the content through a Markdown card, but the message body itself is not designed as Markdown. The result is technically correct yet visually weak:

- section boundaries are unclear
- important values do not stand out
- empty fields create noise
- the raw status block competes with the structured summary

The layout should be optimized for Feishu card reading without changing the underlying status behavior.

## Selected Approach

Introduce a dedicated `/status` message formatter that produces:

- a Feishu-oriented `bodyMarkdown`
- a compatibility `fallbackText`

The formatter should own status presentation rules. `SessionManager` should stop building the user-facing `/status` string directly and instead pass structured local and Codex status data into the formatter.

This keeps message layout concerns isolated from session orchestration and preserves a stable place to refine the design later.

## User-Facing Layout

The Markdown body should be split into three blocks:

1. `## Session`
2. `## Codex`
3. `## Raw`

### `## Session`

This block shows the local bot/session view.

Always include:

- `Project`
- `Session`
- `Status`

Conditionally include:

- `Summary`
- `Pending approvals`

Formatting rules:

- one bullet per field
- field name in bold
- stable identifiers and short state values in inline code
- narrative text such as summaries stays plain text

Example:

```md
## Session
- **Project**: `repo`
- **Session**: `sess_abc123`
- **Status**: `running`
- **Summary**: recent work summary
```

### `## Codex`

This block shows the Codex-native or fallback-derived status summary.

When Codex status is available, display only present fields:

- `Source`
- `Fetched at`
- `Status`
- `Task`
- `Progress`
- `Context window`
- `Token usage`
- `Model`
- `Working directory`

Formatting rules:

- one bullet per field
- labels in bold
- machine-like short values in inline code
- longer prose values such as task and progress remain plain text

Example:

```md
## Codex
- **Source**: `live`
- **Fetched at**: `2026-06-03T10:00:00.000Z`
- **Status**: `running`
- **Task**: Implement status integration
- **Model**: `gpt-5-codex`
```

When Codex status is unavailable:

```md
## Codex
Unavailable
```

This should not render a noisy empty field list.

### `## Raw`

This block is shown by default whenever raw Codex status text exists.

Rendering rules:

- use a fenced code block
- preserve line breaks
- do not attempt secondary formatting inside the raw block

Example:

```md
## Raw
```text
Status: running
Task: Implement status integration
Model: gpt-5-codex
```
```

If no raw text is available, omit the `## Raw` block entirely.

## Empty-Field Policy

Use a mixed policy:

- always show `Project`, `Session`, and `Status`
- omit empty `Summary`
- omit empty `Pending approvals`
- omit missing optional Codex summary fields
- render explicit `Unavailable` for the entire Codex block only when no Codex status is available

This keeps the card compact without hiding the essential session identity.

## Plain-Text Fallback

The formatter must also produce a plain-text fallback string.

Requirements:

- preserve all important information
- keep the current line-based style acceptable for text fallback
- do not require the fallback to mirror the Markdown layout exactly

The fallback may remain close to the existing format:

- local session lines first
- blank line
- Codex status lines
- blank line
- raw status lines

This keeps fallback reliability high while allowing the Markdown card to be more polished.

## Implementation Boundary

Add a dedicated formatter unit, for example:

- `src/status/StatusMessageFormatter.ts`

Responsibilities:

- accept local status data plus rendered Codex status data
- produce `{ bodyMarkdown, fallbackText }`
- encode field inclusion rules and section ordering

Non-responsibilities:

- do not fetch Codex status
- do not parse native status text
- do not inspect PTY logs
- do not send Feishu messages directly

`SessionManager` should use this formatter when handling `/status`, ideally by returning a `renderedReply` explicitly instead of routing `/status` through the generic plain-string-to-Markdown bridge.

## Integration Strategy

Recommended flow:

1. `SessionManager` gathers local session data.
2. `SessionManager` resolves the Codex status result exactly as today.
3. A dedicated formatter builds:
   - `bodyMarkdown`
   - `fallbackText`
4. `/status` returns both:
   - a plain `reply` for compatibility
   - a `renderedReply` using the new Markdown body

This keeps the existing reply contract intact while allowing `/status` to opt into a purpose-built card body.

## Testing Scope

Add focused tests for:

- Markdown layout with all session and Codex fields present
- omission of empty `Summary`
- omission of empty `Pending approvals`
- Codex unavailable layout
- raw block rendering when raw text exists
- raw block omission when raw text does not exist
- plain-text fallback remaining readable
- `/status` integration returning a rendered Markdown reply instead of relying only on the generic reply bridge

## Risks

1. Feishu Markdown may render headings, bullets, and fenced code blocks slightly differently than GitHub Markdown.
2. If the Markdown body and fallback text diverge too much, failure-mode output may feel inconsistent.
3. The raw block can dominate the card if Codex `status` output becomes very large.

These risks are acceptable for this scoped change. The first iteration should optimize readability without over-engineering truncation or card-element customization.

## Success Criteria

- `/status` is clearly segmented inside Feishu cards.
- Important status values stand out visually.
- Empty optional fields do not clutter the card.
- Raw Codex status remains visible by default.
- Plain-text fallback remains intact and reliable.
