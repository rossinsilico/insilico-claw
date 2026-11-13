const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function harness() {
  let now = 0;
  const load = loader({ Date: class extends Date { static now() { return now; } } }, {
    '../native/frame-timings': { spanCurrent: (_name, fn) => fn() },
    '../graphics/screen-size': { screenWidth: () => 640, screenHeight: () => 480 },
    '../gestures': { isDirectionalInput: () => false },
    './gestures': { isDirectionalInput: () => false },
    './geometry': {
      appViewportSize: () => ({ width: 576, height: 280 }),
      appViewportRect: () => ({ x: 64, y: 0, width: 576, height: 280 }),
      SHELL_OPAQUE_BLACK: 1,
    },
  });
  return { setNow(value) { now = value; },
    ...load('app/graphics/image.ts'), ...load('app/graphics/display-list.ts'),
    ...load('app/graphics/shell-scene.ts'), ...load('app/ui/layers.ts'),
    ...load('app/ui/shell/modal-layer.ts'),
  };
}

test('one encoded notification frame expires on the retained clock, without host repaint', () => {
  const h = harness();
  const modal = new h.ShellModalLayer({
    paint: ctx => new h.GrayImage(ctx.stack.getBaseSize().width, ctx.stack.getBaseSize().height, 240),
    handleInput() {},
  }, h.noopLayerActions, { expiration: () => ({ token: 1, startedAt: 0, durationMs: 5000 }) });
  const stack = new h.LayerStack({ paint: () => new h.GrayImage(640, 480), handleInput() {} }, h.noopLayerActions, { width: 640, height: 480 });
  stack.push(modal);
  const bytes = h.encodeShellScene(stack.paintUndimmed());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint16(0, true), 1);
  const w = view.getUint16(8, true), height = view.getUint16(10, true);
  assert.equal(view.getUint16(14, true), 1, 'retained-only modal must survive scene encoding');
  assert.ok(view.getUint16(4, true) >= 640, 'empty carrier must not cover underlying content');
  const decoded = h.readDisplayList(bytes, 18 + w * height, 0).placed;
  for (const elapsed of [0, 4999, 5000, 6000]) {
    const screen = new Uint8Array(640 * 480).fill(32), output = screen.slice();
    h.paintDisplayList(output, screen, 640, 480, decoded, false, elapsed);
    assert.equal(output[20 * 640 + 90], elapsed < 5000 ? 240 : 32, `elapsed=${elapsed}`);
    assert.equal(output[0], 32, 'surrounding app is untouched');
  }
});

test('indefinite and covered notification modals retain their ordinary static surface', () => {
  const h = harness();
  const modal = new h.ShellModalLayer({ paint: () => new h.GrayImage(540, 231, 240), handleInput() {} }, h.noopLayerActions, { expiration: () => null });
  const image = modal.paint({}, () => new h.GrayImage(640, 480));
  assert.equal(image.pixels[20 * 640 + 90], 240);
  assert.equal(image.draws.length, 0);
});

test('repainting preserves elapsed expiry and interaction resets the actual encoded timeline', () => {
  const h = harness();
  let timing = { token: 1, startedAt: 0, durationMs: 5000 };
  const modal = new h.ShellModalLayer({ paint: () => new h.GrayImage(540, 231, 240), handleInput() {} }, h.noopLayerActions, { expiration: () => timing });
  const encode = now => {
    h.setNow(now);
    const image = modal.paint({}, () => new h.GrayImage(640, 480));
    const bytes = h.encodeShellScene([{ image, x: 0, y: 0, shellKey: 1 }]);
    return h.readDisplayList(bytes, 19, now).placed;
  };
  const pixelAt = (placed, now) => {
    const screen = new Uint8Array(640 * 480).fill(32), output = screen.slice();
    h.paintDisplayList(output, screen, 640, 480, placed, false, now);
    return output[20 * 640 + 90];
  };
  const initial = encode(0), repaint = encode(4000);
  assert.equal(repaint.displayList.timeline.token, initial.displayList.timeline.token);
  assert.equal(pixelAt(repaint, 4999), 240);
  assert.equal(pixelAt(repaint, 5000), 32);
  timing = { token: 2, startedAt: 4000, durationMs: 5000 };
  const reset = encode(4000);
  assert.notEqual(reset.displayList.timeline.token, initial.displayList.timeline.token);
  assert.equal(pixelAt(reset, 5000), 240);
  assert.equal(pixelAt(reset, 8999), 240);
  assert.equal(pixelAt(reset, 9000), 32);
});
