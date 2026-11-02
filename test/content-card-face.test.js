'use strict';

/**
 * A recording or clip with no picture shows who made it (as Shared's kit.card does since 4.89.0): their face over a blur
 * of it, else their letter in their own colour, and the plain icon only when there is no one to show.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'content-feed.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'features', 'content.css'), 'utf8');
const ph = js.slice(js.indexOf('function placeholder('), js.indexOf('function thumb('));

assert.ok(ph.includes("el('img', { class: 'cf-who-bg'") && ph.includes("el('img', { class: 'cf-who-face'"), 'their face over a blur of it');
assert.ok(ph.includes('ovImgW(face, 160)'), 'at the size it is drawn, not the original upload');
assert.ok(ph.includes("class: 'cf-who-letter'") && ph.includes('who.profile_color'), 'else their letter, in their own colour');
assert.ok(/if \(!face\) return el\('span', \{ class: 'cf-thumb cf-thumb--ph' \}, icon\(fallbackIcon\)\);/.test(ph), 'the icon when there is no one');
assert.ok(ph.includes("me.addEventListener('error'"), 'a face that fails to load falls back to the icon');
// Recordings and clips pass who made them; a failed thumbnail falls back the same way.
assert.ok(js.includes("thumb(it.thumbnail_url, 'fa-video', it.channel)") && js.includes("thumb(it.thumbnail_url, 'fa-scissors', it.channel)"), 'VODs and clips pass the creator');
assert.ok(js.includes('img.replaceWith(placeholder(fallbackIcon, who));'), 'a thumbnail that fails shows the creator too');
for (const sel of ['.cf-thumb--who .cf-who-bg', '.cf-thumb--who .cf-who-face', '.cf-who-letter']) assert.ok(css.includes(sel), sel);

console.log('content-card-face: all passed');
