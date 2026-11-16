// app.js — Launch Radar dashboard renderer (ES module, no network).
//
// Reads the generated data.js, renders the board, the filters and the
// detail view. Farm steps are built by the shared engine in farm.js —
// the same engine main.ts used for board.json, so the page and the board
// can never disagree. Shot modes for screenshots: ?shot=board (default),
// ?shot=detail (rank 1 open), ?shot=filtered (watchlist only).

import { RADAR } from './data.js';
import { buildFarmSteps, suggestedSizeUsd, gasFor } from './farm.js';

const rows = RADAR.rows.map((r) => ({
  slug: r[0], name: r[1], rank: r[2], value: r[3], tvl: r[4],
  change: r[5], ageDays: r[6], category: r[7], chains: r[8],
  multiple: r[9], growth: r[10], age: r[11], chainsF: r[12],
  watchlist: r[13] === 1,
}));

const $ = (id) => document.getElementById(id);
const state = { q: '', cat: '', chain: '', watchOnly: false, sort: 'value', sel: null };

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const compact = (n) => {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  return '$' + Math.round(n / 1e3) + 'K';
};
const changeFmt = (c) => (c === null ? '—' : (c >= 0 ? '+' : '') + c.toFixed(1) + '%');
const ageFmt = (d) => {
  if (d === null) return '—';
  if (d >= 365) return (d / 365.25).toFixed(1) + 'y';
  return d + 'd';
};

function why(r) {
  const parts = [];
  if (r.multiple >= 0.3) parts.push(`${r.multiple.toFixed(2)}× ${r.category || 'category'} multiple`);
  if (r.growth >= 1.15) parts.push('fast 7d growth');
  else if (r.growth <= 0.85) parts.push('cooling 7d');
  if (r.age >= 1.12) parts.push('long no-token run');
  if (r.chainsF >= 1.08) parts.push(`${r.chains.length} chains`);
  if (parts.length === 0) parts.push('large TVL at category multiple');
  return parts.slice(0, 2).join(' · ');
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  let list = rows.filter((r) => {
    if (state.watchOnly && !r.watchlist) return false;
    if (state.cat && r.category !== state.cat) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q))) return false;
    return true;
  });
  const by = {
    value: (a, b) => a.rank - b.rank,
    tvl: (a, b) => b.tvl - a.tvl,
    growth: (a, b) => (b.change ?? -1e9) - (a.change ?? -1e9),
    age: (a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1),
  };
  return list.sort(by[state.sort]);
}

function factorRows(r) {
  const f = [
    ['TVL base', compact(r.tvl), 1],
    ['Category multiple', r.multiple.toFixed(2) + '×', Math.min(1, r.multiple / 1.5)],
    ['Growth factor', '×' + r.growth.toFixed(2), (r.growth - 0.75) / 0.75],
    ['Age factor', '×' + r.age.toFixed(2), (r.age - 1) / 0.16],
    ['Chain factor', '×' + r.chainsF.toFixed(2), (r.chainsF - 1) / 0.1],
  ];
  return f.map(([label, val, frac]) =>
    `<tr><td>${label}<div class="bar"><i style="width:${Math.round(Math.max(0.04, Math.min(1, frac)) * 100)}%"></i></div></td><td>${val}</td></tr>`).join('');
}

function renderDetail(r) {
  const steps = buildFarmSteps({
    slug: r.slug, name: r.name, category: r.category,
    chains: r.chains, tvl_usd: r.tvl, implied_value_usd: r.value,
  });
  const size = suggestedSizeUsd(r.tvl);
  const gas = gasFor(r.chains[0] || 'Ethereum');
  $('detail').innerHTML = `
    <h2>${r.name}${r.watchlist ? '<span class="badge">WATCHLIST</span>' : ''}</h2>
    <p class="slug">${r.slug} · ${r.category || 'Uncategorized'} · ${r.chains.join(', ')} · records no token</p>
    <div class="grid"><div>
      <h3>Implied launch value</h3>
      <div class="big">${money(r.value)}</div>
      <p class="cost">Rank #${r.rank} of ${rows.length} · TVL ${compact(r.tvl)} · 7d ${changeFmt(r.change)} · listed ${ageFmt(r.ageDays)} ago</p>
      <h3>How the value is built</h3>
      <table class="factors">${factorRows(r)}</table>
    </div><div>
      <h3>Farm plan — about ${money(size)} + ${money(gas)} gas</h3>
      <ol class="steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      <p class="cost">Costs are estimates for a suggested position, not requirements. A protocol that
      records no token may still have one its DefiLlama record does not carry.</p>
    </div></div>`;
}

function render() {
  const list = filtered();
  $('count').textContent = `${list.length} of ${rows.length} protocols`;
  $('rows').innerHTML = list.map((r) => `
    <tr data-slug="${r.slug}" class="${state.sel === r.slug ? 'sel' : ''}">
      <td class="num">${r.rank}</td>
      <td class="name"><b>${r.name}</b><span>${r.slug}</span></td>
      <td class="cat">${r.category || '—'}</td>
      <td class="chains">${r.chains.slice(0, 3).join(', ')}${r.chains.length > 3 ? ' +' + (r.chains.length - 3) : ''}</td>
      <td class="num">${compact(r.tvl)}</td>
      <td class="num ${r.change === null ? '' : r.change >= 0 ? 'up' : 'down'}">${changeFmt(r.change)}</td>
      <td class="num">${ageFmt(r.ageDays)}</td>
      <td class="num"><b>${money(r.value)}</b></td>
      <td class="why">${why(r)}${r.watchlist ? '<span class="badge">WATCHLIST</span>' : ''}</td>
    </tr>`).join('');
  const sel = rows.find((r) => r.slug === state.sel) || list[0];
  if (sel) {
    state.sel = sel.slug;
    renderDetail(sel);
  }
  document.querySelectorAll('#rows tr').forEach((tr) => {
    tr.addEventListener('click', () => {
      state.sel = tr.dataset.slug;
      render();
      $('detail').scrollIntoView({ block: 'nearest' });
    });
  });
}

function fillSelects() {
  const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
  const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
  $('cat').innerHTML = '<option value="">All categories</option>' +
    cats.map((c) => `<option>${c}</option>`).join('');
  $('chain').innerHTML = '<option value="">All chains</option>' +
    chains.map((c) => `<option>${c}</option>`).join('');
}

function init() {
  const m = RADAR.calibration;
  $('stats').innerHTML = `
    <div class="stat"><b>${rows.length}</b><span>ranked</span></div>
    <div class="stat"><b>${RADAR.watchlist_count}</b><span>watchlist</span></div>
    <div class="stat"><b>${RADAR.candidates}</b><span>pre-token in snapshot</span></div>
    <div class="stat"><b>${compact(RADAR.total_implied_value_usd)}</b><span>total implied value</span></div>`;
  $('calib').textContent = `Calibration: ${m.compCount} launched protocols in this snapshot carry a ` +
    `market cap; their median FDV/TVL is ${m.globalMultiple.toFixed(2)}× (p25 ${m.p25.toFixed(2)}×, ` +
    `p75 ${m.p75.toFixed(2)}×). Category multiples are the medians of the same comps, recomputed from ` +
    `whatever snapshot the program reads.`;
  $('asof').textContent = 'as of ' + RADAR.as_of;
  fillSelects();
  const shot = new URLSearchParams(location.search).get('shot') || 'board';
  if (shot === 'filtered') state.watchOnly = true;
  if (shot === 'detail') state.sel = rows[0].slug;
  $('q').addEventListener('input', (e) => { state.q = e.target.value; render(); });
  $('cat').addEventListener('change', (e) => { state.cat = e.target.value; render(); });
  $('chain').addEventListener('change', (e) => { state.chain = e.target.value; render(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  $('watchOnly').addEventListener('change', (e) => { state.watchOnly = e.target.checked; render(); });
  if (shot === 'filtered') $('watchOnly').checked = true;
  render();
  if (shot === 'detail') $('detail').scrollIntoView();
  requestAnimationFrame(() => { window.__shotReady = true; });
}

init();
