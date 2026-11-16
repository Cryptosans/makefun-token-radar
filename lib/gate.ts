// lib/gate.ts — the gate, as a self-check.
//
// Mirrors the scorer's seven rows from the kit's rules, run by main.ts on
// its own /output before it reports success: a program that cannot pass
// its own gate in the open should not be handed in. It is a check, not the
// scorer — the server's copy is the one that counts — but every row here
// is the same rule the rules state, and the dossier row re-runs the kit's
// own buildDossier and compares byte for byte.
//
// One row is stricter than the scorer's: the dashboard's source must fit
// the dossier's 65,536-byte text whole. The scorer only cuts what does not
// fit; this radar wants the judge to read all of it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from '../vendor/makefun-board.ts';
import type { Snapshot } from './model.ts';

const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MAX_BOARD_ROWS = 4000;
const MIN_BOARD_ROWS = 100;
const MAX_IMPLIED = 100000000000000;

export interface GateResult {
  row: string;
  pass: boolean;
  detail: string;
}

function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  )
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: view.getUint32(16), h: view.getUint32(20) };
}

function jpegSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] as number;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xda) return null; // scan data: no SOF before it
    const len = view.getUint16(at + 2);
    if (marker === 0xc0 || marker === 0xc2) {
      return { h: view.getUint16(at + 5), w: view.getUint16(at + 7) };
    }
    at += 2 + len;
  }
  return null;
}

function imageSize(bytes: Uint8Array): { w: number; h: number; type: string } | null {
  const png = pngSize(bytes);
  if (png) return { ...png, type: 'png' };
  const jpg = jpegSize(bytes);
  if (jpg) return { ...jpg, type: 'jpeg' };
  return null;
}

function walkFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function isWhole(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Run all seven rows (plus the source-size row) over an output directory. */
export function checkOutput(outDir: string, snapshot: Snapshot): GateResult[] {
  const results: GateResult[] = [];
  const fail = (row: string, detail: string): void => {
    results.push({ row, pass: false, detail });
  };
  const ok = (row: string, detail: string): void => {
    results.push({ row, pass: true, detail });
  };

  // dashboard_files -------------------------------------------------------
  const dashDir = join(outDir, 'dashboard');
  let dashFiles: string[] = [];
  try {
    dashFiles = walkFiles(dashDir, '');
  } catch {
    fail('dashboard_files', 'no dashboard/ directory');
    dashFiles = [];
  }
  if (dashFiles.length > 0) {
    const hasIndex = dashFiles.includes('index.html');
    const hasCss = dashFiles.some((f) => f.endsWith('.css'));
    const hasJs = dashFiles.some((f) => f.endsWith('.js'));
    const totalBytes = dashFiles.reduce(
      (n, f) => n + statSync(join(dashDir, f)).size,
      0,
    );
    const badName = dashFiles.find((f) => {
      const parts = f.split('/');
      return parts.some((part) => part.startsWith('.') || !PLAIN_NAME.test(part));
    });
    let networkHit = '';
    for (const f of dashFiles) {
      const text = readFileSync(join(dashDir, f), 'utf8');
      if (text.includes('http://') || text.includes('https://')) {
        networkHit = f;
        break;
      }
    }
    if (!hasIndex) fail('dashboard_files', 'no index.html');
    else if (!hasCss) fail('dashboard_files', 'no .css file');
    else if (!hasJs) fail('dashboard_files', 'no .js file');
    else if (dashFiles.length > 400)
      fail('dashboard_files', `${dashFiles.length} files, over 400`);
    else if (totalBytes > 4 * 1024 * 1024)
      fail('dashboard_files', `${totalBytes} bytes, over 4 MiB`);
    else if (badName !== undefined)
      fail('dashboard_files', `bad file name: ${badName}`);
    else if (networkHit !== '')
      fail('dashboard_files', `network address in ${networkHit}`);
    else
      ok(
        'dashboard_files',
        `${dashFiles.length} files, ${totalBytes} bytes, no network address`,
      );
    if (totalBytes > 65536) {
      fail(
        'dashboard_source_fits',
        `dashboard source is ${totalBytes} bytes, over the 65,536 the dossier shows whole`,
      );
    } else {
      ok('dashboard_source_fits', `${totalBytes} bytes of 65,536`);
    }
  }

  // board_file / sorted_by_value / coverage / farm_steps -------------------
  const boardPath = join(outDir, 'board.json');
  let rows: Record<string, unknown>[] = [];
  let boardBytes = 0;
  try {
    const raw = readFileSync(boardPath);
    boardBytes = raw.length;
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as
      | { rows?: unknown }
      | unknown[];
    rows = (Array.isArray(parsed) ? parsed : parsed.rows) as Record<
      string,
      unknown
    >[];
    if (!Array.isArray(rows)) throw new Error('rows is not an array');
  } catch (err) {
    fail('board_file', `board.json unreadable: ${(err as Error).message}`);
    rows = [];
  }
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  if (rows.length > 0) {
    if (rows.length < MIN_BOARD_ROWS || rows.length > MAX_BOARD_ROWS)
      fail(
        'board_file',
        `${rows.length} rows, outside 100-4000`,
      );
    else if (boardBytes > 8 * 1024 * 1024)
      fail('board_file', `${boardBytes} bytes, over 8 MiB`);
    else {
      const bad = rows.find(
        (r) =>
          typeof r.slug !== 'string' ||
          (r.slug as string).length < 1 ||
          (r.slug as string).length > 128 ||
          /\s/.test(r.slug as string) ||
          !slugs.has(r.slug as string) ||
          typeof r.name !== 'string' ||
          (r.name as string).length === 0 ||
          !isWhole(r.rank as number) ||
          !isWhole(r.implied_value_usd as number) ||
          (r.implied_value_usd as number) > MAX_IMPLIED ||
          !Array.isArray(r.farm_steps),
      );
      if (bad !== undefined)
        fail('board_file', `bad row: ${JSON.stringify(bad).slice(0, 160)}`);
      else ok('board_file', `${rows.length} rows, ${boardBytes} bytes`);
    }

    const ranks = rows.map((r) => r.rank as number).sort((a, b) => a - b);
    const ranksOk =
      ranks.length > 0 &&
      ranks.every((r, i) => r === i + 1);
    const byRank = [...rows].sort(
      (a, b) => (a.rank as number) - (b.rank as number),
    );
    const values = byRank.map((r) => r.implied_value_usd as number);
    const nonIncreasing = values.every(
      (v, i) => i === 0 || v < (values[i - 1] as number),
    );
    const allEqual = values.length >= 2 && values.every((v) => v === values[0]);
    if (!ranksOk) fail('sorted_by_value', 'ranks are not exactly 1..N');
    else if (!nonIncreasing)
      fail('sorted_by_value', 'implied value rises with rank');
    else if (allEqual)
      fail('sorted_by_value', 'all implied values are equal');
    else ok('sorted_by_value', `ranks 1..${rows.length}, strictly decreasing`);

    const rowSlugs = new Set(rows.map((r) => r.slug as string));
    const missing = snapshot.watchlist.filter((s) => !rowSlugs.has(s));
    if (missing.length > 0)
      fail('coverage', `watchlist missing: ${missing.slice(0, 5).join(', ')}`);
    else ok('coverage', `all ${snapshot.watchlist.length} watchlist slugs covered`);

    const badSteps = rows.find((r) => {
      const steps = r.farm_steps as unknown[];
      if (!Array.isArray(steps) || steps.length < 3 || steps.length > 12)
        return true;
      return steps.some(
        (s) =>
          typeof s !== 'string' ||
          s.trim().length < 20 ||
          s.trim().length > 600,
      );
    });
    if (badSteps !== undefined)
      fail(
        'farm_steps',
        `bad farm_steps on row ${String(badSteps.slug)}`,
      );
    else ok('farm_steps', `every row carries 3-12 steps of 20-600 characters`);
  }

  // screenshots ------------------------------------------------------------
  const shotsDir = join(outDir, 'screenshots');
  let shots: string[] = [];
  let shotsError = '';
  try {
    shots = readdirSync(shotsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    shotsError = 'no screenshots/ directory';
  }
  if (shotsError !== '') fail('screenshots', shotsError);
  else if (shots.length === 0) fail('screenshots', 'no images in screenshots/');
  else {
    if (shots.length < 3 || shots.length > 4)
      fail('screenshots', `${shots.length} images, need 3-4`);
    else {
      let bad = '';
      for (const name of shots) {
        if (!PLAIN_NAME.test(name)) {
          bad = `bad name: ${name}`;
          break;
        }
        const bytes = readFileSync(join(shotsDir, name));
        if (bytes.length > 512 * 1024) {
          bad = `${name} is ${bytes.length} bytes, over 512 KiB`;
          break;
        }
        const size = imageSize(new Uint8Array(bytes));
        if (size === null) {
          bad = `${name} is not a whole PNG or JPEG`;
          break;
        }
        const long = Math.max(size.w, size.h);
        const short = Math.min(size.w, size.h);
        if (long > 1440 || short < 800) {
          bad = `${name} is ${size.w}x${size.h}, outside long<=1440 short>=800`;
          break;
        }
      }
      if (bad !== '') fail('screenshots', bad);
      else ok('screenshots', `${shots.length} images within limits`);
    }
  }

  // dossier_matches ---------------------------------------------------------
  try {
    const written = readFileSync(join(outDir, 'dossier.json'));
    if (written.length > 1.5 * 1024 * 1024) {
      fail('dossier_matches', `dossier.json is ${written.length} bytes, over 1.5 MiB`);
    } else {
      const fresh = buildDossier(outDir, { text_max_bytes: 65536 });
      const same =
        written.length === fresh.length &&
        written.every((b, i) => b === (fresh as Uint8Array)[i]);
      if (!same)
        fail('dossier_matches', 'dossier.json differs from buildDossier output');
      else ok('dossier_matches', `${written.length} bytes, byte for byte`);
    }
  } catch (err) {
    fail('dossier_matches', `dossier.json unreadable: ${(err as Error).message}`);
  }

  return results;
}
