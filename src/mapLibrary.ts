// Saved copies of maps and automatic backups, kept in browser storage beside the working map.
// Needs no WebGL or DOM beyond a Storage, so tests can pass their own.
import type { SaveData } from './saveData';
import { parseSave } from './saveData';

const INDEX_KEY = 'vibe-train-sim/library';
const COPY_PREFIX = 'vibe-train-sim/copy/';
const BACKUP_PREFIX = 'vibe-train-sim/auto-backup/';
/** Backups kept before a map is replaced. Few, because each can be hundreds of kilobytes. */
export const BACKUP_COUNT = 3;

export interface MapEntry {
  id: string;
  name: string;
  /** Milliseconds since 1970, from Date.now(). */
  savedAt: number;
  kind: 'copy' | 'backup';
}

interface Index {
  copies: MapEntry[];
  backups: MapEntry[];
}

export type LibraryResult = { ok: true } | { ok: false; reason: string };

/** A Storage kept in memory, optionally with a size limit. Used when the browser blocks storage, and by tests. */
export class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  constructor(private limit = Infinity) {}
  get length() {
    return this.items.size;
  }
  private used() {
    let n = 0;
    for (const [k, v] of this.items) n += k.length + v.length;
    return n;
  }
  clear() {
    this.items.clear();
  }
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.items.delete(k);
  }
  setItem(k: string, v: string) {
    const before = this.items.get(k);
    this.items.set(k, v);
    if (this.used() > this.limit) {
      if (before === undefined) this.items.delete(k);
      else this.items.set(k, before);
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    }
  }
}

/** localStorage, or a store that lasts only for this page when the browser blocks it. */
export function browserStorage(): Storage {
  try {
    const s = globalThis.localStorage;
    if (s) return s;
  } catch {
    /* Reading localStorage throws when site data is blocked. */
  }
  return new MemoryStorage();
}

const FULL = 'browser storage is full or blocked. Delete a saved copy or export the map to a file';

export class MapLibrary {
  constructor(
    private store: Storage,
    private now: () => number = Date.now,
  ) {}

  private readIndex(): Index {
    try {
      const raw = JSON.parse(this.store.getItem(INDEX_KEY) ?? 'null') as Partial<Index> | null;
      return { copies: raw?.copies ?? [], backups: raw?.backups ?? [] };
    } catch {
      return { copies: [], backups: [] };
    }
  }

  private writeIndex(index: Index) {
    this.store.setItem(INDEX_KEY, JSON.stringify(index));
  }

  /** Saved copies, newest first. */
  copies(): MapEntry[] {
    return [...this.readIndex().copies].sort((a, b) => b.savedAt - a.savedAt);
  }

  /** Automatic backups, newest first. */
  backups(): MapEntry[] {
    return [...this.readIndex().backups].sort((a, b) => b.savedAt - a.savedAt);
  }

  /** Saves a named copy. A copy with the same name is replaced. */
  saveCopy(name: string, data: SaveData): LibraryResult {
    const clean = name.trim().slice(0, 40) || 'Untitled map';
    const index = this.readIndex();
    const existing = index.copies.find((c) => c.name === clean);
    const entry: MapEntry = { id: existing?.id ?? this.newId('c'), name: clean, savedAt: this.now(), kind: 'copy' };
    try {
      this.store.setItem(COPY_PREFIX + entry.id, JSON.stringify(data));
      index.copies = [...index.copies.filter((c) => c.id !== entry.id), entry];
      this.writeIndex(index);
      return { ok: true };
    } catch {
      return { ok: false, reason: FULL };
    }
  }

  /**
   * Keeps the map about to be replaced as a backup, dropping the oldest beyond BACKUP_COUNT.
   * If storage is full it drops older backups to make room, and gives up quietly if even that fails.
   */
  backup(name: string, data: SaveData): boolean {
    const index = this.readIndex();
    const entry: MapEntry = { id: this.newId('b'), name, savedAt: this.now(), kind: 'backup' };
    const json = JSON.stringify(data);
    let backups = [...index.backups].sort((a, b) => a.savedAt - b.savedAt);
    while (backups.length >= BACKUP_COUNT) backups = this.dropOldest(backups);
    for (;;) {
      try {
        this.store.setItem(BACKUP_PREFIX + entry.id, json);
        this.writeIndex({ ...index, backups: [...backups, entry] });
        return true;
      } catch {
        if (!backups.length) {
          this.writeIndexQuietly({ ...index, backups });
          return false;
        }
        backups = this.dropOldest(backups);
      }
    }
  }

  private dropOldest(sortedOldestFirst: MapEntry[]) {
    const [oldest, ...rest] = sortedOldestFirst;
    this.removeQuietly(BACKUP_PREFIX + oldest.id);
    return rest;
  }

  /** Reads and validates an entry. Returns the reason if it can't be used. */
  load(entry: MapEntry): { ok: true; data: SaveData } | { ok: false; reason: string } {
    let raw: string | null = null;
    try {
      raw = this.store.getItem(this.keyOf(entry));
    } catch {
      return { ok: false, reason: 'browser storage is blocked' };
    }
    if (raw === null) return { ok: false, reason: 'it is no longer in browser storage' };
    return parseSave(raw);
  }

  remove(entry: MapEntry) {
    const index = this.readIndex();
    this.removeQuietly(this.keyOf(entry));
    if (entry.kind === 'copy') index.copies = index.copies.filter((c) => c.id !== entry.id);
    else index.backups = index.backups.filter((c) => c.id !== entry.id);
    this.writeIndexQuietly(index);
  }

  private keyOf(entry: MapEntry) {
    return (entry.kind === 'copy' ? COPY_PREFIX : BACKUP_PREFIX) + entry.id;
  }

  private newId(prefix: string) {
    return `${prefix}${this.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  private removeQuietly(key: string) {
    try {
      this.store.removeItem(key);
    } catch {
      /* Blocked storage: nothing to remove. */
    }
  }

  private writeIndexQuietly(index: Index) {
    try {
      this.writeIndex(index);
    } catch {
      /* The index is tiny; if even this fails, storage is blocked. */
    }
  }
}
