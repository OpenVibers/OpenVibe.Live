'use strict';
/**
 * The channel weather cache (server/streaming/weather.js): a visitor never waits for a refresh once a zip has a
 * forecast (the route's p95 was 2.4 s on 2026-10-17), concurrent requests share one refresh, an error answer is
 * never cached, a failed refresh keeps the last forecast, and an unknown zip is remembered.
 *
 *   node test/weather-cache.test.js
 */
const assert = require('assert');

console.warn = () => {};

(async () => {
    const calls = [];
    let forecastStatus = 200;
    let forecastTemp = 70;
    let gate = null;   // a promise the next forecast answer waits for
    global.fetch = async (url, opts) => {
        calls.push(url);
        assert.ok(opts && opts.signal, 'every upstream call has a timeout');
        if (url.includes('geocoding-api')) {
            if (url.includes('00000')) return { ok: true, json: async () => ({}) };
            return { ok: true, json: async () => ({ results: [{ latitude: 34.1, longitude: -118.4, name: 'Beverly Hills', admin1: 'California', country_code: 'US' }] }) };
        }
        if (url.includes('zippopotam')) return { ok: false, json: async () => ({}) };
        if (gate) await gate;
        const status = forecastStatus;
        return { ok: status === 200, status, json: async () => (status === 200 ? { current: { temperature_2m: forecastTemp } } : { error: true, reason: 'busy' }) };
    };
    const weather = require('../server/streaming/weather');
    const forecasts = () => calls.filter((u) => u.includes('api.open-meteo.com/v1/forecast')).length;

    // First request waits for the forecast; the next ones are served from the cache.
    const first = await weather.fetchWeather('90210');
    assert.strictEqual(first.current.temperature_2m, 70);
    assert.deepStrictEqual(first.location, { name: 'Beverly Hills', region: 'California', country: 'US' });
    await weather.fetchWeather('90210');
    assert.strictEqual(forecasts(), 1, 'cached within 15 minutes');

    // Expired: answered at once with the last forecast while one shared refresh runs behind it.
    weather._cache.get('90210').ts -= weather.WEATHER_TTL_MS + 1;
    let release;
    gate = new Promise((r) => { release = r; });
    forecastTemp = 72;
    const [a, b] = await Promise.all([weather.fetchWeather('90210'), weather.fetchWeather('90210')]);
    assert.strictEqual(a.current.temperature_2m, 70, 'the stale forecast, without waiting');
    assert.strictEqual(b.current.temperature_2m, 70);
    assert.strictEqual(forecasts(), 2, 'one refresh for both');
    release(); gate = null;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual((await weather.fetchWeather('90210')).current.temperature_2m, 72, 'the refresh landed');

    // A failed refresh (Open-Meteo answering 429) keeps the last forecast and is not cached as one.
    weather._cache.get('90210').ts -= weather.WEATHER_TTL_MS + 1;
    forecastStatus = 429;
    assert.strictEqual((await weather.fetchWeather('90210')).current.temperature_2m, 72);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual((await weather.fetchWeather('90210')).current.temperature_2m, 72, 'still the last good forecast');
    const n = forecasts();
    await weather.fetchWeather('90210');
    assert.strictEqual(forecasts(), n, 'a failure is tried again after a minute, not on every request');

    // A zip with no forecast yet and an error answer: null, nothing cached.
    weather._reset();
    calls.length = 0;
    assert.strictEqual(await weather.fetchWeather('10001'), null);
    assert.strictEqual(weather._cache.has('10001'), false, 'an error answer is not a forecast');

    // A zip no geocoder knows costs its lookups once an hour, not on every viewer's request.
    calls.length = 0;
    assert.strictEqual(await weather.fetchWeather('00000'), null);
    const lookups = calls.length;
    assert.strictEqual(await weather.fetchWeather('00000'), null);
    assert.strictEqual(calls.length, lookups, 'remembered as unknown');

    console.log('weather cache: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
