import { Link, useLocation } from 'wouter';
import { Camera, TrendingUp, MapPin, Trophy, Users, Globe } from 'lucide-react';
import { PinballIcon } from '../components/PinballIcon';
import { enableGuestMode } from '../lib/guestMode';
import bridgeImage from '../assets/welcome-bridge.jpg';

const OTHER_PLAYER_DOTS = [
  { cx: 114.08, cy: 143.2, score: '42,000,000' },
  { cx: 160.8, cy: 231.21, score: '9,800,000' },
  { cx: 254.24, cy: 89.9, score: '61,500,000' },
  { cx: 341.84, cy: 243.79, score: '5,200,000' },
  { cx: 394.4, cy: 184.2, score: '27,000,000' },
  { cx: 499.52, cy: 63.93, score: '71,000,000' },
  { cx: 546.24, cy: 215.36, score: '15,600,000' },
  { cx: 55.68, cy: 249.53, score: '3,100,000' },
  { cx: 225.04, cy: 125.43, score: '48,500,000' },
  { cx: 371.04, cy: 224.11, score: '12,400,000' },
  { cx: 470.32, cy: 157.41, score: '36,800,000' },
  { cx: 604.64, cy: 99.47, score: '58,000,000' },
];

const YOUR_DOTS = [
  { cx: 73.2, cy: 240.51, score: '6,400,000' },
  { cx: 190, cy: 254.36, score: '1,330,410' },
  { cx: 306.8, cy: 165.07, score: '34,000,000' },
  { cx: 435.28, cy: 207.43, score: '18,500,000' },
];

const BARN_MACHINES = [
  'Fire!',
  'World Cup Soccer',
  'Lights… Camera… Action!',
  'Creature from the Black Lagoon',
  "Ripley's Believe It or Not!",
];

const STORY_STOPS = [
  { when: '1950s', title: "Grandpa's route", body: 'My grandfather starts an operator business: pool tables, jukeboxes and cigarette machines.' },
  { when: '1980s–2000s', title: "Dad's route and the barn", body: 'Pinball and arcade games go out to bars and bowling alleys. Broken ones come home to the barn, where I test them for free.' },
  { when: 'Last one standing', title: "Ripley's stays", body: "When the route closes, Dad keeps one machine, Ripley's Believe It or Not. It's still in the barn, waiting for me to go get it." },
  { when: 'In a boarding line', title: 'The idea', body: "Listening to a pinball podcast, I realize I still can't tell if I'm getting better. A photo and some AI could fix that." },
  { when: 'Now', title: 'Players, not just scores', body: 'Friends, pods and challenges, for everyone with no machines nearby and nobody to play with.' },
];

export default function WelcomePage() {
  const [, navigate] = useLocation();

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
            <span className="font-display text-xl sm:text-2xl tracking-widest text-white">
              TILT<span className="text-primary">TRACK</span>
            </span>
          </div>
          <div className="flex items-center gap-6">
            <Link href="/sign-in" className="hidden sm:block text-sm font-bold uppercase tracking-wider text-muted-foreground hover:text-white transition-colors">
              Sign In
            </Link>
            <Link href="/sign-up" className="px-4 py-2.5 rounded-lg bg-primary text-white text-sm font-bold uppercase tracking-wider hover:opacity-90 transition-opacity">
              Start Tracking
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
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
            <div className="text-xs font-bold uppercase tracking-[0.22em] text-muted-foreground">Pinball score tracking</div>
            <h1 className="mt-3 font-display uppercase font-black tracking-tight leading-[1.02] text-5xl sm:text-6xl lg:text-7xl">
              No machine<br />
              <span className="text-glow-primary">left behind.</span>
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-muted-foreground max-w-[46ch]">
              90% of the machines on your route were built before score tracking existed. Snap a photo of the backbox —
              TiltTrack reads the machine, the score, the date, even the venue, and remembers it for good.
            </p>
            <div className="mt-8 flex items-center gap-4 flex-wrap">
              <Link href="/sign-up" className="px-5 py-3 rounded-lg bg-primary text-white text-sm font-bold uppercase tracking-wider hover:opacity-90 transition-opacity">
                Start Tracking
              </Link>
              <Link href="/sign-in" className="px-5 py-2.5 rounded-lg border border-white/15 text-sm font-bold uppercase tracking-wider hover:border-white/40 hover:bg-white/5 transition-colors">
                Sign In
              </Link>
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
              <div className="mt-1.5 text-4xl sm:text-5xl font-bold text-primary text-glow-primary">102,070,660</div>
              <div className="mt-3.5 flex items-center justify-between text-sm text-muted-foreground">
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

      {/* Features */}
      <section className="py-16 sm:py-28">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-[62ch]">
            <div className="text-xs font-bold uppercase tracking-[0.22em] text-muted-foreground">How it works</div>
            <h2 className="mt-3 font-display uppercase font-black tracking-tight text-3xl sm:text-4xl">
              Point, shoot, forget about it.
            </h2>
          </div>
          <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="rounded-2xl border border-white/10 bg-card p-6">
              <div className="w-11 h-11 rounded-xl bg-primary/15 border border-primary/45 flex items-center justify-center mb-5">
                <Camera className="w-5 h-5 text-primary" />
              </div>
              <h3 className="font-bold">Snap it, don't type it</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
                Snap a pic of the machine and TiltTrack's AI reads the machine name, the score, the timestamp, and your GPS location straight off the backbox. Prefer to type it yourself? Skip the AI anytime.
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-card p-6">
              <div className="w-11 h-11 rounded-xl bg-machine/15 border border-machine/45 flex items-center justify-center mb-5">
                <PinballIcon className="w-5 h-5 text-machine" />
              </div>
              <h3 className="font-bold">Works on machines of all ages</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
                Cross-referenced against a database of over 2,000 machines, from 1970s electromechanical classics to next month's hot Stern release — even the oldest machines can become competitive.
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-card p-6">
              <div className="w-11 h-11 rounded-xl bg-venue/15 border border-venue/45 flex items-center justify-center mb-5">
                <TrendingUp className="w-5 h-5 text-venue" />
              </div>
              <h3 className="font-bold">Watch yourself get better</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
                Personal bests per machine, score trends over time, and a venue difficulty index that adjusts for who else has actually played there — not just a leaderboard, an honest read on your progress.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Bridge narrative */}
      <section className="py-14 sm:py-24 border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-center">
            <img
              src={bridgeImage}
              alt="A weathered 1970s electromechanical pinball machine on the left, bridged by a glowing beam of light to a modern smartphone showing the TiltTrack app on the right"
              className="w-full max-w-[860px] h-auto rounded-2xl border border-white/10 shadow-2xl"
            />
          </div>
          <div className="mt-10 text-center max-w-[56ch] mx-auto">
            <h2 className="font-display uppercase font-black tracking-tight text-2xl sm:text-3xl">
              The leaderboard the machine never had.
            </h2>
            <p className="mt-3.5 text-muted-foreground leading-relaxed">
              Old machines don't track anything — no leaderboard, no history, nothing - TiltTrack does, for every machine you'll ever drop a coin into, no matter how old.
            </p>
          </div>
        </div>
      </section>

      {/* Founder's note */}
      <section className="py-16 sm:py-28 border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 grid grid-cols-1 lg:grid-cols-[0.8fr_1.2fr] gap-8 lg:gap-16 items-start">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.22em] text-muted-foreground">A note from the founder</div>
            <h2 className="mt-3 font-display uppercase font-black tracking-tight leading-[1.05] text-4xl sm:text-5xl">
              It started<br />in a <span className="text-glow-primary">barn.</span>
            </h2>
            <div className="mt-7">
              <div className="text-[0.7rem] font-extrabold uppercase tracking-[0.14em] text-muted-foreground">Off the route, in the barn</div>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {BARN_MACHINES.map(name => (
                  <span key={name} className="text-xs font-bold text-machine border border-machine/35 bg-machine/10 rounded-full px-3 py-1">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="max-w-[62ch] space-y-4 text-[1.05rem] leading-relaxed text-foreground/80">
            <p>
              My dad ran a route. From the '80s into the 2000s he put pinball and arcade games in bars, bowling alleys and restaurants, and when one broke, it came home to our barn. I was the official tester. I'd prop the coin door open and play for hours, or lift the glass to trigger modes by hand and learn how the rules worked.
            </p>
            <p>
              I never got very good. What I loved was finishing a game and seeing everything it had. On Creature I wanted every <span className="font-semibold text-foreground">Move Your Car</span> animation, not the points.
            </p>
            <p>
              Years later I came back to pinball wanting to finally get better, and found there was no easy way to tell if I was. So I built one. Take a picture, and TiltTrack remembers.
            </p>
            <p>
              Then I hit the other problem. Where I live now there are hardly any machines, and nobody I know plays. Pinball has always been better with other people. TiltTrack is how I'm finding them, and how you can too.
            </p>
            <div className="pt-4 border-t border-white/10 flex items-baseline gap-2.5">
              <span className="font-bold text-foreground">Will</span>
              <span className="text-sm font-bold text-username">@helmhead</span>
            </div>
          </div>
        </div>
      </section>

      {/* Story timeline */}
      <section className="py-16 sm:py-28 border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-[58ch] mx-auto">
            <div className="text-xs font-bold uppercase tracking-[0.22em] text-muted-foreground">Where this came from</div>
            <h2 className="mt-3 font-display uppercase font-black tracking-tight text-3xl sm:text-4xl">
              Three generations <span className="text-glow-primary">of pinball.</span>
            </h2>
          </div>
          <ol className="mt-12 sm:mt-14 grid grid-cols-1 lg:grid-cols-5 lg:gap-5">
            {STORY_STOPS.map((stop, i) => {
              const last = i === STORY_STOPS.length - 1;
              return (
                <li key={stop.title} className="relative pl-9 pb-8 lg:pl-0 lg:pb-0 lg:pt-9">
                  {!last && (
                    <span
                      aria-hidden
                      className="absolute bg-white/15 left-[7px] top-2 -bottom-2 w-0.5 lg:left-4 lg:-right-5 lg:top-[7px] lg:bottom-auto lg:w-auto lg:h-0.5"
                    />
                  )}
                  <span
                    aria-hidden
                    className={`absolute left-0 top-1 lg:top-0 w-4 h-4 rounded-full border-[3px] ${last ? 'border-primary bg-primary shadow-[0_0_10px_hsl(var(--primary)/0.8),0_0_26px_hsl(var(--primary)/0.45)]' : 'border-machine bg-card'}`}
                  />
                  <div className={`text-xs font-extrabold uppercase tracking-[0.14em] ${last ? 'text-primary' : 'text-machine'}`}>{stop.when}</div>
                  <h3 className="mt-1.5 font-extrabold">{stop.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground max-w-[40ch]">{stop.body}</p>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      {/* Mission */}
      <section className="py-16 sm:py-28 border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-[62ch]">
            <div className="text-xs font-bold uppercase tracking-[0.22em] text-muted-foreground">What TiltTrack is for</div>
            <h2 className="mt-3 font-display uppercase font-black tracking-tight text-3xl sm:text-4xl">
              Better games, <span className="text-glow-primary">better company.</span>
            </h2>
          </div>
          <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="rounded-2xl border border-white/10 bg-card p-6">
              <div className="w-11 h-11 rounded-xl bg-primary/15 border border-primary/45 flex items-center justify-center mb-5">
                <Camera className="w-5 h-5 text-primary" />
              </div>
              <h3 className="font-bold">Every play counts</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
                Not just the ones worth bragging about. The drained balls and the so-so nights are what show how far you've come, so log them all. It only takes a photo.
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-card p-6">
              <div className="w-11 h-11 rounded-xl bg-username/15 border border-username/45 flex items-center justify-center mb-5">
                <Users className="w-5 h-5 text-username" />
              </div>
              <h3 className="font-bold">See where you stand</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
                Put your scores next to everyone else's on the same machine. Find the players at your level and the ones worth chasing. Some of them turn into friends.
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-card p-6">
              <div className="w-11 h-11 rounded-xl bg-venue/15 border border-venue/45 flex items-center justify-center mb-5">
                <Globe className="w-5 h-5 text-venue" />
              </div>
              <h3 className="font-bold">Play together from anywhere</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
                No machines nearby, and nobody you know plays? Pods and challenges give you people to compete with, wherever they are. Pinball has always been better with company.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-16 sm:py-32 text-center border-t border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="font-display uppercase font-black tracking-tight text-4xl sm:text-5xl">
            Your scores. <span className="text-glow-primary">Your legacy.</span>
          </h2>

          <div className="mt-11 mb-14 sm:mb-20 max-w-[720px] mx-auto text-left">
            <div className="flex items-baseline justify-between flex-wrap gap-x-5 gap-y-2 mb-4">
              <div className="text-sm font-extrabold">
                The Munsters <span className="font-semibold text-muted-foreground">(Pro) · score trend</span>
              </div>
              <div className="flex gap-4 text-xs font-semibold text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-username inline-block" />You
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-field inline-block" />Everyone else
                </span>
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-card p-4 pb-2.5">
              <svg viewBox="0 0 640 300" className="w-full h-auto block" role="img" aria-label="Scatter chart of scores on The Munsters Pro over six months, comparing your plays to every other player's">
                <line x1="44" y1="12" x2="628" y2="12" stroke="hsl(var(--border))" strokeWidth="1" />
                <line x1="44" y1="94" x2="628" y2="94" stroke="hsl(var(--border))" strokeWidth="1" />
                <line x1="44" y1="176" x2="628" y2="176" stroke="hsl(var(--border))" strokeWidth="1" />
                <line x1="44" y1="258" x2="628" y2="258" stroke="hsl(var(--border))" strokeWidth="1" />

                <text x="36" y="16" textAnchor="end" fontSize="11" fill="hsl(var(--muted-foreground))">90M</text>
                <text x="36" y="98" textAnchor="end" fontSize="11" fill="hsl(var(--muted-foreground))">60M</text>
                <text x="36" y="180" textAnchor="end" fontSize="11" fill="hsl(var(--muted-foreground))">30M</text>
                <text x="36" y="262" textAnchor="end" fontSize="11" fill="hsl(var(--muted-foreground))">0</text>

                {OTHER_PLAYER_DOTS.map((d, i) => (
                  <circle key={i} cx={d.cx} cy={d.cy} r="6" fill="hsl(var(--field))" stroke="hsl(var(--card))" strokeWidth="2">
                    <title>Another player · {d.score}</title>
                  </circle>
                ))}

                <polyline
                  points={YOUR_DOTS.map(d => `${d.cx},${d.cy}`).join(' ') + ' 581.28,31.13'}
                  fill="none" stroke="hsl(var(--username))" strokeWidth="2" strokeLinecap="round" opacity="0.6"
                />
                {YOUR_DOTS.map((d, i) => (
                  <circle key={i} cx={d.cx} cy={d.cy} r="6" fill="hsl(var(--username))" stroke="hsl(var(--card))" strokeWidth="2">
                    <title>You · {d.score}</title>
                  </circle>
                ))}
                <circle cx="581.28" cy="31.13" r="7" fill="hsl(var(--username))" stroke="hsl(var(--card))" strokeWidth="2">
                  <title>You · 83,000,000 — personal best</title>
                </circle>
                <text x="560" y="20" textAnchor="end" fontSize="11" fontWeight="700" fill="hsl(var(--username))">
                  Personal best · 83,000,000
                </text>
              </svg>
            </div>
            <p className="mt-3 text-sm text-muted-foreground text-center">
              Full score history by machine — yours and everyone else's who dropped a coin in.
            </p>
          </div>

          <div className="flex justify-center gap-4 flex-wrap">
            <Link href="/sign-up" className="px-5 py-3 rounded-lg bg-primary text-white text-sm font-bold uppercase tracking-wider hover:opacity-90 transition-opacity">
              Start Tracking
            </Link>
            <Link href="/sign-in" className="px-5 py-2.5 rounded-lg border border-white/15 text-sm font-bold uppercase tracking-wider hover:border-white/40 hover:bg-white/5 transition-colors">
              Sign In
            </Link>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Or{' '}
            <button onClick={handleGuest} className="underline underline-offset-2 text-white hover:text-primary transition-colors">
              continue as a guest
            </button>{' '}
            to browse first.
          </p>
        </div>
      </section>

      <footer className="border-t border-white/10 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between text-sm text-muted-foreground">
          <span>TILT<span className="text-primary font-bold">TRACK</span></span>
          <span>Every score remembered.</span>
        </div>
      </footer>
    </div>
  );
}
