/**
 * changeDPI library - Adds DPI metadata to PNG images
 * Source: https://github.com/shutterstock/changeDPI (MIT License)
 */
(function() {
    function createPngDataTable() {
        var crcTable = [];
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) {
                c = ((c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1));
            }
            crcTable[n] = c;
        }
        return crcTable;
    }
    var crcTable = createPngDataTable();

    function calcCrc(buf) {
        var c = -1;
        for (var n = 0; n < buf.length; n++) {
            c = crcTable[(c ^ buf[n]) & 0xFF] ^ (c >>> 8);
        }
        return c ^ -1;
    }

    function changeDpiOnArray(dataArray, dpi, format) {
        if (format === 'png') {
            var physChunk = new Uint8Array(21);
            var ppmX = Math.round(dpi * 39.3701);
            var ppmY = Math.round(dpi * 39.3701);

            physChunk[0] = 0x00;
            physChunk[1] = 0x00;
            physChunk[2] = 0x00;
            physChunk[3] = 0x09;  // chunk length = 9

            physChunk[4] = 0x70;  // 'p'
            physChunk[5] = 0x48;  // 'H'
            physChunk[6] = 0x59;  // 'Y'
            physChunk[7] = 0x73;  // 's'

            physChunk[8] = (ppmX >>> 24) & 0xFF;
            physChunk[9] = (ppmX >>> 16) & 0xFF;
            physChunk[10] = (ppmX >>> 8) & 0xFF;
            physChunk[11] = ppmX & 0xFF;

            physChunk[12] = (ppmY >>> 24) & 0xFF;
            physChunk[13] = (ppmY >>> 16) & 0xFF;
            physChunk[14] = (ppmY >>> 8) & 0xFF;
            physChunk[15] = ppmY & 0xFF;

            physChunk[16] = 0x01;  // unit = meter

            var crc = calcCrc(physChunk.subarray(4, 17));
            physChunk[17] = (crc >>> 24) & 0xFF;
            physChunk[18] = (crc >>> 16) & 0xFF;
            physChunk[19] = (crc >>> 8) & 0xFF;
            physChunk[20] = crc & 0xFF;

            // Find IHDR chunk end (after PNG signature + IHDR)
            var insertPos = 8;  // PNG signature is 8 bytes
            // Skip IHDR chunk (length 4 + type 4 + data 13 + crc 4 = 25 bytes)
            insertPos += 4 + 4 + dataArray[insertPos] * 256 * 256 * 256 +
                         dataArray[insertPos + 1] * 256 * 256 +
                         dataArray[insertPos + 2] * 256 +
                         dataArray[insertPos + 3] + 4;

            var result = new Uint8Array(dataArray.length + 21);
            result.set(dataArray.subarray(0, insertPos), 0);
            result.set(physChunk, insertPos);
            result.set(dataArray.subarray(insertPos), insertPos + 21);

            return result;
        }
        return dataArray;
    }

    window.changeDpiDataUrl = function(dataUrl, dpi) {
        var format = dataUrl.split(';')[0].split('/')[1];
        var base64 = dataUrl.split(',')[1];
        var byteString = atob(base64);
        var dataArray = new Uint8Array(byteString.length);
        for (var i = 0; i < byteString.length; i++) {
            dataArray[i] = byteString.charCodeAt(i);
        }
        var modifiedArray = changeDpiOnArray(dataArray, dpi, format);
        var modifiedBase64 = btoa(String.fromCharCode.apply(null, modifiedArray));
        return 'data:image/' + format + ';base64,' + modifiedBase64;
    };
})();
