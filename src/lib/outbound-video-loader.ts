/** Keep one shared ticket budget across rapid recording changes. Superseded
 * queued work never reaches IPC; late successful tickets are released. */
export class OutboundVideoLoader<T,R=string> {
  private generation=0;
  private active=0;
  private queue:{item:T;generation:number;request:(item:T)=>Promise<R>;loaded:(item:T,url:R)=>void;failed:(item:T,error:unknown)=>void;done:()=>void}[]=[];
  private remaining=0;
  private dispatchLimit=0;
  private finished:(()=>void)|null=null;
  private release:(url:R)=>void;
  constructor(release:(url:R)=>void){this.release=release;}
  cancel(){this.generation++;this.queue=[];this.remaining=0;this.finished=null;this.dispatchLimit=0;}
  resume(){this.dispatchLimit=Infinity;this.pump();}
  replace(items:T[],request:(item:T)=>Promise<R>,loaded:(item:T,url:R)=>void,failed:(item:T,error:unknown)=>void,done:()=>void,foreground=items.length){
    this.cancel();
    this.dispatchLimit=foreground;
    const generation=this.generation;
    this.remaining=items.length;this.finished=done;
    this.queue=items.map(item=>({item,generation,request,loaded,failed,done}));
    if(!items.length){done();return;}
    this.pump();
  }
  private pump(){
    while(this.active<4&&this.queue.length&&this.dispatchLimit>0){
      const job=this.queue.shift()!;this.active++;this.dispatchLimit--;
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
