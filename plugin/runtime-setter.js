import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const execFileP = promisify(execFile);

// ── Dependency paths ──────────────────────────────────────────────────────────
// Full paths required — Node.js subprocesses do not inherit Termux PATH.

const HOME         = process.env.HOME ?? "/data/data/com.termux/files/home";
const SMS_SEND      = `${HOME}/.openclaw/workspace/skills/sms-send/bin/sms-send`;
const MMS_RECEIVE   = `${HOME}/.openclaw/workspace/skills/mms-receive/bin/mms-receive`;
const MMS_HTTP_SEND = `${HOME}/.openclaw/workspace/skills/mms-send/bin/mms-http-send`;

// State file for persisted high-water marks — survives gateway restarts
const STATE_DIR    = `${HOME}/.config/openclaw-termux-channel`;
const STATE_FILE   = join(STATE_DIR, "state.json");
const SESSIONS_FILE   = `${HOME}/.openclaw/agents/main/sessions/sessions.json`;
const OPENCLAW_CONFIG = `${HOME}/.openclaw/openclaw.json`;

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

// ── Model switching ───────────────────────────────────────────────────────────

function listModels() {
  try {
    const cfg = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf8"));
    const providers = cfg?.models?.providers ?? {};
    const results = [];
    for (const [provId, prov] of Object.entries(providers)) {
      for (const m of prov.models ?? []) {
        const vision = (m.input ?? []).includes("image");
        const reasoning = m.reasoning === true;
        results.push({ id: `${provId}/${m.id}`, vision, reasoning });
      }
    }
    return results;
  } catch { return []; }
}

// Returns the best vision model for a one-off auto-dispatch:
// prefer non-reasoning vision models (cheaper), else fall back to any vision model.
function bestVisionModel() {
  const models = listModels();
  return models.find(m => m.vision && !m.reasoning) ?? models.find(m => m.vision) ?? null;
}

function getCurrentModel() {
  try {
    const sessions = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    const sess = sessions["agent:main:main"] ?? {};
    if (sess.providerOverride && sess.modelOverride)
      return `${sess.providerOverride}/${sess.modelOverride}`;
    return null;
  } catch { return null; }
}

function setSessionModel(providerOverride, modelOverride) {
  try {
    const sessions = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    const sess = sessions["agent:main:main"] ?? {};
    sess.providerOverride      = providerOverride;
    sess.modelOverride         = modelOverride;
    sess.modelOverrideSource   = "user";
    sess.updatedAt             = Date.now();
    sessions["agent:main:main"] = sess;
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    throw new Error(`could not write sessions.json: ${err?.message}`);
  }
}

function clearSessionModel() {
  try {
    const sessions = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    const sess = sessions["agent:main:main"] ?? {};
    delete sess.providerOverride;
    delete sess.modelOverride;
    delete sess.modelOverrideSource;
    sess.updatedAt = Date.now();
    sessions["agent:main:main"] = sess;
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    throw new Error(`could not write sessions.json: ${err?.message}`);
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
  pluginId: "termux-sms-channel",
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

// Returns the canonical reply-to number for a secondary source, or null if the
// sender is not a secondary source. Secondary sources are treated as the owner
// (messages are processed normally) but replies go to the primary allowFrom
// number and a warning is sent back to the secondary number.
// Intended for dual-SIM / multi-number scenarios where the same person uses
// more than one phone number to reach the channel.
function resolveSecondary(sender, smsConfig) {
  if (!smsConfig.secondaryFrom) return null;
  const secondary = String(smsConfig.secondaryFrom).split(",").map(s => s.trim()).filter(Boolean);
  if (!secondary.includes(sender)) return null;
  const canonical = String(smsConfig.allowFrom ?? "").split(",")[0].trim();
  return canonical || null;
}

function getConfig(runtime) {
  return runtime?.config?.current?.() ?? {};
}

function getChannelConfig(runtime) {
  return getConfig(runtime)?.channels?.["termux-sms-channel"] ?? {};
}

// ── Outbound ──────────────────────────────────────────────────────────────────

async function sendSms(to, text) {
  await execFileP(SMS_SEND, [to, text], { timeout: 30_000 });
}

async function sendMms(to, filePath) {
  await execFileP(MMS_HTTP_SEND, [to, filePath], { timeout: 60_000 });
}

// ── Deterministic slash commands ──────────────────────────────────────────────
// These are handled before the agent sees the message.
// Returns true if the command was handled (skip agent dispatch), false otherwise.

const HELP_TEXT =
  "/status       — system status\n" +
  "/help         — this list\n" +
  "/models       — list available models\n" +
  "/model <id>   — switch model (use ID from /models)\n" +
  "/model reset  — revert to default model\n" +
  "/new [prompt] — start fresh session\n" +
  "/reset        — alias for /new";

async function handleSlashCommand(body, replyTo, runtime) {
  if (!body.startsWith("/")) return false;

  const [cmd, ...rest] = body.trim().split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd.toLowerCase()) {
    case "/status": {
      const cfg     = getConfig(runtime);
      const smsCfg  = getChannelConfig(runtime);
      const model   = getCurrentModel() ?? cfg?.agents?.defaults?.model?.fallbacks?.[0] ?? "unknown";
      const myNum   = smsCfg.myNumber ?? "?";
      await sendSms(replyTo,
        `edge-android-25 online\nmodel: ${model}\nSMS: ${myNum}\nchannel: ok`
      );
      return true;
    }

    case "/help":
      await sendSms(replyTo, HELP_TEXT);
      return true;

    case "/models": {
      const models = listModels();
      const current = getCurrentModel();
      const lines = models.map(m => {
        const tag = m.vision ? " [vision]" : "";
        const cur = m.id === current ? " *" : "";
        return `${m.id}${tag}${cur}`;
      });
      await sendSms(replyTo, lines.join("\n") || "No models configured.");
      return true;
    }

    case "/model": {
      if (!arg) {
        await sendSms(replyTo, `Current: ${getCurrentModel() ?? "default (fallback chain)"}`);
        return true;
      }
      if (arg === "reset") {
        clearSessionModel();
        await sendSms(replyTo, "Model reset to default.");
        return true;
      }
      const models = listModels();
      const match = models.find(m => m.id === arg || m.id.endsWith(`/${arg}`));
      if (!match) {
        await sendSms(replyTo, `Unknown model: ${arg}\nUse /models to list available.`);
        return true;
      }
      const [provider, ...rest] = match.id.split("/");
      setSessionModel(provider, rest.join("/"));
      await sendSms(replyTo, `Model set: ${match.id}${match.vision ? " [vision]" : ""}`);
      return true;
    }

    case "/new":
    case "/reset": {
      await dispatchInboundDirectDmWithRuntime({
        cfg: getConfig(runtime),
        channel: "termux-sms-channel",
        accountId: "default",
        peer: replyTo,
        runtime,
        channelLabel: "SMS",
        conversationLabel: replyTo,
        rawBody: body,
        bodyForAgent: arg || "You are starting a new conversation. Greet the user briefly.",
        commandBody: body,
        commandAuthorized: true,
        senderAddress: getChannelConfig(runtime).myNumber ?? "",
        recipientAddress: replyTo,
        senderId: replyTo,
        messageId: `reset-${Date.now()}`,
        timestamp: new Date(),
        resetSession: true,
        deliver: async (payload) => {
          const text = String(payload?.text ?? "").trim();
          if (text) await sendSms(replyTo, text);
          return {};
        },
      });
      return true;
    }

    default:
      await sendSms(replyTo, `Unknown command: ${cmd}\n${HELP_TEXT}`);
      return true;
  }
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

    const canonicalReplyTo = resolveSecondary(sender, smsCfg);
    if (canonicalReplyTo) {
      const warn = String(smsCfg.secondaryWarning ?? "").trim();
      if (warn) sendSms(sender, warn).catch(() => {});
    } else if (!isAllowed(sender, smsCfg)) {
      const reject = String(smsCfg.rejectMessage ?? "").trim();
      if (reject) sendSms(sender, reject).catch(() => {});
      continue;
    }

    const replyTo    = canonicalReplyTo ?? sender;
    const timestamp  = new Date(typeof msg.date === "number" ? msg.date : Date.now());

    try {
      if (await handleSlashCommand(body, replyTo, runtime)) continue;
    } catch (err) {
      process.stderr.write(`[termux-channel] slash command error: ${err?.message ?? err}\n`);
      continue;
    }

    try {
      await dispatchInboundDirectDmWithRuntime({
        cfg,
        channel: "termux-sms-channel",
        accountId: "default",
        peer: replyTo,
        runtime,
        channelLabel: "SMS",
        conversationLabel: replyTo,
        rawBody: body,
        bodyForAgent: body,
        commandBody: body,
        commandAuthorized: false,
        senderAddress: myNumber,
        recipientAddress: replyTo,
        senderId: sender,
        messageId: String(id),
        timestamp,
        deliver: async (payload) => {
          const text = String(payload?.text ?? "").trim();
          if (text) await sendSms(replyTo, text);
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

const IMAGE_MIME_RE = /^image\//i;

function formatMmsParts(parts) {
  return parts.map(p => {
    const size = p.size ? ` (${(p.size / 1024).toFixed(1)} KB)` : "";
    const path = p.saved_path ? `\n    saved: ${p.saved_path}` : "";
    const text = p.text ? `\n    text: ${p.text.slice(0, 200)}` : "";
    const err  = p.error ? `\n    [file unavailable — may have expired in telephony storage]` : "";
    return `  - ${p.mime}${p.name ? " " + p.name : ""}${size}${path}${text}${err}`;
  }).join("\n");
}

// Builds bodyForAgent and extraContext for an MMS dispatch.
// Image parts are passed via MediaPath/MediaType so openclaw annotates them,
// and bodyForAgent includes an explicit read instruction so vision models
// read the file immediately rather than relying on autonomous tool use.
function buildMmsAgentPayload(mms, parts) {
  const imageParts = parts.filter(p => IMAGE_MIME_RE.test(p.mime ?? "") && p.saved_path);
  const textParts  = parts.filter(p => p.text);
  const otherParts = parts.filter(p => !IMAGE_MIME_RE.test(p.mime ?? "") && !p.text && p.saved_path);

  const lines = [];

  if (imageParts.length > 0) {
    lines.push(`[MMS — ${imageParts.length} image(s) received. Read each file and describe its contents before responding.]`);
    for (const p of imageParts) {
      const size = p.size ? ` (${(p.size / 1024).toFixed(1)} KB)` : "";
      lines.push(`Image: ${p.saved_path}${size}`);
    }
  }

  for (const p of textParts) {
    lines.push(`Text: ${p.text.slice(0, 500)}`);
  }

  for (const p of otherParts) {
    const size = p.size ? ` (${(p.size / 1024).toFixed(1)} KB)` : "";
    lines.push(`Attachment: ${p.saved_path} (${p.mime})${size}`);
  }

  const bodyForAgent = lines.join("\n");

  // Pass first image via extraContext so openclaw adds its standard media annotation
  const extraContext = {};
  if (imageParts.length > 0) {
    extraContext.MediaPath  = imageParts[0].saved_path;
    extraContext.MediaType  = imageParts[0].mime;
    if (imageParts.length > 1) {
      extraContext.MediaPaths = imageParts.map(p => p.saved_path);
      extraContext.MediaTypes = imageParts.map(p => p.mime);
    }
  }

  return { bodyForAgent, extraContext };
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
    const { stdout, stderr } = await execFileP(
      MMS_RECEIVE,
      ["--since", String(state.mmsHighWater), "--limit", "3", "--oldest-first", "--save", mediaDir, "--json"],
      { timeout: 120_000 }
    );
    if (stderr) process.stderr.write(`[termux-channel] mms-receive stderr: ${stderr}\n`);
    messages = JSON.parse(stdout);
  } catch (err) {
    process.stderr.write(`[termux-channel] mms-receive failed: ${err?.message ?? err}\n`);
    return;
  }

  if (!messages.length) return;

  let changed = false;

  for (const mms of messages) {
    if (mms.id > state.mmsHighWater) {
      state.mmsHighWater = mms.id;
      changed = true;
    }

    const sender = String(mms.sender ?? "").trim();
    if (!sender) continue;

    const canonicalReplyTo = resolveSecondary(sender, smsCfg);
    if (canonicalReplyTo) {
      const warn = String(smsCfg.secondaryWarning ?? "").trim();
      if (warn) sendSms(sender, warn).catch(() => {});
    } else if (!isAllowed(sender, smsCfg)) {
      const reject = String(smsCfg.rejectMessage ?? "").trim();
      if (reject) sendSms(sender, reject).catch(() => {});
      continue;
    }

    const replyTo = canonicalReplyTo ?? sender;

    // Fire hook stubs per part (best-effort, non-blocking)
    for (const part of mms.parts) {
      if (part.saved_path && hookScript) {
        runHook(hookScript, part.mime, part.saved_path).catch(() => {});
      }
    }

    const body      = `[MMS received — ${mms.parts.length} part(s)]:\n${formatMmsParts(mms.parts)}`;
    const timestamp = new Date(mms.date * 1000);
    const { bodyForAgent, extraContext } = buildMmsAgentPayload(mms, mms.parts);

    // If MMS has images and the active model isn't vision-capable, automatically
    // switch to the best available vision model for this one turn, then restore.
    const hasImages = mms.parts.some(p => IMAGE_MIME_RE.test(p.mime ?? "") && p.saved_path);
    let autoVisionRestoreModel = undefined; // undefined = no restore needed
    let autoVisionRestoreClear = false;
    if (hasImages) {
      const currentModel = getCurrentModel();
      const allModels = listModels();
      const activeEntry = allModels.find(m => m.id === currentModel);
      if (!activeEntry?.vision) {
        const pick = bestVisionModel();
        if (!pick) {
          await sendSms(replyTo, "Image received but no vision models are configured.");
          continue;
        }
        autoVisionRestoreModel = currentModel;
        autoVisionRestoreClear = !currentModel;
        const [vProv, ...vRest] = pick.id.split("/");
        setSessionModel(vProv, vRest.join("/"));
      }
    }

    try {
      await dispatchInboundDirectDmWithRuntime({
        cfg,
        channel: "termux-sms-channel",
        accountId: "default",
        peer: replyTo,
        runtime,
        channelLabel: "SMS",
        conversationLabel: replyTo,
        rawBody: body,
        bodyForAgent,
        commandBody: body,
        commandAuthorized: false,
        senderAddress: myNumber,
        recipientAddress: replyTo,
        senderId: sender,
        messageId: `mms-${mms.id}`,
        timestamp,
        extraContext,
        deliver: async (payload) => {
          const text = String(payload?.text ?? "").trim();
          if (text) await sendSms(replyTo, text);
          return {};
        },
      });
    } catch (err) {
      process.stderr.write(`[termux-channel] MMS dispatch error ${sender}: ${err?.message ?? err}\n`);
    } finally {
      // Restore model if we temporarily switched for vision
      if (autoVisionRestoreClear) {
        clearSessionModel();
      } else if (autoVisionRestoreModel !== undefined) {
        const [prov, ...rest] = autoVisionRestoreModel.split("/");
        setSessionModel(prov, rest.join("/"));
      }
    }
  }

  if (changed) saveState(state);
}

// ── Polling loop ──────────────────────────────────────────────────────────────

function startPolling(runtime) {
  const cfg        = getConfig(runtime);
  const intervalMs = Number(cfg?.channels?.["termux-sms-channel"]?.pollIntervalMs ?? 5_000);

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
