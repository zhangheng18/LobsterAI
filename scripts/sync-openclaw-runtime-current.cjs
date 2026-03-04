'use strict';

const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`[sync-openclaw-runtime-current] ${message}`);
  process.exit(1);
}

const targetId = (process.argv[2] || '').trim();
if (!targetId) {
  fail('Missing target id. Usage: node scripts/sync-openclaw-runtime-current.cjs <target-id>');
}

const rootDir = path.resolve(__dirname, '..');
const runtimeBaseDir = path.join(rootDir, 'vendor', 'openclaw-runtime');
const targetRuntimeDir = path.join(runtimeBaseDir, targetId);
const currentRuntimeDir = path.join(runtimeBaseDir, 'current');

if (!fs.existsSync(targetRuntimeDir)) {
  fail(`Target runtime does not exist: ${targetRuntimeDir}`);
}

fs.rmSync(currentRuntimeDir, { recursive: true, force: true });
fs.cpSync(targetRuntimeDir, currentRuntimeDir, { recursive: true, force: true });

console.log(`[sync-openclaw-runtime-current] Synced ${targetId} -> vendor/openclaw-runtime/current`);
