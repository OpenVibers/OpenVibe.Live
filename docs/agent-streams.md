# Agent streams

An agent stream is an AI agent's screen on OpenVibe.Live: the desk on the person's machine publishes it with WHIP, Live
relays it with mediasoup, and a viewer watches it on the person's channel, in a task page or in the Dock. This page is the
S1 API (the Agent Streams design, 2026-11-06): the resource, the tickets, the curtain and the embed. There is no chat on
an agent stream in S1.

```
POST /api/streams/agent                    create it; answers the stream and its publish ticket
POST /whip/agent/<ags_id>                  the desk publishes with the ticket (WHIP)
GET  /api/streams/agent/<ags_id>           the stream (the view rule decides who may read it)
POST /whep/agent/<ags_id>                  a player that is not ours: its offer in, an SDP answer out
GET  /embed/agent/<ags_id>?vt=wvt_…        the player, for a task page or the Dock
```

## The stream

`live.agent-stream@1` is a `managed_streams` row of kind `agent` with a public id `ags_<ULID>`. It never has a stream key
and it never takes one of the person's normal stream slots: a person may have one agent stream live at a time (the Live
owner, five), and any number of offline ones — the cards stay with the last frame and the worked time.

| Field | What it is |
|---|---|
| `owner`, `channel` | the person (`usr_…`) and their Live channel |
| `task` | `{ source: codes\|actor\|desk\|node, ref, title, url? }` — what the agent is doing, and where |
| `visibility` | `private` (the owner and the people it is shared with), `unlisted` (anyone with the link), `public` |
| `mode` | `watch` in S1 (the field exists for narrated, co-pilot and chat plays) |
| `state` | `idle`, `live` or `ended` |
| `curtain` | `{ up, since? }` — the desk's privacy screen |
| `label` | always `AI agent` |

`POST /api/streams/agent` answers `201 { stream, publish: { whip_url, ticket, expires_at } }`. The ticket is shown once;
Live keeps only its SHA-256. The caller is the person's own session, or a first-party service token for audience
`openvibe.live` that holds `live.agent_stream.publish` and names the person (the token's `sub`, or `X-OV-Subject` when a
`svc:`/`node:` principal acts for them). Never a developer app, never another person's stream.

## The publish ticket

```
POST   /api/streams/agent/<ags_id>/ticket      a new ticket (the desk renews at three hours)
DELETE /api/streams/agent/<ags_id>/ticket      revoke it: the kill switch, the WHIP session ends at once
POST   /whip/agent/<ags_id>                    Authorization: Bearer wpt_…
```

A ticket lives four hours. A `wpt_` that does not verify, has expired, was revoked or names another stream answers `401
invalid_ticket`; a second WHIP session while one is up answers `409 already_publishing`; a person already at their live
limit answers `409 live.agent_stream_limit`. A ticket is bound to one session when the WHIP offer is accepted, and the
`Location` it answers with is `/whip/agent/<ags_id>/<resource>`.

## What the desk reads and sends

```
GET  /api/streams/agent/<ags_id>/state    { viewers, encode, curtain, ends_at }   every 10 s, with the ticket
PUT  /api/streams/agent/<ags_id>/frame    JPEG or WebP, at most 200 KB, with the ticket
POST /api/streams/agent/<ags_id>/curtain  { up, reason }
POST /api/streams/agent/<ags_id>/end
```

`encode` is true while anyone watches or the stream is public. While it is false the desk stops encoding and sends a
snapshot every five seconds; that frame is the card's picture and the task page's still. `ends_at` is the current
ticket's expiry — a stream whose ticket expires with no renewal ends.

## Watching

Live's own player joins `/ws/broadcast` as usual, and a private or unlisted stream carries a **view ticket**
(`?vt=wvt_…`). A third-party player (Node's latency probe, a WHEP-compatible player) uses the WHEP endpoint below.

```
POST /api/streams/agent/<ags_id>/view-ticket        { k? , renew? }
```

The owner's session gets one. So does a person the sharing system allows (`openvibe-sdk/share`, service `live`, kind
`agent-stream`) — the same sheet as everywhere else on the network. For an unlisted stream the secret is the link:
`/@person/agents/<ags_id>?k=<22 chars>`, stored hashed, and `POST /api/streams/agent/<ags_id>/rotate-link` closes the old
links. A view ticket lives ten minutes and renews itself while the page is open, at most four hours from the first mint.

Without a ticket a private stream's page answers `404` and the socket refuses the join (`4003 View ticket required`).
There is no other way in.

## WHEP (a player that is not ours)

```
POST   /whep/agent/<ags_id>                Authorization: Bearer wvt_…   (a public stream needs none)
DELETE /whep/agent/<ags_id>/<resource>     the viewer leaves; the stream keeps going
```

The offer goes in, an SDP answer comes out — the same shape as the WHIP side, `sendonly` from Live. The server
consumes the stream's audio and video for that viewer with the codecs the offer named, and its ICE/DTLS setup mirrors
`/whip` (Live is ice-lite and answers `setup:passive`). A private or unlisted stream needs a view ticket; a stream that
is not publishing answers `409 not_live`; an offer with no codec Live can send answers `406 no_compatible_codecs`.
CORS is the WHIP endpoint's (every origin, because the player is usually on someone else's page). The consumer is an
ordinary room consumer, so the curtain pauses it like any other viewer's, and a WHEP viewer counts as a viewer: the desk
keeps encoding while one is connected.

## The curtain

The desk blanks its own picture before this runs; Live is the second, independent enforcement. While the curtain is up,
every viewer's media consumer of that stream is paused — a desk that failed to blank still shows nothing — and every
player is told to show "Private screen". The reason (`password_field`, `secret_file`, `env_print`, `manual`, `site`,
`detector`) is kept for the owner and never reaches a viewer. The curtain comes down only from the desk, after its
detectors report clear for two seconds, or from the owner's own button.

## The pages

- **The owner's page:** `/@person/agents/<ags_id>` — the player, the task and its link, the visibility switch, the Share
  sheet, Curtain now and End. Others see the player and the `AI agent` label.
- **The embed:** `/embed/agent/<ags_id>?vt=wvt_…` — the player, the label, the curtain state and the viewer count. Its
  CSP `frame-ancestors` is the first-party origins only (Live, Network, Codes, Actor, Node, Tools), never `*`. A
  third-party iframe has no Live cookies, so Codes, Actor or the desk mints the view ticket server-side with the person's
  own token and puts it in the address.

## In S1

There is no chat, no voice, no Agents tab and no directory yet (S2 and later), and public streams do not appear anywhere
but their own page. The visibility switch offers Public, and the page disables it until S2.
