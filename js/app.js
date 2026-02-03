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
    padding: 100,              // Padding in pixels
    labelHeight: 60           // Label height in pixels
};

// Map instance
let map = null;
let tileLayer = null;
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

    // Fit map to triangle bounds
    map.fitBounds(triangleLayer.getBounds(), { padding: [10, 10] });
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

    // 1. Calculate actual scale of captured image
    const centerLat = (capturedBounds.north + capturedBounds.south) / 2;
    const centerLatRad = centerLat * Math.PI / 180;

    // Calculate meters per pixel at this zoom level
    const earthCircumference = 2 * Math.PI * 6378137;
    const metersPerPixelAtZoom = (earthCircumference * Math.cos(centerLatRad)) /
                                  (256 * Math.pow(2, capturedZoom));

    // 2. Calculate how many pixels the E-W edge occupies in captured image
    const ewEdgeMeters = ewEdge.length * 1000;  // km to meters
    const ewEdgePixelsInCapture = ewEdgeMeters / metersPerPixelAtZoom;

    // 3. Calculate target pixels for 1:100,000 scale at 300 DPI
    // At 1:100,000: 1 km = 1 cm
    // At 300 DPI: 1 cm = 300/2.54 = 118.11 pixels
    const targetEWEdgePixels = ewEdge.length * (CAPTURE_CONFIG.dpi / 2.54);  // e.g., 1277px

    // 4. Calculate scale factor needed
    const scaleFactor = targetEWEdgePixels / ewEdgePixelsInCapture;

    console.log('📊 Scale calculation:', {
        capturedZoom,
        metersPerPixelAtZoom,
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
 */
async function generateImage() {
    const btn = document.getElementById('generate-btn');
    btn.disabled = true;
    btn.textContent = 'Generating...';

    setStatus('Centering and capturing satellite imagery...', 'info');

    const mapContainer = document.querySelector('.map-container');
    const mapElement = document.getElementById('map');

    // Store original dimensions for restoration
    let originalWidth = mapContainer.style.width;
    let originalHeight = mapContainer.style.height;

    // Get references to Leaflet controls for hiding/restoring
    const attributionControl = document.querySelector('.leaflet-control-attribution');
    const zoomControl = document.querySelector('.leaflet-control-zoom');

    try {
        // Step 1: Calculate triangle bounding box
        const bounds = calculateTriangleBounds(currentTileData.coordinates);

        console.log('📊 Triangle bounding box:', bounds);

        // Step 2: Set container to FIXED large size (1300×1300px)
        mapContainer.style.width = CAPTURE_CONFIG.captureSize + 'px';
        mapContainer.style.height = CAPTURE_CONFIG.captureSize + 'px';
        map.invalidateSize();

        // Step 3: Fit map to show triangle bounding box
        map.fitBounds([
            [bounds.south, bounds.west],
            [bounds.north, bounds.east]
        ], {
            padding: [0, 0],  // No padding - we want tight fit
            animate: false
        });

        // Wait for map to update
        await new Promise(resolve => setTimeout(resolve, 100));

        // Step 4: Store captured zoom and bounds for scale calculation
        const capturedZoom = map.getZoom();
        const actualBounds = map.getBounds();
        capturedMapBounds = {
            north: actualBounds.getNorth(),
            south: actualBounds.getSouth(),
            east: actualBounds.getEast(),
            west: actualBounds.getWest()
        };

        console.log('📊 Map setup for capture:', {
            containerSize: CAPTURE_CONFIG.captureSize,
            zoom: capturedZoom,
            bounds: capturedMapBounds,
            boundsSize: {
                latRange: capturedMapBounds.north - capturedMapBounds.south,
                lngRange: capturedMapBounds.east - capturedMapBounds.west
            }
        });

        // Step 5: Hide overlays and controls for capture
        if (triangleLayer) {
            triangleLayer.setStyle({ opacity: 0, fillOpacity: 0 });
        }
        subTileLayers.forEach(layer => layer.setStyle({ opacity: 0 }));

        if (attributionControl) attributionControl.style.display = 'none';
        if (zoomControl) zoomControl.style.display = 'none';

        // Step 6: Wait for map tiles to load
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Step 7: Capture the map at large size
        const canvas = await html2canvas(mapElement, {
            useCORS: true,
            allowTaint: true,
            logging: false
        });

        console.log('📊 Captured canvas:', {
            width: canvas.width,
            height: canvas.height,
            expectedSize: CAPTURE_CONFIG.captureSize
        });

        // Step 8: Restore map UI
        mapContainer.style.height = originalHeight || '600px';
        map.invalidateSize();

        if (triangleLayer) {
            triangleLayer.setStyle({ opacity: 1, fillOpacity: 0.15 });
        }
        subTileLayers.forEach(layer => layer.setStyle({ opacity: 1 }));

        if (attributionControl) attributionControl.style.display = '';
        if (zoomControl) zoomControl.style.display = '';

        drawTriangle(currentTileData.coordinates);

        // Step 9: Process the captured image with scaling
        await processImageWithScaling(canvas, bounds, capturedZoom);

        // Show download button
        document.getElementById('download-btn').classList.remove('hidden');

        setStatus('Image generated successfully! Ready to download.', 'info');
    } catch (error) {
        setStatus('Error generating image: ' + error.message, 'error');

        // Restore map container on error
        mapContainer.style.height = originalHeight || '600px';
        map.invalidateSize();

        // Restore triangle visibility on error
        if (triangleLayer) {
            triangleLayer.setStyle({ opacity: 1, fillOpacity: 0.15 });
        }
        subTileLayers.forEach(layer => layer.setStyle({ opacity: 1 }));

        // Restore controls on error
        if (attributionControl) attributionControl.style.display = '';
        if (zoomControl) zoomControl.style.display = '';
    } finally {
        // Restore original map container size
        if (originalWidth && originalHeight) {
            mapContainer.style.width = originalWidth;
            mapContainer.style.height = originalHeight;
            map.invalidateSize();
        }

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

    // 3. Calculate output dimensions
    const ewEdge = currentTileData.ewEdge || findEWEdge(currentTileData.coordinates);
    const triangleSize = Math.round(scaleInfo.targetEWEdgePixels);  // e.g., 1277px
    const canvasSize = triangleSize + (CAPTURE_CONFIG.padding * 2);  // e.g., 1297px
    const labelHeight = CAPTURE_CONFIG.labelHeight;

    console.log("=========Output Dimensions========", {
        triangleSize,
        canvasSize,
        padding: CAPTURE_CONFIG.padding,
        ewEdge: ewEdge.length,
        scaleFactor
    });

    // 4. Set output canvas size
    outputCanvas.width = canvasSize;
    outputCanvas.height = canvasSize + labelHeight;

    // 5. Fill background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outputCanvas.width, outputCanvas.height);

    // 6. Create intermediate canvas for scaling
    const scaledCanvas = document.createElement('canvas');
    const scaledSize = Math.round(croppedCanvas.width * scaleFactor);
    scaledCanvas.width = scaledSize;
    scaledCanvas.height = scaledSize;

    const scaledCtx = scaledCanvas.getContext('2d');

    // 7. Scale the CROPPED image with high-quality smoothing
    scaledCtx.imageSmoothingEnabled = true;
    scaledCtx.imageSmoothingQuality = 'high';
    scaledCtx.drawImage(
        croppedCanvas,  // Use cropped canvas, not original captured
        0, 0, croppedCanvas.width, croppedCanvas.height,
        0, 0, scaledSize, scaledSize
    );

    console.log('📊 Image scaling:', {
        originalCapturedSize: capturedCanvas.width,
        croppedSize: croppedCanvas.width.toFixed(2) + '×' + croppedCanvas.height.toFixed(2),
        scaledSize: scaledSize,
        scaleFactor: scaleFactor
    });

    // 8. Get rotation angle
    const inverted = currentTileData.isInverted !== undefined ?
                     currentTileData.isInverted :
                     isInvertedTile(currentTileData.code);
    const rotationAngle = calculateRotation(ewEdge, inverted);

    // 9. Draw scaled image to output canvas with rotation
    ctx.save();
    ctx.translate(canvasSize / 2, canvasSize / 2);
    ctx.rotate(-rotationAngle);  // Negative to counteract the angle

    // Draw scaled image centered
    ctx.drawImage(
        scaledCanvas,
        0, 0, scaledSize, scaledSize,
        -canvasSize / 2, -canvasSize / 2, canvasSize, canvasSize
    );
    ctx.restore();

    // 10. Draw triangle overlay with correct coordinate mapping
    // Pass the scaled size for coordinate mapping
    drawTriangleOnCanvas(ctx, canvasSize, rotationAngle, scaledSize);

    // 11. Add label at bottom
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, canvasSize, canvasSize, labelHeight);

    ctx.fillStyle = '#000000';
    ctx.font = 'bold 36px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const labelText = `${currentTileData.code}  |  ${ewEdge.length.toFixed(2)} km  |  ${triangleSize}px  |  ${inverted ? '↓ Inverted' : '△ Normal'}`;
    ctx.fillText(labelText, canvasSize / 2, canvasSize + labelHeight / 2);

    // Store final dimensions
    currentTileData.trianglePixels = triangleSize;
    currentTileData.outputPixels = canvasSize;
    currentTileData.sourceCanvasSize = scaledSize;

    // Restore original bounds
    capturedMapBounds = originalBounds;
}

/**
 * Draw triangle boundary on the output canvas (main tile + sub-tiles)
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {number} canvasSize - Size of the output canvas
 * @param {number} rotationAngle - Rotation angle in radians (optional)
 * @param {number} sourceCanvasSize - Size of the source captured canvas (for scale compensation)
 */
function drawTriangleOnCanvas(ctx, canvasSize, rotationAngle = 0, sourceCanvasSize = null) {
    // Use the actual map bounds that were captured, not calculated tile bounds
    // This ensures the triangle aligns with the satellite imagery
    const bounds = capturedMapBounds || calculateBounds(currentTileData.coordinates);

    // Calculate the ranges from actual map bounds
    const latRange = bounds.north - bounds.south;
    const lngRange = bounds.east - bounds.west;

    const centerLat = (bounds.north + bounds.south) / 2;
    const centerLng = (bounds.east + bounds.west) / 2;

    // Calculate scale factor between source and output canvas
    // If source was 1185px but output is 1297px, scaleFactor = 1297/1185 = 1.094
    const scaleFactor = sourceCanvasSize ? (canvasSize / sourceCanvasSize) : 1.0;

    console.log('🎨 Drawing triangle on canvas:', {
        canvasSize: canvasSize,
        sourceCanvasSize: sourceCanvasSize,
        scaleFactor: scaleFactor,
        rotationAngle: rotationAngle,
        capturedBounds: bounds,
        latRange: latRange,
        lngRange: lngRange
    });

    // Convert coordinates to canvas pixels (before rotation)
    function toCanvasCoords(lng, lat) {
        // Map coordinates to canvas pixels using the actual captured bounds
        // First map to the SOURCE canvas size, then scale to OUTPUT canvas size
        // x: longitude maps to horizontal position
        // y: latitude maps to vertical position (inverted because canvas Y increases downward)
        const baseSize = sourceCanvasSize || canvasSize;
        let x = ((lng - centerLng) / lngRange) * baseSize;
        let y = ((centerLat - lat) / latRange) * baseSize;  // Invert Y

        // Apply rotation around center
        if (rotationAngle !== 0) {
            const cos = Math.cos(-rotationAngle);
            const sin = Math.sin(-rotationAngle);
            const rotX = x * cos - y * sin;
            const rotY = x * sin + y * cos;
            x = rotX;
            y = rotY;
        }

        // Scale from source to output canvas size
        x = x * scaleFactor;
        y = y * scaleFactor;

        // Translate to canvas coordinates
        return {
            x: x + canvasSize / 2,
            y: y + canvasSize / 2
        };
    }

    // Calculate triangle vertices in pixel coordinates
    const vertices = currentTileData.coordinates.slice(0, 3);

    // Log detailed coordinate transformation for debugging
    console.log('📊 Step F: Coordinate transformation details', {
        triangleVerticesGeo: vertices,
        capturedBounds: bounds,
        capturedCenter: { lat: centerLat, lng: centerLng },
        sourceCanvasSize: sourceCanvasSize,
        outputCanvasSize: canvasSize,
        scaleFactor: scaleFactor
    });

    const pixelVertices = vertices.map((v, i) => {
        const result = toCanvasCoords(v[0], v[1]);

        // Log transformation for first vertex as example
        if (i === 0) {
            const baseSize = sourceCanvasSize || canvasSize;
            const xRaw = ((v[0] - centerLng) / lngRange) * baseSize;
            const yRaw = ((centerLat - v[1]) / latRange) * baseSize;
            console.log(`📊 Step G: Vertex 0 transformation breakdown`, {
                geoCoords: { lng: v[0], lat: v[1] },
                step1_normalize: {
                    lngOffset: v[0] - centerLng,
                    latOffset: centerLat - v[1],
                    lngNormalized: (v[0] - centerLng) / lngRange,
                    latNormalized: (centerLat - v[1]) / latRange
                },
                step2_toBaseSize: { xRaw, yRaw, baseSize },
                step3_afterScale: { x: xRaw * scaleFactor, y: yRaw * scaleFactor },
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
    console.log('✅ Vertices Inside Canvas Check (0 to ' + canvasSize + 'px):');
    console.log('   Vertex 0:',
        (pixelVertices[0].x >= 0 && pixelVertices[0].x <= canvasSize &&
         pixelVertices[0].y >= 0 && pixelVertices[0].y <= canvasSize) ? '✅ INSIDE' : '❌ OUTSIDE');
    console.log('   Vertex 1:',
        (pixelVertices[1].x >= 0 && pixelVertices[1].x <= canvasSize &&
         pixelVertices[1].y >= 0 && pixelVertices[1].y <= canvasSize) ? '✅ INSIDE' : '❌ OUTSIDE');
    console.log('   Vertex 2:',
        (pixelVertices[2].x >= 0 && pixelVertices[2].x <= canvasSize &&
         pixelVertices[2].y >= 0 && pixelVertices[2].y <= canvasSize) ? '✅ INSIDE' : '❌ OUTSIDE');
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
            drawTrianglePath(subTile.coordinates, '#ffaa00', 2, [8, 4]);  // Orange, dashed
        });
    }

    // Draw main triangle on top
    drawTrianglePath(currentTileData.coordinates, '#00d4aa', 4);  // Teal, solid
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
