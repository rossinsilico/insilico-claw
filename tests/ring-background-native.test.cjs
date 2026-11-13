const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

test('native ring background coordinator is idempotent and finishes jobs exactly once', () => {
  const root = resolve(__dirname, '..');
  const dir = mkdtempSync(join(tmpdir(), 'faceclaw-ring-background-'));
  const binary = join(dir, 'ring-background-test');
  execFileSync('xcrun', [
    'swiftc',
    '-parse-as-library',
    'App_Resources/iOS/src/FaceclawRingHealthBackground.swift',
    'tests/native/ring-background/main.swift',
    '-o', binary,
  ], { cwd: root, stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
});
