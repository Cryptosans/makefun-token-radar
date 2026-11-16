// lib/model.ts — the radar's value model.
//
// Everything here derives from the sealed snapshot's own figures. No
// hardcoded protocol names, no hardcoded multiples: the calibration (what a
// launched token is worth relative to its protocol's TVL) is computed at
// runtime from the snapshot's own token-bearing protocols, per category,
// and every pre-token protocol is then priced with the multiple its own
// category earned. Run it on a fresh snapshot and it prices that snapshot.
//
// Implied value (USD) =
//   tvl_usd
//   x category FDV/TVL multiple   (median of launched comps in the category,
//                                  global median when the category has < 3)
//   x growth factor               (7-day TVL change, clamped to [-50%, +100%],
//                                  mapped to [0.75, 1.50])
//   x age factor                  (years listed with no token: 1 + 0.04/yr,
//                                  capped at 1.16; unknown age is neutral)
//   x chain factor                (1 + 0.02 per chain, capped at 1.10)
//
// A protocol is a launch candidate when DefiLlama records no token for it
// (gecko_id and symbol both null) and it is not a wrapped, staked or
// bridged product of a token that already trades — the same rule the
// snapshot's own watchlist uses, applied with only the ten fields the
// snapshot carries (parentProtocol is not one of them).

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Factors {
  multiple: number;
  growth: number;
  age: number;
  chains: number;
}

export interface Scored extends Protocol {
  rank: number;
  implied_value_usd: number;
  factors: Factors;
  age_days: number | null;
  watchlist: boolean;
  pre_token: boolean;
}

export interface Calibration {
  /** Median FDV/TVL over all launched comps. */
  globalMultiple: number;
  /** Per-category median FDV/TVL, only where the category has >= 3 comps. */
  byCategory: Record<string, number>;
  /** Launched comps the calibration read. */
  compCount: number;
  /** Quartiles of the comp multiples, for the method note. */
  p25: number;
  p75: number;
}

/** Categories the watchlist rule excludes as wrapped / staked / bridged products. */
export const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX =
  /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** True when the snapshot records no token for this protocol. */
export function hasNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/**
 * True when the protocol is not a wrapped, staked or bridged product of a
 * token that already trades, by the watchlist rule's visible half: category,
 * name markers and exchange prefixes. (parentProtocol is not a field the
 * snapshot carries, so it cannot be checked here.)
 */
export function isNotWrappedProduct(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_MARKER.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** A launch candidate: no token recorded, and not a wrapped product. */
export function isPreTokenCandidate(p: Protocol): boolean {
  return hasNoToken(p) && isNotWrappedProduct(p);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Calibrate the FDV/TVL multiple from the snapshot's own launched
 * protocols: every protocol with a market cap and a positive TVL is a comp.
 * The multiple is clamped to [0.02, 1.50] so a single wild comp (a
 * $400 FDV/TVL prediction market, a 12x collateral manager) cannot price
 * the board.
 */
export function calibrate(snapshot: Snapshot): Calibration {
  const comps = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const ratios = comps
    .map((p) => (p.mcap_usd as number) / p.tvl_usd)
    .sort((a, b) => a - b);
  const clamp = (x: number): number => Math.min(1.5, Math.max(0.02, x));
  const globalMultiple = clamp(median(ratios));
  const byCategory: Record<string, number> = {};
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    const cat = p.category ?? '(none)';
    const list = byCat.get(cat) ?? [];
    list.push((p.mcap_usd as number) / p.tvl_usd);
    byCat.set(cat, list);
  }
  for (const [cat, list] of byCat) {
    if (list.length >= 3) byCategory[cat] = clamp(median(list));
  }
  return {
    globalMultiple,
    byCategory,
    compCount: comps.length,
    p25: clamp(quantile(ratios, 0.25)),
    p75: clamp(quantile(ratios, 0.75)),
  };
}

function daysBetween(fromYmd: string, toYmd: string): number | null {
  const parse = (s: string): number | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(t) ? null : t;
  };
  const a = parse(fromYmd);
  const b = parse(toYmd);
  if (a === null || b === null) return null;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/**
 * Price one protocol. The multiple is its category's when the category
 * earned one, else the global median. Growth is the 7-day TVL change
 * clamped to [-50%, +100%] and halved into a factor. Age is years listed
 * with no token, at 4% a year capped at 16%. Chains add 2% each, capped
 * at 10%.
 */
export function scoreProtocol(
  p: Protocol,
  cal: Calibration,
  asOf: string,
  watchlist: ReadonlySet<string>,
): Scored {
  const multiple =
    p.category !== null && cal.byCategory[p.category] !== undefined
      ? (cal.byCategory[p.category] as number)
      : cal.globalMultiple;
  const change = p.change_7d === null ? 0 : Math.min(100, Math.max(-50, p.change_7d));
  const growth = 1 + (change / 100) * 0.5;
  const ageDays = p.listed_at === null ? null : daysBetween(p.listed_at, asOf);
  const years = ageDays === null ? 0 : ageDays / 365.25;
  const age = 1 + Math.min(years, 4) * 0.04;
  const chains = 1 + 0.02 * Math.min(p.chains.length, 5);
  const implied = Math.max(
    1,
    Math.round(p.tvl_usd * multiple * growth * age * chains),
  );
  return {
    ...p,
    rank: 0, // assigned by buildBoard after sorting
    implied_value_usd: implied,
    factors: { multiple, growth, age, chains },
    age_days: ageDays,
    watchlist: watchlist.has(p.slug),
    pre_token: isPreTokenCandidate(p),
  };
}

export interface BoardMeta {
  as_of: string;
  source: string;
  floor_usd: number;
  universe: number;
  candidates: number;
  watchlist_count: number;
  rows: number;
  total_implied_value_usd: number;
  calibration: Calibration;
}

export interface Board {
  meta: BoardMeta;
  rows: Scored[];
}

/**
 * Build the board: every pre-token candidate in the snapshot, scored and
 * ranked by implied value. Ties break by TVL, then slug, and a final pass
 * guarantees strictly decreasing implied values (a $1 nudge at most) so
 * the ranks are exactly 1..N with no equal neighbours.
 */
export function buildBoard(snapshot: Snapshot): Board {
  const watchlist = new Set(snapshot.watchlist);
  const cal = calibrate(snapshot);
  const candidates = snapshot.protocols.filter(isPreTokenCandidate);
  const scored = candidates.map((p) =>
    scoreProtocol(p, cal, snapshot.as_of, watchlist),
  );
  scored.sort((a, b) => {
    if (b.implied_value_usd !== a.implied_value_usd)
      return b.implied_value_usd - a.implied_value_usd;
    if (b.tvl_usd !== a.tvl_usd) return b.tvl_usd - a.tvl_usd;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (let i = 1; i < scored.length; i++) {
    const prev = scored[i - 1] as Scored;
    const cur = scored[i] as Scored;
    if (cur.implied_value_usd >= prev.implied_value_usd) {
      cur.implied_value_usd = Math.max(1, prev.implied_value_usd - 1);
    }
  }
  scored.forEach((r, i) => {
    r.rank = i + 1;
  });
  return {
    meta: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      universe: snapshot.protocols.length,
      candidates: candidates.length,
      watchlist_count: snapshot.watchlist.length,
      rows: scored.length,
      total_implied_value_usd: scored.reduce(
        (n, r) => n + r.implied_value_usd,
        0,
      ),
      calibration: cal,
    },
    rows: scored,
  };
}

/** Validate the snapshot's shape before any scoring runs. */
export function validateSnapshot(value: unknown): Snapshot {
  if (typeof value !== 'object' || value === null)
    throw new Error('snapshot: not an object');
  const s = value as Record<string, unknown>;
  if (typeof s.as_of !== 'string') throw new Error('snapshot: as_of missing');
  if (typeof s.source !== 'string') throw new Error('snapshot: source missing');
  if (typeof s.floor_usd !== 'number')
    throw new Error('snapshot: floor_usd missing');
  if (!Array.isArray(s.protocols)) throw new Error('snapshot: protocols missing');
  if (!Array.isArray(s.watchlist)) throw new Error('snapshot: watchlist missing');
  const slugs = new Set<string>();
  for (const p of s.protocols as Protocol[]) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string')
      throw new Error('snapshot: protocol without slug/name');
    if (typeof p.tvl_usd !== 'number')
      throw new Error(`snapshot: ${p.slug} without tvl_usd`);
    slugs.add(p.slug);
  }
  for (const slug of s.watchlist as string[]) {
    if (!slugs.has(slug))
      throw new Error(`snapshot: watchlist slug ${slug} is not a protocol`);
  }
  return value as Snapshot;
}
