// lib/farm.js — the farm-plan engine.
//
// One engine, two runtimes: Node imports it (main.ts builds board.json)
// and the dashboard loads it as an ES module (farm.js) to render the same
// steps in the detail view, so the page and the board can never disagree.
//
// A plan is five steps, each 20 to 600 characters, each concrete: what to
// do, on which chain, with about how much money, and how long it takes.
// Every step names the protocol, so no step reads as a generic slogan.
// Nothing here names a protocol the snapshot does not: the category picks
// the playbook, the protocol's own figures fill the slots, so the same
// engine writes a plan for a protocol that does not exist yet — which is
// the whole point of a radar.
//
// Costs are estimates, stated as such: the suggested position scales with
// the protocol's TVL (log scale, $250 at the $5M floor, about $1,000 at
// $5B), and gas is the usual cost of a transaction on the primary chain.

/** Typical cost of one transaction on each chain, in USD. */
const GAS_USD = {
  Ethereum: 18,
  Arbitrum: 0.6,
  Base: 0.15,
  Solana: 0.02,
  Binance: 0.3,
  Avalanche: 0.5,
  Polygon: 0.1,
  Optimism: 0.2,
  Fantom: 0.3,
  Gnosis: 0.1,
  Linea: 0.2,
  zkSync: 0.3,
  Scroll: 0.2,
  Blast: 0.1,
  Mantle: 0.1,
  Sei: 0.05,
  Sui: 0.02,
  Aptos: 0.02,
};

/** Suggested farm size for a protocol of this TVL, in whole USD. */
export function suggestedSizeUsd(tvlUsd) {
  const steps = 1 + Math.log10(Math.max(tvlUsd, 5000000) / 5000000);
  return Math.max(250, Math.round((250 * steps) / 50) * 50);
}

/** Typical gas cost of one transaction on this chain, in USD. */
export function gasFor(chain) {
  return GAS_USD[chain] ?? 1;
}

function primaryChain(chains) {
  return chains.length > 0 ? chains[0] : 'Ethereum';
}

function money(n) {
  if (n < 1) return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString('en-US');
}

/**
 * One playbook per category family. `core` is the main farming action,
 * `extra` a second distinct on-protocol action, `hold` how the position
 * earns over time. {name}, {chain}, {size} and {gas} are filled per
 * protocol; every playbook is written for a protocol whose token does not
 * exist yet, so the plan farms usage and points, never a yield that
 * assumes a token.
 */
const PLAYBOOKS = {
  Dexs: {
    core: 'Swap about {size} through {name} on {chain} across at least three different pairs, then add {size} as liquidity to its deepest pool and hold the LP position.',
    extra:
      'Route a second swap through {name} the following week through a different pair so your address shows repeat router volume, not a single trade.',
    hold: 'Keep the LP position on {name} open and collect the trading fees it earns; a closed position after one day reads as a wash, not usage.',
  },
  Lending: {
    core: 'Supply about {size} of collateral to {name} on {chain} and borrow a small amount against it, about a third of what you supplied, to open a real borrow position.',
    extra:
      'Repay half the borrow on {name} the next week and borrow again, so the position shows an active borrow lifecycle rather than a one-off deposit.',
    hold: 'Leave the supply on {name} earning for six to eight weeks; lending points usually accrue on time-weighted supply, not on deposits alone.',
  },
  Yield: {
    core: 'Deposit about {size} into the highest-TVL vault on {name} on {chain} and let it compound; note the vault address so you can prove the deposit later.',
    extra:
      'Split a second deposit of about a third of the first into a different vault on {name} to show breadth across its products.',
    hold: 'Stay deposited on {name} for at least a full month; vault points are normally time-weighted, and early exits forfeit the accrual.',
  },
  'Yield Aggregator': {
    core: 'Deposit about {size} into the highest-TVL strategy on {name} on {chain} and let the aggregator route it; keep the receipt of the strategy you entered.',
    extra:
      'Move about a third of the deposit to a second strategy on {name} the following week to show you use more than one route.',
    hold: 'Hold the position on {name} for six to eight weeks; aggregator rewards usually weight deposits by how long they stay in a strategy.',
  },
  Derivatives: {
    core: 'Open a small perpetual or options position of about {size} notional on {name} on {chain}, with leverage no higher than 2x, and close it after the position has run a few days.',
    extra:
      'Open a second position on {name} in the opposite direction the next week so your address shows repeat trading activity, not a single punt.',
    hold: 'Trade on {name} at least once a week for a month; derivatives points normally reward sustained volume over weeks, not one large trade.',
  },
  RWA: {
    core: 'Buy or mint about {size} of the tokenized asset on {name} on {chain} and hold it in the wallet you farm with, so the holding itself is the on-chain record.',
    extra:
      'Use the position once more on {name} — a second purchase, a redemption, or a transfer between your own wallets — to show an active holder, not a dormant one.',
    hold: 'Hold the position on {name} for at least a month; real-world-asset programs usually snapshot holders over weeks, and a same-week exit earns nothing.',
  },
  'Risk Curators': {
    core: 'Deposit about {size} into the largest curated vault on {name} on {chain}; curators allocate across markets, so pick the vault whose underlying markets you understand.',
    extra:
      'Allocate about a third of the deposit to a second curated vault on {name} run by a different curator.',
    hold: 'Leave both deposits on {name} in place for six to eight weeks; curator vaults accrue points on time-weighted deposits, and churning between vaults resets the clock.',
  },
  'Onchain Capital Allocator': {
    core: 'Allocate about {size} through {name} on {chain} into its largest allocation strategy and keep the allocation receipt for the wallet you farm with.',
    extra:
      'Rebalance about a third of the allocation on {name} into a second strategy the next week to show you actively manage the position.',
    hold: 'Hold the allocation on {name} for at least a month; allocator programs normally reward capital that stays deployed across their snapshots.',
  },
  CDP: {
    core: 'Lock about {size} of collateral in a vault on {name} on {chain} and mint a modest amount of its stablecoin against it, well under half the collateral value.',
    extra:
      'Repay part of the minted stablecoin on {name} and mint again the following week to show the vault is actively managed, not opened once and forgotten.',
    hold: 'Keep the vault on {name} open and healthy for six to eight weeks; CDP points usually accrue on time-weighted collateral, and a liquidation ends the farm.',
  },
  'Basis Trading': {
    core: 'Place about {size} into the basis strategy on {name} on {chain} — the delta-neutral position is the product, so enter it as the protocol presents it, not as a directional bet.',
    extra:
      'Top up the position on {name} by about a third the following week after the first funding cycle settles, so the record shows a returning user.',
    hold: 'Stay in the strategy on {name} across at least four funding cycles; basis returns and points both accrue over time, not on entry.',
  },
  Restaking: {
    core: 'Restake about {size} of liquid staking tokens through {name} on {chain} and confirm the restaked position appears under your wallet before you stop.',
    extra:
      'Delegate the restaked position through {name} to a second operator or vault the next week to show you use the protocol more than once.',
    hold: 'Keep the restake on {name} active for at least a month; restaking points are time-weighted, and unstaking early usually forfeits the accrual.',
  },
  'Staking Pool': {
    core: 'Stake about {size} in the main staking pool on {name} on {chain} and confirm the stake and its rewards rate show under your wallet.',
    extra:
      'Add about a third more to the stake on {name} the following week to show a growing, returning staker rather than a single deposit.',
    hold: 'Stay staked on {name} for six to eight weeks; staking programs normally snapshot stakers over time, and early unstaking earns little.',
  },
  Chain: {
    core: 'Bridge about {size} to {name} on {chain} and use it there: make at least three transactions across two different apps on the chain in the first week.',
    extra:
      'Return the following week and use a second app on {name}, so the wallet shows repeat activity rather than one bridge and nothing else.',
    hold: 'Stay active on {name} weekly for a month; new-chain programs reward wallets that keep using the chain, not one-time bridgers.',
  },
  Payments: {
    core: 'Move about {size} through {name} on {chain} for a real payment — pay for something, or send it to a second wallet you control — and keep the receipt.',
    extra:
      'Make a second payment through {name} the next week for a different amount so the wallet shows a pattern of use, not a single transfer.',
    hold: 'Use {name} at least weekly for a month; payment programs reward repeat volume over time, and a single transfer is noise.',
  },
  CeDeFi: {
    core: 'Deposit about {size} into the main CeDeFi product on {name} on {chain} and confirm the deposit and its terms show under your wallet.',
    extra:
      'Add about a third more on {name} the following week, or use a second product on the same protocol, to show breadth as well as size.',
    hold: 'Hold the deposit on {name} for six to eight weeks; CeDeFi points are normally time-weighted, and early exits forfeit the accrual.',
  },
  Insurance: {
    core: 'Buy about {size} of cover on {name} on {chain} for a position you actually hold, and keep the policy receipt under the wallet you farm with.',
    extra:
      'Extend or renew the cover on {name} the following month, or cover a second position, so the record shows a returning customer.',
    hold: 'Keep cover active on {name} across at least one full policy period; insurance programs reward covered capital held over time.',
  },
  'Governance Incentives': {
    core: 'Lock or delegate about {size} of voting power through {name} on {chain} and cast a vote on the next live proposal from the wallet you farm with.',
    extra:
      'Vote on a second proposal on {name} the following month, or delegate to a second delegate, to show sustained governance activity.',
    hold: 'Stay delegated and voting on {name} for at least two proposal cycles; governance programs reward consistent voters, not one ballot.',
  },
  'Stablecoin Wrapper': {
    core: 'Wrap about {size} through {name} on {chain} into its wrapped stablecoin and hold the wrapped balance in the wallet you farm with.',
    extra:
      'Unwrap and re-wrap about a third of the position through {name} the next week to show active use of the wrapper, not a single mint.',
    hold: 'Hold the wrapped balance on {name} for at least a month; wrapper programs normally snapshot holders over weeks.',
  },
  'Collateral Markets': {
    core: 'Post about {size} of collateral in the largest market on {name} on {chain} and open a modest borrow against it, well under half the collateral value.',
    extra:
      'Adjust the position on {name} the following week — add collateral or repay part of the borrow — so the record shows active management.',
    hold: 'Keep the position on {name} healthy for six to eight weeks; collateral-market points accrue on time-weighted positions, and a liquidation ends the farm.',
  },
};

const GENERIC = {
  core: 'Use the core feature of {name} on {chain} with about {size}: open a real position through its main product and confirm it shows under your wallet before you stop.',
  extra:
    'Return the following week and use a second feature of {name}, so your address shows breadth across its products, not one action.',
  hold: 'Keep the position on {name} open for six to eight weeks; most programs accrue points on time-weighted usage, and a same-week exit earns little.',
};

/**
 * Build the five-step farm plan for one protocol row. Every step is a
 * complete sentence naming the protocol, the chain, a dollar amount and a
 * duration; the engine throws when a step would fall outside 20 to 600
 * characters, so a bad template fails loudly instead of shipping.
 */
export function buildFarmSteps(row) {
  const chain = primaryChain(row.chains || []);
  const size = suggestedSizeUsd(row.tvl_usd || 5000000);
  const gas = gasFor(chain);
  const playbook = PLAYBOOKS[row.category] || GENERIC;
  const fill = (text) =>
    text
      .replaceAll('{name}', row.name)
      .replaceAll('{chain}', chain)
      .replaceAll('{size}', money(size))
      .replaceAll('{gas}', money(gas));
  const steps = [
    fill(
      `Open a fresh wallet on ${chain} to farm ${row.name} and fund it with about ${money(size)} plus roughly ${money(gas)} for gas. Use a wallet you can afford to lose touch with, never your main holdings. About 15 minutes.`,
    ),
    fill(playbook.core),
    fill(playbook.extra),
    fill(playbook.hold),
    fill(
      `Track the position weekly on ${row.name} on ${chain}: note any points balance, snapshot date or claim window it shows, and exit only after a token claim opens — selling the farm before the claim is the most common way to earn nothing. About 10 minutes a week.`,
    ),
  ];
  for (const step of steps) {
    const trimmed = step.trim();
    if (trimmed.length < 20 || trimmed.length > 600) {
      throw new Error(
        `farm plan for ${row.slug}: step of ${trimmed.length} characters outside 20-600: ${trimmed.slice(0, 80)}`,
      );
    }
  }
  return steps;
}
