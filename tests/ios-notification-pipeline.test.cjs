const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { loader } = require('./helpers/load-typescript.cjs');

function setup(t) {
  const values = new Map(), logs = [], opened = [];
  let display = '5s', wakes = 0, sequence = 0;
  const load = loader({ setTimeout, clearTimeout }, {
    './settings-store': {
      getStringSetting: (key, fallback) => values.get(key) ?? fallback,
      setStringSetting: (key, value) => values.set(key, value),
    },
    '../graphics/pebble-icons': {}, './notification-app-icons': {},
  });
  const sources = load('app/native/notification-sources.ts');
  const notifications = load('app/native/notification-icons.ios.ts');
  const { AncsClient } = load('app/g2/ancs-client.ts');
  const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const tree = file => ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
  const settingsTree = tree('app/ui/dashboard-settings.ts');
  const policy = settingsTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'shouldPopUpNewNotification');
  const displaySetting = { get: () => display };
  const compiledPolicy = ts.transpileModule(policy.getText(settingsTree).replace(/^export /, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const shouldPopup = vm.runInNewContext(compiledPolicy + ';shouldPopUpNewNotification', {
    newNotificationDisplaySetting: displaySetting,
    shouldShowNotificationOnGlasses: sources.shouldShowNotificationOnGlasses,
  });
  const controllerTree = tree('app/g2/ios-preview-controller.ts');
  let registration;
  function visit(node) {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
        && node.expression.expression.getText(controllerTree) === 'onIosNotificationPopup') registration = node.getText(controllerTree);
    ts.forEachChild(node, visit);
  }
  visit(controllerTree); assert.ok(registration);
  const host = { glassesLocked: false, requestShellRender() {}, logBluetooth: message => logs.push(message) };
  const shell = { isScreenOn: () => false, wake() { wakes++; return true; }, openNotificationModal: key => opened.push(key) };
  new Function('onIosNotificationPopup', 'readActiveNotifications', 'shouldPopUpNewNotification',
    'newNotificationDisplaySetting', 'shouldShowNotificationOnGlasses', 'shell', registration)
    .call(host, notifications.onIosNotificationPopup, notifications.readActiveNotifications, shouldPopup,
      displaySetting, sources.shouldShowNotificationOnGlasses, shell);
  const client = new AncsClient(async () => {}, (key, popup) => notifications.iosNotificationsChanged(key, popup));
  notifications.bindIosNotifications(client); t.after(() => client.stop());
  const le = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24];
  function feed(kind, bytes) {
    if (!bytes.length) client.receive(new Uint8Array([65, 78, 1, kind, ...le(123), sequence & 255, sequence++ >> 8, 3]));
    for (let i = 0; i < bytes.length; i += 9) client.receive(new Uint8Array([
      65, 78, 1, kind, ...le(123), sequence & 255, sequence++ >> 8,
      (i === 0 ? 1 : 0) | (i + 9 >= bytes.length ? 2 : 0), ...bytes.slice(i, i + 9),
    ]));
  }
  const attr = (id, text) => { const bytes = [...Buffer.from(text)]; return [id, bytes.length & 255, bytes.length >> 8, ...bytes]; };
  function deliver(uid, appId, flags = 0) {
    feed(1, [0, flags, 1, 1, ...le(uid)]); feed(3, []);
    feed(2, [0, ...le(uid), ...attr(0, appId), ...attr(1, 'Synthetic private title'), ...attr(3, 'Synthetic private body')]); feed(3, []);
    feed(2, [0, ...le(uid), ...attr(2, ''), ...attr(4, ''), ...attr(5, ''), ...attr(6, ''), ...attr(7, '')]); feed(3, []);
  }
  client.start(123, 20); feed(0, [0]); feed(0, [1]);
  return { sources, notifications, logs, opened, host, deliver,
    updateFlags: (uid, flags) => feed(1, [1, flags, 1, 1, ...le(uid)]),
    wakes: () => wakes, setDisplay: value => { display = value; } };
}

test('the real ANCS, iOS adapter and controller suppress a saved source mute before waking', t => {
  const h = setup(t);
  h.sources.setNotificationSourceEnabled({ packageName: 'com.audit.blocked', appName: 'Muted app' }, false);
  h.deliver(1, 'com.audit.blocked');
  assert.equal(h.wakes(), 0); assert.equal(h.opened.length, 0);
  assert.equal(h.notifications.readActiveNotifications().length, 1);
  assert.equal(h.sources.shouldShowNotificationOnGlasses('com.audit.blocked'), false);
  h.deliver(2, 'com.audit.allowed');
  assert.equal(h.wakes(), 1); assert.equal(h.opened.length, 1);
});

test('global Off and glasses locking suppress allowed-source interruptions', t => {
  const h = setup(t); h.setDisplay('off'); h.deliver(1, 'com.audit.allowed');
  h.setDisplay('5s'); h.host.glassesLocked = true; h.deliver(2, 'com.audit.allowed');
  assert.equal(h.wakes(), 0); assert.equal(h.opened.length, 0);
});

test('Silent, Important plus Silent and PreExisting stay in inventory without an interruption', t => {
  const h = setup(t);
  for (const [uid, flags] of [[1, 1], [2, 3], [3, 4]]) h.deliver(uid, 'com.audit.allowed', flags);
  assert.equal(h.notifications.readActiveNotifications().length, 3);
  assert.equal(h.wakes(), 0); assert.equal(h.opened.length, 0);
});

test('a quiet-state update reaches the visible notification before any refreshed contents arrive', t => {
  const h = setup(t); h.deliver(1, 'com.audit.allowed');
  assert.equal(h.opened.length, 1);
  h.updateFlags(1, 1);
  assert.equal(h.notifications.readActiveNotifications()[0].suppressPopup, true);
  assert.equal(h.opened.length, 1);
});

test('popup decision diagnostics contain effective policy but no notification contents or session identifiers', t => {
  const h = setup(t);
  h.sources.setNotificationSourceEnabled({ packageName: 'com.audit.blocked', appName: 'Muted app' }, false);
  h.deliver(1, 'com.audit.blocked');
  h.deliver(2, 'com.audit.allowed');
  const decisions = h.logs.filter(line => line.startsWith('Notification popup: ')).map(line => JSON.parse(line.slice('Notification popup: '.length)));
  assert.equal(decisions.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(decisions[0])), {
    appId: 'com.audit.blocked', sourceEnabled: false, display: '5s', reason: 'source-muted',
  });
  assert.equal(decisions[1].reason, 'eligible');
  const saved = h.logs.join('\n');
  assert.ok(!saved.includes('Synthetic private')); assert.ok(!saved.includes('ancs:123:'));
});
