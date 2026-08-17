# OpenVibe.Live — Restream Channel Branding Guide

> These Twitch/Kick/YouTube channels exist to **advertise OpenVibe.Live** and funnel viewers to the main platform. Every element should make visitors curious about OpenVibe.Live and give them a reason to come over.

**Brand colors:** Violet accent `#8b5cf6`, light violet `#a78bfa`, deep violet `#6d28d9`, cyan secondary `#22d3ee`, dark background `#131318`, live red `#e74c3c`
**Logo motif:** Play triangle inside a broadcast ring + signal waves (see `public/assets/logo.svg`)
**Tagline:** "Free & Open Live Streaming"
**URL:** `https://openvibe.live`
**OpenVibe.Network (SSO / accounts):** `https://openvibe.network`
**OpenVibe.Tools:** `https://openvibe.tools`
**Scraplandia (game):** `https://play.openvibe.games`
**Discord:** `https://discord.gg/M6MuRUaeJj`
**GitHub:** `https://github.com/OpenVibers`

---

## 1. Profile Avatar / Profile Picture (All Platforms)

Used as: Twitch profile picture, Kick avatar, YouTube channel icon. Should be recognizable at small sizes (110×110 on Twitch, even smaller in chat).

### Image Generation Prompt

> **Prompt:** A minimalist logo icon on a pure black background. A bold play-button triangle in violet (#8b5cf6) centered inside a thin gradient ring (violet #a78bfa to deep violet #6d28d9). Two curved broadcast/WiFi signal arcs emanate from the top-right of the ring in violet, with a tiny red (#e74c3c) "live" dot at the signal origin. Clean vector style, no text, flat design with subtle depth. Square format, centered composition. High contrast against black for readability at small sizes.

### Notes
- Keep it simple — this is viewed at 28–110px. No fine details.
- The existing SVG logo at `public/assets/logo.svg` is the reference design.
- Generate at **512×512** minimum, export as PNG with transparent or black background.
- Use the same avatar across all three platforms for brand consistency.

---

## 2. Profile Banner / Channel Banner

Used as: Twitch profile banner (1200×480), Kick banner (1920×480), YouTube banner (2560×1440 safe area 1546×423).

### Image Generation Prompt

> **Prompt:** A wide cinematic banner for a streaming channel. A dark near-black backdrop (#131318) with soft neon-violet light trails and a subtle audio-waveform ribbon in cyan (#22d3ee) flowing across the lower third. On the right side in clean modern sans-serif typography: "OpenVibe.Live" in large violet (#8b5cf6) text, and below it in smaller white text: "Free & Open Live Streaming — openvibe.live". Subtle broadcast signal arcs near the text suggest live streaming. Dark cinematic color grading with violet and cyan glows. Wide aspect ratio (21:9 or wider). No people, no faces.

### Notes
- Generate at **2560×1440** to cover YouTube's requirement, then crop to platform sizes.
- Keep key text/elements in the center safe zone (1546×423) so it's visible on all devices.
- Alternative: Generate without text and add "OpenVibe.Live" + "openvibe.live" yourself in an image editor for crisper typography.

---

## 3. Under-Stream Panels (Twitch & Kick)

Twitch and Kick both support info panels below the stream. Standard panel image size: **320×100 px** (Twitch) or similar banners. Each panel has a **header image** and **description text** below it.

---

### Panel 1: "Watch on OpenVibe.Live" (THE MAIN CTA)

This is the most important panel — it should be the first one visitors see.

#### Header Image Prompt

> **Prompt:** A streaming panel header banner (320×100 pixels, 3.2:1 ratio). Dark background (#131318). On the left, a small play-triangle-in-ring icon in violet (#8b5cf6). In the center, bold modern text reading "WATCH ON OPENVIBE.LIVE" in violet. A subtle right-pointing arrow or "go" indicator on the right side. Clean, minimal, high contrast. Flat design.

#### Description Text

```
▶ This stream is rebroadcast from OpenVibe.Live — a free, open-source streaming platform run by its community.

👉 Watch the FULL experience at:
   https://openvibe.live/Goosely

✅ No ads, no subs, no paywalls
✅ Interactive chat with emotes & cosmetics
✅ Clips, VODs & AI highlights
✅ Open source — run your own instance

Come hang out on the real thing!
```

---

### Panel 2: "About This Stream"

#### Header Image Prompt

> **Prompt:** A streaming panel header banner (320×100 pixels). Dark background (#131318). A small broadcast-waves icon on the left in violet outline. Bold text reading "ABOUT" in clean white sans-serif, with a thin violet (#8b5cf6) underline accent. Minimal, flat design, high contrast.

#### Description Text

```
This is a rebroadcast from OpenVibe.Live — a self-hosted, open-source live streaming platform for indie streamers and IRL creators.

The stream you're watching originates at openvibe.live where you'll get the best quality, lowest latency, and full interactive features.

The platform is 100% free, open source, and community-driven.
```

---

### Panel 3: "Why OpenVibe.Live?"

#### Header Image Prompt

> **Prompt:** A streaming panel header banner (320×100 pixels). Dark background (#131318). A glowing violet play-button icon on the left. Bold text "WHY OPENVIBE.LIVE?" in violet (#8b5cf6), clean modern font. Subtle broadcast signal arcs as a watermark in the background. Minimal flat design.

#### Description Text

```
💜 Why watch on OpenVibe.Live instead of here?

• Better stream quality (direct, not reencoded)
• Lower latency — chat in real time
• Custom emotes, hats, name effects & particles
• Auto VODs, clips & AI highlights
• Scraplandia — the community browser game
• No corporate algorithms, no ads
• Built by the community, for the community

→ openvibe.live
```

---

### Panel 4: "Community / Discord"

#### Header Image Prompt

> **Prompt:** A streaming panel header banner (320×100 pixels). Dark background (#131318). The Discord logo (simplified blurple circle) on the left. Bold text "JOIN THE COMMUNITY" in white with a violet (#8b5cf6) accent line. Clean, minimal, flat design.

#### Description Text

```
💬 Join the OpenVibe Discord!

Chat with the community, suggest features, report bugs, or just hang out.

→ https://discord.gg/M6MuRUaeJj
```

---

### Panel 5: "Open Source"

#### Header Image Prompt

> **Prompt:** A streaming panel header banner (320×100 pixels). Dark background (#131318). A code bracket icon "< />" or Git branch icon on the left in violet (#8b5cf6). Bold text "OPEN SOURCE" in white. A subtle GitHub octocat silhouette watermarked in the background at low opacity. Clean flat design.

#### Description Text

```
🛠️ OpenVibe.Live, OpenVibe.Tools, Scraplandia, and the whole OpenVibe network are fully open source:
https://github.com/OpenVibers

The entire platform — streaming server, chat, media pipeline, game, everything — is on GitHub. Run your own instance, contribute, or just read the code.

⭐ https://github.com/OpenVibers

Built with Node.js, WebSockets, SQLite, FFmpeg, and mediasoup.
```

---

### Panel 6: "OpenVibe.Tools"

#### Header Image Prompt

> **Prompt:** A streaming panel header banner (320×100 pixels). Dark background (#131318). A multi-tool/wrench icon on the left in violet (#8b5cf6). Bold text "OPENVIBE.TOOLS" in violet, with smaller subtitle "200+ Free Web Tools" in white below. Clean flat design, high contrast.

#### Description Text

```
🧰 OpenVibe.Tools — 200+ Free Web Tools

Calculators, converters, maps, dev utilities, media tools and more — built by the OpenVibe community, free for everyone.

100% free, open source, and community-driven.

→ https://openvibe.tools
```

---

### Panel 7: "Scraplandia"

#### Header Image Prompt

> **Prompt:** A streaming panel header banner (320×100 pixels). Dark background (#131318). A scrap-metal gear or quest compass icon on the left in violet (#8b5cf6). Bold text "SCRAPLANDIA" in violet, with smaller subtitle "Community MMORPG & Canvas" in white below. A faint junkyard-fantasy map texture in the background at very low opacity. Clean flat design.

#### Description Text

```
⚙️ Scraplandia — Community MMORPG & Canvas

A custom-built browser MMORPG and collaborative canvas made by the OpenVibe community. Scrap, quest, and create together — no downloads required.

100% free, open source, and community-driven.

→ https://play.openvibe.games
```

---

## 4. Channel Bio / About Section

### Twitch Bio (300 char max)

```
▶ Rebroadcast from OpenVibe.Live — free & open live streaming, run by its community. Better quality + interactive chat + clips & VODs on the real site → openvibe.live | openvibe.tools | openvibe.games | Discord: discord.gg/M6MuRUaeJj
```

### Kick Bio

```
▶ This stream is rebroadcast from OpenVibe.Live — a free, open-source live streaming platform built by its community. Watch the real stream with full features at openvibe.live
```

### YouTube Channel Description

```
OpenVibe.Live — Free & Open Live Streaming ▶

This channel rebroadcasts live streams from OpenVibe.Live, a free and open-source streaming platform run by its community.

For the best experience — better quality, lower latency, interactive chat, custom emotes, clips & VODs, and the Scraplandia browser game — watch directly at:
🔗 https://openvibe.live

OpenVibe.Live is 100% free, open source, and community-driven.
📂 Source code: https://github.com/OpenVibers
💬 Discord: https://discord.gg/M6MuRUaeJj
🧰 OpenVibe.Tools: https://openvibe.tools
⚙️ Scraplandia: https://play.openvibe.games
```

---

## 5. Stream Title Templates

Use these as your stream title on Twitch/Kick/YouTube to drive traffic:

```
▶ Live from OpenVibe.Live — Watch the real stream at openvibe.live!
```
```
Rebroadcast from OpenVibe.Live — Full experience at openvibe.live 💜
```
```
🔴 LIVE on OpenVibe.Live — Free & open live streaming | openvibe.live
```

---

## 6. Stream Category / Tags

### Twitch
- **Category:** "Just Chatting" or "IRL" (or whatever fits the stream content)
- **Tags:** `OpenSource`, `IRL`, `SelfHosted`, `Community`, `Indie`

### Kick
- **Category:** "Just Chatting" or "IRL"

### YouTube
- **Tags:** `live`, `live streaming`, `open source`, `IRL`, `self-hosted`, `community`, `indie streaming`

---

## 7. Offline Screen / Thumbnail (Optional)

Shown when the stream is offline.

### Image Generation Prompt

> **Prompt:** A streaming offline screen (1920×1080). A moody near-black backdrop (#131318) with a dim violet play-button-in-ring logo at low glow and a faint cyan waveform ribbon settling flat across the lower third, as if the signal has gone quiet. Centered text in large violet (#8b5cf6) sans-serif: "STREAM OFFLINE" with smaller white text below: "Watch live at openvibe.live". The overall mood is calm, end-of-night. Dark color grading with soft violet highlights. Cinematic composition.

---

## 8. Stream Overlay Watermark (Optional)

A small persistent watermark in the corner of the stream itself.

### Image Generation Prompt

> **Prompt:** A small transparent watermark badge (300×80 pixels, PNG with transparency). Text reading "openvibe.live" in clean white sans-serif with a subtle dark drop shadow for readability on any background. A tiny violet play-triangle icon before the text. Semi-transparent (designed to be placed at 30-50% opacity in OBS). No background.

### OBS Setup
- Add as an Image source in OBS
- Position: bottom-right corner
- Opacity: 30–50%
- This ensures every frame of the restream advertises the URL

---

## Quick Reference: Image Sizes

| Asset | Twitch | Kick | YouTube |
|-------|--------|------|---------|
| Avatar | 256×256 (shown 112×112) | 256×256 | 800×800 |
| Banner | 1200×480 | 1920×480 | 2560×1440 (safe: 1546×423) |
| Panel headers | 320×100 | ~320×100 | N/A (use cards) |
| Offline screen | 1920×1080 | 1920×1080 | 1920×1080 |
| Thumbnail | 1280×720 | 1280×720 | 1280×720 |

---

## Tips

- **Consistency is key** — use the same avatar, same violet-on-dark palette, same "OpenVibe.Live" branding across all platforms so people recognize the brand.
- **The URL is the payload** — every single element should contain or point to `openvibe.live`. It's the whole reason these channels exist.
- **Keep it genuine** — don't try to compete with Twitch/Kick/YouTube. Frame it as "the real stream is over there, this is just a taste."
- **Pin a chat message** on Twitch/Kick with: `▶ Watch the full stream with interactive chat at https://openvibe.live`
