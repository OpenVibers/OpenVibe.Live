# Channel embeds

`GET /embed/<username>` (also `/embed/@<username>`) renders a small, chat-free player suitable for a floating mini player on another OpenVibe site. It uses the same `/ws/broadcast` stream player as the channel page. Playback starts muted; the parent can control it with `postMessage`.

Commands sent by the parent:

```js
frame.contentWindow.postMessage({ type: 'ov-embed', cmd: 'unmute' }, 'https://openvibe.live');
```

`cmd` may be `mute`, `unmute`, `play`, or `pause`. The frame accepts commands only from origins in Network's `/api/frame` list (cached for five minutes), plus `*.openvibe.website`; a checked-in first-party list is used if Network is unavailable.

The frame sends `{type:'ov-embed', event:'state', live, muted, playing, title, username, viewers}` on load and whenever playback or channel state changes. The payload contains only public channel data. Listen for it with `event.data.type === 'ov-embed' && event.data.event === 'state'`.

Channels marked 18+ show an age confirmation before the player starts, matching the channel page's gate. Offline channels show their public avatar and an offline label.
