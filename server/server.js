// server.js - Complete server without Redis
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import storage from './storage.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// ==================== MIDDLEWARE ====================

app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
});

// ==================== MULTER STORAGE ====================

// Create uploads directory if it doesn't exist
const uploadsDir = './uploads';
try {
    await fs.mkdir(uploadsDir, { recursive: true });
} catch (err) {
    console.error('Failed to create uploads directory:', err);
}

const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Use flat uploads directory (files will be named uniquely)
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        // Generate unique filename with timestamp to avoid conflicts
        const timestamp = Date.now();
        const uniqueFilename = `${timestamp}_${file.originalname}`;
        cb(null, uniqueFilename);
    }
});

const upload = multer({
    storage: uploadStorage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'image/png') {
            cb(null, true);
        } else {
            cb(new Error('Only PNG files allowed'));
        }
    }
});

// ==================== HELPER FUNCTIONS ====================

function generateSessionId() {
    return `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function calculateFileHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

// ==================== ROUTES ====================

// Health check
app.get('/health', (req, res) => {
    const stats = storage.getStats();
    res.json({
        status: 'ok',
        storage: 'in-memory',
        ...stats
    });
});

// Create new session
app.post('/api/sessions/create', async (req, res) => {
    try {
        const { sectorCode } = req.body;

        if (!sectorCode) {
            return res.status(400).json({
                success: false,
                error: 'sectorCode is required'
            });
        }

        const sessionId = generateSessionId();

        const sessionData = {
            id: sessionId,
            sectorCode,
            status: 'uploading',
            totalTiles: 729,
            uploadedTiles: 0,
            tiles: [],
            createdAt: new Date().toISOString()
        };

        storage.createSession(sessionData);

        console.log(`✅ Session created: ${sessionId} (${sectorCode})`);

        res.json(sessionData);
    } catch (error) {
        console.error('❌ Error creating session:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Check if tile exists (deduplication)
app.get('/api/tile-exists/:tileCode', async (req, res) => {
    try {
        const { tileCode } = req.params;
        const sessionId = req.query.sessionId;

        const tile = storage.getTile(tileCode);

        if (tile) {
            // Verify file still exists on disk
            const exists = await fileExists(tile.filePath);

            if (exists) {
                // Add this session to the tile's usage tracking (if not already tracked)
                if (sessionId && !tile.usedBySessions.includes(sessionId)) {
                    tile.usedBySessions.push(sessionId);
                    storage.setTile(tileCode, tile);
                    storage.addTileToSession(sessionId, tileCode);

                    // Increment session progress (cached tiles count as "uploaded")
                    const session = storage.incrementSessionProgress(sessionId);
                    console.log(`🔗 Session ${sessionId} using cached tile: ${tileCode} (${session.uploadedTiles}/${session.totalTiles})`);
                }

                res.json({
                    exists: true,
                    cached: true,
                    tile
                });
            } else {
                // File missing, remove from cache
                storage.deleteTile(tileCode);
                res.json({
                    exists: false,
                    cached: false
                });
            }
        } else {
            res.json({
                exists: false,
                cached: false
            });
        }
    } catch (error) {
        console.error('❌ Error checking tile:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Upload tile
app.post('/api/upload-tile', upload.single('image'), async (req, res) => {
    try {
        const { sessionId, tileCode, position } = req.body;

        if (!sessionId || !tileCode || !req.file) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields'
            });
        }

        // Calculate file hash
        const fileBuffer = await fs.readFile(req.file.path);
        const hash = calculateFileHash(fileBuffer);

        // Store tile metadata
        const tileData = {
            tileCode,
            hash,
            filePath: req.file.path,
            createdAt: new Date().toISOString(),
            sizeBytes: fileBuffer.length,
            usedBySessions: [sessionId]
        };

        storage.setTile(tileCode, tileData);
        storage.addTileToSession(sessionId, tileCode);

        // Update session progress
        const session = storage.incrementSessionProgress(sessionId);

        console.log(`📤 Uploaded: ${tileCode} (${session.uploadedTiles}/${session.totalTiles})`);

        res.json({
            success: true,
            tileCode,
            cached: false,
            progress: {
                uploaded: session.uploadedTiles,
                total: session.totalTiles,
                percentage: ((session.uploadedTiles / session.totalTiles) * 100).toFixed(1)
            }
        });
    } catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get all sessions
app.get('/api/sessions', (req, res) => {
    try {
        const sessions = storage.getAllSessions();
        res.json(sessions);
    } catch (error) {
        console.error('❌ Error getting sessions:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get single session
app.get('/api/sessions/:sessionId', (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = storage.getSession(sessionId);

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Session not found'
            });
        }

        res.json(session);
    } catch (error) {
        console.error('❌ Error getting session:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Delete session
app.delete('/api/sessions/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = storage.getSession(sessionId);

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Session not found'
            });
        }

        // Remove tiles
        if (session.tiles) {
            for (const tileCode of session.tiles) {
                const tile = storage.getTile(tileCode);
                if (tile) {
                    // Remove session from usage list
                    tile.usedBySessions = tile.usedBySessions.filter(id => id !== sessionId);

                    if (tile.usedBySessions.length === 0) {
                        // No other sessions use this tile, delete it
                        try {
                            await fs.rm(tile.filePath, { force: true });
                            storage.deleteTile(tileCode);
                            console.log(`🗑️ Deleted tile: ${tileCode}`);
                        } catch (err) {
                            console.warn(`⚠️ Could not delete file: ${tile.filePath}`);
                        }
                    } else {
                        // Other sessions still use it, just update
                        storage.setTile(tileCode, tile);
                    }
                }
            }
        }

        // Delete upload folder
        const uploadDir = path.join(process.env.UPLOAD_DIR || './uploads', sessionId);
        try {
            await fs.rm(uploadDir, { recursive: true, force: true });
            console.log(`🗑️ Deleted upload folder: ${uploadDir}`);
        } catch (err) {
            console.warn(`⚠️ Could not delete folder: ${uploadDir}`);
        }

        // Delete session from storage
        storage.deleteSession(sessionId);

        console.log(`✅ Session deleted: ${sessionId}`);

        res.json({
            success: true,
            message: 'Session deleted successfully'
        });
    } catch (error) {
        console.error('❌ Error deleting session:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
    console.log('');
    console.log('========================================');
    console.log('🚀 Satellite Tile Server');
    console.log('========================================');
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`💾 Storage: In-Memory (no Redis)`);
    console.log(`📁 Uploads: ${process.env.UPLOAD_DIR || './uploads'}`);
    console.log('========================================');
    console.log('');
});
