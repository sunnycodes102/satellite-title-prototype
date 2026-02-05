// storage.js - Simple in-memory storage (replaces Redis)

class Storage {
    constructor() {
        this.sessions = new Map();
        this.tiles = new Map();
        console.log('📦 Using in-memory storage (no Redis needed)');
    }

    // ==================== SESSIONS ====================

    createSession(sessionData) {
        this.sessions.set(sessionData.id, sessionData);
        return sessionData;
    }

    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }

    getAllSessions() {
        return Array.from(this.sessions.values())
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    updateSession(sessionId, updates) {
        const session = this.sessions.get(sessionId);
        if (session) {
            Object.assign(session, updates);
            this.sessions.set(sessionId, session);
        }
        return session;
    }

    incrementSessionProgress(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.uploadedTiles++;
            this.sessions.set(sessionId, session);
        }
        return session;
    }

    deleteSession(sessionId) {
        return this.sessions.delete(sessionId);
    }

    // ==================== TILES ====================

    getTile(tileCode) {
        return this.tiles.get(tileCode);
    }

    setTile(tileCode, tileData) {
        this.tiles.set(tileCode, tileData);
    }

    deleteTile(tileCode) {
        return this.tiles.delete(tileCode);
    }

    addTileToSession(sessionId, tileCode) {
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
        return {
            totalSessions: this.sessions.size,
            totalCachedTiles: this.tiles.size,
            activeSessions: Array.from(this.sessions.values())
                .filter(s => s.status === 'uploading').length
        };
    }
}

// Singleton instance
const storage = new Storage();

export default storage;
