const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader } = require('./helpers/load-typescript.cjs');

class Observable {
  set(name, value) { this[name] = value; }
}

function harness(options = {}) {
  const calls = [], navigations = [];
  const sources = options.sources ?? [];
  const mocks = {
    '@nativescript/core': {
      Observable,
      Frame: { topmost: () => ({ navigate: entry => navigations.push(entry) }) },
    },
    '../native/notification-sources': {
      readNotificationSources: () => sources,
      setNotificationSourceEnabled: (source, enabled) => calls.push(['popups', source.packageName, enabled]),
      setNotificationSourceStatusIconEnabled: (source, enabled) => calls.push(['icon', source.packageName, enabled]),
    },
    '../ui/dashboard-settings': { newNotificationDisplaySetting: { get: () => options.globalDisplay ?? '15s' } },
  };
  const load = loader({}, mocks);
  return {
    list: load('app/phone-ui/notification-settings-page.ts'),
    detail: load('app/phone-ui/notification-source-settings-page.ts'),
    calls,
    navigations,
  };
}

test('notification summaries cover every popup and status-icon combination', () => {
  const { list } = harness();
  assert.equal(list.notificationSourceSummary({ showOnGlasses: true, showStatusIcon: true }), 'Popups and icon');
  assert.equal(list.notificationSourceSummary({ showOnGlasses: true, showStatusIcon: false }), 'Popups only');
  assert.equal(list.notificationSourceSummary({ showOnGlasses: false, showStatusIcon: true }), 'Icon only');
  assert.equal(list.notificationSourceSummary({ showOnGlasses: false, showStatusIcon: false }), 'Off');
});

test('duplicate app names retain package identity and row taps only navigate', () => {
  const sources = [
    { packageName: 'com.two', appName: 'Mail', showOnGlasses: false, showStatusIcon: true },
    { packageName: 'com.one', appName: 'Mail', showOnGlasses: true, showStatusIcon: false },
  ];
  const h = harness({ sources });
  const model = new h.list.NotificationSettingsViewModel();
  assert.deepEqual(model.sources.map(source => source.packageName), ['com.one', 'com.two']);
  assert.deepEqual(model.sources.map(source => source.packageLabel), ['com.one', 'com.two']);
  assert.equal(model.sources[1].accessibilityLabel, 'Mail, com.two, Icon only');
  assert.match(fs.readFileSync('app/phone-ui/notification-settings-page.xml', 'utf8'), /text="\{\{ packageLabel \}\}"/);
  model.onSourceTap({ index: 1 });
  assert.equal(JSON.stringify(h.navigations), JSON.stringify([{
    moduleName: 'phone-ui/notification-source-settings-page',
    context: { packageName: 'com.two' },
  }]));
  assert.deepEqual(h.calls, []);
});

test('unique app names do not add bundle identifier clutter', () => {
  const sources = [
    { packageName: 'com.mail', appName: 'Mail', showOnGlasses: true, showStatusIcon: true },
    { packageName: 'com.chat', appName: 'Chat', showOnGlasses: true, showStatusIcon: true },
  ];
  const h = harness({ sources });
  const rows = h.list.notificationSourceRows(sources);
  assert.deepEqual(rows.map(row => row.packageVisibility), ['collapse', 'collapse']);
  assert.equal(rows.find(row => row.appName === 'Mail').accessibilityLabel, 'Mail, Popups and icon');
});

test('returning from details refreshes the list without writing preferences', () => {
  const sources = [{ packageName: 'com.mail', appName: 'Mail', showOnGlasses: true, showStatusIcon: true }];
  const h = harness({ sources });
  const model = new h.list.NotificationSettingsViewModel();
  sources[0].showOnGlasses = false;
  h.list.navigatingTo({ object: { bindingContext: model } });
  assert.equal(model.sources[0].summary, 'Icon only');
  assert.deepEqual(h.calls, []);
});

test('iOS bundle registration includes both notification routes and views', () => {
  const source = fs.readFileSync('app/phone-ui/onboarding-register.ios.ts', 'utf8');
  for (const route of ['notification-settings-page', 'notification-source-settings-page']) {
    assert.match(source, new RegExp(`registerModule\\('phone-ui/${route}', `));
    assert.match(source, new RegExp(`registerModule\\('phone-ui/${route}\\.xml', `));
  }
});

test('detail view scrolls and explains that the Notifications inventory remains available', () => {
  const source = fs.readFileSync('app/phone-ui/notification-source-settings-page.xml', 'utf8');
  assert.match(source, /<ScrollView>/);
  assert.match(source, /Notifications app inventory remains available even when both options are off\./);
});

test('detail switches mutate only their matching preference and ignore initial binding events', () => {
  const source = { packageName: 'com.mail', appName: 'Mail', showOnGlasses: false, showStatusIcon: true };
  const h = harness({ sources: [source] });
  const model = new h.detail.NotificationSourceSettingsViewModel(source);
  model.onPopupsChanged({ value: false });
  model.onStatusIconChanged({ value: true });
  assert.deepEqual(h.calls, []);
  model.onPopupsChanged({ value: true });
  model.onStatusIconChanged({ value: false });
  assert.deepEqual(h.calls, [['popups', 'com.mail', true], ['icon', 'com.mail', false]]);
});

test('global popup Off is explained without changing the saved per-app switch', () => {
  const source = { packageName: 'com.mail', appName: 'Mail', showOnGlasses: true, showStatusIcon: true };
  const h = harness({ sources: [source], globalDisplay: 'off' });
  const model = new h.detail.NotificationSourceSettingsViewModel(source);
  assert.equal(model.popupsEnabled, true);
  assert.equal(model.globalPopupNoteVisibility, 'visible');
  assert.match(model.globalPopupNote, /off for all apps/i);
  assert.deepEqual(h.calls, []);
});
