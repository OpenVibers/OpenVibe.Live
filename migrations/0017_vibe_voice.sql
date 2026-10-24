-- phase: expand
-- Vibe on stream (server/ai/vibe-voice.js; plan track K, 2026-10-24): a streamer's call word, said on stream, wakes
-- Vibe, OpenVibe's assistant, to clip the moment or answer in the stream's chat. Off unless the streamer turns it on.
-- speak: Vibe's answers are also read aloud (Chat's TTS) on the stream.
CREATE TABLE IF NOT EXISTS channel_vibe_settings (
    user_id    bigint PRIMARY KEY,
    enabled    smallint NOT NULL DEFAULT 0,
    call_word  text NOT NULL DEFAULT 'hey vibe',
    speak      smallint NOT NULL DEFAULT 0,
    updated_at text
);
