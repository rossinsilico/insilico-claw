const test=require('node:test');
const assert=require('node:assert/strict');
const {loader}=require('./helpers/load-typescript.cjs');

function boot(background){
  const calls=[],events=new Map();let frame;
  const app={sharedApplication:{applicationState:background?2:0}};
  class Frame {constructor(){frame=this;}navigate(options){calls.push(options.moduleName??'placeholder');}}
  loader({FaceclawConfigPort:{processPendingRequest:()=>calls.push('config')},UIApplication:app,
    UIApplicationState:{Background:2},setTimeout:fn=>fn()}, {
    '@nativescript/core':{Frame,Page:class{},Application:{resumeEvent:'resume',launchEvent:'launch',on:(key,fn)=>events.set(key,fn),run:entry=>{calls.push('run');entry.create();}}},
    './health/ring-session.ios':{initializeIosRingBackground:()=>calls.push('register-ring')},
    './apps/evenhub/bundled-apps':{ensureBundledEvenHubApps:()=>calls.push('packages')},
    './phone-ui/onboarding-register.ios':{},
    './phone-ui/onboarding-state':{hasCompletedOnboarding:()=>true},
    './analytics/analytics-sources':{startAppAnalytics:()=>calls.push('analytics')},
  })('app/bootstrap.ios.ts');
  return{calls,frame,resume:()=>{app.sharedApplication.applicationState=0;events.get('resume')?.();}};
}

test('cold background bootstrap registers ring work before run and defers interactive packages/pages/analytics',()=>{
  const b=boot(true);
  assert.ok(b.calls.indexOf('register-ring')<b.calls.indexOf('run'));
  assert.equal(b.calls.includes('packages'),false);assert.equal(b.calls.includes('analytics'),false);
  assert.equal(b.calls.includes('phone-ui/main-page'),false);
  b.resume();assert.ok(b.calls.includes('phone-ui/main-page'));
  b.resume();assert.equal(b.calls.filter(x=>x==='phone-ui/main-page').length,1);
});

test('ordinary foreground launch retains packages, onboarding routing and one interactive view',()=>{
  const b=boot(false);
  assert.ok(b.calls.includes('packages'));assert.ok(b.calls.includes('phone-ui/main-page'));
  assert.equal(b.calls.filter(x=>x==='register-ring').length,1);
});
