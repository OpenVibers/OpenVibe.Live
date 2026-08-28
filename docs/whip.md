# WHIP Ingest API

OpenVibe.Live accepts live video over **WHIP** (WebRTC-HTTP Ingestion Protocol, [RFC 9725](https://www.rfc-editor.org/rfc/rfc9725)). Anything that can produce a WebRTC offer can go live with a single HTTP request — OBS 30+, FFmpeg 7+, GStreamer, hardware encoders, **and a plain web page**.

> **Can a frontend-only site stream to WHIP?** Yes. The endpoint is open to every origin (CORS `*`) and authenticates with your stream key, so a static page with no backend can publish straight from the browser using only `RTCPeerConnection` + `fetch()`. Jump to [Publishing from a browser](#publishing-from-a-browser), or try the hosted single-file demo at **<https://openvibe.live/whip-publisher.html>** (view-source to copy it).

## Endpoint

```
POST https://whip.openvibe.live/whip/{streamKey}
Content-Type: application/sdp
```

| URL form | Credential | Use it when |
|---|---|---|
| `/whip/{streamKey}` | the key is in the path (optionally also as `Authorization: Bearer {streamKey}` — OBS sends both) | **Default.** Browsers, FFmpeg, GStreamer, OBS. |
| `/whip/{slotId}` | `Authorization: Bearer {streamKey}` or `?key={streamKey}` | Tools that want a stable, non-secret URL with the secret in a header. |
| `/whip/{streamSessionId}` | `Authorization: Bearer {openvibe.network JWT}` | Internal / legacy. Requires an already-live session; `hbt_` API tokens are **not** accepted here. |

`{streamKey}` is a 32-char hex string that belongs to one **stream slot** (a "managed stream"). Posting to it auto-creates a live session on that slot if none exists — you do not need to click *Go Live* first. The slot's streaming method must be **Browser** or **WHIP** (protocol `webrtc`); RTMP/JSMPEG slots answer `409 wrong_protocol`.

### Getting your WHIP URL

- **UI:** *Broadcast → your stream → Streaming method: WHIP* → copy the WHIP URL. (Same URL the OBS instructions show.)
- **API:** `GET /api/streams/managed/{slotId}/profile` (JWT or `hbt_` token) returns `stream_key` and `whip_url_base`; the URL is `${whip_url_base}/whip/${stream_key}`.

Treat the URL as a password: anyone holding it can broadcast to your channel. Regenerate the key from the dashboard if it leaks.

## Session lifecycle

1. **`POST /whip/{streamKey}`** with the SDP offer as the body.
   `201 Created` · body is the SDP answer (`Content-Type: application/sdp`) · `Location` header is the **session resource URL** — keep it.
2. Apply the answer, and ICE/DTLS connect. The stream is shown as live once media flows (the *Live* state in your app corresponds to `RTCPeerConnection.connectionState === 'connected'`).
3. **`PATCH {Location}`** (`Content-Type: application/trickle-ice-sdpfrag`) — accepted and acknowledged with `204`, but **not required**: the server is an ICE-lite agent and includes all of its candidates in the answer, so a client never needs to trickle. Browsers can post the offer immediately after `setLocalDescription()` without waiting for gathering.
4. **`DELETE {Location}`** — ends the session. When the last session on a stream is gone, the stream ends (VOD finalises, restreams stop, viewers are notified). Sessions also end on their own if ICE fails, or 15 s after ICE reports `disconnected` without recovering.

Posting a second offer to the same slot replaces the previous session (useful for reconnecting after a network change).

## Media requirements

| | Accepted | Notes |
|---|---|---|
| Video | **VP8**, **H.264** (Constrained Baseline, `profile-level-id=42e01f`, `packetization-mode=1`) | The server takes the **first** codec in your offer that it supports. AV1 / VP9 / HEVC are skipped; if nothing else is offered you get `406 no_compatible_codecs`. |
| Audio | **Opus** 48 kHz (mono or stereo) | |
| Encodings | one per m-section (SSRC or a single RID) | No simulcast / SVC — offer a single encoding. RTX (`a=ssrc-group:FID`) is supported. |
| Transport | BUNDLE, `rtcp-mux`, DTLS-SRTP | Offer `a=setup:actpass`; the answer is `a=setup:passive` + `a=ice-lite`. A data-channel m-section is rejected (`port 0`) but does not fail the offer. |

No STUN/TURN is needed: the server sits on a public address and the client connects straight to the candidates in the answer. Outbound UDP must be allowed.

## Errors

Errors are JSON (`{ "error": "...", "error_code": "..." }`) and also carry the code in an `X-WHIP-ERROR` header, which is exposed to cross-origin callers.

| Status | `X-WHIP-ERROR` | Meaning |
|---|---|---|
| 400 | `missing_sdp` / `invalid_sdp` / `invalid_rtp_encoding` / `invalid_stream_id` | Body is not a usable SDP offer (e.g. a video section with no SSRC or RID). |
| 401 | `invalid_stream_key` / `bearer_mismatch` / `invalid_key` / `invalid_token` / `authentication_required` / `user_not_found` | Key or token not recognised, or path key ≠ bearer key. |
| 403 | `user_banned` / `not_your_stream` | |
| 404 | `slot_not_found` / `stream_not_found` / `session_not_found` | The last one is a `PATCH`/`DELETE` to a resource that already ended. |
| 406 | `no_compatible_codecs` | Offer only VP8 / H.264 / Opus. |
| 409 | `wrong_protocol` / `stream_not_live` | Slot is set to RTMP/JSMPEG (change the streaming method), or (JWT form) session is not live. |
| 502 | `transport_creation_failed` / `dtls_negotiation_failed` / `producer_creation_failed` | SFU could not set up the session — retry. |
| 503 | `sfu_unavailable` / `whip_unavailable` | Server-side WebRTC is down. |

## Cross-origin (CORS)

Every `/whip/*` response, including errors, carries:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, If-Match
Access-Control-Expose-Headers: Location, X-WHIP-ERROR
```

There are no cookies involved, so `credentials` is never needed — call `fetch()` normally. You can verify from a shell:

```bash
curl -si -X OPTIONS https://whip.openvibe.live/whip/x \
  -H 'Origin: https://my-static-site.example' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
# → HTTP/2 204 with the headers above
```

## Publishing from a browser

> **Direct link to this section:** <https://github.com/OpenVibers/OpenVibe.Live/blob/main/docs/whip.md#publishing-from-a-browser>
> Everything needed to build a browser-only publisher is in this section — copy it whole into your AI assistant or your notes.

**Spec in five lines (paste-ready):**

```text
OpenVibe.Live WHIP ingest — browser publisher requirements
1. POST the SDP offer to https://whip.openvibe.live/whip/<streamKey> with Content-Type: application/sdp. No cookies, no other auth; CORS is open (*).
2. Expect 201; body = SDP answer (application/sdp); Location header = session resource URL (read it — it is exposed via CORS).
3. Offer: one audio + one video m-section, a=setup:actpass, BUNDLE + rtcp-mux, single encoding (no simulcast). Codecs: VP8 or H.264 (42e01f, packetization-mode=1) + Opus 48k. AV1/VP9/HEVC are ignored.
4. No STUN/TURN needed (server is ICE-lite); do not wait for ICE gathering; PATCH/trickle is optional.
5. Stop with DELETE <Location> (use fetch keepalive on pagehide). Errors: JSON + X-WHIP-ERROR header (see table above).
```

A complete publisher is about forty lines. This is the core of [`whip-publisher.html`](../public/whip-publisher.html) (hosted at <https://openvibe.live/whip-publisher.html>), which adds a UI, screen-share, bitrate stats and clean-up on tab close:

```html
<video id="preview" autoplay muted playsinline></video>
<button id="go">Go live</button>
<script>
const WHIP_URL = 'https://whip.openvibe.live/whip/<your-stream-key>';
let pc, resourceUrl;

async function goLive() {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: true,
    });
    document.getElementById('preview').srcObject = stream;

    pc = new RTCPeerConnection({ iceServers: [] });        // ICE-lite server: no STUN needed
    for (const track of stream.getTracks()) {
        pc.addTransceiver(track, {
            direction: 'sendonly',
            sendEncodings: track.kind === 'video' ? [{ maxBitrate: 2_500_000 }] : undefined,
        });
    }
    pc.onconnectionstatechange = () => console.log('connection:', pc.connectionState);

    await pc.setLocalDescription(await pc.createOffer());   // no need to wait for ICE gathering

    const res = await fetch(WHIP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
    });
    if (res.status !== 201) {
        throw new Error(`WHIP ${res.status} ${res.headers.get('X-WHIP-ERROR') || ''}`);
    }
    resourceUrl = new URL(res.headers.get('Location'), WHIP_URL).href;
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
}

async function stop() {
    if (resourceUrl) await fetch(resourceUrl, { method: 'DELETE', keepalive: true });
    pc?.close();
}

document.getElementById('go').onclick = () => goLive().catch(console.error);
addEventListener('pagehide', () => resourceUrl && fetch(resourceUrl, { method: 'DELETE', keepalive: true }));
</script>
```

Things worth knowing:

- **Secure context.** `getUserMedia` only works on `https://`, `localhost`, or a local `file://` — plain `http://` hosting will not get camera access.
- **Screen share.** Swap `getUserMedia` for `navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })`. Listen for the video track's `ended` event — that is the browser's own *Stop sharing* button.
- **Codec choice.** Chrome and Firefox offer VP8 first, Safari offers H.264 first; both are accepted as-is. If you use `RTCRtpTransceiver.setCodecPreferences()`, keep VP8 or H.264 at the front — the server negotiates the first supported codec it sees.
- **Bitrate.** Set `maxBitrate` in `sendEncodings` (or later via `sender.setParameters()`); 2.5 Mbps for 720p30 and 4.5 Mbps for 1080p30 are good defaults.
- **Reconnecting.** On `connectionState === 'failed'`, build a fresh `RTCPeerConnection` and `POST` again — the new session replaces the old one on the same slot, and viewers pick up automatically.
- **Ending cleanly.** Always `DELETE` the resource (use `keepalive: true` so it survives tab close). If you don't, the stream lingers until the 15-second ICE grace period expires.
- **The key is visible in the page.** That is inherent to a backend-less publisher and the same trust model as OBS; keep the page private (or have the streamer paste their own key at runtime, as the hosted demo does) rather than committing a key into a public repo.

## Other clients

- **OBS Studio (30+):** *Settings → Stream → Service: WHIP*, Server = the WHIP URL, Bearer Token = your stream key.
- **FFmpeg (7.0+):** `ffmpeg -re -i input.mp4 -c:v libx264 -profile:v baseline -level 3.1 -pix_fmt yuv420p -c:a libopus -f whip "https://whip.openvibe.live/whip/<streamKey>"`
- **GStreamer:** `... ! whipsink whip-endpoint="https://whip.openvibe.live/whip/<streamKey>"` (needs `gst-plugins-rs`).

The Broadcast page shows ready-to-paste commands for each with your key filled in. See [Broadcasting Guide](broadcasting.md) for the other ingest methods.
