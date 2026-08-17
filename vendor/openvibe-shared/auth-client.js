'use strict';

// ═══════════════════════════════════════════════════════════════
// OpenVibe — OAuth2 Auth Client
// Used by OpenVibe.Live, OpenVibe.Tools, OpenVibe.Games, and OpenVibe.Media
// to authenticate users via the central OpenVibe.Network SSO.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { BRAND } = require('./brand');

const AUTH_BASE = BRAND.urls.login;

class OpenVibeAuthClient {
    /**
     * @param {Object} opts
     * @param {string} opts.clientId       - OAuth2 client_id (e.g. 'live')
     * @param {string} opts.clientSecret   - OAuth2 client_secret
     * @param {string} opts.redirectUri    - Callback URL (e.g. 'https://openvibe.live/auth/callback')
     * @param {string} opts.publicKey      - RS256 public key for JWT verification (PEM)
     * @param {string} [opts.authBase]     - Override auth server URL (default: openvibe.network)
     * @param {string} [opts.internalBase] - Internal auth API (default: http://127.0.0.1:4000)
     */
    constructor(opts) {
        this.clientId = opts.clientId;
        this.clientSecret = opts.clientSecret;
        this.redirectUri = opts.redirectUri;
        this.publicKey = opts.publicKey;
        this.authBase = opts.authBase || AUTH_BASE;
        this.internalBase = opts.internalBase || 'http://127.0.0.1:4000';
    }

    /**
     * Generate an authorization URL for the OAuth2 login redirect.
     * @param {string} [scope='profile theme'] - Requested scopes
     * @returns {{ url: string, state: string }}
     */
    getAuthorizationUrl(scope = 'profile theme') {
        const state = crypto.randomBytes(16).toString('hex');
        const params = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            response_type: 'code',
            scope,
            state,
        });
        return {
            url: `${this.authBase}/oauth/authorize?${params.toString()}`,
            state,
        };
    }

    /**
     * Exchange an authorization code for tokens.
     * @param {string} code - The authorization code from the callback
     * @returns {Promise<{ access_token: string, refresh_token: string, user: Object }>}
     */
    async exchangeCode(code) {
        const res = await fetch(`${this.authBase}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'authorization_code',
                client_id: this.clientId,
                client_secret: this.clientSecret,
                redirect_uri: this.redirectUri,
                code,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Token exchange failed: ${res.status}`);
        }
        return res.json();
    }

    /**
     * Refresh an access token using a refresh token.
     * @param {string} refreshToken
     * @returns {Promise<{ access_token: string, refresh_token: string }>}
     */
    async refreshAccessToken(refreshToken) {
        const res = await fetch(`${this.authBase}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                client_id: this.clientId,
                client_secret: this.clientSecret,
                refresh_token: refreshToken,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Token refresh failed: ${res.status}`);
        }
        return res.json();
    }

    /**
     * Verify and decode a JWT access token.
     * Uses the RS256 public key from the auth server.
     * @param {string} token
     * @returns {Object|null} Decoded payload or null if invalid
     */
    verifyToken(token) {
        try {
            // issuer is the tools/SSO public URL — derive from authBase to support white-label
            const issuer = this.authBase || this.issuer;
            return jwt.verify(token, this.publicKey, {
                algorithms: ['RS256'],
                issuer,
            });
        } catch {
            return null;
        }
    }

    /**
     * Verify a token via the internal API (server-to-server).
     * Useful as a fallback or for getting fresh user data.
     * @param {string} token
     * @param {string} internalKey - X-Internal-Key header value
     * @returns {Promise<Object|null>}
     */
    async verifyTokenInternal(token, internalKey) {
        try {
            const res = await fetch(`${this.internalBase}/internal/verify-token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Key': internalKey,
                },
                body: JSON.stringify({ token }),
            });
            if (!res.ok) return null;
            return res.json();
        } catch {
            return null;
        }
    }

    /**
     * Get fresh user profile data via internal API.
     * @param {number} userId
     * @param {string} internalKey
     * @returns {Promise<Object|null>}
     */
    async getUserProfile(userId, internalKey) {
        try {
            const res = await fetch(`${this.internalBase}/internal/user/${userId}/sync`, {
                method: 'POST',
                headers: { 'X-Internal-Key': internalKey },
            });
            if (!res.ok) return null;
            return res.json();
        } catch {
            return null;
        }
    }
}

module.exports = { OpenVibeAuthClient };
