# Redis Setup Instructions for Contabo Server

## 🚀 Quick Setup (5 minutes)

You've already installed Redis. Now follow these steps to configure it:

---

## Step 1: Make Setup Script Executable

```bash
# On your Contabo server, in the project directory
cd /var/www/ZeusODX-server

# Make the setup script executable
chmod +x scripts/setup-redis.sh

# Run the setup script
sudo bash scripts/setup-redis.sh
```

**What this script does:**
- ✅ Backs up original Redis config
- ✅ Configures Redis for production (password, memory limits, persistence)
- ✅ Generates a strong random password
- ✅ Binds Redis to localhost only (security)
- ✅ Disables dangerous commands
- ✅ Updates your .env file
- ✅ Saves credentials securely
- ✅ Restarts Redis service

---

## Step 2: Install ioredis Package

```bash
# Still in /var/www/ZeusODX-server
npm install ioredis
```

---

## Step 3: Test Redis Connection

```bash
# Run the test script
node scripts/test-redis.js
```

**Expected output:**
```
🔍 Testing Redis Connection...

✅ Connected to Redis server
✅ Redis client ready

Running Redis tests...

✅ PING command
✅ SET command
✅ GET command
✅ INCR command
✅ EXPIRE command
✅ TTL command
✅ DEL command
✅ EXISTS command
✅ HASH operations
✅ Pipeline operations

================================================
📊 Test Results:
   Total Tests: 10
   Passed: 10
   Failed: 0
================================================

✅ All Redis tests passed successfully!

🎉 Redis is ready for production use

📌 Redis Version: 7.0.15
💾 Memory Used: 1.02M
```

---

## Step 4: Verify Everything is Working

```bash
# Check Redis service status
sudo systemctl status redis-server

# Should show: "active (running)"
```

---

## 🔐 Security Verification

After setup, verify these security settings:

```bash
# 1. Check Redis is bound to localhost only
sudo netstat -tlnp | grep 6379
# Should show: 127.0.0.1:6379 (NOT 0.0.0.0:6379)

# 2. Verify password is required
redis-cli PING
# Should return: (error) NOAUTH Authentication required

# 3. Test with password (get password from credentials file)
cat /root/.zeusodx-redis-credentials
# Copy the password, then:
redis-cli -a 'YOUR_PASSWORD_HERE' PING
# Should return: PONG
```

---

## 📋 Important Files Created

1. **Redis Config**: `/etc/redis/redis.conf`
2. **Credentials**: `/root/.zeusodx-redis-credentials` (keep secure!)
3. **Environment**: `/var/www/ZeusODX-server/.env` (updated)
4. **Backup**: `/etc/redis/redis.conf.backup` (original config)

---

## 🛠️ Useful Commands

### Check Status
```bash
sudo systemctl status redis-server
```

### View Logs
```bash
sudo tail -f /var/log/redis/redis-server.log
```

### Redis CLI (with password)
```bash
# Get password first
cat /root/.zeusodx-redis-credentials | grep Password

# Connect
redis-cli -a 'YOUR_PASSWORD'
```

### Monitor Redis Activity
```bash
redis-cli -a 'YOUR_PASSWORD' MONITOR
```

### Check Memory Usage
```bash
redis-cli -a 'YOUR_PASSWORD' INFO memory | grep used_memory_human
```

### Check Number of Keys
```bash
redis-cli -a 'YOUR_PASSWORD' DBSIZE
```

---

## 🔧 Troubleshooting

### Redis Won't Start
```bash
# Check logs
sudo journalctl -u redis-server -n 50

# Check config syntax
sudo redis-server /etc/redis/redis.conf --test-memory 1
```

### Can't Connect from Node.js
```bash
# Verify .env has correct password
cat /var/www/ZeusODX-server/.env | grep REDIS_PASSWORD

# Compare with actual Redis password
cat /root/.zeusodx-redis-credentials | grep Password

# If they don't match, update .env:
nano /var/www/ZeusODX-server/.env
```

### Memory Issues
```bash
# Check current memory usage
redis-cli -a 'YOUR_PASSWORD' INFO memory

# Check max memory setting
redis-cli -a 'YOUR_PASSWORD' CONFIG GET maxmemory
# Should return: 512mb (536870912 bytes)
```

---

## ⚠️ Important Notes

1. **Keep Password Secure**: Never commit the password to git
2. **Backup Credentials**: Save `/root/.zeusodx-redis-credentials` somewhere safe
3. **Localhost Only**: Redis should ONLY listen on 127.0.0.1 (already configured)
4. **Firewall**: Port 6379 should NOT be open to the internet
5. **Memory**: Current limit is 512MB (can be increased if needed)

---

## ✅ What's Next?

Once Redis tests pass, you're ready for:
1. ✅ Race condition fix implementation
2. ✅ 2FA brute force protection
3. ✅ PIN lockout system

These will be implemented automatically after Redis is confirmed working.

---

## 📞 Need Help?

If you encounter issues:
1. Check logs: `sudo journalctl -u redis-server -n 50`
2. Verify .env password matches credentials file
3. Ensure Redis service is running: `sudo systemctl status redis-server`
4. Test basic connection: `redis-cli -a 'PASSWORD' PING`

---

**Created:** 2026-01-01
**Redis Version:** 7.0.15
**Security Level:** Production-Ready
