# Message ID Deduplication Design

## Goal

Prevent the same Feishu `messageId` from being sent to Codex more than once.

When Feishu redelivers the same inbound message, code bot should silently drop the duplicate: no user-visible reply, no `SessionManager.handleText` call, and no Codex runner send.

## Context

Current logs show repeated `command.received` and `session.send_dispatched` events for the same Feishu `messageId`. The gateway already extracts and logs `messageId`, but the value is not used for idempotency. As a result, a redelivered Feishu event is treated as normal user input. If a Codex turn is already pending, the duplicate can become a follow-up and be sent to Codex again.

The retry path inside `SessionManager` is not the source of the duplicate user text because submit retry sends an empty string, not the original message body.

## Chosen Approach

Add durable inbound message claiming at the bootstrap/gateway boundary.

The callback passed to `gateway.start` should:

1. Log the existing `command.received` event.
2. Claim the inbound `messageId` through `FileStateStore`.
3. Continue to `app.sessionManager.handleText(message)` only when the claim succeeds.
4. For duplicate claims, append `command.duplicate_dropped` and return an empty reply.

This keeps Feishu delivery idempotency outside `SessionManager`, which should remain focused on bot commands, chat state, sessions, and Codex interaction.

## Alternatives Considered

### SessionManager-Level Deduplication

Passing `messageId` into `IncomingBotText` and deduplicating inside `handleTextQueued` would place the check closer to command handling. It is less clean because `SessionManager` would need to understand Feishu event identity, and duplicates would still enter the chat queue before being rejected.

### In-Memory Deduplication

Keeping a process-local `Set` of seen IDs is simple, but it fails after restart and does not match the at-least-once delivery model seen in the logs.

## State Model

Add an inbound message receipt record persisted under:

```text
.code-bot/state/inbound-messages/<safeMessageId>.json
```

Record shape:

```ts
interface InboundMessageReceipt {
  messageId: string;
  chatId: string;
  chatType: 'private' | 'group';
  userId: string;
  textPreview: string;
  firstReceivedAt: string;
  lastDuplicateAt?: string;
  duplicateCount: number;
  status: 'claimed';
}
```

`textPreview` should be bounded to avoid persisting unexpectedly large message bodies.

## Store API

Add a method equivalent to:

```ts
claimInboundMessage(input): Promise<
  | { claimed: true; reason?: 'missing_message_id' }
  | { claimed: false; receipt: InboundMessageReceipt }
>
```

Semantics:

- Missing `messageId`: return claimed and do not write state. Existing behavior is preserved for sources that do not provide message IDs.
- First seen `messageId`: write a receipt with `duplicateCount: 0` and return claimed.
- Duplicate `messageId`: update `lastDuplicateAt`, increment `duplicateCount`, and return not claimed.

The read-check-write sequence must run inside the existing `FileStateStore` write queue so two near-simultaneous deliveries cannot both claim the same ID.

## Logging

Keep the existing `command.received` event for every inbound delivery attempt.

Add `command.duplicate_dropped` only when a duplicate is suppressed. Event data should include:

- `messageId`
- `chatId`
- `chatType`
- `userId`
- `text`
- `duplicateCount`

Duplicate deliveries should not emit `command.replied`, `session.send_requested`, or `session.send_dispatched`.

## Error Handling

If claiming the inbound message fails because of storage errors, fail closed:

- Record an error log entry.
- Return an empty reply.
- Do not call `SessionManager.handleText`.

This can drop a new message during a state storage outage, but it preserves the primary safety property: code bot must not send a possibly duplicated user command to Codex.

## Retention

The first implementation should keep receipts indefinitely. A cleanup policy can be added later if the state directory grows enough to matter. Avoiding an expiration window prevents old redeliveries from becoming eligible for Codex dispatch again.

## Tests

Add focused coverage for:

- `FileStateStore` first claim succeeds and writes a receipt.
- `FileStateStore` duplicate claim returns not claimed and increments `duplicateCount`.
- Concurrent claims for the same `messageId` produce one successful claim.
- Bootstrap dispatches a repeated `messageId` to `SessionManager.handleText` only once.
- Bootstrap returns an empty reply and writes `command.duplicate_dropped` for duplicate deliveries.
- Messages without `messageId` still follow current behavior.
- Claim storage failure records an error and does not call `SessionManager.handleText`.

Run the relevant unit tests and full build after implementation.
