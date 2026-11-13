/**
 * LID <-> Phone mapping store
 *
 * Baileys v7 emits 'lid-mapping.update' whenever WhatsApp exposes the real
 * phone number behind a LID JID, e.g. { lid: '123...@lid', pn: '234801...@s.whatsapp.net' }.
 *
 * This module:
 *  1. Feeds the in-memory botState.lidMap used by the web dashboard (server.js).
 *  2. Persists pairs to session/lid-mapping-<lid>.json (+ _reverse.json) —
 *     the exact file format utils/jidHelper.js and handler.js already read,
 *     so welcome/goodbye mentions and participant matching resolve to real
 *     numbers and survive restarts.
 *  3. Clears the read-caches in jidHelper/handler so new pairs are visible
 *     immediately without a restart.
 *
 * Note: a real number can only be learned when WhatsApp actually sends it
 * (via participantAlt / pnForLid contact sync). Privacy-hidden LIDs without
 * any exposed number cannot be resolved by any bot.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const botState = require('../sharedState');

const lidVariants = (lidUser) => [`${lidUser}@lid`, `${lidUser}@hosted.lid`];

function sessionDir() {
  const dir = path.join(__dirname, '..', config.sessionName || 'session');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function userOf(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function isValidLidUser(u) {
  return /^\d{6,25}$/.test(u) || /^[a-f0-9]{6,64}$/i.test(u);
}

function isValidPnUser(u) {
  return /^\d{7,15}$/.test(u);
}

/** Write both directions in the exact format jidHelper.js / handler.js read.
 *  Reader convention:
 *    direction 'lidToPn' reads lid-mapping-<lid>_reverse.json  -> phone user
 *    direction 'pnToLid' reads lid-mapping-<pn>.json           -> lid user
 */
function persistPair(lidJid, pnJid) {
  const lidUser = userOf(lidJid);
  const pnUser = userOf(pnJid);
  if (!isValidLidUser(lidUser) || !isValidPnUser(pnUser)) return false;
  const dir = sessionDir();
  fs.writeFileSync(path.join(dir, `lid-mapping-${lidUser}_reverse.json`), JSON.stringify(pnUser));
  fs.writeFileSync(path.join(dir, `lid-mapping-${pnUser}.json`), JSON.stringify(lidUser));
  return true;
}

/** Load persisted mappings into the in-memory map (dashboard) at startup. */
function hydrate() {
  let files = [];
  try {
    files = fs.readdirSync(sessionDir());
  } catch {
    return 0;
  }
  let count = 0;
  for (const f of files) {
    // skip reverse files — they carry the same pair in the other direction
    if (/^lid-mapping-.+_reverse\.json$/.test(f)) continue;
    const fwd = f.match(/^lid-mapping-(.+)\.json$/);
    if (!fwd) continue;
    const pnUser = fwd[1]; // plain files are keyed by phone user
    try {
      const lidUser = JSON.parse(fs.readFileSync(path.join(sessionDir(), f), 'utf8').trim());
      if (!isValidLidUser(String(lidUser)) || !isValidPnUser(pnUser)) continue;
      for (const v of lidVariants(String(lidUser))) {
        botState.setLidMapping(v, `${pnUser}@s.whatsapp.net`);
      }
      count++;
    } catch {}
  }
  if (count) {
    console.log(`📇 LID mappings restored: ${count} contact(s) resolvable to real numbers`);
  }
  return count;
}

/** Listen for Baileys LID->phone reveals. Call once per socket on connect. */
function attach(sock) {
  if (!sock?.ev || typeof sock.ev.on !== 'function') return;
  if (sock.__lidMappingAttached) return; // guard against duplicate listeners
  sock.__lidMappingAttached = true;
  sock.ev.on('lid-mapping.update', (mapping) => {
    try {
      const lid = String(mapping?.lid || '');
      const pn = String(mapping?.pn || '');
      if (!lid || !pn) return;

      const lidJid = lid.includes('@') ? lid : `${lid}@lid`;
      const pnJid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`;
      const lidUser = userOf(lidJid);
      const pnUser = userOf(pnJid);
      if (!isValidLidUser(lidUser) || !isValidPnUser(pnUser)) return;

      // 1) in-memory map — used by the web dashboard right away
      for (const v of lidVariants(lidUser)) {
        botState.setLidMapping(v, `${pnUser}@s.whatsapp.net`);
      }

      // 2) persist to session files — welcome/goodbye + restart survival
      const saved = persistPair(lidJid, pnJid);

      // 3) drop cached nulls so jidHelper/handler see the new files now
      try { require('./jidHelper').clearLidMappingCache(); } catch {}
      try { require('../handler').clearLidMappingCache(); } catch {}

      if (saved) {
        console.log('📇 LID mapping learned — contact now resolvable to real number');
      }
    } catch (e) {
      console.error('[lid-mapping] error:', e.message);
    }
  });
}

module.exports = { hydrate, persistPair, attach };
