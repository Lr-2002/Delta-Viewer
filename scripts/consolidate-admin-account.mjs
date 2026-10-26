#!/usr/bin/env node
// Offline service-host migration. Caller must stop the user center first.
import {open,readFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function consolidateAdminAccount(state, from, to) {
  if(!from || from===to)throw Error('Distinct source and target required');
  const result=structuredClone(state);
  const previous=result.users?.find(user=>user.username===from);
  const target=result.users?.find(user=>user.username===to);
  if(!previous || previous.role!=='admin' || !target || target.role!=='operator' || target.accountStatus==='paused') throw Error('Existing admin and active test operator required');
  target.managementAccess=true;
  previous.accountStatus='paused';
  return result;
}
export async function migrateAdminOffline({dataRoot,from,to,offlineConfirmed}) {
  if(!offlineConfirmed)throw Error('Stop the user center and pass --offline-confirmed');
  const file=path.join(dataRoot,'users.json'), original=await readFile(file);
  const next=consolidateAdminAccount(JSON.parse(original.toString('utf8')),from,to);
  const backup=file+`.before-management-${Date.now()}-${randomUUID()}`;
  const copy=await open(backup,'wx',0o600);
  try {await copy.writeFile(original);await copy.sync();}finally {await copy.close();}
  const temporary=file+`.partial-${randomUUID()}`, out=await open(temporary,'wx',0o600);
  try {await out.writeFile(JSON.stringify(next,null,2)+'\n');await out.sync();}finally {await out.close();}
  if(!(await readFile(file)).equals(original))throw Error('Account state changed; original preserved, migration cancelled');
  await rename(temporary,file);
  const dir=await open(dataRoot,'r');try {await dir.sync();}finally {await dir.close();}
  if(JSON.stringify(JSON.parse(await readFile(file,'utf8')))!==JSON.stringify(next))throw Error('Migration verification failed');
  return {from,to,previousDisabled:true,passwordUnchanged:true,backup};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), get=name=>args[args.indexOf(name)+1];
  if(!['--data-root','--from','--to'].every(name=>args.includes(name)))throw Error('Use --data-root ROOT --from OLD --to TEST --offline-confirmed');
  console.log(JSON.stringify(await migrateAdminOffline({dataRoot:get('--data-root'),from:get('--from'),to:get('--to'),offlineConfirmed:args.includes('--offline-confirmed')})));
}
