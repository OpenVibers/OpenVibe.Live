/**
 * OpenVibe.Live — Word Filter (Safe/Unsafe)
 * 
 * Filters chat messages for unsafe content.
 * Two modes: SAFE (whitelist only) and STANDARD (blacklist).
 */
const fs = require('fs');
const path = require('path');

class WordFilter {
    constructor() {
        this.unsafeWords = new Set();
        this.unsafePatterns = [];
        this.loaded = false;
    }

    /**
     * Load unsafe words from file
     */
    load(filePath) {
        try {
            const fullPath = path.resolve(filePath || './server/chat/unsafe-words.txt');
            if (fs.existsSync(fullPath)) {
                const content = fs.readFileSync(fullPath, 'utf8');
                content.split('\n').forEach(line => {
                    const word = line.trim().toLowerCase();
                    if (word && !word.startsWith('#')) {
                        this.unsafeWords.add(word);
                        // Also create regex pattern for partial matches
                        this.unsafePatterns.push(new RegExp(`\\b${this.escapeRegex(word)}\\b`, 'gi'));
                    }
                });
                this.loaded = true;
                console.log(`[Filter] Loaded ${this.unsafeWords.size} unsafe words`);
            } else {
                console.log('[Filter] No unsafe words file found, using defaults');
                this.loadDefaults();
            }
        } catch (err) {
            console.error('[Filter] Failed to load word filter:', err.message);
            this.loadDefaults();
        }
    }

    loadDefaults() {
        // Minimal default filter — add more as needed
        const defaults = [
            // Location identifiers that could compromise OpSec
            'address', 'coordinates', 'gps location', 'exact location',
        ];
        defaults.forEach(w => this.unsafeWords.add(w.toLowerCase()));
        this.loaded = true;
    }

    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Check if a message contains unsafe words
     * Returns { safe: boolean, filtered: string, matches: string[] }
     */
    check(message) {
        if (!this.loaded) this.loadDefaults();

        const lower = message.toLowerCase();
        const matches = [];

        for (const word of this.unsafeWords) {
            if (lower.includes(word)) {
                matches.push(word);
            }
        }

        if (matches.length === 0) {
            return { safe: true, filtered: message, matches: [] };
        }

        // Replace unsafe words with asterisks
        let filtered = message;
        for (const pattern of this.unsafePatterns) {
            filtered = filtered.replace(pattern, (match) => '*'.repeat(match.length));
        }

        return { safe: false, filtered, matches };
    }

    /**
     * Check for obvious spam patterns
     */
    isSpam(message) {
        // Repeated characters
        if (/(.)\1{10,}/.test(message)) return true;
        // Too many caps
        if (message.length > 10 && (message.replace(/[^A-Z]/g, '').length / message.length) > 0.8) return true;
        // URL spam
        const urlCount = (message.match(/https?:\/\//g) || []).length;
        if (urlCount > 3) return true;

        return false;
    }
}

module.exports = new WordFilter();
