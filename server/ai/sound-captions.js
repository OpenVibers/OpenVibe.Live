'use strict';

/**
 * sound-captions.js — what a stream's audio classifier heard, as caption cues: "[laughter]", "[applause]", "[music]"
 * (item 151, C15: grounded audio descriptions). The VOD's captions on OpenVibe.Video carry them between the spoken
 * lines, the way captions for deaf and hard-of-hearing viewers name the sounds that matter.
 *
 * Grounded by construction: every cue is one of a short list of tags, each from a classifier label (YAMNet's
 * AudioSet names, server/ai/audio-events.js) above that tag's own bar. Nothing is written by a model, so nothing can be
 * invented: no speaker, no reason, no "possibly". The bars come from production (2026-11-03, read-only): applause
 * averaged 0.77 and is kept from 0.7, laughter is rare and noisy and is kept from 0.7, while explosions and gunfire
 * fill a shooter's evening at 0.6: they are captioned only from 0.85 and only where they are rare in the stream (at
 * most 12 an hour; in a shooter they are the game, not news). The long tail ("Vehicle", "Animal", "Glass", "Liquid")
 * is never captioned: it is mostly wrong.
 *
 *   cues(events, { spanSec }) → [{ start, end, text }]   events: [{ start_sec, end_sec, label, confidence }]
 *
 * A burst becomes one cue (same tag within 4 s), 1.5 to 6 seconds long. Background music (audio-events.js spans,
 * label "Music") gives one "[music]" cue where it starts, not one under every line.
 */

const clipScore = require('./clip-score');

// [label pattern, tag, minimum confidence, only where rare in the stream]
const TAGS = [
    [/^(laughter|giggle|chuckle, chortle|belly laugh|snicker|baby laughter)$/i, 'laughter', 0.7, false],
    [/^(applause|clapping)$/i, 'applause', 0.7, false],
    [/^(cheering|crowd|children shouting)$/i, 'cheering', 0.7, false],
    [/^whistling$/i, 'whistling', 0.75, false],
    [/^(crying, sobbing|baby cry, infant cry|whimper)$/i, 'crying', 0.75, false],
    [/^screaming$/i, 'screaming', 0.8, false],
    [/^(dog|bark|yip|howl|bow-wow)$/i, 'dog barking', 0.8, false],
    [/^(cat|meow|purr)$/i, 'cat meowing', 0.8, false],
    [/^(doorbell|ding-dong)$/i, 'doorbell', 0.8, false],
    [/^(telephone bell ringing|ringtone)$/i, 'phone ringing', 0.8, false],
    [/^(siren|police car \(siren\)|ambulance \(siren\)|fire engine, fire truck \(siren\)|civil defense siren)$/i, 'siren', 0.8, false],
    [/^explosion$/i, 'explosion', 0.85, true],
    [/^(gunshot, gunfire|machine gun|fusillade)$/i, 'gunfire', 0.85, true],
];
const MERGE_GAP = 4;
const MIN_LEN = 1.5;
const MAX_LEN = 6;
const MUSIC_LEN = 3;

function tagOf(label) {
    const l = String(label || '').trim();
    for (const [re, tag, min, rareOnly] of TAGS) if (re.test(l)) return { tag, min, rareOnly };
    return null;
}

function cues(events, { spanSec = 0 } = {}) {
    const list = (Array.isArray(events) ? events : []).filter((e) => e && Number.isFinite(Number(e.start_sec)));
    const rare = new Set(clipScore.rareSounds(list, spanSec).map((e) => String(e.label || '')));
    const raw = [];
    for (const e of list) {
        const start = Math.max(0, Number(e.start_sec));
        const end = Number.isFinite(Number(e.end_sec)) && Number(e.end_sec) > start ? Number(e.end_sec) : start + MIN_LEN;
        if (String(e.label || '') === 'Music') {
            if (Number(e.confidence || 0) >= 0.5) raw.push({ start, end: start + MUSIC_LEN, text: '[music]' });
            continue;
        }
        const t = tagOf(e.label);
        if (!t || Number(e.confidence || 0) < t.min) continue;
        if (t.rareOnly && !rare.has(String(e.label || ''))) continue;
        raw.push({ start, end, text: `[${t.tag}]` });
    }
    raw.sort((a, b) => a.start - b.start || a.text.localeCompare(b.text));
    const out = [];
    const last = new Map();   // tag → its latest cue, so a burst becomes one cue
    for (const c of raw) {
        const prev = last.get(c.text);
        if (prev && c.start - prev.end <= MERGE_GAP && c.text !== '[music]') {
            prev.end = Math.min(prev.start + MAX_LEN, Math.max(prev.end, c.end));
            continue;
        }
        if (prev && c.text === '[music]' && c.start - prev.end <= MERGE_GAP) continue;
        const cue = { start: c.start, end: Math.min(c.start + MAX_LEN, Math.max(c.start + MIN_LEN, c.end)), text: c.text };
        out.push(cue);
        last.set(c.text, cue);
    }
    return out.map((c) => ({ start: Math.round(c.start * 100) / 100, end: Math.round(c.end * 100) / 100, text: c.text }));
}

module.exports = { cues, tagOf, TAGS };
