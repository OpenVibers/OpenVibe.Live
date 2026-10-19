# The Arena (retired 2026-10-19)

The Arena (`/arena`: ARENA ALERT, the Lolcow Index, Clout Rankings and mic-judged beefs) became **[The Rundown](rundown.md)**: what streamers talked about, written up, with no beefs, ratings or rankings. In the owner's words, the Arena was "kinda lame", and the Lolcow and Clout boards were "cringe".

- `/arena` and its pages redirect (301) to `/rundown`, and a fighter's `/arena/<username>` goes to `/rundown/<username>`.
- Chat still forwards the Arena's commands. `!arena [user]` answers with the streamer's latest episode and topics, and `!hype` and `!beef` say beefs are gone (`server/rundown/chat-commands.js`).
- The Rundown kept the Arena's opt-outs (`arena_opt_outs`), whole-name matching (`server/rundown/names.js`) and the line-in-their-chat-voice player (`server/rundown/voice.js`, setting `arena_voice_daily_max`).
- The Arena's pages, styles, jobs, `/api/arena` and AI portraits were removed on 2026-10-19. Its tables (roster, mic moments, beefs, drama, trash levels) are dropped by a later contract migration. Until then, account export and deletion still cover them (`server/auth/account-data.js`).
