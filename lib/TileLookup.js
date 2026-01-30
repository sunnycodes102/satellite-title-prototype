/**
 * TileLookup - Geodesic Tile Coordinate Calculator
 *
 * Converts tile codes (e.g., "M713289") to geographic coordinates.
 * Based on icosahedral subdivision of the Earth's surface.
 *
 * Original source: tag3.github.io
 */
class TileLookup {

    constructor() {
        this.facets = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T'];

        // Icosahedron vertices (12 vertices)
        this.vico = [
            /*0*/ [0, 0, 1.],
            /*1*/ [0.89442719099991587856, 0, 0.44721359549995793],
            /*2*/ [0.27639320225002104342, 0.85065080835203993366, 0.44721359549995793],
            /*3*/ [-0.72360679774997893378, 0.52573111211913365982, 0.44721359549995793],
            /*4*/ [-0.72360679774997893378, -0.52573111211913365982, 0.44721359549995793],
            /*5*/ [0.27639320225002104342, -0.85065080835203993366, 0.44721359549995793],
            /*6*/ [0.72360679774997893378, 0.52573111211913365982, -0.44721359549995793],
            /*7*/ [-0.27639320225002104342, 0.85065080835203993366, -0.44721359549995793],
            /*8*/ [-0.89442719099991587856, 0, -0.44721359549995793],
            /*9*/ [-0.27639320225002104342, -0.85065080835203993366, -0.44721359549995793],
            /*10*/ [0.72360679774997893378, -0.52573111211913365982, -0.44721359549995793],
            /*11*/ [0, 0, -1.]
        ];

        // Face definitions (20 faces, A-T)
        this.fico = [
            [2, 0, 1], /* A */
            [3, 0, 2], /* B */
            [4, 0, 3], /* C */
            [5, 0, 4], /* D */
            [1, 0, 5], /* E */
            [1, 6, 2], /* F */
            [7, 2, 6], /* G */
            [2, 7, 3], /* H */
            [8, 3, 7], /* I */
            [3, 8, 4], /* J */
            [9, 4, 8], /* K */
            [4, 9, 5], /* L */
            [10, 5, 9], /* M */
            [5, 10, 1], /* N */
            [6, 1, 10], /* O */
            [6, 11, 7], /* P */
            [7, 11, 8], /* Q */
            [8, 11, 9], /* R */
            [9, 11, 10], /* S */
            [10, 11, 6]  /* T */
        ];

        /*
         * Subdivision pattern (each triangle divided into 9 sub-triangles):
         *
         *         v0
         *        /  \
         *       /  9 \
         *      v3----v8
         *     / \  8 / \
         *    / 4 \  / 7 \
         *   v4----v9----v7
         *  / \ 3 /  \ 6 / \
         * / 1 \ /  2 \ / 5 \
         * v1----v5----v6----v2
         */

        this.subvert = [
            [0, 0, 1], /* v3 */
            [0, 1, 1], /* v4 */
            [1, 1, 2], /* v5 */
            [1, 2, 2], /* v6 */
            [0, 2, 2], /* v7 */
            [0, 0, 2], /* v8 */
            [0, 1, 2]  /* v9 */
        ];

        this.subface = [
            [0, 1, 2], /* Not really used */
            [4, 1, 5], /* facet 1 */
            [9, 5, 6], /* facet 2 */
            [5, 9, 4], /* facet 3 */
            [3, 4, 9], /* facet 4 */
            [7, 6, 2], /* facet 5 */
            [6, 7, 9], /* facet 6 */
            [8, 9, 7], /* facet 7 */
            [9, 8, 3], /* facet 8 */
            [0, 3, 8]  /* facet 9 */
        ];
    }

    /**
     * Convert a tile name to geographic coordinates
     * @param {string} name - Tile code (e.g., "M713289")
     * @returns {Array} Array of 3 corner coordinates, each as [lat, lon]
     */
    nameToLocations(name) {
        let verts = this.nameToFacet(name);

        return [
            TileLookup.pointToGeo(verts[0]),
            TileLookup.pointToGeo(verts[1]),
            TileLookup.pointToGeo(verts[2])
        ];
    }

    /**
     * Convert a tile name to 3D unit sphere vertices
     * @param {string} name - Tile code
     * @returns {Array} Array of 3 vertices on unit sphere
     */
    nameToFacet(name) {
        let major = this.facets.indexOf(name.charAt(0).toUpperCase()),
            verts = [];

        if (major < 0) {
            throw new Error('Invalid tile code: first character must be A-T');
        }

        for (let i = 0; i < 3; i++) {
            verts[i] = this.vico[this.fico[major][i]];
        }

        for (let i = 1; i < name.length; i++) {
            let facet = parseInt(name.charAt(i));

            if (isNaN(facet) || facet < 1 || facet > 9) {
                throw new Error('Invalid tile code: digits must be 1-9');
            }

            this.subTri(verts, facet, verts);
        }

        return verts;
    }

    /**
     * Convert latitude/longitude to tile name
     * @param {number} latitude - Latitude in degrees
     * @param {number} longitude - Longitude in degrees
     * @returns {string} Tile code
     */
    locationToName(latitude, longitude) {
        return this.pointToName(TileLookup.geoToPoint(latitude, longitude), 6);
    }

    pointToName(p, depth) {
        let i = 0,
            facet,
            verts = [],
            facetId = "";

        for (facet = 0; facet < 20; facet++) {
            for (i = 0; i < 3; i++) {
                verts[i] = this.vico[this.fico[facet][i]];
            }

            if (TileLookup.within(p, verts[0], verts[1], verts[2])) {
                break;
            }
        }

        if (facet >= 20) {
            console.log("Trouble: " + p[0] + ", " + p[1] + ", " + p[2] + " not within any triangle");
            return null;
        }

        facetId += this.facets[facet];

        for (i = 0; i < depth; i++) {
            facet = this.findTri(verts, p, verts);
            if (facet < 0) {
                break;
            }

            facetId += facet;
        }

        return facetId;
    }

    findTri(t, p, subt) {
        let v = [];

        v[0] = t[0];
        v[1] = t[1];
        v[2] = t[2];
        for (let i = 0; i < 10 - 3; i++) {
            v[i + 3] = TileLookup.interp(t[this.subvert[i][0]], t[this.subvert[i][1]], t[this.subvert[i][2]]);
        }

        let facet;

        if (TileLookup.rightSide(p, v[6], v[3])) {
            if (TileLookup.rightSide(p, v[9], v[5])) {
                facet = 2;
            } else if (TileLookup.rightSide(p, v[5], v[4])) {
                facet = 1;
            } else if (TileLookup.rightSide(p, v[4], v[9])) {
                facet = 4;
            } else {
                facet = 3;
            }
        } else {
            if (TileLookup.rightSide(p, v[7], v[9])) {
                if (TileLookup.rightSide(p, v[6], v[7])) {
                    facet = 6;
                } else {
                    facet = 5;
                }
            } else {
                if (TileLookup.rightSide(p, v[8], v[9])) {
                    facet = 7;
                } else if (TileLookup.rightSide(p, v[8], v[3])) {
                    facet = 8;
                } else {
                    facet = 9;
                }
            }
        }

        for (let i = 0; i < 3; i++) {
            subt[i] = v[this.subface[facet][i]];
        }

        if (!TileLookup.within(p, subt[0], subt[1], subt[2])) {
            return -1;
        }

        return facet;
    }

    subTri(tri, facet, subt) {
        let t = [tri[0], tri[1], tri[2]];

        for (let i = 0; i < 3; i++) {
            let k = this.subface[facet][i];

            subt[i] = k < 3 ? t[k] : TileLookup.interp(
                t[this.subvert[k - 3][0]],
                t[this.subvert[k - 3][1]],
                t[this.subvert[k - 3][2]]
            )
        }
    }

    // Static utility methods

    static geoToPoint(latitude, longitude) {
        latitude *= Math.PI / 180;
        longitude *= Math.PI / 180;

        let r = Math.cos(latitude);

        return [r * Math.cos(longitude), r * Math.sin(longitude), Math.sin(latitude)]
    }

    static pointToGeo(point) {
        let r = Math.sqrt(point[0] * point[0] + point[1] * point[1]),
            lat = Math.atan2(point[2], r),
            lon = r === 0 ? 0 : Math.atan2(point[1], point[0]);

        lat *= 180 / Math.PI;
        lon *= 180 / Math.PI;

        lat = Math.abs(lat) > 90 ? Math.sign(lat) * 90 : lat;
        lon = Math.abs(lon) > 180 ? Math.sign(lon) * 180 : lon;

        return [lat, lon];
    }

    static within(v, va, vb, vc) {
        return TileLookup.rightSide(v, va, vb) && TileLookup.rightSide(v, vb, vc) && TileLookup.rightSide(v, vc, va);
    }

    static rightSide(v, va, vb) {
        return TileLookup.dot(TileLookup.cross(va, vb), v) >= 0;
    }

    static interp(v1, v2, v3) {
        let x = v1[0] + v2[0] + v3[0],
            y = v1[1] + v2[1] + v3[1],
            z = v1[2] + v2[2] + v3[2],
            m = Math.sqrt(x * x + y * y + z * z);

        return [x / m, y / m, z / m];
    }

    static normalize(v) {
        let m = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);

        return [v[0] / m, v[1] / m, v[2] / m];
    }

    static dot(a, b) {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    static cross(a, b) {
        return [
            (a[1] * b[2]) - (a[2] * b[1]),
            (a[2] * b[0]) - (a[0] * b[2]),
            (a[0] * b[1]) - (a[1] * b[0])
        ]
    }
}
