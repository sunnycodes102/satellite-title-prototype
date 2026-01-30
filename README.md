# Globe Tiles - Satellite Image Generator

## Prototype for 3D Printed Earth Model Decals

This tool generates print-ready satellite imagery for tile decals based on KML boundary files.

---

## Quick Start

1. Open `index.html` in a web browser (Chrome recommended)
2. The default tile M713289 (Peru/Andes) is pre-loaded
3. Click **"Generate Satellite Image"** to capture the satellite view
4. Click **"Download PNG"** to save the image

---

## Features

- **Satellite Imagery**: Uses Esri World Imagery (free tier)
- **KML Support**: Load your own KML files to define tile boundaries
- **Auto-labeling**: Tile code is added along the east-west edge
- **Print-ready Output**: 4.25" at 300 DPI (1275 x 1335 pixels)
- **Triangle Overlay**: Shows exact tile boundary on the map

---

## How to Use Your Own KML Files

1. Click the "Drop KML file or click to browse" area
2. Select your KML file (e.g., `H961234.kml`)
3. The map will automatically zoom to the tile location
4. Click **"Generate Satellite Image"**
5. Download the PNG

---

## Output Specifications

| Property | Value |
|----------|-------|
| Scale | 1:100,000 |
| Size | 4.25 inches |
| DPI | 300 |
| Resolution | 1275 x 1335 px |
| Format | PNG |
| Label Position | Bottom (east-west edge) |

---

## Technical Notes

### Satellite Imagery Source
This prototype uses **Esri World Imagery**, which is free for limited use. For production (10+ million tiles), you'll need:
- Esri enterprise license, OR
- USGS/NASA public domain imagery, OR  
- Other licensed imagery provider

### Browser Requirements
- Modern browser with JavaScript enabled
- Chrome/Edge recommended for best html2canvas support
- CORS-enabled for satellite tile fetching

### Known Limitations (Prototype)
- Map capture depends on tiles being fully loaded
- Triangle overlay on output is approximate (based on bounding box)
- No batch processing (single tile at a time)

---

## Next Steps for Production Version

The full production tool will include:

1. **Batch Processing** - Process all 729 tiles for a sector at once
2. **Precise Triangle Cropping** - Output exact triangle shape, not bounding box
3. **Higher Resolution** - Direct tile fetching for maximum quality
4. **Progress Tracking** - Monitor batch jobs
5. **Automated Labeling** - Precise label placement per spec
6. **Multiple Export Formats** - PNG, TIFF, etc.

---

## File Structure

```
satellite-tile-prototype/
├── index.html      # Main application (self-contained)
└── README.md       # This file
```

---

## Credits

- Satellite imagery: Esri World Imagery
- Map library: Leaflet.js
- Screen capture: html2canvas

---

## Questions?

This is a prototype to demonstrate the concept. The full production tool will be scoped based on the  requirements.
