/**
 * Anti-Delete Command — Toggle for the anti-delete engine (utils/antidelete.js)
 *
 * Usage: ,antidelete on/off
 *
 * The engine (utils/antidelete.js) pre-saves media at arrival so deleted
 * photos/videos are recovered even after WhatsApp revokes the CDN link.
 */

const { isEnabled, setEnabled } = require('../../utils/antidelete');

module.exports = {
	name: 'antidelete',
	category: 'owner',
	description: 'Catch deleted messages and forward to your DM',
	usage: ',antidelete [on|off]',
	ownerOnly: true,

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
			? '🔒 *Anti-Delete ON*\n\nDeleted messages will be forwarded to your DM.'
			: '🔓 *Anti-Delete OFF*');
	}
};
