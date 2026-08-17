# OpenVibe.Live Security Audit

Date: 2026-03-09

## Summary

This audit focused on practical hardening for a self-hosted public alpha deployment.

High-priority issues addressed in code:

- private VOD/clip files could be fetched directly by filename if guessed
- auth and upload endpoints had weaker abuse controls than the rest of the API
- CORS and WebSocket origin checks were too permissive
- several WebSocket servers did not cap payload size
- profile and monetization inputs accepted overly loose values
- client toast rendering accepted raw HTML
- RTMP HTTP-FLV playback allowed all origins

## Hardening Applied

### Server entrypoint

File: [server/index.js](server/index.js)

- enabled `trust proxy`
- added explicit allowed-origin handling for CORS
- rejected WebSocket upgrades from disallowed origins
- added dedicated auth/upload rate limits
- reduced URL-encoded body limit
- added structured CORS error response

### Auth

File: [server/auth/routes.js](server/auth/routes.js)

- trimmed and validated registration input
- validated email format and lengths
- validated profile fields and profile color
- restricted `avatar_url` updates to local avatar paths or `http(s)` URLs
- normalized login input handling

### Media privacy

File: [server/vod/routes.js](server/vod/routes.js)

- private VOD/clip file serving now checks visibility and ownership before streaming
- blocks direct filename-based access to private media

### WebSocket hardening

Files:
- [server/chat/chat-server.js](server/chat/chat-server.js)
- [server/streaming/call-server.js](server/streaming/call-server.js)
- [server/controls/control-server.js](server/controls/control-server.js)
- [server/streaming/broadcast-server.js](server/streaming/broadcast-server.js)
- [server/game/game-server.js](server/game/game-server.js)

- added payload caps
- disabled per-message compression on additional WS servers for lower abuse overhead where appropriate

### RTMP playback

File: [server/streaming/rtmp-server.js](server/streaming/rtmp-server.js)

- restricted HTTP-FLV origin in production to the configured base URL instead of `*`

### Monetization

File: [server/monetization/openvibe-bucks.js](server/monetization/openvibe-bucks.js)

- normalized currency amounts to finite 2-decimal numbers
- rejected invalid, negative, or excessive amounts
- validated PayPal email
- limited text field lengths for donation/cashout metadata
- validated donation goal title and amount

### Client-side XSS reduction

File: [public/js/app.js](public/js/app.js)

- changed toast rendering to use DOM text nodes instead of injecting raw HTML

## Deployment Assets Added

- [deploy/nginx/openvibe.live.conf](deploy/nginx/openvibe.live.conf)
- [deploy/systemd/openvibelive.service](deploy/systemd/openvibelive.service)
- [deploy/fail2ban/jail.local.example](deploy/fail2ban/jail.local.example)
- [deploy/cloudflare/checklist.md](deploy/cloudflare/checklist.md)
- [deploy/scripts/post-deploy-check.sh](deploy/scripts/post-deploy-check.sh)

## Remaining Risk Areas

These were identified but not fully refactored in this pass:

1. **Heavy `innerHTML` usage in frontend files**
   - especially in [public/js/app.js](public/js/app.js), [public/js/chat.js](public/js/chat.js), [public/js/admin.js](public/js/admin.js), and related UI modules
   - much of it appears escaped, but the safest long-term fix is to move more rendering to DOM node creation or audited template helpers

2. **Inline event handlers in generated HTML**
   - these increase XSS blast radius if escaping ever regresses

3. **Broad feature surface for alpha**
   - RTMP, HTTP-FLV, JSMPEG, WebRTC, uploads, thumbnails, emotes, VODs, clips, chat, controls, and game all increase attack surface
   - safest public alpha is still website + minimal streaming protocol set + closed registration

4. **Runtime and infra controls still matter**
   - Cloudflare, Nginx limits, UFW, fail2ban, and private origin protection are still required

## Recommended Next Security Steps

1. Replace higher-risk `innerHTML` rendering paths in chat/admin/player UIs.
2. Add a stricter production CSP once inline-script dependencies are reduced.
3. Add feature flags to disable RTMP, HTTP-FLV, JSMPEG, uploads, or registration when unused.
4. Add server-side per-route caps for stream creation, clip creation, and chat-log admin search if abuse is observed.
5. Consider moving auth tokens out of `localStorage` to secure cookies if the frontend architecture is later tightened for CSRF/XSS defense.

## Practical Best-Free Setup

For the safest inexpensive deployment:

- proxy only the website through Cloudflare
- keep registration closed by default
- use only the streaming protocol you actually need
- keep RTMP/HTTP-FLV/JSMPEG closed unless required
- keep VOD limits small during alpha
- restart the app after deploying these changes
