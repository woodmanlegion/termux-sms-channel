# eavesdrop

A real-time operator observation surface for the SMS/MMS channel.

## What it is

A browser-based viewer that shows the live SMS conversation — both sides, with timestamps, inline MMS images, slash command annotations, and a header showing the active model and session. It is served by the channel plugin itself via the openclaw gateway, so no additional server is needed.

This is **not** a skill. The agent never uses it. It is a tap for the human operator (and for Claude Code running in Termux) to observe the channel without relying on SMS delivery or log parsing.

## Opening the viewer

With the openclaw gateway running, open in VNC Chromium:

```
http://127.0.0.1:18789/eavesdrop
```

The page connects to a server-sent events stream and updates live. No refresh needed. The green dot in the header indicates an active connection.

## Observing from the terminal (Claude Code / curl)

```bash
curl -N http://127.0.0.1:18789/eavesdrop/events
```

Each event is a JSON object on the `data:` line. Event types:

| type | meaning |
|------|---------|
| `inbound` | message received from the user's phone |
| `outbound` | agent reply sent back via SMS |
| `slash` | deterministic slash command handled by the channel (never reached the agent) |
| `reset` | `/new` or `/reset` — session divider |

The `meta` event fires on connect and carries `{ model, sessionId }`.

## What the viewer shows

- **Header**: active model, session ID (first 8 chars), time since last activity
- **Inbound bubbles**: sender number, message text, timestamp
- **Outbound bubbles**: agent reply text, timestamp
- **Slash command blocks**: the command as sent + the reply returned — annotated so it's clear the channel handled it, not the agent
- **Session dividers**: a dashed line with timestamp when `/new` resets the conversation
- **MMS images**: displayed inline (served via the `/eavesdrop/media` sub-route)

## What it does not show

- Agent tool calls (exec, browser, etc.) — those are in the session JSONL at `~/.openclaw/agents/main/sessions/<id>.jsonl`
- Messages from numbers not in `allowFrom` / `secondaryFrom` (they are silently dropped before the tap)

## Media note

MMS images are served by path from wherever `mms-receive` saves them (default: `~/.openclaw/workspace/media/inbound`). If media storage is reorganized, the `/eavesdrop/media?path=...` route still works — it is a passthrough with no assumptions about directory structure.

## Security surface

The three routes (`/eavesdrop`, `/eavesdrop/events`, `/eavesdrop/media`) are registered with `auth: "none"`. The gateway is bound to loopback (`127.0.0.1`) only, so these routes are not reachable from the network. If you expose the gateway on LAN or Tailscale, consider whether unauthenticated conversation access is acceptable for your threat model.
