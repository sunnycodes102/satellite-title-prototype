/**
 * PNG Metadata Verification Tool
 * Reads and displays PNG chunks including pHYs (DPI) metadata
 */

/**
 * Read PNG file and display all chunks
 */
function verifyPNGMetadata(file) {
    const reader = new FileReader();

    reader.onload = function(e) {
        const arrayBuffer = e.target.result;
        const data = new Uint8Array(arrayBuffer);

        console.log('=== PNG FILE ANALYSIS ===');
        console.log('File name:', file.name);
        console.log('File size:', file.size, 'bytes');

        // Verify PNG signature
        if (data[0] !== 0x89 || data[1] !== 0x50 || data[2] !== 0x4E || data[3] !== 0x47) {
            console.error('❌ Not a valid PNG file!');
            return;
        }
        console.log('✓ Valid PNG signature');

        // Parse chunks
        let offset = 8; // Skip PNG signature
        let chunkCount = 0;
        const chunks = [];

        while (offset < data.length) {
            // Read chunk length (4 bytes, big-endian)
            const length = (data[offset] << 24) |
                          (data[offset + 1] << 16) |
                          (data[offset + 2] << 8) |
                          data[offset + 3];

            // Read chunk type (4 bytes)
            const type = String.fromCharCode(
                data[offset + 4],
                data[offset + 5],
                data[offset + 6],
                data[offset + 7]
            );

            chunks.push({ type, length, offset: offset + 8 });
            chunkCount++;

            // Log chunk
            console.log(`  Chunk #${chunkCount}: ${type} (${length} bytes at offset ${offset})`);

            // If it's a pHYs chunk, decode it
            if (type === 'pHYs') {
                const chunkData = data.slice(offset + 8, offset + 8 + length);
                const ppmX = (chunkData[0] << 24) | (chunkData[1] << 16) |
                            (chunkData[2] << 8) | chunkData[3];
                const ppmY = (chunkData[4] << 24) | (chunkData[5] << 16) |
                            (chunkData[6] << 8) | chunkData[7];
                const unit = chunkData[8];

                console.log('  ✓ Found pHYs chunk!');
                console.log('    Pixels per meter (X):', ppmX);
                console.log('    Pixels per meter (Y):', ppmY);
                console.log('    Unit:', unit === 1 ? 'meters' : 'unknown');

                // Calculate DPI
                const dpiX = Math.round(ppmX / 39.3701);
                const dpiY = Math.round(ppmY / 39.3701);
                console.log(`    ✓ DPI: ${dpiX} × ${dpiY}`);

                // Show alert
                alert(`✓ PNG has DPI metadata!\n\nDPI: ${dpiX} × ${dpiY}\nPixels per meter: ${ppmX} × ${ppmY}`);
            }

            // Move to next chunk (length + type + data + crc = 4 + 4 + length + 4)
            offset += 4 + 4 + length + 4;

            // Safety check
            if (chunkCount > 100) {
                console.error('❌ Too many chunks, stopping parse');
                break;
            }
        }

        console.log(`\nTotal chunks found: ${chunkCount}`);

        // Check if pHYs chunk exists
        const hasPhys = chunks.some(c => c.type === 'pHYs');
        if (!hasPhys) {
            console.error('❌ No pHYs chunk found! DPI metadata is missing.');
            alert('❌ ERROR: No DPI metadata found in PNG!\n\nThe pHYs chunk is missing from the file.');
        }

        console.log('=== END ANALYSIS ===');
    };

    reader.readAsArrayBuffer(file);
}

// Add file drop zone for testing
function createDPIVerifier() {
    // Create UI element
    const verifierDiv = document.createElement('div');
    verifierDiv.id = 'dpi-verifier';
    verifierDiv.innerHTML = `
        <div style="position: fixed; bottom: 20px; right: 20px; background: #1a1a2e;
                    border: 2px solid #00d4aa; border-radius: 8px; padding: 15px;
                    color: white; font-family: monospace; z-index: 9999; max-width: 300px;">
            <div style="font-weight: bold; margin-bottom: 10px;">🔍 DPI Verifier</div>
            <div style="font-size: 12px; margin-bottom: 10px;">
                Drop a PNG here to check DPI metadata
            </div>
            <input type="file" id="dpi-verify-input" accept=".png"
                   style="width: 100%; padding: 5px; margin-bottom: 5px;">
            <button id="verify-btn" style="width: 100%; padding: 8px;
                    background: #00d4aa; border: none; border-radius: 4px;
                    cursor: pointer; font-weight: bold;">
                Verify DPI
            </button>
        </div>
    `;

    document.body.appendChild(verifierDiv);

    // Add event listeners
    document.getElementById('verify-btn').addEventListener('click', function() {
        const input = document.getElementById('dpi-verify-input');
        if (input.files.length > 0) {
            verifyPNGMetadata(input.files[0]);
        } else {
            alert('Please select a PNG file first');
        }
    });

    // Drag and drop
    const dropZone = verifierDiv;
    dropZone.addEventListener('dragover', function(e) {
        e.preventDefault();
        dropZone.style.borderColor = '#ffaa00';
    });

    dropZone.addEventListener('dragleave', function(e) {
        dropZone.style.borderColor = '#00d4aa';
    });

    dropZone.addEventListener('drop', function(e) {
        e.preventDefault();
        dropZone.style.borderColor = '#00d4aa';

        if (e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.name.endsWith('.png')) {
                verifyPNGMetadata(file);
            } else {
                alert('Please drop a PNG file');
            }
        }
    });
}

// Auto-load verifier on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createDPIVerifier);
} else {
    createDPIVerifier();
}

console.log('✓ PNG DPI Verifier loaded - Check bottom-right corner');
