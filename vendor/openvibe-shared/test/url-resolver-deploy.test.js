'use strict';

const assert = require('assert');
const { URL_DEFINITIONS, normalizeValue, resolveRegistryValues } = require('../url-resolver');

// ── Test: Deploy infrastructure keys exist ───────────────────
const deployKeys = [
    'DEPLOY_ACME_EMAIL',
    'DEPLOY_CERT_MODE',
    'DEPLOY_CLOUDFLARE_TOKEN',
    'DEPLOY_DOMAINS',
    'DEPLOY_NGINX_MODE',
    'DEPLOY_NGINX_SITES_PATH',
    'DEPLOY_NGINX_BACKUP_PATH',
    'DEPLOY_SERVICE_MAP',
];

for (const key of deployKeys) {
    assert.ok(URL_DEFINITIONS[key], `Missing deploy key: ${key}`);
    assert.strictEqual(URL_DEFINITIONS[key].key, key);
    assert.ok(URL_DEFINITIONS[key].category.startsWith('deploy_'), `Deploy key ${key} should have deploy_ category`);
}

// ── Test: Deploy key defaults ────────────────────────────────
assert.strictEqual(URL_DEFINITIONS.DEPLOY_CERT_MODE.default, 'manual');
assert.strictEqual(URL_DEFINITIONS.DEPLOY_NGINX_MODE.default, 'preview');
assert.strictEqual(URL_DEFINITIONS.DEPLOY_NGINX_SITES_PATH.default, '/etc/nginx/sites-enabled');
assert.strictEqual(URL_DEFINITIONS.DEPLOY_CLOUDFLARE_TOKEN.type, 'secret');

// ── Test: Secret type normalization ──────────────────────────
assert.strictEqual(normalizeValue('  my-secret-token  ', 'secret'), 'my-secret-token');
assert.strictEqual(normalizeValue(null, 'secret'), null);
assert.strictEqual(normalizeValue(undefined, 'secret'), null);

// ── Test: Deploy config resolves through registry chain ──────
const env = {};
const bootstrap = {
    DEPLOY_ACME_EMAIL: 'admin@example.com',
    DEPLOY_CERT_MODE: 'cloudflare',
};
const overrides = {
    DEPLOY_CERT_MODE: 'manual',
};

const resolved = resolveRegistryValues(env, overrides, bootstrap, URL_DEFINITIONS);

assert.strictEqual(resolved.DEPLOY_ACME_EMAIL.value, 'admin@example.com');
assert.strictEqual(resolved.DEPLOY_ACME_EMAIL.source, 'bootstrap');
assert.strictEqual(resolved.DEPLOY_CERT_MODE.value, 'manual');
assert.strictEqual(resolved.DEPLOY_CERT_MODE.source, 'admin');
assert.strictEqual(resolved.DEPLOY_NGINX_MODE.value, 'preview');
assert.strictEqual(resolved.DEPLOY_NGINX_MODE.source, 'default');

// ── Test: DEPLOY_DOMAINS as JSON array ───────────────────────
const domainsResolved = resolveRegistryValues({}, {
    DEPLOY_DOMAINS: JSON.stringify([
        { domain: 'openvibe.tools', wildcard: true, certName: 'openvibe.tools', services: ['network'] },
        { domain: 'openvibe.live', wildcard: true, certName: 'openvibe.live-0001', services: ['live'] },
    ]),
}, {}, URL_DEFINITIONS);

assert.ok(Array.isArray(domainsResolved.DEPLOY_DOMAINS.value));
assert.strictEqual(domainsResolved.DEPLOY_DOMAINS.value.length, 2);
assert.strictEqual(domainsResolved.DEPLOY_DOMAINS.value[0].domain, 'openvibe.tools');

// ── Test: DEPLOY_SERVICE_MAP as JSON map ─────────────────────
const svcMapResolved = resolveRegistryValues({}, {
    DEPLOY_SERVICE_MAP: JSON.stringify({ custom: { port: 9000, domains: ['custom.example.com'] } }),
}, {}, URL_DEFINITIONS);

assert.ok(typeof svcMapResolved.DEPLOY_SERVICE_MAP.value === 'object');
assert.strictEqual(svcMapResolved.DEPLOY_SERVICE_MAP.value.custom.port, 9000);

// ── Test: White-label defaults still work ────────────────────
const whitelabelResolved = resolveRegistryValues({}, {
    NETWORK_NAME: 'CoolNet',
    TOOLS_SERVICE_NAME: 'CoolTools',
    DEPLOY_ACME_EMAIL: 'ops@cool.net',
    DEPLOY_CERT_MODE: 'cloudflare',
}, {}, URL_DEFINITIONS);

assert.strictEqual(whitelabelResolved.NETWORK_NAME.value, 'CoolNet');
assert.strictEqual(whitelabelResolved.DEPLOY_ACME_EMAIL.value, 'ops@cool.net');
assert.strictEqual(whitelabelResolved.DEPLOY_CERT_MODE.value, 'cloudflare');

console.log('✅ url-resolver deploy config tests passed');
