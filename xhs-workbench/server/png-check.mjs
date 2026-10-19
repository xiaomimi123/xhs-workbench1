import {inflateSync} from 'node:zlib';
function crc(b){let c=0xffffffff;for(const x of b){c^=x;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
export function checkPng(b){
 if(b.length<45||!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('当前支持校验 PNG，请转换图片后再检查');
 let at=8,width,height,depth,color,ended=false;const parts=[];
 while(at+12<=b.length){const len=b.readUInt32BE(at),end=at+8+len;if(end+4>b.length)throw Error('PNG 数据不完整');const type=b.toString('ascii',at+4,at+8),chunk=b.subarray(at+8,end);
 if(crc(b.subarray(at+4,end))!==b.readUInt32BE(end))throw Error('PNG 校验码错误');
 if(at===8&&type!=='IHDR')throw Error('缺少 PNG 文件头');
 if(type==='IHDR'){if(at!==8||len!==13)throw Error('PNG 文件头无效');width=chunk.readUInt32BE(0);height=chunk.readUInt32BE(4);depth=chunk[8];color=chunk[9];if(!width||!height||width>16384||height>16384||chunk[10]||chunk[11]||chunk[12])throw Error('PNG 尺寸或编码暂不支持');}
 if(type==='IDAT')parts.push(chunk);if(type==='IEND'){if(len)throw Error('PNG 结束块错误');ended=true;break;}at=end+4;
 }
 const channels={0:1,2:3,3:1,4:2,6:4}[color];const depths={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
 if(!ended||!parts.length||!channels||!depths[color].includes(depth))throw Error('PNG 编码无效');
 const stride=Math.ceil(width*channels*depth/8)+1,size=stride*height;if(size>128*1024*1024)throw Error('PNG 解码尺寸过大');
 const pixels=inflateSync(Buffer.concat(parts),{maxOutputLength:size});if(pixels.length!==size)throw Error('PNG 像素不完整');for(let i=0;i<size;i+=stride)if(pixels[i]>4)throw Error('PNG 像素过滤器错误');
 return {width,height};
}
