import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=ts.transpileModule(readFileSync(new URL('../src/lib/outbound-video-loader.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {OutboundVideoLoader}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('rapid recording changes share four in-flight tickets, drop superseded queues and release late results',async()=>{
 const pending=[],calls=[],loaded=[],released=[],errors=[],completed=[];
 let active=0,peak=0;
 const loader=new OutboundVideoLoader(url=>released.push(url));
 const request=item=>{calls.push(item);active++;peak=Math.max(peak,active);return new Promise((resolve,reject)=>pending.push({item,resolve:url=>{active--;resolve(url)},reject:error=>{active--;reject(error)}}));};
 const select=recording=>loader.replace(Array.from({length:7},(_,camera)=>`${recording}:${camera}`),request,(item,url)=>loaded.push({item,url}),(item,error)=>errors.push({item,error}),()=>completed.push(recording));
 select('first');await flush();assert.equal(calls.length,4);
 for(let i=0;i<100;i++)select('superseded-'+i);
 select('last');await flush();assert.equal(calls.length,4,'rapid clicks do not enqueue native IPC for discarded recordings');
 for(const item of pending.splice(0))item.resolve('url:'+item.item);
 await flush();assert.equal(calls.length,8);assert.equal(released.length,4);assert.equal(loaded.length,0);
 for(const item of pending.splice(0))item.resolve('url:'+item.item);
 await flush();for(const item of pending.splice(0))item.resolve('url:'+item.item);
 await flush();assert.equal(peak,4);assert.equal(calls.length,11);assert.equal(loaded.length,7);assert.deepEqual(errors,[]);assert.deepEqual(completed,['last']);
 select('closed');await flush();loader.cancel();for(const item of pending.splice(0))item.resolve('url:'+item.item);
 await flush();assert.equal(released.length,8);assert.equal(loaded.length,7);assert.equal(calls.length,15);
});
test('a failed camera is reported once and cannot block the next recording',async()=>{
 const loader=new OutboundVideoLoader(()=>{}),failed=[],loaded=[];let done=0;
 loader.replace([0,1,2,3,4],async item=>{if(item===2)throw Error('synthetic');return String(item)},(item)=>loaded.push(item),(item)=>failed.push(item),()=>done++);
 await flush();await flush();assert.deepEqual(failed,[2]);assert.deepEqual(loaded.sort(),[0,1,3,4]);assert.equal(done,1);
});

test('a pending play promise from a retired recording cannot block the next recording',async()=>{
 const code=ts.transpileModule(readFileSync(new URL('../src/lib/outbound-playback.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
 const {OutboundPlayback}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 class Player extends EventTarget {
   currentTime=0;duration=10;readyState=4;ended=false;seeking=false;playbackRate=1;calls=0;
   buffered={length:1,start:()=>0,end:()=>10};
   play(){this.calls++;return new Promise(()=>{});}
   pause(){}
 }
 const transport=new OutboundPlayback(()=>{},()=>assert.fail('unexpected playback failure'));
 try {
   const old=new Player();transport.attach(0,old);transport.play();assert.equal(old.calls,1);
   transport.pause();transport.attach(0,null);
   const next=new Player();transport.attach(0,next);transport.play();
   assert.equal(next.calls,1,'the next recording starts even when the old WebView2 play promise never settles');
 }finally{transport.dispose();}
});
