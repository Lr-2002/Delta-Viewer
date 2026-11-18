import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=ts.transpileModule(readFileSync(new URL('../src/lib/outbound-playback.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {OutboundPlayback}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
class Decoder extends EventTarget {
  currentTime=10;duration=300;readyState=4;ended=false;seeking=false;paused=true;playbackRate=1;defaultPlaybackRate=1;ahead=4;
  get buffered(){return {length:1,start:()=>0,end:()=>this.currentTime+this.ahead};}
  play(){this.paused=false;return Promise.resolve();}pause(){this.paused=true;}
}
test('speed increase reserves a lead and cancelling buffering never starts late',async t=>{
 let now=0;t.mock.method(performance,'now',()=>now);t.mock.timers.enable({apis:['setInterval']});
 const states=[],players=Array.from({length:7},()=>new Decoder());
 const playback=new OutboundPlayback(s=>states.push(s),()=>assert.fail('play failed'));
 try{
  players.forEach((p,i)=>playback.attach(i,p));playback.play();await flush();assert.ok(players.every(p=>!p.paused));
  playback.setSpeed(8);assert.equal(states.at(-1).buffering,true);assert.ok(players.every(p=>p.paused));
  now=500;t.mock.timers.tick(160);assert.ok(players.every(p=>p.paused),'insufficient high-speed buffer does not resume');
  playback.pause();players.forEach(p=>p.ahead=60);now=5000;t.mock.timers.tick(160);await flush();assert.ok(players.every(p=>p.paused),'late buffer cannot undo pause');
  playback.play();await flush();assert.ok(players.every(p=>!p.paused&&p.playbackRate===8));
 }finally{playback.dispose();}
});
test('starved high-speed decoder recovers without consuming at 8x; group waits for buffer and restores requested rate',async t=>{
 let now=0;t.mock.method(performance,'now',()=>now);t.mock.timers.enable({apis:['setInterval']});
 const states=[],players=Array.from({length:7},()=>Object.assign(new Decoder(),{ahead:60}));
 const playback=new OutboundPlayback(s=>states.push(s),()=>assert.fail('play failed'));
 try{
  players.forEach((p,i)=>playback.attach(i,p));playback.setSpeed(8);playback.play();await flush();
  const hungry=players[4];hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));
  assert.equal(hungry.paused,false);assert.equal(hungry.playbackRate,2);assert.ok(players.filter(p=>p!==hungry).every(p=>p.paused));
  hungry.readyState=3;hungry.ahead=.3;hungry.dispatchEvent(new Event('canplay'));await flush();assert.equal(states.at(-1).buffering,true,'first decoded frame is not enough to thrash peers again');
  hungry.ahead=16;hungry.dispatchEvent(new Event('canplay'));await flush();assert.equal(states.at(-1).buffering,false);assert.ok(players.every(p=>!p.paused&&p.playbackRate===8));
  assert.ok(players.every(p=>p.currentTime===10),'recovery never performs repeated seeks');
  hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));hungry.readyState=3;hungry.ahead=.1;now=2600;t.mock.timers.tick(160);await flush();assert.equal(states.at(-1).buffering,false,'reserve wait is bounded even on slow links');
 }finally{playback.dispose();}
});
