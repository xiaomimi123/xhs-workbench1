// 与已保存的发布素材顺序一致，只引用实际存在于笔记详情中的图片。
export function imagePages(note) {
 if(note.video)return [];
 return [...(note.hasCover&&note.coverMode!=='first'?[{path:'cover.png',label:'封面'}]:[]),...(note.media||[]).map((m,i)=>({path:`images/${m.file}`,label:`配图 ${i+1}`}))];
}
