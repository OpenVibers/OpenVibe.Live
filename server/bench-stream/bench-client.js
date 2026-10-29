'use strict';

const { createClient } = require('openvibe-sdk/core');
const { createBenchClient } = require('openvibe-sdk/bench');
const principal = require('../net/network-principal');

let bench;
function client() {
    if (require('../drill').enabled) throw new Error('Bench is unavailable in a restore drill');
    if (!principal.configured()) throw new Error('Live has no service credentials for Bench');
    if (!bench) {
        const baseUrl = (process.env.OV_BENCH_INTERNAL_URL || 'http://127.0.0.1:5230').replace(/\/+$/, '');
        bench = createBenchClient(createClient({
            baseUrls: { bench: baseUrl }, autoDiscover: false, retries: 0,
            getToken: async () => (await principal.serviceHeaders('openvibe.bench')).Authorization.replace(/^Bearer\s+/i, ''),
            invalidateToken: () => principal.invalidate('openvibe.bench'),
        }));
    }
    return bench;
}

module.exports = { client };
