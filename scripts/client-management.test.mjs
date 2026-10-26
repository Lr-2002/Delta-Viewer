import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {request as httpsRequest} from 'node:https';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createUserCenter} from './user-center-server.mjs';
import {migrateAdminOffline} from './consolidate-admin-account.mjs';

function request(port,method,url,body,token) {
 return new Promise((resolve,reject)=>{
  const payload=body?Buffer.from(JSON.stringify(body)):null;
  const r=httpsRequest({hostname:'127.0.0.1',port,method,path:url,rejectUnauthorized:false,
   headers:{...(token?{authorization:'Bearer '+token}:{}),...(payload?{'content-type':'application/json','content-length':payload.length}:{})}},res=>{
   const parts=[];res.on('data',p=>parts.push(p));res.on('end',()=>resolve({status:res.statusCode,body:parts.length?JSON.parse(Buffer.concat(parts).toString()):null}));
  });r.on('error',reject);if(payload)r.write(payload);r.end();
 });
}
test('admin test account retains password and reviewer identity, manager authorization and one/multi/all reminder delivery survive restart',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'delta-management-')), port=17983;
 const config={schemaVersion:1,listenHost:'127.0.0.1',listenPort:port,publicBaseUrl:`https://10.1.11.200:${port}`,sessionTtlSeconds:300};
 const logger={log(){},error(){}};let service;
 const req=(method,url,body,token)=>request(port,method,url,body,token);
 try {
  service=await createUserCenter(config,root,logger);await service.start();
  assert.equal((await req('POST','/api/v1/setup',{username:'previous',displayName:'原管理',password:'original-password'})).status,201);
  const login=async(username,password='test-password')=>(await req('POST','/api/v1/auth/login',{username,password}));
  const previous=(await login('previous','original-password')).body.token;
  const reg=async username=>(await req('POST','/api/v1/auth/register',{username,displayName:username,password:'test-password'}));
  const testUser=await reg('admin'), alice=await reg('alice'), bob=await reg('bob');
  assert.equal(testUser.body.user.role,'operator');assert.equal(testUser.body.user.canManage,false,'username admin alone never grants permission');
  const at=alice.body.token,bt=bob.body.token;
  assert.equal((await req('GET','/api/v1/admin/client-versions',null,at)).status,403);
  assert.equal((await req('POST','/api/v1/admin/update-reminders',{all:true},at)).status,403);
  assert.equal((await req('POST','/api/v1/auth/register',{username:'forbidden',displayName:'forbidden',password:'test-password',managementAccess:true})).status,400);
  const bytes=await readFile(path.join(root,'users.json'));
  await service.stop();
  await assert.rejects(migrateAdminOffline({dataRoot:root,from:'previous',to:'admin'}),/Stop/);
  const migration=await migrateAdminOffline({dataRoot:root,from:'previous',to:'admin',offlineConfirmed:true});
  assert.equal((await readFile(migration.backup)).equals(bytes),true);
  const before=JSON.parse(bytes),after=JSON.parse(await readFile(path.join(root,'users.json'),'utf8'));
  for(const u of after.users)assert.deepEqual(u.password,before.users.find(x=>x.username===u.username).password);
  assert.deepEqual(after.users.filter(u=>['alice','bob'].includes(u.username)),before.users.filter(u=>['alice','bob'].includes(u.username)));
  assert.equal(after.users.find(u=>u.username==='previous').accountStatus,'paused');
  service=await createUserCenter(config,root,logger);await service.start();
  assert.equal((await login('previous','original-password')).status,403);
  const adminLogin=await login('admin');assert.equal(adminLogin.status,200);
  const manager=adminLogin.body.token;
  assert.equal(adminLogin.body.user.role,'operator');assert.equal(adminLogin.body.user.canManage,true);
  for(const url of ['/api/v1/admin/reviews','/api/v1/admin/audit','/api/v1/admin/users','/api/v1/admin/client-versions'])assert.equal((await req('GET',url,null,manager)).status,200,url);
  assert.equal((await req('POST','/api/v1/review/events',{events:[{eventId:randomUUID(),sessionId:randomUUID(),episodeKey:'a'.repeat(64),episodeName:'isolated',action:'loaded',occurredAtMs:Date.now(),elapsedMs:0,details:{}}]},manager)).status,200,'test audit stays operator-capable');
  assert.equal((await req('DELETE','/api/v1/admin/users/admin',null,manager)).status,403,'cannot delete sole manager');
  assert.equal((await req('PUT','/api/v1/admin/users/status',{usernames:['admin'],status:'paused'},manager)).status,404,'cannot pause manager');
  const aliceToken=(await login('alice')).body.token,bobToken=(await login('bob')).body.token;
  assert.equal((await req('POST','/api/v1/client/poll',{clientId:randomUUID(),version:'1.3.3',platform:'windows',acknowledgedIds:[]})).status,401);
  const aid=randomUUID(),report={clientId:aid,version:'1.3.3',platform:'windows',acknowledgedIds:[]};
  assert.equal((await req('POST','/api/v1/client/poll',report,aliceToken)).status,200);
  let overview=(await req('GET','/api/v1/admin/client-versions',null,manager)).body;
  assert.equal(overview.users.find(u=>u.username==='alice').clients[0].online,true);
  const one=await req('POST','/api/v1/admin/update-reminders',{usernames:['alice']},manager);assert.equal(one.status,200);
  const notice=one.body.queued[0].id;
  const all=await req('POST','/api/v1/admin/update-reminders',{all:true},manager);
  assert.deepEqual(all.body.queued.map(u=>u.username).sort(),['alice','bob'],'all excludes self and disabled old admin');
  assert.equal(all.body.queued.find(u=>u.username==='alice').id,notice,'one and all coalesce');
  const multi=await req('POST','/api/v1/admin/update-reminders',{usernames:['alice','bob']},manager);assert.equal(multi.body.queued.length,2);
  assert.equal((await req('POST','/api/v1/admin/update-reminders',{usernames:['absent']},manager)).status,400);
  await req('POST','/api/v1/auth/logout',{},aliceToken);
  overview=(await req('GET','/api/v1/admin/client-versions',null,manager)).body;
  assert.equal(overview.users.find(u=>u.username==='alice').clients[0].online,false);
  await service.stop();service=await createUserCenter(config,root,logger);await service.start();
  const nextAlice=(await login('alice')).body.token,nextBob=(await login('bob')).body.token;
  const pending=await req('POST','/api/v1/client/poll',report,nextAlice);assert.equal(pending.body.reminder.id,notice);
  const other=await req('POST','/api/v1/client/poll',{...report,acknowledgedIds:[notice]},nextBob);assert.ok(other.body.reminder);
  assert.equal((await req('POST','/api/v1/client/poll',report,nextAlice)).body.reminder.id,notice,'other account cannot remove reminder');
  assert.equal((await req('POST','/api/v1/client/poll',{...report,acknowledgedIds:[notice]},nextAlice)).body.reminder,null);
 } finally {if(service)await service.stop();await rm(root,{recursive:true,force:true});}
});
