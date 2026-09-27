'use strict';
/**
 * What an open tab does with each Live release (ADR-016, D43/D46 scenario 1; openvibe-shared/release components):
 *
 *   styles  every stylesheet under public/css (kind style): a styles-only release is swapped into open tabs in
 *           place, so a broadcaster's desk or a viewer's player is never reloaded for a colour or a margin
 *   shell   every other file the page runs (kind script): scripts, pages, fragments, the feature registry, the
 *           service worker, the OBS overlays, the server code that stamps pages (server/web, server/seo) and the
 *           lockfile (the /shared files come from the openvibe-shared pin): a change prompts, never reloads mid-use
 *   server  the rest of server/ (kind server): nothing to do in open tabs
 * Images and other media need nothing. Before this, Live declared no components, so every release (a stylesheet
 * included) prompted open tabs to reload (Host docs/release-acceptance.md, gate 1e).
 */
const fs = require('fs');
const path = require('path');

const SHELL_FILES = [
    'public/js', 'public/fragments', 'public/obs', 'public/index.html', 'public/features.json', 'public/service-worker.js',
    'public/live-notify.js', 'public/manifest.webmanifest', 'public/banned.html', 'public/dmca.html', 'public/kiosk.html',
    'public/media-player.html', 'public/popout-chat.html', 'public/privacy.html', 'public/tos.html', 'public/whip-publisher.html',
    'server/web', 'server/seo', 'package-lock.json',
];

/** Every stylesheet under <root>/public/css as a URL path (/css/…), sorted. */
function stylesheets(root) {
    const base = path.join(root, 'public');
    const out = [];
    const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.css')) out.push('/' + path.relative(base, p).split(path.sep).join('/'));
        }
    };
    walk(path.join(base, 'css'));
    return out.sort();
}

function componentsFor(root) {
    return {
        styles: { kind: 'style', assets: stylesheets(root) },
        shell: { kind: 'script', files: SHELL_FILES.filter((f) => fs.existsSync(path.join(root, f))) },
        server: { kind: 'server', files: ['server'] },
    };
}

module.exports = { componentsFor, stylesheets, SHELL_FILES };
