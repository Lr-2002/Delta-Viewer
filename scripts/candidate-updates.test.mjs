import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {candidateBase,nameFor,verifyCandidate,publishCandidate,validateCandidate} from './candidate-updates.mjs';

function signer(){
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'),id=randomBytes(8);
 return {publicKey:Buffer.from(`untrusted comment: test key\n${Buffer.concat([Buffer.from([0x45,0x64]),id,publicKey.export({format:'der',type:'spki'}).subarray(-32)]).toString('base64')}\n`).toString('base64'),
 sign(bytes){const signature=sign(null,createHash('blake2b512').update(bytes).digest(),privateKey),comment='timestamp:1794967200\tfile:fixture\tprehashed';return Buffer.from(['untrusted comment: test signature',Buffer.concat([Buffer.from([0x45,0x44]),id,signature]).toString('base64'),'trusted comment: '+comment,sign(null,Buffer.concat([signature,Buffer.from(comment)]),privateKey).toString('base64'),''].join('\n')).toString('base64');}};
}
const target='windows-x86_64-nsis',bytes=Buffer.alloc(1024*1024,5);
async function fixture(root,key,version='9.1.0',change=()=>{}){
 await mkdir(root,{recursive:true});const name=nameFor(version,target),payload={schemaVersion:1,channel:'candidate',version,commit:'a'.repeat(40),pub_date:'2026-11-18T02:00:00Z',notes:'- synthetic candidate',platforms:{[target]:{url:`${candidateBase}/releases/v${version}/${name}`,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),signature:key.sign(bytes)}}};change(payload);
 const raw=Buffer.from(JSON.stringify(payload));await writeFile(path.join(root,name),bytes);await writeFile(path.join(root,'latest.json'),JSON.stringify({payload:raw.toString('base64'),signature:key.sign(raw)}));return payload;
}

test('signed candidate validates independently of GitHub; tampering, wrong keys, paths, unsupported platforms and bad sizes fail closed',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'candidate-test-')),key=signer();
 try{
  await fixture(root,key);await verifyCandidate({input:root,publicKey:key.publicKey});
  await assert.rejects(verifyCandidate({input:root,publicKey:signer().publicKey}));
  const original=await readFile(path.join(root,'latest.json'),'utf8'),envelope=JSON.parse(original);envelope.payload=Buffer.from(Buffer.from(envelope.payload,'base64').toString().replace('synthetic','tampered')).toString('base64');await writeFile(path.join(root,'latest.json'),JSON.stringify(envelope));await assert.rejects(verifyCandidate({input:root,publicKey:key.publicKey}));
  for(const change of [m=>m.platforms[target].url='https://evil.invalid/app.exe',m=>m.platforms[target].size=65*1024*1024,m=>m.platforms[target].sha256='b'.repeat(64),m=>m.platforms.evil=m.platforms[target],m=>m.version='../escape',m=>m.channel='stable',m=>delete m.notes]){
   await fixture(root,key,'9.1.0',change);await assert.rejects(verifyCandidate({input:root,publicKey:key.publicKey}));
  }
  await fixture(root,key);await writeFile(path.join(root,nameFor('9.1.0',target)),Buffer.alloc(bytes.length,7));await assert.rejects(verifyCandidate({input:root,publicKey:key.publicKey}));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('publication keeps public versions immutable, publishes exact signed bytes, permits exact retry and rejects a late downgrade',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'candidate-publish-')),key=signer(),input=path.join(root,'input'),output=path.join(root,'served');
 try{
  await fixture(input,key);await publishCandidate({input,root:output,publicKey:key.publicKey});const first=await readFile(path.join(output,'latest.json'));
  await verifyCandidate({input:path.join(output,'releases/v9.1.0'),publicKey:key.publicKey});await publishCandidate({input,root:output,publicKey:key.publicKey});
  await fixture(input,key,'9.1.0',m=>m.notes='different content');await assert.rejects(publishCandidate({input,root:output,publicKey:key.publicKey}),/different bytes/);assert.deepEqual(await readFile(path.join(output,'latest.json')),first);
  await fixture(input,key,'9.0.9');await assert.rejects(publishCandidate({input,root:output,publicKey:key.publicKey}),/downgrade/);assert.deepEqual(await readFile(path.join(output,'latest.json')),first);
 }finally{await rm(root,{recursive:true,force:true});}
});
