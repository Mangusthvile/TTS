/**
 * LRU cache helpers for Map-based caches with size limits.
 * Evicts oldest (first) entries when capacity is exceeded.
 */

export const CHAPTER_TEXT_REF_CACHE_MAX = 50;

/**
 * Get value from cache; moves to end (most recently used) if found.
 */
export function lruMapGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  const v = map.get(key);
  if (v !== undefined) {
    map.delete(key);
    map.set(key, v);
  }
  return v;
}

/**
 * Set value in cache; evicts oldest entries when over capacity.
 */
export function lruMapSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (map.has(key)) map.delete(key);
  else {
    while (map.size >= maxSize) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
  map.set(key, value);
}
