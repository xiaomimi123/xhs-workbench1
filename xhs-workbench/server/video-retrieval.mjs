// Result retrieval only. Never calls generate/start and never scans shared gateway jobs.
export class VideoRetrieval {
 constructor({workflow,accounts,now=()=>Date.now(),windowMs=30*60*1000}){this.workflow=workflow;this.accounts=accounts;this.now=now;this.windowMs=windowMs;this.tracking=new Map();}
 async tick(){const pending=[];for(const a of this.accounts())for(const job of this.workflow.jobs(a.id)){
  if(!job.remoteId||['done','error'].includes(job.status))continue;
  const k=a.id+':'+job.id;let t=this.tracking.get(k);if(!t){t={until:this.now()+this.windowMs,next:0,busy:false};this.tracking.set(k,t);}
  if(t.busy||this.now()>t.until||this.now()<t.next)continue;
  t.busy=true;pending.push((async()=>{try{const result=await this.workflow.refresh(a.id,job.id,60);t.next=this.now()+(result.error?30000:3000);}catch{t.next=this.now()+30000;}finally{t.busy=false;}})());
 }await Promise.allSettled(pending);}
}
