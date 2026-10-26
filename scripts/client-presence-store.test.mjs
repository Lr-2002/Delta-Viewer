import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {openClientPresence} from './client-presence-store.mjs';

test('versions, multiple devices, offline/session expiry, durable reminders and account-owned acknowledgements',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'delta-presence-'));
  let now=1_700_000_000_000, store=openClientPresence(root,()=>now);
  const users=[{username:'alice'},{username:'bob'},{username:'legacy'}];
  const a=randomUUID(),a2=randomUUID(),b=randomUUID();
  const report=(clientId,version='1.3.3',acknowledgedIds=[])=>({clientId,version,platform:'windows',acknowledgedIds});
  try {
    store.poll('alice',report(a,'1.3.2'),'ta');now++;
    store.poll('alice',report(a2),'ta2');
    store.poll('bob',report(b),'tb');
    let data=store.overview(users,new Set(['ta','ta2','tb']));
    assert.equal(data.users[0].clients.length,2);
    assert.deepEqual(new Set(data.users[0].clients.map(c=>c.version)),new Set(['1.3.2','1.3.3']));
    assert.ok(data.users[0].clients.every(c=>c.online));
    assert.equal(data.users[2].clients.length,0,'legacy version unknown');
    assert.equal(store.overview(users,new Set()).users[0].clients[0].online,false,'logout/expired sessions offline');
    now+=90_001;
    assert.equal(store.overview(users,new Set(['ta2'])).users[0].clients[0].online,false,'stale even if token valid');
    const reminders=store.push('manager',['alice','bob']).queued;
    const aid=reminders[0].id,bid=reminders[1].id;
    assert.equal(store.push('manager',['alice']).queued[0].id,aid,'repeated clicks coalesced');
    assert.equal(store.poll('alice',report(a,'1.3.3',[bid]),'ta').reminder.id,aid,'cannot ack another user');
    store.close();store=openClientPresence(root,()=>now);
    data=store.overview(users,new Set(['ta','ta2']));
    assert.equal(data.users[0].clients[0].online,false,'restart never falsely marks saved report online');
    assert.equal(data.users[0].pendingReminder.id,aid);
    assert.equal(store.poll('alice',report(a,'1.3.3',[aid]),'ta').reminder,null);
    assert.equal(store.poll('alice',report(a,'1.3.3',[aid]),'ta').reminder,null,'ack idempotent after lost response');
    assert.equal(store.poll('bob',report(b),'tb').reminder.id,bid);
    now+=7*24*3600_000+1;
    assert.equal(store.poll('bob',report(b),'tb').reminder,null,'expired reminders not delivered');
    for(let i=0;i<25;i++){now++;store.poll('alice',report(randomUUID()),'ta');}
    assert.equal(store.overview(users,new Set(['ta'])).users[0].clients.length,16,'bounded per-account device rows');
    for(const bad of [null,{},report('bad'),{...report(a),version:'https://evil'},report(a,'1.3.3',Array(21).fill(a))]) {
      assert.throws(()=>store.poll('alice',bad,'ta'),/CLIENT_REPORT_INVALID/);
    }
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});
