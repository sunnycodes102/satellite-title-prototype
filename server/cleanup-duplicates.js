// cleanup-duplicates.js - Remove duplicate tile files
import fs from 'fs/promises';
import path from 'path';

const uploadsDir = './uploads';

async function cleanupDuplicates() {
    try {
        console.log('🔍 Scanning for duplicate tiles...\n');

        // Read all files
        const files = await fs.readdir(uploadsDir);

        // Group files by tile code
        const tileGroups = {};

        for (const file of files) {
            // Extract tile code from filename (format: timestamp_TILECODE.png)
            const match = file.match(/^(\d+)_(.+)$/);
            if (match) {
                const timestamp = parseInt(match[1]);
                const tileCode = match[2];

                if (!tileGroups[tileCode]) {
                    tileGroups[tileCode] = [];
                }

                tileGroups[tileCode].push({
                    filename: file,
                    timestamp: timestamp,
                    path: path.join(uploadsDir, file)
                });
            }
        }

        // Find and handle duplicates
        let duplicatesFound = 0;
        let filesDeleted = 0;

        for (const [tileCode, fileList] of Object.entries(tileGroups)) {
            if (fileList.length > 1) {
                duplicatesFound++;

                // Sort by timestamp (newest first)
                fileList.sort((a, b) => b.timestamp - a.timestamp);

                console.log(`📋 ${tileCode}: ${fileList.length} copies found`);
                console.log(`   ✓ Keeping: ${fileList[0].filename}`);

                // Delete older copies
                for (let i = 1; i < fileList.length; i++) {
                    console.log(`   ✗ Deleting: ${fileList[i].filename}`);
                    await fs.unlink(fileList[i].path);
                    filesDeleted++;
                }
                console.log('');
            }
        }

        console.log('✅ Cleanup complete!');
        console.log(`   Unique tiles: ${Object.keys(tileGroups).length}`);
        console.log(`   Duplicates found: ${duplicatesFound}`);
        console.log(`   Files deleted: ${filesDeleted}`);
        console.log(`   Files remaining: ${Object.keys(tileGroups).length}`);

    } catch (error) {
        console.error('❌ Error during cleanup:', error);
    }
}

cleanupDuplicates();
