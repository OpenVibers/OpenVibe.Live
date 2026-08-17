/**
 * RSS/Atom feed source — fetches headlines from any RSS feed.
 * No API key needed. Uses built-in XML parsing.
 */
const BaseNewsSource = require('./base-source');

class RssSource extends BaseNewsSource {
    constructor() {
        super('rss', 'RSS Feeds', { pollIntervalMs: 10 * 60 * 1000 }); // 10 min
    }

    validate() {
        if (!this.config.feeds || !this.config.feeds.length) {
            return { valid: false, error: 'At least one RSS feed URL required' };
        }
        return { valid: true };
    }

    async poll() {
        const { valid } = this.validate();
        if (!valid) return [];

        const feeds = Array.isArray(this.config.feeds)
            ? this.config.feeds
            : String(this.config.feeds).split(',').map(s => s.trim()).filter(Boolean);

        const items = [];
        for (const feedUrl of feeds.slice(0, 10)) { // max 10 feeds
            try {
                const res = await fetch(feedUrl, {
                    headers: { 'User-Agent': 'OpenVibe.Live/1.0' },
                    signal: AbortSignal.timeout(10000),
                });
                if (!res.ok) continue;
                const xml = await res.text();
                // Simple XML extraction — handles RSS 2.0 and Atom
                const entries = this._parseItems(xml, feedUrl);
                items.push(...entries.slice(0, 5)); // max 5 per feed
            } catch (err) {
                console.error(`[News:rss] Failed ${feedUrl}:`, err.message);
            }
        }
        return items;
    }

    _parseItems(xml, feedUrl) {
        const items = [];
        // RSS 2.0: <item><title>...<link>...
        const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
        for (const item of rssItems.slice(0, 5)) {
            const title = this._extractTag(item, 'title');
            const link = this._extractTag(item, 'link');
            if (title) {
                items.push({
                    headline: this._decodeEntities(title),
                    url: link || feedUrl,
                    source: 'RSS',
                    category: 'news',
                });
            }
        }
        if (items.length) return items;

        // Atom: <entry><title>...<link href="...">
        const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
        for (const entry of atomEntries.slice(0, 5)) {
            const title = this._extractTag(entry, 'title');
            const linkMatch = entry.match(/<link[^>]*href=["']([^"']+)["']/i);
            const link = linkMatch ? linkMatch[1] : feedUrl;
            if (title) {
                items.push({
                    headline: this._decodeEntities(title),
                    url: link,
                    source: 'RSS',
                    category: 'news',
                });
            }
        }
        return items;
    }

    _extractTag(xml, tag) {
        // Handle CDATA: <title><![CDATA[...]]></title>
        const cdataMatch = xml.match(new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i'));
        if (cdataMatch) return cdataMatch[1].trim();
        const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
        return match ? match[1].trim() : null;
    }

    _decodeEntities(str) {
        return str
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
    }
}

module.exports = RssSource;
