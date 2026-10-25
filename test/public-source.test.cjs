'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {inspectPublicFile}=require('../scripts/check-public-source.cjs');
test('public scan rejects generated and investigation files even if explicitly staged',()=>{
  for(const file of ['work/sample.cjs','dist/setup.exe','docs/private-notes.md','.env','src/browser-data/Cookies','src/key.pem'])assert.ok(inspectPublicFile(file,Buffer.from('sample')).length,file);
  assert.deepEqual(inspectPublicFile('docs/使用说明.md',Buffer.from('公开使用说明')),[]);
});
test('public scan identifies secrets without printing their values',()=>{
  const cases=[['github_token','ghp_'+'a'.repeat(36)],['github_token','github_pat_'+'a'.repeat(45)],['private_key',['-----BEGIN','PRIVATE KEY-----'].join(' ')],['openai_key','sk-'+'a'.repeat(36)],['personal_windows_path',['C:','Users','Merchant','state.json'].join('/')],['credential_in_url',['https:/','name:password@example.test'].join('/')]];
  for(const [code,text] of cases)assert.ok(inspectPublicFile('src/example.cjs',Buffer.from(text)).includes(code),code);
});
test('public scan permits source, workflows and public image assets',()=>{
  for(const file of ['src/main.cjs','test/core.test.cjs','scripts/fixture-platform.cjs','.github/workflows/ci.yml','src/renderer/icon.png'])assert.deepEqual(inspectPublicFile(file,Buffer.from('public sample')),[]);
  assert.ok(inspectPublicFile('src/bundle.cjs',Buffer.alloc(2*1024*1024+1,65)).includes('oversized_source_file'));
});
