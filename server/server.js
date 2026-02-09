// server.js - Complete server without Redis
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import storage from './storage.js';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import archiver from 'archiver';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Create HTTP server and Socket.io
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Make io available to storage
export { io };

// Initialize Socket.io in storage for real-time updates
storage.setIO(io);

// Track ongoing PDF/EPS generations to prevent duplicates and handle disconnects
const ongoingGenerations = new Map(); // Key: `${sectorCode}-${format}`, Value: { startedAt, clientId, aborted }

// Handle client disconnections
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    socket.on('disconnect', () => {
        console.log(`🔌 Client disconnected: ${socket.id}`);

        // Mark any ongoing generations for this client as aborted
        for (const [key, generation] of ongoingGenerations.entries()) {
            if (generation.clientId === socket.id) {
                generation.aborted = true;
                console.log(`⚠️ Marking generation ${key} as aborted (client disconnected)`);
            }
        }
    });
});

// ==================== MIDDLEWARE ====================

app.use(cors());
app.use(express.json());

// Serve static files from parent directory (index.html, dashboard.html, js/, css/)
const staticDir = path.join(__dirname, '..');
app.use(express.static(staticDir));

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
    destination: async (req, file, cb) => {
        // Extract sector code from filename (M713111.png → M713)
        // This is more reliable than req.body.sectorCode which may not be parsed yet
        const sectorCode = file.originalname.substring(0, 4);

        if (sectorCode && /^[A-Z]\d{3}$/.test(sectorCode)) {
            // New sector-based organization
            const sectorDir = path.join(uploadsDir, sectorCode);
            try {
                await fs.mkdir(sectorDir, { recursive: true });
                cb(null, sectorDir);
            } catch (err) {
                console.error(`Error creating sector directory ${sectorDir}:`, err);
                cb(null, uploadsDir); // Fallback to flat structure
            }
        } else {
            // Legacy: flat structure (for backward compatibility)
            cb(null, uploadsDir);
        }
    },
    filename: (req, file, cb) => {
        // Extract sector code from filename (M713111.png → M713)
        const sectorCode = file.originalname.substring(0, 4);

        if (sectorCode && /^[A-Z]\d{3}$/.test(sectorCode)) {
            // New sector-based naming: just use tile code
            // File will be: uploads/M713/M713111.png
            cb(null, file.originalname);
        } else {
            // Legacy: timestamp-based naming
            // File will be: uploads/1234567890_M713111.png
            const timestamp = Date.now();
            const uniqueFilename = `${timestamp}_${file.originalname}`;
            cb(null, uniqueFilename);
        }
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

// Check if tile exists (new sector-based version)
app.get('/api/tiles/:tileCode/exists', async (req, res) => {
    try {
        const { tileCode } = req.params;
        const tile = storage.getTile(tileCode);

        if (tile) {
            // Verify file still exists on disk
            const exists = await fileExists(tile.filePath);

            if (exists) {
                res.json({
                    exists: true,
                    tile: {
                        tileCode: tile.tileCode,
                        sectorCode: tile.sectorCode,
                        filePath: tile.filePath,
                        createdAt: tile.createdAt
                    }
                });
            } else {
                // File missing, remove from cache
                storage.deleteTile(tileCode);
                res.json({ exists: false });
            }
        } else {
            res.json({ exists: false });
        }
    } catch (error) {
        console.error('❌ Error checking tile:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Legacy endpoint for backward compatibility
app.get('/api/tile-exists/:tileCode', async (req, res) => {
    try {
        const { tileCode } = req.params;
        const sessionId = req.query.sessionId;

        const tile = storage.getTile(tileCode);

        if (tile) {
            // Verify file still exists on disk
            const exists = await fileExists(tile.filePath);

            if (exists) {
                // Legacy session support
                if (sessionId) {
                    const session = storage.getSession(sessionId);
                    if (session && tile.usedBySessions && !tile.usedBySessions.includes(sessionId)) {
                        tile.usedBySessions.push(sessionId);
                        storage.setTile(tileCode, tile);
                        storage.addTileToSession(sessionId, tileCode);
                        storage.incrementSessionProgress(sessionId);
                    }
                }

                res.json({
                    exists: true,
                    cached: true,
                    tile
                });
            } else {
                storage.deleteTile(tileCode);
                res.json({ exists: false, cached: false });
            }
        } else {
            res.json({ exists: false, cached: false });
        }
    } catch (error) {
        console.error('❌ Error checking tile:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Upload tile (new sector-based version)
app.post('/api/tiles/upload', upload.single('image'), async (req, res) => {
    try {
        const { tileCode, sectorCode, jobId } = req.body;

        if (!tileCode || !sectorCode || !req.file) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: tileCode, sectorCode, and image file required'
            });
        }

        // Extract sector code from tile code for validation
        const tileSectorCode = tileCode.substring(0, 4);
        if (tileSectorCode !== sectorCode) {
            return res.status(400).json({
                success: false,
                error: `Tile code ${tileCode} does not match sector ${sectorCode}`
            });
        }

        // Calculate file hash
        const fileBuffer = await fs.readFile(req.file.path);
        const hash = calculateFileHash(fileBuffer);

        // Check if tile already exists (for replace-all mode)
        const existingTile = storage.getTile(tileCode);
        if (existingTile && existingTile.filePath) {
            try {
                await fs.rm(existingTile.filePath, { force: true });
                console.log(`🗑️ Replaced existing tile: ${tileCode}`);
            } catch (err) {
                console.warn(`⚠️ Could not delete old file: ${existingTile.filePath}`);
            }
        }

        // Normalize file path to use forward slashes (for cross-platform consistency)
        const normalizedPath = req.file.path.replace(/\\/g, '/');

        // Store tile metadata (sector-based, no usedBySessions)
        const tileData = {
            tileCode,
            sectorCode,
            hash,
            filePath: normalizedPath,
            createdAt: new Date().toISOString(),
            sizeBytes: fileBuffer.length
        };

        storage.setTile(tileCode, tileData);

        // Get or create sector
        let sector = storage.getSector(sectorCode);
        if (!sector) {
            sector = {
                sectorCode,
                totalTiles: 729,
                uploadedTiles: 0,
                missingTiles: generateAllTileCodesForSector(sectorCode),
                tiles: [],
                status: 'incomplete',
                createdAt: new Date().toISOString(),
                lastUpdatedAt: new Date().toISOString()
            };
            storage.createSector(sector);
        }

        // Add tile to sector
        storage.addTileToSector(sectorCode, tileCode);
        sector = storage.getSector(sectorCode); // Refresh

        // Update sector missing tiles
        const allTiles = generateAllTileCodesForSector(sectorCode);
        sector.missingTiles = allTiles.filter(code => !sector.tiles.includes(code));
        storage.updateSector(sectorCode, sector);

        // Update job progress if jobId provided
        let jobProgress = null;
        if (jobId) {
            const job = storage.getJob(jobId);
            if (job) {
                job.processedTiles++;
                job.uploadedTiles++;
                job.progress = job.processedTiles / job.totalTiles;
                storage.updateJob(jobId, job);

                jobProgress = {
                    processed: job.processedTiles,
                    total: job.totalTiles,
                    percentage: (job.progress * 100).toFixed(1)
                };
            }
        }

        console.log(`📤 Uploaded: ${tileCode} (Sector: ${sector.uploadedTiles}/729)`);

        res.json({
            success: true,
            tileCode,
            sectorCode,
            sectorProgress: {
                uploaded: sector.uploadedTiles,
                total: 729,
                percentage: (sector.uploadedTiles / 729 * 100).toFixed(1),
                status: sector.status
            },
            jobProgress
        });
    } catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Upload tile (legacy session-based version for backward compatibility)
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

        // Normalize file path to use forward slashes (for cross-platform consistency)
        const normalizedPath = req.file.path.replace(/\\/g, '/');

        // Store tile metadata
        const tileData = {
            tileCode,
            hash,
            filePath: normalizedPath,
            createdAt: new Date().toISOString(),
            sizeBytes: fileBuffer.length,
            usedBySessions: sessionId ? [sessionId] : []
        };

        storage.setTile(tileCode, tileData);
        storage.addTileToSession(sessionId, tileCode);

        // Update session progress
        const session = storage.incrementSessionProgress(sessionId);

        console.log(`📤 Uploaded (legacy): ${tileCode} (${session ? session.uploadedTiles : 0}/${session ? session.totalTiles : 0})`);

        res.json({
            success: true,
            tileCode,
            cached: false,
            progress: session ? {
                uploaded: session.uploadedTiles,
                total: session.totalTiles,
                percentage: ((session.uploadedTiles / session.totalTiles) * 100).toFixed(1)
            } : null
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

// ==================== SECTOR ENDPOINTS ====================

// Get all sectors
app.get('/api/sectors', (req, res) => {
    try {
        const sectors = storage.getAllSectors();
        res.json(sectors);
    } catch (error) {
        console.error('❌ Error getting sectors:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get specific sector details
app.get('/api/sectors/:sectorCode', (req, res) => {
    try {
        const { sectorCode } = req.params;
        const sector = storage.getSector(sectorCode);

        if (!sector) {
            // Sector doesn't exist yet - return empty state
            return res.json({
                sectorCode,
                totalTiles: 729,
                uploadedTiles: 0,
                missingTiles: generateAllTileCodesForSector(sectorCode),
                tiles: [],
                status: 'incomplete',
                exists: false
            });
        }

        res.json({
            ...sector,
            exists: true
        });
    } catch (error) {
        console.error('❌ Error getting sector:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get missing tiles for a sector
app.get('/api/sectors/:sectorCode/missing', (req, res) => {
    try {
        const { sectorCode } = req.params;
        const sector = storage.getSector(sectorCode);

        if (!sector) {
            // Sector doesn't exist - all tiles are missing
            const allTiles = generateAllTileCodesForSector(sectorCode);
            return res.json({
                sectorCode,
                missing: allTiles,
                count: allTiles.length
            });
        }

        res.json({
            sectorCode,
            missing: sector.missingTiles || [],
            count: sector.missingTiles ? sector.missingTiles.length : 0
        });
    } catch (error) {
        console.error('❌ Error getting missing tiles:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Delete sector and all its tiles
app.delete('/api/sectors/:sectorCode', async (req, res) => {
    try {
        const { sectorCode } = req.params;
        const sector = storage.getSector(sectorCode);

        if (!sector) {
            return res.status(404).json({
                success: false,
                error: 'Sector not found'
            });
        }

        console.log(`🗑️ Deleting sector: ${sectorCode} (${sector.tiles.length} tiles)`);

        // Delete all tile files for this sector
        let deletedFiles = 0;
        for (const tileCode of sector.tiles) {
            const tile = storage.getTile(tileCode);
            if (tile && tile.filePath) {
                try {
                    await fs.rm(tile.filePath, { force: true });
                    storage.deleteTile(tileCode);
                    deletedFiles++;
                } catch (err) {
                    console.warn(`⚠️ Could not delete file: ${tile.filePath}`);
                }
            }
        }

        // Delete sector from storage
        storage.deleteSector(sectorCode);

        console.log(`✅ Sector deleted: ${sectorCode} (${deletedFiles} files removed)`);

        res.json({
            success: true,
            message: `Sector ${sectorCode} deleted successfully`,
            tilesDeleted: deletedFiles
        });
    } catch (error) {
        console.error('❌ Error deleting sector:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Start generation job for a sector
app.post('/api/sectors/start-generation', (req, res) => {
    try {
        const { sectorCode, mode } = req.body;

        if (!sectorCode) {
            return res.status(400).json({
                success: false,
                error: 'sectorCode is required'
            });
        }

        if (!mode || !['replace-all', 'only-missing'].includes(mode)) {
            return res.status(400).json({
                success: false,
                error: 'mode must be "replace-all" or "only-missing"'
            });
        }

        // Get or create sector
        let sector = storage.getSector(sectorCode);
        if (!sector) {
            // Create new sector
            sector = {
                sectorCode,
                totalTiles: 729,
                uploadedTiles: 0,
                missingTiles: generateAllTileCodesForSector(sectorCode),
                tiles: [],
                status: 'incomplete',
                createdAt: new Date().toISOString(),
                lastUpdatedAt: new Date().toISOString()
            };
            storage.createSector(sector);
        } else {
            // Recalculate missing tiles to ensure accuracy
            sector = storage.recalculateMissingTiles(sectorCode);
        }

        // Determine which tiles to generate based on mode
        let tilesToGenerate;
        if (mode === 'replace-all') {
            // Regenerate all 729 tiles
            tilesToGenerate = generateAllTileCodesForSector(sectorCode);
        } else {
            // Only generate missing tiles
            tilesToGenerate = sector.missingTiles || [];
        }

        // Create generation job
        const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const job = {
            jobId,
            sectorCode,
            mode,
            totalTiles: tilesToGenerate.length,
            processedTiles: 0,
            uploadedTiles: 0,
            skippedTiles: 0,
            failedTiles: [],
            status: 'running',
            startedAt: new Date().toISOString(),
            completedAt: null,
            progress: 0
        };

        storage.createJob(job);

        console.log(`🚀 Started generation job: ${jobId}`);
        console.log(`   Sector: ${sectorCode}`);
        console.log(`   Mode: ${mode}`);
        console.log(`   Tiles to generate: ${tilesToGenerate.length}`);

        res.json({
            success: true,
            jobId,
            sectorCode,
            mode,
            tilesToGenerate,
            existingTiles: sector.uploadedTiles,
            totalTiles: tilesToGenerate.length
        });
    } catch (error) {
        console.error('❌ Error starting generation:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get generation job progress
app.get('/api/jobs/:jobId', (req, res) => {
    try {
        const { jobId } = req.params;
        const job = storage.getJob(jobId);

        if (!job) {
            return res.status(404).json({
                success: false,
                error: 'Job not found'
            });
        }

        res.json(job);
    } catch (error) {
        console.error('❌ Error getting job:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Helper function to generate all possible tile codes for a sector
function generateAllTileCodesForSector(sectorCode) {
    const tiles = [];
    for (let i = 1; i <= 9; i++) {
        for (let j = 1; j <= 9; j++) {
            for (let k = 1; k <= 9; k++) {
                tiles.push(`${sectorCode}${i}${j}${k}`);
            }
        }
    }
    return tiles;
}

// ==================== SECTOR-BASED DOWNLOADS ====================

// Download all tiles as ZIP
app.get('/api/sectors/:sectorCode/tiles-zip', async (req, res) => {
    try {
        const { sectorCode } = req.params;
        const sector = storage.getSector(sectorCode);

        if (!sector) {
            return res.status(404).json({ success: false, error: 'Sector not found' });
        }

        if (sector.status !== 'complete') {
            return res.status(400).json({
                success: false,
                error: `Cannot download incomplete sector (${sector.uploadedTiles}/729 tiles)`
            });
        }

        // Check if generation already in progress
        const generationKey = `${sectorCode}-zip`;
        if (ongoingGenerations.has(generationKey)) {
            return res.status(409).json({
                success: false,
                error: 'ZIP generation already in progress for this sector',
                inProgress: true
            });
        }

        console.log(`📦 Generating tiles ZIP for sector: ${sectorCode}`);

        // Track this generation
        const clientId = req.headers['x-socket-id'] || 'unknown';
        const generation = { startedAt: Date.now(), clientId, aborted: false };
        ongoingGenerations.set(generationKey, generation);

        // Clean up on response close
        res.on('close', () => {
            generation.aborted = true;
        });

        // Emit initial progress
        io.emit('download:progress', {
            type: 'zip',
            sectorCode,
            processed: 0,
            total: sector.tiles.length,
            percentage: 0,
            status: 'starting'
        });

        // Create ZIP archive
        const archive = archiver('zip', { zlib: { level: 9 } });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${sectorCode}_tiles.zip"`);
        archive.pipe(res);

        let processedTiles = 0;
        const totalTiles = sector.tiles.length;

        for (const tileCode of sector.tiles) {
            if (generation.aborted || res.closed) {
                console.log(`⚠️ Aborting ZIP generation for ${sectorCode}`);
                archive.abort();
                ongoingGenerations.delete(generationKey);
                return;
            }

            const tile = storage.getTile(tileCode);
            if (!tile || !tile.filePath) continue;

            const exists = await fileExists(tile.filePath);
            if (!exists) continue;

            // Add file to archive
            archive.file(tile.filePath, { name: `${tileCode}.png` });
            processedTiles++;

            // Emit progress every 50 tiles
            if (processedTiles % 50 === 0 || processedTiles === totalTiles) {
                const percentage = Math.round((processedTiles / totalTiles) * 100);
                io.emit('download:progress', {
                    type: 'zip',
                    sectorCode,
                    processed: processedTiles,
                    total: totalTiles,
                    percentage,
                    status: 'processing'
                });
            }
        }

        await archive.finalize();

        // Emit completion
        io.emit('download:progress', {
            type: 'zip',
            sectorCode,
            processed: processedTiles,
            total: totalTiles,
            percentage: 100,
            status: 'complete'
        });

        console.log(`✅ ZIP generated: ${processedTiles} tiles`);
        ongoingGenerations.delete(generationKey);

    } catch (error) {
        console.error('❌ Error generating ZIP:', error);
        ongoingGenerations.delete(`${req.params.sectorCode}-zip`);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
});

// ==================== SECTOR-BASED PDF/EPS GENERATION ====================

// Create exports directory for cached files
const exportsDir = './exports';
try {
    await fs.mkdir(exportsDir, { recursive: true });
} catch (err) {
    console.error('Failed to create exports directory:', err);
}

// Check EPS cache status
app.get('/api/sectors/:sectorCode/eps-status', async (req, res) => {
    try {
        const { sectorCode } = req.params;
        const cachedPath = path.join(exportsDir, `${sectorCode}_eps.zip`);

        try {
            const stats = await fs.stat(cachedPath);
            res.json({
                cached: true,
                filename: `${sectorCode}_eps.zip`,
                size: stats.size,
                createdAt: stats.mtime.toISOString()
            });
        } catch {
            res.json({ cached: false });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Download cached EPS (fast)
app.get('/api/sectors/:sectorCode/eps-cached', async (req, res) => {
    try {
        const { sectorCode } = req.params;
        const cachedPath = path.join(exportsDir, `${sectorCode}_eps.zip`);

        try {
            await fs.access(cachedPath);
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${sectorCode}_eps.zip"`);
            createReadStream(cachedPath).pipe(res);
            console.log(`📦 Serving cached EPS for ${sectorCode}`);
        } catch {
            res.status(404).json({ success: false, error: 'No cached EPS found. Generate first.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete cached EPS
app.delete('/api/sectors/:sectorCode/eps-cached', async (req, res) => {
    try {
        const { sectorCode } = req.params;
        const cachedPath = path.join(exportsDir, `${sectorCode}_eps.zip`);

        try {
            await fs.rm(cachedPath, { force: true });
            console.log(`🗑️ Deleted cached EPS for ${sectorCode}`);
            res.json({ success: true });
        } catch {
            res.json({ success: true, message: 'No cached file to delete' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Generate PDF for sector - 11 column layout
app.get('/api/sectors/:sectorCode/pdf-11col', async (req, res) => {
    // PDF generation temporarily disabled
    return res.status(503).json({
        success: false,
        error: 'PDF generation is temporarily disabled'
    });

    try {
        const { sectorCode } = req.params;
        const sector = storage.getSector(sectorCode);

        if (!sector) {
            return res.status(404).json({
                success: false,
                error: 'Sector not found'
            });
        }

        if (sector.status !== 'complete') {
            return res.status(400).json({
                success: false,
                error: `Cannot generate PDF for incomplete sector (${sector.uploadedTiles}/729 tiles)`,
                missing: sector.missingTiles.length
            });
        }

        // Check if generation already in progress
        const generationKey = `${sectorCode}-pdf`;
        if (ongoingGenerations.has(generationKey)) {
            return res.status(409).json({
                success: false,
                error: 'PDF generation already in progress for this sector',
                inProgress: true
            });
        }

        console.log(`📄 Generating PDF (11-column) for sector: ${sectorCode} (${sector.tiles.length} tiles)`);

        // Track this generation
        const clientId = req.headers['x-socket-id'] || 'unknown';
        const generation = { startedAt: Date.now(), clientId, aborted: false };
        ongoingGenerations.set(generationKey, generation);

        const pageWidth = 3744;
        const pageHeight = 2754;
        const tilesPerRow = 11;
        const tilesPerColumn = 9;
        const tilesPerPage = 99;
        const tileWidth = 340.36;
        const tileHeight = 306;
        const totalTiles = sector.tiles.length;
        const totalPages = Math.ceil(totalTiles / tilesPerPage);

        const tempFiles = [];
        let processedTiles = 0;

        // Clean up on response close/error
        res.on('close', () => {
            generation.aborted = true;
            console.log(`⚠️ Response closed for ${generationKey}`);
        });

        // Emit initial progress
        io.emit('download:progress', {
            type: 'pdf',
            sectorCode,
            processed: 0,
            total: totalTiles,
            percentage: 0,
            status: 'starting',
            currentPage: 0,
            totalPages
        });

        // Generate separate PDF for each page
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            if (generation.aborted || res.closed) {
                console.log(`⚠️ Aborting PDF generation for ${sectorCode} (client disconnected)`);
                // Clean up temp files
                for (const f of tempFiles) {
                    try { await fs.rm(f, { force: true }); } catch {}
                }
                ongoingGenerations.delete(generationKey);
                return;
            }

            const pageFilePath = path.join(uploadsDir, `temp_${Date.now()}_page${pageNum}.pdf`);
            tempFiles.push(pageFilePath);

            const doc = new PDFDocument({
                size: [pageWidth, pageHeight],
                margin: 0,
                pdfVersion: '1.7',
                compress: false,
                info: {
                    Title: `${sectorCode} Page ${pageNum}/${totalPages}`,
                    Author: 'Satellite Tile Generator',
                    Subject: `Satellite tiles for sector ${sectorCode}`,
                    Creator: 'PDFKit',
                    Producer: 'Satellite Tile Generator'
                }
            });

            const writeStream = createWriteStream(pageFilePath);
            doc.pipe(writeStream);

            const startIdx = (pageNum - 1) * tilesPerPage;
            const endIdx = Math.min(startIdx + tilesPerPage, sector.tiles.length);
            const pageTiles = sector.tiles.slice(startIdx, endIdx);

            let tileCount = 0;
            for (const tileCode of pageTiles) {
                if (generation.aborted || res.closed) {
                    doc.end();
                    break;
                }

                const tile = storage.getTile(tileCode);
                if (!tile || !tile.filePath) {
                    console.log(`⚠️ Skipping ${tileCode}: No tile metadata or filePath`);
                    continue;
                }

                const exists = await fileExists(tile.filePath);
                if (!exists) {
                    console.log(`⚠️ Skipping ${tileCode}: File not found at ${tile.filePath}`);
                    continue;
                }

                // Column-by-column layout: fill vertically first (top to bottom), then move right
                const col = Math.floor(tileCount / tilesPerColumn);  // Column index (0-10)
                const row = tileCount % tilesPerColumn;              // Row index (0-8)

                // Cell position (top-left corner of cell)
                const cellX = col * tileWidth;
                const cellY = row * tileHeight;

                try {
                    // Get image dimensions to calculate actual size at 300 DPI
                    const metadata = await sharp(tile.filePath).metadata();
                    // Calculate actual image dimensions in points (pixels / 300 DPI * 72 points/inch)
                    const imgWidth = (metadata.width / 300) * 72;
                    const imgHeight = (metadata.height / 300) * 72;

                    // Place image at top-left corner of cell with original dimensions
                    doc.image(tile.filePath, cellX, cellY, {
                        width: imgWidth,
                        height: imgHeight,
                        compress: false
                    });
                    tileCount++;
                    processedTiles++;

                    // Emit progress every 10 tiles
                    if (processedTiles % 10 === 0 || processedTiles === totalTiles) {
                        const percentage = Math.round((processedTiles / totalTiles) * 100);
                        io.emit('download:progress', {
                            type: 'pdf',
                            sectorCode,
                            processed: processedTiles,
                            total: totalTiles,
                            percentage,
                            status: 'processing',
                            currentPage: pageNum,
                            totalPages
                        });
                    }
                } catch (err) {
                    console.error(`❌ Error adding tile ${tileCode}:`, err);
                }
            }

            doc.end();
            await new Promise((resolve, reject) => {
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });
        }

        // Create ZIP archive with all PDF pages
        const archive = archiver('zip', { zlib: { level: 9 } });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${sectorCode}_tiles_11col_pdf.zip"`);
        archive.pipe(res);

        for (let i = 0; i < totalPages; i++) {
            archive.file(tempFiles[i], { name: `${sectorCode}_page${i+1}_11col.pdf` });
        }

        await archive.finalize();

        console.log(`✅ PDF generated: ${processedTiles} tiles across ${totalPages} pages`);

        // Emit completion
        io.emit('download:progress', {
            type: 'pdf',
            sectorCode,
            processed: processedTiles,
            total: totalTiles,
            percentage: 100,
            status: 'complete'
        });

        // Clean up temp files
        for (const f of tempFiles) {
            try { await fs.rm(f, { force: true }); } catch {}
        }

        // Clean up tracking
        ongoingGenerations.delete(generationKey);
    } catch (error) {
        console.error('❌ Error generating PDF:', error);
        ongoingGenerations.delete(generationKey);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Generate EPS for sector - 11 column layout (with caching)
app.get('/api/sectors/:sectorCode/eps-11col', async (req, res) => {
    const tempFiles = [];
    try {
        const { sectorCode } = req.params;
        const rebuild = req.query.rebuild === 'true';
        const sector = storage.getSector(sectorCode);
        const cachedPath = path.join(exportsDir, `${sectorCode}_eps.zip`);

        if (!sector) {
            return res.status(404).json({ success: false, error: 'Sector not found' });
        }

        if (sector.status !== 'complete') {
            return res.status(400).json({
                success: false,
                error: `Cannot generate EPS for incomplete sector (${sector.uploadedTiles}/729 tiles)`
            });
        }

        // Check for cached file if not rebuilding
        if (!rebuild) {
            try {
                await fs.access(cachedPath);
                console.log(`📦 Serving cached EPS for ${sectorCode}`);
                res.setHeader('Content-Type', 'application/zip');
                res.setHeader('Content-Disposition', `attachment; filename="${sectorCode}_eps.zip"`);
                createReadStream(cachedPath).pipe(res);
                return;
            } catch {
                // No cache, continue to generate
            }
        }

        // Check if generation already in progress
        const generationKey = `${sectorCode}-eps`;
        if (ongoingGenerations.has(generationKey)) {
            return res.status(409).json({
                success: false,
                error: 'EPS generation already in progress for this sector',
                inProgress: true
            });
        }

        console.log(`📄 Generating EPS (11-column) for sector: ${sectorCode}${rebuild ? ' (rebuild)' : ''}`);

        // Track this generation
        const clientId = req.headers['x-socket-id'] || 'unknown';
        const generation = { startedAt: Date.now(), clientId, aborted: false };
        ongoingGenerations.set(generationKey, generation);

        // Clean up on response close/error
        res.on('close', () => {
            generation.aborted = true;
            console.log(`⚠️ Response closed for ${generationKey}`);
        });

        const pageWidth = 3744;
        const pageHeight = 2754;
        const tilesPerPage = 99;
        const tileWidth = 340.36;
        const tileHeight = 306;
        const totalPages = Math.ceil(sector.tiles.length / tilesPerPage);
        const totalTiles = sector.tiles.length;
        let processedTiles = 0;

        // Emit initial progress
        io.emit('download:progress', {
            type: 'eps',
            sectorCode,
            processed: 0,
            total: totalTiles,
            percentage: 0,
            status: 'starting',
            currentPage: 0,
            totalPages
        });

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            const pageFilePath = path.join(uploadsDir, `temp_${Date.now()}_page${pageNum}.eps`);
            tempFiles.push(pageFilePath);
            const writeStream = createWriteStream(pageFilePath, { encoding: 'utf8' });

            const startIdx = (pageNum - 1) * tilesPerPage;
            const endIdx = Math.min(startIdx + tilesPerPage, sector.tiles.length);
            const pageTiles = sector.tiles.slice(startIdx, endIdx);

            writeStream.write(`%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 ${Math.ceil(pageWidth)} ${Math.ceil(pageHeight)}
%%Title: ${sectorCode} Page ${pageNum}/${totalPages}
%%EndComments
%%Page: 1 1

`);

            let tileCount = 0;
            for (const tileCode of pageTiles) {
                // Check if generation should be aborted
                if (generation.aborted || res.closed) {
                    console.log(`⚠️ Aborting EPS generation for ${sectorCode} (client disconnected)`);
                    writeStream.end();
                    ongoingGenerations.delete(generationKey);
                    // Clean up temp files
                    for (const f of tempFiles) {
                        try { await fs.rm(f, { force: true }); } catch {}
                    }
                    return;
                }

                const tile = storage.getTile(tileCode);
                if (!tile || !tile.filePath) continue;
                if (!await fileExists(tile.filePath)) continue;

                const positionOnPage = tileCount;
                // Column-by-column layout: fill vertically first (top to bottom), then move right
                const col = Math.floor(positionOnPage / 9);  // Column index (0-10)
                const row = positionOnPage % 9;              // Row index (0-8)

                // Cell position (top-left corner of cell)
                const cellX = col * tileWidth;
                const cellY = pageHeight - (row * tileHeight);

                try {
                    const metadata = await sharp(tile.filePath).metadata();
                    // Remove alpha channel and convert to RGB (EPS expects RGB, not RGBA)
                    const rawData = await sharp(tile.filePath)
                        .removeAlpha()
                        .raw()
                        .toBuffer();

                    // Calculate actual image dimensions in points (assuming 300 DPI)
                    // Formula: pixels / 300 DPI * 72 points/inch
                    const imgWidth = (metadata.width / 300) * 72;
                    const imgHeight = (metadata.height / 300) * 72;

                    // Position image at top-left corner of cell
                    // In PostScript, origin is bottom-left, so we need to position from top
                    const imgX = cellX;
                    const imgY = cellY - imgHeight;

                    writeStream.write(`
gsave
${imgX.toFixed(2)} ${imgY.toFixed(2)} translate
${imgWidth.toFixed(2)} ${imgHeight.toFixed(2)} scale
/DeviceRGB setcolorspace
<< /ImageType 1 /Width ${metadata.width} /Height ${metadata.height}
   /ImageMatrix [${metadata.width} 0 0 -${metadata.height} 0 ${metadata.height}]
   /DataSource <`);

                    const hexData = rawData.toString('hex').toUpperCase();
                    for (let i = 0; i < hexData.length; i += 80) {
                        writeStream.write(hexData.substring(i, Math.min(i + 80, hexData.length)) + '\n');
                    }

                    writeStream.write(`> /BitsPerComponent 8 /Decode [0 1 0 1 0 1]
>> image
grestore
`);
                    tileCount++;
                    processedTiles++;

                    // Emit progress every 10 tiles
                    if (processedTiles % 10 === 0) {
                        const percentage = Math.round((processedTiles / totalTiles) * 100);
                        io.emit('download:progress', {
                            type: 'eps',
                            sectorCode,
                            processed: processedTiles,
                            total: totalTiles,
                            percentage,
                            status: 'processing',
                            currentPage: pageNum,
                            totalPages
                        });
                    }
                } catch (err) {
                    console.error(`❌ Error processing ${tileCode}:`, err);
                }
            }

            writeStream.write('showpage\n%%EOF\n');
            await new Promise((resolve, reject) => {
                writeStream.end(() => resolve());
                writeStream.on('error', reject);
            });
        }

        // Create ZIP and save to cache
        const archive = archiver('zip', { zlib: { level: 9 } });
        const cacheWriteStream = createWriteStream(cachedPath);
        archive.pipe(cacheWriteStream);

        for (let i = 0; i < totalPages; i++) {
            archive.file(tempFiles[i], { name: `${sectorCode}_page${i+1}_11col.eps` });
        }

        await archive.finalize();

        // Wait for file to be written
        await new Promise((resolve, reject) => {
            cacheWriteStream.on('finish', resolve);
            cacheWriteStream.on('error', reject);
        });

        console.log(`✅ EPS ZIP generated and cached: ${cachedPath}`);

        // Emit completion
        io.emit('download:progress', {
            type: 'eps',
            sectorCode,
            processed: processedTiles,
            total: totalTiles,
            percentage: 100,
            status: 'complete',
            currentPage: totalPages,
            totalPages
        });

        // Clean up tracking
        ongoingGenerations.delete(generationKey);

        // Clean up temp EPS files
        for (const f of tempFiles) {
            try { await fs.rm(f, { force: true }); } catch {}
        }

        // Send cached file to client
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${sectorCode}_eps.zip"`);
        createReadStream(cachedPath).pipe(res);
    } catch (error) {
        console.error('❌ Error generating EPS:', error);
        ongoingGenerations.delete(generationKey);
        for (const f of tempFiles) {
            try { await fs.rm(f, { force: true }); } catch {}
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

// Generate PDF from session tiles
app.get('/api/sessions/:sessionId/pdf', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = storage.getSession(sessionId);

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Session not found'
            });
        }

        if (!session.tiles || session.tiles.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No tiles in this session'
            });
        }

        console.log(`📄 Generating PDF for session: ${sessionId} (${session.tiles.length} tiles)`);

        // Create PDF document (A4 size: 595 x 842 points)
        const doc = new PDFDocument({
            size: 'A4',
            margin: 20,
            info: {
                Title: `Satellite Tiles - ${session.sectorCode}`,
                Author: 'Satellite Tile Generator',
                Subject: `${session.tiles.length} tiles for sector ${session.sectorCode}`
            }
        });

        // Set response headers
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${session.sectorCode}_tiles.pdf"`);

        // Pipe PDF to response
        doc.pipe(res);

        // Layout configuration
        const pageWidth = 595;
        const pageHeight = 842;
        const margin = 20;
        const tilesPerRow = 3;
        const tilesPerColumn = 3;
        const tilesPerPage = tilesPerRow * tilesPerColumn; // 9 tiles per page
        const availableWidth = pageWidth - (margin * 2);
        const availableHeight = pageHeight - (margin * 2);
        const tileWidth = availableWidth / tilesPerRow;
        const tileHeight = availableHeight / tilesPerColumn;

        let tileCount = 0;

        // Add tiles to PDF
        for (const tileCode of session.tiles) {
            const tile = storage.getTile(tileCode);

            if (!tile || !tile.filePath) {
                console.warn(`⚠️ Tile ${tileCode} not found, skipping`);
                continue;
            }

            // Check if file exists
            const exists = await fileExists(tile.filePath);
            if (!exists) {
                console.warn(`⚠️ File not found for tile ${tileCode}, skipping`);
                continue;
            }

            // Calculate position on current page
            const positionOnPage = tileCount % tilesPerPage;
            // Column-by-column layout: fill vertically first (top to bottom), then move right
            const col = Math.floor(positionOnPage / tilesPerColumn);
            const row = positionOnPage % tilesPerColumn;
            const x = margin + (col * tileWidth);
            const y = margin + (row * tileHeight);

            // Add new page if needed (except for first tile)
            if (tileCount > 0 && positionOnPage === 0) {
                doc.addPage();
            }

            try {
                // Add image to PDF with fit option to maintain aspect ratio
                doc.image(tile.filePath, x, y, {
                    fit: [tileWidth - 4, tileHeight - 4], // Small padding
                    align: 'center',
                    valign: 'center'
                });

                // Add tile code label below image
                doc.fontSize(8)
                   .fillColor('#666666')
                   .text(tileCode, x, y + tileHeight - 15, {
                       width: tileWidth,
                       align: 'center'
                   });

                tileCount++;
            } catch (imageError) {
                console.error(`❌ Error adding tile ${tileCode} to PDF:`, imageError);
            }
        }

        // Add summary page at the end
        doc.addPage();
        doc.fontSize(20)
           .fillColor('#000000')
           .text(`Satellite Tiles - ${session.sectorCode}`, margin, margin + 100, {
               align: 'center'
           });

        doc.fontSize(14)
           .text(`Total tiles: ${tileCount}`, margin, margin + 150, {
               align: 'center'
           });

        doc.fontSize(10)
           .fillColor('#666666')
           .text(`Generated: ${new Date().toLocaleString()}`, margin, margin + 180, {
               align: 'center'
           });

        // Finalize PDF
        doc.end();

        console.log(`✅ PDF generated: ${tileCount} tiles`);

    } catch (error) {
        console.error('❌ Error generating PDF:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Generate PDF - Option A: 10 columns (4.75" tiles, 91.3% material efficiency)
app.get('/api/sessions/:sessionId/pdf-10col', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = storage.getSession(sessionId);

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Session not found'
            });
        }

        if (!session.tiles || session.tiles.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No tiles in this session'
            });
        }

        console.log(`📄 Generating PDF (10-column layout) for session: ${sessionId} (${session.tiles.length} tiles)`);

        // Vinyl roll dimensions: 52" × 38.25" = 3744 × 2754 points (at 72 DPI)
        const pageWidth = 3744;   // 52 inches
        const pageHeight = 2754;  // 38.25 inches

        // Create PDF document with custom vinyl roll size
        const doc = new PDFDocument({
            size: [pageWidth, pageHeight],
            margin: 0,  // No margins for vinyl printing
            info: {
                Title: `Satellite Tiles - ${session.sectorCode} (10-Column Layout)`,
                Author: 'Satellite Tile Generator',
                Subject: `${session.tiles.length} tiles for sector ${session.sectorCode} - 10 columns per page`
            }
        });

        // Set response headers
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${session.sectorCode}_tiles_10col.pdf"`);

        // Pipe PDF to response
        doc.pipe(res);

        // Layout configuration - Option A: 10 columns × 9 rows
        const tilesPerRow = 10;     // 10 columns
        const tilesPerColumn = 9;   // 9 rows (38.25" ÷ 4.25")
        const tilesPerPage = tilesPerRow * tilesPerColumn; // 90 tiles per page
        const tileWidth = 342;      // 4.75" × 72 DPI = 342 points
        const tileHeight = 306;     // 4.25" × 72 DPI = 306 points

        let tileCount = 0;

        // Add tiles to PDF
        for (const tileCode of session.tiles) {
            const tile = storage.getTile(tileCode);

            if (!tile || !tile.filePath) {
                console.warn(`⚠️ Tile ${tileCode} not found, skipping`);
                continue;
            }

            // Check if file exists
            const exists = await fileExists(tile.filePath);
            if (!exists) {
                console.warn(`⚠️ File not found for tile ${tileCode}, skipping`);
                continue;
            }

            // Calculate position on current page
            const positionOnPage = tileCount % tilesPerPage;
            const col = positionOnPage % tilesPerRow;
            const row = Math.floor(positionOnPage / tilesPerRow);
            const x = col * tileWidth;
            const y = row * tileHeight;

            // Add new page if needed (except for first tile)
            if (tileCount > 0 && positionOnPage === 0) {
                doc.addPage();
            }

            try {
                // Add image to PDF with LOSSLESS quality (no compression)
                doc.image(tile.filePath, x, y, {
                    width: tileWidth,
                    height: tileHeight,
                    compress: false  // CRITICAL: Preserve original quality
                });

                tileCount++;
            } catch (imageError) {
                console.error(`❌ Error adding tile ${tileCode} to PDF:`, imageError);
            }
        }

        // Finalize PDF (no summary page for production printing)
        doc.end();

        console.log(`✅ PDF (10-column) generated: ${tileCount} tiles`);

    } catch (error) {
        console.error('❌ Error generating PDF:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Generate PDF - Option B: 11 columns (4.727" tiles, 99.9% material efficiency)
app.get('/api/sessions/:sessionId/pdf-11col', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = storage.getSession(sessionId);

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Session not found'
            });
        }

        if (!session.tiles || session.tiles.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No tiles in this session'
            });
        }

        console.log(`📄 Generating PDF (11-column layout) for session: ${sessionId} (${session.tiles.length} tiles)`);

        // Vinyl roll dimensions: 52" × 38.25" = 3744 × 2754 points (at 72 DPI)
        const pageWidth = 3744;   // 52 inches
        const pageHeight = 2754;  // 38.25 inches

        // Create PDF document with custom vinyl roll size
        const doc = new PDFDocument({
            size: [pageWidth, pageHeight],
            margin: 0,  // No margins for vinyl printing
            info: {
                Title: `Satellite Tiles - ${session.sectorCode} (11-Column Layout)`,
                Author: 'Satellite Tile Generator',
                Subject: `${session.tiles.length} tiles for sector ${session.sectorCode} - 11 columns per page`
            }
        });

        // Set response headers
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${session.sectorCode}_tiles_11col.pdf"`);

        // Pipe PDF to response
        doc.pipe(res);

        // Layout configuration - Option B: 11 columns × 9 rows
        const tilesPerRow = 11;      // 11 columns
        const tilesPerColumn = 9;    // 9 rows (38.25" ÷ 4.25")
        const tilesPerPage = tilesPerRow * tilesPerColumn; // 99 tiles per page
        const tileWidth = 340.36;    // 4.727" × 72 DPI ≈ 340.36 points (52" ÷ 11)
        const tileHeight = 306;      // 4.25" × 72 DPI = 306 points

        let tileCount = 0;

        // Add tiles to PDF
        for (const tileCode of session.tiles) {
            const tile = storage.getTile(tileCode);

            if (!tile || !tile.filePath) {
                console.warn(`⚠️ Tile ${tileCode} not found, skipping`);
                continue;
            }

            // Check if file exists
            const exists = await fileExists(tile.filePath);
            if (!exists) {
                console.warn(`⚠️ File not found for tile ${tileCode}, skipping`);
                continue;
            }

            // Calculate position on current page
            const positionOnPage = tileCount % tilesPerPage;
            const col = positionOnPage % tilesPerRow;
            const row = Math.floor(positionOnPage / tilesPerRow);
            const x = col * tileWidth;
            const y = row * tileHeight;

            // Add new page if needed (except for first tile)
            if (tileCount > 0 && positionOnPage === 0) {
                doc.addPage();
            }

            try {
                // Add image to PDF with LOSSLESS quality (no compression)
                doc.image(tile.filePath, x, y, {
                    width: tileWidth,
                    height: tileHeight,
                    compress: false  // CRITICAL: Preserve original quality
                });

                tileCount++;
            } catch (imageError) {
                console.error(`❌ Error adding tile ${tileCode} to PDF:`, imageError);
            }
        }

        // Finalize PDF (no summary page for production printing)
        doc.end();

        console.log(`✅ PDF (11-column) generated: ${tileCount} tiles`);

    } catch (error) {
        console.error('❌ Error generating PDF:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Generate EPS - Option B: 11 columns (4.727" tiles, 99.9% material efficiency)
// Generates 8 separate EPS files (one per page) and packages them in a ZIP
app.get('/api/sessions/:sessionId/eps-11col', async (req, res) => {
    const tempFiles = [];

    try {
        const { sessionId } = req.params;
        const session = storage.getSession(sessionId);

        if (!session) {
            return res.status(404).json({
                success: false,
                error: 'Session not found'
            });
        }

        if (!session.tiles || session.tiles.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No tiles in this session'
            });
        }

        console.log(`📄 Generating EPS (11-column layout) for session: ${sessionId} (${session.tiles.length} tiles)`);
        console.log(`   Generating 8 separate page files to avoid memory limits`);

        // Vinyl roll dimensions: 52" × 38.25" = 3744 × 2754 points (at 72 DPI)
        const pageWidth = 3744;   // 52 inches
        const pageHeight = 2754;  // 38.25 inches

        // Layout configuration - Option B: 11 columns × 9 rows
        const tilesPerRow = 11;      // 11 columns
        const tilesPerColumn = 9;    // 9 rows
        const tilesPerPage = tilesPerRow * tilesPerColumn; // 99 tiles per page
        const tileWidth = 340.36;    // 4.727" × 72 DPI
        const tileHeight = 306;      // 4.25" × 72 DPI

        // Calculate total pages needed
        const totalPages = Math.ceil(session.tiles.length / tilesPerPage);
        console.log(`   Total pages: ${totalPages}`);

        // Generate each page as a separate EPS file
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            const pageFilePath = path.join(uploadsDir, `temp_${Date.now()}_page${pageNum}.eps`);
            tempFiles.push(pageFilePath);

            const writeStream = createWriteStream(pageFilePath, { encoding: 'utf8' });

            // Calculate tile range for this page
            const startTileIndex = (pageNum - 1) * tilesPerPage;
            const endTileIndex = Math.min(startTileIndex + tilesPerPage, session.tiles.length);
            const pageTiles = session.tiles.slice(startTileIndex, endTileIndex);

            console.log(`   📄 Page ${pageNum}/${totalPages}: Tiles ${startTileIndex + 1}-${endTileIndex} (${pageTiles.length} tiles)`);

            // Write EPS header
            const header = `%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 ${Math.ceil(pageWidth)} ${Math.ceil(pageHeight)}
%%Title: Satellite Tiles - ${session.sectorCode} (11-Column Layout) - Page ${pageNum}/${totalPages}
%%Creator: Satellite Tile Generator
%%CreationDate: ${new Date().toISOString()}
%%Pages: 1
%%DocumentData: Clean7Bit
%%LanguageLevel: 2
%%EndComments
%%BeginProlog
%%EndProlog
%%Page: 1 1

`;
            writeStream.write(header);

            let tileCount = 0;

            // Process tiles for this page
            for (const tileCode of pageTiles) {
                const tile = storage.getTile(tileCode);

                if (!tile || !tile.filePath) {
                    console.warn(`⚠️ Tile ${tileCode} not found, skipping`);
                    continue;
                }

                // Check if file exists
                const exists = await fileExists(tile.filePath);
                if (!exists) {
                    console.warn(`⚠️ File not found for tile ${tileCode}, skipping`);
                    continue;
                }

                // Calculate position on this page
                const positionOnPage = tileCount;
                const col = positionOnPage % tilesPerRow;
                const row = Math.floor(positionOnPage / tilesPerRow);

                // EPS coordinates: origin is bottom-left
                const x = col * tileWidth;
                const y = pageHeight - ((row + 1) * tileHeight); // Flip Y coordinate

                try {
                    // Convert PNG to raw RGB data using sharp
                    const imageMetadata = await sharp(tile.filePath).metadata();
                    const imageWidth = imageMetadata.width;
                    const imageHeight = imageMetadata.height;

                    // Convert to raw RGB (3 bytes per pixel, no alpha)
                    const rawImageData = await sharp(tile.filePath)
                        .raw()
                        .toBuffer();

                    // Write PostScript commands for this tile
                    writeStream.write(`
% Tile: ${tileCode}
gsave
${x.toFixed(2)} ${y.toFixed(2)} translate
${tileWidth.toFixed(2)} ${tileHeight.toFixed(2)} scale

% RGB Image Data
/DeviceRGB setcolorspace
<<
  /ImageType 1
  /Width ${imageWidth}
  /Height ${imageHeight}
  /ImageMatrix [${imageWidth} 0 0 -${imageHeight} 0 ${imageHeight}]
  /DataSource <`);

                    // Write hex data in chunks to avoid building large strings
                    const hexData = rawImageData.toString('hex').toUpperCase();
                    for (let i = 0; i < hexData.length; i += 80) {
                        writeStream.write(hexData.substring(i, Math.min(i + 80, hexData.length)));
                        writeStream.write('\n');
                    }

                    writeStream.write(`>
  /BitsPerComponent 8
  /Decode [0 1 0 1 0 1]
>> image
grestore

`);

                    tileCount++;

                    if (tileCount % 10 === 0) {
                        console.log(`      Progress: ${tileCount}/${pageTiles.length} tiles`);
                    }

                } catch (imageError) {
                    console.error(`❌ Error processing tile ${tileCode} for EPS:`, imageError);
                }
            }

            // Write EPS footer
            writeStream.write(`
showpage
%%Trailer
%%EOF
`);

            // Close the write stream
            await new Promise((resolve, reject) => {
                writeStream.end(() => resolve());
                writeStream.on('error', reject);
            });

            console.log(`   ✅ Page ${pageNum} generated: ${tileCount} tiles`);
        }

        console.log(`📦 Creating ZIP archive with ${totalPages} EPS files...`);

        // Create ZIP archive
        const archive = archiver('zip', {
            zlib: { level: 9 } // Maximum compression
        });

        // Set response headers for ZIP download
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${session.sectorCode}_tiles_11col_eps.zip"`);

        // Pipe archive to response
        archive.pipe(res);

        // Add each EPS file to the archive
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
            const pageFilePath = tempFiles[pageNum - 1];
            archive.file(pageFilePath, { name: `${session.sectorCode}_page${pageNum}_11col.eps` });
        }

        // Finalize the archive
        await archive.finalize();

        console.log(`✅ ZIP archive generated and download started`);

        // Clean up temp files after a delay (to ensure streaming completes)
        setTimeout(async () => {
            for (const tempFile of tempFiles) {
                try {
                    await fs.unlink(tempFile);
                } catch (cleanupError) {
                    console.error(`⚠️ Failed to clean up temp file ${tempFile}:`, cleanupError);
                }
            }
            console.log(`🧹 Cleaned up ${tempFiles.length} temp files`);
        }, 5000);

    } catch (error) {
        console.error('❌ Error generating EPS:', error);

        // Clean up temp files on error
        for (const tempFile of tempFiles) {
            try {
                await fs.unlink(tempFile);
            } catch {}
        }

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Recover sessions from existing files
app.post('/api/sessions/recover', async (req, res) => {
    try {
        console.log('🔍 Starting session recovery...');

        // Read all files from uploads directory
        const files = await fs.readdir(uploadsDir);
        console.log(`📁 Found ${files.length} files`);

        // Group files by sector code
        const sectors = {};

        for (const file of files) {
            // Extract tile code from filename (format: timestamp_TILECODE.png)
            const match = file.match(/^(\d+)_(M\d{6}).png$/);
            if (match) {
                const tileCode = match[2];
                const sectorCode = tileCode.substring(0, 4); // M713

                if (!sectors[sectorCode]) {
                    sectors[sectorCode] = new Set();
                }
                sectors[sectorCode].add(tileCode);
            }
        }

        const recoveredSessions = [];

        // Create sessions for each sector
        for (const [sectorCode, tileCodes] of Object.entries(sectors)) {
            const tileArray = Array.from(tileCodes).sort();

            console.log(`🔧 Recovering sector: ${sectorCode} (${tileArray.length} tiles)`);

            // Generate session ID
            const sessionId = `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

            // Create session
            const sessionData = {
                id: sessionId,
                sectorCode,
                status: 'completed',
                totalTiles: tileArray.length,
                uploadedTiles: tileArray.length,
                tiles: [],
                createdAt: new Date().toISOString()
            };

            storage.createSession(sessionData);

            // Register each tile
            for (const tileCode of tileArray) {
                // Find the file for this tile code
                const filePattern = new RegExp(`\\d+_${tileCode}\\.png$`);
                const matchingFile = files.find(f => filePattern.test(f));

                if (matchingFile) {
                    const filePath = path.join(uploadsDir, matchingFile);
                    const fileStats = await fs.stat(filePath);

                    // Register tile in storage
                    const tileData = {
                        tileCode,
                        hash: tileCode,
                        filePath,
                        createdAt: new Date(fileStats.birthtime).toISOString(),
                        sizeBytes: fileStats.size,
                        usedBySessions: [sessionId]
                    };

                    storage.setTile(tileCode, tileData);
                    storage.addTileToSession(sessionId, tileCode);
                }
            }

            recoveredSessions.push({
                sessionId,
                sectorCode,
                tileCount: tileArray.length
            });

            console.log(`✅ Session created: ${sessionId}`);
        }

        console.log(`🎉 Recovery complete! Recovered ${recoveredSessions.length} session(s)`);

        res.json({
            success: true,
            sessions: recoveredSessions
        });

    } catch (error) {
        console.error('❌ Error during recovery:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });

    // Send initial data on connection
    socket.emit('sectors:list', storage.getAllSectors());
    socket.emit('stats:update', storage.getStats());
});

// ==================== START SERVER ====================

// Listen on all interfaces (0.0.0.0) for remote access
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('========================================');
    console.log('🚀 Satellite Tile Server');
    console.log('========================================');
    console.log(`📡 Server: http://0.0.0.0:${PORT}`);
    console.log(`📡 Remote: http://<your-vps-ip>:${PORT}`);
    console.log(`🔌 WebSocket: Socket.io enabled`);
    console.log(`💾 Storage: Persistent JSON`);
    console.log(`📁 Uploads: ${process.env.UPLOAD_DIR || './uploads'}`);
    console.log('========================================');
    console.log('');
});
