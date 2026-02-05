/**
 * Globe Tiles - Satellite Image Generator
 * Main Application JavaScript
 */

// ============================================
// PHASE 1: HELPER FUNCTIONS
// ============================================

/**
 * Calculate distance between two geographic points using Haversine formula
 * @param {number} lat1 - Latitude of point 1 (degrees)
 * @param {number} lon1 - Longitude of point 1 (degrees)
 * @param {number} lat2 - Latitude of point 2 (degrees)
 * @param {number} lon2 - Longitude of point 2 (degrees)
 * @returns {number} Distance in kilometers
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
}

/**
 * Find the E-W (East-West) edge of a triangle
 * E-W edge = the most horizontal edge (smallest latitude difference)
 * @param {Array} coordinates - Array of [lng, lat] coordinates (3 vertices + closing point)
 * @returns {Object} { vertices: [i, j], length: km, latDiff: degrees }
 */
function findEWEdge(coordinates) {
    // Only use first 3 points (vertices), ignore closing point
    const vertices = coordinates.slice(0, 3);

    const edges = [
        { vertices: [0, 1] },  // Edge between vertex 0 and 1
        { vertices: [1, 2] },  // Edge between vertex 1 and 2
        { vertices: [2, 0] }   // Edge between vertex 2 and 0
    ];

    // Calculate latitude difference and length for each edge
    edges.forEach(edge => {
        const v1 = vertices[edge.vertices[0]];
        const v2 = vertices[edge.vertices[1]];

        // Latitude is at index 1 (format is [lng, lat])
        edge.latDiff = Math.abs(v1[1] - v2[1]);
        edge.length = haversineDistance(v1[1], v1[0], v2[1], v2[0]);
        edge.v1 = v1;
        edge.v2 = v2;
    });

    // E-W edge = smallest latitude difference (most horizontal)
    const ewEdge = edges.reduce((best, edge) =>
        edge.latDiff < best.latDiff ? edge : best
    );

    return ewEdge;
}

/**
 * Check if a tile is inverted (apex pointing down)
 * Tiles ending in 3, 6, 8 are inverted and need 180° rotation
 * @param {string} tileCode - Tile code (e.g., "M713289")
 * @returns {boolean} True if inverted
 */
function isInvertedTile(tileCode) {
    const lastDigit = parseInt(tileCode.slice(-1));
    return [3, 6, 8].includes(lastDigit);
}

/**
 * Calculate rotation angle to make E-W edge horizontal at bottom
 * @param {Object} ewEdge - E-W edge object from findEWEdge()
 * @param {boolean} isInverted - Whether tile is inverted (3, 6, 8)
 * @returns {number} Rotation angle in radians
 */
function calculateRotation(ewEdge, isInverted) {
    // Calculate angle of E-W edge
    const dx = ewEdge.v2[0] - ewEdge.v1[0];  // longitude difference
    const dy = ewEdge.v2[1] - ewEdge.v1[1];  // latitude difference

    // Angle to make this edge horizontal
    let angle = Math.atan2(dy, dx);

    // For inverted tiles, add 180° rotation
    if (isInverted) {
        angle += Math.PI;
    }

    return angle;
}

// ============================================
// SERVER API INTEGRATION
// ============================================

const API_URL = 'http://localhost:3001/api';
let currentSessionId = null;

/**
 * Smart waiting function: Wait for canvas to be ready using event-driven approach
 * with timeout fallback (better than static delays)
 * Based on: https://davidwalsh.name/waitfor
 */
function waitForCanvasReady(maxWait = 5000) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const canvas = document.getElementById('preview-canvas');

        // Check if canvas has content (not blank)
        function isCanvasReady() {
            if (!canvas) return false;

            try {
                const ctx = canvas.getContext('2d');
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

                // Check if canvas has any non-white pixels (has content)
                for (let i = 0; i < imageData.data.length; i += 4) {
                    if (imageData.data[i] !== 255 ||
                        imageData.data[i + 1] !== 255 ||
                        imageData.data[i + 2] !== 255) {
                        return true; // Found non-white pixel
                    }
                }
                return false;
            } catch (e) {
                return false;
            }
        }

        // Use requestAnimationFrame for checking (syncs with browser rendering)
        // Based on: https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
        function checkReady() {
            const elapsed = Date.now() - startTime;

            // Timeout fallback
            if (elapsed >= maxWait) {
                console.warn(`Canvas ready check timed out after ${maxWait}ms`);
                resolve();
                return;
            }

            // Check if canvas is ready
            if (isCanvasReady()) {
                // Wait one more frame to ensure complete rendering
                requestAnimationFrame(() => {
                    resolve();
                });
            } else {
                // Check again on next frame
                requestAnimationFrame(checkReady);
            }
        }

        // Start checking
        requestAnimationFrame(checkReady);
    });
}

/**
 * Create a new upload session on the server
 */
async function createSession(sectorCode) {
    try {
        const response = await fetch(`${API_URL}/sessions/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sectorCode })
        });

        const data = await response.json();
        currentSessionId = data.id;
        console.log('📝 Session created:', currentSessionId);
        return data;
    } catch (error) {
        console.error('❌ Failed to create session:', error);
        throw new Error('Could not connect to server. Make sure it\'s running on http://localhost:3001');
    }
}

/**
 * Check if a tile already exists on the server (for deduplication)
 */
async function checkTileExists(tileCode) {
    try {
        const response = await fetch(`${API_URL}/tile-exists/${tileCode}?sessionId=${currentSessionId}`);
        const data = await response.json();
        return data.exists;
    } catch (error) {
        console.error('❌ Error checking tile:', error);
        return false;
    }
}

/**
 * Upload a tile image to the server
 */
async function uploadTileToServer(tileCode, imageBlob) {
    const formData = new FormData();
    formData.append('image', imageBlob, `${tileCode}.png`);
    formData.append('sessionId', currentSessionId);
    formData.append('tileCode', tileCode);

    try {
        const response = await fetch(`${API_URL}/upload-tile`, {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
        return result;
    } catch (error) {
        console.error('❌ Upload failed:', error);
        throw error;
    }
}

// ============================================
// CONFIGURATION
// ============================================

// Default tile data for M713289 (from the KML file)
const DEFAULT_TILE = {
    code: 'M713289',
    // Triangle coordinates [lng, lat]
    coordinates: [
        [-71.548858, -14.100060],
        [-71.599134, -14.015646],
        [-71.649112, -14.100223],
        [-71.548858, -14.100060]  // Close the triangle
    ]
};

// Output specifications
const OUTPUT_CONFIG = {
    dpi: 300,
    scale: 100000,  // 1:100,000
    labelHeight: 60,  // Space for tile label at bottom
    fixedPadding: 10,  // Fixed padding in pixels (on each side)
    /**
     * Calculate pixel dimensions from E-W edge length
     * At 1:100,000 scale: E-W edge (km) = print width (cm)
     * At 300 DPI: pixels = cm × (300 / 2.54)
     * @param {number} ewEdgeLengthKm - E-W edge length in kilometers
     * @returns {number} Pixel width for output image
     */
    calculatePixels(ewEdgeLengthKm) {
        const printWidthCm = ewEdgeLengthKm;  // At 1:100,000, km = cm
        const pixels = Math.round(printWidthCm * this.dpi / 2.54);
        return pixels;
    }
};

// Capture configuration for "Capture Large, Scale to Exact" approach
const CAPTURE_CONFIG = {
    captureSize: 1300,        // Fixed large capture size in pixels
    targetScale: 100000,      // 1:100,000 scale
    dpi: 300,                 // Output DPI
    padding: 0,              // Padding in pixels
    labelHeight: 60           // Label height in pixels
};

// Map instances
let map = null;              // Visible map for user interaction
let captureMap = null;       // Hidden map for image capture (user never sees this)
let tileLayer = null;
let captureTileLayer = null; // Tile layer for capture map
let triangleLayer = null;
let subTileLayers = [];  // Array to hold sub-tile polygon layers
let currentTileData = { ...DEFAULT_TILE };
let currentSubTiles = [];  // Array of 9 sub-tile coordinate sets
let capturedMapBounds = null;  // Store map bounds when image is captured

// TileLookup instance for converting tile codes to coordinates
let tileLookup = null;

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', function() {
    // Initialize TileLookup
    tileLookup = new TileLookup();

    initMap();
    updateDisplay();

    // Add Enter key handler for tile code input
    document.getElementById('tile-code').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            loadTileFromCode();
        }
    });

    // Add file input handler
    document.getElementById('kml-file').addEventListener('change', handleKMLFile);
});

/**
 * Initialize the Leaflet map with Esri satellite imagery
 */
function initMap() {
    // Calculate center of the default triangle
    const center = calculateCenter(DEFAULT_TILE.coordinates);

    // Create map
    map = L.map('map', {
        center: [center.lat, center.lng],
        zoom: 13,
        zoomControl: true
    });

    // Add Esri World Imagery (free satellite basemap)
    tileLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
            attribution: 'Tiles © Esri',
            maxZoom: 19
        }
    ).addTo(map);

    // Draw the default triangle
    drawTriangle(DEFAULT_TILE.coordinates);

    // Add coordinate display on mouse move (for manual testing)
    map.on('mousemove', function(e) {
        const lat = e.latlng.lat.toFixed(6);
        const lng = e.latlng.lng.toFixed(6);
        document.getElementById('display-center').textContent = `${lat}°, ${lng}° (cursor)`;
    });

    // Add click handler to log coordinates
    map.on('click', function(e) {
        const lat = e.latlng.lat.toFixed(6);
        const lng = e.latlng.lng.toFixed(6);
        console.log('📍 Clicked coordinates:', {
            lat: parseFloat(lat),
            lng: parseFloat(lng),
            formatted: `[${lng}, ${lat}]`  // [lng, lat] format for GeoJSON
        });
    });
}

/**
 * Initialize the hidden capture map (lazy initialization)
 * This map is used for image generation and is never visible to the user
 */
function initCaptureMap() {
    if (captureMap) {
        return; // Already initialized
    }

    console.log('🗺️ Initializing hidden capture map...');

    // Create hidden map instance
    captureMap = L.map('capture-map', {
        zoomControl: false,
        attributionControl: false,
        boxZoom: false,
        doubleClickZoom: false,
        dragging: false,
        keyboard: false,
        scrollWheelZoom: false,
        touchZoom: false
    });

    // Add same satellite tile layer as visible map
    captureTileLayer = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        {
            attribution: 'Tiles © Esri',
            maxZoom: 19
        }
    ).addTo(captureMap);

    console.log('✅ Hidden capture map initialized');
}

/**
 * Draw triangle overlay on the map (main tile + 9 sub-tiles)
 */
function drawTriangle(coordinates) {
    // Remove existing triangle if any
    if (triangleLayer) {
        map.removeLayer(triangleLayer);
    }

    // Remove existing sub-tile layers
    subTileLayers.forEach(layer => map.removeLayer(layer));
    subTileLayers = [];

    // Convert to Leaflet format [lat, lng]
    const latLngs = coordinates.map(coord => [coord[1], coord[0]]);

    // Create main polygon
    triangleLayer = L.polygon(latLngs, {
        color: '#00d4aa',
        weight: 3,
        fillColor: '#00d4aa',
        fillOpacity: 0.15
    }).addTo(map);

    // Get and draw sub-tiles if we have a valid tile code
    if (currentTileData.code && tileLookup) {
        currentSubTiles = getSubTileCoordinates(currentTileData.code);

        currentSubTiles.forEach(subTile => {
            const subLatLngs = subTile.coordinates.map(coord => [coord[1], coord[0]]);
            const subLayer = L.polygon(subLatLngs, {
                color: '#ffaa00',  // Orange for sub-tiles
                weight: 2,
                fillColor: 'transparent',
                fillOpacity: 0,
                dashArray: '5, 5'  // Dashed line
            }).addTo(map);
            subTileLayers.push(subLayer);
        });
    }

    console.log("========triangleLayer==========", triangleLayer.getBounds())

    // Add vertex coordinate labels for manual verification
    // addVertexLabels(coordinates);

    // Fit map to triangle bounds
    map.fitBounds(triangleLayer.getBounds(), { padding: [10, 10] });
}

/**
 * Add coordinate labels at triangle vertices for manual verification
 */
let vertexMarkers = [];
function addVertexLabels(coordinates) {
    // Remove existing markers
    vertexMarkers.forEach(marker => map.removeLayer(marker));
    vertexMarkers = [];

    // Add markers at each vertex (first 3 points, skip closing point)
    for (let i = 0; i < 3; i++) {
        const lng = coordinates[i][0];
        const lat = coordinates[i][1];

        const marker = L.marker([lat, lng], {
            icon: L.divIcon({
                className: 'vertex-label',
                html: `<div style="background: rgba(0,0,0,0.8); color: #00d4aa; padding: 4px 8px; border-radius: 4px; font-size: 11px; white-space: nowrap; font-family: 'JetBrains Mono', monospace;">
                    V${i}: ${lat.toFixed(6)}°, ${lng.toFixed(6)}°
                </div>`,
                iconSize: [150, 30],
                iconAnchor: [75, -5]
            })
        }).addTo(map);

        vertexMarkers.push(marker);
    }
}

/**
 * Calculate center point of coordinates
 */
function calculateCenter(coordinates) {
    // Exclude the closing point (last point = first point)
    const points = coordinates.slice(0, -1);

    const sumLat = points.reduce((sum, c) => sum + c[1], 0);
    const sumLng = points.reduce((sum, c) => sum + c[0], 0);

    return {
        lat: sumLat / points.length,
        lng: sumLng / points.length
    };
}

/**
 * Calculate bounding box of coordinates
 */
function calculateBounds(coordinates) {
    const lats = coordinates.map(c => c[1]);
    const lngs = coordinates.map(c => c[0]);

    return {
        north: Math.max(...lats),
        south: Math.min(...lats),
        east: Math.max(...lngs),
        west: Math.min(...lngs)
    };
}

/**
 * Get coordinates for all 9 sub-tiles of a given tile code
 * @param {string} tileCode - Parent tile code (e.g., "M713289")
 * @returns {Array} Array of 9 sub-tile coordinate arrays
 */
function getSubTileCoordinates(tileCode) {
    const subTiles = [];

    for (let i = 1; i <= 9; i++) {
        const subTileCode = tileCode + i;
        try {
            const locations = tileLookup.nameToLocations(subTileCode);
            // Convert to [lng, lat] format and close the triangle
            const coords = [
                [locations[0][1], locations[0][0]],
                [locations[1][1], locations[1][0]],
                [locations[2][1], locations[2][0]],
                [locations[0][1], locations[0][0]]  // Close
            ];
            subTiles.push({
                code: subTileCode,
                coordinates: coords
            });
        } catch (e) {
            console.warn('Could not get sub-tile:', subTileCode, e);
        }
    }

    return subTiles;
}

// ============================================
// KML PARSING
// ============================================

/**
 * Parse KML file and extract main tile coordinates
 */
function parseKML(kmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(kmlText, 'text/xml');

    // Get all placemarks
    const placemarks = doc.querySelectorAll('Placemark');

    if (placemarks.length === 0) {
        throw new Error('No placemarks found in KML');
    }

    // Get the first placemark (main tile)
    const firstPlacemark = placemarks[0];
    const name = firstPlacemark.querySelector('n')?.textContent ||
                firstPlacemark.querySelector('name')?.textContent ||
                'Unknown';

    const coordsText = firstPlacemark.querySelector('coordinates')?.textContent;

    if (!coordsText) {
        throw new Error('No coordinates found in KML');
    }

    // Parse coordinates
    const coordinates = coordsText.trim().split('\n').map(line => {
        const parts = line.trim().split(',');
        return [parseFloat(parts[0]), parseFloat(parts[1])];
    });

    return {
        code: name,
        coordinates: coordinates
    };
}

/**
 * Handle KML file upload
 */
function handleKMLFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        try {
            const kmlText = event.target.result;
            currentTileData = parseKML(kmlText);

            // Update tile code input
            document.getElementById('tile-code').value = currentTileData.code;

            // Update map
            drawTriangle(currentTileData.coordinates);

            // Update display
            updateDisplay();

            setStatus('KML loaded: ' + currentTileData.code, 'info');
        } catch (error) {
            setStatus('Error parsing KML: ' + error.message, 'error');
        }
    };
    reader.readAsText(file);
}

// ============================================
// TILE CODE LOADING
// ============================================

/**
 * Load tile coordinates from tile code using TileLookup
 */
function loadTileFromCode() {
    const tileCode = document.getElementById('tile-code').value.trim().toUpperCase();

    if (!tileCode) {
        setStatus('Please enter a tile code', 'error');
        return;
    }

    // Validate format: 1 letter (A-T) + 1-6 digits (1-9)
    const validPattern = /^[A-T][1-9]{1,6}$/;
    if (!validPattern.test(tileCode)) {
        setStatus('Invalid tile code. Format: Letter (A-T) + 1-6 digits (1-9). Example: M713289', 'error');
        return;
    }

    try {
        // Get coordinates from tile code
        const locations = tileLookup.nameToLocations(tileCode);

        // Convert to our coordinate format [lng, lat] and close the triangle
        const coordinates = [
            [locations[0][1], locations[0][0]],  // [lng, lat]
            [locations[1][1], locations[1][0]],
            [locations[2][1], locations[2][0]],
            [locations[0][1], locations[0][0]]   // Close the triangle
        ];

        // Update current tile data
        currentTileData = {
            code: tileCode,
            coordinates: coordinates
        };

        // Update map
        drawTriangle(currentTileData.coordinates);

        // Update display
        updateDisplay();

        setStatus('Tile loaded: ' + tileCode, 'info');
    } catch (error) {
        setStatus('Error loading tile: ' + error.message, 'error');
    }
}

// ============================================
// IMAGE GENERATION
// ============================================

/**
 * Calculate geographic bounding box for triangle
 * @param {Array} coordinates - Triangle coordinates [[lng, lat], [lng, lat], [lng, lat]]
 * @returns {Object} Bounding box with north, south, east, west, center, and spans
 */
function calculateTriangleBounds(coordinates) {
    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;

    for (let i = 0; i < 3; i++) {
        minLat = Math.min(minLat, coordinates[i][1]);
        maxLat = Math.max(maxLat, coordinates[i][1]);
        minLng = Math.min(minLng, coordinates[i][0]);
        maxLng = Math.max(maxLng, coordinates[i][0]);
    }

    return {
        north: maxLat,
        south: minLat,
        east: maxLng,
        west: minLng,
        centerLat: (maxLat + minLat) / 2,
        centerLng: (maxLng + minLng) / 2,
        latSpan: maxLat - minLat,
        lngSpan: maxLng - minLng
    };
}

/**
 * Wait for map tiles to fully load AND render before capturing
 * Uses event listeners + timeout fallback + extra render time for reliability
 * ENHANCED: Longer wait times, error tracking, multiple verification stages
 * @param {L.TileLayer} tileLayer - Leaflet tile layer to wait for
 * @param {number} maxWait - Maximum wait time in milliseconds (default 20000)
 * @returns {Promise} Resolves when tiles loaded+rendered or timeout reached
 */
function waitForTilesToLoad(tileLayer, maxWait = 20000) {
    return new Promise((resolve) => {
        let loadedCount = 0;
        let errorCount = 0;
        let timeoutHandle = null;

        const cleanup = () => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            tileLayer.off('load', onLoad);
            tileLayer.off('tileload', onTileLoad);
            tileLayer.off('tileerror', onTileError);
            tileLayer.off('loading', onLoading);
        };

        console.log('⏳ Waiting for tiles to load and render...');
        console.log(`   Initial loading state: ${tileLayer._loading ? 'LOADING' : 'NOT LOADING'}`);

        // Check if tiles are already loaded/cached
        if (!tileLayer._loading && tileLayer._tiles && Object.keys(tileLayer._tiles).length > 0) {
            const cachedTileCount = Object.keys(tileLayer._tiles).length;
            console.log(`✅ Tiles already in cache (${cachedTileCount} tiles), waiting for render...`);
            setTimeout(() => {
                console.log('✅ Render wait complete, ready to capture');
                resolve();
            }, 2000);
            return;
        }

        // Timeout fallback (increased to 20 seconds)
        timeoutHandle = setTimeout(() => {
            console.warn(`⏱️ Tile loading timeout after ${maxWait}ms`);
            console.warn(`   Loaded: ${loadedCount} tiles, Errors: ${errorCount} tiles`);
            cleanup();
            // Still resolve - proceed with whatever we have
            resolve();
        }, maxWait);

        // Detect when tile loading starts
        const onLoading = () => {
            console.log('🔄 Tile loading started...');
        };

        // Track individual tile loads
        const onTileLoad = () => {
            loadedCount++;
            if (loadedCount % 5 === 0) {
                console.log(`📦 ${loadedCount} tiles loaded...`);
            }
        };

        // Track tile errors
        const onTileError = (e) => {
            errorCount++;
            console.warn(`❌ Tile load error (${errorCount} total):`, e.tile?.src || 'unknown');
        };

        // All tiles loaded event
        const onLoad = () => {
            console.log(`✅ All tiles loaded (${loadedCount} total, ${errorCount} errors)`);

            // If no tiles loaded at all, something is wrong
            if (loadedCount === 0) {
                console.error('⚠️ WARNING: No tiles were loaded! Image may be blank.');
            }

            cleanup();

            // CRITICAL: Wait LONGER for tiles to fully paint/render
            // Increased from 800ms to 2000ms for better reliability
            console.log('⏳ Waiting 2000ms for render and paint...');
            setTimeout(() => {
                console.log('✅ Render wait complete, ready to capture');
                resolve();
            }, 2000);
        };

        // Attach listeners (including error tracking and loading start)
        tileLayer.on('loading', onLoading);
        tileLayer.on('tileload', onTileLoad);
        tileLayer.on('tileerror', onTileError);
        tileLayer.once('load', onLoad);
    });
}

/**
 * Calculate square bounds that fit the entire triangle with proper scaling
 * The goal: E-W edge should be exactly trianglePixels (1277px) when rendered
 *
 * @param {Array} coordinates - Triangle coordinates [lng, lat]
 * @param {number} paddingRatio - Ratio of canvas to triangle (e.g., 1297/1277 = 1.0157)
 * @param {Object} ewEdge - E-W edge info from findEWEdge()
 * @returns {Object} Square bounds { north, south, east, west }
 */
function calculateCenteredSquareBounds(coordinates, paddingRatio, ewEdge) {
    const center = calculateCenter(coordinates);
    const centerLatRad = center.lat * Math.PI / 180;

    // Step 1: Calculate meters per pixel based on E-W edge
    const ewEdgeMeters = ewEdge.length * 1000;  // km to meters
    const trianglePixels = 1277;
    const metersPerPixel = ewEdgeMeters / trianglePixels;

    // Step 2: Find the actual bounding box of the triangle in degrees
    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;

    for (let i = 0; i < 3; i++) {
        const lng = coordinates[i][0];
        const lat = coordinates[i][1];
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
    }

    const triangleLatSpan = maxLat - minLat;
    const triangleLngSpan = maxLng - minLng;

    // Step 3: Convert degrees to approximate meters
    const metersPerDegreeLat = 111320;
    const metersPerDegreeLng = 111320 * Math.cos(centerLatRad);

    const triangleLatMeters = triangleLatSpan * metersPerDegreeLat;
    const triangleLngMeters = triangleLngSpan * metersPerDegreeLng;

    // Step 4: Calculate pixel dimensions of triangle bounding box
    const triangleLatPixels = triangleLatMeters / metersPerPixel;
    const triangleLngPixels = triangleLngMeters / metersPerPixel;

    // Step 5: The canvas needs to fit the LARGER dimension, then apply padding ratio
    const triangleMaxPixels = Math.max(triangleLatPixels, triangleLngPixels);
    const canvasPixels = triangleMaxPixels * paddingRatio;

    // Step 6: Convert canvas size back to geographic extent
    const canvasMeters = canvasPixels * metersPerPixel;
    const halfExtentLat = (canvasMeters / 2) / metersPerDegreeLat;
    const halfExtentLng = (canvasMeters / 2) / metersPerDegreeLng;

    // Step 7: Use the LARGER extent to create a square
    const halfExtentDegrees = Math.max(halfExtentLat, halfExtentLng);

    console.log('Square bounds calculation (FIT ALL VERTICES method):', {
        ewEdgeKm: ewEdge.length,
        ewEdgeMeters: ewEdgeMeters,
        metersPerPixel: metersPerPixel,
        triangleBoundingBox: {
            latSpan: triangleLatSpan,
            lngSpan: triangleLngSpan,
            latMeters: triangleLatMeters,
            lngMeters: triangleLngMeters,
            latPixels: triangleLatPixels,
            lngPixels: triangleLngPixels,
            maxPixels: triangleMaxPixels
        },
        canvasPixels: canvasPixels,
        paddingRatio: paddingRatio,
        halfExtentDegrees: halfExtentDegrees,
        totalSquareSizeDegrees: halfExtentDegrees * 2
    });

    // Create square bounds centered on the triangle center
    return {
        north: center.lat + halfExtentDegrees,
        south: center.lat - halfExtentDegrees,
        east: center.lng + halfExtentDegrees,
        west: center.lng - halfExtentDegrees
    };
}

/**
 * Calculate scale factor needed to convert captured image to exact 1:100,000 scale
 * @param {HTMLCanvasElement} capturedCanvas - The captured satellite image
 * @param {Object} capturedBounds - The geographic bounds of captured image
 * @param {number} capturedZoom - The zoom level used for capture
 * @returns {Object} Scale information including scaleFactor and target pixels
 */
function calculateScaleFactor(capturedCanvas, capturedBounds, capturedZoom) {
    const ewEdge = currentTileData.ewEdge || findEWEdge(currentTileData.coordinates);

    // 1. Calculate actual scale of captured image from ACTUAL canvas dimensions
    const centerLat = (capturedBounds.north + capturedBounds.south) / 2;
    const centerLatRad = centerLat * Math.PI / 180;

    // Calculate meters per pixel based on ACTUAL canvas width and geographic range
    const lngRange = capturedBounds.east - capturedBounds.west;
    const metersPerDegreeLng = 111320 * Math.cos(centerLatRad);  // Meters per degree longitude at this latitude
    const totalWidthMeters = lngRange * metersPerDegreeLng;
    const metersPerPixel = totalWidthMeters / capturedCanvas.width;

    // 2. Calculate how many pixels the E-W edge occupies in THIS canvas
    const ewEdgeMeters = ewEdge.length * 1000;  // km to meters
    const ewEdgePixelsInCapture = ewEdgeMeters / metersPerPixel;

    // 3. Calculate target pixels for 1:100,000 scale at 300 DPI
    // At 1:100,000: 1 km = 1 cm
    // At 300 DPI: 1 cm = 300/2.54 = 118.11 pixels
    const targetEWEdgePixels = ewEdge.length * (CAPTURE_CONFIG.dpi / 2.54);  // e.g., 1277px

    // 4. Calculate scale factor needed
    const scaleFactor = targetEWEdgePixels / ewEdgePixelsInCapture;

    console.log('📊 Scale calculation:', {
        capturedZoom,
        canvasWidth: capturedCanvas.width,
        lngRange,
        metersPerPixel,
        ewEdgeMeters,
        ewEdgePixelsInCapture,
        targetEWEdgePixels,
        scaleFactor,
        direction: scaleFactor > 1 ? 'Scale UP' : 'Scale DOWN'
    });

    return {
        scaleFactor,
        targetEWEdgePixels,
        ewEdgePixelsInCapture
    };
}

/**
 * Main function to generate the satellite image
 * Uses a HIDDEN capture map - user's visible map remains unchanged
 */
async function generateImage() {
    const btn = document.getElementById('generate-btn');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    setStatus('Processing satellite imagery...', 'info');
    console.log("======currentTileData=====", currentTileData);
    try {
        // Step 1: Initialize hidden capture map if not already done
        initCaptureMap();

        // Step 2: Calculate triangle bounding box
        const bounds = calculateTriangleBounds(currentTileData.coordinates);

        console.log('📊 Triangle bounding box:', bounds);

        // Step 3: Make capture map temporarily visible so tiles load
        const captureElement = document.getElementById('capture-map');

        // CRITICAL: visibility:hidden prevents tile rendering!
        // Temporarily make visible (but still behind visible map via z-index:-1)
        captureElement.style.visibility = 'visible';
        captureElement.style.opacity = '1';

        captureMap.invalidateSize();

        // Step 4: Set capture map to show triangle bounding box
        // Note: User's visible map is NOT affected (stays on top)
        captureMap.fitBounds([
            [bounds.south, bounds.west],
            [bounds.north, bounds.east]
        ], {
            padding: [0, 0],  // No padding - we want tight fit
            animate: false
        });

        // Wait for capture map to update (increased from 200ms to 500ms)
        await new Promise(resolve => setTimeout(resolve, 500));

        // Force tile layer to refresh (Esri-specific fix for cached tiles)
        captureTileLayer.redraw();

        // Step 5: Store captured zoom and bounds for scale calculation
        const capturedZoom = captureMap.getZoom();
        const actualBounds = captureMap.getBounds();
        capturedMapBounds = {
            north: actualBounds.getNorth(),
            south: actualBounds.getSouth(),
            east: actualBounds.getEast(),
            west: actualBounds.getWest()
        };

        console.log('📊 Capture map setup:', {
            containerSize: CAPTURE_CONFIG.captureSize,
            zoom: capturedZoom,
            bounds: capturedMapBounds,
            boundsSize: {
                latRange: capturedMapBounds.north - capturedMapBounds.south,
                lngRange: capturedMapBounds.east - capturedMapBounds.west
            }
        });

        // Step 5: Wait for capture map tiles to fully load AND render
        // This ensures satellite imagery is complete before capturing
        // ENHANCED: 25 second timeout + 2 second render wait = 27 seconds total
        await waitForTilesToLoad(captureTileLayer, 25000);

        // Step 6: Capture the HIDDEN map (user never sees this)
        const canvas = await html2canvas(captureElement, {
            useCORS: true,
            allowTaint: true,
            logging: false
        });

        console.log('📊 Captured canvas:', {
            width: canvas.width,
            height: canvas.height,
            expectedSize: CAPTURE_CONFIG.captureSize
        });

        // Hide capture map again (capture complete)
        captureElement.style.visibility = 'hidden';
        captureElement.style.opacity = '0';

        // Step 7: Process the captured image with scaling
        await processImageWithScaling(canvas, bounds, capturedZoom);

        // Show download button
        document.getElementById('download-btn').classList.remove('hidden');

        setStatus('Image generated successfully! Ready to download.', 'info');
    } catch (error) {
        console.error('Error generating image:', error);
        setStatus('Error generating image: ' + error.message, 'error');
    } finally {
        // Ensure capture map is hidden again (even if error occurred)
        const captureEl = document.getElementById('capture-map');
        if (captureEl) {
            captureEl.style.visibility = 'hidden';
            captureEl.style.opacity = '0';
        }

        // Re-enable button
        btn.disabled = false;
        btn.textContent = 'Generate Satellite Image';
    }
}

/**
 * Process captured image with scaling: calculate scale factor, resize to exact dimensions,
 * rotate, add label, prepare for export
 * NEW APPROACH: Capture large (1300px), calculate actual scale, then resize to exact 1:100,000
 */
async function processImageWithScaling(capturedCanvas, triangleBounds, capturedZoom) {
    const outputCanvas = document.getElementById('preview-canvas');
    const ctx = outputCanvas.getContext('2d');

    // 1. CROP: Remove extra space from square capture
    // Map triangle vertices to pixel coordinates in captured image
    const bounds = capturedMapBounds;
    const latRange = bounds.north - bounds.south;
    const lngRange = bounds.east - bounds.west;
    const centerLat = (bounds.north + bounds.south) / 2;
    const centerLng = (bounds.east + bounds.west) / 2;

    // Function to map geographic coords to captured canvas pixels
    function geoCoordsToPixels(lng, lat) {
        const x = ((lng - centerLng) / lngRange) * capturedCanvas.width;
        const y = ((centerLat - lat) / latRange) * capturedCanvas.height;
        return {
            x: x + capturedCanvas.width / 2,
            y: y + capturedCanvas.height / 2
        };
    }

    // Get triangle vertices in captured image pixels
    const vertices = currentTileData.coordinates.slice(0, 3);
    const pixelVertices = vertices.map(v => geoCoordsToPixels(v[0], v[1]));

    // Find bounding box of triangle in captured image
    const minX = Math.min(pixelVertices[0].x, pixelVertices[1].x, pixelVertices[2].x);
    const maxX = Math.max(pixelVertices[0].x, pixelVertices[1].x, pixelVertices[2].x);
    const minY = Math.min(pixelVertices[0].y, pixelVertices[1].y, pixelVertices[2].y);
    const maxY = Math.max(pixelVertices[0].y, pixelVertices[1].y, pixelVertices[2].y);

    const cropWidth = maxX - minX;
    const cropHeight = maxY - minY;

    console.log('✂️ Crop Rectangle (removing extra space):', {
        capturedSize: capturedCanvas.width,
        triangleBoundingBox: {
            minX: minX.toFixed(2),
            maxX: maxX.toFixed(2),
            minY: minY.toFixed(2),
            maxY: maxY.toFixed(2),
            width: cropWidth.toFixed(2),
            height: cropHeight.toFixed(2)
        },
        extraSpaceRemoved: {
            horizontal: (capturedCanvas.width - cropWidth).toFixed(2) + 'px',
            vertical: (capturedCanvas.height - cropHeight).toFixed(2) + 'px'
        }
    });

    // Create cropped canvas with just the triangle area
    const croppedCanvas = document.createElement('canvas');
    croppedCanvas.width = cropWidth;
    croppedCanvas.height = cropHeight;
    const croppedCtx = croppedCanvas.getContext('2d');

    // Copy the triangle area from captured canvas to cropped canvas
    croppedCtx.drawImage(
        capturedCanvas,
        minX, minY, cropWidth, cropHeight,  // Source rectangle
        0, 0, cropWidth, cropHeight          // Destination (full cropped canvas)
    );

    // Update the captured bounds to match the cropped area
    const cropLatRange = (cropHeight / capturedCanvas.height) * latRange;
    const cropLngRange = (cropWidth / capturedCanvas.width) * lngRange;
    const cropCenterLat = centerLat - ((minY + cropHeight/2 - capturedCanvas.height/2) / capturedCanvas.height) * latRange;
    const cropCenterLng = centerLng + ((minX + cropWidth/2 - capturedCanvas.width/2) / capturedCanvas.width) * lngRange;

    // Store cropped bounds for later use in coordinate mapping
    const croppedMapBounds = {
        north: cropCenterLat + cropLatRange / 2,
        south: cropCenterLat - cropLatRange / 2,
        east: cropCenterLng + cropLngRange / 2,
        west: cropCenterLng - cropLngRange / 2
    };

    // Replace capturedMapBounds temporarily for this processing
    const originalBounds = capturedMapBounds;
    capturedMapBounds = croppedMapBounds;

    // 2. Calculate scale factor to achieve exact 1:100,000 scale
    // Use cropped canvas instead of original captured canvas
    const scaleInfo = calculateScaleFactor(croppedCanvas, croppedMapBounds, capturedZoom);
    const scaleFactor = scaleInfo.scaleFactor;

    // 3. Calculate output dimensions based on SCALED image (not square!)
    const ewEdge = currentTileData.ewEdge || findEWEdge(currentTileData.coordinates);
    const triangleSize = Math.round(scaleInfo.targetEWEdgePixels);  // e.g., 1277px

    // 4. Create intermediate canvas for scaling
    const scaledCanvas = document.createElement('canvas');
    // Apply scale factor to BOTH dimensions separately (preserves aspect ratio!)
    const scaledWidth = Math.round(croppedCanvas.width * scaleFactor);
    const scaledHeight = Math.round(croppedCanvas.height * scaleFactor);
    scaledCanvas.width = scaledWidth;
    scaledCanvas.height = scaledHeight;

    const scaledCtx = scaledCanvas.getContext('2d');

    // 5. Scale the CROPPED image with high-quality smoothing
    scaledCtx.imageSmoothingEnabled = true;
    scaledCtx.imageSmoothingQuality = 'high';
    scaledCtx.drawImage(
        croppedCanvas,  // Use cropped canvas, not original captured
        0, 0, croppedCanvas.width, croppedCanvas.height,
        0, 0, scaledWidth, scaledHeight  // Use separate width/height!
    );

    console.log('📊 Image scaling:', {
        originalCapturedSize: capturedCanvas.width,
        croppedSize: croppedCanvas.width.toFixed(2) + '×' + croppedCanvas.height.toFixed(2),
        scaledSize: scaledWidth + '×' + scaledHeight,
        scaleFactor: scaleFactor
    });

    // 6. Set output canvas size - use ACTUAL dimensions (preserves aspect ratio!)
    const labelHeight = CAPTURE_CONFIG.labelHeight;
    const canvasWidth = scaledWidth + (CAPTURE_CONFIG.padding * 2);
    const canvasHeight = scaledHeight + (CAPTURE_CONFIG.padding * 2);

    outputCanvas.width = canvasWidth;
    outputCanvas.height = canvasHeight + labelHeight;

    console.log("=========Output Dimensions========", {
        triangleSize,
        canvasWidth,
        canvasHeight,
        scaledWidth,
        scaledHeight,
        aspectRatio: (canvasWidth / canvasHeight).toFixed(3),
        padding: CAPTURE_CONFIG.padding,
        ewEdge: ewEdge.length,
        scaleFactor
    });

    // 7. Fill background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outputCanvas.width, outputCanvas.height);

    // 8. Get rotation angle
    const inverted = currentTileData.isInverted !== undefined ?
                     currentTileData.isInverted :
                     isInvertedTile(currentTileData.code);
    const rotationAngle = calculateRotation(ewEdge, inverted);

    // 9. Draw scaled image to output canvas with rotation
    ctx.save();
    ctx.translate(canvasWidth / 2, canvasHeight / 2);
    ctx.rotate(-rotationAngle);

    // Draw scaled image centered (using actual dimensions, not square!)
    ctx.drawImage(
        scaledCanvas,
        0, 0, scaledWidth, scaledHeight,
        -canvasWidth / 2, -canvasHeight / 2, canvasWidth, canvasHeight
    );
    ctx.restore();

    // 10. Draw triangle overlay with correct coordinate mapping
    drawTriangleOnCanvas(ctx, canvasWidth, canvasHeight, rotationAngle, scaledWidth, scaledHeight);

    // 11. Add label at bottom
    ctx.fillStyle = '#373435';
    ctx.fillRect(0, canvasHeight, canvasWidth, labelHeight);

    ctx.fillStyle = '#ffffffff';
    ctx.font = 'bold 36px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const labelText = `${currentTileData.code}`;
    ctx.fillText(labelText, canvasWidth / 2, canvasHeight + labelHeight / 2);

    // Store final dimensions
    currentTileData.trianglePixels = triangleSize;
    currentTileData.outputPixels = { width: canvasWidth, height: canvasHeight };
    currentTileData.sourceCanvasSize = { width: scaledWidth, height: scaledHeight };

    // Restore original bounds
    capturedMapBounds = originalBounds;
}

/**
 * Draw triangle boundary on the output canvas (main tile + sub-tiles)
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {number} canvasWidth - Width of the output canvas
 * @param {number} canvasHeight - Height of the output canvas
 * @param {number} rotationAngle - Rotation angle in radians (optional)
 * @param {number} scaledWidth - Width of the scaled source canvas (for scale compensation)
 * @param {number} scaledHeight - Height of the scaled source canvas (for scale compensation)
 */
function drawTriangleOnCanvas(ctx, canvasWidth, canvasHeight, rotationAngle = 0, scaledWidth = null, scaledHeight = null) {
    // Use the actual map bounds that were captured, not calculated tile bounds
    // This ensures the triangle aligns with the satellite imagery
    const bounds = capturedMapBounds || calculateBounds(currentTileData.coordinates);

    // Calculate the ranges from actual map bounds
    const latRange = bounds.north - bounds.south;
    const lngRange = bounds.east - bounds.west;

    const centerLat = (bounds.north + bounds.south) / 2;
    const centerLng = (bounds.east + bounds.west) / 2;

    // Use separate base dimensions for non-square canvases
    // These represent the dimensions before padding was added
    const baseWidth = scaledWidth || canvasWidth;
    const baseHeight = scaledHeight || canvasHeight;

    // Calculate scale factors (should be 1.0 if no padding, or slightly > 1.0 with padding)
    const scaleFactorX = scaledWidth ? (canvasWidth / scaledWidth) : 1.0;
    const scaleFactorY = scaledHeight ? (canvasHeight / scaledHeight) : 1.0;

    console.log('🎨 Drawing triangle on canvas:', {
        canvasWidth: canvasWidth,
        canvasHeight: canvasHeight,
        scaledWidth: scaledWidth,
        scaledHeight: scaledHeight,
        scaleFactorX: scaleFactorX,
        scaleFactorY: scaleFactorY,
        rotationAngle: rotationAngle,
        capturedBounds: bounds,
        latRange: latRange,
        lngRange: lngRange
    });

    // Convert coordinates to canvas pixels (before rotation)
    function toCanvasCoords(lng, lat) {
        // Map coordinates to canvas pixels using the actual captured bounds
        // x: longitude maps to horizontal position
        // y: latitude maps to vertical position (inverted because canvas Y increases downward)
        let x = ((lng - centerLng) / lngRange) * baseWidth;
        let y = ((centerLat - lat) / latRange) * baseHeight;  // Invert Y

        // Apply rotation around center
        if (rotationAngle !== 0) {
            const cos = Math.cos(-rotationAngle);
            const sin = Math.sin(-rotationAngle);
            const rotX = x * cos - y * sin;
            const rotY = x * sin + y * cos;
            x = rotX;
            y = rotY;
        }

        // Scale from source to output canvas size (accounts for padding)
        x = x * scaleFactorX;
        y = y * scaleFactorY;

        // Translate to canvas coordinates (center of canvas)
        return {
            x: x + canvasWidth / 2,
            y: y + canvasHeight / 2
        };
    }

    // Calculate triangle vertices in pixel coordinates
    const vertices = currentTileData.coordinates.slice(0, 3);

    // Log detailed coordinate transformation for debugging
    console.log('📊 Step F: Coordinate transformation details', {
        triangleVerticesGeo: vertices,
        capturedBounds: bounds,
        capturedCenter: { lat: centerLat, lng: centerLng },
        scaledSize: { width: scaledWidth, height: scaledHeight },
        outputCanvasSize: { width: canvasWidth, height: canvasHeight },
        scaleFactors: { x: scaleFactorX, y: scaleFactorY }
    });

    const pixelVertices = vertices.map((v, i) => {
        const result = toCanvasCoords(v[0], v[1]);

        // Log transformation for first vertex as example
        if (i === 0) {
            const xRaw = ((v[0] - centerLng) / lngRange) * baseWidth;
            const yRaw = ((centerLat - v[1]) / latRange) * baseHeight;
            console.log(`📊 Step G: Vertex 0 transformation breakdown`, {
                geoCoords: { lng: v[0], lat: v[1] },
                step1_normalize: {
                    lngOffset: v[0] - centerLng,
                    latOffset: centerLat - v[1],
                    lngNormalized: (v[0] - centerLng) / lngRange,
                    latNormalized: (centerLat - v[1]) / latRange
                },
                step2_toBaseSize: { xRaw, yRaw, baseWidth, baseHeight },
                step3_afterScale: { x: xRaw * scaleFactorX, y: yRaw * scaleFactorY },
                step4_afterTranslate: result
            });
        }

        return result;
    });

    // Calculate triangle bounding box and dimensions
    const minX = Math.min(pixelVertices[0].x, pixelVertices[1].x, pixelVertices[2].x);
    const maxX = Math.max(pixelVertices[0].x, pixelVertices[1].x, pixelVertices[2].x);
    const minY = Math.min(pixelVertices[0].y, pixelVertices[1].y, pixelVertices[2].y);
    const maxY = Math.max(pixelVertices[0].y, pixelVertices[1].y, pixelVertices[2].y);

    const triangleWidth = maxX - minX;
    const triangleHeight = maxY - minY;

    // Calculate all three edge lengths
    const edge01Length = Math.sqrt(
        Math.pow(pixelVertices[1].x - pixelVertices[0].x, 2) +
        Math.pow(pixelVertices[1].y - pixelVertices[0].y, 2)
    );
    const edge12Length = Math.sqrt(
        Math.pow(pixelVertices[2].x - pixelVertices[1].x, 2) +
        Math.pow(pixelVertices[2].y - pixelVertices[1].y, 2)
    );
    const edge20Length = Math.sqrt(
        Math.pow(pixelVertices[0].x - pixelVertices[2].x, 2) +
        Math.pow(pixelVertices[0].y - pixelVertices[2].y, 2)
    );

    // Calculate E-W edge pixel length
    const ewEdge = currentTileData.ewEdge || findEWEdge(currentTileData.coordinates);
    const ewV1Pixels = toCanvasCoords(ewEdge.v1[0], ewEdge.v1[1]);
    const ewV2Pixels = toCanvasCoords(ewEdge.v2[0], ewEdge.v2[1]);
    const ewEdgePixelLength = Math.sqrt(
        Math.pow(ewV2Pixels.x - ewV1Pixels.x, 2) +
        Math.pow(ewV2Pixels.y - ewV1Pixels.y, 2)
    );

    console.log('═══════════════════════════════════════════════════════');
    console.log('📐 TRIANGLE DIMENSIONS IN GENERATED IMAGE');
    console.log('═══════════════════════════════════════════════════════');
    console.log('📍 Vertex Positions (in output canvas pixels):');
    console.log('   Vertex 0:', pixelVertices[0]);
    console.log('   Vertex 1:', pixelVertices[1]);
    console.log('   Vertex 2:', pixelVertices[2]);
    console.log('');
    console.log('📏 Triangle Bounding Box:');
    console.log('   Min X:', minX.toFixed(2), 'px');
    console.log('   Max X:', maxX.toFixed(2), 'px');
    console.log('   Min Y:', minY.toFixed(2), 'px');
    console.log('   Max Y:', maxY.toFixed(2), 'px');
    console.log('');
    console.log('📊 Triangle Dimensions:');
    console.log('   WIDTH  (horizontal):', triangleWidth.toFixed(2), 'px');
    console.log('   HEIGHT (vertical):  ', triangleHeight.toFixed(2), 'px');
    console.log('');
    console.log('📐 All Edge Lengths:');
    console.log('   Edge 0→1:', edge01Length.toFixed(2), 'px');
    console.log('   Edge 1→2:', edge12Length.toFixed(2), 'px');
    console.log('   Edge 2→0:', edge20Length.toFixed(2), 'px');
    console.log('');
    console.log('🎯 E-W Edge (horizontal base) - TARGET DIMENSION:');
    console.log('   E-W Edge Length (measured):', ewEdgePixelLength.toFixed(2), 'px');
    console.log('   E-W Edge Length (expected):', (currentTileData.trianglePixels || '?'), 'px');
    console.log('   Difference:', (ewEdgePixelLength - (currentTileData.trianglePixels || 0)).toFixed(2), 'px');
    console.log('');
    console.log('✅ Vertices Inside Canvas Check (W: 0-' + canvasWidth + 'px, H: 0-' + canvasHeight + 'px):');
    console.log('   Vertex 0:',
        (pixelVertices[0].x >= 0 && pixelVertices[0].x <= canvasWidth &&
         pixelVertices[0].y >= 0 && pixelVertices[0].y <= canvasHeight) ? '✅ INSIDE' : '❌ OUTSIDE');
    console.log('   Vertex 1:',
        (pixelVertices[1].x >= 0 && pixelVertices[1].x <= canvasWidth &&
         pixelVertices[1].y >= 0 && pixelVertices[1].y <= canvasHeight) ? '✅ INSIDE' : '❌ OUTSIDE');
    console.log('   Vertex 2:',
        (pixelVertices[2].x >= 0 && pixelVertices[2].x <= canvasWidth &&
         pixelVertices[2].y >= 0 && pixelVertices[2].y <= canvasHeight) ? '✅ INSIDE' : '❌ OUTSIDE');
    console.log('═══════════════════════════════════════════════════════');

    // Helper function to draw a triangle path
    function drawTrianglePath(coords, strokeStyle, lineWidth, dashPattern = []) {
        ctx.beginPath();
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth;
        ctx.setLineDash(dashPattern);

        const first = toCanvasCoords(coords[0][0], coords[0][1]);
        ctx.moveTo(first.x, first.y);

        for (let i = 1; i < coords.length; i++) {
            const point = toCanvasCoords(coords[i][0], coords[i][1]);
            ctx.lineTo(point.x, point.y);
        }

        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);  // Reset dash pattern
    }

    // Draw sub-tiles first (behind main tile)
    if (currentSubTiles && currentSubTiles.length > 0) {
        currentSubTiles.forEach(subTile => {
            drawTrianglePath(subTile.coordinates, '#000000ff', 2, [8, 4]);  // Orange, dashed
        });
    }

    // Draw main triangle on top
    drawTrianglePath(currentTileData.coordinates, '#000000ff', 4);  // Teal, solid
}

// ============================================
// DOWNLOAD
// ============================================

/**
 * Download the generated image as PNG with DPI metadata
 * Phase 1: Embeds 300 DPI metadata so CorelDraw reads correct dimensions
 */
function downloadImage() {
    const canvas = document.getElementById('preview-canvas');
    const tileCode = currentTileData.code;
    const dpi = OUTPUT_CONFIG.dpi;  // 300 DPI
    const filename = `${tileCode}_satellite_decal_${dpi}dpi.png`;

    // Try alternative method first (more reliable)
    if (typeof downloadCanvasWithDPI !== 'undefined') {
        console.log('Using alternative DPI embedding method (canvas-to-blob)');
        downloadCanvasWithDPI(canvas, filename, dpi);

        // Show download info
        const ewEdge = currentTileData.ewEdge;
        const printWidth = ewEdge ? ewEdge.length.toFixed(2) : '?';
        const trianglePixels = currentTileData.trianglePixels || '?';
        const canvasPixels = currentTileData.outputPixels || canvas.width;
        setStatus(`Downloaded: ${tileCode} | Canvas: ${canvasPixels}px | Triangle E-W: ${trianglePixels}px | Print: ${printWidth} cm @ ${dpi} DPI`, 'info');
        return;
    }

    // Fallback to original method
    console.warn('Alternative method not available, using original changeDPI method');

    // Check if changeDPI function is available
    if (typeof changeDpiDataUrl === 'undefined') {
        console.error('ERROR: changeDpiDataUrl function not found! Check if changeDPI.js is loaded.');
        alert('Warning: DPI metadata function not available. Image will be 96 DPI.');
    }

    // Get PNG data URL
    let dataUrl = canvas.toDataURL('image/png');

    // Add DPI metadata (300 DPI)
    try {
        console.log('Before DPI change - dataUrl length:', dataUrl.length);
        const originalDataUrl = dataUrl;
        dataUrl = changeDpiDataUrl(dataUrl, dpi);
        console.log('After DPI change - dataUrl length:', dataUrl.length);
        console.log('DPI metadata added successfully:', dataUrl.length > originalDataUrl.length);
    } catch (e) {
        console.error('ERROR: Could not add DPI metadata:', e);
        console.error('Stack trace:', e.stack);
    }

    // Create download link
    const link = document.createElement('a');
    link.download = filename;
    link.href = dataUrl;
    link.click();

    // Show download info with calculated dimensions
    const ewEdge = currentTileData.ewEdge;
    const printWidth = ewEdge ? ewEdge.length.toFixed(2) : '?';
    const trianglePixels = currentTileData.trianglePixels || '?';
    const canvasPixels = currentTileData.outputPixels || canvas.width;
    setStatus(`Downloaded: ${tileCode} | Canvas: ${canvasPixels}px | Triangle E-W: ${trianglePixels}px | Print: ${printWidth} cm @ ${dpi} DPI`, 'info');
}

// ============================================
// UI HELPERS
// ============================================

/**
 * Update the display panel with tile info including E-W edge calculations
 */
function updateDisplay() {
    const center = calculateCenter(currentTileData.coordinates);

    // Basic info
    document.getElementById('display-tile').textContent = currentTileData.code;
    document.getElementById('display-center').textContent =
        `${center.lat.toFixed(4)}°, ${center.lng.toFixed(4)}°`;

    // E-W edge calculations
    const ewEdge = findEWEdge(currentTileData.coordinates);
    const inverted = isInvertedTile(currentTileData.code);

    // At 1:100,000 scale, 1 km = 1 cm on print
    const printWidthCm = ewEdge.length;

    // Calculate triangle pixel size (actual E-W edge in pixels at 300 DPI)
    const trianglePixels = OUTPUT_CONFIG.calculatePixels(ewEdge.length);

    // Update UI
    document.getElementById('display-ew-edge').textContent = `${ewEdge.length.toFixed(2)} km`;
    document.getElementById('display-print-width').textContent = `${printWidthCm.toFixed(2)} cm`;
    document.getElementById('display-triangle-pixels').textContent = `${trianglePixels} px`;
    document.getElementById('display-tile-type').textContent = inverted ? 'Inverted (↓)' : 'Normal (△)';

    // Store for image processing
    currentTileData.ewEdge = ewEdge;
    currentTileData.isInverted = inverted;
    currentTileData.printWidthCm = printWidthCm;
}

/**
 * Set status message
 */
function setStatus(message, type) {
    const statusEl = document.getElementById('status-message');
    statusEl.textContent = message;
    statusEl.className = 'status ' + type;
}

// ============================================
// BATCH PROCESSING
// ============================================

/**
 * Global batch processing state
 */
let batchState = {
    isRunning: false,
    isCancelled: false,
    startTime: 0,
    completed: 0,
    failed: 0,
    total: 0,
    currentTile: '',
    failedTiles: []
};

/**
 * Generate all tile codes for a sector (729 tiles)
 */
function generateAllTileCodes(sectorCode) {
    const tiles = [];

    // FOR TESTING: Generate only 9 tiles (M713111 - M713119)
    // To generate all 729 tiles, uncomment the full loops below
    for (let k = 1; k <= 9; k++) {
        tiles.push(`${sectorCode}11${k}`);
    }

    /* FULL VERSION (729 tiles):
    for (let i = 1; i <= 9; i++) {
        for (let j = 1; j <= 9; j++) {
            for (let k = 1; k <= 9; k++) {
                tiles.push(`${sectorCode}${i}${j}${k}`);
            }
        }
    }
    */

    console.log(`Generated ${tiles.length} tile codes for sector ${sectorCode}`);
    return tiles;
}

/**
 * Start batch generation process
 */
async function startBatchGeneration() {
    const sectorCodeInput = document.getElementById('sector-code');
    const sectorCode = sectorCodeInput.value.trim().toUpperCase();

    // Validate sector code format
    if (!/^[A-T][0-9]{3}$/.test(sectorCode)) {
        alert('Invalid sector code format.\n\nRequired: Letter (A-T) + 3 digits\nExample: M713');
        sectorCodeInput.focus();
        return;
    }

    // Confirm with user
    const confirmMessage = `[TEST MODE] Generate and upload 9 satellite tiles for sector ${sectorCode}?\n\n` +
        `Tiles: ${sectorCode}1111 - ${sectorCode}1119 (9 tiles for testing)\n` +
        `Tiles will be uploaded to server at: http://localhost:3001\n` +
        `Estimated time: ~2-3 minutes\n` +
        `Keep this browser tab open during generation\n\n` +
        `Note: Make sure the server is running!\n\n` +
        `Click OK to start batch processing.`;

    if (!confirm(confirmMessage)) {
        return;
    }

    // Generate tile codes first to get the count
    const tileCodes = generateAllTileCodes(sectorCode);

    // Initialize batch state
    batchState = {
        isRunning: true,
        isCancelled: false,
        startTime: Date.now(),
        completed: 0,
        failed: 0,
        total: tileCodes.length,  // Dynamic based on actual tile count
        currentTile: '',
        failedTiles: []
    };

    // Update UI
    document.getElementById('batch-generate-btn').disabled = true;
    document.getElementById('batch-progress').classList.remove('hidden');
    document.getElementById('progress-bar').style.width = '0%';

    try {
        await processBatchTiles(sectorCode, tileCodes);
    } catch (error) {
        console.error('Batch generation error:', error);
        alert('Batch generation failed: ' + error.message);
    } finally {
        batchState.isRunning = false;
        document.getElementById('batch-generate-btn').disabled = false;
        document.getElementById('batch-progress').classList.add('hidden');
    }
}

/**
 * Process all tiles in batch and upload to server
 */
async function processBatchTiles(sectorCode, tileCodes) {
    console.log(`Starting batch generation for ${tileCodes.length} tiles...`);

    // Create session on server
    try {
        await createSession(sectorCode);
    } catch (error) {
        alert('Failed to connect to server:\n\n' + error.message + '\n\nMake sure the server is running:\ncd server\nnpm run dev');
        throw error;
    }

    for (let i = 0; i < tileCodes.length; i++) {
        if (batchState.isCancelled) {
            console.log('Batch generation cancelled by user');
            alert(`Batch cancelled. ${batchState.completed} tiles completed.`);
            return;
        }

        const tileCode = tileCodes[i];
        batchState.currentTile = tileCode;

        try {
            // Check if tile already exists on server
            const exists = await checkTileExists(tileCode);
            if (exists) {
                console.log(`✅ [${i + 1}/${tileCodes.length}] ${tileCode} - cached (skipped)`);
                batchState.completed++;
                updateBatchProgress();
                continue;
            }

            console.log(`🔄 [${i + 1}/${tileCodes.length}] Generating ${tileCode}...`);

            // Generate tile image
            const imageBlob = await generateSingleTileImage(tileCode);

            // Upload to server
            const result = await uploadTileToServer(tileCode, imageBlob);

            if (result.success) {
                console.log(`📤 [${i + 1}/${tileCodes.length}] ${tileCode} - uploaded (${result.progress.percentage}%)`);
                batchState.completed++;
            } else {
                throw new Error(result.error || 'Upload failed');
            }

        } catch (error) {
            console.error(`❌ Failed to process ${tileCode}:`, error);
            batchState.failed++;
            batchState.failedTiles.push({ code: tileCode, error: error.message });
        }

        updateBatchProgress();

        // Delay after each tile to ensure map clears and prepares for next tile
        // This prevents image quality issues from rapid successive generations
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (batchState.completed === 0) {
        throw new Error('No tiles were uploaded successfully');
    }

    console.log(`✅ Upload complete! ${batchState.completed} tiles uploaded to server.`);
    showBatchSummary(sectorCode);
}

/**
 * Generate a single tile image and return as Blob with DPI metadata
 * Uses the same logic as downloadImage to ensure consistency
 */
async function generateSingleTileImage(tileCode) {
    document.getElementById('tile-code').value = tileCode;

    const locations = tileLookup.nameToLocations(tileCode);
    if (!locations || locations.length !== 3) {
        throw new Error(`Invalid coordinates for tile ${tileCode}`);
    }

    // Convert to coordinate format [lng, lat] and close the triangle (same as single mode)
    const coordinates = [
        [locations[0][1], locations[0][0]],  // [lng, lat]
        [locations[1][1], locations[1][0]],
        [locations[2][1], locations[2][0]],
        [locations[0][1], locations[0][0]]   // Close the triangle
    ];

    currentTileData = {
        code: tileCode,
        coordinates: coordinates
    };

    // Get sub-tile coordinates (same as drawTriangle does in single mode)
    currentSubTiles = getSubTileCoordinates(tileCode);

    updateDisplay();
    await generateImage();

    // IMPORTANT: Wait for canvas to be fully rendered before capturing (event-driven)
    await waitForCanvasReady();

    const canvas = document.getElementById('preview-canvas');
    const dpi = OUTPUT_CONFIG.dpi;  // 300 DPI

    // Use the same DPI embedding method as downloadImage
    return new Promise((resolve, reject) => {
        if (typeof canvasToBlobWithDPI !== 'undefined') {
            // Use alternative method (more reliable) - same as downloadImage
            canvasToBlobWithDPI(canvas, dpi, (blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('Failed to create blob with DPI metadata'));
                }
            });
        } else {
            // Fallback: canvas.toBlob (no DPI metadata)
            console.warn(`Tile ${tileCode}: DPI metadata function not available, using basic toBlob`);
            canvas.toBlob(blob => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('Failed to create blob from canvas'));
                }
            }, 'image/png');
        }
    });
}

/**
 * Generate ZIP file and trigger download
 */
async function generateAndDownloadZip(zip, sectorCode) {
    setStatus('Creating ZIP file...', 'info');

    const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
        streamFiles: true
    }, (metadata) => {
        const percent = metadata.percent.toFixed(1);
        console.log(`ZIP progress: ${percent}%`);
        setStatus(`Creating ZIP file... ${percent}%`, 'info');
    });

    console.log(`ZIP file created: ${(zipBlob.size / 1024 / 1024).toFixed(2)} MB`);

    const downloadLink = document.createElement('a');
    downloadLink.href = URL.createObjectURL(zipBlob);
    downloadLink.download = `${sectorCode}_satellite_tiles.zip`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);

    setTimeout(() => URL.revokeObjectURL(zipBlob), 1000);
    setStatus('ZIP file downloaded!', 'info');
}

/**
 * Update batch progress display
 */
function updateBatchProgress() {
    const percentage = (batchState.completed / batchState.total * 100).toFixed(1);
    const elapsed = (Date.now() - batchState.startTime) / 1000;
    const avgTimePerTile = elapsed / batchState.completed;
    const remaining = (batchState.total - batchState.completed) * avgTimePerTile;

    document.getElementById('progress-text').textContent =
        `${batchState.completed}/${batchState.total} tiles (${percentage}%)`;
    document.getElementById('time-remaining').textContent =
        `${formatTime(remaining)} remaining`;
    document.getElementById('progress-bar').style.width = `${percentage}%`;
}

/**
 * Format seconds to human-readable time
 */
function formatTime(seconds) {
    if (seconds < 60) {
        return `${Math.floor(seconds)}s`;
    } else if (seconds < 3600) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}m ${secs}s`;
    } else {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        return `${hours}h ${mins}m`;
    }
}

/**
 * Cancel batch generation
 */
function cancelBatch() {
    if (!batchState.isRunning) {
        return;
    }

    if (confirm('Cancel batch generation?\n\nProgress will be lost.')) {
        batchState.isCancelled = true;
        setStatus('Cancelling batch generation...', 'error');
    }
}

/**
 * Show batch generation summary
 */
function showBatchSummary(sectorCode) {
    const elapsed = (Date.now() - batchState.startTime) / 1000;
    const avgTime = elapsed / batchState.completed;

    let message = `Batch Generation Complete!\n\n`;
    message += `Sector: ${sectorCode}\n`;
    message += `Completed: ${batchState.completed} tiles\n`;
    message += `Failed: ${batchState.failed} tiles\n`;
    message += `Total time: ${formatTime(elapsed)}\n`;
    message += `Average: ${avgTime.toFixed(1)}s per tile\n\n`;

    if (batchState.failed > 0) {
        message += `Failed tiles:\n`;
        batchState.failedTiles.slice(0, 10).forEach(tile => {
            message += `  - ${tile.code}\n`;
        });
        if (batchState.failedTiles.length > 10) {
            message += `  ... and ${batchState.failedTiles.length - 10} more\n`;
        }
    }

    message += `\nZIP file downloaded to your computer.`;
    alert(message);
    console.log('Batch Summary:', batchState);
}
