/** Keep one shared ticket budget across rapid recording changes. Superseded
 * queued work never reaches IPC; late successful tickets are released. */
export class OutboundVideoLoader<T> {
  private generation=0;
  private active=0;
  private queue:{item:T;generation:number;request:(item:T)=>Promise<string>;loaded:(item:T,url:string)=>void;failed:(item:T,error:unknown)=>void;done:()=>void}[]=[];
  private remaining=0;
  private finished:(()=>void)|null=null;
  private release:(url:string)=>void;
  constructor(release:(url:string)=>void){this.release=release;}
  cancel(){this.generation++;this.queue=[];this.remaining=0;this.finished=null;}
  replace(items:T[],request:(item:T)=>Promise<string>,loaded:(item:T,url:string)=>void,failed:(item:T,error:unknown)=>void,done:()=>void){
    this.cancel();
    const generation=this.generation;
    this.remaining=items.length;this.finished=done;
    this.queue=items.map(item=>({item,generation,request,loaded,failed,done}));
    if(!items.length){done();return;}
    this.pump();
  }
  private pump(){
    while(this.active<4&&this.queue.length){
      const job=this.queue.shift()!;this.active++;
      void Promise.resolve().then(()=>job.request(job.item)).then(url=>{
        if(job.generation===this.generation)job.loaded(job.item,url);else this.release(url);
      },error=>{if(job.generation===this.generation)job.failed(job.item,error);}).finally(()=>{
        this.active--;
        if(job.generation===this.generation&&--this.remaining===0)this.finished?.();
        this.pump();
      });
    }
  }
}
