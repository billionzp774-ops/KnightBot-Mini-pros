/**
 * PLUGIN: Message & Media Recovery
 * Catches deleted messages AND deleted media before WhatsApp wipes them.
 * Auto-activates on load — no command needed to start capturing.
 * Command: ,recovered — shows last few recovered items
 */

const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

let listenersAttached = false;
const messageCache = {}; // { [msgId]: { jid, text, rawMsg, time } }
const recoveredLog = []; // last recovered items for quick recall

function attachListeners(sock) {
  if (listenersAttached) return;
  listenersAttached = true;

  // Cache every message the moment it arrives, before any delete can happen
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages) {
      if (m.key.remoteJid === "status@broadcast") continue;
      if (!m.key?.id) continue;
      const text =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        "";
      messageCache[m.key.id] = { jid: m.key.remoteJid, text, rawMsg: m, time: Date.now() };
    }
  });

  // Catch delete/revoke events (Baileys v7: status 13 = DELETED, stubType 68 = revoked)
  sock.ev.on("messages.update", async (updates) => {
    for (const u of updates) {
      const isRevoked =
        u.update?.status === 13 ||
        u.update?.messageStubType === 68 ||
        u.update?.message === null;
      if (!isRevoked) continue;
      if (!u.key?.id) continue;

      const cached = messageCache[u.key.id];
      if (!cached) continue;

      // Log it for the ,recovered command
      const who = u.key.fromMe ? "You" : cached.jid;
      recoveredLog.push({ who, text: cached.text, time: Date.now() });
      if (recoveredLog.length > 30) recoveredLog.shift();

      // If the upstream antidelete engine is ON, it already forwards with
      // pre-saved media — skip forwarding here to avoid duplicates.
      let engineEnabled = false;
      try { engineEnabled = require("../../utils/antidelete").isEnabled(); } catch (_) {}
      if (engineEnabled) continue;

      let header = `♻️ Recovered deleted message\nFrom: ${who}`;

      try {
        const raw = cached.rawMsg.message;
        const mtype = Object.keys(raw)[0] || '';
        let mediaType = null;
        let buffer = null;

        if (/image/i.test(mtype)) {
          mediaType = 'image';
          const stream = await downloadContentFromMessage(raw.imageMessage, 'image');
          buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        } else if (/video/i.test(mtype)) {
          mediaType = 'video';
          const stream = await downloadContentFromMessage(raw.videoMessage, 'video');
          buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        } else if (/audio/i.test(mtype)) {
          mediaType = 'audio';
          const stream = await downloadContentFromMessage(raw.audioMessage, 'audio');
          buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        }

        if (buffer && mediaType) {
          const caption = cached.text ? header + `\n"${cached.text}"` : header;
          const sendOpts = {
            [mediaType]: buffer,
            mimetype: mediaType === 'image' ? 'image/jpeg' : mediaType === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus',
          };
          if (mediaType === 'audio') sendOpts.ptt = true;
          else sendOpts.caption = caption;
          await sock.sendMessage(sock.user.id, sendOpts);
        } else {
          await sock.sendMessage(sock.user.id, {
            text: header + `\n"${cached.text || '[media]'}"`,
          });
        }
      } catch (e) {
        // Text-only fallback
        await sock.sendMessage(sock.user.id, {
          text: header + `\n"${cached.text || '[media]'}"`,
        });
      }

      console.log(`[recovery] Recovered deleted message from ${who}`);
    }
  });

  // Also listen for messages.delete events (Baileys v7 backup)
  sock.ev.on("messages.delete", async (deletions) => {
    if (!deletions?.keys) return;
    for (const key of deletions.keys) {
      if (!key?.id) continue;
      const cached = messageCache[key.id];
      if (!cached) continue;

      const who = key.fromMe ? "You" : cached.jid;
      recoveredLog.push({ who, text: cached.text, time: Date.now() });
      if (recoveredLog.length > 30) recoveredLog.shift();

      // Skip forwarding if upstream antidelete engine handles it
      let engineEnabled2 = false;
      try { engineEnabled2 = require("../../utils/antidelete").isEnabled(); } catch (_) {}
      if (engineEnabled2) continue;

      await sock.sendMessage(sock.user.id, {
        text: `♻️ Recovered deleted message\nFrom: ${who}\n"${cached.text || '[media]'}"`,
      });
      console.log(`[recovery] messages.delete recovered from ${who}`);
    }
  });

  // Cleanup old cache entries every 10 minutes (keep last 30 min)
  setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, entry] of Object.entries(messageCache)) {
      if (entry.time < cutoff) delete messageCache[id];
    }
  }, 10 * 60 * 1000);

  console.log('[recovery] Plugin active — watching for deleted messages');
}

module.exports = {
  name: "recovered",
  category: "general",
  description: "Auto-recovers deleted messages/media and shows recent recovery log",
  usage: ",recovered",

  async execute(sock, msg, args, extra) {
    attachListeners(sock);

    if (recoveredLog.length === 0) {
      await extra.reply("♻️ No deletions caught yet — recovery is active and watching.");
      return;
    }

    const lines = recoveredLog
      .slice(-10)
      .map(
        (r) =>
          `• ${r.who}: "${r.text || '[media]'}" — ${new Date(r.time).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}`
      )
      .join("\n");

    await extra.reply(`♻️ RECOVERY LOG (last 10)\n\n${lines}`);
  },

  init(sock) {
    attachListeners(sock);
  },
};
