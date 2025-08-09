// controllers/waController.js
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";
import axios from "axios";
import Log from "../models/Log.js";
import User from "../models/User.js";

/**
 * WA Controller - full features
 *
 * - Sessions kept in ./baileys/sessions/{apiKey}
 * - QR pushed to frontend via Server-Sent Events (SSE) on /wa/qr-stream
 * - All important events logged to Log model
 */

/* ----------------------------
   Internal state
   ---------------------------- */
const sessions = {};      // apiKey -> socket
const reconnecting = {};  // apiKey -> boolean
const sseClients = new Map(); // apiKey -> Set of res (SSE response objects)

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
      // ignore broken clients
    }
  }
}

/* Convert QR string to PNG dataURL using 'qrcode' lib */
async function qrStringToDataUrl(qrString) {
  try {
    const dataUrl = await qrcode.toDataURL(qrString, { errorCorrectionLevel: "M", type: "image/png" });
    return dataUrl;
  } catch (err) {
    // fallback: return raw base64 of string (less useful)
    return `data:text/plain;base64,${Buffer.from(qrString).toString("base64")}`;
  }
}

/* Ensure session dir exists */
function ensureSessionDir(apiKey) {
  const sessionPath = path.join("baileys", "sessions", apiKey);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
  return sessionPath;
}

/* Create or reuse socket for `user` */
export async function createSocketForUser(user) {
  const apiKey = user.apiKey;
  if (sessions[apiKey]) return sessions[apiKey];

  ensureSessionDir(apiKey);

  // get latest baileys version
  let versionInfo;
  try {
    versionInfo = await fetchLatestBaileysVersion();
  } catch (err) {
    versionInfo = { version: undefined, isLatest: false };
  }

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
        // convert to PNG dataUrl and send to SSE clients
        const dataUrl = await qrStringToDataUrl(qr);
        // store minimal info to logs and push to client
        await saveLog(user.id, "qr_generated", { ts: new Date().toISOString() });
        sendSSE(apiKey, "qr", { qrDataUrl: dataUrl, ts: new Date().toISOString() });
      }

      if (connection === "open") {
        sendSSE(apiKey, "connected", { ts: new Date().toISOString() });
        await saveLog(user.id, "connection_open", {});
        // cleanup any old qr SSE payloads for fresh start
        sendSSE(apiKey, "qr_cleared", {});
      }

      if (connection === "close") {
        await saveLog(user.id, "connection_close", { lastDisconnect });
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          // logged out -> cleanup session files and socket
          await saveLog(user.id, "logged_out", {});
          try {
            if (sessions[apiKey]) {
              await sessions[apiKey].logout().catch(() => {});
              delete sessions[apiKey];
            }
            const sessDir = path.join("baileys", "sessions", apiKey);
            fs.rmSync(sessDir, { recursive: true, force: true });
          } catch (e) {
            console.error("cleanup error:", e);
          }
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
                console.error("reconnect attempt failed", e);
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

  // Save creds
  sock.ev.on("creds.update", saveCreds);

  // messages.upsert handler
  sock.ev.on("messages.upsert", async (m) => {
    try {
      await saveLog(user.id, "message_in", m);
      // auto-mark read (optional behavior)
      if (m.type === "notify") {
        const msgs = m.messages || [];
        for (const msg of msgs) {
          if (!msg.key || msg.key.remoteJid === "status@broadcast") continue;
          try {
            await sock.sendReadReceipt(msg.key.remoteJid, msg.key.participant ?? msg.key.remoteJid, [msg.key.id]);
          } catch (e) { /* ignore */ }
        }
      }
      // push incoming to SSE too
      sendSSE(apiKey, "message", { event: m });
    } catch (err) {
      console.error("messages.upsert err:", err);
    }
  });

  // other events logging
  sock.ev.on("presence.update", (p) => saveLog(user.id, "presence_update", p).catch(()=>{}));
  sock.ev.on("chats.set", (c) => saveLog(user.id, "chats_set", c).catch(()=>{}));
  sock.ev.on("groups.update", (g) => saveLog(user.id, "groups_update", g).catch(()=>{}));
  sock.ev.on("group-participants.update", (u) => saveLog(user.id, "group_participants_update", u).catch(()=>{}));

  return sock;
}

/* ----------------------------
   SSE endpoint: /wa/qr-stream
   - Client must set header x-api-key or query ?apiKey=
   - Keep connection open, send events:
     event: qr -> { qrDataUrl, ts }
     event: connected -> {}
     event: message -> { event }
     event: logged_out -> {}
 */
export async function qrSSE(req, res) {
  try {
    const apiKey = req.headers["x-api-key"] || req.query.apiKey;
    if (!apiKey) return res.status(401).json({ error: "x-api-key header or ?apiKey required" });

    // set SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // add to sseClients
    if (!sseClients.has(apiKey)) sseClients.set(apiKey, new Set());
    sseClients.get(apiKey).add(res);

    // heartbeat comment every 25s (some proxies close idle sse)
    const ping = setInterval(() => {
      try { res.write(":\n\n"); } catch (e) {}
    }, 25000);

    // cleanup on close
    req.on("close", () => {
      clearInterval(ping);
      const setClients = sseClients.get(apiKey);
      if (setClients) {
        setClients.delete(res);
        if (setClients.size === 0) sseClients.delete(apiKey);
      }
    });

    // send initial ack
    res.write(`event: connected\n`);
    res.write(`data: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
  } catch (err) {
    console.error("qrSSE err:", err);
    try { res.status(500).json({ error: err.message }); } catch {}
  }
}

/* ----------------------------
   REST endpoints
   ---------------------------- */

/**
 * POST /wa/connect
 * header: x-api-key
 * -> starts socket for user (non-blocking). QR will be sent through SSE (if client connected).
 */
export async function connect(req, res) {
  try {
    const user = req.user;
    // create or reuse
    await createSocketForUser(user);
    res.json({ success: true, message: "Socket initiating. Subscribe to /wa/qr-stream (SSE) to receive QR & events." });
  } catch (err) {
    console.error("connect err:", err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /wa/status
 */
export async function status(req, res) {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    const connected = !!sock && sock?.ws?.readyState === 1;
    res.json({ connected });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /wa/send-text
 * body: { to, text }
 */
export async function sendText(req, res) {
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
    console.error("sendText err:", err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /wa/send-media
 * body: { to, url (optional), base64 (optional), filename (optional), caption (optional) }
 */
export async function sendMedia(req, res) {
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
    console.error("sendMedia err:", err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /wa/send-buttons
 * body: { to, text, footer, buttons }
 */
export async function sendButtons(req, res) {
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
    console.error("sendButtons err:", err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /wa/send-template
 * body: { to, text, footer, hydratedButtons }
 */
export async function sendTemplate(req, res) {
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
    console.error("sendTemplate err:", err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /wa/broadcast
 * body: { numbers: ["628xx@s.whatsapp.net", ...], message }
 */
export async function broadcast(req, res) {
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
}

/**
 * GET /wa/chats
 */
export async function getChats(req, res) {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const chats = sock.chats || [];
    res.json({ chats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /wa/messages?jid=&count=
 */
export async function getMessages(req, res) {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const jid = req.query.jid;
    const count = parseInt(req.query.count || "20");
    if (!jid) return res.status(400).json({ error: "jid required" });

    if (typeof sock.fetchMessages === "function") {
      const msgs = await sock.fetchMessages(jid, count);
      return res.json({ messages: msgs });
    } else {
      // fallback: not guaranteed; return empty array
      return res.json({ messages: [] });
    }
  } catch (err) {
    console.error("getMessages err:", err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /wa/mark-read
 * body: { jid, messageId }
 */
export async function markRead(req, res) {
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
    console.error("markRead err:", err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /wa/presence
 * body: { to, presence }
 */
export async function presence(req, res) {
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
}

/**
 * POST /wa/block  /wa/unblock
 * body: { jid }
 */
export async function block(req, res) {
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
}

export async function unblock(req, res) {
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
}

/**
 * Group operations: create/add/remove/promote/demote
 */
export async function createGroup(req, res) {
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
}

export async function groupAdd(req, res) {
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
}

export async function groupRemove(req, res) {
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
}

export async function groupPromote(req, res) {
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
}

export async function groupDemote(req, res) {
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
}

/**
 * GET /wa/contacts
 */
export async function getContacts(req, res) {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const contacts = sock.contacts || {};
    res.json({ contacts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /wa/download-media
 * body: { message } - full message object
 */
export async function downloadMedia(req, res) {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });

    const mediaBuffer = await sock.downloadMediaMessage(message, "buffer");
    const mediaType = Object.keys(message.message || {}).find(k => k.includes("Message")) || "media";
    const fileName = `${Date.now()}_${mediaType.replace("Message", "")}`;
    if (!fs.existsSync("downloads")) fs.mkdirSync("downloads", { recursive: true });
    const filePath = path.join("downloads", fileName);
    fs.writeFileSync(filePath, mediaBuffer);
    await saveLog(req.user.id, "media_download", { filePath });
    res.json({ success: true, filePath });
  } catch (err) {
    console.error("downloadMedia err:", err);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /wa/profile-update
 * body: { name }
 */
export async function updateProfileName(req, res) {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });

    const result = await sock.updateProfileName(name).catch(()=>null);
    await saveLog(req.user.id, "profile_update", { name });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /wa/profile-picture
 * body: { base64 } (image base64)
 */
export async function updateProfilePicture(req, res) {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (!sock) return res.status(400).json({ error: "Session not connected" });

    const { base64 } = req.body;
    if (!base64) return res.status(400).json({ error: "base64 required" });

    const buffer = Buffer.from(base64, "base64");
    // Baileys API has different method names depending on version; attempt updateProfilePicture
    try {
      await sock.updateProfilePicture(req.user.apiKey + "@s.whatsapp.net", buffer);
    } catch (e) {
      // ignore if not available
    }
    await saveLog(req.user.id, "profile_picture_update", {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /wa/logout
 */
export async function logout(req, res) {
  try {
    const apiKey = req.user.apiKey;
    const sock = sessions[apiKey];
    if (sock) {
      try { await sock.logout(); } catch (e) {}
      delete sessions[apiKey];
    }
    const sessDir = path.join("baileys", "sessions", apiKey);
    try { fs.rmSync(sessDir, { recursive: true, force: true }); } catch {}
    // notify SSE clients
    sendSSE(apiKey, "logged_out", {});
    await saveLog(req.user.id, "logout", {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/* ----------------------------
   Router helper to export all routes
   ---------------------------- */
import express from "express";
const router = express.Router();

// SSE QR stream (client must connect with x-api-key header or ?apiKey=)
router.get("/qr-stream", qrSSE);

// main actions
router.post("/connect", async (req, res, next) => connect(req, res).catch(next));
router.get("/status", async (req, res, next) => status(req, res).catch(next));
router.post("/send-text", async (req, res, next) => sendText(req, res).catch(next));
router.post("/send-media", async (req, res, next) => sendMedia(req, res).catch(next));
router.post("/send-buttons", async (req, res, next) => sendButtons(req, res).catch(next));
router.post("/send-template", async (req, res, next) => sendTemplate(req, res).catch(next));
router.post("/broadcast", async (req, res, next) => broadcast(req, res).catch(next));
router.get("/chats", async (req, res, next) => getChats(req, res).catch(next));
router.get("/messages", async (req, res, next) => getMessages(req, res).catch(next));
router.post("/mark-read", async (req, res, next) => markRead(req, res).catch(next));
router.post("/presence", async (req, res, next) => presence(req, res).catch(next));
router.post("/block", async (req, res, next) => block(req, res).catch(next));
router.post("/unblock", async (req, res, next) => unblock(req, res).catch(next));
router.post("/group-create", async (req, res, next) => createGroup(req, res).catch(next));
router.post("/group-add", async (req, res, next) => groupAdd(req, res).catch(next));
router.post("/group-remove", async (req, res, next) => groupRemove(req, res).catch(next));
router.post("/group-promote", async (req, res, next) => groupPromote(req, res).catch(next));
router.post("/group-demote", async (req, res, next) => groupDemote(req, res).catch(next));
router.get("/contacts", async (req, res, next) => getContacts(req, res).catch(next));
router.post("/download-media", async (req, res, next) => downloadMedia(req, res).catch(next));
router.post("/profile-update", async (req, res, next) => updateProfileName(req, res).catch(next));
router.post("/profile-picture", async (req, res, next) => updateProfilePicture(req, res).catch(next));
router.post("/logout", async (req, res, next) => logout(req, res).catch(next));

// Export router and helpers for app to mount at e.g. /api/wa
export { createSocketForUser };
export default router;
