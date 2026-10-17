'use strict';
/**
 * The channel weather (GET /api/streams/channel/:username/weather): a streamer's zip code → a 7-day Open-Meteo
 * forecast. The zip never leaves the server.
 *
 *   fetchWeather(zip)  the forecast with { location }, or null when there has never been one for this zip
 *
 * A visitor never waits for a refresh once a zip has a forecast: an entry older than 15 minutes is answered at once
 * and refreshed behind the answer (the route's p95 was 2.4 s on 2026-10-17: each expiry made one visitor wait for
 * Open-Meteo), and concurrent requests share one refresh. A failed refresh keeps the last forecast and is tried
 * again after a minute; an error answer from Open-Meteo is never cached as a forecast. Every upstream call gives up
 * after 5 seconds. A zip no geocoder knows is remembered for an hour, so its channel does not cost two lookups per
 * viewer.
 */

const WEATHER_TTL_MS = 15 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
const GEOCODE_MISS_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

const weatherCache = new Map();   // zip → { data, ts }
const inflight = new Map();       // zip → the refresh in progress
const geocodeCache = new Map();   // zip → { lat, lon, name, region, country }
const geocodeMiss = new Map();    // zip → until (ms)

const get = (url) => fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });

async function geocodeZip(zip) {
    if (geocodeCache.has(zip)) return geocodeCache.get(zip);
    if ((geocodeMiss.get(zip) || 0) > Date.now()) return null;
    try {
        const resp = await get(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(zip)}&count=1&language=en&format=json`);
        const json = resp.ok ? await resp.json() : null;
        const r = json && json.results && json.results[0];
        if (r) {
            const result = { lat: r.latitude, lon: r.longitude, name: r.name, region: r.admin1 || '', country: r.country_code || '' };
            geocodeCache.set(zip, result);
            return result;
        }
    } catch (e) { console.warn('[Weather] Geocode error:', e.message); }
    // Fallback: a US zip through zippopotam.us.
    try {
        const resp = await get(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
        if (resp.ok) {
            const place = (await resp.json()).places?.[0];
            if (place) {
                const result = { lat: parseFloat(place.latitude), lon: parseFloat(place.longitude), name: place['place name'], region: place['state abbreviation'] || '', country: 'US' };
                geocodeCache.set(zip, result);
                return result;
            }
        }
    } catch { /* silent fallback */ }
    geocodeMiss.set(zip, Date.now() + GEOCODE_MISS_MS);
    return null;
}

function refresh(zip) {
    if (inflight.has(zip)) return inflight.get(zip);
    const run = (async () => {
        const geo = await geocodeZip(zip);
        if (!geo) return weatherCache.get(zip)?.data || null;
        try {
            const resp = await get(`https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}`
                + '&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover,visibility,uv_index'
                + '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset'
                + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day'
                + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch'
                + '&timezone=auto&forecast_days=7');
            if (!resp.ok) throw new Error(`Open-Meteo answered ${resp.status}`);
            const result = { ...(await resp.json()), location: { name: geo.name, region: geo.region, country: geo.country } };
            weatherCache.set(zip, { data: result, ts: Date.now() });
            return result;
        } catch (e) {
            console.warn('[Weather] Fetch error:', e.message);
            const stale = weatherCache.get(zip);
            if (stale) stale.ts = Date.now() - WEATHER_TTL_MS + RETRY_AFTER_FAILURE_MS;   // the last forecast, tried again in a minute
            return stale ? stale.data : null;
        }
    })().finally(() => inflight.delete(zip));
    inflight.set(zip, run);
    return run;
}

async function fetchWeather(zip) {
    const cached = weatherCache.get(zip);
    if (cached && Date.now() - cached.ts < WEATHER_TTL_MS) return cached.data;
    const next = refresh(zip);
    if (cached) return cached.data;   // the refresh finishes behind this answer
    return await next;
}

function _reset() { weatherCache.clear(); inflight.clear(); geocodeCache.clear(); geocodeMiss.clear(); }

module.exports = { fetchWeather, geocodeZip, WEATHER_TTL_MS, _reset, _cache: weatherCache };
