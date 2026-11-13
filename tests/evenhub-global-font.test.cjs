const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loader } = require('./helpers/load-typescript.cjs');

const bdf = loader({}, { '@nativescript/core': { knownFolders: {} } })('app/graphics/bdffont.ts').BdfFont;
const font = (size) => bdf.parse(fs.readFileSync(`app/fonts/terminus/ter-u${size}n.bdf`, 'utf8'));

function fontFixture() {
  const normal = font(12);
  const large = font(20);
  const explicit = font(16);
  const stock = {
    lineHeight: 27,
    measureLine: (text) => text.length * 11,
    wrap: (text) => [text],
    drawText() {},
  };
  let selected = normal;
  let revision = 0;
  let globalReads = 0;
  const fonts = loader({}, {
    '../../graphics/evenhub-font': { EvenHubFont: { get: () => stock } },
    '../../graphics/ui-fonts': {
      getDefaultSmallFont: () => { globalReads++; return selected; },
      getUiFontRevision: () => revision,
    },
    '../../graphics/bdffont': { getTerminusFont: () => null, TERMINUS_SIZES: [12, 14, 16, 18, 20] },
    '../../graphics/ttf-font': { TtfFont: { load: (path, size) => path === '/fonts/Inter.ttf' && size === 16 ? explicit : null } },
    '../../graphics/installed-fonts': { listInstalledFonts: () => [{ family: 'Inter', weightOrder: 400, monospace: false, path: '/fonts/Inter.ttf' }] },
  })('app/apps/evenhub/fonts.ts');
  return {
    fonts,
    normal,
    large,
    explicit,
    stock,
    useLarge: () => { selected = large; },
    bumpRevision: () => { revision++; },
    globalReads: () => globalReads,
  };
}

test('unstyled containers measure, wrap, and draw with the current global font', () => {
  const h = fontFixture();
  const normalFace = h.fonts.containerFace(undefined);
  const normalText = 'global font';
  const normalDraws = [];

  assert.equal(normalFace.lineHeight, h.normal.lineHeight);
  assert.equal(normalFace.measureLine(normalText), h.normal.measureText(normalText));
  assert.deepEqual(Array.from(normalFace.wrap(normalText, h.normal.measureText('global'))), ['global', 'font']);
  normalFace.drawText({ drawGlyph: (...args) => normalDraws.push(args) }, 2, 3, normalText, 177);
  assert.equal(normalDraws.length, normalText.length);
  assert.equal(normalDraws[0][0], h.normal);
  assert.deepEqual({ ...h.fonts.measureContainerText(`${normalText}\nwide`, undefined) }, {
    width: Math.max(h.normal.measureText(normalText), h.normal.measureText('wide')),
    lineHeight: h.normal.lineHeight,
    revision: 0,
  });

  const wrapped = h.fonts.measureContainerText(normalText, undefined, h.normal.measureText('global'));
  assert.deepEqual({ ...wrapped, lines: Array.from(wrapped.lines) }, {
    width: h.normal.measureText(normalText),
    lineHeight: h.normal.lineHeight,
    revision: 0,
    lines: ['global', 'font'],
  });

  h.useLarge();
  h.bumpRevision();
  const largeFace = h.fonts.containerFace(undefined);
  assert.equal(largeFace.lineHeight, h.large.lineHeight);
  assert.equal(largeFace.measureLine(normalText), h.large.measureText(normalText));
  assert.deepEqual({ ...h.fonts.measureContainerText(normalText, undefined) }, {
    width: h.large.measureText(normalText), lineHeight: h.large.lineHeight, revision: 1,
  });
  assert.equal(h.globalReads(), 5, 'the global face is resolved on every request, not cached here');
});

test('explicit fonts keep extension semantics, including the stock EvenHub escape hatch', () => {
  const h = fontFixture();
  const explicit = h.fonts.containerFace({ family: 'Inter', size: 16 });
  assert.equal(explicit.lineHeight, h.explicit.lineHeight);
  assert.equal(explicit.measureLine('styled'), h.explicit.measureText('styled'));
  assert.equal(h.fonts.containerFace({ family: 'EvenHub', size: 40 }), h.stock);
  assert.equal(h.globalReads(), 0, 'explicit fonts never consult the global selection');
});

test('an image-only page remains font-independent', () => {
  class Image {
    constructor(width, height, fill) {
      this.width = width;
      this.height = height;
      this.pixels = new Uint8Array(width * height).fill(fill);
    }
    bitBlt(source, x, y, options) {
      for (let row = 0; row < options.height; row++) {
        for (let col = 0; col < options.width; col++) {
          this.pixels[(y + row) * this.width + x + col] = source.pixels[row * source.width + col];
        }
      }
    }
    bakeDeferredDrawsWithin() {}
  }
  const { compositePage } = loader({}, {
    '../../graphics/image': { GrayImage: Image },
    './fonts': { containerFace: () => { throw new Error('image rendering resolved a font'); } },
    './containers': { borderGrey: () => 0, paintOrder: (containers) => containers },
    './list-menu': { paintListItems() {} },
  })('app/apps/evenhub/compositor.ts');
  const image = compositePage({ containers: [{
    kind: 'image', x: 1, y: 1, width: 2, height: 1,
    pixels: Uint8Array.from([41, 92]), pixelsWidth: 2, pixelsHeight: 1,
  }] }, { width: 4, height: 3 }, false);
  assert.deepEqual(Array.from(image.pixels), [0, 0, 0, 0, 0, 41, 92, 0, 0, 0, 0, 0]);
});
