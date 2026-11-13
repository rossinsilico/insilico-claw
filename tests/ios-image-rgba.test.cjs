const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

test('iOS image decoding uses the shared packet parser without resolving its own platform module', () => {
  const packet = new Uint8Array([2, 0, 1, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const image = loader({
    FaceclawGraphics: { rgbaPacketFromImageData: () => packet },
  }, {
    './kotlin-data': { toData: bytes => bytes, fromData: bytes => bytes },
    // NativeScript resolves ./image-rgba from image-rgba.ios.ts back to the
    // platform file itself, whose exports are incomplete during evaluation.
    './image-rgba': {},
  })('app/native/image-rgba.ios.ts').decodeImageRgba(new Uint8Array([9]));

  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
  assert.deepEqual(Array.from(image.rgba), [1, 2, 3, 4, 5, 6, 7, 8]);
});
