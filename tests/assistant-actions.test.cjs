const test=require('node:test');
const assert=require('node:assert/strict');
const {loader}=require('./helpers/load-typescript.cjs');

test('completed assistant replies default to Follow-up with Done one scroll below',()=>{
  let rows,followUps=0,closed=0;
  const menu={selectedIndex:0,select(index){this.selectedIndex=index},handleInput(event){this.selectedIndex=event.type==='scroll-down'?1:0}};
  const load=loader({}, {'./input-dialog':{createInputDialogMenu:value=>{rows=value;return menu},paintInputDialog(){}}});
  const {AssistantLayer}=load('app/ui/shell/assistant.ts');
  const layer=new AssistantLayer({requestRender(){}},{onFollowUp:()=>followUps++,onClose:()=>closed++,onCancel(){}});
  layer.onTextDelta('', 'Reply');layer.onTurnDone();
  layer.handleInput({type:'click'},{});
  assert.equal(followUps,1);
  assert.equal(closed,0);
  assert.deepEqual(Array.from(rows,row=>row.label),['Follow-up','Done']);
  layer.handleInput({type:'scroll-down'},{});layer.handleInput({type:'click'},{});
  assert.equal(closed,1);
  layer.onError('Synthetic failure');layer.handleInput({type:'click'},{});
  assert.equal(followUps,2,'error recovery also starts at Follow-up');
  layer.handleInput({type:'double-click'},{});
  assert.equal(closed,2,'double-click still exits directly');
});
