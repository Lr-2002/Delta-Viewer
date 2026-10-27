import assert from 'node:assert/strict';
import test from 'node:test';
import { clientInstallationId, currentClientVersion } from '../src/lib/client-versions.ts';

function memoryStorage() {
  const entries = new Map<string,string>();
  return { get length(){return entries.size;}, key:(index:number)=>[...entries.keys()][index]??null,
    getItem:(key:string)=>entries.get(key)??null, setItem:(key:string,value:string)=>{entries.set(key,value);},
    removeItem:(key:string)=>{entries.delete(key);}, clear:()=>entries.clear() };
}
test('installation identity survives upgrade, account switch and failed storage without deleting old keys',()=>{
  const storage=memoryStorage(),id='aabbccdd-aabb-4abb-8abb-aabbccddeeff';
  storage.setItem('delta.client-installation.v1:1.3.7',id);
  storage.setItem('delta.client-installation.v1:1.3.5','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(clientInstallationId(storage,'1.3.8'),id);
  assert.equal(clientInstallationId(storage,'1.3.9'),id);
  assert.equal(storage.getItem('delta.client-installation.v1:1.3.7'),id);
  const bad={...storage,getItem(){throw Error('disk unavailable');}};
  assert.match(clientInstallationId(bad,'1.3.8'),/^[a-f0-9-]{36}$/);
});
test('current means fresh online report, never highest historical version or stale cached response',()=>{
  const now=1_700_000_000_000;
  const clients=[{clientId:'old',version:'9.9.9',platform:'linux',online:false,lastSeenAtMs:now},
    {clientId:'new',version:'1.3.5',platform:'windows',online:true,lastSeenAtMs:now-200},
    {clientId:'other',version:'1.3.4',platform:'windows',online:true,lastSeenAtMs:now-300}];
  assert.equal(currentClientVersion(clients,now,now).current?.version,'1.3.5');
  assert.equal(currentClientVersion(clients,now,now).otherVersions,1);
  assert.equal(currentClientVersion(clients,now,now+90_001).current,null);
  assert.equal(currentClientVersion(clients,now-90_001,now).current,null);
  assert.equal(currentClientVersion([],now,now).current,null);
});
