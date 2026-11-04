import { Worker } from "node:worker_threads";

// One bounded reader, shared in-flight requests, immutable timestamped snapshots.
// Slow filtered queries must never occupy the HTTPS/event-ingestion thread.
export function openReviewQueries(dataRoot, { workerUrl = new URL("./review-query-worker.mjs",import.meta.url), deadlineMs=8000 } = {}) {
  const overview=openReviewReader(dataRoot,{workerUrl,deadlineMs}), filtered=openReviewReader(dataRoot,{workerUrl,deadlineMs});
  return {
    query(input,accounts){return (["username","sessionId","episodeKey","action","fromMs","toMs"].some(key=>input[key])?filtered:overview).query(input,accounts);},
    async close(){await Promise.all([overview.close(),filtered.close()]);},
  };
}

function openReviewReader(dataRoot,{workerUrl,deadlineMs}) {
  let worker, sequence=0, closed=false;
  const jobs=new Map(), cache=new Map();
  function rejectAll(error) { for (const job of jobs.values()) job.reject(error); jobs.clear(); }
  function start() {
    if (closed) throw Error("REVIEW_QUERY_CLOSED");
    if (worker) return;
    const current=new Worker(workerUrl,{workerData:{dataRoot}});worker=current;
    current.on("message",({id,result,error})=>{
      const job=[...jobs.values()].find(j=>j.id===id);
      if (!job) return;
      jobs.delete(job.key);
      if (error) job.reject(Error(error));
      else {
        cache.set(job.key,{result,at:Date.now(),ttl:Math.min(15000,Math.max(2000,Date.now()-job.started))});
        while(cache.size>16)cache.delete(cache.keys().next().value);
        job.resolve(result);
      }
    });
    current.on("error",error=>{if(worker===current){worker=null;rejectAll(error);}});
    current.on("exit",code=>{if(worker===current){worker=null;rejectAll(Error(`REVIEW_QUERY_WORKER_EXIT: ${code}`));}});
  }
  return {
    async query(input,accounts) {
      const key=JSON.stringify([Object.fromEntries(Object.entries(input).sort()),accounts]);
      const saved=cache.get(key);
      if (saved && Date.now()-saved.at<saved.ttl) return saved.result;
      let job=jobs.get(key);
      if (!job) {
        if (jobs.size>=8) throw Error("REVIEW_QUERY_BUSY: 统计查询繁忙，在线上报与写回仍可继续，请稍后刷新");
        start();
        let resolve,reject;
        const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
        job={key,id:++sequence,promise,resolve,reject,started:Date.now()};jobs.set(key,job);
        worker.postMessage({id:job.id,input,accounts});
      }
      let timer;
      try {
        return await Promise.race([job.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("REVIEW_QUERY_PENDING: 正在计算审核统计，已保留原记录；在线上报和 NAS 写回不受此查询影响，请稍后刷新")),deadlineMs);})]);
      } finally {clearTimeout(timer);}
    },
    async close(){closed=true;rejectAll(Error("REVIEW_QUERY_CLOSED"));const old=worker;worker=null;if(old)await old.terminate();},
  };
}
