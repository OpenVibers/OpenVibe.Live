'use strict';

const db = require('../db/database');

// Cooldown tracking: streamId → lastNotifyTimestamp
const _cooldowns = new Map();
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Send a Discord webhook embed when a stream goes live.
 * @param {{ id: number, username: string, display_name?: string, avatar_url?: string }} streamer
 * @param {{ id: number, title?: string }} stream
 */
async function notifyDiscordGoLive(streamer, stream) {
    try {
        const webhookUrl = db.getSetting('discord_webhook_url');
        if (!webhookUrl) return;

        // Validate URL format
        if (!/^https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(webhookUrl) &&
            !/^https:\/\/discordapp\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(webhookUrl)) {
            return;
        }

        // Cooldown check per stream
        const cooldownMs = (db.getSetting('discord_webhook_cooldown') || 15) * 60 * 1000;
        const lastNotify = _cooldowns.get(stream.id);
        if (lastNotify && (Date.now() - lastNotify) < cooldownMs) return;

        const displayName = streamer.display_name || streamer.username;
        const streamUrl = `https://openvibe.live/${streamer.username}`;
        const title = stream.title || 'Started streaming';

        const embed = {
            title: `🔴 ${displayName} is live!`,
            description: title,
            url: streamUrl,
            color: 0xef4444, // red
            timestamp: new Date().toISOString(),
            footer: { text: 'OpenVibe.Live.com' },
        };

        if (streamer.avatar_url) {
            embed.thumbnail = { url: streamer.avatar_url };
        }

        // Custom message template support
        const customContent = db.getSetting('discord_webhook_message') || null;

        const body = {
            embeds: [embed],
        };
        if (customContent) {
            body.content = customContent
                .replace(/{username}/g, streamer.username)
                .replace(/{display_name}/g, displayName)
                .replace(/{title}/g, title)
                .replace(/{url}/g, streamUrl);
        }

        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (res.ok || res.status === 204) {
            _cooldowns.set(stream.id, Date.now());
        } else {
            console.warn(`[discord-webhook] Discord returned ${res.status} for stream ${stream.id}`);
        }
    } catch (err) {
        console.warn('[discord-webhook] Failed to send:', err.message);
    }
}

module.exports = { notifyDiscordGoLive };
