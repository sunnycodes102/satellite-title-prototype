# Satellite Tile Server

Simple Node.js server for handling tile uploads (no Redis required).

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Server will run on: http://localhost:3001

## Features

- ✅ In-memory storage (no Redis needed)
- ✅ Session management
- ✅ File upload with deduplication
- ✅ SHA-256 file hashing
- ✅ Progress tracking
- ✅ CORS enabled

## API Endpoints

- `GET /health` - Health check
- `POST /api/sessions/create` - Create new session
- `GET /api/tile-exists/:tileCode` - Check if tile exists
- `POST /api/upload-tile` - Upload tile image
- `GET /api/sessions` - Get all sessions
- `GET /api/sessions/:sessionId` - Get session details
- `DELETE /api/sessions/:sessionId` - Delete session

## Environment Variables

See `.env` file for configuration.
