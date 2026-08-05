/**
 * storage-adapter.js — The only module in the app that touches Local Storage.
 *
 * Contract
 * --------
 * Every method is async and returns a Promise, even though Local Storage is
 * synchronous. That is deliberate: the day this is swapped for Supabase (or
 * IndexedDB), the replacement is genuinely async, and if the interface were
 * synchronous today every call site would have to change. Paying the `await`
 * cost now keeps that migration to a one-line adapter swap.
 *
 *   interface StorageAdapter {
 *     get(key)            -> Promise<any | null>
 *     set(key, value)     -> Promise<void>
 *     remove(key)         -> Promise<void>
 *     keys()              -> Promise<string[]>   // app keys, un-prefixed
 *     clear()             -> Promise<void>       // app keys only
 *     isAvailable()       -> boolean
 *   }
 *
 * Keys are namespaced (`ironlog:v1:workouts`) so the app can never collide
 * with anything else served from the same origin, and so `clear()` can wipe
 * IronLog without touching an unrelated key on that origin.
 */

export const NAMESPACE = 'ironlog';
export const STORE_VERSION = 'v1';

const PREFIX = `${NAMESPACE}:${STORE_VERSION}:`;

/** Thrown when a write fails because the browser quota is exhausted. */
export class QuotaExceededError extends Error {
  constructor(key) {
    super(
      'Storage is full. Free space by deleting old progress photos, then try again.'
    );
    this.name = 'QuotaExceededError';
    this.key = key;
  }
}

/**
 * Local Storage implementation of the adapter contract.
 */
export class LocalStorageAdapter {
  constructor(backing = safeLocalStorage()) {
    this.backing = backing;
    /**
     * In-memory fallback used when Local Storage is unavailable — Safari
     * Private Browsing and some iOS lockdown states throw on access. The app
     * stays usable for the session instead of crashing; nothing persists.
     */
    this.memory = new Map();
    this.usingMemory = this.backing === null;

    if (this.usingMemory) {
      console.warn('[storage] Local Storage unavailable — running in memory only.');
    }
  }

  isAvailable() {
    return !this.usingMemory;
  }

  async get(key) {
    const raw = this.usingMemory
      ? (this.memory.get(PREFIX + key) ?? null)
      : this.backing.getItem(PREFIX + key);

    if (raw === null || raw === undefined) return null;

    try {
      return JSON.parse(raw);
    } catch (error) {
      // A corrupt value must not take the whole app down. Log it, quarantine
      // the raw string so it can be recovered by hand, and report null.
      console.error(`[storage] "${key}" is not valid JSON; quarantining.`, error);
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.#writeRaw(`__corrupt:${key}:${stamp}`, raw);
        this.#removeRaw(key);
      } catch { /* quarantine is best-effort */ }
      return null;
    }
  }

  async set(key, value) {
    const raw = JSON.stringify(value);
    try {
      this.#writeRaw(key, raw);
    } catch (error) {
      if (isQuotaError(error)) throw new QuotaExceededError(key);
      throw error;
    }
  }

  async remove(key) {
    this.#removeRaw(key);
  }

  async keys() {
    const all = this.usingMemory
      ? [...this.memory.keys()]
      : Object.keys(this.backing);

    return all
      .filter((key) => key.startsWith(PREFIX))
      .map((key) => key.slice(PREFIX.length));
  }

  async clear() {
    for (const key of await this.keys()) this.#removeRaw(key);
  }

  /** Approximate bytes used by this app's keys — surfaced in Settings. */
  async usageBytes() {
    let total = 0;
    for (const key of await this.keys()) {
      const raw = this.usingMemory
        ? this.memory.get(PREFIX + key)
        : this.backing.getItem(PREFIX + key);
      // UTF-16 code units: two bytes each, which is how browsers bill quota.
      if (raw) total += (PREFIX.length + key.length + raw.length) * 2;
    }
    return total;
  }

  #writeRaw(key, raw) {
    if (this.usingMemory) this.memory.set(PREFIX + key, raw);
    else this.backing.setItem(PREFIX + key, raw);
  }

  #removeRaw(key) {
    if (this.usingMemory) this.memory.delete(PREFIX + key);
    else this.backing.removeItem(PREFIX + key);
  }
}

/**
 * Probe Local Storage with a real write. Merely checking `'localStorage' in
 * window` is not enough: Safari Private Browsing exposes the object and
 * throws on `setItem`.
 */
function safeLocalStorage() {
  try {
    const probe = `${PREFIX}__probe`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

function isQuotaError(error) {
  return (
    error &&
    (error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014)
  );
}

/**
 * The adapter instance the app runs on. Swapping backends later means
 * changing this one line — no page or service needs to know.
 *
 *   export const storage = new SupabaseAdapter(client);
 */
export const storage = new LocalStorageAdapter();
