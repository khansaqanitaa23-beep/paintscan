const STEPS = [
  {
    n: '01',
    title: 'Resize & color conversion',
    body: 'The photo is downscaled to a ~480px analysis grid, then converted from RGB into two spaces: CIE L*a*b* — where distances match human color perception — and grayscale luminance for structural analysis.',
    code: 'cvtColor(img, COLOR_RGB2Lab)',
  },
  {
    n: '02',
    title: 'K-means color clustering',
    body: 'Every pixel is assigned to one of 5 color clusters (k-means++ seeding, Lloyd iterations). The dominant cluster is the reference paint; the others are candidate defect regions. This is the "lightweight model" — no training data needed, it adapts to each photo.',
    code: 'kmeans(Lab_pixels, K=5)',
  },
  {
    n: '03',
    title: 'Black-hat crack extraction',
    body: 'A morphological black-hat transform — closing(gray) minus gray — isolates structures darker than their surroundings. Connected-component shape filtering (elongation, fill ratio) keeps thin crack networks and rejects blotches and shadows.',
    code: 'morphologyEx(gray, MORPH_BLACKHAT, k)',
  },
  {
    n: '04',
    title: 'Classification & measurement',
    body: 'Clusters are scored against the reference paint: darker and green-shifted → mold; brighter and desaturated → exposed substrate (peeling). Connected components count regions, and surface percentages are pixel counts over the total grid.',
    code: 'connectedComponentsWithStats(mask)',
  },
];

export default function HowItWorks() {
  return (
    <section id="method" className="border-t border-border bg-[#0d0d0d]">
      <div className="mx-auto w-full max-w-[1400px] px-4 py-20 sm:px-6 lg:px-10">
        <span className="label-tech">Methodology</span>
        <h2 className="mt-2 max-w-2xl font-display text-3xl font-bold tracking-tight sm:text-4xl">
          A classical vision pipeline — no training data required
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Instead of a heavy neural network, PaintScan uses unsupervised color clustering plus
          morphological filtering. It runs fully in the browser, needs zero labeled examples,
          and every step maps one-to-one to an OpenCV call — the same pipeline is available
          as a Python script for your IoT device or batch processing.
        </p>

        <div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
          {STEPS.map((s) => (
            <div key={s.n} className="bg-card p-6">
              <span className="font-mono2 text-xs font-semibold text-primary">{s.n}</span>
              <h3 className="mt-3 font-display text-base font-semibold">{s.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{s.body}</p>
              <code className="mt-4 block rounded-md border border-border bg-background px-3 py-2 font-mono2 text-[11px] text-primary/90">
                {s.code}
              </code>
            </div>
          ))}
        </div>

        {/* honest limitations */}
        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-6">
            <h3 className="font-mono2 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
              When it works well
            </h3>
            <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
              {[
                'Evenly lit photos taken straight-on to the surface',
                'Mold darker or greener than the surrounding paint',
                'Peeling that exposes bright plaster, concrete or wood',
                'Cracks that contrast with the paint around them',
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-primary" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border border-border bg-card p-6">
            <h3 className="font-mono2 text-xs font-semibold uppercase tracking-[0.14em] text-[#f0b429]">
              Known limitations
            </h3>
            <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
              {[
                'Strong shadows can be misread as mold — lower the mold sensitivity',
                'Dark paint colors shrink the mold/paint contrast margin',
                'Cracks wider than the structuring element count as peeling',
                'It estimates surface coverage, not depth or structural damage',
              ].map((t) => (
                <li key={t} className="flex gap-2.5">
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#f0b429]" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
