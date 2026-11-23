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
test('a stationary group reports its exact position once and cannot restart from late readiness', async t=>{
 let now=0;
 t.mock.method(performance,'now',()=>now);
 t.mock.timers.enable({apis:['setInterval','setTimeout']});
 const players=Array.from({length:7},()=>Object.assign(new Decoder(),{ahead:60}));
 const states=[];
 let stalls=0;
 const playback=new OutboundPlayback(state=>states.push(state),()=>assert.fail('play failed'),()=>assert.fail('unexpected end'),position=>{assert.equal(position,30);stalls++;});
 try {
  players.forEach((player,index)=>playback.attach(index,player));
  playback.setSpeed(3);
  playback.play();
  await flush();
  now=11900;
  players.forEach(player=>{player.currentTime=30;});
  t.mock.timers.tick(160);
  const camera=players[3];
  camera.readyState=2;
  camera.ahead=0;
  camera.dispatchEvent(new Event('waiting'));
  now=12900;
  t.mock.timers.tick(160);
  assert.equal(stalls,0,'recent playback progress keeps a short buffer wait alive');
  now=23900;
  t.mock.timers.tick(160);
  assert.equal(stalls,1);
  assert.deepEqual(states.at(-1),{playing:false,buffering:false,position:30,duration:300});
  assert.ok(players.every(player=>player.paused));
  camera.readyState=4;
  camera.ahead=60;
  camera.dispatchEvent(new Event('canplay'));
  now=26000;
  t.mock.timers.tick(160);
  assert.equal(stalls,1);
  assert.ok(players.every(player=>player.paused),'late readiness cannot resume the timed-out attempt');
  playback.play();
  await flush();
  assert.ok(players.every(player=>!player.paused&&player.currentTime===30));
 } finally {playback.dispose();}
});

test('1x and 2x absorb brief decode gaps; sustained shortages pause and refill together',async t=>{
 let now=0;
 t.mock.method(performance,'now',()=>now);
 t.mock.timers.enable({apis:['setInterval','setTimeout']});
 const states=[],players=Array.from({length:7},()=>Object.assign(new Decoder(),{networkState:2}));
 const playback=new OutboundPlayback(state=>states.push(state),()=>assert.fail('play failed'));
 try {
  players.forEach((player,index)=>playback.attach(index,player));
  for(const speed of [1,2]){
   const camera=players[4];
   playback.setSpeed(speed);playback.play();await flush();
   camera.readyState=2;camera.dispatchEvent(new Event('waiting'));
   assert.ok(players.every(p=>!p.paused),'the other cameras stay running during a short decode gap');
   t.mock.timers.tick(20);camera.readyState=4;camera.dispatchEvent(new Event('canplay'));
   t.mock.timers.tick(60);assert.equal(states.at(-1).buffering,false);
   camera.ahead=.05;camera.readyState=2;camera.dispatchEvent(new Event('waiting'));
   assert.equal(states.at(-1).buffering,true);
   camera.readyState=3;camera.dispatchEvent(new Event('canplay'));await flush();
   assert.ok(players.every(p=>p.paused),'one frame does not immediately restart and drain an active transfer');
   now+=300;camera.ahead=speed;camera.dispatchEvent(new Event('canplay'));await flush();
   assert.ok(players.every(p=>p.paused),'a brief delivery burst leaves too little runway to resume safely');
   camera.ahead=1.3*speed;camera.dispatchEvent(new Event('canplay'));await flush();
   assert.ok(players.every(p=>!p.paused&&p.currentTime===10&&p.playbackRate===speed));
   playback.pause();camera.ahead=4;
  }
 } finally {playback.dispose();}
});

test('opening a new part keeps its already-decoded first frames',t=>{
 t.mock.timers.enable({apis:['setInterval']});
 const playback=new OutboundPlayback(()=>{},()=>assert.fail('play failed'));
 const times=[];
 try{
  for(let i=0;i<7;i++){
   const player=new Decoder();let at=0;
   Object.defineProperty(player,'currentTime',{get:()=>at,set:value=>{times.push(value);at=value;}});
   playback.attach(i,player);
  }
  playback.seek(0);
  assert.deepEqual(times,[],'the new MP4 is already at zero; do not flush its prepared frames');
  playback.seek(42);
  assert.deepEqual(times,Array(7).fill(42),'reconnecting mid-part still restores the saved position');
 }finally{playback.dispose();}
});

test('a superseded play promise cannot block a ready group or fail a later attempt',async t=>{
 t.mock.timers.enable({apis:['setInterval','setTimeout']});
 const states=[],players=Array.from({length:7},()=>new Decoder());
 const playback=new OutboundPlayback(state=>states.push(state),()=>assert.fail('superseded play failed'));
 let rejectOld;
 const nativePlay=players[2].play.bind(players[2]);
 players[2].play=()=>{players[2].play=nativePlay;players[2].paused=false;return new Promise((_,reject)=>{rejectOld=reject;});};
 try{
  players.forEach((player,index)=>playback.attach(index,player));
  playback.play();await flush();
  const hungry=players[1];hungry.ahead=0;hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));
  assert.equal(states.at(-1).buffering,true);
  hungry.ahead=4;hungry.readyState=4;hungry.dispatchEvent(new Event('canplay'));await flush();
  assert.ok(players.every(p=>!p.paused),'all seven resume before the first promise settles');
  rejectOld(new Error('old decoder failed'));await flush();
  assert.equal(states.at(-1).playing,true);
 } finally {playback.dispose();}
});
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
  const hungry=players[0],peer=players[2];hungry.ahead=.1;hungry.readyState=2;hungry.dispatchEvent(new Event('waiting'));
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

test('3x coalesces a short decoded-frame gap but immediately holds when bytes are missing',async t=>{
 t.mock.timers.enable({apis:['setInterval','setTimeout']});
 const states=[],players=Array.from({length:7},()=>Object.assign(new Decoder(),{ahead:60}));
 const playback=new OutboundPlayback(s=>states.push(s),()=>assert.fail('play failed'));
 try{
  players.forEach((p,i)=>playback.attach(i,p));playback.setSpeed(3);playback.play();await flush();
  const camera=players[5];camera.readyState=2;camera.dispatchEvent(new Event('waiting'));
  assert.equal(states.at(-1).buffering,false,'a pending frame with ample compressed media does not flush six healthy decoders');
  t.mock.timers.tick(20);camera.readyState=4;camera.dispatchEvent(new Event('canplay'));t.mock.timers.tick(40);await flush();
  assert.ok(players.every(p=>!p.paused&&p.playbackRate===3));
  camera.readyState=2;camera.dispatchEvent(new Event('waiting'));t.mock.timers.tick(30);await flush();
  assert.equal(states.at(-1).buffering,true,'a sustained decoder stall is still bounded');
  camera.readyState=4;camera.dispatchEvent(new Event('canplay'));await flush();
  camera.ahead=.1;camera.readyState=2;camera.dispatchEvent(new Event('waiting'));
  assert.equal(states.at(-1).buffering,true,'network starvation never gets a decode grace period');
  playback.pause();t.mock.timers.tick(100);assert.equal(states.at(-1).playing,false);
 }finally{playback.dispose();}
});
