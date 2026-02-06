// server.js - Complete server without Redis
import express from 'express';
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
            const row = Math.floor(positionOnPage / tilesPerRow);
            const col = positionOnPage % tilesPerRow;
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
