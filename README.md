# openclaw-termux-channel

Unified OpenClaw channel plugin for Android/Termux. Handles SMS and MMS receive and send from the device SIM — no Twilio, no cloud intermediary.

**Status:** Working. Replaces [openclaw-plugin-termux-sms](https://github.com/woodmanlegion/openclaw-plugin-termux-sms).

---

## What It Does

- Polls `termux-sms-list` for inbound SMS every `pollIntervalMs` ms
- Polls `mms-receive` for inbound MMS on the same interval
- Saves received MMS parts to `~/.openclaw/workspace/media/inbound/` (configurable)
- Dispatches both to the OpenClaw agent with full part metadata
- Replies via `sms-send` (with Android rate-limit bypass)
- Fires an optional hook script per received MMS part for downstream processing
- Persists high-water marks to `~/.config/openclaw-termux-channel/state.json` — survives gateway restarts without replaying old messages

## Dependencies

All required binaries must be on absolute paths — Node.js subprocesses do not inherit Termux PATH.

| Dependency | Install |
|-----------|---------|
| [skill-sms-send](https://github.com/woodmanlegion/skill-sms-send) | Outbound SMS with rate-limit bypass |
| [skill-mms-receive](https://github.com/woodmanlegion/skill-mms-receive) | MMS content provider query |
| [skill-mms-send](https://github.com/woodmanlegion/skill-mms-send) | Outbound MMS via mms-http-send |

## Installation

```bash
# 1. Install dependencies first
# skill-sms-send, skill-mms-receive, skill-mms-send — see each repo

# 2. Clone
git clone https://github.com/woodmanlegion/openclaw-termux-channel \
  ~/Projects/openclaw-termux-channel

# 3. Register the plugin load path
openclaw config patch --file - << 'EOF'
{
  plugins: {
    load: {
      paths: ["/data/data/com.termux/files/home/Projects/openclaw-termux-channel/plugin"]
    }
  }
}
EOF

# 4. Configure the channel
openclaw config patch --inline '{
  "channels": {
    "termux-sms": {
      "enabled": true,
      "myNumber": "+15550000000",
      "allowFrom": "+15558675309",
      "pollIntervalMs": 5000
    }
  }
}'

# 5. Restart
openclaw gateway restart
```

## Configuration

All keys under `channels.termux-sms` in `openclaw.json`. See `config.example`.

| Key | Default | Purpose |
|-----|---------|---------|
| `enabled` | `true` | Enable/disable the channel |
| `myNumber` | — | Your SIM's E.164 number |
| `allowFrom` | — | Comma-separated E.164 allowlist. Empty = allow all. |
| `pollIntervalMs` | `5000` | Poll interval in ms |
| `mediaDir` | `~/.openclaw/workspace/media/inbound` | MMS part save directory |
| `hookScript` | — | Optional script called per MMS part: `<script> <mime> <saved_path>` |

## State File

`~/.config/openclaw-termux-channel/state.json` — written after every poll that advances the high-water mark. Prevents MMS replay on gateway restart.

## Known Issues

- Session peer is stored as `direct:unknown` rather than `direct:+number` — all SMS/MMS conversation history lands in one session regardless of sender. Functional but not per-contact.
- Health-monitor restarts the channel runtime every ~10 min (channel never signals "connected" to the health monitor). State persists through this correctly.

## Deprecation Notice

This plugin deprecates:
- [openclaw-plugin-termux-sms](https://github.com/woodmanlegion/openclaw-plugin-termux-sms) — predecessor, SMS-only, no state persistence

The standalone skills remain as reference implementations and are called as binaries by this plugin:
- [skill-sms-send](https://github.com/woodmanlegion/skill-sms-send)
- [skill-mms-receive](https://github.com/woodmanlegion/skill-mms-receive)
- [skill-mms-send](https://github.com/woodmanlegion/skill-mms-send)
