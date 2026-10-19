import {test} from 'node:test';import assert from 'node:assert/strict';
import {imagePages} from '../xhs-workbench/web/note-preview.js';
test('预览按实际素材顺序列出封面和所有配图，不重复首图封面',()=>{
 const n={hasCover:true,coverMode:'template',media:[{file:'second.png'},{file:'first.png'}]};
 assert.deepEqual(imagePages(n).map(p=>p.path),['cover.png','images/second.png','images/first.png']);
 assert.deepEqual(imagePages({...n,coverMode:'first'}).map(p=>p.path),['images/second.png','images/first.png']);
 assert.deepEqual(imagePages({...n,hasCover:false}).map(p=>p.path),['images/second.png','images/first.png']);assert.deepEqual(imagePages({...n,video:{file:'a.mp4'}}),[]);
});
