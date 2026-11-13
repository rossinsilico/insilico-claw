const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function harness() {
  const drawn = [];
  const font = {
    lineHeight: 12,
    ascent: 10,
    descent: 2,
    measureText: (text) => text.length * 4,
    getGlyph: (codePoint) => ({ dwidthX: codePoint ? 4 : 0 }),
    drawText(image, x, y, text, value) {
      drawn.push(text);
      for (let index = 0; index < text.length; index++) image.fillRect(x + index * 4, y + 2, 2, 6, value);
    },
  };
  const load = loader({ setTimeout, clearTimeout }, {
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../../native/assistant-trace': { traceAssistantStage() {} },
    '../native/frame-timings': { spanCurrent: (_name, fn) => fn() },
    '../graphics/screen-size': { screenWidth: () => 640, screenHeight: () => 480 },
    '../gestures': { GESTURE_DOUBLE_CLICK: 'double-click', isDirectionalInput: () => false },
    './gestures': { isDirectionalInput: () => false },
    './geometry': {
      appViewportSize: () => ({ width: 576, height: 280 }),
      appViewportRect: () => ({ x: 64, y: 0, width: 576, height: 280 }),
      SHELL_OPAQUE_BLACK: 1,
    },
  });
  return {
    drawn,
    ...load('app/graphics/image.ts'),
    ...load('app/graphics/shell-scene.ts'),
    ...load('app/ui/layers.ts'),
    ...load('app/ui/shell/assistant-question.ts'),
    ...load('app/ui/shell/modal-layer.ts'),
  };
}

function prompt() {
  return {
    id: 'question-1',
    expiresAtMs: Date.now() + 60_000,
    signal: { aborted: false, addEventListener() {}, removeEventListener() {} },
    questions: [{
      questionId: 'recipient',
      header: 'Confirm recipient',
      question: 'Send the exact message to Jordan at the saved mobile number? ' + 'Preserve every word of this exact message preview. '.repeat(12),
      options: [{ label: 'Jordan mobile', value: '+15551234567', description: 'Send the message exactly as shown.' }],
    }],
  };
}

test('a raw lens-sized assistant question exceeds the shell surface cap', () => {
  const { AssistantQuestionLayer, LayerStack, encodeShellScene, noopLayerActions } = harness();
  const question = new AssistantQuestionLayer(prompt(), () => {});
  const stack = new LayerStack(question, noopLayerActions, { width: 640, height: 480 });
  try {
    assert.throws(() => encodeShellScene(stack.paint()), /exceeds 64 KiB \(624×464\)/);
  } finally {
    question.onRemoved();
  }
});

test('a modalized assistant question encodes every page within the shell surface cap', async () => {
  const {
    AssistantQuestionLayer, GrayImage, LayerStack, ShellModalLayer, drawn,
    encodeShellScene, noopLayerActions,
  } = harness();
  let answer;
  const question = new AssistantQuestionLayer(prompt(), (value) => { answer = value; });
  const modal = new ShellModalLayer(question, noopLayerActions, { removed: () => question.onRemoved() });
  const stack = new LayerStack({
    paint: () => new GrayImage(640, 480),
    handleInput() {},
  }, noopLayerActions, { width: 640, height: 480 });
  stack.push(modal);

  const paintAndEncode = () => {
    drawn.length = 0;
    const bytes = encodeShellScene(stack.paint());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint16(8, true), height = view.getUint16(10, true);
    assert.ok(5 + Math.ceil(width / 2) * height <= 65536);
    return { width, height, text: drawn.join(' ') };
  };

  try {
    const questionPage = paintAndEncode();
    assert.deepEqual([questionPage.width, questionPage.height], [548, 239]);
    assert.match(questionPage.text, /Send the exact message to Jordan/);
    await stack.handleInput({ type: 'click' });
    assert.equal(answer, undefined, 'question text cannot approve an action');

    await stack.handleInput({ type: 'scroll-down' });
    const choicePage = paintAndEncode();
    assert.match(choicePage.text, /Jordan mobile/);
    assert.match(choicePage.text, /\+15551234567/);
    await stack.handleInput({ type: 'click' });
    assert.equal(JSON.stringify(answer), '{"recipient":[0]}');
  } finally {
    stack.pop();
  }
});

test('pinned question and both choice pages encode on the real G2 modal', async () => {
  const {AssistantQuestionLayer, GrayImage, LayerStack, ShellModalLayer, drawn, encodeShellScene, noopLayerActions}=harness();
  const value=prompt();
  value.questions=[{questionId:'color',header:'Color',question:'Choose Red or Blue?',options:[{label:'Red'},{label:'Blue'}]}];
  let answer;
  const question=new AssistantQuestionLayer(value,result=>{answer=result});
  const stack=new LayerStack({paint:()=>new GrayImage(640,480),handleInput(){}},noopLayerActions,{width:640,height:480});
  stack.push(new ShellModalLayer(question,noopLayerActions,{removed:()=>question.onRemoved()}));
  const paint=()=>{
    drawn.length=0;
    assert.doesNotThrow(()=>encodeShellScene(stack.paint()));
    return drawn.join(' ');
  };
  try{
    const first=paint();
    assert.match(first,/Choose Red or Blue\?/);
    assert.match(first,/Page 1\/2/);
    assert.match(first,/Choice 1 of 2 Red/);
    await stack.handleInput({type:'scroll-down'});
    await stack.handleInput({type:'click'});
    assert.equal(answer,undefined);
    const second=paint();
    assert.match(second,/Choose Red or Blue\?/);
    assert.match(second,/Page 2\/2/);
    assert.match(second,/Choice 2 of 2 Blue/);
    await stack.handleInput({type:'click'});
    assert.equal(JSON.stringify(answer),'{"color":[1]}');
  }finally{stack.pop()}
});
