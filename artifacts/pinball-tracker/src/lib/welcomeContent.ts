// The /welcome page's copy: the built-in defaults, and how admin edits (site_content, Admin > Config >
// Welcome page) are laid over them. The page renders these defaults immediately and swaps in any
// overrides when GET /api/content/welcome answers — it never waits on the database.
//
// To change the copy without the admin editor, edit it here. The shapes are checked server-side by
// CONTENT_SPEC in api-server src/lib/siteContent.ts — a new field needs adding there too.
//
// Text formatting (lib/richText.ts): body text takes paragraphs (blank line), **bold**, *italic* and
// [links](https://…); headings take ==glow== and line breaks (\n).

export interface WelcomeContent {
  'welcome.hero': { eyebrow: string; headline: string; subhead: string };
  'welcome.how': { title: string; steps: Array<{ title: string; body: string }> };
  'welcome.social': { title: string; intro: string; cards: Array<{ title: string; body: string }> };
  'welcome.badges': { title: string; body: string };
  'welcome.action': { title: string; caption: string };
  'welcome.founder': { title: string; body: string; signature: string };
  'welcome.timeline': { entries: Array<{ year: string; title: string; body: string }> };
  'welcome.socials': { title: string; email: string; links: Array<{ label: string; url: string }> };
}

export type WelcomeKey = keyof WelcomeContent;

export const WELCOME_DEFAULTS: WelcomeContent = {
  'welcome.hero': {
    eyebrow: 'Built by a player who wanted to get better',
    headline: "Snap your score.\n==See if you're getting better.==",
    subhead:
      '90% of the machines on your route were built before score tracking existed. Snap a photo of the backbox — ' +
      'TiltTrack reads the machine, the score, the date, even the venue, and remembers it for good.',
  },
  'welcome.how': {
    title: 'Point, shoot, forget about it.',
    steps: [
      {
        title: "Snap it, don't type it",
        body: "Snap a pic of the machine and TiltTrack's AI reads the machine name, the score, the timestamp, and your GPS location straight off the backbox. Prefer to type it yourself? Skip the AI anytime.",
      },
      {
        title: 'Works on machines of all ages',
        body: "Cross-referenced against a database of over 2,000 machines, from 1970s electromechanical classics to next month's hot Stern release — even the oldest machines can become competitive.",
      },
      {
        title: 'Watch yourself get better',
        body: 'Personal bests per machine, score trends over time, and a venue difficulty index that adjusts for who else has actually played there — not just a leaderboard, an honest read on your progress.',
      },
    ],
  },
  'welcome.social': {
    title: 'Pinball is better ==with company.==',
    intro: 'No machines nearby, or nobody to play with? Add friends and challenge them from anywhere.',
    cards: [
      {
        title: 'Friends',
        body: 'Send a request; once they accept, you can challenge each other and compare scores on the machines you both play.',
      },
      {
        title: 'High score',
        body: 'Pick a machine and a window — three days, a week, two weeks, or your own. Best score when time runs out wins. One on one, or up to eight players.',
      },
      {
        title: 'Beat my score',
        body: 'Set a target: your best on that machine, or a number you choose. The first player to post a score above it wins on the spot.',
      },
      {
        title: 'Same machine, fair fight',
        body: 'By default any model counts, so Pro, Premium and LE all play; lock it to one exact model if you like. Every score needs a photo and has to be played inside the window.',
      },
    ],
  },
  'welcome.badges': {
    title: 'Badges ==along the way.==',
    body: 'Earn badges as you play: post scores, explore new machines and venues, win challenges and build streaks.',
  },
  'welcome.action': {
    title: 'One photo. ==That’s it.==',
    caption: 'From the glass to your stats in a few seconds.',
  },
  'welcome.founder': {
    title: 'It started\nin a ==barn.==',
    body: [
      "My dad ran a route. From the '80s into the 2000s he put pinball and arcade games in bars, bowling alleys and restaurants, and when one broke, it came home to our barn. I was the official tester. I'd prop the coin door open and play for hours, or lift the glass to trigger modes by hand and learn how the rules worked.",
      'I never got very good. What I loved was finishing a game and seeing everything it had. On Creature I wanted every **Move Your Car** animation, not the points.',
      'Years later I came back to pinball wanting to finally get better, and found there was no easy way to tell if I was. So I built one. Take a picture, and TiltTrack remembers.',
      'Then I hit the other problem. Where I live now there are hardly any machines, and nobody I know plays. Pinball has always been better with other people. TiltTrack is how I’m finding them, and how you can too.',
    ].join('\n\n'),
    signature: 'Will @helmhead',
  },
  'welcome.timeline': {
    entries: [
      { year: '1950s', title: "Grandpa's route", body: 'My grandfather starts an operator business: pool tables, jukeboxes and cigarette machines.' },
      { year: '1980s–2000s', title: "Dad's route and the barn", body: 'Pinball and arcade games go out to bars and bowling alleys. Broken ones come home to the barn, where I test them for free.' },
      { year: 'Last one standing', title: "Ripley's stays", body: "When the route closes, Dad keeps one machine, Ripley's Believe It or Not. It's still in the barn, waiting for me to go get it." },
      { year: 'In a boarding line', title: 'The idea', body: "Listening to a pinball podcast, I realize I still can't tell if I'm getting better. A photo and some AI could fix that." },
      { year: 'Now', title: 'Players, not just scores', body: 'Friends, pods and challenges, for everyone with no machines nearby and nobody to play with.' },
    ],
  },
  'welcome.socials': {
    title: 'Follow ==along.==',
    email: 'tilttrack@gmail.com',
    links: [],
  },
};

export const WELCOME_KEYS = Object.keys(WELCOME_DEFAULTS) as WelcomeKey[];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The defaults with each stored override laid over its key. Field by field, so a field added to the
 * defaults after a row was saved still shows its default. Anything that isn't an object for a known
 * key is ignored (the server validates; this only guards against a surprise). Pure — unit-tested.
 */
export function mergeWelcomeContent(overrides: unknown): WelcomeContent {
  const out = { ...WELCOME_DEFAULTS } as Record<WelcomeKey, unknown>;
  if (!isPlainObject(overrides)) return out as WelcomeContent;
  for (const key of WELCOME_KEYS) {
    const o = overrides[key];
    if (!isPlainObject(o)) continue;
    const base = WELCOME_DEFAULTS[key] as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...base };
    for (const [field, def] of Object.entries(base)) {
      const v = o[field];
      if (Array.isArray(def) ? Array.isArray(v) : typeof v === typeof def) merged[field] = v;
    }
    out[key] = merged;
  }
  return out as WelcomeContent;
}
