# AGENTS.md — termux-sms-channel

Channel plugin dispatch guide. This is an OpenClaw channel plugin, not a callable binary. Read this to understand how the channel is configured and how messages flow.

## What this is

`termux-sms-channel` is an OpenClaw channel plugin that bridges Android SMS/MMS to the OpenClaw agent gateway. It polls the Android SMS/MMS content provider, delivers inbound messages as DMs, and sends outbound replies via `sms-send` and `mms-http-send`.

This plugin **does not run as a binary you call.** It runs inside the OpenClaw gateway process and is managed by it.

---

## First Run / Configuration

Install via claw-gh-install:

```bash
claw-gh-install woodmanlegion/termux-sms-channel
openclaw gateway restart
```

Configure the channel via `openclaw config patch`:

```bash
# Minimum required: allowFrom (your authorized phone number)
openclaw config patch channels.termux-sms-channel.allowFrom "+15558675309" --string
openclaw config patch channels.termux-sms-channel.myNumber "+15558675309" --string
```

Full config options:

```bash
# Required
openclaw config patch channels.termux-sms-channel.allowFrom "+15558675309" --string
openclaw config patch channels.termux-sms-channel.myNumber "+15558675309" --string

# Dual-SIM: secondary number (e.g. work SIM) that maps to allowFrom for replies
openclaw config patch channels.termux-sms-channel.secondaryFrom "+15550000000" --string

# Message sent to senders not in allowFrom/secondaryFrom (empty = silent drop)
openclaw config patch channels.termux-sms-channel.rejectMessage "not authorized" --string

# Optional warning sent back when secondaryFrom is detected
# (omit to suppress — agent handles silently via system prompt)
openclaw config patch channels.termux-sms-channel.secondaryWarning "" --string
```

Verify configuration:

```bash
openclaw config get channels.termux-sms-channel
```

---

## Routing

The channel plugin does **not** route itself — the OpenClaw gateway does. Messages from `allowFrom` arrive in the `termux-sms-channel` DM session. The agent responds and the plugin sends the reply via `sms-send` or `mms-http-send`.

| Condition | Behavior |
|-----------|----------|
| Sender in `allowFrom` | Delivered normally |
| Sender in `secondaryFrom` | Delivered; reply sent to `allowFrom[0]` (canonical number) |
| Sender in neither | `rejectMessage` sent (if set); message dropped |
| Group MMS (3+ address rows) | Delivered as-is; sender is the FROM address |

---

## Skill Dependencies

The plugin calls these skills at runtime — all must be installed in `~/.openclaw/workspace/skills/`:

| Binary | Skill repo | Purpose |
|--------|-----------|---------|
| `sms-send` | `woodmanlegion/skill-sms-send` | Outbound SMS replies |
| `mms-http-send` | `woodmanlegion/skill-mms-send` | Outbound MMS replies |
| `mms-receive` | `woodmanlegion/skill-mms-receive` | Inbound MMS polling |

Install each:

```bash
claw-gh-install woodmanlegion/skill-sms-send
claw-gh-install woodmanlegion/skill-mms-send
claw-gh-install woodmanlegion/skill-mms-receive
```

---

## Health / Troubleshooting

**Channel not starting:**
```bash
openclaw gateway logs --tail 50
```
Look for `termux-sms-channel` errors. If health-monitor restarts every ~10 min, the channel exited immediately — check that the plugin is installed to `~/.openclaw/extensions/`, not loaded from a project folder.

**Verify plugin is installed (not linked):**
```bash
ls ~/.openclaw/extensions/termux-sms-channel/
openclaw config get plugins.load.paths   # should be []
```

**Gateway restart:**
```bash
openclaw gateway restart
```

**No messages arriving:**
- Confirm `allowFrom` matches the exact E.164 number the phone sends from
- Check `mms-receive --show-config` for `content_binary_exists: true`
- Check `sms-send --show-config` for `termux_sms_send_exists: true`

---

## Framework Compatibility

| Framework | Status | Notes |
|-----------|--------|-------|
| OpenClaw | ✅ Native | Channel plugin; loaded by gateway |
| Pi | ⛔ Not applicable | Pi reads SKILL.md; channel plugins are gateway-only |
| Claude Code | ⛔ Not applicable | Claude Code is a coding agent, not a gateway runtime |
