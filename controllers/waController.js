// controllers/waController.js
import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";
import axios from "axios";
import User from "../models/User.js";
import Log from "../models/Log.js";

/**
 * WA Controller - Full features
 *
 * Mount this router under /api/wa (recommended) and protect routes with verifyApiKey
 * Except /qr-stream which can accept ?apiKey=... without auth for EventSource clients.
 */

/* ----------------------------
   Internal state
   ---------------------------- */
const sessions = {};      // apiKey -> socket
const reconnecting = {};  // apiKey -> boolean
const sseClients = new Map(); // apiKey -> Set(res) for SSE

/* ----------------------------
   Helpers
   ---------------------------- */
async function saveLog(userId, event, meta = {}) {
  try {
    await Log.create({ userId, event, meta });
  } catch (err) {
    console.error("saveLog error:", err);
  }
}

function sendSSE(apiKey, eventName, data) {
  const clients = sseClients.get(apiKey);
  if (!clients) return;
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  for (const res of clients) {
    try {
      res.write(`event: ${eventName}\n`);
      res.write(`data: ${payload}\n\n`);
    } catch (err) {
      // ignore
    }
  }
}

async function qrStringToDataUrl(qrString) {
  try {
    const dataUrl = await qrcode.toDataURL(qrString, { errorCorrectionLevel: "M", type: "image/png" });
    return dataUrl;
  } catch (err) {
    return `data:text/plain;base64,${Buffer.from(qrString).toString("base64")}`;
  }
}

function ensureSessionDir(apiKey) {
  const sessionPath = path.join("baileys", "sessions", apiKey);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
  return sessionPath;
}

/* ----------------------------
   Create or reuse socket for a user
   ---------------------------- */
export async function createSocketForUser(user) {
  const apiKey = user.apiKey;
  if (sessions[apiKey]) return sessions[apiKey];

  ensureSessionDir(apiKey);

  // fetch latest Baileys version (best-effort)
  let versionInfo;
  try { versionInfo = await fetchLatestBaileysVersion(); } catch (e) { versionInfo = { version: undefined }; }

  // create auth state
  const { state, saveCreds } = await useMultiFileAuthState(path.join("baileys", "sessions", apiKey));

  const sock = makeWASocket({
    auth: state,
    version: versionInfo.version,
    printQRInTerminal: false
  });

  sessions[apiKey] = sock;

  // connection.update handler
  sock.ev.on("connection.update", async (update) => {
    try {
      await saveLog(user.id, "connection_update", update);

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const dataUrl = await qrStringToDataUrl(qr);
        await saveLog(user.id, "qr_generated", { ts: new Date().toISOString() });
        sendSSE(apiKey, "qr", { qrDataUrl: dataUrl, ts: new Date().toISOString() });
      }

      if (connection === "open") {
        sendSSE(apiKey, "connected", { ts: new Date().toISOString() });
        await saveLog(user.id, "connection_open", {});
        sendSSE(apiKey, "qr_cleared", {});
      }

      if (connection === "close") {
        await saveLog(user.id, "connection_close", { lastDisconnect });
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          // logged out -> remove session files and socket
          await saveLog(user.id, "logged_out", {});
          try {
            if (sessions[apiKey]) {
              await sessions[apiKey].logout().catch(()=>{});
              delete sessions[apiKey];
            }
            const sessDir = path.join("baileys", "sessions", apiKey);
            fs.rmSync(sessDir, { recursive: true, force: true });
          } catch (e) { console.error("cleanup error:", e); }
          sendSSE(apiKey, "logged_out", {});
        } else {
          // try reconnect
          if (!reconnecting[apiKey]) {
            reconnecting[apiKey] = true;
            setTimeout(async () => {
              try {
                const freshUser = await User.findOne({ where: { apiKey } });
                if (freshUser) await createSocketForUser(freshUser);
              } catch (e) {
                console.error("reconnect err:", e);
              } finally {
                reconnecting[apiKey] = false;
              }
            }, 3000);
          }
        }
      }
    } catch (err) {
      console.error("connection.update handler err:", err);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // incoming messages
  sock.ev.on("messages.upsert", async (m) => {
    try {
      await saveLog(user.id, "message_in", m);
      // push to SSE clients
      sendSSE(apiKey, "message", { event: m });
      // auto-read receipts for notify type
      if (m.type === "notify") {
        const messages = m.messages || [];
        for (const msg of messages) {
          if (!msg.key || msg.key.remoteJid === "status@broadcast") continue;
          try {
            await sock.sendReadReceipt(msg.key.remoteJid, msg.key.participant ?? msg.key.remoteJid, [msg.key.id]);
          } catch {}
        }
      }
    } catch (err) {
      console.error("messages.upsert err:", err);
    }
  });

  // other events -> log
  sock.ev.on("presence.update", (p) => saveLog(user.id, "presence_update", p).catch(()=>{}));
  sock.ev.on("chats.set", (c) => saveLog(user.id, "chats_set", c).catch(()=>{}));
  sock.ev.on("groups.update", (g) => saveLog(user.id, "groups_update", g).catch(()=>{}));
  sock.ev.on("group-participants.update", (u) => saveLog(user.id, "group_participants_update", u).catch(()=>{}));

  return sock;
}

/* ----------------------------
   Router & handlers
   ---------------------------- */
const router = express.Router();

/**
 * SSE endpoint: GET /qr-stream?apiKey=...
 * - Accepts query param apiKey for EventSource (browsers cannot send headers)
 * - Also accepts if route mounted with verifyApiKey middleware (then uses req.user)
 */
router.get("/qr-stream", async (req, res) => {
  try {
    // allow either ?apiKey= or header-provided req.user (if middleware used)
    const apiKey = req.query.apiKey || (req.user && req.user.apiKey) || req.headers["x-api-key"];
    if (!apiKey) return res.status(401).json({ error: "apiKey query param or x-api-key required" });

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    if (!sseClients.has(apiKey)) sseClients.set(apiKey, new Set());
    sseClients.get(apiKey).add(res);

    // heartbeat to keep connection alive
    const ping = setInterval(() => {
      try { res.write(":\n\n"); } catch (e) {}
    }, 25000);

    // remove on close
    req.on("close", () => {
      clearInterval(ping);
      const setClients = sseClients.get(apiKey);
      if (setClients) {
        setClients.delete(res);
        if (setClients.size === 0) sseClients.delete(apiKey);
      }
    });

    // initial ack
    res.write(`event: connected\n`);
    res.write(`data: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
  } catch (err) {
    console.error("qr-stream err:", err);
    try { res.status(500).json({ error: err.message }); } catch {}
  }
});

/**
 * POST /connect
 * Protected: expects req.user (verifyApiKey middleware)
 * -> starts socket (non-blocking). QR will be delivered via SSE if client connected.
 */
router.post("/connect", async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    // reload full user instance if req.user contains only id/apiKey
    const fullUser = await User.findByPk(user.id);
    await createSocketForUser(fullUser);
    res.json({ success: true, message: "Socket initiating. Subscribe to /qr-stream to receive QR & events." });
  } catch (err) {
    console.error("connect err:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /status
 */
router.get("/status", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    const connected = !!sock && sock?.ws?.readyState === 1;
    res.json({ connected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /send-text
 * body: { to, text }
 */
router.post("/send-text", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const { to, text } = req.body;
    if (!to || !text) return res.status(400).json({ error: "to & text required" });

    const result = await sock.sendMessage(to, { text });
    await saveLog(req.user.id, "message_out_text", { to, text });
    res.json({ success: true, result });
  } catch (err) {
    console.error("send-text err:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /send-media
 * body: { to, url (optional), base64 (optional), filename (optional), caption (optional) }
 */
router.post("/send-media", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const { to, url, base64, filename = "file", caption } = req.body;
    if (!to) return res.status(400).json({ error: "to required" });

    let buffer;
    if (url) {
      const resp = await axios.get(url, { responseType: "arraybuffer" });
      buffer = Buffer.from(resp.data);
    } else if (base64) {
      buffer = Buffer.from(base64, "base64");
    } else {
      return res.status(400).json({ error: "url or base64 required" });
    }

    const ext = path.extname(filename).toLowerCase();
    let message = {};
    if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
      message = { image: buffer, caption };
    } else if ([".mp4", ".mkv", ".mov"].includes(ext)) {
      message = { video: buffer, caption, mimetype: "video/mp4" };
    } else if ([".mp3", ".wav", ".ogg"].includes(ext)) {
      message = { audio: buffer };
    } else {
      message = { document: buffer, fileName: filename, mimetype: "application/octet-stream", caption };
    }

    const result = await sock.sendMessage(to, message);
    await saveLog(req.user.id, "message_out_media", { to, filename, caption });
    res.json({ success: true, result });
  } catch (err) {
    console.error("send-media err:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /send-buttons
 * body: { to, text, footer, buttons }
 */
router.post("/send-buttons", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const { to, text, footer = "", buttons } = req.body;
    if (!to || !text || !buttons) return res.status(400).json({ error: "to, text, buttons required" });

    const msg = { text, footer, buttons };
    const result = await sock.sendMessage(to, msg);
    await saveLog(req.user.id, "message_out_buttons", { to, text, buttons });
    res.json({ success: true, result });
  } catch (err) {
    console.error("send-buttons err:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /send-template
 * body: { to, text, footer, hydratedButtons }
 */
router.post("/send-template", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const { to, text, footer = "", hydratedButtons } = req.body;
    if (!to || !text) return res.status(400).json({ error: "to & text required" });

    const message = { text, footer, templateButtons: hydratedButtons };
    const result = await sock.sendMessage(to, message);
    await saveLog(req.user.id, "message_out_template", { to, text });
    res.json({ success: true, result });
  } catch (err) {
    console.error("send-template err:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /broadcast
 * body: { numbers: ["628xx@s.whatsapp.net", ...], message }
 */
router.post("/broadcast", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const { numbers, message } = req.body;
    if (!Array.isArray(numbers) || !message) return res.status(400).json({ error: "numbers array & message required" });

    const results = [];
    for (const to of numbers) {
      const r = await sock.sendMessage(to, { text: message });
      results.push({ to, r });
      await saveLog(req.user.id, "broadcast_out", { to });
    }
    res.json({ success: true, results });
  } catch (err) {
    console.error("broadcast err:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /chats
 */
router.get("/chats", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });
    const chats = sock.chats || [];
    res.json({ chats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /messages?jid=&count=
 */
router.get("/messages", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const jid = req.query.jid;
    const count = parseInt(req.query.count || "20");
    if (!jid) return res.status(400).json({ error: "jid required" });

    if (typeof sock.fetchMessages === "function") {
      const msgs = await sock.fetchMessages(jid, count);
      res.json({ messages: msgs });
    } else {
      res.json({ messages: [] });
    }
  } catch (err) {
    console.error("messages err:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /mark-read
 * body: { jid, messageId }
 */
router.post("/mark-read", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const { jid, messageId } = req.body;
    if (!jid || !messageId) return res.status(400).json({ error: "jid & messageId required" });

    await sock.sendReadReceipt(jid, jid, [messageId]);
    await saveLog(req.user.id, "mark_read", { jid, messageId });
    res.json({ success: true });
  } catch (err) {
    console.error("mark-read err:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /presence  body: { to, presence }
 */
router.post("/presence", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const { to, presence: p } = req.body;
    if (!to || !p) return res.status(400).json({ error: "to & presence required" });

    await sock.sendPresenceUpdate(p, to);
    await saveLog(req.user.id, "presence_update_sent", { to, p });
    res.json({ success: true });
  } catch (err) {
    console.error("presence err:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /block  /unblock  body: { jid }
 */
router.post("/block", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    const { jid } = req.body;
    if (!sock) return res.status(400).json({ error: "Session not connected" });
    if (!jid) return res.status(400).json({ error: "jid required" });

    await sock.updateBlockStatus(jid, "block");
    await saveLog(req.user.id, "block", { jid });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/unblock", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    const { jid } = req.body;
    if (!sock) return res.status(400).json({ error: "Session not connected" });
    if (!jid) return res.status(400).json({ error: "jid required" });

    await sock.updateBlockStatus(jid, "unblock");
    await saveLog(req.user.id, "unblock", { jid });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Group operations
 */
router.post("/group-create", async (req, res) => {
  try {
    const { subject, participants } = req.body;
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });
    if (!subject || !participants) return res.status(400).json({ error: "subject & participants required" });

    const result = await sock.groupCreate(subject, participants);
    await saveLog(req.user.id, "group_create", { subject, participants });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/group-add", async (req, res) => {
  try {
    const { groupId, participants } = req.body;
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });
    if (!groupId || !participants) return res.status(400).json({ error: "groupId & participants required" });

    const result = await sock.groupAdd(groupId, participants);
    await saveLog(req.user.id, "group_add", { groupId, participants });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/group-remove", async (req, res) => {
  try {
    const { groupId, participant } = req.body;
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });
    if (!groupId || !participant) return res.status(400).json({ error: "groupId & participant required" });

    const result = await sock.groupRemove(groupId, [participant]);
    await saveLog(req.user.id, "group_remove", { groupId, participant });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/group-promote", async (req, res) => {
  try {
    const { groupId, participant } = req.body;
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });
    if (!groupId || !participant) return res.status(400).json({ error: "groupId & participant required" });

    const result = await sock.groupMakeAdmin(groupId, [participant]);
    await saveLog(req.user.id, "group_promote", { groupId, participant });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/group-demote", async (req, res) => {
  try {
    const { groupId, participant } = req.body;
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });
    if (!groupId || !participant) return res.status(400).json({ error: "groupId & participant required" });

    const result = await sock.groupDemoteAdmin(groupId, [participant]);
    await saveLog(req.user.id, "group_demote", { groupId, participant });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /contacts
 */
router.get("/contacts", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });
    res.json({ contacts: sock.contacts || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /download-media
 * body: { message } - full message object
 */
router.post("/download-media", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });

    const buffer = await sock.downloadMediaMessage(message, "buffer");
    const mediaType = Object.keys(message.message || {}).find(k => k.includes("Message")) || "media";
    const fileName = `${Date.now()}_${mediaType.replace("Message","")}`;
    if (!fs.existsSync("downloads")) fs.mkdirSync("downloads", { recursive: true });
    const filePath = path.join("downloads", fileName);
    fs.writeFileSync(filePath, buffer);
    await saveLog(req.user.id, "media_download", { filePath });
    res.json({ success: true, filePath });
  } catch (err) {
    console.error("download-media err:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /profile-update
 * body: { name }
 */
router.post("/profile-update", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });

    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    await sock.updateProfileName(name).catch(()=>null);
    await saveLog(req.user.id, "profile_update", { name });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /profile-picture
 * body: { base64 } (image base64)
 */
router.post("/profile-picture", async (req, res) => {
  try {
    const { base64 } = req.body;
    if (!base64) return res.status(400).json({ error: "base64 required" });

    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const buffer = Buffer.from(base64, "base64");
    try { await sock.updateProfilePicture(req.user.apiKey + "@s.whatsapp.net", buffer); } catch {}
    await saveLog(req.user.id, "profile_picture_update", {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /logout
 */
router.post("/logout", async (req, res) => {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (sock) {
      try { await sock.logout(); } catch {}
      delete sessions[apiKey];
    }
    const sessDir = path.join("baileys", "sessions", apiKey);
    try { fs.rmSync(sessDir, { recursive: true, force: true }); } catch {}
    sendSSE(apiKey, "logged_out", {});
    await saveLog(req.user.id, "logout", {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ----------------------------
   Export router and helpers
   ---------------------------- */
export default router;
