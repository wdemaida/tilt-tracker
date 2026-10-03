// The Venues page's Map view. Switched off 2026-09-30 (it read as a stand-in for Pinball Map's own
// site, and it pinned only scores with photo GPS, so venues went missing); back on 2026-10-03, rebuilt
// on GET /api/venues — one pin per venue with scores, at its server-computed public `mapPoint`
// (approximate circle for city_state home venues, nothing for hidden ones). Covers MapPage, the
// List / Map toggle, `?view=map`, the `/map` redirect and the venue page's thumbnail click-through;
// flip to false to hide the whole lot again.
export const MAP_VIEW_ENABLED: boolean = true;
