import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "termux-sms",
  name: "SMS/MMS (Termux)",
  description: "Unified Termux SMS/MMS channel — receive and send SMS and MMS, media saved to workspace",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin.js",
    exportName: "smsPlugin",
  },
  runtime: {
    specifier: "./runtime-setter.js",
    exportName: "setSmsRuntime",
  },
});
