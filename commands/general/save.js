/**
 * PLUGIN: Status Save
 * React \u{1fae} to any status and it gets saved straight to your own DM.
 * Auto-activates on load \u2014 no command needed to start watching.
 */

const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const SAVE_EMOJI = "\u{1fae}";
let listenersAttached = false;

const statusCache = {}; // { [msgId]: rawMsg }

function attachListeners(sock) {
  if (listenersAttached) return;
  listenersAttached = true;

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages) {
      if (m.key.remoteJid === "status@broadcast" && !m.key.fromMe) {
        statusCache[m.key.id] = m;
      }
    }
  });

  sock.ev.on("messages.reaction", async (reactions) => {
    for (const r of reactions) {
      if (r.reaction?.text !== SAVE_EMOJI) continue;

      const cached = statusCache[r.key.id];
      if (!cached) {
        console.log("[statusSave] Reaction caught but no matching status in cache:", r.key.id);
        continue;
      }

      const jid = cached.key.participant;
      const text =
        cached.message?.conversation ||
        cached.message?.extendedTextMessage?.text ||
        cached.message?.imageMessage?.caption ||
        cached.message?.videoMessage?.caption ||
        "";

      try {
        const mtype = Object.keys(cached.message)[0] || '';
        let mediaType = null;
        let buffer = null;

        if (/image/i.test(mtype)) {
          mediaType = 'image';
          const stream = await downloadContentFromMessage(cached.message.imageMessage, 'image');
          buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        } else if (/video/i.test(mtype)) {
          mediaType = 'video';
          const stream = await downloadContentFromMessage(cached.message.videoMessage, 'video');
          buffer = Buffer.from([]);
          for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        }

        if (buffer && mediaType) {
          const sendOpts = { [mediaType]: buffer, mimetype: mediaType === 'image' ? 'image/jpeg' : 'video/mp4' };
          if (text) sendOpts.caption = `\u{1fae} Saved status from ${jid}\n${text}`;
          else sendOpts.caption = `\u{1fae} Saved status from ${jid}`;
          await sock.sendMessage(sock.user.id, sendOpts);
        } else {
          await sock.sendMessage(sock.user.id, {
            text: `\u{1fae} Saved status from ${jid}:\n"${text}"`,
          });
        }
        console.log("[statusSave] Status saved to DM");
      } catch (e) {
        // Fallback to text-only if media download fails
        await sock.sendMessage(sock.user.id, {
          text: `\u{1fae} Saved status from ${jid}:\n"${text}"`,
        });
        console.log("[statusSave] Text-only fallback saved");
      }
    }
  });

  console.log('[statusSave] Plugin active — react ' + SAVE_EMOJI + ' to save statuses');
}

module.exports = {
  name: "save",
  category: "general",
  description: "React \u{1fae} to any status to save it to your DM",
  usage: ",save",

  async execute(sock, msg, args, extra) {
    attachListeners(sock);
    await extra.reply("\u{1fae} Status saver is active \u2014 react \u{1fae} on any status to save it.");
  },

  init(sock) {
    attachListeners(sock);
  },
};
