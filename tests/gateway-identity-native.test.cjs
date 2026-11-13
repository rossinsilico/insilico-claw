const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { loader } = require('./helpers/load-typescript.cjs');

test('native gateway identity signs the exact v3 payload and scopes keys by HTTPS origin', () => {
  const root = resolve(__dirname, '..');
  const dir = mkdtempSync(join(tmpdir(), 'faceclaw-gateway-identity-'));
  const binary = join(dir, 'gateway-identity-test');
  execFileSync('xcrun', [
    'swiftc',
    '-parse-as-library',
    'App_Resources/iOS/src/FaceclawGatewayIdentity.swift',
    'tests/native/gateway-identity/main.swift',
    '-o', binary,
  ], { cwd: root, stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
});

test('generic gateway identity fails closed off iOS', () => {
  const gatewayIdentity = loader()('app/native/gateway-identity.ts');
  assert.throws(
    () => gatewayIdentity.signGatewayChallenge('https://gateway.example', 'token', [], 'nonce', 123),
    /only available on iOS/,
  );
});
