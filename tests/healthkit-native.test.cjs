const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

test('native HealthKit bridge validates canonical ring samples and local day intervals', () => {
  const root = resolve(__dirname, '..');
  const dir = mkdtempSync(join(tmpdir(), 'faceclaw-healthkit-'));
  const binary = join(dir, 'healthkit-test');
  execFileSync('xcrun', [
    'swiftc',
    '-parse-as-library',
    'App_Resources/iOS/src/FaceclawHealthKit.swift',
    'tests/native/healthkit/main.swift',
    '-o', binary,
  ], { cwd: root, stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
});

test('authorized HealthKit writes remain available while protected data is locked', function () {
  const root = resolve(__dirname, '..');
  const source = readFileSync(join(root, 'App_Resources/iOS/src/FaceclawHealthKit.swift'), 'utf8');
  const writePath = source.slice(
    source.indexOf('public func writeRingSamples('),
    source.indexOf('static func dayInterval('),
  );

  assert.doesNotMatch(writePath, /protectedDataAvailable/);
  assert.doesNotMatch(writePath, /completeSensitive/);
  assert.match(writePath, /self\.complete\(result:/);
});

test('HealthKit access and queries remain protected while the phone is locked', function () {
  const root = resolve(__dirname, '..');
  const source = readFileSync(join(root, 'App_Resources/iOS/src/FaceclawHealthKit.swift'), 'utf8');
  const accessPath = source.slice(source.indexOf('public func requestAccess('), source.indexOf('@objc(querySummary'));
  const queryPath = source.slice(source.indexOf('public func querySummary('), source.indexOf('@objc(cancelRequest'));
  const queryResultPath = source.slice(source.indexOf('private func record('), source.indexOf('private func failRequest('));

  assert.match(accessPath, /guard Self\.protectedDataAvailable\(\)/);
  assert.match(queryPath, /guard Self\.protectedDataAvailable\(\)/);
  assert.match(queryResultPath, /completeSensitive\(result:/);
});
