import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {P,SKILL_DIR} from './paths.mjs';
const exec=promisify(execFile);let building;
export async function localQR(value){if(process.platform!=='darwin')throw Error('当前本地二维码需要macOS');const source=path.join(SKILL_DIR,'scripts/native/qr-code.swift'),key=crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0,16),dir=path.join(P.run,'native'),binary=path.join(dir,'qr-'+key);
 if(!fs.existsSync(binary)){if(!building)building=(async()=>{fs.mkdirSync(dir,{recursive:true});const temp=binary+'.building';await exec('/usr/bin/swiftc',['-O',source,'-o',temp],{timeout:60000,maxBuffer:1024*1024});fs.renameSync(temp,binary);})().finally(()=>building=null);await building;}
 const {stdout}=await exec(binary,[value],{encoding:'buffer',timeout:15000,maxBuffer:1024*1024});return 'data:image/png;base64,'+stdout.toString('base64');
}
