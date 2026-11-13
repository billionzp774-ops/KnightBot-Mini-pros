/**
 * Schedule Status — Schedule personal WhatsApp status posts for later
 * 
 * Usage:
 *   ,schedstatus 30m Hello world          — post text status in 30 minutes
 *   ,schedstatus 2h I'll be back           — post text status in 2 hours
 *   ,schedstatus 10:30pm Good night 🌙     — post text status at 10:30 PM today
 *   ,schedstatus list                      — view all scheduled statuses
 *   ,schedstatus cancel <id>               — cancel a scheduled status
 *   
 *   Reply to an image/video with:
 *   ,schedstatus 30m [optional caption]    — post that media as status in 30 min
 * 
 * Owner only.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

const SCHEDULE_FILE = path.join(__dirname, '../../database/schedstatus.json');
const ACTIVE_TIMERS_FILE = path.join(__dirname, '../../database/schedstatus_timers.json');

// ---- Persistence ----
function loadScheduled() {
        try {
                if (fs.existsSync(SCHEDULE_FILE)) {
                        return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
                }
        } catch (_) {}
        return [];
}

function saveScheduled(list) {
        const dir = path.dirname(SCHEDULE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(list, null, 2));
}

// ---- Time Parsing ----
function parseTime(str) {
        str = str.trim().toLowerCase();

        // Relative: "30m", "2h", "1h30m", "45s", "1d"
        const relMatch = str.match(/^(\d+(?:\.\d+)?)\s*(d|h|m|s)$/i);
        if (relMatch) {
                const val = parseFloat(relMatch[1]);
                const unit = relMatch[2].toLowerCase();
                let ms = 0;
                if (unit === 's') ms = val * 1000;
                else if (unit === 'm') ms = val * 60 * 1000;
                else if (unit === 'h') ms = val * 60 * 60 * 1000;
                else if (unit === 'd') ms = val * 24 * 60 * 60 * 1000;
                return Date.now() + ms;
        }

        // Combined relative: "1h30m"
        const comboMatch = str.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/i);
        if (comboMatch && (comboMatch[1] || comboMatch[2])) {
                const h = parseInt(comboMatch[1] || '0');
                const m = parseInt(comboMatch[2] || '0');
                if (h === 0 && m === 0) return null;
                return Date.now() + (h * 3600 + m * 60) * 1000;
        }

        // Absolute time: "10:30pm", "10:30am", "22:30", "10:30"
        const absMatch = str.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
        if (absMatch) {
                let hour = parseInt(absMatch[1]);
                const min = parseInt(absMatch[2]);
                const ampm = (absMatch[3] || '').toLowerCase();

                if (ampm === 'pm' && hour < 12) hour += 12;
                if (ampm === 'am' && hour === 12) hour = 0;
                if (hour >= 24 || min >= 60) return null;

                const now = new Date();
                const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, min, 0, 0);

                // If the time has already passed today, schedule for tomorrow
                if (target <= now) {
                        target.setDate(target.getDate() + 1);
                }
                return target.getTime();
        }

        return null;
}

function formatTimeLeft(ms) {
        const diff = ms - Date.now();
        if (diff <= 0) return 'now';

        const d = Math.floor(diff / 86400000);
        const h = Math.floor((diff % 86400000) / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);

        let parts = [];
        if (d > 0) parts.push(`${d}d`);
        if (h > 0) parts.push(`${h}h`);
        if (m > 0) parts.push(`${m}m`);
        if (s > 0 && d === 0 && h === 0) parts.push(`${s}s`);
        return parts.join(' ') || 'now';
}

function formatDate(ts) {
        return new Date(ts).toLocaleString('en-NG', {
                weekday: 'short',
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
                timeZone: 'Africa/Lagos'
        });
}

// ---- Post Status ----
async function postStatus(sock, item) {
        try {
                if (item.type === 'text') {
                        await sock.sendMessage('status@broadcast', {
                                text: item.text,
                                backgroundColor: item.bgColor || '#1a1a2e',
                                font: item.font || 1,
                        });
                } else if (item.type === 'image') {
                        const opts = { image: item.buffer, mimetype: 'image/jpeg' };
                        if (item.caption) opts.caption = item.caption;
                        await sock.sendMessage('status@broadcast', opts);
                } else if (item.type === 'video') {
                        const opts = { video: item.buffer, mimetype: 'video/mp4' };
                        if (item.caption) opts.caption = item.caption;
                        await sock.sendMessage('status@broadcast', opts);
                }
                console.log(`[schedStatus] Posted ${item.type} status (ID: ${item.id})`);
                return true;
        } catch (e) {
                console.error(`[schedStatus] Failed to post (ID: ${item.id}):`, e.message);
                return false;
        }
}

// ---- Timer Management ----
const activeTimers = new Map();

function clearTimer(id) {
        if (activeTimers.has(id)) {
                clearTimeout(activeTimers.get(id));
                activeTimers.delete(id);
        }
}

function setTimer(sock, item) {
        const delay = item.scheduledAt - Date.now();
        if (delay <= 0) {
                // Already due, post immediately
                postStatus(sock, item).then(() => {
                        removeScheduledItem(item.id);
                });
                return;
        }

        const timer = setTimeout(async () => {
                activeTimers.delete(item.id);
                const success = await postStatus(sock, item);
                removeScheduledItem(item.id);

                // Notify owner
                try {
                        const ownerJid = config.ownerNumber[0] + '@s.whatsapp.net';
                        const msg = success
                                ? `✅ Scheduled status posted!\n\n📌 Type: ${item.type}\n📝 Text: ${item.text || item.caption || '(media)'}\n🆔 ID: ${item.id}`
                                : `❌ Failed to post scheduled status (ID: ${item.id})`;
                        await sock.sendMessage(ownerJid, { text: msg });
                } catch (_) {}
        }, delay);

        activeTimers.set(item.id, timer);
}

function removeScheduledItem(id) {
        const list = loadScheduled().filter(i => i.id !== id);
        saveScheduled(list);
}

// ---- Restore timers on bot start ----
function restoreTimers(sock) {
        const list = loadScheduled();
        const now = Date.now();
        let restored = 0;

        for (const item of list) {
                // Decode base64 buffer back to Buffer if restoring media
                if (item.bufferB64 && !item.buffer) {
                        item.buffer = Buffer.from(item.bufferB64, 'base64');
                }

                if (item.scheduledAt > now) {
                        setTimer(sock, item);
                        restored++;
                } else {
                        // Past due — post immediately if not too old (within 1 hour)
                        if (item.scheduledAt > now - 3600000) {
                                postStatus(sock, item).then(() => removeScheduledItem(item.id));
                        } else {
                                removeScheduledItem(item.id);
                        }
                }
        }

        if (restored > 0) {
                console.log(`[schedStatus] Restored ${restored} scheduled status timer(s)`);
        }
}

module.exports = {
        name: 'schedstatus',
        aliases: ['schedulestatus', 'ssched', 'sstatus'],
        category: 'owner',
        description: 'Schedule a personal status post for later',
        usage: ',schedstatus <time> <text>  |  ,schedstatus list  |  ,schedstatus cancel <id>',
        ownerOnly: true,

        restoreTimers,

        async execute(sock, msg, args, extra) {
                try {
                        // No args = show help
                        if (!args.length) {
                                return extra.reply(
                                        `📱 *Schedule Status*\n\n` +
                                        `Post status at a specific time.\n\n` +
                                        `*Usage:*\n` +
                                        `  \`,schedstatus 30m Your text\`\n` +
                                        `  \`,schedstatus 2h Hello world\`\n` +
                                        `  \`,schedstatus 10:30pm Good night 🌙\`\n` +
                                        `  \`,schedstatus 1h30m Be right back\`\n\n` +
                                        `*Reply to image/video with:*\n` +
                                        `  \`,schedstatus 30m [caption]\`\n\n` +
                                        `*Manage:*\n` +
                                        `  \`,schedstatus list\` — view scheduled\n` +
                                        `  \`,schedstatus cancel <id>\` — cancel one\n\n` +
                                        `*Time formats:*\n` +
                                        `  Relative: 30s, 5m, 2h, 1d, 1h30m\n` +
                                        `  Absolute: 10:30pm, 10:30am, 22:30`
                                );
                        }

                        const sub = args[0].toLowerCase();

                        // LIST
                        if (sub === 'list') {
                                const list = loadScheduled();
                                if (!list.length) {
                                        return extra.reply('📋 No scheduled statuses.');
                                }

                                let text = `📋 *Scheduled Statuses (${list.length})*\n\n`;
                                for (const item of list) {
                                        const preview = (item.text || item.caption || '(media)').slice(0, 40);
                                        text += `🆔 ${item.id}\n`;
                                        text += `📌 ${item.type} — \"${preview}\"\n`;
                                        text += `⏰ ${formatDate(item.scheduledAt)} (${formatTimeLeft(item.scheduledAt)})\n\n`;
                                }

                                return extra.reply(text);
                        }

                        // CANCEL
                        if (sub === 'cancel' || sub === 'del' || sub === 'remove') {
                                const id = args[1];
                                if (!id) {
                                        return extra.reply('❌ Provide the status ID. Use \`,schedstatus list\` to see IDs.');
                                }

                                const list = loadScheduled();
                                const idx = list.findIndex(i => i.id === id);
                                if (idx === -1) {
                                        return extra.reply(`❌ No scheduled status with ID: ${id}`);
                                }

                                clearTimer(id);
                                list.splice(idx, 1);
                                saveScheduled(list);

                                return extra.reply(`✅ Cancelled scheduled status ${id}`);
                        }

                        // CLEAR ALL
                        if (sub === 'clear' || sub === 'clearall') {
                                const list = loadScheduled();
                                for (const item of list) clearTimer(item.id);
                                saveScheduled([]);
                                return extra.reply(`🗑️ Cleared all ${list.length} scheduled status(es).`);
                        }

                        // SCHEDULE — parse time from first arg
                        const scheduledAt = parseTime(args[0]);
                        if (!scheduledAt) {
                                return extra.reply(
                                        `❌ Invalid time format: \"${args[0]}\"\n\n` +
                                        `Use: 30m, 2h, 1h30m, 10:30pm, 22:30`
                                );
                        }

                        if (scheduledAt - Date.now() < 10000) {
                                return extra.reply('❌ Minimum delay is 10 seconds.');
                        }

                        // Check if replying to media
                        const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
                        const hasQuoted = !!ctxInfo?.quotedMessage;
                        const restText = args.slice(1).join(' ').trim();

                        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

                        let scheduleItem = null;

                        if (hasQuoted) {
                                // Media status
                                const qmsg = ctxInfo.quotedMessage;
                                const mtype = Object.keys(qmsg)[0] || '';

                                let mediaType = null;
                                if (/image/i.test(mtype)) mediaType = 'image';
                                else if (/video/i.test(mtype)) mediaType = 'video';
                                else {
                                        return extra.reply('❌ Reply to an image or video to schedule it as status.');
                                }

                                await extra.react('⏳');

                                // Download media now and store in schedule
                                let buffer = Buffer.from([]);
                                try {
                                        const stream = await downloadContentFromMessage(qmsg[mediaType + 'Message'], mediaType);
                                        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                                } catch (e) {
                                        return extra.reply(`❌ Failed to download ${mediaType}: ${e.message}`);
                                }

                                scheduleItem = {
                                        id,
                                        type: mediaType,
                                        buffer, // Store buffer in memory (will be posted when timer fires)
                                        caption: restText || null,
                                        scheduledAt,
                                        createdAt: Date.now(),
                                };
                        } else {
                                // Text status
                                if (!restText) {
                                        return extra.reply('❌ Provide text to post as status.\nExample: \`,schedstatus 30m Hello world\`');
                                }

                                const bgColors = ['#1a1a2e', '#16213e', '#0f3460', '#533483', '#2b2d42', '#1b263b', '#264653'];
                                const fonts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

                                scheduleItem = {
                                        id,
                                        type: 'text',
                                        text: restText,
                                        bgColor: bgColors[Math.floor(Math.random() * bgColors.length)],
                                        font: fonts[Math.floor(Math.random() * fonts.length)],
                                        scheduledAt,
                                        createdAt: Date.now(),
                                };
                        }

                        // Save to file (without buffer for text, with buffer base64 for media)
                        const persistItem = { ...scheduleItem };
                        if (persistItem.buffer) {
                                persistItem.bufferB64 = persistItem.buffer.toString('base64');
                                delete persistItem.buffer;
                        }

                        const list = loadScheduled();
                        list.push(persistItem);
                        saveScheduled(list);

                        // Set timer
                        setTimer(sock, scheduleItem);

                        const preview = (scheduleItem.text || scheduleItem.caption || `(${scheduleItem.type})`).slice(0, 40);
                        await extra.reply(
                                `✅ *Status Scheduled!*\n\n` +
                                `🆔 ID: \`${id}\`\n` +
                                `📌 Type: ${scheduleItem.type}\n` +
                                `📝 \"${preview}\"\n` +
                                `⏰ ${formatDate(scheduledAt)}\n` +
                                `⏳ In: ${formatTimeLeft(scheduledAt)}\n\n` +
                                `Use \`,schedstatus list\` to view all\n` +
                                `Use \`,schedstatus cancel ${id}\` to cancel`
                        );

                } catch (e) {
                        console.error('[schedStatus] error:', e);
                        return extra.reply('❌ Error: ' + (e.message || e));
                }
        }
};
