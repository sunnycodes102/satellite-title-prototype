// storage.js - Persistent storage with JSON file backup
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORAGE_FILE = path.join(__dirname, 'storage-data.json');

class Storage {
    constructor() {
        this.sectors = new Map();
        this.jobs = new Map();
        this.tiles = new Map();
        this.io = null; // Socket.io instance
        this.saveInProgress = false; // Prevent concurrent writes
        this.pendingSave = false; // Queue additional saves
        this.loadFromFile();
    }

    // Set Socket.io instance for real-time updates
    setIO(io) {
        this.io = io;
        console.log('✅ Socket.io connected to storage');
    }

    // Emit Socket.io events
    emitSectorUpdate(sectorCode) {
        if (this.io) {
            const sector = this.getSector(sectorCode);
            this.io.emit('sector:update', sector);
            this.io.emit('stats:update', this.getStats());
        }
    }

    emitSectorsList() {
        if (this.io) {
            this.io.emit('sectors:list', this.getAllSectors());
            this.io.emit('stats:update', this.getStats());
        }
    }

    // Load data from JSON file
    async loadFromFile() {
        try {
            const data = await fs.readFile(STORAGE_FILE, 'utf8');
            const parsed = JSON.parse(data);

            // Restore sectors
            if (parsed.sectors) {
                this.sectors = new Map(Object.entries(parsed.sectors));
                console.log(`📦 Loaded ${this.sectors.size} sectors from persistent storage`);
            }

            // Restore tiles
            if (parsed.tiles) {
                this.tiles = new Map(Object.entries(parsed.tiles));
                console.log(`📦 Loaded ${this.tiles.size} tiles from persistent storage`);
            }

            console.log('✅ Persistent storage loaded successfully');

            // Recalculate sector data after loading
            await this.recalculateAllSectorsOnStartup();
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('📦 No existing storage file found. Starting fresh.');
            } else {
                console.error('⚠️ Error loading storage:', error.message);
            }
        }
    }

    // Sync sectors with actual files on disk
    async syncSectorsWithDisk() {
        const uploadsDir = process.env.UPLOAD_DIR || './uploads';
        const sectors = Array.from(this.sectors.values());

        if (sectors.length === 0) {
            return; // No sectors to sync
        }

        console.log(`\n🔄 Syncing ${sectors.length} sector(s) with disk...\n`);

        for (const sector of sectors) {
            const sectorDir = path.join(uploadsDir, sector.sectorCode);

            try {
                // Check if sector directory exists
                const stats = await fs.stat(sectorDir);
                if (!stats.isDirectory()) {
                    console.log(`   ⚠️  ${sector.sectorCode}: Not a directory, skipping`);
                    continue;
                }

                // Read actual files from disk
                const files = await fs.readdir(sectorDir);

                // Extract tile codes from filenames (format: M713111.png)
                const actualTiles = files
                    .filter(file => file.endsWith('.png'))
                    .map(file => file.replace('.png', ''))
                    .filter(tileCode => tileCode.startsWith(sector.sectorCode));

                // Update sector.tiles to match actual files
                const before = sector.tiles ? sector.tiles.length : 0;
                sector.tiles = actualTiles;
                sector.uploadedTiles = actualTiles.length;
                this.sectors.set(sector.sectorCode, sector);

                console.log(`   📊 ${sector.sectorCode}: ${before} → ${actualTiles.length} tiles (synced with disk)`);

            } catch (error) {
                if (error.code === 'ENOENT') {
                    console.log(`   ⚠️  ${sector.sectorCode}: Directory not found, clearing tiles`);
                    sector.tiles = [];
                    sector.uploadedTiles = 0;
                    this.sectors.set(sector.sectorCode, sector);
                } else {
                    console.error(`   ❌ ${sector.sectorCode}: Error syncing - ${error.message}`);
                }
            }
        }

        console.log(`\n✅ Disk sync complete\n`);
    }

    // Recalculate all sectors on startup
    async recalculateAllSectorsOnStartup() {
        const sectors = Array.from(this.sectors.values());

        if (sectors.length === 0) {
            return; // No sectors to recalculate
        }

        // First, sync with actual files on disk
        await this.syncSectorsWithDisk();

        console.log(`🔄 Recalculating sector data for ${sectors.length} sector(s)...\n`);

        for (const sector of sectors) {
            // Skip saving during startup to avoid triggering file watchers
            this.recalculateMissingTiles(sector.sectorCode, true);
            const after = this.sectors.get(sector.sectorCode).uploadedTiles;

            console.log(`   📊 ${sector.sectorCode}: ${after}/729 tiles (${sector.missingTiles?.length || 0} missing)`);
        }

        // Save synced data to JSON (nodemon ignores storage-data.json)
        await this.saveToFile();

        console.log(`\n✅ Sector data synchronized and saved to JSON\n`);
    }

    // Save data to JSON file with queue to prevent concurrent writes
    async saveToFile() {
        // If a save is already in progress, mark that another save is needed
        if (this.saveInProgress) {
            this.pendingSave = true;
            return;
        }

        this.saveInProgress = true;

        try {
            const data = {
                sectors: Object.fromEntries(this.sectors),
                tiles: Object.fromEntries(this.tiles),
                lastSaved: new Date().toISOString()
            };

            await fs.writeFile(STORAGE_FILE, JSON.stringify(data, null, 2), 'utf8');
        } catch (error) {
            console.error('⚠️ Error saving storage:', error.message);
        } finally {
            this.saveInProgress = false;

            // If another save was requested while we were saving, do it now
            if (this.pendingSave) {
                this.pendingSave = false;
                // Use setImmediate to avoid deep recursion
                setImmediate(() => this.saveToFile());
            }
        }
    }

    // ==================== SECTORS ====================

    createSector(sectorData) {
        this.sectors.set(sectorData.sectorCode, sectorData);
        this.saveToFile(); // Persist to disk
        this.emitSectorsList(); // Real-time update
        return sectorData;
    }

    getSector(sectorCode) {
        return this.sectors.get(sectorCode);
    }

    getAllSectors() {
        return Array.from(this.sectors.values())
            .sort((a, b) => a.sectorCode.localeCompare(b.sectorCode));
    }

    updateSector(sectorCode, updates) {
        const sector = this.sectors.get(sectorCode);
        if (sector) {
            Object.assign(sector, updates);
            this.sectors.set(sectorCode, sector);
            this.saveToFile(); // Persist to disk
            this.emitSectorUpdate(sectorCode); // Real-time update
        }
        return sector;
    }

    deleteSector(sectorCode) {
        const result = this.sectors.delete(sectorCode);
        if (result) {
            this.saveToFile(); // Persist to disk
            this.emitSectorsList(); // Real-time update
        }
        return result;
    }

    // ==================== JOBS (Generation Jobs) ====================

    createJob(jobData) {
        this.jobs.set(jobData.jobId, jobData);
        return jobData;
    }

    getJob(jobId) {
        return this.jobs.get(jobId);
    }

    updateJob(jobId, updates) {
        const job = this.jobs.get(jobId);
        if (job) {
            Object.assign(job, updates);
            this.jobs.set(jobId, job);
        }
        return job;
    }

    deleteJob(jobId) {
        return this.jobs.delete(jobId);
    }

    // ==================== SESSIONS (Legacy - will be removed) ====================

    createSession(sessionData) {
        this.sessions = this.sessions || new Map();
        this.sessions.set(sessionData.id, sessionData);
        return sessionData;
    }

    getSession(sessionId) {
        return this.sessions ? this.sessions.get(sessionId) : null;
    }

    getAllSessions() {
        if (!this.sessions) return [];
        return Array.from(this.sessions.values())
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    updateSession(sessionId, updates) {
        if (!this.sessions) return null;
        const session = this.sessions.get(sessionId);
        if (session) {
            Object.assign(session, updates);
            this.sessions.set(sessionId, session);
        }
        return session;
    }

    incrementSessionProgress(sessionId) {
        if (!this.sessions) return null;
        const session = this.sessions.get(sessionId);
        if (session) {
            session.uploadedTiles++;
            this.sessions.set(sessionId, session);
        }
        return session;
    }

    deleteSession(sessionId) {
        return this.sessions ? this.sessions.delete(sessionId) : false;
    }

    // ==================== TILES ====================

    getTile(tileCode) {
        return this.tiles.get(tileCode);
    }

    setTile(tileCode, tileData) {
        this.tiles.set(tileCode, tileData);
        this.saveToFile(); // Persist to disk
    }

    deleteTile(tileCode) {
        const result = this.tiles.delete(tileCode);
        if (result) {
            this.saveToFile(); // Persist to disk
        }
        return result;
    }

    addTileToSector(sectorCode, tileCode) {
        const sector = this.sectors.get(sectorCode);
        if (sector) {
            if (!sector.tiles) {
                sector.tiles = [];
            }
            if (!sector.tiles.includes(tileCode)) {
                sector.tiles.push(tileCode);
                sector.uploadedTiles = sector.tiles.length;
                sector.lastUpdatedAt = new Date().toISOString();
                sector.status = sector.uploadedTiles === 729 ? 'complete' : 'incomplete';

                // Update missingTiles array - remove the uploaded tile
                if (sector.missingTiles && Array.isArray(sector.missingTiles)) {
                    const index = sector.missingTiles.indexOf(tileCode);
                    if (index > -1) {
                        sector.missingTiles.splice(index, 1);
                    }
                }

                this.sectors.set(sectorCode, sector);
                this.saveToFile(); // Persist to disk
                this.emitSectorUpdate(sectorCode); // Real-time update
            }
        }
    }

    // Recalculate missing tiles for a sector
    recalculateMissingTiles(sectorCode, skipSave = false) {
        const sector = this.sectors.get(sectorCode);
        if (!sector) return;

        // Generate all possible tile codes for this sector
        const allTiles = [];
        for (let i = 1; i <= 9; i++) {
            for (let j = 1; j <= 9; j++) {
                for (let k = 1; k <= 9; k++) {
                    allTiles.push(`${sectorCode}${i}${j}${k}`);
                }
            }
        }

        // Calculate missing tiles (tiles not in sector.tiles array)
        const existingTiles = new Set(sector.tiles || []);
        sector.missingTiles = allTiles.filter(tile => !existingTiles.has(tile));
        sector.uploadedTiles = sector.tiles ? sector.tiles.length : 0;
        sector.status = sector.uploadedTiles === 729 ? 'complete' : 'incomplete';

        this.sectors.set(sectorCode, sector);

        // Only save and emit if not skipping (e.g., during startup)
        if (!skipSave) {
            this.saveToFile();
            this.emitSectorUpdate(sectorCode);
        }

        return sector;
    }

    addTileToSession(sessionId, tileCode) {
        if (!this.sessions) return;
        const session = this.sessions.get(sessionId);
        if (session) {
            if (!session.tiles) {
                session.tiles = [];
            }
            session.tiles.push(tileCode);
            this.sessions.set(sessionId, session);
        }
    }

    // ==================== STATS ====================

    getStats() {
        const sectors = Array.from(this.sectors.values());
        return {
            totalSectors: this.sectors.size,
            completeSectors: sectors.filter(s => s.status === 'complete').length,
            incompleteSectors: sectors.filter(s => s.status === 'incomplete').length,
            totalCachedTiles: this.tiles.size,
            activeJobs: Array.from(this.jobs.values())
                .filter(j => j.status === 'running').length,
            // Legacy session stats for backward compatibility
            totalSessions: this.sessions ? this.sessions.size : 0,
            activeSessions: this.sessions ? Array.from(this.sessions.values())
                .filter(s => s.status === 'uploading').length : 0
        };
    }
}

// Singleton instance
const storage = new Storage();

export default storage;
