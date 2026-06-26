# Codex Home Isolation Design

## Goal

Prevent multiple `code_bot` instances running on the same machine from sharing one Codex home and overwriting each other's Codex hook configuration.

Today, when `CODEX_HOME` is unset, `code_bot` falls back to `$HOME/.codex`. Two pm2-managed instances under the same user therefore use the same Codex home. If both install hooks, they compete for the same `hooks.json` and managed hook script, so Codex hook events from one bot can be routed to the other bot.

## Decision

`code_bot` always uses a project-local Codex home:

```text
<projectRoot>/.code-bot/codex-home
```

The service must not respect `CODEX_HOME` for the Codex home it manages or for Codex CLI child processes it starts. The project root is the root used when the service is created, matching the existing app and session manager project-root semantics.

This makes separate pm2 instances naturally isolated when they run from different checkouts:

```text
/data00/home/huangjiancheng.max/workspace/code_bot/.code-bot/codex-home
/data00/home/huangjiancheng.max/projects/code_bot/.code-bot/codex-home
```

## Initialization

At service startup, `code_bot` initializes the project-local Codex home:

1. Ensure `<projectRoot>/.code-bot/codex-home` exists.
2. If `<projectRoot>/.code-bot/codex-home/config.toml` already exists, leave it unchanged.
3. If the project-local `config.toml` is missing and `$HOME/.codex/config.toml` exists, copy that file into the project-local Codex home.
4. If the default config file does not exist, create only the directory and allow Codex to use its own defaults.

Only `config.toml` is copied. The initializer must not copy `hooks.json`, sessions, auth state, plugin caches, temporary files, or any other runtime state from the default Codex home.

## Runtime Behavior

All code paths that need a Codex home use the same resolved project-local path:

- Codex hook installer writes `hooks.json`, the managed hook script, and the manifest under the project-local Codex home.
- Codex hook status reports inspect the project-local Codex home.
- `CodexSessionRegistry` reads sessions from the project-local Codex home.
- model catalog/cache reads use the project-local Codex home.
- Codex CLI child processes are spawned with `CODEX_HOME=<projectRoot>/.code-bot/codex-home`.

This keeps hooks, Codex CLI sessions, resume behavior, and model metadata on the same isolated state root.

## Status and Observability

Hook status should show the resolved Codex home path so operators can confirm isolation:

```text
Codex home: <projectRoot>/.code-bot/codex-home
Codex home source: project
```

Startup logs should record whether the local `config.toml` was already present, copied from the default home, or absent because no default config existed.

## Compatibility

This intentionally changes default behavior. A `code_bot` instance will no longer use the user's shared `$HOME/.codex` state for hooks, sessions, or child Codex processes.

The first startup preserves user-level Codex configuration by copying only `config.toml`. Operators may need to re-authenticate or reinstall plugins inside the project-local Codex home if those are required by Codex CLI behavior, because auth state and plugin caches are not copied.

This tradeoff is intentional: copying runtime state would reintroduce cross-instance coupling and could import unrelated hooks into the isolated home.

## Error Handling

Initialization failure should be explicit and fail startup when the project-local Codex home cannot be created or when `config.toml` cannot be copied. Running with a partially initialized Codex home would make hook and resume behavior difficult to reason about.

If the default `config.toml` is missing, that is not an error.

## Testing

Tests should cover:

- default resolution uses `<projectRoot>/.code-bot/codex-home`
- `CODEX_HOME` is ignored by the resolver
- startup copies only `$HOME/.codex/config.toml` when the local file is missing
- startup does not overwrite an existing project-local `config.toml`
- missing default `config.toml` creates only the project-local directory
- hook installer, hook status, session registry, model catalog, and Codex runner receive the same resolved Codex home
- two different project roots resolve to different Codex home paths

