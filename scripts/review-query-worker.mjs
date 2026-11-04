import { parentPort, workerData } from "node:worker_threads";
import { openReviewAuditStore } from "./review-audit-store.mjs";

const store = openReviewAuditStore(workerData.dataRoot, { readOnly:true });
parentPort.on("message", ({id,input,accounts}) => {
  try { parentPort.postMessage({id,result:store.query(input,accounts)}); }
  catch (error) { parentPort.postMessage({id,error:error.message}); }
});
