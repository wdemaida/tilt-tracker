// Basemap tiles for every Leaflet map in the app, in one place so the two maps can never drift.
//
// This used to be CARTO's dark_all. CARTO began requiring an api_token for basemap tiles, and it
// does NOT fail loudly when one is missing — it returns HTTP 200 with a tile that has
// "API KEY REQUIRED / carto.com/basemaps/apikey" burned into the image, so the map degrades into a
// watermarked mess with nothing in the console and nothing for a health check to catch.
//
// Esri's Dark Gray Canvas needs no key at all, which also means no credential shipped in the
// frontend bundle where anyone can read it.
//
// NOTE the {z}/{y}/{x} path order — Esri puts row before column, the reverse of CARTO's and OSM's
// {z}/{x}/{y}. Leaflet substitutes the placeholders by name so the order is honoured as written,
// but transposing them silently serves tiles from the wrong place rather than erroring.
export const TILE_BASE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';

// Place names and road labels, as a transparent overlay drawn on top of the base. Esri splits these
// into a separate service; the base layer alone is nearly unlabelled at city zoom.
export const TILE_LABELS_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';

// Esri's terms require visible attribution wherever the tiles are shown at full size.
export const TILE_ATTRIBUTION =
  'Tiles &copy; <a href="https://www.esri.com/">Esri</a>';
