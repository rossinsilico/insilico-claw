const test=require('node:test');
const assert=require('node:assert/strict');
const {loader}=require('./helpers/load-typescript.cjs');

test('assistant connection trace retains only bounded stage names and numeric counters',()=>{
  let contents='';
  const load=loader({}, {'@nativescript/core':{
    File:{exists:()=>false,fromPath:()=>({writeTextSync:text=>{contents=text}})},
    knownFolders:{documents:()=>({path:'/documents'})},path:{join:(...parts)=>parts.join('/')},
  }});
  const {traceAssistantStage}=load('app/native/assistant-trace.ios.ts');
  traceAssistantStage('sse.first-line',241);
  assert.match(contents,/sse.first-line 241/);
  traceAssistantStage('Authorization: Bearer private-key');
  traceAssistantStage('question.received','secret prompt');
  assert.doesNotMatch(contents,/private-key|secret prompt|Authorization/);
  for(let i=0;i<220;i++)traceAssistantStage('input.scan',i);
  assert.equal(contents.trim().split('\n').length,200);
  assert.match(contents,/input.scan 219/);
});
