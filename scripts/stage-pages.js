const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');const target=process.argv[2]&&path.resolve(process.argv[2]);
if(!target||target===root||(fs.existsSync(target)&&fs.readdirSync(target).length))throw Error('Specify an empty output directory; no existing data is removed.');
fs.mkdirSync(target,{recursive:true});
const files=['index.html','weekly-wrapped.html','sw.js','manifest.webmanifest','icon-192.png','icon-512.png','assets'];
for(const name of files)fs.cpSync(path.join(root,name),path.join(target,name),{recursive:true,dereference:false});
console.log('Staged frontend-only Pages artifact.');
