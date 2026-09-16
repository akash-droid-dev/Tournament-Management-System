/**
 * Deterministic seeded RNG.
 *
 * §7.2.9: "Seeded random draws must store the RNG seed so any draw is
 * reproducible for dispute resolution." That is only true if the generator is
 * deterministic and versioned, so `Math.random()` is never used in draw code.
 *
 * `ALGORITHM` is recorded alongside the seed in the draw record. If this file
 * ever changes its algorithm, bump the version so historical draws stay
 * reproducible against the generator that produced them.
 */

export const ALGORITHM = 'mulberry32/v1';

/** FNV-1a — turns a human-readable seed string into a 32-bit state. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class SeededRandom {
  readonly seed: string;
  readonly algorithm = ALGORITHM;
  #state: number;
  #draws = 0;

  constructor(seed: string) {
    this.seed = seed;
    this.#state = hashSeed(seed);
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    this.#draws++;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) throw new Error('int() needs a positive bound');
    return Math.floor(this.next() * maxExclusive);
  }

  /** Fisher–Yates shuffle of a copy. Deterministic for a given seed. */
  shuffle<T>(items: readonly T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const ai = a[i] as T;
      a[i] = a[j] as T;
      a[j] = ai;
    }
    return a;
  }

  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new Error('pick() needs a non-empty list');
    return items[this.int(items.length)] as T;
  }

  /** How many values were consumed — recorded so a replay can be verified. */
  get drawCount(): number {
    return this.#draws;
  }
}

/**
 * Build a seed that is reproducible but not guessable before the draw:
 * the event ID plus an operator-supplied or generated nonce.
 */
export function buildSeed(eventId: string, nonce?: string): string {
  return `${eventId}:${nonce ?? Date.now().toString(36)}`;
}
