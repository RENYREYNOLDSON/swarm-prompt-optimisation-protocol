import { SignInButton, SignUpButton } from '@clerk/clerk-react'
import { ArrowRight, Bird, Bot, Bug, Fish, GitCompare, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ThemeToggle } from '@/components/theme-toggle'
import { SwarmBackground } from '@/components/swarm-background'
import { Typewriter } from '@/components/typewriter'
import { cn } from '@/lib/utils'

function WhaleIcon({ className, strokeWidth = 1.25 }: { className?: string; strokeWidth?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 13c0-3.5 3.5-6 8-6 5 0 9 3 10 6 0 1-1 2-2 2-.8 0-1.5-.5-2-1l-3 3-2-3c-3 1-9-.2-9-1z" />
      <path d="M21 7l2-3-3 1" />
      <circle cx="9.5" cy="11.5" r="0.6" fill="currentColor" />
    </svg>
  )
}

const swarmAlgos = [
  {
    icon: Bug,
    title: 'Ant',
    body: 'Ant Colony Optimization — agents lay pheromone trails; shorter paths attract more traffic, reinforcing the optimum.',
    accent: 'from-amber-500/30 to-orange-500/10',
  },
  {
    icon: Bird,
    title: 'Bird',
    body: 'Particle Swarm Optimization — particles update velocity from personal and global bests, flocking toward strong solutions.',
    accent: 'from-sky-500/30 to-indigo-500/10',
  },
  {
    icon: Fish,
    title: 'Fish',
    body: 'Fish Swarm Algorithm — schooling, foraging and following behaviours produce robust exploration of the search space.',
    accent: 'from-emerald-500/30 to-teal-500/10',
  },
  {
    icon: WhaleIcon,
    title: 'Whale',
    body: 'Whale Optimization Algorithm — humpback hunting strategy: spiral encirclement of prey balances exploration with exploitation.',
    accent: 'from-blue-500/30 to-cyan-500/10',
  },
]

const features = [
  {
    icon: Bot,
    title: 'Swarm exploration',
    body: 'Hundreds of agents probe variations of your prompt in parallel — temperature, structure, framing — so you don’t have to hand-tune.',
    accent: 'from-violet-500/30 to-fuchsia-500/10',
  },
  {
    icon: GitCompare,
    title: 'Discovery & ranking',
    body: 'Candidates are scored against your evaluation criteria and a leaderboard surfaces the strongest performers across diverse inputs.',
    accent: 'from-sky-500/30 to-emerald-500/10',
  },
  {
    icon: Workflow,
    title: 'Iterative optimisation',
    body: 'Winners breed the next generation. SPOP refines, mutates and prunes until the prompt converges on a stable optimum.',
    accent: 'from-amber-500/30 to-rose-500/10',
  },
]

export default function Landing() {
  return (
    <div className="min-h-svh flex flex-col text-foreground">
      <SwarmBackground />
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="relative mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <a href="/" className="flex items-center gap-2 group">
            <img
              src="/logo.svg"
              alt="SPOP"
              className="size-8 dark:invert transition-transform group-hover:scale-110"
            />
            <span className="font-semibold tracking-tight text-lg">SPOP</span>
          </a>

          <nav className="absolute left-1/2 -translate-x-1/2 hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">
              Features
            </a>
            <a href="#how" className="hover:text-foreground transition-colors">
              How it works
            </a>
            <a
              href="https://github.com/RENYREYNOLDSON/CosPy/blob/main/CosPy%20Paper.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors"
            >
              Background
            </a>
          </nav>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <SignInButton mode="modal">
              <Button variant="ghost" size="sm" className="hidden sm:inline-flex">
                Sign in
              </Button>
            </SignInButton>
            <SignUpButton mode="modal">
              <Button size="sm">Get started</Button>
            </SignUpButton>
          </div>
        </div>
      </header>

      <main className="flex-1 relative z-10">
        <section className="px-6 pt-20 pb-24 sm:pt-28 sm:pb-32">
          <div className="mx-auto max-w-4xl flex flex-col items-center text-center gap-8">
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-700 fill-mode-both">
              <h1 className="text-6xl sm:text-8xl font-bold tracking-tighter leading-none">
                <span className="text-muted-foreground/50">[</span>
                <span className="title-shine">SPOP</span>
                <span className="text-muted-foreground/50">]</span>
              </h1>
            </div>

            <p
              className={cn(
                'max-w-2xl text-xl sm:text-2xl text-muted-foreground leading-relaxed',
                'animate-in fade-in slide-in-from-bottom-4 duration-700 fill-mode-both delay-150',
              )}
            >
              <Typewriter
                text="Swarm prompt optimisation protocol for LLM prompt discovery and optimisation."
                cps={50}
                startDelay={500}
              />
            </p>

            <div
              className={cn(
                'flex flex-col sm:flex-row gap-3',
                'animate-in fade-in slide-in-from-bottom-4 duration-700 fill-mode-both delay-300',
              )}
            >
              <SignUpButton mode="modal">
                <Button size="lg" className="text-base">
                  Get started free
                  <ArrowRight className="size-4" />
                </Button>
              </SignUpButton>
              <SignInButton mode="modal">
                <Button size="lg" variant="outline" className="text-base">
                  Sign in
                </Button>
              </SignInButton>
            </div>
          </div>
        </section>

        <section id="features" className="px-6 pb-24">
          <div className="mx-auto max-w-6xl">
            <div className="text-center mb-12 animate-in fade-in duration-700 fill-mode-both">
              <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight">
                <Typewriter text="Built for prompt engineers" cps={45} whileInView />
              </h2>
              <p className="mt-3 text-muted-foreground max-w-xl mx-auto">
                <Typewriter
                  text="Three layers working in concert to turn fuzzy intent into a production-ready prompt."
                  cps={60}
                  startDelay={350}
                  whileInView
                />
              </p>
            </div>

            <div id="how" className="grid gap-6 md:grid-cols-3">
              {features.map((f, i) => {
                const Icon = f.icon
                return (
                  <Card
                    key={f.title}
                    className={cn(
                      'group overflow-hidden transition-all duration-300',
                      'hover:-translate-y-1 hover:shadow-lg hover:border-foreground/20',
                      'animate-in fade-in slide-in-from-bottom-6 duration-700 fill-mode-both',
                    )}
                    style={{ animationDelay: `${150 + i * 120}ms` }}
                  >
                    <div
                      className={cn(
                        'relative mx-6 -mt-2 aspect-[4/3] overflow-hidden rounded-lg border bg-gradient-to-br',
                        f.accent,
                      )}
                    >
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Icon
                          className="size-14 text-foreground/40 transition-transform duration-500 group-hover:scale-110 group-hover:rotate-3"
                          strokeWidth={1.25}
                        />
                      </div>
                    </div>
                    <CardContent className="space-y-2 pt-2">
                      <h3 className="font-semibold text-lg tracking-tight">
                        {f.title}
                      </h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {f.body}
                      </p>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </div>
        </section>

        <section id="swarm-intelligence" className="px-6 pb-24">
          <div className="mx-auto max-w-6xl">
            <div className="text-center mb-12 max-w-3xl mx-auto animate-in fade-in duration-700 fill-mode-both">
              <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight">
                <Typewriter text="About swarm intelligence" cps={45} whileInView />
              </h2>
              <div className="mt-4 space-y-3 text-muted-foreground leading-relaxed">
                <p>
                  <span className="text-foreground font-medium">Emergence</span>{' '}
                  is the phenomenon where simple individual rules — followed by
                  many agents at once — produce coordinated, intelligent
                  behaviour at the group level that no single agent has
                  programmed in.
                </p>
                <p>
                  <span className="text-foreground font-medium">
                    Nature-inspired algorithms
                  </span>{' '}
                  borrow these mechanisms — pheromone trails, flocking,
                  echolocation — and apply them to optimisation problems where
                  the search space is too large for exhaustive evaluation. SPOP
                  uses these techniques to explore prompt space.
                </p>
              </div>
            </div>

            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {swarmAlgos.map((s, i) => {
                const Icon = s.icon
                return (
                  <Card
                    key={s.title}
                    className={cn(
                      'group overflow-hidden transition-all duration-300',
                      'hover:-translate-y-1 hover:shadow-lg hover:border-foreground/20',
                      'animate-in fade-in slide-in-from-bottom-6 duration-700 fill-mode-both',
                    )}
                    style={{ animationDelay: `${150 + i * 100}ms` }}
                  >
                    <div
                      className={cn(
                        'relative mx-6 -mt-2 aspect-square overflow-hidden rounded-lg border bg-gradient-to-br',
                        s.accent,
                      )}
                    >
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Icon
                          className="size-14 text-foreground/40 transition-transform duration-500 group-hover:scale-110 group-hover:rotate-3"
                          strokeWidth={1.25}
                        />
                      </div>
                    </div>
                    <CardContent className="space-y-2 pt-2">
                      <h3 className="font-semibold text-lg tracking-tight">
                        {s.title}
                      </h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {s.body}
                      </p>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t bg-background/80 backdrop-blur relative z-10">
        <div className="mx-auto max-w-6xl px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="" className="size-5 dark:invert" />
            <span>
              SPOP — Swarm Prompt Optimisation Protocol
            </span>
          </div>
          <div className="flex items-center gap-5">
            <a href="#features" className="hover:text-foreground transition-colors">
              Features
            </a>
            <a href="#how" className="hover:text-foreground transition-colors">
              How it works
            </a>
            <a
              href="https://github.com/RENYREYNOLDSON/CosPy/blob/main/CosPy%20Paper.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground transition-colors"
            >
              Background
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
