/**
 * Base class for all breaking news sources.
 * Each source must implement poll() which returns an array of news items.
 */
class BaseNewsSource {
    constructor(id, label, options = {}) {
        this.id = id;                           // e.g. 'reddit', 'newsapi'
        this.label = label;                     // e.g. 'Reddit'
        this.enabled = false;
        this.pollIntervalMs = options.pollIntervalMs || 5 * 60 * 1000;  // 5 min default
        this.config = {};                       // credentials, parameters
        this._timer = null;
        this._onNews = null;                    // callback: (items) => void
    }

    /** Override: return array of { headline, url, source, category? } */
    async poll() {
        return [];
    }

    /** Validate config and return { valid, error? } */
    validate() {
        return { valid: true };
    }

    start(onNews) {
        this._onNews = onNews;
        this._timer = setInterval(() => this._doPoll(), this.pollIntervalMs);
        this._doPoll(); // initial fetch
    }

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    async _doPoll() {
        try {
            const items = await this.poll();
            if (items.length && this._onNews) this._onNews(items);
        } catch (err) {
            console.error(`[News:${this.id}] Poll error:`, err.message);
        }
    }
}

module.exports = BaseNewsSource;
