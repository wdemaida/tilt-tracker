// The Venues page's Map view is switched off. It read as a stand-in for Pinball Map's own site, which
// TiltTrack shouldn't try to be, and it didn't show every venue that has scores anyway. The code all
// stays — MapPage, the List / Map toggle, `?view=map`, the `/map` redirect and the venue page's
// thumbnail click-through. Flip this to true to bring the whole lot back.
export const MAP_VIEW_ENABLED: boolean = false;
