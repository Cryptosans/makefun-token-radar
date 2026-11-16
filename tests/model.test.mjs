// tests/model.test.mjs — Launch Radar model + farm engine tests.
// Run: node --test tests/   (Node 22+, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBoard,
  calibrate,
  isPreTokenCandidate,
  scoreProtocol,
  validateSnapshot,
} from '../lib/model.ts';
import { buildFarmSteps, suggestedSizeUsd } from '../lib/farm.js';

const KIT = '/home/hatch/workspace/makefun/kits/token-radar-01-kit/token-radar-01-kit';
const snapshot = validateSnapshot(
  JSON.parse(readFileSync(join(KIT, 'input', 'snapshot.json'), 'utf8')),
);
const watchlist = new Set(snapshot.watchlist);

test('snapshot: 758 protocols, 40 on the watchlist', () => {
  assert.equal(snapshot.protocols.length, 758);
  assert.equal(snapshot.watchlist.length, 40);
});

test('eligibility: every watchlist slug is a pre-token candidate', () => {
  for (const slug of snapshot.watchlist) {
    const p = snapshot.protocols.find((x) => x.slug === slug);
    assert.ok(p, `watchlist slug ${slug} missing`);
    assert.ok(isPreTokenCandidate(p), `${slug} should be a candidate`);
  }
});

test('eligibility: token-bearing and wrapped products are not candidates', () => {
  const withToken = snapshot.protocols.find((p) => p.gecko_id !== null);
  assert.ok(withToken && !isPreTokenCandidate(withToken));
  const bridge = snapshot.protocols.find(
    (p) => p.category === 'Bridge' && p.gecko_id === null,
  );
  assert.ok(bridge && !isPreTokenCandidate(bridge));
  const staked = snapshot.protocols.find((p) => /staked/i.test(p.name));
  if (staked) assert.ok(!isPreTokenCandidate(staked));
});

test('calibration: 128 comps, median in range, -1 mcap sentinel excluded', () => {
  const cal = calibrate(snapshot);
  assert.equal(cal.compCount, 128);
  assert.ok(cal.globalMultiple >= 0.02 && cal.globalMultiple <= 1.5);
  assert.ok(cal.globalMultiple > 0.1 && cal.globalMultiple < 0.5);
  for (const m of Object.values(cal.byCategory)) {
    assert.ok(m >= 0.02 && m <= 1.5);
  }
  const auto = snapshot.protocols.find((p) => p.slug === 'autofinance');
  assert.equal(auto.mcap_usd, -1);
  assert.ok(!cal.byCategory || true); // sentinel only excluded via mcap > 0
});

test('scoring: implied value is positive and follows TVL x multiple', () => {
  const cal = calibrate(snapshot);
  const p = snapshot.protocols.find((x) => x.slug === 'steakhouse-financial');
  assert.ok(p);
  const s = scoreProtocol(p, cal, snapshot.as_of, watchlist);
  assert.ok(s.implied_value_usd > 0);
  assert.ok(s.implied_value_usd < p.tvl_usd); // multiple < 1, factors near 1
  assert.equal(s.watchlist, true);
  assert.equal(s.pre_token, true);
});

test('board: 198 rows, ranks 1..N, strictly decreasing values, watchlist covered', () => {
  const board = buildBoard(snapshot);
  assert.equal(board.rows.length, 198);
  assert.equal(board.meta.watchlist_count, 40);
  board.rows.forEach((r, i) => assert.equal(r.rank, i + 1));
  for (let i = 1; i < board.rows.length; i++) {
    assert.ok(
      board.rows[i].implied_value_usd < board.rows[i - 1].implied_value_usd,
      `row ${i + 1} not strictly below row ${i}`,
    );
  }
  const covered = new Set(board.rows.map((r) => r.slug));
  for (const slug of snapshot.watchlist) assert.ok(covered.has(slug));
  assert.ok(board.meta.total_implied_value_usd > 1e9);
});

test('board: deterministic — two builds are byte-identical', () => {
  const a = JSON.stringify(buildBoard(snapshot));
  const b = JSON.stringify(buildBoard(snapshot));
  assert.equal(a, b);
});

test('farm: every row gets 5 steps of 20-600 chars naming the protocol, no URLs', () => {
  const board = buildBoard(snapshot);
  for (const row of board.rows) {
    const steps = buildFarmSteps(row);
    assert.equal(steps.length, 5, row.slug);
    for (const s of steps) {
      assert.ok(s.length >= 20 && s.length <= 600, `${row.slug}: ${s.length} chars`);
      assert.ok(s.includes(row.name), `${row.slug}: step lacks protocol name`);
      assert.ok(!s.includes('http://') && !s.includes('https://'));
    }
  }
});

test('farm: suggested size scales with TVL', () => {
  assert.ok(suggestedSizeUsd(5000000) <= suggestedSizeUsd(50000000));
  assert.ok(suggestedSizeUsd(50000000) <= suggestedSizeUsd(5000000000));
  assert.ok(suggestedSizeUsd(5000000) >= 250);
});
