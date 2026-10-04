import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { dispatchInboundDirectDmWithRuntime } from "openclaw/plugin-sdk/channel-inbound";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
import { join, extname } from "node:path";
import { URL } from "node:url";

const execFileP = promisify(execFile);

// ── Dependency paths ──────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? "/data/data/com.termux/files/home";
// skill-sms-send/skill-mms-send/skill-mms-receive are deprecated and
// archived -- consolidated into woodmanlegion/termux-sms. Sending goes
// through termux-sms-send (the package's message-manager entrypoint,
// _termux_sms_lib.py's send_sms/send_mms) so outbound attempts get
// logged in one place instead of this plugin duplicating that
// bookkeeping itself.
//
// As of 2026-10-04: receiving is the same story. This plugin no longer
// polls the SIM itself at all -- termux-sms-poll (also in termux-sms) is
// the one and only poller, and this plugin is a *consumer*, triggered by
// a tiny handler script (termux-sms-channel's own bin/termux-sms-channel-
// handler, registered into ~/.config/termux-sms/handlers.d/ by `tclaw
// sms-channel install`) that POSTs each new message to the webhook route
// registered below. That's why there's no MMS_RECEIVE constant here
// anymore -- this plugin never calls mms-receive directly; termux-sms-
// poll already did, and handed us the already-fetched result.
const TERMUX_SMS_SEND = `${HOME}/.local/bin/termux-sms-send`;

const SESSIONS_FILE   = `${HOME}/.openclaw/agents/main/sessions/sessions.json`;
const OPENCLAW_CONFIG = `${HOME}/.openclaw/openclaw.json`;

const VIEWER_HTML = join(
  HOME,
  ".openclaw/workspace/skills/termux-sms-channel/eavesdrop/viewer.html"
);

const MIME_MAP = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4",
};

// ── Dependency check ──────────────────────────────────────────────────────────

function checkDependencies() {
  const deps = [
    [TERMUX_SMS_SEND, "termux-sms-send (termux-sms)", "https://github.com/woodmanlegion/termux-sms"],
  ];
  const missing = deps.filter(([path]) => !existsSync(path));
  if (missing.length > 0) {
    for (const [path, name, url] of missing)
      process.stderr.write(`[termux-channel] MISSING: ${name} not found at ${path} — install: ${url}\n`);
    throw new Error(`[termux-channel] missing: ${missing.map(([, n]) => n).join(", ")}`);
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

function bestVisionModel() {
  const models = listModels();
  return models.find(m => m.vision && !m.reasoning) ?? models.find(m => m.vision) ?? null;
}

function getCurrentModel() {
  try {
    const sessions = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    const sess = sessions["agent:main:termux-sms-channel:default:direct:+15550003333"]
               ?? sessions["agent:main:main"]
               ?? {};
    if (sess.providerOverride && sess.modelOverride)
      return `${sess.providerOverride}/${sess.modelOverride}`;
    return null;
  } catch { return null; }
}

function getSessionId() {
  try {
    const sessions = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    const sess = sessions["agent:main:termux-sms-channel:default:direct:+15550003333"] ?? {};
    return sess.sessionId ?? null;
  } catch { return null; }
}

function setSessionModel(providerOverride, modelOverride) {
  try {
    const sessions = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    const key = "agent:main:termux-sms-channel:default:direct:+15550003333";
    const sess = sessions[key] ?? {};
    sess.providerOverride      = providerOverride;
    sess.modelOverride         = modelOverride;
    sess.modelOverrideSource   = "user";
    sess.updatedAt             = Date.now();
    sessions[key] = sess;
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    throw new Error(`could not write sessions.json: ${err?.message}`);
  }
}

function clearSessionModel() {
  try {
    const sessions = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    const key = "agent:main:termux-sms-channel:default:direct:+15550003333";
    const sess = sessions[key] ?? {};
    delete sess.providerOverride;
    delete sess.modelOverride;
    delete sess.modelOverrideSource;
    sess.updatedAt = Date.now();
    sessions[key] = sess;
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    throw new Error(`could not write sessions.json: ${err?.message}`);
  }
}

// ── SSE broadcast ─────────────────────────────────────────────────────────────

const sseClients = new Set();

function ssePublish(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

function logEntry(entry) {
  ssePublish("message", {
    ...entry,
    model:     getCurrentModel() ?? "(default)",
    sessionId: getSessionId(),
    timestamp: entry.timestamp ?? new Date().toISOString(),
  });
}

// ── Runtime store ─────────────────────────────────────────────────────────────

const { setRuntime } = createPluginRuntimeStore({
  pluginId: "termux-sms-channel",
  errorMessage: "SMS/MMS runtime not initialized",
});

// ── Shared helpers ────────────────────────────────────────────────────────────

function isAllowed(sender, smsConfig) {
  if (!smsConfig.allowFrom) return true;
  const allowed = String(smsConfig.allowFrom).split(",").map(s => s.trim()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(sender);
}

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

async function sendSms(to, text, tag) {
  // Pass-through to the message manager, per plan -- not reimplemented
  // here. termux-sms-send logs the outbound attempt itself (success or
  // failure) before this ever returns. tag (e.g. "slash") is forwarded
  // so messages.jsonl can distinguish a deterministic slash reply from
  // an ordinary agent-dispatched one, without this plugin touching the
  // log file directly.
  const args = tag ? ["sms", to, text, "--tag", tag] : ["sms", to, text];
  await execFileP(TERMUX_SMS_SEND, args, { timeout: 30_000 });
}

async function sendMms(to, filePath) {
  await execFileP(TERMUX_SMS_SEND, ["mms", to, filePath], { timeout: 60_000 });
}

// ── Pending slash notes (surfaced to the agent at its next real turn) ───────
// Slash commands are handled deterministically and never reach the agent --
// so without this, the agent has no idea e.g. /model was just switched.
// Queued here, drained into a "note but ignore" header on the next actual
// dispatch (SMS or MMS). /new and /reset are deliberately excluded: they
// already force a fresh session, so there is nothing stale left to report
// past that point -- queued notes are cleared outright when one fires.

let pendingSlashNotes = [];

function notePendingSlash(body) {
  pendingSlashNotes.push(body);
}

function clearPendingSlash() {
  pendingSlashNotes = [];
}

function drainPendingSlashNotes() {
  if (pendingSlashNotes.length === 0) return "";
  // First version of this used a "**note but ignore**" line per command,
  // which backfired live: the model treated it as something to react to
  // rather than skip, and -- since it had no record of handling these
  // itself -- guessed they must have failed and said so, unprompted,
  // wrongly. Naming plainly that they already ran and already got a
  // reply (so there's nothing left to do) is what actually worked.
  const commands = pendingSlashNotes.join(", ");
  pendingSlashNotes = [];
  return `[Context: ${commands} ran since your last turn -- handled directly, already replied to. Not part of this message; no action needed.]\n\n`;
}

// ── Deterministic slash commands ──────────────────────────────────────────────

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
  const cmdLower = cmd.toLowerCase();

  if (cmdLower !== "/new" && cmdLower !== "/reset") {
    notePendingSlash(body);
  }

  // Log the slash command before handling; reply is filled in below
  const slashEntry = {
    type: "slash",
    command: body,
    sender: replyTo,
    reply: null,
    timestamp: new Date().toISOString(),
  };

  const reply = async (text) => {
    slashEntry.reply = text;
    logEntry(slashEntry);
    await sendSms(replyTo, text, "slash");
  };

  switch (cmdLower) {
    case "/status": {
      const cfg     = getConfig(runtime);
      const smsCfg  = getChannelConfig(runtime);
      const model   = getCurrentModel() ?? cfg?.agents?.defaults?.model?.fallbacks?.[0] ?? "unknown";
      const myNum   = smsCfg.myNumber ?? "?";
      await reply(`edge-android-25 online\nmodel: ${model}\nSMS: ${myNum}\nchannel: ok`);
      return true;
    }

    case "/help":
      await reply(HELP_TEXT);
      return true;

    case "/models": {
      const models  = listModels();
      const current = getCurrentModel();
      const lines   = models.map(m => {
        const tag = m.vision ? " [vision]" : "";
        const cur = m.id === current ? " *" : "";
        return `${m.id}${tag}${cur}`;
      });
      await reply(lines.join("\n") || "No models configured.");
      return true;
    }

    case "/model": {
      if (!arg) {
        await reply(`Current: ${getCurrentModel() ?? "default (fallback chain)"}`);
        return true;
      }
      if (arg === "reset") {
        clearSessionModel();
        await reply("Model reset to default.");
        return true;
      }
      const models = listModels();
      const match  = models.find(m => m.id === arg || m.id.endsWith(`/${arg}`));
      if (!match) {
        await reply(`Unknown model: ${arg}\nUse /models to list available.`);
        return true;
      }
      const [provider, ...mrest] = match.id.split("/");
      setSessionModel(provider, mrest.join("/"));
      await reply(`Model set: ${match.id}${match.vision ? " [vision]" : ""}`);
      return true;
    }

    case "/new":
    case "/reset": {
      // Starting fresh makes any notes queued before this moot.
      clearPendingSlash();

      // Log session reset divider before dispatching
      logEntry({
        type:      "reset",
        command:   body,
        timestamp: new Date().toISOString(),
      });
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
          if (text) {
            logEntry({ type: "outbound", text, timestamp: new Date().toISOString() });
            await sendSms(replyTo, text, "slash");
          }
          return {};
        },
      });
      return true;
    }

    default:
      await reply(`Unknown command: ${cmd}\n${HELP_TEXT}`);
      return true;
  }
}

// ── SMS inbound (consumer -- termux-sms-poll already fetched this) ──────────

async function processSmsMessage(msg, runtime) {
  const cfg      = getConfig(runtime);
  const smsCfg   = getChannelConfig(runtime);
  const myNumber = String(smsCfg.myNumber ?? "").trim();

  const id     = msg.id;
  const sender = String(msg.sender ?? "").trim();
  const body   = String(msg.body ?? "").trim();
  if (!sender || !body) return;

  const canonicalReplyTo = resolveSecondary(sender, smsCfg);
  if (canonicalReplyTo) {
    const warn = String(smsCfg.secondaryWarning ?? "").trim();
    if (warn) sendSms(sender, warn).catch(() => {});
  } else if (!isAllowed(sender, smsCfg)) {
    const reject = String(smsCfg.rejectMessage ?? "").trim();
    if (reject) sendSms(sender, reject).catch(() => {});
    return;
  }

  const replyTo = canonicalReplyTo ?? sender;
  const parsedDate = new Date(msg.date);
  const timestamp  = Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString();

  logEntry({ type: "inbound", sender, text: body, timestamp });

  try {
    if (await handleSlashCommand(body, replyTo, runtime)) return;
  } catch (err) {
    process.stderr.write(`[termux-channel] slash command error: ${err?.message ?? err}\n`);
    return;
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
      bodyForAgent: drainPendingSlashNotes() + body,
      commandBody: body,
      commandAuthorized: false,
      senderAddress: myNumber,
      recipientAddress: replyTo,
      senderId: sender,
      messageId: String(id),
      timestamp: new Date(timestamp),
      deliver: async (payload) => {
        const text = String(payload?.text ?? "").trim();
        if (text) {
          logEntry({ type: "outbound", text, timestamp: new Date().toISOString() });
          await sendSms(replyTo, text);
        }
        return {};
      },
    });
  } catch (err) {
    process.stderr.write(`[termux-channel] SMS dispatch error ${sender}: ${err?.message ?? err}\n`);
  }
}

// ── MMS inbound (consumer -- termux-sms-poll already fetched + saved parts) ──

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

  for (const p of textParts) lines.push(`Text: ${p.text.slice(0, 500)}`);
  for (const p of otherParts) {
    const size = p.size ? ` (${(p.size / 1024).toFixed(1)} KB)` : "";
    lines.push(`Attachment: ${p.saved_path} (${p.mime})${size}`);
  }

  const bodyForAgent = lines.join("\n");

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

async function processMmsMessage(mms, runtime) {
  const smsCfg     = getChannelConfig(runtime);
  const cfg        = getConfig(runtime);
  const myNumber   = String(smsCfg.myNumber ?? "").trim();
  // mediaDir is no longer read here -- termux-sms-poll already fetched
  // and saved these parts using ~/.config/termux-sms/config's own
  // SAVE_DIR before this ever runs. channels.termux-sms-channel.mediaDir
  // is superseded; left in the config schema for now, just unused.
  const hookScript = smsCfg.hookScript || null;

  const sender = String(mms.sender ?? "").trim();
  if (!sender) return;

  const canonicalReplyTo = resolveSecondary(sender, smsCfg);
  if (canonicalReplyTo) {
    const warn = String(smsCfg.secondaryWarning ?? "").trim();
    if (warn) sendSms(sender, warn).catch(() => {});
  } else if (!isAllowed(sender, smsCfg)) {
    const reject = String(smsCfg.rejectMessage ?? "").trim();
    if (reject) sendSms(sender, reject).catch(() => {});
    return;
  }

  const replyTo   = canonicalReplyTo ?? sender;
  const timestamp = new Date(mms.date * 1000).toISOString();

  for (const part of mms.parts) {
    if (part.saved_path && hookScript) {
      runHook(hookScript, part.mime, part.saved_path).catch(() => {});
    }
  }

  const imageParts = mms.parts.filter(p => IMAGE_MIME_RE.test(p.mime ?? "") && p.saved_path);
  const textParts  = mms.parts.filter(p => p.text);
  logEntry({
    type:      "inbound",
    sender,
    text:      textParts.map(p => p.text).join("\n") || null,
    images:    imageParts.map(p => ({ path: p.saved_path, mime: p.mime })),
    timestamp,
  });

  const body      = `[MMS received — ${mms.parts.length} part(s)]:\n${formatMmsParts(mms.parts)}`;
  const { bodyForAgent: mmsBodyForAgent, extraContext } = buildMmsAgentPayload(mms, mms.parts);
  const bodyForAgent = drainPendingSlashNotes() + mmsBodyForAgent;

  const hasImages = mms.parts.some(p => IMAGE_MIME_RE.test(p.mime ?? "") && p.saved_path);
  if (hasImages) {
    const currentModel = getCurrentModel();
    const allModels    = listModels();
    const activeEntry  = allModels.find(m => m.id === currentModel);
    if (!activeEntry?.vision) {
      const pick = bestVisionModel();
      if (!pick) {
        await sendSms(replyTo, "Image received but no vision models are configured.");
        return;
      }
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
      timestamp: new Date(timestamp),
      extraContext,
      deliver: async (payload) => {
        const text = String(payload?.text ?? "").trim();
        if (text) {
          logEntry({ type: "outbound", text, timestamp: new Date().toISOString() });
          await sendSms(replyTo, text);
        }
        return {};
      },
    });
  } catch (err) {
    process.stderr.write(`[termux-channel] MMS dispatch error ${sender}: ${err?.message ?? err}\n`);
  }
}

// ── Inbound webhook (termux-sms-poll's handler forwards here) ───────────────
// Replaces the old self-polling setInterval entirely. termux-sms-poll is
// the one and only thing that polls the SIM now; this route just
// receives what it already found. Responds immediately (202) and
// processes fire-and-forget, rather than awaiting a full agent turn
// inside the HTTP response -- that keeps the calling handler script's
// own curl well inside termux-sms-poll's 30s per-handler timeout
// regardless of how long the actual model response takes.

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function registerInboundWebhookRoute(runtime) {
  registerPluginHttpRoute({
    pluginId: "termux-sms-channel",
    path:     "/termux-sms-channel/inbound",
    auth:     "none",
    handler:  (req, res) => {
      if (req.method !== "POST") return false;
      readRequestBody(req)
        .then((raw) => {
          let kind, message;
          try {
            ({ kind, message } = JSON.parse(raw));
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `bad json: ${err?.message}` }));
            return;
          }
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));

          if (kind === "sms") {
            processSmsMessage(message, runtime).catch((err) =>
              process.stderr.write(`[termux-channel] inbound SMS processing error: ${err?.message}\n`)
            );
          } else if (kind === "mms") {
            processMmsMessage(message, runtime).catch((err) =>
              process.stderr.write(`[termux-channel] inbound MMS processing error: ${err?.message}\n`)
            );
          } else {
            process.stderr.write(`[termux-channel] inbound webhook: unknown kind "${kind}"\n`);
          }
        })
        .catch((err) => {
          process.stderr.write(`[termux-channel] inbound webhook error: ${err?.message}\n`);
          try { res.writeHead(500); res.end("error"); } catch {}
        });
      return true;
    },
  });
  process.stderr.write("[termux-channel] inbound webhook registered at /termux-sms-channel/inbound\n");
}

// ── Eavesdrop HTTP routes ─────────────────────────────────────────────────────

function registerEavesdropRoutes() {
  // GET /eavesdrop — serve the HTML viewer
  registerPluginHttpRoute({
    pluginId: "termux-sms-channel",
    path:     "/eavesdrop",
    auth:     "none",
    handler:  (req, res) => {
      if (req.method !== "GET") return false;
      try {
        const html = readFileSync(VIEWER_HTML, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch {
        res.writeHead(404);
        res.end("viewer.html not found");
      }
      return true;
    },
  });

  // GET /eavesdrop/events — SSE stream
  registerPluginHttpRoute({
    pluginId: "termux-sms-channel",
    path:     "/eavesdrop/events",
    auth:     "none",
    handler:  (req, res) => {
      if (req.method !== "GET") return false;
      res.writeHead(200, {
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
      });

      // Send current meta on connect
      const meta = JSON.stringify({ model: getCurrentModel() ?? "(default)", sessionId: getSessionId() });
      res.write(`event: meta\ndata: ${meta}\n\n`);

      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return true;
    },
  });

  // GET /eavesdrop/media?path=... — serve local media files
  registerPluginHttpRoute({
    pluginId: "termux-sms-channel",
    path:     "/eavesdrop/media",
    auth:     "none",
    handler:  (req, res) => {
      if (req.method !== "GET") return false;
      // req.url may be a full path or just query string depending on gateway prefix stripping
      const m    = (req.url ?? "").match(/[?&]path=([^&]*)/);
      const file = m ? decodeURIComponent(m[1]) : null;
      if (!file || !existsSync(file)) {
        res.writeHead(404);
        res.end("not found");
        return true;
      }
      const mime = MIME_MAP[extname(file).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime });
      createReadStream(file).pipe(res);
      return true;
    },
  });

  process.stderr.write("[termux-channel] eavesdrop routes registered at /eavesdrop\n");
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function setSmsRuntime(runtime) {
  try {
    process.stderr.write("[termux-channel] setSmsRuntime called\n");
    checkDependencies();
    setRuntime(runtime);
    registerEavesdropRoutes();
    registerInboundWebhookRoute(runtime);
  } catch (err) {
    process.stderr.write(`[termux-channel] ERROR in setSmsRuntime: ${err?.message}\n`);
    throw err;
  }
}
