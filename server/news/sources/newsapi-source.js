/**
 * NewsAPI.org source — fetches headlines from major news outlets.
 * Requires a free API key from https://newsapi.org/
 */
const BaseNewsSource = require('./base-source');

class NewsApiSource extends BaseNewsSource {
    constructor() {
        super('newsapi', 'NewsAPI', { pollIntervalMs: 10 * 60 * 1000 }); // 10 min
    }

    validate() {
        if (!this.config.apiKey) return { valid: false, error: 'NewsAPI key required (get one at newsapi.org)' };
        return { valid: true };
    }

    async poll() {
        const { valid, error } = this.validate();
        if (!valid) return [];

        const category = this.config.category || 'technology';
        const country = this.config.country || 'us';
        const url = `https://newsapi.org/v2/top-headlines?category=${category}&country=${country}&pageSize=5&apiKey=${this.config.apiKey}`;

        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
            if (res.status === 401) throw new Error('Invalid NewsAPI key');
            throw new Error(`NewsAPI ${res.status}`);
        }

        const data = await res.json();
        return (data.articles || []).map(a => ({
            headline: a.title,
            url: a.url,
            source: a.source?.name || 'NewsAPI',
            category,
        }));
    }
}

module.exports = NewsApiSource;
