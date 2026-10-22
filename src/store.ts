/**
 * store.ts — analysis history persisted in the browser (localStorage).
 */
import type { ClassStats, DefectClass } from './analyze';

export interface HistoryEntry {
  id: string;
  name: string;
  date: number;
  thumb: string; // small data-url
  score: number;
  severity: string;
  stats: Record<DefectClass | 'intact', ClassStats>;
}

const KEY = 'paintscan-history-v1';
const MAX_ENTRIES = 12;

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // storage quota exceeded — drop oldest and retry once
    try {
      localStorage.setItem(KEY, JSON.stringify(entries.slice(0, 4)));
    } catch { /* give up silently */ }
  }
}

export function clearHistory() {
  try { localStorage.removeItem(KEY); } catch { /* noop */ }
}

export function makeThumb(dataUrl: string, maxW = 96): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}
