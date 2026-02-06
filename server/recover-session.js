// recover-session.js - Recreate session from existing tile files
import fs from 'fs/promises';
import path from 'path';
import storage from './storage.js';
import crypto from 'crypto';

const uploadsDir = './uploads';

async function recoverSession() {
    try {
        console.log('🔍 Scanning uploads directory...\n');

        // Read all files
        const files = await fs.readdir(uploadsDir);
        console.log(`📁 Found ${files.length} files\n`);

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

        console.log(`📊 Found ${Object.keys(sectors).length} sector(s):\n`);

        // Create sessions for each sector
        for (const [sectorCode, tileCodes] of Object.entries(sectors)) {
            const tileArray = Array.from(tileCodes).sort();

            console.log(`🔧 Recovering sector: ${sectorCode}`);
            console.log(`   Tiles found: ${tileArray.length}`);

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
                        hash: tileCode, // Use tile code as hash for recovery
                        filePath,
                        createdAt: new Date(fileStats.birthtime).toISOString(),
                        sizeBytes: fileStats.size,
                        usedBySessions: [sessionId]
                    };

                    storage.setTile(tileCode, tileData);
                    storage.addTileToSession(sessionId, tileCode);
                }
            }

            console.log(`✅ Session created: ${sessionId}`);
            console.log(`   Sector: ${sectorCode}`);
            console.log(`   Tiles registered: ${tileArray.length}`);
            console.log(`   Status: completed\n`);
        }

        console.log('🎉 Recovery complete!\n');
        console.log('📋 Session Summary:');
        const allSessions = storage.getAllSessions();
        allSessions.forEach(session => {
            console.log(`   ${session.sectorCode}: ${session.uploadedTiles}/${session.totalTiles} tiles (${session.id})`);
        });
        console.log('\n✨ You can now access the dashboard to download PDF/EPS files!');
        console.log('   Dashboard: http://localhost:3001/dashboard.html\n');

    } catch (error) {
        console.error('❌ Error during recovery:', error);
    }
}

recoverSession();
