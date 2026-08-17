/**
 * OpenVibe.Live — IP Utilities
 *
 * GeoIP lookup using geoip-lite (free MaxMind-based local DB).
 * No external API calls — all lookups are instant against an in-memory dataset.
 */

let geoip = null;
try {
    geoip = require('geoip-lite');
} catch {
    console.warn('[IP Utils] geoip-lite not installed. GeoIP lookups disabled. Run: npm install geoip-lite');
}

/**
 * Look up geographic / ISP info for an IP address.
 * Returns a normalized object (or null for private/unknown IPs).
 */
function lookupIp(ip) {
    if (!geoip || !ip || ip === 'unknown') return null;

    // Skip private / loopback
    if (ip === '127.0.0.1' || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) {
        return { country: 'Local', region: '', city: 'Private Network', isp: '', org: '', ll: '' };
    }

    const geo = geoip.lookup(ip);
    if (!geo) return null;

    return {
        country: geo.country || '',
        region: geo.region || '',
        city: geo.city || '',
        isp: '',              // geoip-lite doesn't include ISP; field reserved for future ASN lookup
        org: geo.org || '',
        ll: geo.ll ? geo.ll.join(',') : '',
        timezone: geo.timezone || '',
        range: geo.range || null,
    };
}

/**
 * Enrich an IP with geo data and return a flat object suitable for db.logIp().
 */
function enrichIp(ip) {
    const geo = lookupIp(ip);
    return geo || { country: null, region: null, city: null, isp: null, org: null, ll: null };
}

module.exports = { lookupIp, enrichIp };
