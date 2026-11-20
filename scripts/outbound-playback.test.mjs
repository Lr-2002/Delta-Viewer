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
test('entering browsing while paused reports the current video position after ordinary playback',t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const states=[],players=Array.from({length:7},()=>new Decoder());
 const playback=new OutboundPlayback(s=>states.push(s),()=>assert.fail('play failed'));
 try{
  players.forEach((p,i)=>playback.attach(i,p));playback.setSpeed(8);playback.setBrowsing(true);playback.seek(38);playback.setBrowsing(false);
  players.forEach(p=>{p.currentTime=54;});playback.pause();playback.setBrowsing(true);
  assert.equal(states.at(-1).position,54,'mode toggle must not show a stale sampled position');
  playback.setSpeed(3);players.forEach(p=>{p.currentTime=72;});playback.pause();playback.setSpeed(8);
  assert.equal(states.at(-1).position,72,'crossing the sampled speed threshold has the same position contract');
 }finally{playback.dispose();}
});
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
 let now=0;t.mock.method(performance,'now',()=>now);t.mock.timers.enable({apis:['setInterval','setTimeout']});
 const states=[],players=Array.from({length:7},()=>Object.assign(new Decoder(),{ahead:60}));
 const playback=new OutboundPlayback(s=>states.push(s),()=>assert.fail('play failed'));
 try{
  players.forEach((p,i)=>playback.attach(i,p));playback.setSpeed(8);playback.play();await flush();
  const hungry=players[4];hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));
  t.mock.timers.tick(15);
  assert.equal(hungry.paused,false);assert.equal(hungry.playbackRate,2);assert.ok(players.filter(p=>p!==hungry).every(p=>p.paused));
  hungry.readyState=3;hungry.ahead=.3;hungry.dispatchEvent(new Event('canplay'));await flush();assert.equal(states.at(-1).buffering,true,'first decoded frame is not enough to thrash peers again');
  assert.ok(players.every(p=>p.paused),'recovered decoder stops consuming reserve and advancing away from held peers');
  const peer=players[2];peer.readyState=2;t.mock.timers.tick(160);await flush();assert.equal(peer.paused,false,'a held peer that loses readiness must resume decoding');assert.equal(peer.playbackRate,2);
  peer.readyState=3;peer.dispatchEvent(new Event('canplay'));await flush();assert.ok(players.every(p=>p.paused),'all recovered cameras wait together for reserve');
  hungry.ahead=16;hungry.dispatchEvent(new Event('canplay'));await flush();assert.equal(states.at(-1).buffering,false);assert.ok(players.every(p=>!p.paused&&p.playbackRate===8));
  assert.ok(players.every(p=>p.currentTime===10),'recovery never performs repeated seeks');
  hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));t.mock.timers.tick(15);hungry.readyState=3;hungry.ahead=.1;now=2600;t.mock.timers.tick(160);await flush();assert.equal(states.at(-1).buffering,false,'reserve wait is bounded even on slow links');
 }finally{playback.dispose();}
});

test('queued waiting events cannot pause cameras that have already recovered',async t=>{
 t.mock.timers.enable({apis:['setInterval','setTimeout']});
 const states=[],players=Array.from({length:7},()=>Object.assign(new Decoder(),{ahead:60}));
 const playback=new OutboundPlayback(s=>states.push(s),()=>assert.fail('play failed'));
 try{
  players.forEach((p,i)=>playback.attach(i,p));playback.setSpeed(8);playback.play();await flush();
  players[4].dispatchEvent(new Event('waiting'));await flush();
  assert.equal(states.at(-1).buffering,false,'a stale waiting event is not a new stall');
  assert.ok(players.every(p=>!p.paused&&p.playbackRate===8));
 }finally{playback.dispose();}
});

test('brief high-rate decode gaps with buffered media do not restart the seven-camera group',async t=>{
 t.mock.timers.enable({apis:['setInterval','setTimeout']});
 const states=[],players=Array.from({length:7},()=>Object.assign(new Decoder(),{ahead:60}));
 const playback=new OutboundPlayback(s=>states.push(s),()=>assert.fail('play failed'));
 try{
  players.forEach((p,i)=>playback.attach(i,p));playback.setSpeed(8);playback.play();await flush();
  const hungry=players[4];hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));
  assert.ok(players.every(p=>!p.paused&&p.playbackRate===8),'do not flush healthy decoders for a pending frame');
  t.mock.timers.tick(5);hungry.readyState=4;hungry.dispatchEvent(new Event('canplay'));t.mock.timers.tick(30);await flush();
  assert.equal(states.at(-1).buffering,false);assert.ok(players.every(p=>!p.paused&&p.playbackRate===8));
  hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));t.mock.timers.tick(15);await flush();
  assert.equal(states.at(-1).buffering,true,'a sustained decode gap still pauses peers within 0.12 media seconds');
  assert.ok(players.filter(p=>p!==hungry).every(p=>p.paused));assert.equal(hungry.playbackRate,2);
 }finally{playback.dispose();}
});

test('empty buffers hold immediately and late decode-gap callbacks cannot undo user intent',async t=>{
 t.mock.timers.enable({apis:['setInterval','setTimeout']});
 const states=[],players=Array.from({length:7},()=>Object.assign(new Decoder(),{ahead:60}));
 const playback=new OutboundPlayback(s=>states.push(s),()=>assert.fail('play failed'));
 try{
  players.forEach((p,i)=>playback.attach(i,p));playback.setSpeed(8);playback.play();await flush();
  const hungry=players[4];hungry.ahead=.1;hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));
  assert.equal(states.at(-1).buffering,true,'network starvation must not use a decode grace period');
  hungry.readyState=4;hungry.ahead=60;hungry.dispatchEvent(new Event('canplay'));await flush();
  hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));playback.pause();t.mock.timers.tick(30);await flush();
  assert.equal(states.at(-1).playing,false);assert.equal(states.at(-1).buffering,false);assert.ok(players.every(p=>p.paused));
  hungry.readyState=4;playback.play();await flush();hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));
  playback.seek(50);hungry.readyState=4;playback.play();await flush();t.mock.timers.tick(30);await flush();
  assert.equal(states.at(-1).buffering,false);assert.ok(players.every(p=>!p.paused));
  hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));playback.attach(4,null);t.mock.timers.tick(30);await flush();
  assert.equal(states.at(-1).buffering,false,'detached decoders cannot pause the current group');
 }finally{playback.dispose();}
});

test('optional browsing samples seven original sources together without queuing seeks or late resumes',async t=>{
 let now=0;t.mock.method(performance,'now',()=>now);t.mock.timers.enable({apis:['setInterval','setTimeout']});
 const states=[],players=Array.from({length:7},()=>Object.assign(new Decoder(),{ahead:60}));let seeks=0,finished=0;
 for(const p of players){let time=10;Object.defineProperty(p,'currentTime',{get:()=>time,set:v=>{time=v;p.seeking=true;seeks++;}});}
 const playback=new OutboundPlayback(s=>states.push(s),()=>assert.fail('play failed'),()=>finished++);
 const ready=()=>{players.forEach(p=>{p.seeking=false;p.readyState=4;});players[0].dispatchEvent(new Event('seeked'));};
 try{
  players.forEach((p,i)=>playback.attach(i,p));playback.setSpeed(8);playback.setBrowsing(true);playback.play();
  assert.ok(players.every(p=>p.paused),'browsing does not decode every intervening frame');
  now=320;t.mock.timers.tick(320);assert.equal(seeks,7);assert.equal(states.at(-1).position,10,'unpresented target is not counted as viewed');
  now=3000;t.mock.timers.tick(1600);assert.equal(seeks,7,'a slow camera cannot create a seek backlog');
  playback.pause();ready();now=4000;t.mock.timers.tick(320);assert.equal(seeks,7);assert.equal(states.at(-1).playing,false);
  playback.seek(20+1/30);ready();assert.ok(players.every(p=>Math.abs(p.currentTime-(20+1/30))<1e-9),'paused fine inspection retains exact seek time');
  playback.play();now=4320;t.mock.timers.tick(320);ready();assert.ok(players.every(p=>Math.abs(p.currentTime-players[0].currentTime)<1e-9));
  playback.setBrowsing(false);await flush();assert.ok(players.every(p=>!p.paused&&p.playbackRate===8),'ordinary playback resumes at selected speed');
  playback.pause();playback.setBrowsing(true);playback.setSpeed(3);playback.play();await flush();assert.ok(players.every(p=>!p.paused&&p.playbackRate===3),'1–3x remains ordinary playback');
  playback.pause();playback.setSpeed(8);playback.seek(299.8);ready();playback.play();now=4640;t.mock.timers.tick(320);ready();assert.equal(finished,1,'end is emitted only after all cameras present the final sample');
  t.mock.timers.tick(1000);assert.equal(finished,1);
 }finally{playback.dispose();}
});


test('ordinary 3x buffering recovers a paused peer that also loses decoded readiness',async t=>{
 t.mock.timers.enable({apis:['setInterval','setTimeout']});
 const states=[],players=Array.from({length:7},()=>Object.assign(new Decoder(),{ahead:60}));
 const playback=new OutboundPlayback(s=>states.push(s),()=>assert.fail('play failed'));
 try{
  players.forEach((p,i)=>playback.attach(i,p));playback.setSpeed(3);playback.play();await flush();
  const hungry=players[0],peer=players[2];hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));
  assert.equal(states.at(-1).buffering,true);assert.equal(hungry.paused,false);
  assert.equal(hungry.playbackRate,2,'recovery should not consume decoded runway at the stalled 3x rate');
  assert.ok(players.slice(1).every(p=>p.paused));
  peer.readyState=2;t.mock.timers.tick(160);await flush();
  assert.equal(peer.paused,false,'a paused decoder needs play intent to regain future data at ordinary rates too');
  hungry.readyState=4;hungry.dispatchEvent(new Event('canplay'));await flush();
  assert.equal(states.at(-1).buffering,true);assert.equal(hungry.paused,true,'recovered cameras wait for the remaining peer');
  peer.readyState=4;peer.dispatchEvent(new Event('canplay'));await flush();
  assert.equal(states.at(-1).buffering,false);assert.ok(players.every(p=>!p.paused&&p.playbackRate===3));
  assert.ok(players.every(p=>p.currentTime===10),'recovery does not seek or skip source frames');
  hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));playback.pause();
  hungry.readyState=4;hungry.dispatchEvent(new Event('canplay'));t.mock.timers.tick(160);await flush();
  assert.ok(players.every(p=>p.paused&&p.playbackRate===3),'late recovery cannot undo user pause');
 }finally{playback.dispose();}
});
