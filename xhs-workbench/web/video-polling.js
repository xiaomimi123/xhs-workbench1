// Poll only existing task IDs while this page is open; never submit a generation.
export function startVideoPolling({current,ready,jobs,refresh,updated}){
 let stopped=false,timer;const schedule=ms=>{if(!stopped&&current())timer=setTimeout(tick,ms);};
 async function tick(){if(stopped||!current())return;let failed=false,changed=false;try{if(ready()){for(const j of jobs().filter(j=>j.remoteId&&!['done','error'].includes(j.status))){if(stopped||!current())break;const result=await refresh(j.id);changed=true;if(result.error){failed=true;break;}}if(changed&&current()&&!stopped)await updated();}}catch{failed=true;}finally{schedule(failed?30000:5000);}}
 schedule(5000);return ()=>{stopped=true;clearTimeout(timer);};
}
