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
    openapi: '/openapi.json',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: '900 GET/HEAD API requests a minute per address, 180 writes; sign-in and registration attempts are limited to 20 per 15 minutes',
        // What an id in a page's address is, and where it goes (AGT-4; server/web/page-status.js, video-handover.js).
        stableIds: [
            { kind: 'channel', url: 'https://openvibe.live/@{username}', id: 'the streamer\'s OpenVibe username (never a bare /{username}); a renamed channel\'s old name answers 301 to the current one', gone: 'a name no one has answers 404' },
            { kind: 'recording', url: 'https://openvibe.live/vod/{id}', id: 'OpenVibe.Media\'s recording id; answers 301 to its watch page, https://openvibe.video/v/{id}, whose manifest has the rule' },
            { kind: 'clip', url: 'https://openvibe.live/clip/{id}', id: 'OpenVibe.Media\'s clip id; answers 301 to https://openvibe.video/c/{id}' },
        ],
    },
};
