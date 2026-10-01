// The /welcome page's copy: the built-in defaults, and how admin edits (site_content, Admin > Config >
// Welcome page) are laid over them. The page renders these defaults immediately and swaps in any
// overrides when GET /api/content/welcome answers — it never waits on the database.
//
// To change the copy without the admin editor, edit it here. The shapes are checked server-side by
// CONTENT_SPEC in api-server src/lib/siteContent.ts — a new field needs adding there too.
//
// Text formatting (lib/richText.ts): body text takes paragraphs (blank line), **bold**, *italic* and
// [links](https://…); headings take ==glow== and line breaks (\n).
//
// List conventions the page relies on: a social fact's `chips` is comma-separated (a leading * marks
// the highlighted chip); `badges.ladder` is up to four comma-separated badge names; an action shot's
// `image` is a file name in public/welcome/; a socials link with no URL shows as "Soon".

import { isWelcomeIcon } from './iconNames';

export interface WelcomeContent {
  'welcome.hero': { eyebrow: string; headline: string; subhead: string };
  'welcome.how': { tagline: string; eyebrow: string; title: string; steps: Array<{ icon: string; title: string; body: string }> };
  'welcome.social': {
    eyebrow: string;
    title: string;
    intro: string;
    types: Array<{ kicker: string; title: string; body: string }>;
    also: string;
    facts: Array<{ title: string; body: string; chips: string }>;
  };
  'welcome.badges': { title: string; body: string; ladder: string };
  'welcome.action': { eyebrow: string; title: string; caption: string; shots: Array<{ title: string; image: string }> };
  'welcome.founder': { eyebrow: string; title: string; body: string; signature: string };
  'welcome.timeline': { title: string; hint: string; entries: Array<{ when: string; title: string; body: string }> };
  'welcome.closing': { title: string };
  'welcome.socials': { title: string; intro: string; email: string; links: Array<{ label: string; url: string }> };
}

export type WelcomeKey = keyof WelcomeContent;

export const WELCOME_DEFAULTS: WelcomeContent = {
  'welcome.hero': {
    eyebrow: '',
    headline: "Snap your score.\n==See if you're getting better.==",
    subhead:
      '90% of the machines on your route were built before score tracking existed. Snap a photo of the backbox — ' +
      'TiltTrack reads the machine, the score, the date, even the venue, and remembers it for good.',
  },
  'welcome.how': {
    tagline: 'No machine left behind',
    eyebrow: 'How it works',
    title: 'Point, shoot, ==forget about it.==',
    steps: [
      {
        icon: 'camera',
        title: "Snap it, don't type it",
        body: 'One photo of the backbox. The Engine fills in the machine, the score, the time and the venue. Prefer typing? Skip the Engine anytime.',
      },
      {
        icon: 'pinball',
        title: 'Matched to the right machine',
        body: "Checked against more than 2,000 machines, from 1970s electromechanicals to next month's Stern release. The oldest games become competitive too.",
      },
      {
        icon: 'trending-up',
        title: 'Your progress, measured',
        body: "Personal bests per machine, score trends over time, and a venue difficulty index that accounts for who else plays there. An honest read on whether you're improving.",
      },
    ],
  },
  'welcome.social': {
    eyebrow: 'Play together',
    title: 'Nobody nearby? ==Play anyway.==',
    intro:
      'Playing on location with friends is the best part of pinball. If you live somewhere with three machines and no one to play with, ' +
      'TiltTrack brings the competition to you. Challenge friends anywhere, on the machines you can each get to.',
    types: [
      {
        kicker: 'Challenge type',
        title: 'High score',
        body: 'Everyone plays during the window. Best score when the clock runs out wins.',
      },
      {
        kicker: 'Challenge type',
        title: 'Hit the target',
        body: 'Set a number to beat: your best on that machine, or one you pick. The first friend to post a score above it wins on the spot.',
      },
    ],
    also: 'Also: **Most improved** and **Best average**. Head to head, or a group of up to 8.',
    facts: [
      {
        title: 'Friends, and Pods',
        body: "Send a request; once they accept, you're friends. Challenges are friends only. Not friends? No problem — **Pods** let you group users into a pod to measure yourself against. Your pods are private to you.",
        chips: '',
      },
      {
        title: 'Same machine, wherever you are',
        body: '**Any model** counts Pro, Premium and LE together. **Exact model** means that machine only. Scores from any venue count, unless the challenge is locked to one.',
        chips: '',
      },
      {
        title: 'On the clock',
        body: "It starts when everyone's in, or at a time you pick. Scores have to be played and posted inside the window, with a photo. The photo's own timestamp keeps it honest.",
        chips: '3 days, *1 week, 2 weeks, Custom: 1 hour to 90 days',
      },
    ],
  },
  'welcome.badges': {
    title: 'Badges along the way',
    body: 'Earn badges as you play: post scores, explore new machines and venues, win challenges, build streaks. Climb ladders from First Ball to Wizard Mode.',
    ladder: 'First Ball, Explorer, Hot Streak, Wizard Mode',
  },
  'welcome.action': {
    eyebrow: 'See it in action',
    title: 'One photo. ==That’s it.==',
    caption: 'From the glass to your stats in a few seconds.',
    shots: [
      { title: 'Score trend', image: 'trend.jpg' },
      { title: 'Start a challenge', image: 'challenge.jpg' },
      { title: 'Every machine', image: 'machines.jpg' },
      { title: 'Site stats', image: 'overall-stats.jpg' },
      { title: 'Badges on your profile', image: 'badges.jpg' },
    ],
  },
  'welcome.founder': {
    eyebrow: 'A note from the founder',
    title: 'It started in a ==barn.==',
    body: [
      "My dad ran a route. From the '80s into the 2000s he put pinball and arcade games in bars, bowling alleys and restaurants, and when one broke, it came home to our barn. I was the official tester. I'd prop the coin door open and play for hours, or lift the glass to trigger modes by hand and learn how the rules worked.",
      'I never got very good. What I loved was finishing a game and seeing everything it had. On Creature I wanted every **Move Your Car** animation, not the points.',
      'Years later I came back to pinball wanting to finally get better, and found there was no easy way to tell if I was. So I built one. Take a picture, and TiltTrack remembers.',
      'Then I hit the other problem. Where I live now there are hardly any machines, and nobody I know plays. Pinball has always been better with other people. TiltTrack is how I’m finding them, and how you can too.',
    ].join('\n\n'),
    signature: 'Will @helmhead',
  },
  'welcome.timeline': {
    title: 'Three generations of pinball',
    hint: '',
    entries: [
      { when: '1950s', title: "Grandpa's route", body: 'My grandfather starts an operator business: pool tables, jukeboxes and cigarette machines.' },
      { when: '1980s–2000s', title: "Dad's route and the barn", body: 'Pinball and arcade games go out to bars and bowling alleys. Broken ones come home to the barn, where I test them for free.' },
      { when: 'Last one standing', title: "Ripley's stays", body: "When the route closes, Dad keeps one machine, Ripley's Believe It or Not. It's still in the barn, waiting for me to go get it." },
      { when: 'In a boarding line', title: 'The idea', body: "Listening to a pinball podcast, I realize I still can't tell if I'm getting better. A photo and some AI could fix that." },
      { when: 'Now', title: 'Players, not just scores', body: 'Friends, pods and challenges, for everyone with no machines nearby and nobody to play with.' },
    ],
  },
  'welcome.closing': {
    title: 'Your scores. ==Your legacy.==',
  },
  'welcome.socials': {
    title: 'Follow along',
    intro: 'Updates, new features and the occasional great score.',
    email: 'tilttrack@gmail.com',
    links: [
      { label: 'Instagram', url: '' },
      { label: 'r/pinball', url: 'https://www.reddit.com/r/pinball/' },
      { label: 'Discord', url: '' },
    ],
  },
};

export const WELCOME_KEYS = Object.keys(WELCOME_DEFAULTS) as WelcomeKey[];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A stored list replaces the default list, but an item saved before a field existed has no value for
 * it: each such item gets the field from the default item at the same position (cycled past the end).
 * Only missing fields — an empty string the admin left is kept.
 */
function fillListItems(stored: unknown[], defaults: unknown[]): unknown[] {
  if (!defaults.length || !defaults.every(isPlainObject)) return stored;
  return stored.map((item, i) => {
    if (!isPlainObject(item)) return item;
    const def = defaults[i % defaults.length] as Record<string, unknown>;
    const out = { ...item };
    for (const [f, v] of Object.entries(def)) if (typeof out[f] !== typeof v) out[f] = v;
    return out;
  });
}

/** How-it-works step icons: a missing, empty or unknown name means the default icon for that position. */
function withStepIcons(how: WelcomeContent['welcome.how']): WelcomeContent['welcome.how'] {
  const defaults = WELCOME_DEFAULTS['welcome.how'].steps;
  return {
    ...how,
    steps: how.steps.map((s, i) => (isWelcomeIcon(s.icon) ? s : { ...s, icon: defaults[i % defaults.length].icon })),
  };
}

/**
 * The defaults with each stored override laid over its key. Field by field, so a field added to the
 * defaults after a row was saved still shows its default — inside list items too (fillListItems).
 * Anything that isn't an object for a known key is ignored (the server validates; this only guards
 * against a surprise). Pure — unit-tested.
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
      if (Array.isArray(def)) { if (Array.isArray(v)) merged[field] = fillListItems(v, def); }
      else if (typeof v === typeof def) merged[field] = v;
    }
    out[key] = merged;
  }
  out['welcome.how'] = withStepIcons(out['welcome.how'] as WelcomeContent['welcome.how']);
  return out as WelcomeContent;
}
