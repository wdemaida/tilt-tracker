import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Camera, TrendingUp, MapPin, Trophy, Target, Users, Clock, Instagram, MessageCircle, MessagesSquare, Link2, Mail,
  type LucideIcon,
} from 'lucide-react';
import { PinballIcon } from '../components/PinballIcon';
import BadgeImage from '../components/BadgeImage';
import WelcomeTimeline from '../components/welcome/WelcomeTimeline';
import { PhoneVideo, Screenshot } from '../components/welcome/WelcomeMedia';
import { enableGuestMode } from '../lib/guestMode';
import { useWelcomeContent } from '../lib/useWelcomeContent';
import { parseChips, parseLadder, socialHref, socialKind, type SocialKind } from '../lib/welcomeParts';
import { InlineText, RichText } from '../components/RichText';

// /welcome. Every word on it comes from useWelcomeContent() — defaults in lib/welcomeContent.ts,
// edited in Admin > Config > Welcome page. Only the illustrations are fixed here: the sample score
// card, the two example challenge cards and the badge ladder's icons.

// One icon per How-it-works step, in order (cycled if an admin adds more steps).
const STEP_ICONS = [
  { Icon: Camera, tone: 'bg-primary/15 border-primary/45', color: 'text-primary' },
  { Icon: PinballIcon, tone: 'bg-machine/15 border-machine/45', color: 'text-machine' },
  { Icon: TrendingUp, tone: 'bg-venue/15 border-venue/45', color: 'text-venue' },
];

// The social section's facts panel, in order (cycled).
const FACT_ICONS = [
  { Icon: Users, tone: 'bg-friend/10 border-friend/40', color: 'text-friend' },
  { Icon: PinballIcon, tone: 'bg-machine/15 border-machine/45', color: 'text-machine' },
  { Icon: Clock, tone: 'bg-primary/15 border-primary/45', color: 'text-primary' },
];

// The challenge type cards: icon + accent, in order (cycled).
const TYPE_STYLES = [
  { Icon: Trophy, tone: 'bg-primary/15 border-primary/45', color: 'text-primary' },
  { Icon: Target, tone: 'bg-username/15 border-username/45', color: 'text-username' },
];

// The badge ladder's look, by position. BadgeImage takes hex colors: these are the theme's primary,
// machine and username defaults.
const LADDER_LOOK = [
  { icon: 'camera', color: '#dd47eb' },
  { icon: 'compass', color: '#3ebaf4' },
  { icon: 'flame', color: '#facc14' },
  { icon: 'star', color: '#dd47eb' },
];

const SOCIAL_ICONS: Record<SocialKind, LucideIcon> = {
  instagram: Instagram, reddit: MessageCircle, discord: MessagesSquare, other: Link2,
};

const eyebrowCls = 'text-xs font-bold uppercase tracking-[0.22em] text-muted-foreground';
const h2Cls = 'mt-3 font-display uppercase font-black tracking-tight text-3xl sm:text-4xl';
const primaryBtn = 'px-5 py-3 rounded-lg bg-primary text-white text-sm font-bold uppercase tracking-wider hover:opacity-90 transition-opacity';
const ghostBtn = 'px-5 py-2.5 rounded-lg border border-white/15 text-sm font-bold uppercase tracking-wider hover:border-white/40 hover:bg-white/5 transition-colors';

export default function WelcomePage() {
  const [, navigate] = useLocation();
  const content = useWelcomeContent();
  const hero = content['welcome.hero'];
  const how = content['welcome.how'];
  const social = content['welcome.social'];
  const badges = content['welcome.badges'];
  const action = content['welcome.action'];
  const founder = content['welcome.founder'];
  const timeline = content['welcome.timeline'];
  const closing = content['welcome.closing'];
  const socials = content['welcome.socials'];

  function handleGuest() {
    enableGuestMode();
    navigate('/');
  }

  return (
    <div className="min-h-screen w-full bg-background text-foreground overflow-x-clip">
      <nav className="sticky top-0 z-50 w-full border-b border-white/10 bg-background/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-20">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center border border-primary/50">
              <Trophy className="w-6 h-6 text-primary" aria-hidden />
            </div>
            <span className="font-display text-lg sm:text-2xl tracking-widest text-white">
              TILT<span className="text-primary">TRACK</span>
            </span>
          </div>
          <div className="flex items-center gap-6">
            <Link href="/sign-in" className="hidden sm:block text-sm font-bold uppercase tracking-wider text-muted-foreground hover:text-white transition-colors">
              Sign In
            </Link>
            <Link href="/sign-up" className="whitespace-nowrap px-3 sm:px-4 py-2.5 rounded-lg bg-primary text-white text-xs sm:text-sm font-bold uppercase tracking-wider hover:opacity-90 transition-opacity">
              Start Tracking
            </Link>
          </div>
        </div>
      </nav>

      {/* 1 · Hero */}
      <section className="relative overflow-clip py-14 sm:py-24">
        <div
          className="absolute -inset-x-10 -top-20 h-[640px] pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse at 30% 20%, hsl(var(--primary) / 0.2), transparent 60%), radial-gradient(ellipse at 80% 0%, hsl(var(--machine) / 0.1), transparent 55%)',
          }}
        />
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 md:grid-cols-[1.15fr_1fr] gap-10 md:gap-16 items-center">
          <div>
            {hero.eyebrow && <div className={`${eyebrowCls} mb-3`}>{hero.eyebrow}</div>}
            <h1 className="font-display uppercase font-black tracking-tight leading-[1.02] text-5xl sm:text-6xl lg:text-7xl [overflow-wrap:anywhere]">
              <InlineText text={hero.headline} />
            </h1>
            <RichText
              text={hero.subhead}
              className="mt-6 space-y-3 text-lg leading-relaxed text-muted-foreground max-w-[46ch]"
            />
            <div className="mt-8 flex items-center gap-4 flex-wrap">
              <Link href="/sign-up" className={primaryBtn}>Start Tracking</Link>
              <Link href="/sign-in" className={ghostBtn}>Sign In</Link>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Just want to look around first?{' '}
              <button onClick={handleGuest} className="underline underline-offset-2 text-white hover:text-primary transition-colors">
                Continue as a guest
              </button>{' '}
              — you can browse every score, but you'll need an account to submit your own.
            </p>
          </div>

          <div className="flex justify-center">
            <div className="relative w-full max-w-sm rounded-2xl border border-white/10 bg-card p-5 shadow-2xl">
              <span className="absolute -top-3 left-5 text-[0.6rem] font-extrabold uppercase tracking-widest text-background bg-username rounded-full px-2.5 py-1">
                A captured TiltTrack score
              </span>
              <div className="flex items-center justify-between">
                <span className="text-[0.65rem] font-extrabold uppercase tracking-wider text-muted-foreground border border-white/20 rounded-full px-2.5 py-0.5">
                  Casual
                </span>
                <span className="text-[0.65rem] font-extrabold uppercase tracking-wider text-muted-foreground border border-white/20 rounded-full px-2.5 py-0.5">
                  Proof attached
                </span>
              </div>
              <div className="mt-4 font-bold text-machine">The Shadow</div>
              <div className="mt-1.5 text-4xl sm:text-5xl font-bold text-primary text-glow-primary tabular-nums">102,070,660</div>
              <div className="mt-3.5 flex items-center justify-between gap-2 flex-wrap text-sm text-muted-foreground">
                <span>Jun 14, 2026 · 9:12 PM</span>
                <span className="inline-flex items-center gap-1 text-venue font-semibold">
                  <MapPin className="w-3 h-3 flex-shrink-0" />
                  Pastime Pinball
                </span>
              </div>
              <div className="mt-4 pt-3.5 border-t border-white/10 text-sm text-username font-bold">@helmhead</div>
            </div>
          </div>
        </div>
      </section>

      {/* 2 · How it works */}
      <section className="py-16 sm:py-28 border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {how.tagline && (
            <div className="inline-flex items-center gap-2.5 text-xs font-extrabold uppercase tracking-[0.2em] text-machine mb-5">
              <span aria-hidden className="w-7 h-0.5 bg-machine" />
              {how.tagline}
            </div>
          )}
          <div className="max-w-[62ch]">
            {how.eyebrow && <div className={eyebrowCls}>{how.eyebrow}</div>}
            <h2 className={h2Cls}><InlineText text={how.title} /></h2>
          </div>
          <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-5 md:gap-6">
            {how.steps.map((step, i) => {
              const { Icon, tone, color } = STEP_ICONS[i % STEP_ICONS.length];
              return (
                <div key={i} className="rounded-2xl border border-white/10 bg-card p-6 min-w-0">
                  <div className="flex items-start justify-between mb-5">
                    <div className={`w-11 h-11 rounded-xl border flex items-center justify-center ${tone}`}>
                      <Icon className={`w-5 h-5 ${color}`} />
                    </div>
                    <span className="text-[0.7rem] font-extrabold uppercase tracking-[0.16em] text-muted-foreground">Step {i + 1}</span>
                  </div>
                  <h3 className="font-bold">{step.title}</h3>
                  <RichText text={step.body} className="mt-2.5 space-y-2 text-sm leading-relaxed text-muted-foreground" />
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* 3 · Play together */}
      <section className="py-16 sm:py-28 border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {social.eyebrow && <div className={eyebrowCls}>{social.eyebrow}</div>}
          <h2 className={h2Cls}><InlineText text={social.title} /></h2>
          {social.intro && (
            <RichText text={social.intro} className="mt-4 space-y-3 text-[1.05rem] leading-relaxed text-muted-foreground max-w-[60ch]" />
          )}

          <div className="mt-12 grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-6 lg:gap-10 items-start">
            <div className="min-w-0">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                {social.types.map((type, i) => {
                  const { Icon, tone, color } = TYPE_STYLES[i % TYPE_STYLES.length];
                  return (
                    <article key={i} className="rounded-2xl border border-white/10 bg-card p-6 min-w-0 flex flex-col gap-4">
                      <div className={`w-11 h-11 rounded-xl border flex items-center justify-center ${tone}`}>
                        <Icon className={`w-5 h-5 ${color}`} />
                      </div>
                      <div>
                        {type.kicker && <div className={`text-[0.7rem] font-extrabold uppercase tracking-[0.16em] ${color}`}>{type.kicker}</div>}
                        <h3 className="mt-0.5 text-xl font-black uppercase tracking-tight">{type.title}</h3>
                        <RichText text={type.body} className="mt-2.5 space-y-2 text-sm leading-relaxed text-muted-foreground" />
                      </div>
                      {i === 0 && <HighScoreExample />}
                      {i === 1 && <TargetExample />}
                    </article>
                  );
                })}
              </div>
              {social.also && <RichText text={social.also} className="mt-4 text-sm text-muted-foreground" />}
            </div>

            <div className="rounded-2xl border border-white/10 bg-card min-w-0 divide-y divide-white/10">
              {social.facts.map((fact, i) => {
                const { Icon, tone, color } = FACT_ICONS[i % FACT_ICONS.length];
                const chips = parseChips(fact.chips);
                return (
                  <div key={i} className="flex gap-4 p-5 sm:p-6 items-start min-w-0">
                    <div className={`w-11 h-11 rounded-xl border flex-shrink-0 flex items-center justify-center ${tone}`}>
                      <Icon className={`w-5 h-5 ${color}`} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-extrabold">{fact.title}</h3>
                      <RichText text={fact.body} className="mt-1.5 space-y-2 text-sm leading-relaxed text-muted-foreground" />
                      {chips.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          {chips.map((c, j) => (
                            <span
                              key={j}
                              className={`text-xs font-bold rounded-md px-2 py-0.5 border tabular-nums ${
                                c.highlighted ? 'border-primary/45 text-primary bg-primary/15' : 'border-white/10 text-white/80 bg-white/[0.03]'
                              }`}
                            >
                              {c.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* 4 · Badges (a slim strip) */}
      <section className="py-10 border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-wrap items-center justify-between gap-x-8 gap-y-5">
          <div className="max-w-[56ch] min-w-0">
            <h2 className="text-lg font-black uppercase tracking-wide"><InlineText text={badges.title} /></h2>
            <RichText text={badges.body} className="mt-1.5 space-y-2 text-sm leading-relaxed text-muted-foreground" />
          </div>
          <BadgeLadder names={parseLadder(badges.ladder)} />
        </div>
      </section>

      {/* 5 · See it in action */}
      <section className="py-16 sm:py-28 border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {action.eyebrow && <div className={eyebrowCls}>{action.eyebrow}</div>}
          <h2 className={h2Cls}><InlineText text={action.title} /></h2>
          {action.caption && (
            <RichText text={action.caption} className="mt-4 space-y-2 text-[1.05rem] leading-relaxed text-muted-foreground max-w-[60ch]" />
          )}
          <div className="mt-12 grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-8 lg:gap-14 items-center">
            <PhoneVideo />
            {action.shots.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 min-w-0">
                {/* An odd count would leave a hole in the 2-column grid, so the first shot spans it. */}
                {action.shots.map((shot, i) => (
                  <Screenshot key={i} index={i} title={shot.title} image={shot.image} wide={i === 0 && action.shots.length % 2 === 1} />
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 6 · Founder's note, with the timeline beside it */}
      <section id="founder" className="py-16 sm:py-28 border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {founder.eyebrow && <div className={eyebrowCls}>{founder.eyebrow}</div>}
          <h2 className="mt-3 font-display uppercase font-black tracking-tight leading-[1.04] text-4xl sm:text-5xl lg:text-6xl">
            <InlineText text={founder.title} />
          </h2>
          <div className="mt-10 sm:mt-12 grid grid-cols-1 lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)] gap-10 lg:gap-16 items-start">
            {/* The timeline sits left of the letter; phones stack it above, in the same reading order. */}
            <div className="min-w-0">
              <WelcomeTimeline timeline={timeline} />
            </div>
            <div className="min-w-0">
              <RichText
                text={founder.body}
                className="space-y-[1.1em] text-[1.075rem] leading-[1.78] text-white/80 max-w-[62ch]"
              />
              {founder.signature && <Signature text={founder.signature} />}
            </div>
          </div>

          <div className="mt-20 sm:mt-24 text-center">
            <h2 className="font-display uppercase font-black tracking-tight text-3xl sm:text-5xl">
              <InlineText text={closing.title} />
            </h2>
            <div className="mt-8 flex justify-center gap-4 flex-wrap">
              <Link href="/sign-up" className={primaryBtn}>Start Tracking</Link>
              <Link href="/sign-in" className={ghostBtn}>Sign In</Link>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Or{' '}
              <button onClick={handleGuest} className="underline underline-offset-2 text-white hover:text-primary transition-colors">
                continue as a guest
              </button>{' '}
              to browse first.
            </p>
          </div>
        </div>
      </section>

      {/* 7 · Socials + contact */}
      <section className="py-12 border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-wrap items-center justify-between gap-6">
          <div className="min-w-0">
            <h2 className="text-lg font-black uppercase tracking-wide"><InlineText text={socials.title} /></h2>
            {socials.intro && <RichText text={socials.intro} className="mt-1.5 text-sm text-muted-foreground" />}
          </div>
          <div className="flex flex-wrap items-center gap-2.5 min-w-0">
            {socials.links.map((link, i) => <SocialLink key={i} label={link.label} url={link.url} />)}
            {socials.email && <EmailChip email={socials.email} />}
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-3 flex-wrap text-sm text-muted-foreground">
          <span>TILT<span className="text-primary font-bold">TRACK</span></span>
          <span>Every score remembered.</span>
        </div>
      </footer>
    </div>
  );
}

// ── illustrations (fixed, not copy) ──────────────────────────────────────────────

const exampleBox = 'mt-auto rounded-xl border border-white/10 bg-[hsl(240_9%_10%)] p-3.5 text-[0.8rem]';
const exampleTag = 'text-[0.6rem] font-extrabold uppercase tracking-[0.12em] text-muted-foreground';

function HighScoreExample() {
  return (
    <div className={exampleBox} aria-label="Example high score challenge">
      <div className="flex justify-between gap-2"><span className="font-bold text-machine">Godzilla (any model)</span><span className="text-muted-foreground tabular-nums whitespace-nowrap">2d 6h left</span></div>
      <div className="mt-2 flex justify-between gap-2"><span className="font-bold text-username">You</span><span className="font-extrabold text-primary tabular-nums">412,880,150</span></div>
      <div className="mt-1.5 h-1.5 rounded-full bg-border overflow-hidden"><div className="h-full w-[82%] rounded-full bg-primary" /></div>
      <div className="mt-2 flex justify-between gap-2"><span className="font-bold text-friend">A friend</span><span className="font-extrabold text-primary tabular-nums">503,120,600</span></div>
      <div className="mt-1.5 h-1.5 rounded-full bg-border overflow-hidden"><div className="h-full w-full rounded-full bg-friend" /></div>
      <div className="mt-2.5 flex justify-between gap-2"><span className={exampleTag}>Example</span><span className={exampleTag}>1 week · 3 players</span></div>
    </div>
  );
}

function TargetExample() {
  return (
    <div className={exampleBox} aria-label="Example hit the target challenge">
      <div className="flex justify-between gap-2"><span className="font-bold text-machine">Attack from Mars</span><span className="text-muted-foreground tabular-nums whitespace-nowrap">4d left</span></div>
      <div className="mt-2 flex justify-between gap-2"><span className="text-muted-foreground">Target</span><span className="font-extrabold text-primary tabular-nums">2,150,000,000</span></div>
      <div className="mt-2 flex justify-between gap-2"><span className="font-bold text-friend">A friend</span><span className="font-extrabold text-white/80 tabular-nums">1,874,300,220</span></div>
      <div className="mt-1.5 h-1.5 rounded-full bg-border overflow-hidden"><div className="h-full w-[87%] rounded-full bg-friend" /></div>
      <div className="mt-2.5 flex justify-between gap-2"><span className={exampleTag}>Example</span><span className={exampleTag}>First past it wins</span></div>
    </div>
  );
}

function BadgeLadder({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div className="flex items-start gap-1.5 flex-wrap" aria-label="Example badge ladder">
      {names.map((name, i) => {
        const look = LADDER_LOOK[i % LADDER_LOOK.length];
        const top = i === names.length - 1;
        return (
          <div key={i} className="flex items-start gap-1.5">
            {i > 0 && <span aria-hidden className="mt-3 font-black text-border">›</span>}
            <div className="w-[74px] flex flex-col items-center gap-1.5">
              <BadgeImage
                badge={{ id: 0, name, icon: look.icon, color: look.color, imageVersion: null }}
                size={46}
                className={top ? 'shadow-[0_0_14px_hsl(var(--primary)/0.5)]' : ''}
              />
              <span className="text-[0.65rem] font-bold text-center leading-tight text-white/80">{name}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── small pieces ─────────────────────────────────────────────────────────────────

/** "Will @helmhead": the name in bold, any @handle in the username color. */
function Signature({ text }: { text: string }) {
  const parts = text.split(/(@[A-Za-z0-9_.-]+)/);
  return (
    <div className="mt-2 pt-4 border-t border-white/10 max-w-[62ch] flex flex-wrap items-baseline gap-x-2.5">
      {parts.map((p, i) =>
        p.startsWith('@')
          ? <span key={i} className="text-username font-bold text-sm">{p}</span>
          : p.trim() ? <span key={i} className="font-bold text-[1.05rem]">{p.trim()}</span> : null,
      )}
    </div>
  );
}

function SocialLink({ label, url }: { label: string; url: string }) {
  const Icon = SOCIAL_ICONS[socialKind(label, url)];
  const href = socialHref(url);
  const cls = 'inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border text-sm font-bold';
  if (!href) {
    return (
      <span className={`${cls} border-dashed border-white/15 text-muted-foreground`}>
        <Icon className="w-4 h-4" aria-hidden />
        {label}
        <span className="text-[0.65rem] tracking-[0.1em] uppercase">Soon</span>
      </span>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${cls} border-white/10 bg-card hover:border-white/30 transition-colors`}>
      <Icon className="w-4 h-4" aria-hidden />
      {label}
    </a>
  );
}

function EmailChip({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard access (insecure context, denied): the address is still right there to select.
    }
  }
  return (
    <span className="inline-flex items-center gap-2 pl-3.5 pr-1.5 py-1.5 rounded-xl border border-white/10 bg-card text-sm font-semibold max-w-full">
      <Mail className="w-4 h-4 flex-shrink-0 text-muted-foreground" aria-hidden />
      <a href={`mailto:${email}`} className="hover:text-primary transition-colors truncate">{email}</a>
      <button
        type="button"
        onClick={copy}
        className="text-[0.7rem] font-bold uppercase tracking-[0.08em] px-2.5 py-1.5 rounded-lg border border-white/10 bg-white/[0.04] hover:bg-white/10 transition-colors"
      >
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </span>
  );
}
