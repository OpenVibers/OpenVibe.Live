'use strict';
// What openvibe.live tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the JSON API behind the SPA, the API docs page,
// llms.txt/llms-full.txt/sitemap, and the API's own per-minute limits.
module.exports = {
    id: 'live',
    name: 'OpenVibe.Live',
    purpose: 'Open-source, community-run live streaming: go live from a browser or OBS, keep every stream as a VOD, clip it, and chat in real time.',
    home: 'https://openvibe.live',
    site: 'openvibe.live',
    api: '/api',
    docs: '/documentation',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: '900 GET/HEAD API requests a minute per address, 180 writes; sign-in and registration attempts are limited to 20 per 15 minutes',
    },
};
