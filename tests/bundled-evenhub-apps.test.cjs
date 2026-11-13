const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loader } = require('./helpers/load-typescript.cjs');

const root = path.resolve(__dirname, '..');
const assetDir = path.join(root, 'app', 'assets', 'evenhub');
const assetPath = path.join(root, 'app', 'assets', 'evenhub', 'G2C-1.0.48-codex.ehpk');
const expectedHash = '6bed1e692652129b3765ab66442fe7079a1f46a1f1e5951254f42582e1e4bc49';
const ehpk = loader({}, {
  fzstd: require('fzstd'),
  './permissions': { parsePermissions: () => [] },
})('app/apps/evenhub/ehpk.ts');
const referenceArchive = ehpk.parseEhpk(new Uint8Array(
  fs.readFileSync(path.join(assetDir, 'G2C-1.0.43-codex.ehpk')),
));
const expectedLicense = Buffer.from(referenceArchive.files.get('dist/LICENSE-G2C.txt'));

function bootHarness({ includeAsset = true } = {}) {
  const packageBytes = new Uint8Array(fs.readFileSync(assetPath));
  const files = new Map(includeAsset ? [['/bundle/assets/evenhub/G2C-1.0.48-codex.ehpk', packageBytes]] : []);
  const settings = new Map([['g2c-user-data', 'keep me']]);
  const deleted = [];
  let runs = 0, writes = 0;

  const boot = () => loader({
    FaceclawConfigPort: { processPendingRequest() {} },
    UIApplication:{sharedApplication:{applicationState:0}},UIApplicationState:{Background:2},
    setTimeout() {},
  }, {
    '@nativescript/core': {
      Application: { launchEvent: 'launch', resumeEvent:'resume', on() {}, run(entry) { runs++;entry.create(); } },
      ApplicationSettings: {
        getString: (key, fallback) => settings.get(key) ?? fallback,
        setString: (key, value) => settings.set(key, value),
        hasKey: key => settings.has(key),
      },
      Frame: class { navigate() {} },
      Page: class {},
      knownFolders: { currentApp: () => ({ path: '/bundle' }) },
    },
    './phone-ui/onboarding-register.ios': {},
    './phone-ui/onboarding-state': { hasCompletedOnboarding: () => true },
    './health/ring-session.ios':{initializeIosRingBackground(){}},
    '../../native/file-access': {
      appFilesDirPath: () => '/documents',
      readBinaryFile: file => files.get(file) ?? null,
      readTextFile() {},
      writeBinaryFile: (file, bytes) => { writes++; files.set(file, bytes.slice()); return true; },
      deletePathRecursively: file => { deleted.push(file); files.delete(file); },
    },
    '../../native/firmware-files': {
      firmwareSha256: buffer => crypto.createHash('sha256').update(new Uint8Array(buffer)).digest('hex'),
    },
    '../../native/settings-store': {
      getStringSetting: (key, fallback) => settings.get(key) ?? fallback,
      setStringSetting: (key, value) => settings.set(key, value),
    },
    '../../native/icon-image': {},
    '../../graphics/icons': {},
    '../../graphics/image': {},
    fzstd: require('fzstd'),
  })('app/bootstrap.ios.ts');

  return { boot, files, settings, deleted, runs: () => runs, writes: () => writes, packageBytes };
}

test('iOS boot installs the bundled G2C package once without clobbering app data', () => {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex'), expectedHash);
  const h = bootHarness();
  const installedPath = '/documents/evenhub-installed/com.liyiyuian.tmuxor/package.ehpk';

  h.boot();
  assert.equal(h.files.get(installedPath)?.length, h.packageBytes.length);
  assert.equal(JSON.parse(h.settings.get('evenhub.installedApps.v1'))[0].name, 'G2C');
  const writesAfterFirstBoot = h.writes();

  h.boot();
  assert.equal(h.writes(), writesAfterFirstBoot, 'an exact installed package is not rewritten on repeat launch');
  assert.equal(h.settings.get('g2c-user-data'), 'keep me');
  assert.deepEqual(h.deleted, []);
});

test('iOS boot repairs a same-version package but preserves a newer installed version', () => {
  const repaired = bootHarness();
  repaired.boot();
  const installedPath = '/documents/evenhub-installed/com.liyiyuian.tmuxor/package.ehpk';
  repaired.files.set(installedPath, new Uint8Array([1, 2, 3]));
  const writesBeforeRepair = repaired.writes();
  repaired.boot();
  assert.ok(repaired.writes() > writesBeforeRepair);
  assert.equal(repaired.files.get(installedPath)?.length, repaired.packageBytes.length);

  const newer = bootHarness();
  newer.settings.set('evenhub.installedApps.v1', JSON.stringify([{
    packageId: 'com.liyiyuian.tmuxor', name: 'G2C', version: '1.0.49', installedAt: 'later',
  }]));
  newer.files.set(installedPath, new Uint8Array([9, 9, 9]));
  newer.boot();
  assert.deepEqual(newer.files.get(installedPath), new Uint8Array([9, 9, 9]));
  assert.equal(newer.writes(), 0);
});

test('a missing bundled package cannot block iOS startup', () => {
  const h = bootHarness({ includeAsset: false });
  h.boot();
  assert.equal(h.runs(), 1);
  assert.equal(h.writes(), 0);
});

test('every bundled G2C package carries the exact upstream MIT notice', () => {
  for (const version of ['1.0.43', '1.0.44', '1.0.45', '1.0.46', '1.0.47', '1.0.48']) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(assetDir, `G2C-${version}-codex.ehpk`)));
    const archive = ehpk.parseEhpk(bytes);
    const manifest = JSON.parse(Buffer.from(archive.files.get('app.json')).toString('utf8'));
    assert.equal(manifest.package_id, 'com.liyiyuian.tmuxor');
    assert.equal(manifest.version, version);
    assert.ok(archive.files.has('dist/LICENSE-G2C.txt'), `${version} is missing its MIT notice`);
    assert.deepEqual(Buffer.from(archive.files.get('dist/LICENSE-G2C.txt')), expectedLicense);
  }
  assert.deepEqual(fs.readFileSync(path.join(assetDir, 'LICENSE-G2C.txt')), expectedLicense);
});
