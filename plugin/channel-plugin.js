import { createChatChannelPlugin, createChannelPluginBase } from "openclaw/plugin-sdk/channel-core";
import { createTopLevelChannelConfigBase } from "openclaw/plugin-sdk/channel-config-helpers";

const smsConfig = createTopLevelChannelConfigBase({
  sectionKey: "termux-sms",
  resolveAccount: (cfg) => cfg?.channels?.["termux-sms"] ?? {},
  deleteMode: "clear-fields",
  clearBaseFields: ["myNumber", "allowFrom", "pollIntervalMs", "mediaDir", "hookScript"],
});

const smsBase = createChannelPluginBase({
  id: "termux-sms",
  meta: {
    label: "SMS/MMS",
    description: "Send and receive SMS and MMS via Termux",
    markdownCapable: false,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- SMS/MMS channel: plain text replies only. No markdown (no *, **, #, >, `, etc.).",
      "- Keep replies concise — 160-char SMS limit; long replies split across multiple messages.",
      "- Inbound MMS appears as [MMS received] with MIME type, filename, size, and saved path per part.",
      "- To send an MMS (image, audio, video) to the peer: call mms-http-send <peer_number> <file_path> as a tool.",
      "- Plain text replies are delivered as SMS automatically — do not call sms-send directly.",
      "- For slash commands, reply with one concise plain-text line unless help was explicitly requested.",
    ],
  },
  config: smsConfig,
  configSchema: {
    accountFields: [
      {
        key: "myNumber",
        label: "My phone number",
        description: "Your SIM's E.164 number (e.g. +15550000000). Used as senderAddress.",
        type: "string",
        required: false,
      },
      {
        key: "allowFrom",
        label: "Allowed senders",
        description: "Comma-separated E.164 allowlist. Empty = allow all.",
        type: "string",
        required: false,
      },
      {
        key: "pollIntervalMs",
        label: "Poll interval (ms)",
        description: "How often to check for new SMS and MMS. Default: 5000.",
        type: "number",
        required: false,
      },
      {
        key: "mediaDir",
        label: "Media save directory",
        description: "Where to save received MMS parts. Default: ~/.openclaw/workspace/media/inbound",
        type: "string",
        required: false,
      },
      {
        key: "hookScript",
        label: "Media hook script",
        description: "Optional script called per received MMS part: <script> <mime> <saved_path>. Absent = file-drop only.",
        type: "string",
        required: false,
      },
    ],
  },
  setup: undefined,
});

export const smsPlugin = createChatChannelPlugin({
  base: smsBase,
});
