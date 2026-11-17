import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {initializeUserCenter} from './user-center-server.mjs';
import {createOutboundReviewBridge} from './outbound-review-bridge.mjs';

test('outbound relay queues camera bursts, reserves task controls and releases every stalled slot',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'outbound-bridge-'));
  let server,bridge;
  const held=[],actions=[];let mode='hold',drip,reply;
  try{
    await initializeUserCenter({schemaVersion:1,listenHost:'::',listenPort:17979,publicBaseUrl:'https://localhost:17979',sessionTtlSeconds:300},root);
    const keyFile=path.join(root,'key');await writeFile(keyFile,'synthetic-bridge-key-with-more-than-32-bytes',{mode:0o600});
    server=createServer({key:await readFile(path.join(root,'tls/server.key')),cert:await readFile(path.join(root,'tls/server.crt'))},async(request,response)=>{
      const chunks=[];for await(const chunk of request)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks));actions.push(input.action);
      if(mode==='hold'&&input.action==='video-url'){held.push(response);return;}
      if(mode==='drip'){
        response.writeHead(200);response.write('{');drip=setInterval(()=>response.write(' '),20);
        response.once('close',()=>clearInterval(drip));return;
      }
      if(mode==='abort'){response.writeHead(200);response.write('{');response.destroy();return;}
      if(mode==='response'){response.writeHead(reply.status,{'Content-Type':reply.type??'application/json'});response.end(reply.body);return;}
      response.end(JSON.stringify(input.action==='video-url'?{path:'/api/platform/manager-outbound/media/'+'a'.repeat(64)}:{batches:[]}));
    });
    await new Promise(resolve=>server.listen(0,resolve));
    const config={origin:`https://localhost:${server.address().port}`,keyFile,certificateFile:path.join(root,'tls/ca.crt')};
    const user={username:'reviewer.one',displayName:'Reviewer'};
    bridge=await createOutboundReviewBridge(config,'synthetic-service',Date.now,{timeoutMs:3000});
    const cameras=Array.from({length:14},(_,segment)=>bridge.request(user,{action:'video-url',segment}));
    while(held.length<6)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(held.length,6);
    assert.deepEqual(await bridge.request(user,{action:'list'}),{batches:[]},'controls remain responsive during a camera burst');
    mode='normal';for(const response of held)response.end(JSON.stringify({path:'/api/platform/manager-outbound/media/'+'a'.repeat(64)}));
    assert.equal((await Promise.all(cameras)).length,14,'camera requests queue without immediate busy errors');
    bridge.close();bridge=await createOutboundReviewBridge(config,'synthetic-service',Date.now,{timeoutMs:180});
    mode='drip';const started=performance.now();
    await assert.rejects(bridge.request(user,{action:'list'}),/OUTBOUND_NETWORK_UNAVAILABLE/);
    assert.ok(performance.now()-started<1200,'a dripping response cannot extend the total deadline');
    clearInterval(drip);mode='abort';await assert.rejects(bridge.request(user,{action:'list'}),/OUTBOUND_NETWORK_UNAVAILABLE/);
    mode='normal';assert.deepEqual(await bridge.request(user,{action:'list'}),{batches:[]},'aborted and timed-out requests release capacity');
    mode='hold';
    const controllers=Array.from({length:7},()=>new AbortController());
    const pending=controllers.map(controller=>bridge.request(user,{action:'video-url'},{signal:controller.signal}));
    const settled=Promise.allSettled(pending);for(const controller of controllers)controller.abort();
    assert.ok((await settled).every(row=>row.status==='rejected'));
    mode='normal';assert.deepEqual(await bridge.request(user,{action:'list'}),{batches:[]});
    // Nginx returns HTML while the outbound process is down. Exercise whole
    // seven-camera bursts across failure and recovery with the same TLS pool.
    mode='response';reply={status:502,type:'text/html',body:'<html>private-upstream-detail</html>'};
    const failed=await Promise.allSettled(Array.from({length:7},()=>bridge.request(user,{action:'video-url'})));
    assert.ok(failed.every(row=>row.status==='rejected'&&row.reason.status===502&&row.reason.message==='OUTBOUND_HTTP_502'));
    for(const status of [401,429,503,504]){
      reply={status,body:''};
      await assert.rejects(bridge.request(user,{action:'list'}),error=>error.status===status&&error.message===`OUTBOUND_HTTP_${status}`);
    }
    reply={status:403,body:JSON.stringify({error:{code:'OUTBOUND_NOT_OWNER'}})};
    await assert.rejects(bridge.request(user,{action:'video-url'}),error=>error.status===403&&error.message==='OUTBOUND_NOT_OWNER');
    reply={status:502,body:JSON.stringify({error:{code:'private-secret-url'}})};
    await assert.rejects(bridge.request(user,{action:'list'}),error=>error.message==='OUTBOUND_HTTP_502');
    for(const body of ['<html>not-json</html>',JSON.stringify({path:'https://untrusted.invalid/media'}),JSON.stringify({path:'/api/platform/manager-outbound/media/'+'a'.repeat(63)})]){
      reply={status:200,body};
      await assert.rejects(bridge.request(user,{action:'video-url'}),/OUTBOUND_RESPONSE_INVALID/,'successful malformed responses still fail closed');
    }
    reply={status:503,body:'<html>private-upstream-detail</html>'};
    for(const action of ['claim','decide']){
      const before=actions.filter(value=>value===action).length;
      await assert.rejects(bridge.request(user,{action}),error=>error.status===503&&error.message==='OUTBOUND_HTTP_503');
      assert.equal(actions.filter(value=>value===action).length,before+1,'mutations are never replayed after an ambiguous gateway failure');
    }
    mode='normal';
    for(let recording=0;recording<8;recording++){
      const recovered=await Promise.all(Array.from({length:7},()=>bridge.request(user,{action:'video-url'})));
      assert.ok(recovered.every(value=>value.url===config.origin+'/api/platform/manager-outbound/media/'+'a'.repeat(64)));
    }
    assert.deepEqual(await bridge.request(user,{action:'list'}),{batches:[]},'service recovery does not require login or rebuilding the relay');
    mode='hold';const closing=Promise.allSettled(Array.from({length:12},()=>bridge.request(user,{action:'video-url'})));bridge.close();
    assert.ok((await closing).every(row=>row.status==='rejected'),'shutdown rejects active and queued requests');
    assert.equal(actions.filter(action=>action==='claim'||action==='decide').length,2,'only the two explicit synthetic mutations reach the isolated server');
  }finally{clearInterval(drip);bridge?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(root,{recursive:true,force:true});}
});
