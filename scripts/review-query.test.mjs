import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { request as httpsRequest } from "node:https";
import test from "node:test";
import { openReviewAuditStore } from "./review-audit-store.mjs";
import { openReviewQueries } from "./review-query-service.mjs";
import { createUserCenter } from "./user-center-server.mjs";

test("incremental summary matches original events through batch boundaries, duplicate/late events, filters and restart",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"delta-review-summary-"));
  const accounts=[{username:"alice",displayName:"Alice",role:"operator"},{username:"bob",displayName:"Bob",role:"operator"}];
  const source=openReviewAuditStore(root);let reader;
  const start=Date.now()-100000,sessions=Array.from({length:30},()=>randomUUID());
  const actions=["loaded","heartbeat","seek","focus","blur","approved","rejected","saved","label_add","label_delete","source_written"];
  const event=i=>({eventId:randomUUID(),sessionId:sessions[i%30],episodeKey:"a".repeat(64),episodeName:"isolated",action:actions[i%actions.length],occurredAtMs:start+i,elapsedMs:i%10000,details:{}});
  const compare=(a,b)=>{
    assert.equal(a.total,b.total);assert.deepEqual(a.events,b.events);
    const keys=["username","operations","approved","rejected","seeks","labelsAdded","labelsDeleted","averageMs","lastActivityAtMs","completed","completedApproved","completedRejected","pendingNas","nasConfirmed"];
    const pick=u=>Object.fromEntries(keys.map(k=>[k,u[k]]));assert.deepEqual(a.users.map(pick),b.users.map(pick));
    assert.deepEqual(a.sessions,b.sessions);assert.equal(a.nextSessionBefore,b.nextSessionBefore);
  };
  try {
    for(let i=0;i<20040;i+=20)source.append(accounts[0],Array.from({length:20},(_,j)=>event(i+j)));
    const e=event(20041);e.action="approved";e.details.value=JSON.stringify({schema:"delta.review-receipt.v1",storage:"local",submissionId:e.eventId,identityKey:"b".repeat(64),channel:"action"});
    source.append(accounts[1],[e]);source.append(accounts[1],[e]);
    reader=openReviewAuditStore(root,{readOnly:true});compare(reader.query({},accounts),source.query({},accounts));
    for(const input of [{before:"500"},{sessionBefore:"200"},{username:"bob"},{action:"seek"},{fromMs:String(start+19000)}])compare(reader.query(input,accounts),source.query(input,accounts));
    const ack=event(20042);ack.action="source_written";ack.details.value=e.details.value;
    source.append(accounts[1],[ack]);compare(reader.query({},accounts),source.query({},accounts));
    assert.equal(reader.query({},accounts).users[1].nasConfirmed,1);
    const revoke={...event(20043),action:"saved"};revoke.details.value=JSON.stringify({...JSON.parse(e.details.value),submissionId:revoke.eventId});
    source.append(accounts[1],[revoke]);reader.close();reader=openReviewAuditStore(root,{readOnly:true});compare(reader.query({},accounts),source.query({},accounts));
    assert.equal(reader.query({},accounts).users[1].completed,0);
    assert.throws(()=>reader.query({sessionBefore:"1.5"},accounts),/INVALID/);
  }finally{reader?.close();source.close();await rm(root,{recursive:true,force:true});}
});

test("HTTPS remains available for health, login, versions and receipts while statistics are deliberately CPU-bound",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"delta-https-read-worker-")),port=17986;
  const workerFile=path.join(root,"slow.mjs");
  await writeFile(workerFile,`import{parentPort}from'node:worker_threads';parentPort.on('message',m=>{const until=Date.now()+1200;while(Date.now()<until){};parentPort.postMessage({id:m.id,result:{events:[],users:[],sessions:[],total:0,generatedAtMs:Date.now()}})});`);
  const service=await createUserCenter({schemaVersion:1,listenHost:"127.0.0.1",listenPort:port,publicBaseUrl:`https://10.1.41.17:${port}`,tlsAlternativeHosts:["delta-worker.local"],sessionTtlSeconds:300},root,{log(){},error(){}},{reviewQueryOptions:{workerUrl:pathToFileURL(workerFile)}});
  const ca=await import("node:fs/promises").then(fs=>fs.readFile(path.join(root,"tls/ca.crt")));
  const req=(method,url,body,token)=>new Promise((resolve,reject)=>{
    const data=body?Buffer.from(JSON.stringify(body)):null;
    const r=httpsRequest({hostname:"127.0.0.1",port,method,path:url,ca,servername:"delta-worker.local",agent:false,headers:{...(token?{authorization:`Bearer ${token}`} : {}),...(data?{"content-type":"application/json","content-length":data.length}:{})}},res=>{
      let text="";res.on("data",b=>{text+=b;});res.on("end",()=>resolve({status:res.statusCode,body:text?JSON.parse(text):null}));
    });r.on("error",reject);r.end(data);
  });
  try{
    await service.start();const password="isolated-test-password";
    await req("POST","/api/v1/setup",{username:"manager",displayName:"Manager",password});
    const admin=(await req("POST","/api/v1/auth/login",{username:"manager",password})).body.token;
    const user=(await req("POST","/api/v1/auth/register",{username:"alice",displayName:"Alice",password})).body.token;
    let finished=false;const slow=req("GET","/api/v1/admin/reviews",null,admin).then(result=>{finished=true;return result;});
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal((await req("GET","/healthz")).status,200);
    assert.equal((await req("POST","/api/v1/client/poll",{clientId:randomUUID(),version:"1.6.0",platform:"windows",acknowledgedIds:[]},user)).status,200);
    assert.equal((await req("POST","/api/v1/client/source-writeback/poll",{clientId:randomUUID(),version:"1.6.0",pending:1,skipped:0,availability:"idle"},user)).status,200);
    assert.equal((await req("GET","/api/v1/admin/client-versions",null,admin)).status,200);
    assert.equal(finished,false,"all control requests finish before heavy statistics");
    assert.equal((await slow).status,200);
  }finally{await service.stop();await rm(root,{recursive:true,force:true});}
});

test("slow statistics run off the service thread; concurrent reads coalesce, timeout stays pending, close preserves source",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"delta-query-worker-"));
  const workerFile=path.join(root,"slow-worker.mjs");
  await writeFile(workerFile,`import{parentPort}from'node:worker_threads';let count=0;parentPort.on('message',m=>{count++;const until=Date.now()+250;while(Date.now()<until){};parentPort.postMessage({id:m.id,result:{count,input:m.input}})});`);
  const reader=openReviewQueries(root,{workerUrl:pathToFileURL(workerFile),deadlineMs:50});
  try{
    let responsive=false;setTimeout(()=>{responsive=true;},10);
    await Promise.all([assert.rejects(reader.query({},[]),/PENDING/),assert.rejects(reader.query({},[]),/PENDING/)]);
    assert.equal(responsive,true,"stats CPU never prevents main-thread timers/HTTPS progress");
    await new Promise(resolve=>setTimeout(resolve,350));
    assert.equal((await reader.query({},[])).count,1,"same query reuses completed work after timeout");
  }finally{await reader.close();await rm(root,{recursive:true,force:true});}
});
