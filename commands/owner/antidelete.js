/**
 * Anti-Delete — Catches deleted messages and forwards to owner
 * 
 * Usage: ,antidelete on/off
 * 
 * Fixed: handles LID JIDs by normalizing both store keys and update keys
 * so message lookup works even when Baileys uses different JID formats.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { jidDecode } = require('@whiskeysockets/baileys');

const STATE_FILE = path.join(__dirname, '../../database/antidelete.json');

function isEnabled() {
        try {
                if (fs.existsSync(STATE_FILE)) {
                        const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
                        return !!d.enabled;
                }
        } catch (_) {}
        return false;
}

function setEnabled(v) {
        const dir = path.dirname(STATE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled: v }, null, 2));
}

/**
 * Normalize a JID to a plain phone number string.
 * Handles: "12345@s.whatsapp.net", "12345:0@s.whatsapp.net", LID JIDs, etc.
 */
function toPhoneNum(jid) {
        if (!jid || typeof jid !== 'string') return null;
        try {
                const decoded = jidDecode(jid);
                if (decoded?.user) {
                        // If it's a real phone number (all digits), return it
                        if (/^\d+$/.test(decoded.user)) return decoded.user;
                }
        } catch (_) {}
        // Fallback: strip @... and :device
        return jid.split(':')[0].split('@')[0];
}

/**
 * Try to find a message in the store by checking multiple JID variants.
 * Baileys v7 may use LID JIDs in updates but phone JIDs as store keys (or vice versa).
 */
function findOriginalMessage(store, remoteJid, msgId) {
        // Direct lookup first
        let chatMsgs = store.messages.get(remoteJid);
        if (chatMsgs) {
                const msg = chatMsgs.get(msgId);
                if (msg) return msg;
        }

        // Build phone-number-based key variants and try those
        const phoneNum = toPhoneNum(remoteJid);
        if (phoneNum && !/^[a-z]/i.test(phoneNum)) {
                const variants = [
                        `${phoneNum}@s.whatsapp.net`,
                        `${phoneNum}@c.us`,
                ];
                for (const v of variants) {
                        chatMsgs = store.messages.get(v);
                        if (chatMsgs) {
                                const msg = chatMsgs.get(msgId);
                                if (msg) return msg;
                        }
                }
        }

        // Last resort: scan ALL store keys for the message ID
        for (const [chatJid, msgs] of store.messages.entries()) {
                if (msgs.has(msgId)) {
                        return msgs.get(msgId);
                }
        }

        return null;
}

/** Called from index.js when a message delete is detected */
async function onMessageDelete(sock, update, store) {
        if (!isEnabled()) return;

        const jid = update.key.remoteJid;
        const id = update.key.id;
        const sender = update.key.participant || update.key.remoteJid;
        const fromMe = update.key.fromMe;

        // Don't report own deleted messages
        if (fromMe) return;

        // Find the original message in store (handles LID JID mismatches)
        const original = findOriginalMessage(store, jid, id);

        if (!original || !original.message) return;

        const m = original.message;
        let content = '';
        let mediaType = null;

        if (m.conversation) {
                content = m.conversation;
        } else if (m.extendedTextMessage?.text) {
                content = m.extendedTextMessage.text;
        } else if (m.imageMessage) {
                content = m.imageMessage.caption || '[Image]';
                mediaType = 'image';
        } else if (m.videoMessage) {
                content = m.videoMessage.caption || '[Video]';
                mediaType = 'video';
        } else if (m.audioMessage) {
                content = '[Voice Note]';
                mediaType = 'audio';
        } else if (m.stickerMessage) {
                content = '[Sticker]';
                mediaType = 'sticker';
        } else {
                content = '[' + Object.keys(m)[0] + ']';
        }

        if (!content) return;

        const ownerNum = config.ownerNumber[0];
        const ownerJid = ownerNum + '@s.whatsapp.net';
        const shortSender = toPhoneNum(sender) || sender.split('@')[0];

        // Try to download media before it's gone
        let mediaBuffer = null;
        if (mediaType) {
                try {
                        const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                        const stream = await downloadContentFromMessage(m[mediaType + 'Message'], mediaType);
                        mediaBuffer = Buffer.from([]);
                        for await (const chunk of stream) mediaBuffer = Buffer.concat([mediaBuffer, chunk]);
                } catch (_) {}
        }

        const chatType = jid.endsWith('@g.us') ? 'Group' : 'DM';
        const header = `🔒 *Deleted Message Caught*\n\n📞 From: +${shortSender}\n💬 Chat: ${chatType}\n`;

        try {
                if (mediaBuffer && mediaType === 'image') {
                        await sock.sendMessage(ownerJid, { image: mediaBuffer, caption: header + content, mimetype: 'image/jpeg' });
                } else if (mediaBuffer && mediaType === 'video') {
                        await sock.sendMessage(ownerJid, { video: mediaBuffer, caption: header + content, mimetype: 'video/mp4' });
                } else if (mediaBuffer && mediaType === 'audio') {
                        await sock.sendMessage(ownerJid, { audio: mediaBuffer, ptt: true, mimetype: 'audio/ogg; codecs=opus' });
                } else {
                        await sock.sendMessage(ownerJid, { text: header + `\n📝 Message:\n${content}` });
                }
        } catch (_) {}
}

module.exports = {
        name: 'antidelete',
        category: 'owner',
        description: 'Catch deleted messages and forward to your DM',
        usage: ',antidelete [on|off]',
        ownerOnly: true,
        isEnabled,
        onMessageDelete,

        async execute(sock, msg, args, extra) {
                const sub = args[0]?.toLowerCase();

                if (sub === 'on') {
                        setEnabled(true);
                        return extra.reply('🔒 *Anti-Delete ON*\n\nDeleted messages will be forwarded to your DM.');
                }

                if (sub === 'off') {
                        setEnabled(false);
                        return extra.reply('🔓 *Anti-Delete OFF*');
                }

                // Toggle
                const now = !isEnabled();
                setEnabled(now);
                return extra.reply(now
                        ? '🔒 *Anti-Delete ON*'
                        : '🔓 *Anti-Delete OFF*');
        }
};