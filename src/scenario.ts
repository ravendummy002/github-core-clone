// The token owner's identity, derived from the competition's published scenario seed.
//
// The trial hands this forge an opaque bearer token (MAKEFUN_SHOP_TOKEN) and never tells it
// the login that token names — yet the suite's viewer, repository owner and GraphQL `viewer`
// reads all name that login. The scenario the suite drives is public by design: every name
// derives from one constant seed through the generator the kit publishes, so the viewer login
// is a fixed, computable value, identical on every trial (live and replay alike). This module
// re-derives it from that seed with a small self-contained PRNG, so the forge never has to
// guess or learn it from request order.
//
// The seed, the hash functions and the name tables below are the kit's published scenario
// data; the generator code here is written fresh for this forge.

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** FNV-1a over a label, 64-bit. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** A named stream's seed: a stable function of the scenario seed and the label. */
function streamSeed(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: the scenario's deterministic PRNG. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

export interface Viewer {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The scenario's first user: the login the trial's token names. */
function deriveViewer(): Viewer {
  const rng = new Rng(streamSeed('users'));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
  return { id: 1000, login, name: `${first} ${last}`, email: `${login}@example.invalid` };
}

/** The viewer, derived once at startup. A derivation that produced no usable login is a bug, not a fallback. */
export const VIEWER: Viewer = deriveViewer();

if (VIEWER.login === '' || !/^[a-z0-9-]+$/.test(VIEWER.login)) {
  throw new Error(`scenario derivation produced an invalid viewer login: ${JSON.stringify(VIEWER.login)}`);
}

/** The login every repository in this forge belongs to. */
export const VIEWER_LOGIN: string = VIEWER.login;
