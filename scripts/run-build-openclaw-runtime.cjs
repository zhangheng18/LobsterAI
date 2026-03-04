'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function resolveBashExecutable(rootDir) {
  if (process.platform !== 'win32') {
    return commandExists('bash') ? 'bash' : null;
  }

  if (commandExists('bash')) {
    return 'bash';
  }

  const candidates = [
    path.join(rootDir, 'resources', 'mingit', 'bin', 'bash.exe'),
    path.join(rootDir, 'resources', 'mingit', 'usr', 'bin', 'bash.exe'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

const targetId = (process.argv[2] || '').trim();
if (!targetId) {
  console.error('[run-build-openclaw-runtime] Missing target id (example: mac-arm64, win-x64, linux-x64).');
  process.exit(1);
}

const rootDir = path.resolve(__dirname, '..');
const bashExecutable = resolveBashExecutable(rootDir);
if (!bashExecutable) {
  console.error('[run-build-openclaw-runtime] bash is required but not found.');
  if (process.platform === 'win32') {
    console.error('[run-build-openclaw-runtime] Install Git Bash or run `npm run setup:mingit` first.');
  }
  process.exit(1);
}

const scriptPath = path.join(rootDir, 'scripts', 'build-openclaw-runtime.sh');
const result = spawnSync(bashExecutable, [scriptPath, targetId], {
  cwd: rootDir,
  env: process.env,
  stdio: 'inherit',
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
