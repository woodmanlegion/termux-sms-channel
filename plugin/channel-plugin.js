import { createChatChannelPlugin, createChannelPluginBase } from "openclaw/plugin-sdk/channel-core";
import { createTopLevelChannelConfigBase } from "openclaw/plugin-sdk/channel-config-helpers";

const smsConfig = createTopLevelChannelConfigBase({
  sectionKey: "termux-sms",
  resolveAccount: (cfg) => cfg?.channels?.["termux-sms"] ?? {},
  deleteMode: "clear-fields",
  clearBaseFields: ["myNumber", "allowFrom", "pollIntervalMs", "mediaDir", "hookScript", "secondaryFrom", "secondaryWarning", "rejectMessage"],
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
      "- To send a proactive SMS/MMS to a phone number: use the message tool with channel='termux-sms', not channel='sms'.",
      "- The channel owner may use multiple phone numbers (e.g. dual SIM). The channel handles routing — replies always go to the configured primary number regardless of which number a message arrived from. No need to acknowledge or comment on sender switching.",
      "- To send an MMS attachment (image, audio, video): call mms-http-send <peer_number> <file_path> as a tool.",
      "- Plain text replies in an active conversation are delivered as SMS automatically — do not call sms-send directly.",
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
      {
        key: "secondaryFrom",
        label: "Secondary source numbers",
        // Dual-SIM / multi-number: messages from these numbers are processed as
        // owner commands but replies go to the primary allowFrom number, and a
        // warning is sent back to the secondary number. Useful when the same
        // person reaches the channel from a second SIM or a number retained for
        // two-factor accounts. Not a general multi-user feature.
        description: "Comma-separated numbers treated as the owner. Replies go to allowFrom; a warning is sent back to the secondary number.",
        type: "string",
        required: false,
      },
      {
        key: "secondaryWarning",
        label: "Secondary source warning",
        description: "Message sent back when a secondary number is used. Default: 'secondary channel in use'.",
        type: "string",
        required: false,
      },
      {
        key: "rejectMessage",
        label: "Rejection message",
        description: "Reply sent to numbers not in allowFrom or secondaryFrom. Empty = silent drop (default).",
        type: "string",
        required: false,
      },
    ],
  },
  setup: undefined,
});

export const smsPlugin = createChatChannelPlugin({
  base: {
    ...smsBase,
    // Polling channels have no persistent connection to signal — keep a pending
    // Promise so the health-monitor sees running=true and stops restarting us.
    startAccount: async ({ abortSignal }) => {
      await new Promise((resolve) => {
        abortSignal.addEventListener("abort", resolve, { once: true });
      });
    },
  },
});
