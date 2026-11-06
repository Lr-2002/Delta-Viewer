// Browser preview fixtures only. Native runtime always uses the Rust implementation.
import type {DeviceRun, DeviceScenario, DeviceCheck} from "./d1";
const cancellations = new Map<number, AbortController>();
export function cancelBrowserDeviceTask(id:number) { const task=cancellations.get(id);task?.abort();return Boolean(task); }
export async function runBrowserDeviceSimulation(scenario:DeviceScenario,operationId:number,timeoutMs:number):Promise<DeviceRun> {
  const controller=new AbortController();cancellations.set(operationId,controller);
  const start=Date.now();
  const checks:DeviceCheck[]=["连接观测","状态观测","可选能力观测"].map((name,index)=>({id:["fixture-link","fixture-result","fixture-optional"][index],name,status:"not_run",evidence:"尚未执行此项模拟检查",observedAtMs:null,ruleVersion:"fixture-v1",applicableFirmware:"仅 fixture-current / fixture-legacy；不适用于真实固件",suggestion:"运行检测后查看观测证据。",errorKind:null}));
  const run:DeviceRun={id:`simulated:browser-${crypto.randomUUID()}`,source:"simulated",scenario,startedAtMs:start,finishedAtMs:0,status:"completed",device:{id:"simulated:local-fixture",model:"D1 模拟设备",source:"simulated",firmware:scenario==="partial"?"fixture-legacy":"fixture-current",capabilities:checks.slice(0,scenario==="partial"?2:3).map(c=>c.id)},checks};
  try {
    for (let index=0;index<checks.length;index++) {
      const step=Date.now();
      while (Date.now()-step<(scenario==="timeout"?11000:220)) {
        if(controller.signal.aborted || Date.now()-start>=timeoutMs) break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      if(controller.signal.aborted){run.status="cancelled";break;}
      const check=checks[index];check.observedAtMs=Date.now();
      if(Date.now()-start>=timeoutMs || scenario==="offline" || (scenario==="disconnect" && index===1) || (scenario==="parse_failure" && index===1)) {
        check.status="indeterminate";check.errorKind=Date.now()-start>=timeoutMs?"timeout":scenario==="parse_failure"?"parse_failure":"disconnected";
        check.evidence=check.errorKind==="timeout"?"模拟响应超过时间预算。":check.errorKind==="parse_failure"?"合成响应缺少必需字段。":"模拟连接不可用，未取得本项观测。";
        check.suggestion="恢复连接或补齐可解析的证据后复检；当前结果不能判断硬件损坏。";
        if(check.errorKind!=="parse_failure"){run.status=check.errorKind==="timeout"?"timed_out":"disconnected";break;}
      } else if(scenario==="partial" && index===2){check.status="unsupported";check.evidence="合成 fixture-legacy 未声明 fixture-optional。";check.suggestion="此模拟固件不支持该项，不能算作通过。";}
      else {check.status=scenario==="failure"&&index===1?"abnormal":"normal";check.evidence=`合成响应 flag=${check.status==="normal"?"fixture-ok":"fixture-failure"}，命中 fixture-v1 对应分支。`;check.suggestion="这是本地合成结果；真实设备仍未检测。";}
    }
    run.finishedAtMs=Math.max(Date.now(),start+1);return run;
  } finally {cancellations.delete(operationId);}
}
