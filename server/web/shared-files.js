'use strict';
/**
 * The openvibe-shared files Live serves at /shared/<file>, and each one's Content-Type. The package lists them
 * (openvibe-shared/files): BROWSER scripts, STYLES, FONTS and IMAGES. Until 2026-11-05 Live served only the scripts
 * and fonts, so a stylesheet the navbar links (ov-forms.css, Shared 4.109) answered 404 text/plain on every page
 * (the phone sweep of 11-05) and the browser refused it.
 */
const files = require('openvibe-shared/files');

const KINDS = [
    [files.BROWSER || [], 'application/javascript; charset=utf-8'],
    [files.STYLES || [], 'text/css; charset=utf-8'],
    [files.FONTS || [], 'font/woff2'],
    [files.IMAGES || [], 'image/svg+xml'],
];

/** name → Content-Type, for every file the package says a site serves. */
const TYPES = new Map();
for (const [names, type] of KINDS) for (const name of names) if (!TYPES.has(name)) TYPES.set(name, type);

/** The Content-Type for a served file, or null when the package does not list it (the route answers 404). */
function typeOf(name) {
    return TYPES.get(String(name)) || null;
}

module.exports = { dir: files.dir, BROWSER: files.BROWSER || [], typeOf, names: () => [...TYPES.keys()] };
