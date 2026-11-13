const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function fixture({ read = 30, available = true, readError = null, writeError = null } = {}) {
  const calls = { refresh: 0, writes: [], modal: null, pushed: [] };
  let value = read === null ? 'Not read' : `${read}\u00b0`;
  const generation = 7;
  class TextViewerLayer { constructor(text, title) { this.text = text; this.title = title; } }
  const load = loader({}, {
    '../native/head-up-settings': {
      headUpAngleValue: () => value,
      isHeadUpSettingsAvailable: () => available,
      headUpSettingsGeneration: () => generation,
      refreshHeadUpAngle: async () => { calls.refresh++; if (readError) throw readError; return read; },
      setHeadUpAngle: async (angle, expectedGeneration) => {
        calls.writes.push([angle, expectedGeneration]);
        if (writeError) throw writeError;
        value = `${angle}\u00b0`;
      },
    },
    '../apps/files/text-viewer': { TextViewerLayer },
    '../graphics/ui-fonts': { getDefaultSmallFont: () => ({}) },
    './menu': {
      drawRightValueMenuItem() {},
      openModalMenu: (...args) => { calls.modal = args; },
    },
  });
  const item = load('app/ui/head-up-settings.ts').headUpAngleMenuItem();
  const ctx = { stack: { push: layer => calls.pushed.push(layer), pop: () => calls.popped = true } };
  return { item, ctx, calls, TextViewerLayer };
}

test('Angle refreshes before opening all integer choices and never writes automatically', async () => {
  const h = fixture({ read: 30 });
  assert.equal(h.item.label, 'Angle');
  assert.equal(h.item.phone.kind, 'head-up-angle');
  await h.item.onSelect(h.ctx);
  assert.equal(h.calls.refresh, 1);
  assert.deepEqual(h.calls.writes, []);
  assert.equal(h.calls.modal[1], 'Angle');
  assert.equal(h.calls.modal[2].length, 61);
  assert.equal(h.calls.modal[2][0].label, '0\u00b0');
  assert.equal(h.calls.modal[2][60].label, '60\u00b0');
  assert.equal(h.calls.modal[3], 30);
});

test('Angle passes the pre-refresh generation and closes only after a confirmed write', async () => {
  const h = fixture({ read: 12 });
  await h.item.onSelect(h.ctx);
  await h.calls.modal[2][41].onSelect(h.ctx);
  assert.deepEqual(h.calls.writes, [[41, 7]]);
  assert.equal(h.calls.popped, true);
});

test('Angle shows read and write failures instead of inventing a current value', async () => {
  const unreadable = fixture({ read: null });
  await unreadable.item.onSelect(unreadable.ctx);
  assert.equal(unreadable.calls.modal, null);
  assert.equal(unreadable.calls.pushed[0] instanceof unreadable.TextViewerLayer, true);

  const readFailed = fixture({ readError: new Error('Read failed') });
  await readFailed.item.onSelect(readFailed.ctx);
  assert.equal(readFailed.calls.modal, null);
  assert.equal(readFailed.calls.pushed[0].text, 'Read failed');

  const failed = fixture({ read: 20, writeError: new Error('Disconnected') });
  await failed.item.onSelect(failed.ctx);
  await failed.calls.modal[2][21].onSelect(failed.ctx);
  assert.equal(failed.calls.popped, undefined);
  assert.equal(failed.calls.pushed[0].text, 'Disconnected');
});

test('Angle is disabled when physical head-up settings are unavailable', () => {
  const h = fixture({ available: false });
  assert.equal(h.item.disabled(), true);
});

test('GlanceHost routes head-up by master and target independently of tap and board enable', () => {
  const settings = { enabled: false, master: true, target: 'glanceboard' };
  const provider = {
    isEnabled: () => settings.enabled, showOnTap: () => false, showOnLongPress: () => false,
    showOnHeadTilt: () => settings.master, headUpTarget: () => settings.target,
  };
  const { GlanceHost } = loader({}, {
    '../graphics/image': {}, '../graphics/glyph-wire': {}, '../graphics/plane': {},
    '../native/frame-timings': {}, '../native/preview-display': {},
    '../ui/shell/geometry': {}, '../util/render-freshness': {},
    './glance-state': { GLANCE_HIDDEN: { visible: false }, glanceEventForGesture: gesture => ({ type: gesture }) },
  })('app/g2/glance-host.ts');
  const host = new GlanceHost({ getProvider: () => provider });
  assert.equal(host.eventForGesture('head-tilt').type, 'head-tilt');
  assert.equal(host.eventForGesture('click'), null);
  settings.target = 'last-app';
  assert.equal(host.eventForGesture('head-tilt'), null);
  settings.master = false;
  settings.target = 'glanceboard';
  assert.equal(host.eventForGesture('head-tilt'), null);
});
