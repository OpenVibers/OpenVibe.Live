'use strict';
/**
 * The signed-in person's picture-in-picture layout, kept in their OpenVibe.Network account.
 *
 *   GET   /api/me/layout   the record's data, or {} when there is none
 *   PATCH /api/me/layout   merge { pip: { "<slot>:<source>": place | null } } into it, answer the merged data
 *
 * Live's browser keeps its own copy too (public/js/stream-pip.js); this is the copy that follows a person to
 * another device. Writes go through Network's service module API as the person's subject
 * (PUT /internal/modules/live.layout/:subject with If-Match, one retry on 412 by re-reading), the same client
 * Live's live.profile / live.stats summaries use (server/auth/module-summaries.js).
 *
 * The route answers 404 while the pinned contracts do not know the namespace, so a browser keeps its local copy
 * and nothing breaks during the pin window. Network needs the same contracts pin and the namespace in its Live
 * principal grant (OpenVibe.Network server/identity/principals.js) before its module API accepts the write.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { requireAuth } = require('../auth/auth');
const identity = require('../auth/identity-sync');

const NAMESPACE = 'live.layout';
const NETWORK_INTERNAL_URL = (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
const CLIENT_ID = process.env.OV_OAUTH_CLIENT_ID || 'live';
const PLACE_KEY = /^[0-9]{1,12}:[0-9]{1,12}$/;
const MAX_PLACES = 60;

class LayoutError extends Error {
    constructor(status, message, errors) {
        super(message);
        this.name = 'LayoutError';
        this.status = status;
        if (errors) this.errors = errors;
    }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

let modulesClient;
/** Network's module service client, or null when Live has no service credential (then the route is off). */
function client() {
    if (modulesClient !== undefined) return modulesClient;
    const clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '';
    if (!clientSecret) return (modulesClient = null);
    const { createClient } = require('openvibe-sdk/core');
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    const { createModulesClient } = require('openvibe-sdk/modules');
    const tokens = createServiceTokenClient({ tokenUrl: `${NETWORK_INTERNAL_URL}/oauth/token`, clientId: CLIENT_ID, clientSecret });
    const core = createClient({ baseUrls: { network: NETWORK_INTERNAL_URL }, tokenProvider: tokens, retries: 1 });
    modulesClient = createModulesClient(core, { baseUrl: NETWORK_INTERNAL_URL }).forSubject;
    return modulesClient;
}

/** The request's pip entries: only `pip`, every key <slot>:<source>, null meaning "remove". */
function patchOf(body) {
    if (!isPlainObject(body)) throw new LayoutError(400, 'The body must be a JSON object');
    for (const key of Object.keys(body)) if (key !== 'pip') throw new LayoutError(400, `Unknown field "${key}"`);
    if (!isPlainObject(body.pip)) throw new LayoutError(400, '"pip" must be an object of <slot>:<source> places');
    for (const key of Object.keys(body.pip)) if (!PLACE_KEY.test(key)) throw new LayoutError(400, `"${key}" is not a <slot>:<source> key`);
    return body.pip;
}

/** The record's places with the request's entries applied; null deletes one. */
function mergePlaces(data, patch) {
    const pip = isPlainObject(data && data.pip) ? { ...data.pip } : {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete pip[key];
        else pip[key] = value;
    }
    return pip;
}

/** The 60 newest places by `at` (epoch ms); a place without a usable at sorts last. */
function newestPlaces(pip) {
    const entries = Object.entries(pip);
    if (entries.length <= MAX_PLACES) return pip;
    const at = ([, place]) => (place && Number.isFinite(place.at) ? place.at : -Infinity);
    entries.sort((a, b) => (at(b) - at(a)) || String(a[0]).localeCompare(String(b[0])));
    return Object.fromEntries(entries.slice(0, MAX_PLACES));
}

/** The namespace's schema and quota; 413 is over the quota, 400 is anything the schema refuses. */
function checked(modules, data) {
    const ns = modules.get(NAMESPACE);
    const size = Buffer.byteLength(JSON.stringify(data));
    if (ns && size > ns.quotaBytes) throw new LayoutError(413, `The layout is ${size} bytes; the quota is ${ns.quotaBytes}`);
    const result = modules.validateData(NAMESPACE, data);
    if (!result || !result.valid) throw new LayoutError(400, 'The layout is not valid', result && result.errors);
    return data;
}

/** Read, merge, validate, write with the revision read; a 412 reads again and applies the same patch once more. */
async function writeLayout(store, subject, patch, modules) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const rec = await store.get(NAMESPACE, subject);
        const data = checked(modules, { pip: newestPlaces(mergePlaces(rec && rec.data, patch)) });
        try {
            const saved = await store.put(NAMESPACE, subject, data, { revision: rec ? rec.revision : 0 });
            return saved && saved.data ? saved.data : data;
        } catch (err) {
            if (err && err.status === 412 && attempt === 0) continue;
            throw err;
        }
    }
}

const notAvailable = (res) => res.status(404).json({ error: 'The account layout is not available yet' });
const sendLayoutError = (res, err) => res.status(err.status).json({ error: err.message, ...(err.errors ? { errors: err.errors } : {}) });

/**
 * The router. `modules`, `store` and `auth` are injectable so the route test runs the same code on a stubbed
 * Network and a contracts registry that carries the namespace (the pinned one only will, after the release).
 */
function createLayoutRouter({ modules = contracts.modules, store, auth = requireAuth, subjectOf = identity.subjectOf } = {}) {
    const router = express.Router();
    const layoutStore = () => store || client();
    const storeMissing = (res) => res.status(503).json({ error: 'The account layout store is not configured' });

    router.get('/layout', auth, async (req, res, next) => {
        try {
            if (!modules.get(NAMESPACE)) return notAvailable(res);
            const subject = await subjectOf(req.user.id);
            if (!subject) return res.json({});
            const service = layoutStore();
            if (!service) return storeMissing(res);
            const rec = await service.get(NAMESPACE, subject);
            res.json(rec && rec.data ? rec.data : {});
        } catch (err) { next(err); }
    });

    router.patch('/layout', auth, async (req, res, next) => {
        try {
            if (!modules.get(NAMESPACE)) return notAvailable(res);
            let patch;
            try { patch = patchOf(req.body); } catch (err) { return sendLayoutError(res, err); }
            const subject = await subjectOf(req.user.id);
            if (!subject) return res.status(404).json({ error: 'No account to keep this layout in' });
            const service = layoutStore();
            if (!service) return storeMissing(res);
            res.json(await writeLayout(service, subject, patch, modules));
        } catch (err) {
            if (err instanceof LayoutError) return sendLayoutError(res, err);
            if (err && err.code === 'modules.unknown_namespace') return notAvailable(res);
            next(err);
        }
    });

    return router;
}

module.exports = { createLayoutRouter, NAMESPACE, mergePlaces, newestPlaces, patchOf, _reset() { modulesClient = undefined; }, LayoutError };
