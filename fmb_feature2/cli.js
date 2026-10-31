#!/usr/bin/env node
// fmb_feature2/cli.js — 回收計畫乾跑工具（唯讀：只讀 stdin、只印 stdout，不刪任何東西）
//
// 用法：
//   node fmb_feature2/cli.js <<'JSON'
//   { "spaces": [ ... ], "liveTargetIds": ["..."], "now": 1767225600000 }
//   JSON
//
// 輸入欄位：spaces（必填）、liveTargetIds（必填）、now（選填毫秒）、policy（選填）、protect（選填）
// 輸出：planReap() 的結果 JSON（closeSpaces / dropPages / staleActiveTargets / stats / reason）
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { planReap } from './reaper.js';

export function buildPlan(input) {
  let payload;
  try {
    payload = JSON.parse(String(input ?? ''));
  } catch (e) {
    throw new Error(`invalid JSON input: ${e.message}`);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload must be a JSON object');
  }
  const { spaces, liveTargetIds, now, policy, protect } = payload;
  return planReap({
    spaces: spaces ?? [],
    liveTargetIds: liveTargetIds ?? [],
    now: typeof now === 'number' ? now : Date.now(),
    policy: policy ?? {},
    protect: protect ?? [],
  });
}

function main() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  if (!raw.trim()) {
    console.error('usage: node fmb_feature2/cli.js < plan.json   (read-only dry run)');
    return 2;
  }
  try {
    console.log(JSON.stringify(buildPlan(raw), null, 1));
    return 0;
  } catch (e) {
    console.error(`reaper-cli: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
