# Bench on stream

A streamer starts a round from the Dashboard while live. Live asks Bench to create a public task and round, then waits for two usable entries. The watch page shows both entries. HTML entries use an empty iframe sandbox with a CSP that blocks scripts and network requests, matching Bench's Design HTML rules.

When the entries are ready, Live posts one chat line opening a 15–600 second vote. OpenVibe.Chat handles `!1`, `!2`, and `!tie` and forwards the signed-in viewer's Live user id and stream id through `POST /internal/chat-effects/bench-vote`. Live verifies the user's Network subject, excludes the streamer, and stores one vote per user per poll. A background job closes votes after the deadline and survives a restart because the poll, deadline, and votes are in Live's database.

Live casts a single Bench service judgement with `judge: audience_poll`, the two entry ids, the plurality outcome, and `vote_counts: { left, right, tie, voters }`. The result is a tie when `!tie` leads or the lead is shared. Bench treats a poll with viewers as one Elo game regardless of voter count; a zero-voter poll is recorded without changing ratings. The counts remain on the judgement for audit and the open dataset. Live then posts the result in chat.

Network must grant Live's service principal `bench.task.create`, `bench.round.create`, and `bench.judgement.cast` for audience `openvibe.bench`. Round reads are public. Set `OV_BENCH_INTERNAL_URL` to Bench's internal origin (default `http://127.0.0.1:5230`). Chat's existing `live.chat_effects.write` grant covers the vote effect.

Live passes the streamer's verified Network subject on task and round creation, so the daily per-person quota belongs to the streamer. Bench accepts this ownership header only from `service:live`; the judgement always belongs to the Live service. A pending poll is abandoned if its stream ends before its entries arrive.
