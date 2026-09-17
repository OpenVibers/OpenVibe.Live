# OpenVibe.Live Security Audit

Current as of **2026-09-17**. The original March 2026 audit is kept at the end as history.

Severity uses a realistic scale: **critical** (anyone can take over accounts, streams or money
today), **high** (a signed-in user can act on someone else's objects or run code), **medium**
(disclosure or abuse that needs specific conditions), **low** (hardening).

## 1. Threat boundaries

| Boundary | Who is on each side | What protects it |
|---|---|---|
| Browser → Live HTTP API | anonymous visitors, signed-in users, API tokens (`hbt_`) | `requireAuth`/`optionalAuth` (server/auth/auth.js), per-object ownership checks in routes, token scopes, rate limits (Express + nginx) |
| Browser → Live WebSockets | same | origin check + IP ban in the upgrade handler (server/index.js), per-server join/auth logic |
| Ingest (RTMP, WHIP) → Live | encoders holding a slot key | slot key lookup, WHIP slot-ownership check, key never returned by public APIs |
| Live → OpenVibe.Media | Live's app key, optionally "acting as" a Live user (`X-OV-User-Id`) | Media's tenant auth; **an app-key call without an acting user has full app authority** (see §4) |
| Live → OpenVibe.Network | JWT verification (RS256 public key), wallet client | signature checks, deadlines |
| Live → user-chosen URLs | song requests (yt-dlp/ffmpeg), kiosk link preview, chat relays | server/net/egress.js: connect-time public-address policy, redirect re-checks, loopback egress proxy for child processes |
| Staff → site | admin, global mod, owner (`is_owner`) | permissions.js role ranks; owner-only for money, secrets, admin grants |

## 2. Fixed in the 2026-09-16/17 pass

Each item below was verified by reading the code (the critical one also against production,
read-only). The Test column names the automated test that covers the fix (test/public-serializers and
test/authorization were also run against the previous code and failed there, case by case);
"manual" means the fix was reviewed and exercised by hand but has no automated test.

| Severity | Finding | Fix | Test |
|---|---|---|---|
| **Critical** | `GET /api/streams/channel/:username` (public) returned every slot's `stream_key` — confirmed on production. Anyone could publish to any streamer's slot. | Explicit public serializers (server/web/serializers.js) on channel, list, recent and detail responses; home ZIP and desk settings removed too. **All slot keys should be rotated after deploying.** | test/public-serializers.test.js |
| High | `POST /api/mod/delete-message` trusted a client `stream_id`: owning any stream allowed deleting any message site-wide. | Checks the message's own stream/channel. | test/authorization.test.js |
| High | Control-profile button edit/delete authorised the profile in the URL, not the button. | SQL scoped by `config_id`; 404 otherwise. | authorization |
| High | Media-request Vibes refund credited the requester even when taking the money back from the streamer failed (repeatable Vibes minting). | Deduction and credit in one transaction; no credit if the deduction fails. | authorization |
| High | A non-owner admin could demote/ban the owner or grant admin. | Owner/admin boundary on role changes and bans. | authorization |
| High | yt-dlp "extra args" (any admin) allowed `--exec`: command execution on the server. | Owner-only, allow-listed flags, disallowed saved values ignored at run time. | authorization |
| High | Pastes proxy sent anonymous requests to Media with app authority: forge pastes/comments as any user, delete any comment, list/read private pastes. | Identity fields stripped from bodies, owner-view switches stripped for anonymous callers, private pastes filtered, comment delete requires sign-in, anonymous write rate limit. | manual (needs Media) |
| High | API token scopes were stored but never enforced (a "read" token could cash out or use admin routes). | Scope enforcement in `requireAuth`/`optionalAuth`; money, staff and credential routes refuse tokens. | authorization |
| High | SSRF: IPv6 spellings of internal IPv4 (`[::ffff:7f00:1]`, NAT64, 6to4) passed the check; DNS rebinding and redirects were not re-checked; yt-dlp/ffmpeg resolved names themselves. | server/net/egress.js: address policy, connect-time lookup, per-hop redirect checks, loopback egress proxy for yt-dlp and ffmpeg (literal-IP bypass found by test and fixed); canonical URLs re-checked. | test/egress.test.js |
| High | Anyone could exhaust the WebRTC SFU: viewer sockets for any stream id created routers/transports. | Viewer sockets only for live streams, 16 per address, viewers never create routers. | manual |
| High | CCBill webhook credited whatever order id the buyer's form URL named (the price digest does not cover `X-order`): pay for a small order, credit a large one. PayPal return read the order before awaiting capture, so a webhook landing in between was credited twice. No webhook checked that the order belonged to that provider. | Provider and paid amount checked on every webhook (CCBill must report a price); orders re-read immediately before crediting; replayed subscription webhooks no longer extend the period. | authorization |
| Medium-High | Chat joined a room by client-supplied `channelUserId`: banned users could post into a channel room and skip its rules; `/ai` controlled other channels' bots. | Room derived from the stream; offline channel chat now applies the channel's latest stream's bans and settings. | security-redaction (ordering) |
| Medium | Relay-user hide/unhide: any user could hide site-wide or delete any channel's hide. | Staff for site-wide; channel moderators for their channel. | authorization |
| Medium | IP-approval queue authorised a channel id as a stream id (IP + geo disclosure). | `canModerateChannel`; review scoped to channel. | authorization |
| Medium | DM: a participant could add a third person to a private 1:1 (who then read the history). | Only group conversations accept new members; blocks checked against every member. | authorization |
| Medium | Hard-coded shared secret on `POST /api/cosmetics/internal-unlock` (in git history). | Configured internal key (timing-safe), or the legacy header from loopback only. | manual |
| Medium | `/banned/continue` trusted a plain display-name cookie (lift any account's ban) and wiped streamer-issued stream bans. | Signed id cookie; site-level bans only. | manual |
| Medium | Control WebSocket forwarded arbitrary command strings and any camera id. | Commands resolved from the stream's enabled buttons; cameras bound to the stream/owner. | manual |
| Medium | Clip upload filed arbitrary video under any stream's channel. | Only for live streams with clipping enabled. | manual |
| Medium | Kiosk link preview followed redirects to internal services and returned their `<title>`. | egress.fetchText. | egress |
| Medium | Chat-relay YouTube host check used `includes` (`youtube.com.evil`), unbounded fetch. | Exact host/subdomain match; guarded, size-capped fetch. | manual |
| Medium | Public VOD/clip lists passed `include_private` to Media under the app key. | Stripped on public lists. | manual |
| Medium | Stream keys in logs (RTMP publish/reject/end, restream command lines incl. SRT passphrases, RS worker ffmpeg line, node-media-server's own connect/publish/play lines). | server/utils/redact.js; the library logs errors only. | manual |
| Medium | OAuth callback skipped the state check when the cookie was missing (login CSRF). | State cookie required. | manual |
| Medium | Media request state (public + broadcast to chat) exposed server file paths and raw yt-dlp errors; `stream-url` returned raw errors to anyone. | Public projection; raw errors only for channel managers. | manual |
| Medium | Real-money Vibes balance and last-seen time on public profiles. | Only for the user themself. | manual |
| Low-Medium | Moderators could change owner policy (grant themselves About editing, disable IP approval). | Owner-only keys ignored for moderators. | manual |
| Low-Medium | Self-donation laundered bought Vibes into cash-out-able Vibes; donation stream id not bound to streamer. | Refused. | manual |
| Low-Medium | Channel-points redemption announced in any stream's chat. | Reward must belong to the stream's channel. | manual |
| Low-Medium | Anyone could set the saved playback position of any media request (unauthenticated). | Channel managers only. | authorization |
| Low-Medium | AI viewer "clone" copied any user's chat history from every channel (and their AI insight) into a bot. | Streamers clone only from what that person said in their own channel; staff unchanged. | authorization |
| Low-Medium | No limit on chat WebSocket connections per address. | 48 per address (admins exempt); clients back off to 30 s on a 4029 close. | test/chat-connection-cap.test.js |
| Low | Slot `control_config_id` accepted other users' profiles; restream viewer counts writable for any destination. | Ownership checks. | manual |
| Low | ONVIF discovery (LAN scan with default-password probing) available to every user. | Admin only, bounded timeout. | manual |
| Low | RobotStreamer API calls carrying the user's RS token disabled TLS verification. | Verification on for api.robotstreamer.com (valid certificate). | manual |
| Low | PowerChat test tip broadcast a fake donation to global chat. | Channel room only. | manual |
| Stability | Timer callbacks (RTMP/WHIP heartbeats, renewal sweep) could throw → `uncaughtException` → process exit → every live stream dropped. | Contained. | manual |
| Data integrity | The Vibes ×100 migration re-ran if its settings row was deleted (any admin can delete settings). | Versioned migration ledger (server/db/migrations.js); production shape adopted. | test/migrations.test.js |

Earlier in September (see git history): WHIP slot ownership, stored/reflected XSS in chat, paste
pages and OAuth pages, stream-key leak on `GET /api/streams` and the media channel endpoint, free
Vibes via unverified purchase, chat logs for non-staff, OAuth slot binding for restreams, ingest URL
validation, private VOD cache leak, HTTP-FLV bound to loopback, admin bans never cascading onto staff.

## 3. Content-Security-Policy status

- **Enforced** (helmet, server/index.js): `default-src 'self'` with explicit hosts; scripts still allow
  `'unsafe-inline'` because inline event handlers remain.
- **Report-only** on every HTML document (server/web/assets.js `cspReportOnly`): inline `<script>`
  elements allowed only by SHA-256 hash, `object-src 'none'`, `base-uri 'self'`, restricted
  `form-action` and `frame-ancestors`. Reports go to `POST /api/csp-report` (rate limited, aggregated,
  logged at most once a minute per directive+origin). Verified in Chrome: no report-only violations on
  `/`, `/broadcast`, `/@user`, `/documentation`, `/popout/global`.
- Next: move inline `onclick=` handlers to delegated handlers per route, then drop
  `script-src-attr 'unsafe-inline'` and enforce.

## 4. Remaining risks (not fixed)

| Severity | Risk | Why it is still open / what closes it |
|---|---|---|
| Medium | **Media trusts app-key calls with no acting user.** Live now scrubs anonymous requests, but any future Live route that forgets is app authority again. | Companion change in OpenVibe.Media: an explicit anonymous mode (e.g. `X-OV-Anonymous: 1`) that never trusts `user_id`. |
| Medium | Session token is readable by page scripts (`token`/`ov_token` cookies are not httpOnly; `localStorage.token`), and WebSocket URLs carry it. Any XSS steals the session. | Needs an OpenVibe.Network contract change (httpOnly session + short-lived socket tickets). Mitigation in the repo: deploy/nginx logs requests without query strings (apply to the live nginx), CSP report-only in place. |
| Medium | Inline event handlers keep `'unsafe-inline'` in the enforced CSP. | Progressive migration (see §3). |
| Medium | Per-address limits (broadcast viewers, rate limits) trust `CF-Connecting-IP`; if the origin is reachable without Cloudflare that header is spoofable. | Firewall the origin to Cloudflare ranges (deploy/cloudflare/checklist.md). |
| Low | Chat connect/close/join still scan every client to update counts. | Profile under load before indexing clients by room. |
| Low | RobotStreamer SFU WebSocket connections still skip certificate verification (hosts are assigned by RS at runtime). | Confirm RS SFU certificates and enable verification. |
| Low | Analytics roll-ups and the 90-day DELETE run synchronously on the main thread (vendor/openvibe-shared/analytics.js). | Companion change in OpenVibe.Network's openvibe-shared, then re-sync. |

## 5. Next hardening steps

1. Rotate every `managed_streams.stream_key` after the serializer fix is deployed.
2. OpenVibe.Media anonymous mode (§4).
3. Delegated handlers for inline `onclick` on the lazy routes first (broadcast, dashboard), then CSP enforcement.
4. httpOnly session + WebSocket tickets with OpenVibe.Network.
5. Load-test chat and index clients by room.

---

## History: March 2026 audit (2026-03-09)

That pass hardened the entrypoint (trust proxy, explicit CORS and WebSocket origin checks, auth and
upload rate limits), validated registration/profile input, gated private VOD/clip files, capped
WebSocket payloads, restricted HTTP-FLV origins, normalized monetization amounts, and rendered toasts
as text. Its "remaining risks" — heavy `innerHTML`, inline handlers, a broad alpha feature surface,
tokens in `localStorage`, and a stricter CSP — are tracked above in §3 and §4. The files it referred
to under `server/vod/`, `server/game/game-server.js`, `public/js/admin.js` and
`deploy/systemd/openvibelive.service` have since moved or been removed.
