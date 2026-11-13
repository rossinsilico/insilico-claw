const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '..', 'app/ui/shell/chrome-layer.ts'), 'utf8');

test('status icon policy is applied before the visible icon limit', () => {
  const icon = (name) => ({ name });
  const all = {
    icons: [icon('stale'), icon('hidden-1'), icon('shown-1'), icon('hidden-2'), icon('shown-2'), icon('new')],
    keys: ['stale', 'h1', 's1', 'h2', 's2', 'new'],
    packageNames: ['', 'hidden.one', 'shown.one', 'hidden.two', 'shown.two', ''],
    stale: false,
  };
  const requested = [];
  let preferenceReads = 0;
  const modules = new Proxy({
    '../../native/notification-icons': {
      ALL_NOTIFICATIONS: 0x7fffffff,
      readActiveNotificationIcons: (maxIcons) => { requested.push(maxIcons); return all; },
    },
    '../../native/notification-sources': {
      readNotificationSources: () => {
        preferenceReads++;
        return [{ packageName: 'hidden.one', showStatusIcon: false }, { packageName: 'hidden.two', showStatusIcon: false }];
      },
    },
    '../../util/render-freshness': { renderPassAllowsStaleData: () => false },
  }, { get: (target, key) => target[key] ?? {} });
  const context = { exports: {}, require: (name) => modules[name] };
  const testSource = `${source}\nexport { readStatusNotificationIcons };`;
  vm.runInNewContext(ts.transpileModule(testSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);

  const result = context.exports.readStatusNotificationIcons(2);
  assert.deepEqual(Array.from(result.keys), ['s1', 's2']);
  assert.deepEqual(Array.from(result.icons, ({ name }) => name), ['shown-1', 'shown-2']);
  assert.deepEqual(requested, [0x7fffffff]);
  assert.equal(preferenceReads, 1);

  all.packageNames[5] = 'unknown.new';
  assert.deepEqual(Array.from(context.exports.readStatusNotificationIcons(3).keys), ['s1', 's2', 'new']);
  assert.equal(preferenceReads, 2);
});
