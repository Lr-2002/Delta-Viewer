import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile,lstat,mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {verifyUpdaterSignature} from './updater-signature.mjs';
import {formatReleaseChangelog,parseReleaseChangelog} from './release-changelog.mjs';

export const candidateBase='https://114.111.19.219/api/manager-updates/candidate';
export const targets={
 'windows-x86_64-nsis':'windows-x64-updater.exe',
 'darwin-aarch64-app':'macos-arm64.app.tar.gz',
 'linux-x86_64-deb':'ubuntu-22.04+-x64.deb',
};
const maxJSON=1024*1024;
export const nameFor=(version,target)=>`Delta-Viewer_${version}_UNSIGNED_${targets[target]}`;
const validVersion=v=>typeof v==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v);
export function validateCandidate(manifest){
 if(!manifest||manifest.schemaVersion!==1||manifest.channel!=='candidate'||!validVersion(manifest.version)
  ||!/^[a-f0-9]{40}$/.test(manifest.commit||'')||typeof manifest.notes!=='string'||!manifest.notes.trim()
  ||!/^\d{4}-\d\d-\d\dT/.test(manifest.pub_date||'')||!Number.isFinite(Date.parse(manifest.pub_date)))throw Error('Invalid candidate identity');
 const rows=Object.entries(manifest.platforms||{});
 if(!rows.length||rows.length>3)throw Error('Candidate platforms missing');
 for(const[target,item]of rows){
  if(!Object.hasOwn(targets,target)||item.url!==`${candidateBase}/releases/v${manifest.version}/${nameFor(manifest.version,target).replaceAll('+','%2B')}`
   ||!Number.isSafeInteger(item.size)||item.size<1024*1024||item.size>64*1024*1024||!/^[a-f0-9]{64}$/.test(item.sha256||'')
   ||typeof item.signature!=='string'||!item.signature)throw Error('Invalid candidate asset');
 }
 return manifest;
}
async function boundedFile(file,limit){const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>limit)throw Error('Unsafe or oversized candidate file');return readFile(file);}
export async function prepareCandidate({input,output,target,commit,root=path.resolve(fileURLToPath(new URL('..',import.meta.url)))}){
 if((target!=='all-present'&&!Object.hasOwn(targets,target))||!/^[a-f0-9]{40}$/.test(commit))throw Error('Candidate target or commit invalid');
 if(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==commit)throw Error('Candidate source commit mismatch');
 const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
 const config=JSON.parse(await readFile(path.join(root,'src-tauri/tauri.conf.json'),'utf8'));
 const selected=target==='all-present'?Object.keys(targets).filter(t=>{try{return execFileSync(process.execPath,['-e',"require('fs').accessSync(process.argv[1])",path.join(input,nameFor(version,t))],{stdio:'ignore'}),true;}catch{return false;}}):[target];
 const platforms={};await mkdir(output,{recursive:true});
 for(const key of selected){
  const file=nameFor(version,key),source=path.join(input,file),bytes=await boundedFile(source,64*1024*1024);
  await verifyUpdaterSignature(source,source+'.sig',config.plugins.updater.pubkey);
  const signature=(await boundedFile(source+'.sig',16384)).toString().trim();
  platforms[key]={url:`${candidateBase}/releases/v${version}/${file.replaceAll('+','%2B')}`,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),signature};
  await copyFile(source,path.join(output,file),constants.COPYFILE_EXCL);await copyFile(source+'.sig',path.join(output,file+'.sig'),constants.COPYFILE_EXCL);
 }
 const manifest=validateCandidate({schemaVersion:1,channel:'candidate',version,commit,pub_date:new Date().toISOString(),
  notes:formatReleaseChangelog(parseReleaseChangelog(await readFile(path.join(root,'CHANGELOG.md'),'utf8'),version)),platforms});
 await writeFile(path.join(output,'candidate-payload.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 return manifest;
}
export async function sealCandidate({input,publicKey}){
 const file=path.join(input,'candidate-payload.json'),bytes=await boundedFile(file,maxJSON/2);
 validateCandidate(JSON.parse(bytes));await verifyUpdaterSignature(file,file+'.sig',publicKey);
 const signature=(await boundedFile(file+'.sig',16384)).toString().trim();
 await writeFile(path.join(input,'latest.json'),JSON.stringify({payload:bytes.toString('base64'),signature})+'\n',{flag:'wx'});
}
export async function verifyCandidate({input,publicKey}){
 const envelope=JSON.parse(await boundedFile(path.join(input,'latest.json'),maxJSON));
 if(typeof envelope.payload!=='string'||typeof envelope.signature!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload))throw Error('Invalid signed candidate envelope');
 const payload=Buffer.from(envelope.payload,'base64');if(payload.toString('base64')!==envelope.payload)throw Error('Invalid candidate encoding');
 const scratch=await mkdtemp(path.join(tmpdir(),'delta-candidate-verify-'));
 try{
  const file=path.join(scratch,'payload');await writeFile(file,payload);await writeFile(file+'.sig',envelope.signature);
  await verifyUpdaterSignature(file,file+'.sig',publicKey);
  const manifest=validateCandidate(JSON.parse(payload));
  for(const[target,entry]of Object.entries(manifest.platforms)){
   const asset=path.join(input,nameFor(manifest.version,target)),bytes=await boundedFile(asset,64*1024*1024);
   if(bytes.length!==entry.size||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('Candidate asset hash or size mismatch');
   const sig=path.join(scratch,'asset.sig');await writeFile(sig,entry.signature);await verifyUpdaterSignature(asset,sig,publicKey);
  }
  return {manifest,envelope};
 }finally{await rm(scratch,{recursive:true,force:true});}
}
export async function publishCandidate({input,root,publicKey}){
 const {manifest}=await verifyCandidate({input,publicKey});await mkdir(root,{recursive:true});
 const lock=path.join(root,'.publish.lock');await mkdir(lock);
 let staging;
 try{
  const final=path.join(root,'releases','v'+manifest.version);await mkdir(path.dirname(final),{recursive:true});
  staging=await mkdtemp(path.join(root,'.candidate-stage-'));
  for(const target of Object.keys(manifest.platforms)){const file=nameFor(manifest.version,target);await copyFile(path.join(input,file),path.join(staging,file),constants.COPYFILE_EXCL);}
  await copyFile(path.join(input,'latest.json'),path.join(staging,'latest.json'),constants.COPYFILE_EXCL);
  // A version is immutable. Repeating the exact publication is safe; rebuilding
  // or extending the platform set under an exposed version requires a new version.
  await verifyCandidate({input:staging,publicKey});
  const existing=await lstat(final).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
  if(existing){
   if(!existing.isDirectory()||existing.isSymbolicLink()||!(await readFile(path.join(final,'latest.json'))).equals(await readFile(path.join(staging,'latest.json'))))throw Error('Candidate version already exists with different bytes');
   await verifyCandidate({input:final,publicKey});
  }else await rename(staging,final);
  // Never replace a newer public candidate with a late build.
  const latest=path.join(root,'latest.json'),old=await boundedFile(latest,maxJSON).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
  if(old){const previous=JSON.parse(Buffer.from(JSON.parse(old).payload,'base64'));const a=previous.version.split('.').map(Number),b=manifest.version.split('.').map(Number);let cmp=0;for(let i=0;i<3&&!cmp;i++)cmp=b[i]-a[i];if(cmp<0)throw Error('Refusing candidate pointer downgrade');}
  const next=path.join(root,'.latest-'+randomUUID());try{await copyFile(path.join(final,'latest.json'),next,constants.COPYFILE_EXCL);await rename(next,latest);}finally{await rm(next,{force:true});}
  return {version:manifest.version,commit:manifest.commit,targets:Object.keys(manifest.platforms),published:true};
 }finally{if(staging)await rm(staging,{recursive:true,force:true});await rm(lock,{recursive:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,...args]=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||!args[i+1])throw Error('Invalid arguments');options[args[i].slice(2)]=args[i+1];}
 const config=JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'));options.publicKey=config.plugins.updater.pubkey;
 const actions={prepare:prepareCandidate,seal:sealCandidate,verify:verifyCandidate,publish:publishCandidate};if(!actions[command])throw Error('Use prepare, seal, verify or publish');console.log(JSON.stringify(await actions[command](options)??{sealed:true}));
}
