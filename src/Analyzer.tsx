import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';
import {
  extractFeatures, classify,
  type AnalysisResult, type Features, type Sensitivity, type DefectClass,
} from '@/lib/analyze';
import { SAMPLES, renderSample, type SampleDef } from '@/lib/samples';
import { loadHistory, saveHistory, clearHistory, makeThumb, type HistoryEntry } from '@/lib/store';

// ---------------------------------------------------------------------------

interface PhotoItem {
  id: string;
  name: string;
  thumb: string;
  features: Features | null;
  result: AnalysisResult | null;
  status: 'analyzing' | 'ready' | 'stale';
}

type View = 'original' | 'overlay' | DefectClass;

const CLASSES: { key: DefectClass; label: string; short: string; color: string; desc: string }[] = [
  { key: 'mold', label: 'Fungal growth / mold', short: 'Mold', color: '#f0b429', desc: 'Dark, green-shifted clusters' },
  { key: 'crack', label: 'Micro-cracking', short: 'Cracks', color: '#38bdf8', desc: 'Thin dark elongated structures' },
  { key: 'peel', label: 'Paint peeling', short: 'Peeling', color: '#fb7185', desc: 'Bright low-chroma exposure' },
];

const VIEWS: { key: View; label: string }[] = [
  { key: 'original', label: 'Original' },
  { key: 'overlay', label: 'Overlay' },
  { key: 'mold', label: 'Mold mask' },
  { key: 'crack', label: 'Crack mask' },
  { key: 'peel', label: 'Peel mask' },
];

const DEFAULT_SENS: Sensitivity = { mold: 55, crack: 55, peel: 55 };

let uid = 0;
const nextId = () => `p${++uid}-${Date.now()}`;

// ---------------------------------------------------------------------------

export default function Analyzer() {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sens, setSens] = useState<Sensitivity>(DEFAULT_SENS);
  const [view, setView] = useState<View>('overlay');
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const sensTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected = photos.find((p) => p.id === selectedId) ?? null;

  // --- ingestion ----------------------------------------------------------

  const analyzeSource = useCallback((name: string, source: HTMLImageElement | HTMLCanvasElement, thumb: string) => {
    const id = nextId();
    setPhotos((prev) => [...prev, { id, name, thumb, features: null, result: null, status: 'analyzing' }]);
    setSelectedId(id);
    // let the UI paint the "analyzing" state before the heavy sync work
    setTimeout(() => {
      const features = extractFeatures(source);
      const result = classify(features, DEFAULT_SENS);
      setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, features, result, status: 'ready' } : p)));
    }, 40);
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/')) return;
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const thumbC = document.createElement('canvas');
        const s = Math.min(1, 96 / img.width);
        thumbC.width = Math.max(1, Math.round(img.width * s));
        thumbC.height = Math.max(1, Math.round(img.height * s));
        thumbC.getContext('2d')!.drawImage(img, 0, 0, thumbC.width, thumbC.height);
        analyzeSource(file.name, img, thumbC.toDataURL('image/jpeg', 0.7));
        URL.revokeObjectURL(url);
      };
      img.src = url;
    });
  }, [analyzeSource]);

  const addSample = useCallback((def: SampleDef) => {
    const canvas = renderSample(def);
    const thumbC = document.createElement('canvas');
    thumbC.width = 96; thumbC.height = Math.round((canvas.height / canvas.width) * 96);
    thumbC.getContext('2d')!.drawImage(canvas, 0, 0, thumbC.width, thumbC.height);
    analyzeSource(def.name, canvas, thumbC.toDataURL('image/jpeg', 0.7));
  }, [analyzeSource]);

  // --- sensitivity re-classification (fast path, debounced) ----------------

  useEffect(() => {
    if (sensTimer.current) clearTimeout(sensTimer.current);
    sensTimer.current = setTimeout(() => {
      setPhotos((prev) => {
        const sel = prev.find((p) => p.id === selectedId);
        if (!sel || !sel.features) return prev;
        return prev.map((p) =>
          p.id === selectedId ? { ...p, result: classify(p.features!, sens), status: 'ready' } : p,
        );
      });
    }, 70);
    return () => { if (sensTimer.current) clearTimeout(sensTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sens]);

  // selecting a photo that was analyzed with older sensitivity -> refresh
  useEffect(() => {
    setPhotos((prev) => {
      const sel = prev.find((p) => p.id === selectedId);
      if (!sel || !sel.features || sel.status !== 'stale') return prev;
      return prev.map((p) =>
        p.id === selectedId ? { ...p, result: classify(p.features!, sens), status: 'ready' } : p,
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // mark others stale when sensitivity changes
  useEffect(() => {
    setPhotos((prev) => prev.map((p) => (p.id === selectedId || !p.result ? p : { ...p, status: 'stale' })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sens]);

  // --- history --------------------------------------------------------------

  const recordToHistory = useCallback(async () => {
    const ready = photos.filter((p) => p.result);
    if (ready.length === 0) return;
    const entries: HistoryEntry[] = [];
    for (const p of ready) {
      const thumb = p.result ? await makeThumb(p.result.overlayUrl) : p.thumb;
      entries.push({
        id: p.id, name: p.name, date: Date.now(), thumb,
        score: p.result!.score, severity: p.result!.severity, stats: p.result!.stats,
      });
    }
    setHistory((prev) => {
      const next = [...entries, ...prev.filter((h) => !entries.some((e) => e.id === h.id))];
      saveHistory(next);
      return next;
    });
  }, [photos]);

  // --- export ---------------------------------------------------------------

  const exportCsv = useCallback(() => {
    const ready = photos.filter((p) => p.result);
    if (!ready.length) return;
    const head = 'photo,mold_pct,crack_pct,peel_pct,intact_pct,mold_regions,crack_regions,peel_regions,degradation_score,severity';
    const rows = ready.map((p) => {
      const r = p.result!;
      return [
        `"${p.name.replace(/"/g, '""')}"`,
        r.stats.mold.pct.toFixed(2), r.stats.crack.pct.toFixed(2), r.stats.peel.pct.toFixed(2),
        r.stats.intact.pct.toFixed(2),
        r.stats.mold.regions, r.stats.crack.regions, r.stats.peel.regions,
        r.score.toFixed(1), `"${r.severity}"`,
      ].join(',');
    });
    const avg = (fn: (r: AnalysisResult) => number) =>
      (ready.reduce((s, p) => s + fn(p.result!), 0) / ready.length).toFixed(2);
    rows.push([
      '"BATCH MEAN"', avg((r) => r.stats.mold.pct), avg((r) => r.stats.crack.pct),
      avg((r) => r.stats.peel.pct), avg((r) => r.stats.intact.pct), '', '', '',
      avg((r) => r.score), '""',
    ].join(','));
    const blob = new Blob([[head, ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'paintscan-report.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }, [photos]);

  // --- derived ---------------------------------------------------------------

  const batch = useMemo(() => {
    const ready = photos.filter((p) => p.result);
    if (!ready.length) return null;
    const mean = (fn: (r: AnalysisResult) => number) => ready.reduce((s, p) => s + fn(p.result!), 0) / ready.length;
    return {
      count: ready.length,
      mold: mean((r) => r.stats.mold.pct),
      crack: mean((r) => r.stats.crack.pct),
      peel: mean((r) => r.stats.peel.pct),
      score: mean((r) => r.score),
    };
  }, [photos]);

  const currentImage = selected?.result
    ? view === 'original' ? selected.result.originalUrl
    : view === 'overlay' ? selected.result.overlayUrl
    : selected.result.maskUrls[view]
    : null;

  // --- render -----------------------------------------------------------------

  return (
    <section id="analyzer" className="mx-auto w-full max-w-[1400px] px-4 sm:px-6 lg:px-10 pb-24">
      {/* batch summary strip */}
      {batch && (
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-card px-4 py-3">
          <span className="label-tech">Batch · {batch.count} photo{batch.count > 1 ? 's' : ''}</span>
          {CLASSES.map((c) => (
            <span key={c.key} className="font-mono2 text-xs text-muted-foreground">
              <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: c.color }} />
              {c.short} <span className="text-foreground font-semibold">{batch[c.key].toFixed(1)}%</span>
            </span>
          ))}
          <span className="font-mono2 text-xs text-muted-foreground">
            Mean score <span className="text-primary font-semibold">{batch.score.toFixed(1)}</span>
          </span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" className="h-9 font-mono2 text-xs" onClick={exportCsv}>
              Export CSV
            </Button>
            <Button size="sm" variant="outline" className="h-9 font-mono2 text-xs" onClick={recordToHistory}>
              Save to history
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        {/* ------------------------------ left: workspace ------------------------------ */}
        <div className="min-w-0">
          {photos.length === 0 ? (
            <DropZone
              dragOver={dragOver}
              setDragOver={setDragOver}
              onFiles={addFiles}
              onSample={addSample}
              onBrowse={() => fileRef.current?.click()}
            />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              {/* photo strip */}
              <div className="flex items-center gap-2 overflow-x-auto border-b border-border px-3 py-2.5">
                {photos.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    className={`relative h-14 w-14 shrink-0 overflow-hidden rounded-md border transition-colors ${
                      p.id === selectedId ? 'border-primary' : 'border-border hover:border-muted-foreground/50'
                    }`}
                    title={p.name}
                  >
                    <img src={p.thumb} alt={p.name} className="h-full w-full object-cover" />
                    {p.status === 'analyzing' && (
                      <span className="absolute inset-0 grid place-items-center bg-black/60">
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                      </span>
                    )}
                  </button>
                ))}
                <button
                  onClick={() => fileRef.current?.click()}
                  className="grid h-14 w-14 shrink-0 place-items-center rounded-md border border-dashed border-muted-foreground/40 text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                  title="Add photo"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              </div>

              {/* view switcher */}
              <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2">
                {VIEWS.map((v) => (
                  <button
                    key={v.key}
                    onClick={() => setView(v.key)}
                    className={`min-h-[36px] rounded-md px-3 font-mono2 text-[11px] uppercase tracking-wider transition-colors ${
                      view === v.key
                        ? 'bg-primary text-primary-foreground font-semibold'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    }`}
                  >
                    {v.label}
                  </button>
                ))}
                <span className="ml-auto hidden font-mono2 text-[11px] text-muted-foreground sm:block">
                  {selected?.result ? `${selected.result.width}×${selected.result.height}px analysis grid` : ''}
                </span>
              </div>

              {/* canvas */}
              <div className="scan-frame relative grid min-h-[280px] place-items-center bg-black/40 p-3 sm:p-5">
                {selected?.status === 'analyzing' && (
                  <div className="flex flex-col items-center gap-3 py-16">
                    <span className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    <span className="label-tech">Extracting features…</span>
                  </div>
                )}
                {currentImage && (
                  <img
                    src={currentImage}
                    alt={`${view} view of ${selected?.name}`}
                    className="max-h-[62vh] w-auto max-w-full rounded-sm"
                    style={{ imageRendering: view === 'original' || view === 'overlay' ? 'auto' : 'pixelated' }}
                  />
                )}
              </div>

              {/* legend */}
              {selected?.result && (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border px-4 py-2.5">
                  {CLASSES.map((c) => (
                    <span key={c.key} className="flex items-center gap-1.5 font-mono2 text-[11px] text-muted-foreground">
                      <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: c.color }} />
                      {c.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* samples row under workspace */}
          {photos.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="label-tech mr-1">No photo handy? Try a synthetic sample:</span>
              {SAMPLES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => addSample(s)}
                  className="min-h-[44px] rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:border-primary/60"
                >
                  <span className="block text-xs font-medium">{s.name}</span>
                  <span className="block font-mono2 text-[10px] text-muted-foreground">{s.defects}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ------------------------------ right: results ------------------------------ */}
        <aside className="min-w-0">
          <div className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-5 py-4">
              <span className="label-tech">Surface analysis</span>
              <p className="mt-1 truncate text-sm font-medium">{selected?.name ?? '—'}</p>
            </div>

            {selected?.result ? (
              <ResultsPanel result={selected.result} />
            ) : (
              <div className="px-5 py-14 text-center">
                <p className="font-mono2 text-xs text-muted-foreground">
                  {selected ? 'Analyzing…' : 'Upload a photo or load a sample\nto see measurements here.'}
                </p>
              </div>
            )}

            <Separator />

            {/* sensitivity */}
            <div className="space-y-5 px-5 py-5">
              <div className="flex items-baseline justify-between">
                <span className="label-tech">Detection sensitivity</span>
                <button
                  onClick={() => setSens(DEFAULT_SENS)}
                  className="min-h-[32px] font-mono2 text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                >
                  reset
                </button>
              </div>
              {CLASSES.map((c) => (
                <div key={c.key}>
                  <div className="mb-2 flex items-center justify-between">
                    <label className="flex items-center gap-2 text-xs font-medium">
                      <span className="h-2 w-2 rounded-full" style={{ background: c.color }} />
                      {c.short}
                    </label>
                    <span className="font-mono2 text-xs text-muted-foreground">{sens[c.key]}</span>
                  </div>
                  <Slider
                    value={[sens[c.key]]}
                    min={0} max={100} step={1}
                    onValueChange={([v]) => setSens((s) => ({ ...s, [c.key]: v }))}
                    aria-label={`${c.label} sensitivity`}
                    className="h-6"
                  />
                </div>
              ))}
              <p className="font-mono2 text-[10px] leading-relaxed text-muted-foreground/70">
                Sliders re-classify cached features in real time — clustering and crack extraction are not re-run.
              </p>
            </div>
          </div>
        </aside>
      </div>

      {/* hidden file input */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }}
      />

      {/* history */}
      {history.length > 0 && (
        <div className="mt-14">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold">Analysis history</h2>
            <button
              onClick={() => { clearHistory(); setHistory([]); }}
              className="min-h-[36px] font-mono2 text-[11px] text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
            >
              clear
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {history.map((h) => (
              <div key={h.id} className="overflow-hidden rounded-lg border border-border bg-card">
                {h.thumb && <img src={h.thumb} alt={h.name} className="h-20 w-full object-cover" />}
                <div className="p-2.5">
                  <p className="truncate text-xs font-medium">{h.name}</p>
                  <p className="font-mono2 text-[10px] text-muted-foreground">
                    {new Date(h.date).toLocaleDateString()} · score {h.score.toFixed(1)}
                  </p>
                  <p className="mt-0.5 font-mono2 text-[10px] text-muted-foreground/80">
                    M {h.stats.mold.pct.toFixed(1)}% · C {h.stats.crack.pct.toFixed(1)}% · P {h.stats.peel.pct.toFixed(1)}%
                  </p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 font-mono2 text-[10px] text-muted-foreground/70">
            History is stored in this browser only (localStorage) — it does not sync across devices.
          </p>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Results readout
// ---------------------------------------------------------------------------

function ResultsPanel({ result }: { result: AnalysisResult }) {
  const r = result;
  const scoreColor = r.score < 10 ? '#00d9a3' : r.score < 25 ? '#f0b429' : r.score < 50 ? '#fb923c' : '#fb7185';
  return (
    <div className="px-5 py-5">
      {/* score */}
      <div className="flex items-end justify-between">
        <div>
          <span className="label-tech">Degradation index</span>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="font-display text-5xl font-bold leading-none" style={{ color: scoreColor }}>
              {r.score.toFixed(1)}
            </span>
            <span className="font-mono2 text-sm text-muted-foreground">/100</span>
          </div>
        </div>
        <span
          className="rounded-md border px-2 py-1 font-mono2 text-[10px] uppercase tracking-wider"
          style={{ color: scoreColor, borderColor: `${scoreColor}55`, background: `${scoreColor}11` }}
        >
          {r.severity}
        </span>
      </div>

      <div className="mt-6 space-y-4">
        {CLASSES.map((c) => {
          const s = r.stats[c.key];
          return (
            <div key={c.key}>
              <div className="flex items-baseline justify-between">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: c.color }} />
                  {c.label}
                </span>
                <span className="font-mono2 text-xl font-semibold" style={{ color: c.color }}>
                  {s.pct.toFixed(2)}<span className="text-xs text-muted-foreground">%</span>
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{ width: `${Math.min(100, s.pct)}%`, background: c.color }}
                />
              </div>
              <p className="mt-1 font-mono2 text-[10px] text-muted-foreground">
                {s.regions} region{s.regions === 1 ? '' : 's'} · largest {s.largestPct.toFixed(2)}% · {c.desc}
              </p>
            </div>
          );
        })}

        <Separator />
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted-foreground">Intact surface</span>
          <span className="font-mono2 text-lg font-semibold text-primary">
            {r.stats.intact.pct.toFixed(2)}<span className="text-xs text-muted-foreground">%</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty-state drop zone
// ---------------------------------------------------------------------------

function DropZone({
  dragOver, setDragOver, onFiles, onSample, onBrowse,
}: {
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
  onFiles: (f: FileList | File[]) => void;
  onSample: (s: SampleDef) => void;
  onBrowse: () => void;
}) {
  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); onFiles(e.dataTransfer.files); }}
        className={`grid place-items-center rounded-lg border border-dashed px-6 py-16 text-center transition-colors sm:py-24 ${
          dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/30 bg-card'
        }`}
      >
        <div className="mx-auto max-w-md">
          <div className="mx-auto mb-5 grid h-14 w-14 place-items-center rounded-xl border border-border bg-background">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M17 8l-5-5-5 5" />
              <path d="M12 3v12" />
            </svg>
          </div>
          <p className="font-display text-lg font-semibold">Drop surface photos here</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Walls, ceilings, facades — JPG or PNG. Batch upload supported.
            Everything runs locally in your browser; photos never leave the device.
          </p>
          <Button onClick={onBrowse} className="mt-5 h-11 px-6 font-mono2 text-xs uppercase tracking-wider">
            Browse files
          </Button>
        </div>
      </div>

      <div className="mt-6">
        <p className="label-tech mb-3">Or start with a synthetic sample</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {SAMPLES.map((s) => (
            <SampleCard key={s.id} def={s} onPick={() => onSample(s)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SampleCard({ def, onPick }: { def: SampleDef; onPick: () => void }) {
  const [url, setUrl] = useState<string>('');
  useEffect(() => {
    const c = renderSample(def);
    const t = document.createElement('canvas');
    t.width = 320; t.height = Math.round((c.height / c.width) * 320);
    t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
    setUrl(t.toDataURL('image/jpeg', 0.8));
  }, [def]);
  return (
    <button
      onClick={onPick}
      className="group overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-primary/60"
    >
      <div className="relative">
        {url && <img src={url} alt={def.name} className="aspect-[4/3] w-full object-cover" />}
        <span className="absolute inset-0 grid place-items-center bg-black/55 opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100">
          <span className="rounded-md bg-primary px-3 py-2 font-mono2 text-[11px] font-semibold uppercase tracking-wider text-primary-foreground">
            Analyze
          </span>
        </span>
      </div>
      <div className="p-3">
        <p className="text-sm font-medium">{def.name}</p>
        <p className="font-mono2 text-[10px] text-muted-foreground">{def.defects}</p>
      </div>
    </button>
  );
}
