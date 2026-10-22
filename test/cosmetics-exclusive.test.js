'use strict';
// A one-of-a-kind cosmetic (fx_vegas, "Josh Vegas", 2026-10-22): it is in Live's catalog of renderers, so the person
// who holds it shows it in chat (getCosmeticProfile maps a worn alias through the catalog), but GET
// /api/cosmetics/catalog never lists it, and its
// class is drawn by both of Live's stylesheets (the site's cosmetics.css and the OBS chat overlay).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

console.warn = () => {};
const cosmetics = require('../server/monetization/cosmetics');

(async () => {
    const vegas = cosmetics.COSMETICS.fx_vegas;
    assert.ok(vegas && vegas.exclusive === true && vegas.category === 'name_effect', 'fx_vegas is a one-of-a-kind name effect');
    // Its set: a particle, a hat and a voice, all one of a kind and valid for Inventory's kinds.
    const SET = { px_vegas: 'particle', hat_vegas: 'hat', voice_vegas: 'voice' };
    for (const [id, category] of Object.entries(SET)) {
        const c = cosmetics.COSMETICS[id];
        assert.ok(c && c.exclusive === true && c.category === category, `${id} is a one-of-a-kind ${category}`);
    }
    assert.ok(cosmetics.COSMETICS.px_vegas.chars.length <= 16 && /^px-[a-z]+$/.test(cosmetics.COSMETICS.px_vegas.cssClass), 'particle chars fit live.particle');
    assert.ok(['float', 'pulse', 'warp'].includes(cosmetics.COSMETICS.hat_vegas.animated) && cosmetics.COSMETICS.hat_vegas.hatChar.length <= 8, 'the hat fits live.hat');
    const v = cosmetics.COSMETICS.voice_vegas;
    assert.ok(v.pitch >= 0 && v.pitch <= 2 && v.rate >= 0.1 && v.rate <= 3, 'the voice fits live.voice');
    assert.match(vegas.cssClass, /^name-fx-[a-z]{2,24}$/, 'its class passes the pattern Chat and Network accept');

    const app = express();
    app.use('/api/cosmetics', require('../server/monetization/cosmetics-routes'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/cosmetics/catalog`);
        const { catalog } = await res.json();
        const listed = Object.values(catalog).flat().map((c) => c.itemId);
        assert.ok(listed.includes('fx_galaxy'), 'the catalog still lists the others');
        for (const id of ['fx_vegas', 'px_vegas', 'hat_vegas', 'voice_vegas']) assert.ok(!listed.includes(id), `${id}, one of a kind, is never listed`);
    } finally {
        server.close();
    }

    for (const file of ['public/css/cosmetics.css', 'public/obs/chat.html']) {
        const css = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        assert.ok(css.includes('.name-fx-vegas {') && css.includes('@keyframes nameFxVegasReel') && css.includes('@keyframes nameFxVegasJackpot'), `${file} draws the effect`);
        assert.ok(css.includes('.px-vegas .chat-particle'), `${file} colours the Vegas particles`);
        assert.ok(css.includes('prefers-reduced-motion: reduce') && /\.name-fx-vegas::before, \.name-fx-vegas::after \{ animation: none/.test(css), `${file} stops the reels for reduced motion`);
    }
    console.log('cosmetics exclusive: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
