// fix-missing-tiles.js - Add missing tiles to the tiles object
import fs from 'fs/promises';
import { statSync } from 'fs';

async function fixMissingTiles() {
    try {
        console.log('📖 Reading storage-data.json...');
        const data = JSON.parse(await fs.readFile('./storage-data.json', 'utf-8'));

        // Find tiles that are in sector.tiles but not in data.tiles
        const sectorTiles = data.sectors.M713?.tiles || [];
        const missingFromTilesObject = sectorTiles.filter(t => !data.tiles[t]);

        console.log(`Found ${missingFromTilesObject.length} tiles missing from tiles object:`);
        console.log(missingFromTilesObject);

        if (missingFromTilesObject.length === 0) {
            console.log('✅ All tiles are already in the tiles object');
            return;
        }

        // Add missing tiles
        for (const tileCode of missingFromTilesObject) {
            const filePath = `uploads/M713/${tileCode}.png`;
            try {
                const stats = statSync(filePath);
                data.tiles[tileCode] = {
                    tileCode,
                    sectorCode: 'M713',
                    hash: tileCode,
                    filePath,
                    createdAt: stats.mtime.toISOString(),
                    sizeBytes: stats.size
                };
                console.log(`  ✓ Added: ${tileCode} (${stats.size} bytes)`);
            } catch (err) {
                console.log(`  ✗ File not found: ${filePath}`);
            }
        }

        // Save updated data
        await fs.writeFile('./storage-data.json', JSON.stringify(data, null, 2));
        console.log(`\n✅ Fixed! Total tiles now: ${Object.keys(data.tiles).length}`);

    } catch (error) {
        console.error('❌ Error:', error);
    }
}

fixMissingTiles();
