/**
 * Reddit source — fetches top posts from configured subreddits.
 * No API key required (uses public JSON endpoint).
 */
const BaseNewsSource = require('./base-source');

class RedditSource extends BaseNewsSource {
    constructor() {
        super('reddit', 'Reddit', { pollIntervalMs: 5 * 60 * 1000 }); // 5 min
    }

    validate() {
        if (!this.config.subreddits || !this.config.subreddits.length) {
            return { valid: false, error: 'At least one subreddit required (e.g. "news", "worldnews")' };
        }
        return { valid: true };
    }

    async poll() {
        const { valid } = this.validate();
        if (!valid) return [];

        const subs = Array.isArray(this.config.subreddits)
            ? this.config.subreddits
            : String(this.config.subreddits).split(',').map(s => s.trim()).filter(Boolean);

        const items = [];
        for (const sub of subs.slice(0, 5)) { // max 5 subreddits
            try {
                const url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot.json?limit=5&raw_json=1`;
                const res = await fetch(url, {
                    headers: { 'User-Agent': 'OpenVibe.Live/1.0 (news bot)' },
                    signal: AbortSignal.timeout(10000),
                });
                if (!res.ok) continue;
                const data = await res.json();
                const posts = data?.data?.children || [];
                for (const p of posts) {
                    if (p.data.stickied) continue; // skip pinned
                    items.push({
                        headline: p.data.title,
                        url: `https://reddit.com${p.data.permalink}`,
                        source: `r/${sub}`,
                        category: 'reddit',
                    });
                }
            } catch (err) {
                console.error(`[News:reddit] Failed r/${sub}:`, err.message);
            }
        }
        return items;
    }
}

module.exports = RedditSource;
