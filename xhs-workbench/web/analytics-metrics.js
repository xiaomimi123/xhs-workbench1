export const METRIC_KEYS=['views','likes','collects','comments','shares','follows'];
export function metric(value){
 if(typeof value==='number')return Number.isFinite(value)&&value>=0?value:null;
 if(typeof value!=='string')return null;const s=value.trim().replace(/,/g,'');
 const m=/^(\d+(?:\.\d+)?)(万|[wWkK])?$/.exec(s);if(!m)return null;
 const n=Number(m[1])*(m[2]==='万'||/[wW]/.test(m[2]||'')?10000:/[kK]/.test(m[2]||'')?1000:1);return Number.isFinite(n)?n:null;
}
export function interactionRate(m={}){const v=metric(m.views),xs=['likes','collects','comments'].map(k=>metric(m[k]));return v>0&&xs.every(x=>x!==null)?xs.reduce((a,b)=>a+b,0)/v:null;}
export function coverage(rows,key){const values=rows.map(r=>metric(r[key])).filter(v=>v!==null);return {value:values.length?values.reduce((a,b)=>a+b,0):null,known:values.length,total:rows.length};}
