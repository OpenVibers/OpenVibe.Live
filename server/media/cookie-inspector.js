
/**
 * Inspect a Netscape cookies.txt for the things that actually decide whether YouTube
 * will serve us video, and report them individually.
 *
 * The save endpoint used to accept any string over 10 characters and report success, so
 * a cookie file that could never work looked identical to a good one — which is how a
 * jar holding only third-party cookies sat in place while every request failed the bot
 * check. These are the checks that distinguish the two.
 *
 * YouTube's first-party session lives in SID/HSID/SSID/APISID/SAPISID (and the
 * __Secure-1P* variants). A jar with only the __Secure-3P* set is a third-party/partial
 * export: it looks plausible, parses fine, and is NOT signed in.
 */
const YT_FIRST_PARTY = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-1PAPISID'];
const YT_THIRD_PARTY = ['__Secure-3PSID', '__Secure-3PAPISID', '__Secure-3PSIDTS'];

function inspectCookies(text) {
    const raw = String(text || '');
    const lines = raw.split('\n');
    const rows = [];
    let malformed = 0;

    for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        // domain, includeSubdomains, path, secure, expiry, name, value
        const parts = line.split('\t');
        if (parts.length < 7) { malformed++; continue; }
        rows.push({
            domain: parts[0].trim(),
            expiry: parseInt(parts[4], 10) || 0,
            name: parts[5].trim(),
        });
    }

    const domains = [...new Set(rows.map(r => r.domain))];
    const yt = rows.filter(r => /youtube\.com$|^\.?youtube\.com$/i.test(r.domain) || /google\.com$/i.test(r.domain));
    const names = new Set(yt.map(r => r.name));

    const firstParty = YT_FIRST_PARTY.filter(n => names.has(n));
    const thirdParty = YT_THIRD_PARTY.filter(n => names.has(n));

    const now = Math.floor(Date.now() / 1000);
    // expiry 0 = session cookie; those are fine, they just do not carry an expiry.
    const dated = yt.filter(r => r.expiry > 0);
    const expired = dated.filter(r => r.expiry < now);
    const soonest = dated.length ? Math.min(...dated.map(r => r.expiry)) : 0;

    const errors = [];
    const warnings = [];

    if (!rows.length) {
        errors.push('No cookie lines found. This must be Netscape cookies.txt format — tab-separated, one cookie per line.');
    }
    if (malformed) {
        warnings.push(`${malformed} line(s) were not tab-separated and were ignored. Some editors and copy/paste convert tabs to spaces — export the file rather than pasting from a viewer.`);
    }
    if (rows.length && !yt.length) {
        errors.push('No youtube.com or google.com cookies present.');
    }
    if (yt.length && !firstParty.length) {
        errors.push(
            'Not signed in: no first-party session cookies (' + YT_FIRST_PARTY.slice(0, 5).join(', ') + ').' +
            (thirdParty.length
                ? ` Only third-party cookies were found (${thirdParty.join(', ')}), which is what an export from an incognito window or a partial/consent-only session looks like. YouTube will still demand a sign-in check.`
                : '')
        );
    }
    if (expired.length && expired.length === dated.length) {
        errors.push('Every dated cookie in this file has already expired.');
    } else if (expired.length) {
        warnings.push(`${expired.length} of ${dated.length} dated cookies have expired.`);
    }

    return {
        ok: errors.length === 0,
        cookieCount: rows.length,
        youtubeCount: yt.length,
        domains: domains.slice(0, 12),
        firstParty,
        thirdParty,
        missingFirstParty: YT_FIRST_PARTY.filter(n => !names.has(n)),
        expiredCount: expired.length,
        expiresAt: soonest ? new Date(soonest * 1000).toISOString() : null,
        errors,
        warnings,
    };
}

module.exports = { inspectCookies, YT_FIRST_PARTY, YT_THIRD_PARTY };
