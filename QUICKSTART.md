# Quick Start Guide

## ✅ Setup Complete!

Your project now has server integration for uploading tiles.

## 📁 What Changed

```
d:\Shadow\freelancer\satellite-tile-prototype\
├── server/                     ← NEW SERVER
│   ├── server.js              ← Main server code
│   ├── storage.js             ← In-memory storage
│   ├── package.json
│   └── .env
│
├── js/
│   └── app.js                 ← UPDATED with server integration
│
├── dashboard.html             ← NEW dashboard to view sessions
├── test-connection.html       ← NEW connection test page
└── QUICKSTART.md             ← This file
```

## 🚀 How to Run

### Step 1: Start the Server

```powershell
cd server
npm install
npm run dev
```

**Expected output:**
```
========================================
🚀 Satellite Tile Server
========================================
📡 Server: http://localhost:3001
💾 Storage: In-Memory (no Redis)
📁 Uploads: ./uploads
========================================
```

**Leave this terminal running!**

### Step 2: Test Server Connection

Open in browser: **test-connection.html**

Click the buttons to test:
1. ✅ Server Health
2. ✅ Create Session
3. ✅ Get Sessions

### Step 3: Open Main App

Open: **index.html** in browser

### Step 4: Generate Tiles

1. Enter sector code (e.g., "M713")
2. Click **"Generate 729 Tiles"**
3. Watch progress in console
4. Tiles are uploaded to server!

### Step 5: View Dashboard

Open: **dashboard.html** in browser

Monitor sessions in real-time!

## 📊 What Happens Now

### Before (Old):
- Generate tiles → Create ZIP → Download locally
- No server, no storage

### After (New):
- Generate tiles → Upload to server → Store in server/uploads/
- Session tracking
- Tile deduplication (cached tiles skip generation)
- Dashboard to view progress

## 🔍 Verify Everything Works

1. **Server running?** → http://localhost:3001/health
2. **Frontend working?** → Open index.html
3. **Connection OK?** → Open test-connection.html
4. **Dashboard working?** → Open dashboard.html

## 📝 Next Steps

- ✅ Server running locally (in-memory storage)
- ✅ Tiles upload to server
- ✅ Session management working
- ✅ Dashboard shows progress

Later you can:
- Add parallel upload (5-10 tiles at once)
- Generate PDF on server
- Deploy to production (VPS or Railway)

## ❓ Troubleshooting

**Can't connect to server:**
```powershell
# Make sure server is running
cd server
npm run dev
```

**CORS errors:**
- Server has CORS enabled, should work
- Make sure using same domain (localhost)

**Port already in use:**
- Change PORT in server/.env
- Update API_URL in js/app.js

## 🎉 You're Ready!

Everything is set up. Just:
1. Start server (cd server && npm run dev)
2. Open index.html
3. Generate tiles!

Check dashboard.html to see uploads in real-time.
