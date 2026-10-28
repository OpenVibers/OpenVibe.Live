# Streamer Dashboard

The dashboard is your control center for managing your channel. Access it by logging in and clicking your username.

## Schedule

The home tab's Schedule card lists your next streams from [OpenVibe.Today](https://openvibe.today/) and links to its
schedule form. A scheduled stream shows on your channel while you are offline ("Next stream", with Remind me), in your
followers' bells (at most three new schedules a day) and in calendars that subscribe to `openvibe.today/ics/@you.ics`;
going live marks it live. Live keeps no copy: `GET /api/today/channel/:username` reads Today's public API and keeps the
answer a minute.

## Stream Key

Your RTMP stream key is shown (hidden by default) for use with OBS, Streamlabs, or other RTMP software. You can regenerate it at any time — this invalidates the old key.

## API Tokens

Create long-lived API tokens for bots and integrations. Tokens authenticate via the `Authorization: Bearer hbt_...` header for REST API and chat WebSocket connections.

Available scopes: `chat`, `read`, `stream`. (A vibe coding feed has its own key on openvibe.chat/feeds since 2026-10-24.)

See [API Tokens](api-tokens.md) for full details.

## Vibe on stream

The **Chat AI** tab's first card. Turn on **Listen for my call word** and say it on stream ("hey vibe" unless you set
your own: 1 to 4 words, 3 to 40 characters), and Vibe, OpenVibe's assistant, acts on what you say next:

- **"hey vibe, clip that"** (also clip it, clip this, make a clip, save that) clips the 45 seconds before you said it
  from the recording and posts the link in your chat.
- **Anything else** ("hey vibe, what was the score last night?") is answered in your chat in a sentence or three, from
  your stream's title and category and what you said in the last few minutes. Turn on **Read Vibe's answers aloud** to
  hear them through chat's text-to-speech.

Vibe hears through the stream's live captions (the live timeline), about 10 to 20 seconds behind live, so it needs
OpenVibe's live captions on (`ai_timeline_enabled`) and a recording for clips. It wakes at most once every 8 seconds
of stream time, never describes anyone's looks, and its lines are AI lines in your chat. Settings: `GET/PUT
/api/vibe/settings` `{ enabled, call_word, speak }` (`server/ai/vibe-voice.js`, table `channel_vibe_settings`).

## AI chat viewers: what they think with

The **Chat AI** tab's **AI Chat Viewers** card, under **Key & Budget**, **AI source**:

- **OpenVibe.Live shared AI.** It has a daily budget you set; when today's spend reaches it, the viewers go quiet until
  tomorrow.
- **My own API key.** OpenAI, Anthropic, or any OpenAI-compatible endpoint (OpenRouter, Groq), with no cap from us.
  The key is kept encrypted in OpenVibe.AI, never in Live, and **Test connection** tries it.
- **A model on my own computer (free).** Ollama, LM Studio or llama.cpp's server on your own PC, through the OpenVibe
  Node, with no port opened.
  - **Set it up.** Install it with `--ai` from [openvibe.bot/machines](https://openvibe.bot/machines), then turn on
    "Let my AI use this computer's models" for that computer there.
  - **Fill in the card.** Name the computer (its `dev_` id from that page) or tick **Any of my computers that is on**
    (the fastest first, the next when one is busy), name the model as your model server does, save, then
    **Test my computer**.
  - **What it does.** Your computer writes the chat lines. Frames from the stream are described by the site's shared
    vision when it is on.
  - **Only yours.** It is never used for anyone else's channel. When your computer is off, the viewers wait: nothing
    else answers in its place.

## Chat Logs

View and manage chat messages from your streams:
- **Search** by message content or username
- **Filter** by date range
- **Purge** messages in a time range (soft-delete — excluded from future replay)

Purged messages are broadcast to live chat clients and excluded from VOD chat replay automatically.

## Emotes

Upload custom channel emotes (PNG, GIF, WebP, AVIF, up to 256KB). Toggle emote sources:
- Custom (your uploads)
- Defaults (built-in)
- FFZ, BTTV, 7TV (third-party)

## VODs & Clips

- **My Videos** — All your recorded streams. Toggle public/private, bulk delete by age.
- **My Clips** — Clips you've taken from other streams. Only clips a person made: the AI's clips of your stream are never listed as yours.
- **Clips of My Stream** — Clips people have taken from your streams. Publish or delete.
- **AI Moments** — Clips OpenVibe's AI cut from your streams when chat reacted, with a count on the tab. They are labelled "AI clip · from your stream" everywhere, credited to no one, and kept out of search. Publish, unlist or delete them here.

## AI Moments from my streams

On the **Home** tab, *Let OpenVibe's AI make Moments from my streams* (on by default) is the channel's switch for everything the AI derives from your streams and publishes: auto-clips, the frames it posts as AI notes (from VODs and "caught live") and the AI-written after-show report. Turned off, none of those jobs touch your channel and your after-show report is the stats-only one. Moments already made stay until you delete them. The stream's AI overview, captions and the AI chat bot are separate settings. A category the AI inferred for your stream is shown as "Gaming · inferred" on your channel and on VOD and clip pages.

## Currency System

- **Vibes** — Real money donations. Cash out when ready.
- **OpenVibe Nickels** — Free loyalty currency earned by viewers for watching and chatting.
- **Coin Rewards** — Create custom rewards viewers can redeem with Nickels (TTS, sound effects, chat highlights, etc.)
- **Redemption Queue** — Fulfill or reject viewer reward redemptions.

## Your robot

On the **Robot & API** tab, put the id of a robot you paired on [OpenVibe.Bot](https://openvibe.bot/robots/new) (a Raspberry Pi car, a Cozmo, a phone or an ONVIF pan-tilt camera). Its live panel shows under your stream, and chat drives it with `!forward`, `!backward`, `!left`, `!right`, `!headup`, `!liftup` and `!say`, each passed to Bot as the viewer who typed it; who may drive is the robot's own setting on Bot.

## Donation Goals

Create funding goals visible to viewers during your stream.
