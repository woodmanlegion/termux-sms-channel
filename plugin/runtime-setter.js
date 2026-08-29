import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/direct-dm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const execFileP = promisify(execFile);

// ── Dependency paths ──────────────────────────────────────────────────────────
// Full paths required — Node.js subprocesses do not inherit Termux PATH.

const HOME         = process.env.HOME ?? "/data/data/com.termux/files/home";
const SMS_SEND     = `${HOME}/.openclaw/workspace/skills/sms-send/bin/sms-send`;
const MMS_RECEIVE  = `${HOME}/Projects/66_mms-receive/bin/mms-receive`;
const MMS_HTTP_SEND = `${HOME}/Scripts/mms-http-send`;

// State file for persisted high-water marks — survives gateway restarts
const STATE_DIR  = `${HOME}/.config/openclaw-termux-channel`;
const STATE_FILE = join(STATE_DIR, "state.json");

// ── Dependency check ──────────────────────────────────────────────────────────

function checkDependencies() {
  const deps = [
    [SMS_SEND,      "skill-sms-send",    "https://github.com/woodmanlegion/skill-sms-send"],
    [MMS_RECEIVE,   "skill-mms-receive", "https://github.com/woodmanlegion/skill-mms-receive"],
    [MMS_HTTP_SEND, "mms-http-send",     "https://github.com/woodmanlegion/skill-mms-send"],
  ];
  const missing = deps.filter(([path]) => !existsSync(path));
  if (missing.length > 0) {
    for (const [path, name, url] of missing)
      process.stderr.write(`[termux-channel] MISSING: ${name} not found at ${path} — install: ${url}\n`);
    throw new Error(`[termux-channel] missing: ${missing.map(([, n]) => n).join(", ")}`);
  }
}

// ── Persisted state ───────────────────────────────────────────────────────────

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { smsHighWater: -1, mmsHighWater: 0 };
  }
}

function saveState(state) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (err) {
    process.stderr.write(`[termux-channel] state save error: ${err?.message}\n`);
  }
}

// ── Runtime store ─────────────────────────────────────────────────────────────

const { setRuntime } = createPluginRuntimeStore({
  pluginId: "termux-sms",
  errorMessage: "SMS/MMS runtime not initialized",
});

let pollTimer = null;
let state     = { smsHighWater: -1, mmsHighWater: 0 };

// ── Shared helpers ────────────────────────────────────────────────────────────

function isAllowed(sender, smsConfig) {
  if (!smsConfig.allowFrom) return true;
  const allowed = String(smsConfig.allowFrom).split(",").map(s => s.trim()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(sender);
}

function getConfig(runtime) {
  return runtime?.config?.current?.() ?? {};
}

function getChannelConfig(runtime) {
  return getConfig(runtime)?.channels?.["termux-sms"] ?? {};
}

// ── Outbound ──────────────────────────────────────────────────────────────────

async function sendSms(to, text) {
  await execFileP(SMS_SEND, [to, text], { timeout: 30_000 });
}

async function sendMms(to, filePath) {
  await execFileP(MMS_HTTP_SEND, [to, filePath], { timeout: 60_000 });
}

// ── SMS inbound ───────────────────────────────────────────────────────────────

async function fetchSmsInbox(limit = 20) {
  const { stdout } = await execFileP(
    "termux-sms-list",
    ["-l", String(limit), "-t", "inbox"],
    { timeout: 10_000 }
  );
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [];
}

async function pollSms(runtime) {
  let messages;
  try { messages = await fetchSmsInbox(20); } catch { return; }

  const cfg       = getConfig(runtime);
  const smsCfg    = getChannelConfig(runtime);
  const myNumber  = String(smsCfg.myNumber ?? "").trim();
  const ordered   = [...messages].reverse();
  let changed     = false;

  for (const msg of ordered) {
    const id = msg._id ?? -1;
    if (id <= state.smsHighWater) continue;
    state.smsHighWater = id;
    changed = true;

    const sender = String(msg.number ?? msg.address ?? "").trim();
    const body   = String(msg.body ?? "").trim();
    if (!sender || !body) continue;
    if (!isAllowed(sender, smsCfg)) continue;

    const timestamp = new Date(typeof msg.date === "number" ? msg.date : Date.now());

    try {
      await dispatchInboundDirectDmWithRuntime({
        cfg,
        channel: "termux-sms",
        accountId: "default",
        peer: sender,
        runtime,
        channelLabel: "SMS",
        conversationLabel: sender,
        rawBody: body,
        bodyForAgent: body,
        commandBody: body,
        commandAuthorized: body.startsWith("/"),
        senderAddress: myNumber,
        recipientAddress: sender,
        senderId: sender,
        messageId: String(id),
        timestamp,
        deliver: async (payload) => {
          const text = String(payload?.text ?? "").trim();
          if (text) await sendSms(sender, text);
          return {};
        },
      });
    } catch (err) {
      process.stderr.write(`[termux-channel] SMS dispatch error ${sender}: ${err?.message ?? err}\n`);
    }
  }

  if (changed) saveState(state);
}

// ── MMS inbound ───────────────────────────────────────────────────────────────

function formatMmsParts(parts) {
  return parts.map(p => {
    const size = p.size ? ` (${(p.size / 1024).toFixed(1)} KB)` : "";
    const path = p.saved_path ? `\n    saved: ${p.saved_path}` : "";
    const text = p.text ? `\n    text: ${p.text.slice(0, 200)}` : "";
    return `  - ${p.mime}${p.name ? " " + p.name : ""}${size}${path}${text}`;
  }).join("\n");
}

async function runHook(hookScript, mime, savedPath) {
  if (!hookScript || !savedPath) return;
  try {
    await execFileP(hookScript, [mime, savedPath], { timeout: 30_000 });
  } catch (err) {
    process.stderr.write(`[termux-channel] hook error for ${mime}: ${err?.message}\n`);
  }
}

async function pollMms(runtime) {
  const smsCfg     = getChannelConfig(runtime);
  const cfg        = getConfig(runtime);
  const myNumber   = String(smsCfg.myNumber ?? "").trim();
  const mediaDir   = smsCfg.mediaDir || `${HOME}/.openclaw/workspace/media/inbound`;
  const hookScript = smsCfg.hookScript || null;

  let messages;
  try {
    const { stdout } = await execFileP(
      MMS_RECEIVE,
      ["--since", String(state.mmsHighWater), "--save", mediaDir, "--json"],
      { timeout: 30_000 }
    );
    messages = JSON.parse(stdout);
  } catch { return; }

  if (!messages.length) return;

  let changed = false;

  for (const mms of messages) {
    if (mms.id > state.mmsHighWater) {
      state.mmsHighWater = mms.id;
      changed = true;
    }

    const sender = String(mms.sender ?? "").trim();
    if (!sender) continue;
    if (!isAllowed(sender, smsCfg)) continue;

    // Fire hook stubs per part (best-effort, non-blocking)
    for (const part of mms.parts) {
      if (part.saved_path && hookScript) {
        runHook(hookScript, part.mime, part.saved_path).catch(() => {});
      }
    }

    const body      = `[MMS received — ${mms.parts.length} part(s)]:\n${formatMmsParts(mms.parts)}`;
    const timestamp = new Date(mms.date * 1000);

    try {
      await dispatchInboundDirectDmWithRuntime({
        cfg,
        channel: "termux-sms",
        accountId: "default",
        peer: sender,
        runtime,
        channelLabel: "SMS",
        conversationLabel: sender,
        rawBody: body,
        bodyForAgent: body,
        commandBody: body,
        commandAuthorized: false,
        senderAddress: myNumber,
        recipientAddress: sender,
        senderId: sender,
        messageId: `mms-${mms.id}`,
        timestamp,
        deliver: async (payload) => {
          const text = String(payload?.text ?? "").trim();
          if (text) await sendSms(sender, text);
          return {};
        },
      });
    } catch (err) {
      process.stderr.write(`[termux-channel] MMS dispatch error ${sender}: ${err?.message ?? err}\n`);
    }
  }

  if (changed) saveState(state);
}

// ── Polling loop ──────────────────────────────────────────────────────────────

function startPolling(runtime) {
  const cfg        = getConfig(runtime);
  const intervalMs = Number(cfg?.channels?.["termux-sms"]?.pollIntervalMs ?? 5_000);

  process.stderr.write(`[termux-channel] starting (interval=${intervalMs}ms, smsHW=${state.smsHighWater}, mmsHW=${state.mmsHighWater})\n`);

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    pollSms(runtime).catch(err =>
      process.stderr.write(`[termux-channel] SMS poll error: ${err?.message}\n`)
    );
    pollMms(runtime).catch(err =>
      process.stderr.write(`[termux-channel] MMS poll error: ${err?.message}\n`)
    );
  }, intervalMs);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function setSmsRuntime(runtime) {
  try {
    process.stderr.write("[termux-channel] setSmsRuntime called\n");
    checkDependencies();
    state = loadState();
    setRuntime(runtime);
    startPolling(runtime);
  } catch (err) {
    process.stderr.write(`[termux-channel] ERROR in setSmsRuntime: ${err?.message}\n`);
    throw err;
  }
}
