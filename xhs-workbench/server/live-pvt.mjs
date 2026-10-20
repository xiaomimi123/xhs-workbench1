import {createZip} from './zip.mjs';
// PVT layout verified with the user's iPhone and Xiaohongshu (2026-10-19).
// Format reference: https://github.com/Hronrad/livephoto-forge (41d2366).
const metadata = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>PFVideoComplementMetadataVersionKey</key><string>1</string></dict></plist>\n`;
export function createPVT(files){
 const photo=files.find(f=>f.name==='photo.jpg'),video=files.find(f=>f.name==='paired.mov');
 if(!photo||!video)throw Object.assign(Error('实况配对文件不完整'),{status:409});
 const prefix='Live-Photo.pvt/';
 return createZip([{name:prefix,data:Buffer.alloc(0)},{name:prefix+'Live-Photo.JPG',data:photo.data},{name:prefix+'Live-Photo.MOV',data:video.data},{name:prefix+'metadata.plist',data:Buffer.from(metadata)}]);
}
export function pvtPage(downloadPath,expiresAt){
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>保存实况照片</title><style>body{font:18px system-ui;line-height:1.8;max-width:600px;margin:32px auto;padding:0 24px}a{display:block;background:#1674ee;color:white;text-decoration:none;padding:16px;border-radius:12px;text-align:center}small{color:#666}</style><h1>保存实况照片</h1><p>无需安装 App。请用 Safari 下载，并在 iPhone「文件」中打开。</p><a href="${downloadPath}">下载 Live Photo（PVT）</a><ol><li>进入「文件 → 下载项」，等待完整下载。</li><li>点击 Live-Photo.pvt.zip 解压，打开得到的 Live-Photo.pvt。</li><li>长按预览确认动态，再点“保存到照片”。</li><li>进入「照片」确认 LIVE 并长按播放，然后在小红书编辑页检查实况。</li></ol><p>不会自动发布。下载成功不代表已保存到相册。若显示普通文件夹或没有保存入口，请反馈具体步骤和 iOS 版本。</p><small>手机与工作台需在同一 Wi-Fi，Mac 保持联网。接收码有效至 ${new Date(expiresAt).toISOString()}（UTC）；原图保持不变。</small></html>`;
}
