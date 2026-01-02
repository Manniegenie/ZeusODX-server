#!/bin/bash
# Redis Setup Script for ZeusODX Production Server
# Run this on your Contabo server

set -e

echo "🔧 ZeusODX Redis Production Setup"
echo "=================================="
echo ""

# Generate a strong random password
REDIS_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)

echo "📝 Step 1: Backing up original Redis config..."
sudo cp /etc/redis/redis.conf /etc/redis/redis.conf.backup
echo "✅ Backup created at /etc/redis/redis.conf.backup"
echo ""

echo "📝 Step 2: Configuring Redis for production..."

# Update Redis configuration
sudo tee /etc/redis/redis.conf > /dev/null <<EOF
# ZeusODX Redis Configuration
# Generated: $(date)

# Bind to localhost only (security)
bind 127.0.0.1 ::1

# Port
port 6379

# Security: Require password
requirepass $REDIS_PASSWORD

# Daemon mode
daemonize no
supervised systemd

# Logging
loglevel notice
logfile /var/log/redis/redis-server.log

# Persistence - RDB
save 900 1
save 300 10
save 60 10000
stop-writes-on-bgsave-error yes
rdbcompression yes
rdbchecksum yes
dbfilename dump.rdb
dir /var/lib/redis

# Persistence - AOF
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec
no-appendfsync-on-rewrite no
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb

# Memory Management
maxmemory 512mb
maxmemory-policy allkeys-lru
maxmemory-samples 5

# Slow log
slowlog-log-slower-than 10000
slowlog-max-len 128

# Client output buffer limits
client-output-buffer-limit normal 0 0 0
client-output-buffer-limit replica 256mb 64mb 60
client-output-buffer-limit pubsub 32mb 8mb 60

# Performance
tcp-backlog 511
timeout 300
tcp-keepalive 300

# Disable dangerous commands
rename-command FLUSHDB ""
rename-command FLUSHALL ""
rename-command CONFIG ""
EOF

echo "✅ Redis configuration updated"
echo ""

echo "📝 Step 3: Setting correct permissions..."
sudo chown redis:redis /etc/redis/redis.conf
sudo chmod 640 /etc/redis/redis.conf
echo "✅ Permissions set"
echo ""

echo "📝 Step 4: Restarting Redis..."
sudo systemctl restart redis-server
sudo systemctl enable redis-server
echo "✅ Redis restarted and enabled on boot"
echo ""

echo "📝 Step 5: Checking Redis status..."
sleep 2
if sudo systemctl is-active --quiet redis-server; then
    echo "✅ Redis is running"
else
    echo "❌ Redis failed to start. Check logs with: sudo journalctl -u redis-server -n 50"
    exit 1
fi
echo ""

echo "📝 Step 6: Testing Redis connection..."
if redis-cli -a "$REDIS_PASSWORD" PING > /dev/null 2>&1; then
    echo "✅ Redis authentication working"
else
    echo "❌ Redis authentication failed"
    exit 1
fi
echo ""

echo "📝 Step 7: Creating .env configuration..."
ENV_FILE="/var/www/ZeusODX-server/.env"

# Check if .env exists
if [ -f "$ENV_FILE" ]; then
    # Remove old Redis config if exists
    sudo sed -i '/^REDIS_/d' "$ENV_FILE"

    # Add new Redis config
    cat >> "$ENV_FILE" <<ENVEOF

# Redis Configuration (Added $(date))
REDIS_URL=redis://127.0.0.1:6379
REDIS_PASSWORD=$REDIS_PASSWORD
REDIS_MAX_RETRIES=3
REDIS_RETRY_DELAY=1000
ENVEOF
    echo "✅ .env file updated with Redis configuration"
else
    echo "⚠️  .env file not found at $ENV_FILE"
    echo "   Please create it manually with:"
    echo ""
    echo "REDIS_URL=redis://127.0.0.1:6379"
    echo "REDIS_PASSWORD=$REDIS_PASSWORD"
    echo "REDIS_MAX_RETRIES=3"
    echo "REDIS_RETRY_DELAY=1000"
fi
echo ""

echo "📝 Step 8: Saving credentials securely..."
CREDS_FILE="/root/.zeusodx-redis-credentials"
cat > "$CREDS_FILE" <<CREDSEOF
ZeusODX Redis Credentials
=========================
Generated: $(date)

Redis Password: $REDIS_PASSWORD
Redis URL: redis://127.0.0.1:6379

Configuration File: /etc/redis/redis.conf
Log File: /var/log/redis/redis-server.log
Data Directory: /var/lib/redis

IMPORTANT: Keep this file secure!
CREDSEOF

chmod 600 "$CREDS_FILE"
echo "✅ Credentials saved to $CREDS_FILE"
echo ""

echo "=================================================="
echo "✅ Redis Setup Complete!"
echo "=================================================="
echo ""
echo "📋 Redis Information:"
echo "   Status: $(sudo systemctl is-active redis-server)"
echo "   Password: $REDIS_PASSWORD"
echo "   URL: redis://127.0.0.1:6379"
echo ""
echo "🔒 Security:"
echo "   ✅ Password authentication enabled"
echo "   ✅ Bound to localhost only"
echo "   ✅ Dangerous commands disabled"
echo "   ✅ Memory limit: 512MB"
echo ""
echo "📝 Next Steps:"
echo "   1. Install ioredis: cd /var/www/ZeusODX-server && npm install ioredis"
echo "   2. Test Redis: node scripts/test-redis.js"
echo "   3. Restart your app: pm2 restart zeusodx"
echo ""
echo "📖 Useful Commands:"
echo "   • Check status: sudo systemctl status redis-server"
echo "   • View logs: sudo tail -f /var/log/redis/redis-server.log"
echo "   • Redis CLI: redis-cli -a '$REDIS_PASSWORD'"
echo "   • Monitor: redis-cli -a '$REDIS_PASSWORD' MONITOR"
echo ""
echo "🔐 Credentials saved to: $CREDS_FILE"
echo "=================================================="
