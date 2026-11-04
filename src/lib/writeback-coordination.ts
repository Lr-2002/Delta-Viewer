// Device-local coordination only; native auth still authorizes every write.
export const WRITEBACK_ACTIVITY = 'delta-source-writeback-activity';
export type WritebackActivity = {username:string;serviceId:string;active:boolean};
export function announceWriteback(owner:{username:string;serviceId:string},active:boolean) {
  window.dispatchEvent(new CustomEvent<WritebackActivity>(WRITEBACK_ACTIVITY,{detail:{...owner,active}}));
}
