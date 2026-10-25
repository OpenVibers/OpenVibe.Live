# Vibe Coding

Vibe coding feeds moved to **OpenVibe Chat** on 2026-10-24: make one at [openvibe.chat/feeds](https://openvibe.chat/feeds). A feed shows what you are building, live: Claude Code, GitHub Copilot or any tool sends each step (a prompt, a command, a file edited, the answer), and viewers follow along in a card above your channel's chat while you stream, in a Chat room, or embedded on your own site.

## What changed for streamers

- **Set up on Chat.** Make a feed on openvibe.chat/feeds and choose the channel slot it shows on. The card appears above that slot's chat whenever the slot is live. Live's stream workspace links there.
- **Claude Code needs no extension.** The feed page gives a `.claude/settings.json` block of Claude Code `http` hooks. Each prompt, tool use and answer is posted with your feed's key, and the hooks never block Claude Code.
- **Any other tool** posts the same canonical events (`session.status`, `prompt`, `response`, `thinking`, `tool.call`, `file.change`, `file.save`) to `POST https://openvibe.chat/api/chat/feeds/<feed>/events` with `Authorization: Bearer <feed key>`. Live's old `vibe-coding.event` envelopes are accepted as they are.
- **Safer by default.** Every step is scrubbed before it is stored: API keys and tokens, passwords, private keys, and your home folder. Viewers see only what your settings allow: prompts, answers, tools, what the tools were given, files, and thinking. The delay is held on the server, so nobody sees a step early.

## What Live answers now

- `wss://openvibe.live/ws/vibe-coding/publish` answers **410**, naming openvibe.chat/feeds.
- `/api/vibe-coding/*` answers **410** with `moved_to` and `api` links. For one release, a page of the previous release that asks `GET /api/vibe-coding/channel/:username/:slot/events` gets a feed that is switched off, so its widget stays hidden.
- API tokens no longer offer the `vibe_coding_publish` scope or the "GitHub Copilot Companion" preset. A feed has its own key.
- The channel chat frames Chat's card (`https://openvibe.chat/embed/feed/<feed>`). It finds the card by asking Chat which feed a slot shows: `GET https://openvibe.chat/api/chat/feeds?slot=<managed stream id>`.

Live's old `vibe_coding_sessions` and `vibe_coding_events` were copied to Chat and verified (Chat's `scripts/import-live-feeds.js`), each slot keeping its newest 5,000 events. Nothing in Live reads them any more (`test/vibe-coding-moved.test.js`), and a contract migration drops them.

The full reference is Chat's README, section "Feeds: vibe coding, live".
