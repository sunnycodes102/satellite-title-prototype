/**
 * Alternative DPI Embedding Method using Canvas-to-Blob
 * More reliable than data URL manipulation
 */

/**
 * Download canvas as PNG with proper DPI metadata
 * @param {HTMLCanvasElement} canvas - The canvas element
 * @param {string} filename - Filename for download
 * @param {number} dpi - DPI value (default: 300)
 */
function downloadCanvasWithDPI(canvas, filename, dpi = 300) {
    // Convert DPI to pixels per meter
    const pixelsPerMeter = Math.round(dpi * 39.3701);

    // Get canvas data as blob
    canvas.toBlob(function(blob) {
        // Read blob as array buffer
        const reader = new FileReader();
        reader.onload = function() {
            const arrayBuffer = this.result;
            const dataArray = new Uint8Array(arrayBuffer);

            // Add pHYs chunk
            const modifiedArray = addPhysChunk(dataArray, pixelsPerMeter);

            // Create blob and download
            const modifiedBlob = new Blob([modifiedArray], { type: 'image/png' });
            const url = URL.createObjectURL(modifiedBlob);

            const link = document.createElement('a');
            link.download = filename;
            link.href = url;
            link.click();

            // Clean up
            setTimeout(() => URL.revokeObjectURL(url), 100);

            console.log(`✓ Downloaded: ${filename} with ${dpi} DPI metadata`);
        };
        reader.readAsArrayBuffer(blob);
    }, 'image/png');
}

/**
 * Add pHYs chunk to PNG data
 */
function addPhysChunk(dataArray, pixelsPerMeter) {
    console.log('📝 Adding pHYs chunk...');
    console.log('  Input pixels per meter:', pixelsPerMeter);
    console.log('  Input array size:', dataArray.length);

    // Create pHYs chunk
    const physChunk = new Uint8Array(21);

    // Chunk length (9 bytes)
    physChunk[0] = 0x00;
    physChunk[1] = 0x00;
    physChunk[2] = 0x00;
    physChunk[3] = 0x09;

    // Chunk type "pHYs"
    physChunk[4] = 0x70;  // 'p'
    physChunk[5] = 0x48;  // 'H'
    physChunk[6] = 0x59;  // 'Y'
    physChunk[7] = 0x73;  // 's'

    // X pixels per meter
    physChunk[8] = (pixelsPerMeter >>> 24) & 0xFF;
    physChunk[9] = (pixelsPerMeter >>> 16) & 0xFF;
    physChunk[10] = (pixelsPerMeter >>> 8) & 0xFF;
    physChunk[11] = pixelsPerMeter & 0xFF;

    // Y pixels per meter
    physChunk[12] = (pixelsPerMeter >>> 24) & 0xFF;
    physChunk[13] = (pixelsPerMeter >>> 16) & 0xFF;
    physChunk[14] = (pixelsPerMeter >>> 8) & 0xFF;
    physChunk[15] = pixelsPerMeter & 0xFF;

    // Unit: 1 = meter
    physChunk[16] = 0x01;

    // Calculate CRC
    const crc = calculateCRC(physChunk.subarray(4, 17));
    physChunk[17] = (crc >>> 24) & 0xFF;
    physChunk[18] = (crc >>> 16) & 0xFF;
    physChunk[19] = (crc >>> 8) & 0xFF;
    physChunk[20] = crc & 0xFF;

    console.log('  pHYs chunk created:', Array.from(physChunk.slice(0, 21)));
    console.log('  CRC:', crc.toString(16));

    // Find insertion point (after IHDR chunk)
    let insertPos = 8;  // PNG signature
    const ihdrLength = (dataArray[insertPos] << 24) |
                       (dataArray[insertPos + 1] << 16) |
                       (dataArray[insertPos + 2] << 8) |
                       dataArray[insertPos + 3];
    insertPos += 4 + 4 + ihdrLength + 4;  // length + type + data + crc

    console.log('  IHDR length:', ihdrLength);
    console.log('  Insert position:', insertPos);

    // Check if pHYs already exists
    const nextChunkType = String.fromCharCode(
        dataArray[insertPos + 4],
        dataArray[insertPos + 5],
        dataArray[insertPos + 6],
        dataArray[insertPos + 7]
    );
    console.log('  Next chunk type:', nextChunkType);

    // Insert pHYs chunk
    const result = new Uint8Array(dataArray.length + 21);
    result.set(dataArray.subarray(0, insertPos), 0);
    result.set(physChunk, insertPos);
    result.set(dataArray.subarray(insertPos), insertPos + 21);

    console.log('  Output array size:', result.length);
    console.log('  Size increase:', result.length - dataArray.length);
    console.log('✓ pHYs chunk added');

    return result;
}

/**
 * Calculate CRC32 for PNG chunk
 */
function calculateCRC(data) {
    // CRC table (precomputed)
    const crcTable = makeCRCTable();
    let crc = -1;

    for (let i = 0; i < data.length; i++) {
        crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }

    return crc ^ -1;
}

function makeCRCTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c;
    }
    return table;
}

/**
 * Convert canvas to Blob with DPI metadata (for batch processing)
 * @param {HTMLCanvasElement} canvas - The canvas element
 * @param {number} dpi - DPI value (default: 300)
 * @param {function} callback - Callback function that receives the blob
 */
function canvasToBlobWithDPI(canvas, dpi = 300, callback) {
    // Convert DPI to pixels per meter
    const pixelsPerMeter = Math.round(dpi * 39.3701);

    // Get canvas data as blob
    canvas.toBlob(function(blob) {
        // Read blob as array buffer
        const reader = new FileReader();
        reader.onload = function() {
            const arrayBuffer = this.result;
            const dataArray = new Uint8Array(arrayBuffer);

            // Add pHYs chunk
            const modifiedArray = addPhysChunk(dataArray, pixelsPerMeter);

            // Create blob with DPI metadata
            const modifiedBlob = new Blob([modifiedArray], { type: 'image/png' });

            // Return blob via callback
            callback(modifiedBlob);
        };
        reader.readAsArrayBuffer(blob);
    }, 'image/png');
}

// Make functions globally available
window.downloadCanvasWithDPI = downloadCanvasWithDPI;
window.canvasToBlobWithDPI = canvasToBlobWithDPI;

console.log('✓ Alternative DPI embedding method loaded');
