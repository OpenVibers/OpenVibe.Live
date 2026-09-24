# API Tokens

API tokens provide programmatic access to OpenVibe.Live for bots, integrations, and automation tools.

## Overview

- Tokens use the `hbt_` prefix for easy identification
- Each user can create up to **10 active tokens**
- Tokens are hashed with SHA-256 before storage — the raw token is shown only once at creation
- Tokens support scoped permissions and optional expiration
- The dashboard exposes integration presets, including a dedicated vibe-coding publisher preset

## Creating a Token

### Dashboard UI

1. Go to your **Dashboard**
2. Find the **API Tokens** card
3. Click **Create Token**
4. Enter a label or use a preset, select scopes, and optionally set an expiration
5. **Copy the token immediately** — it will not be shown again

### REST API

```bash
curl -X POST https://openvibe.live/api/auth/tokens \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"label": "My Bot", "scopes": ["chat", "read"]}'
```

Response:
```json
{
  "token": "hbt_a1b2c3d4e5f6...",
  "id": 1,
  "label": "My Bot",
  "scopes": ["chat", "read"]
}
```

## Scopes

| Scope | Access |
|-------|--------|
| `chat` | Send and receive chat messages via WebSocket |
| `read` | Read streams, VODs, user info |
| `stream` | Start/stop streams, update stream info |
| `control` | Hardware control bridge access |
| `vibe_coding_publish` | Publish sanitized coding-feed events to `/ws/vibe-coding/publish` |

## Recommended Presets

- `Chat Bot` → `chat`, `read`
- `GitHub Copilot Companion` → `read`, `vibe_coding_publish`
- `Stream Controller` → `read`, `stream`, `control`

## Using a Token

### REST API

Include the token in the `Authorization` header:

```bash
curl https://openvibe.live/api/streams \
  -H "Authorization: Bearer hbt_YOUR_TOKEN_HERE"
```

### Vibe Coding Publisher

For the OpenVibe.Live VS Code companion or any other coding-feed publisher, use a token with the `vibe_coding_publish` scope. It is the only scope `/ws/vibe-coding/publish` and the `/api/vibe-coding` writes accept; a `stream` token is refused there.

### WebSocket (Chat)

Send the token in an `Authorization: Bearer` header on the upgrade request (Node's `ws`, Python's `websockets` and most server libraries can), or as the `token` of your first `join` message (browsers cannot set headers):

```
wss://openvibe.live/ws/chat?stream=123
Authorization: Bearer hbt_YOUR_TOKEN_HERE
```

```json
{ "type": "join", "streamId": 123, "token": "hbt_YOUR_TOKEN_HERE" }
```

The token works everywhere a JWT would — the server auto-detects the `hbt_` prefix and validates accordingly. A `?token=` query parameter still works but is deprecated (compatibility shim C-05): URLs end up in proxy logs and browser history, so move to the header or the `join` message.

## Managing Tokens

### List tokens

```bash
curl https://openvibe.live/api/auth/tokens \
  -H "Authorization: Bearer YOUR_JWT"
```

### Revoke a token

```bash
curl -X DELETE https://openvibe.live/api/auth/tokens/TOKEN_ID \
  -H "Authorization: Bearer YOUR_JWT"
```

**Note:** Tokens cannot create or revoke other tokens (must use JWT auth for token management).

## Bot Example

A minimal Node.js chat bot:

```javascript
const WebSocket = require('ws');

const TOKEN = 'hbt_your_token_here';
const STREAM_ID = '123';

const ws = new WebSocket(`wss://openvibe.live/ws/chat?stream=${STREAM_ID}`, {
  headers: { Authorization: `Bearer ${TOKEN}` },
});

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'join', streamId: Number(STREAM_ID) }));
  console.log('Connected to chat');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'chat' && msg.message.startsWith('!hello')) {
    ws.send(JSON.stringify({
      type: 'chat',
      message: `Hello ${msg.username}!`
    }));
  }
});
```

## Security Notes

- Treat API tokens like passwords — never commit them to source control
- Use the narrowest scope necessary for your use case
- Prefer `vibe_coding_publish` over `stream` for coding-feed publishers so tokens stay least-privilege
- Set an expiration for tokens used in shared environments
- Revoke tokens immediately if compromised
- The `last_used_at` field in the token list helps identify unused tokens for cleanup
