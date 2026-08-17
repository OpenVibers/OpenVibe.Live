/**
 * OpenVibe.Live — ONVIF Camera Client
 * 
 * Wrapper around node-onvif for PTZ (pan-tilt-zoom) control.
 * Handles discovery, authentication, and movement commands.
 */

const dgram = require('dgram');
const { EventEmitter } = require('events');

/**
 * ONVIF Discovery via WS-Discovery
 * Broadcasts M-SEARCH on port 3702 to discover devices
 */
class OnvifDiscovery extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
    }

    /**
     * Discover ONVIF devices on the network
     * @param {number} timeoutMs - How long to listen for responses (default 3000ms)
     * @returns {Promise<Array>} Array of discovered device info
     */
    async discover(timeoutMs = 3000) {
        return new Promise((resolve) => {
            const devices = [];
            const multicastAddr = '239.255.255.250';
            const port = 3702;

            const socket = dgram.createSocket('udp4');

            socket.on('message', (msg, rinfo) => {
                try {
                    const msgStr = msg.toString('utf8');
                    // Look for ONVIF URIs in SOAP response
                    const uriMatch = msgStr.match(/onvif:\/\/www\.onvif\.org\/type\/NetworkVideoTransmitter/);
                    const addressMatch = msgStr.match(/http:\/\/([^\/]+\/.*?)(?:\s|<)/);

                    if (uriMatch && addressMatch) {
                        const url = addressMatch[1] || rinfo.address;
                        if (!devices.some(d => d.url === url)) {
                            devices.push({
                                url: `http://${url}`,
                                ip: rinfo.address,
                                discovered_at: new Date().toISOString(),
                            });
                        }
                    }
                } catch (e) {
                    // Ignore malformed responses
                }
            });

            socket.on('error', (err) => {
                console.warn('[ONVIF] Discovery socket error:', err.message);
                socket.close();
            });

            // Send M-SEARCH broadcast
            const ssdpRequest = [
                'M-SEARCH * HTTP/1.1',
                'HOST: 239.255.255.250:3702',
                'MAN: "ssdp:discover"',
                'MX: 2',
                'ST: urn:onvif:service:device:DeviceService',
                '',
                '',
            ].join('\r\n');

            try {
                socket.bind(() => {
                    socket.addMembership(multicastAddr);
                    socket.send(ssdpRequest, 0, ssdpRequest.length, port, multicastAddr, (err) => {
                        if (err) console.warn('[ONVIF] Send error:', err.message);
                    });
                });
            } catch (e) {
                console.warn('[ONVIF] Bind error:', e.message);
                return resolve([]);
            }

            // Timeout timer
            setTimeout(() => {
                socket.close();
                resolve(devices);
            }, timeoutMs);
        });
    }
}

/**
 * ONVIF Client for PTZ control
 */
class OnvifClient extends EventEmitter {
    /**
     * @param {string} url - Device URL (e.g., http://192.168.1.100:8080)
     * @param {string} username - ONVIF username
     * @param {string} password - ONVIF password (plaintext; should be decrypted before passing)
     */
    constructor(url, username, password) {
        super();
        this.url = url;
        this.username = username;
        this.password = password;
        this.connected = false;
        this.profileToken = null;
        this.ptzNode = null;
        this.moveInProgress = false;

        // Try to use node-onvif if available, otherwise provide fallback
        try {
            this.Onvif = require('node-onvif');
        } catch (e) {
            console.warn('[ONVIF] node-onvif not installed, using HTTP fallback');
            this.Onvif = null;
        }
    }

    /**
     * Connect and retrieve capabilities
     */
    async connect() {
        if (this.connected) return true;

        try {
            if (this.Onvif) {
                return await this._connectWithLibrary();
            } else {
                return await this._connectWithFallback();
            }
        } catch (e) {
            this.emit('error', new Error(`Failed to connect: ${e.message}`));
            return false;
        }
    }

    async _connectWithLibrary() {
        const device = new this.Onvif.OnvifDevice({
            xaddr: this.url,
            user: this.username,
            pass: this.password,
        });

        try {
            await device.init();
            this.device = device;
            this.profileToken = device.getCurrentProfile()['$'].token ||
                                (device.getProfileList()[0] && device.getProfileList()[0]['$'].token);
            
            if (!this.profileToken) {
                throw new Error('No profiles available');
            }

            this.connected = true;
            this.emit('connected');
            return true;
        } catch (e) {
            throw new Error(`Device init failed: ${e.message}`);
        }
    }

    async _connectWithFallback() {
        // Simple HTTP-based fallback for cameras that support basic HTTP requests
        // This is a minimal implementation; real cameras may need SOAP WSDL calls
        const response = await this._httpRequest('GET', `/onvif/device_service`);
        if (response && response.statusCode === 200) {
            this.connected = true;
            this.emit('connected');
            return true;
        }
        throw new Error('Device unreachable');
    }

    /**
     * Relative movement (speed-based)
     */
    async relativeMove(panSpeed, tiltSpeed, zoomSpeed, durationMs = 1000) {
        if (!this.connected) {
            throw new Error('Not connected');
        }

        if (this.moveInProgress) {
            return; // Ignore rapid consecutive commands
        }

        try {
            if (this.Onvif && this.device) {
                return await this._relativeMoveWithLibrary(panSpeed, tiltSpeed, zoomSpeed, durationMs);
            } else {
                return await this._relativeMoveWithFallback(panSpeed, tiltSpeed, zoomSpeed);
            }
        } catch (e) {
            this.emit('error', new Error(`Relative move failed: ${e.message}`));
        }
    }

    async _relativeMoveWithLibrary(panSpeed, tiltSpeed, zoomSpeed, durationMs) {
        this.moveInProgress = true;

        try {
            // Clamp speeds to 0.0-1.0
            const params = {
                ProfileToken: this.profileToken,
                Translation: {
                    PanTilt: {
                        x: Math.max(-1, Math.min(1, panSpeed)),
                        y: Math.max(-1, Math.min(1, tiltSpeed)),
                    },
                    Zoom: {
                        x: Math.max(-1, Math.min(1, zoomSpeed)),
                    },
                },
            };

            await this.device.ptz().relativeMove(params);

            // Auto-stop after duration
            if (durationMs > 0) {
                setTimeout(() => this.stop().catch(() => {}), durationMs);
            }

            return true;
        } finally {
            this.moveInProgress = false;
        }
    }

    async _relativeMoveWithFallback(panSpeed, tiltSpeed, zoomSpeed) {
        // HTTP fallback: attempt to call CGI-based PTZ endpoint
        // Different cameras use different endpoints (Hikvision, Axis, Dahua)
        const endpoints = [
            `/API/ISAPI/PTZ/channels/1`,
            `/cgi-bin/admin/param?action=update&PTZRelativeMove`,
            `/axis-cgi/com/ptz.cgi`,
        ];

        for (const endpoint of endpoints) {
            try {
                await this._httpRequest('GET', endpoint, {
                    panSpeed,
                    tiltSpeed,
                    zoomSpeed,
                });
                return true;
            } catch (e) {
                // Try next endpoint
            }
        }
        throw new Error('No working PTZ endpoint found');
    }

    /**
     * Stop all motion
     */
    async stop() {
        if (!this.connected) return false;

        try {
            if (this.Onvif && this.device) {
                const params = { ProfileToken: this.profileToken };
                await this.device.ptz().stop(params);
            } else {
                // HTTP fallback
                await this._httpRequest('GET', `/axis-cgi/com/ptz.cgi?stop=1`);
            }
            this.moveInProgress = false;
            return true;
        } catch (e) {
            this.emit('error', new Error(`Stop failed: ${e.message}`));
            return false;
        }
    }

    /**
     * Go to preset position
     */
    async gotoPreset(presetToken) {
        if (!this.connected) {
            throw new Error('Not connected');
        }

        try {
            if (this.Onvif && this.device) {
                const params = {
                    ProfileToken: this.profileToken,
                    PresetToken: presetToken,
                };
                await this.device.ptz().gotoPreset(params);
            } else {
                // HTTP: preset number (1-99)
                const presetNum = parseInt(presetToken) || 1;
                await this._httpRequest('GET', `/axis-cgi/com/ptz.cgi?gotoserverpresetname=HomePosition&speed=50`);
            }
            return true;
        } catch (e) {
            this.emit('error', new Error(`Goto preset failed: ${e.message}`));
            return false;
        }
    }

    /**
     * Save current position as preset
     */
    async setPreset(presetName) {
        if (!this.connected) {
            throw new Error('Not connected');
        }

        try {
            if (this.Onvif && this.device) {
                const params = {
                    ProfileToken: this.profileToken,
                    PresetName: presetName,
                };
                const result = await this.device.ptz().setPreset(params);
                return result?.PresetToken;
            } else {
                // HTTP fallback: most cameras support basic preset via CGI
                await this._httpRequest('GET', `/axis-cgi/com/ptz.cgi?setserverpresetname=${encodeURIComponent(presetName)}`);
                return presetName;
            }
        } catch (e) {
            this.emit('error', new Error(`Set preset failed: ${e.message}`));
            return null;
        }
    }

    /**
     * Get device capabilities
     */
    async getCapabilities() {
        if (!this.connected) {
            throw new Error('Not connected');
        }

        try {
            if (this.Onvif && this.device) {
                const info = this.device.getInformation();
                return {
                    manufacturer: info.Manufacturer,
                    model: info.Model,
                    firmwareVersion: info.FirmwareVersion,
                    serialNumber: info.SerialNumber,
                    supportsPTZ: true,
                    supportsPresets: true,
                };
            } else {
                return {
                    manufacturer: 'Unknown',
                    supportsPTZ: this.connected,
                    supportsPresets: true,
                };
            }
        } catch (e) {
            this.emit('error', new Error(`Get capabilities failed: ${e.message}`));
            return {};
        }
    }

    /**
     * Helper: HTTP request with basic auth
     */
    async _httpRequest(method, path, params = {}) {
        const https = require('https');
        const http = require('http');
        const url = require('url');

        const parsedUrl = new url.URL(this.url);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        let urlPath = path;
        if (method === 'GET' && Object.keys(params).length > 0) {
            const query = new url.URLSearchParams(params).toString();
            urlPath = `${path}?${query}`;
        }

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: urlPath,
            method: method,
            auth: `${this.username}:${this.password}`,
            timeout: 5000,
        };

        return new Promise((resolve, reject) => {
            const req = client.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ statusCode: res.statusCode, body: data });
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}`));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.end();
        });
    }

    /**
     * Disconnect
     */
    disconnect() {
        this.connected = false;
        this.device = null;
        this.emit('disconnected');
    }
}

module.exports = {
    OnvifDiscovery,
    OnvifClient,
};
