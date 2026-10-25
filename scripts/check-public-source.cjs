'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const publicRoot=new Set(['.gitignore','.gitattributes','AGENTS.md','README.md','LICENSE','LICENSE.md','CONTRIBUTING.md','SECURITY.md','CHANGELOG.md','package.json','package-lock.json']);
const publicDocs=new Set(['docs/使用说明.md','docs/开发说明.md','docs/GitHub发布说明.md']);
function inspectPublicFile(file,bytes) {
  const name=file.replaceAll('\\','/'),issues=[];
  if(!publicRoot.has(name)&&!['src/','test/','scripts/','.github/'].some(prefix=>name.startsWith(prefix))&&!publicDocs.has(name))issues.push('outside_public_source');
  if(/(?:^|\/)(?:node_modules|work|dist|browser-data|\.git)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:exe|asar|zip|har|saz|pfx|p12|pem|key|db|sqlite3?|backup|log)$/i.test(name))issues.push('private_or_generated_file');
  if(bytes.length>2*1024*1024)issues.push('oversized_source_file');
  if(/\.(?:png|ico|jpe?g)$/i.test(name))return issues;
  if(bytes.includes(0))issues.push('unexpected_binary_file');
  const text=bytes.toString('utf8');
  const patterns={private_key:/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,github_token:/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,openai_key:/\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}/,personal_windows_path:/\b[A-Za-z]:[\\/]+Users[\\/]+(?!Public(?:[\\/]|\b)|Default(?:[\\/]|\b))[^\\/\s"'<>]+/i,credential_in_url:/https?:\/\/[^\s/:@]+:[^\s/@]+@/};
  for(const [label,pattern] of Object.entries(patterns))if(pattern.test(text))issues.push(label);
  return issues;
}
function checkPublicSource() {
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'buffer',maxBuffer:16*1024*1024,windowsHide:true});
  const staged=git(['ls-files','--cached','-z']).toString().split('\0').filter(Boolean),known=new Set(staged);
  const files=[...new Set([...staged,...git(['ls-files','--others','--exclude-standard','-z']).toString().split('\0').filter(Boolean)])];
  if(!files.length)throw Error('没有可检查的公开源码');
  const errors=[];
  for(const file of files) {
    const absolute=path.join(root,file);
    if(fs.existsSync(absolute)&&fs.lstatSync(absolute).isSymbolicLink()){errors.push({file,issues:['symbolic_link']});continue;}
    // Inspect the staged blob, so a sensitive staged value cannot be hidden by
    // editing the working copy again before publishing.
    const bytes=known.has(file)?git(['show',':'+file]):fs.readFileSync(absolute);
    const issues=inspectPublicFile(file,bytes);if(issues.length)errors.push({file,issues});
  }
  if(errors.length){for(const row of errors)console.error(row.file+': '+row.issues.join(', '));throw Error('公开源码检查未通过；修正文件后再提交。');}
  console.log(`公开源码检查通过：${files.length} 个文件。`);
  return {files:files.length};
}
if(require.main===module)try{checkPublicSource();}catch(error){console.error(error.message);process.exitCode=1;}
module.exports={inspectPublicFile,checkPublicSource};
