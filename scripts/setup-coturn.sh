#!/bin/bash
# OpenVibe.Live — coturn TURN server setup
# Run on the production server (ubuntu@40.160.240.222)
#
# This sets up coturn as a TURN/TURNS relay so viewers behind
# symmetric NAT or VPN with WebRTC leak protection can watch streams.

set -e

TURN_SECRET="$(openssl rand -hex 32)"
SERVER_IP="40.160.240.222"
DOMAIN="openvibe.live"

echo "=== Installing coturn ==="
sudo apt-get update -qq
sudo apt-get install -y coturn

echo "=== Configuring coturn ==="
sudo tee /etc/turnserver.conf > /dev/null << EOF
# OpenVibe.Live TURN server config
listening-port=3478
tls-listening-port=5349
alt-listening-port=3479
alt-tls-listening-port=5350

# Listen on all interfaces
listening-ip=0.0.0.0

# External/relay IP — must be the public IP
external-ip=$SERVER_IP
relay-ip=$SERVER_IP

# Realm
realm=$DOMAIN

# Static auth credentials (simple — no database needed)
# These must match TURN_USERNAME and TURN_CREDENTIAL in .env
user=openvibelive:$TURN_SECRET

# Long-term credentials
lt-cred-mech

# TLS certs (reuse Let's Encrypt certs from nginx)
cert=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
pkey=/etc/letsencrypt/live/$DOMAIN/privkey.pem

# Fingerprint
fingerprint

# Don't allow relay to private IPs (security)
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=127.0.0.0-127.255.255.255

# Relay port range (don't conflict with mediasoup 11000-11300)
min-port=49152
max-port=65535

# Logging
log-file=/var/log/turnserver.log
simple-log
new-log-timestamp

# Performance
total-quota=100
bps-capacity=0
stale-nonce=600
no-multicast-peers
EOF

echo "=== Enabling coturn service ==="
# Enable coturn daemon (Debian/Ubuntu default is disabled)
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
sudo systemctl enable coturn
sudo systemctl restart coturn

echo ""
echo "=== coturn setup complete ==="
echo ""
echo "Add these to /opt/openvibelive/.env:"
echo ""
echo "  TURN_URL=turn:$DOMAIN:3478"
echo "  TURN_USERNAME=openvibelive"
echo "  TURN_CREDENTIAL=$TURN_SECRET"
echo ""
echo "Then restart OpenVibe.Live:"
echo "  sudo systemctl restart openvibelive"
echo ""
echo "Firewall ports needed (if using UFW):"
echo "  sudo ufw allow 3478/tcp   # TURN"
echo "  sudo ufw allow 3478/udp   # TURN"
echo "  sudo ufw allow 5349/tcp   # TURNS (TLS)"
echo "  sudo ufw allow 49152:65535/udp  # Relay ports"
echo ""
