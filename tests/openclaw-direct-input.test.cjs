const test=require('node:test');
const assert=require('node:assert/strict');
const {loader}=require('./helpers/load-typescript.cjs');
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('iOS OpenClaw establishes confirmation surface before HTTP and closes it after the original turn',async()=>{
  const streams=[],clients=[],errors=[];
  let release;
  const load=loader({global:{isIOS:true},setTimeout,clearTimeout},{
    '../native/local-llm':{streamLocalModel:()=>assert.fail('local')},
    '../native/openai-chat':{streamOpenAiCompatibleChat:options=>{streams.push(options);return {cancel(){}}}},
    './openclaw-input-client':{OpenClawInputClient:class {
      constructor(options){this.options=options;this.ended=0;this.closed=false;clients.push(this)}
      connect(){return new Promise(resolve=>{release=()=>resolve('conn-1')})}
      bindRun(...args){this.bound=args} endRun(){this.ended++} close(){this.closed=true}
    }},
  });
  const {DirectAssistantBackend}=load('app/assistant/direct-backend.ts');
  const onQuestion=async()=>null;
  const handle=new DirectAssistantBackend().runTurn({provider:'openai-compatible',apiKey:'fixture',baseUrl:'https://private/v1',model:'openclaw/main',sessionId:'user-1',messages:[],system:'',buildTools:()=>[],registry:{},resolveToolName:x=>x,
    callbacks:{onQuestion,onTextDelta(){},onToolActivity(){},onError:e=>errors.push(e),onTurnDone(){}}});
  await flush();assert.equal(streams.length,0);assert.equal(clients.length,1);
  release();await flush();assert.equal(streams.length,1);
  assert.equal(streams[0].inputConnectionId,'conn-1');
  streams[0].onOpenClawRun('run-1','session-1','conn-1');assert.deepEqual(clients[0].bound,['run-1','session-1','conn-1']);
  streams[0].onDone({text:'Done',content:[],stopReason:'end_turn'});
  assert.equal(clients[0].closed,true);assert.deepEqual(errors,[]);handle.cancel();
});
