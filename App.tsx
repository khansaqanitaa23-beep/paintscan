import Analyzer from '@/sections/Analyzer';
import HowItWorks from '@/sections/HowItWorks';

export default function App() {
  return (
    <div className="min-h-screen bg-background">
      {/* header */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center gap-4 px-4 sm:px-6 lg:px-10">
          <a href="#" className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-primary">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" strokeWidth="2.4">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.3-4.3" />
              </svg>
            </span>
            <span className="font-display text-[15px] font-bold tracking-tight">Why Is My Paint Degrading?</span>
          </a>
          <span className="hidden font-mono2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground sm:block">
            Surface degradation analyzer
          </span>
          <nav className="ml-auto flex items-center gap-1">
            <a
              href="#method"
              className="grid min-h-[44px] place-items-center rounded-md px-2 font-mono2 text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground sm:px-3 sm:text-[11px]"
            >
              Method
            </a>
            <a
              href="/paint_degradation_pipeline.py"
              download
              className="grid min-h-[44px] place-items-center rounded-md px-2 font-mono2 text-[10px] uppercase tracking-wider text-primary transition-colors hover:bg-accent sm:px-3 sm:text-[11px]"
            >
              Python&nbsp;↓
            </a>
          </nav>
        </div>
      </header>

      {/* hero strip */}
      <div className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-12 sm:px-6 sm:pt-16 lg:px-10">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <span className="label-tech">Computer vision · segmentation · measurement</span>
            <h1 className="mt-3 font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
              How much of this wall is <span className="text-[#f0b429]">mold</span>,
              {' '}<span className="text-[#38bdf8]">cracked</span> or{' '}
              <span className="text-[#fb7185]">peeling</span>?
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Upload inspection photos and get exact surface percentages in seconds —
              segmented pixel-by-pixel with color clustering and morphological crack
              extraction. No training data, no cloud upload, no install.
            </p>
          </div>
          <div className="flex gap-8 border-l border-border pl-6">
            {[
              ['3', 'defect classes'],
              ['5', 'color clusters'],
              ['100%', 'in-browser'],
            ].map(([v, l]) => (
              <div key={l}>
                <div className="font-display text-2xl font-bold text-primary">{v}</div>
                <div className="label-tech mt-1">{l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Analyzer />
      <HowItWorks />

      {/* footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-3 px-4 py-6 sm:px-6 lg:px-10">
          <span className="font-mono2 text-[11px] text-muted-foreground">
            Why Is My Paint Degrading? — CV pipeline for paint degradation & mold measurement
          </span>
          <span className="font-mono2 text-[11px] text-muted-foreground/60">
            k-means · CIE L*a*b* · black-hat morphology · connected components
          </span>
        </div>
      </footer>
    </div>
  );
}
