import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MAX_BUNDLE_BYTES,takeSecrets,validateSecrets,downloadBundle} from '../lib/bootstrap.mjs';
import {executeBundle,safeSummary,cleanEnvironment} from '../lib/execute.mjs';
import {navigationLimit,safeRunId} from '../runner.mjs';
const endpoint='https://example.test/bootstrap',token='synthetic-token-'.repeat(3);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=Buffer.from("export async function execute(){return {summary:{status:'completed',navigations:1},exitCode:0};}");
const config=(bytes=source)=>({endpoint,token,sha256:digest(bytes)});
function response(bytes=source,{url=endpoint,redirected=false,ok=true,contentType='application/javascript; charset=utf-8',length=null}={}){
 const headers=new Headers({'content-type':contentType});if(length!==null)headers.set('content-length',String(length));
 return {url,redirected,ok,headers,body:new Response(bytes).body};
}
async function withTemp(fn){const parent=await mkdtemp(path.join(tmpdir(),'runner-test-'));try{return await fn(parent);}finally{await rm(parent,{recursive:true,force:true});}}
test('all three Secrets are removed before returning validated config or throwing',()=>{
 const env={COLLECTOR_BOOTSTRAP_URL:endpoint,COLLECTOR_TOKEN:token,COLLECTOR_BUNDLE_SHA256:digest(source),PATH:'/synthetic'};
 assert.deepEqual(takeSecrets(env),config());assert.deepEqual(env,{PATH:'/synthetic'});
 const invalid={COLLECTOR_BOOTSTRAP_URL:endpoint,COLLECTOR_TOKEN:'',COLLECTOR_BUNDLE_SHA256:digest(source)};assert.throws(()=>takeSecrets(invalid));assert.deepEqual(invalid,{});
});
test('HTTPS URL without embedded credentials or fragment and strict SHA are required',()=>{
 for(const changes of [{endpoint:'http://example.test/bootstrap'},{endpoint:'https://user:pass@example.test/bootstrap'},{endpoint:endpoint+'#fragment'},{endpoint:'invalid'},{token:''},{token:token+'\n'},{sha256:'abc'},{sha256:digest(source).toUpperCase()}])assert.throws(()=>validateSecrets({...config(),...changes}));
});
test('authenticated GET is fixed to Secret URL and redirects are disabled',async()=>{
 const bytes=await downloadBundle(config(),{fetcher:async(u,o)=>{assert.equal(u,endpoint);assert.equal(o.method,'GET');assert.equal(o.redirect,'error');assert.equal(o.headers.Authorization,'Bearer '+token);assert.equal(o.headers.Accept,'application/javascript');return response();}});assert.deepEqual(bytes,source);
});
test('redirect flag, different response path and unsuccessful response fail closed',async()=>{
 for(const changes of [{url:'https://example.test/redirect'},{redirected:true},{ok:false}])await assert.rejects(downloadBundle(config(),{fetcher:async()=>response(source,changes)}),e=>e.message==='download_failed');
});
test('only application/javascript is accepted, with optional charset',async()=>{
 for(const contentType of ['text/javascript','application/json','text/html',''])await assert.rejects(downloadBundle(config(),{fetcher:async()=>response(source,{contentType})}));
 await downloadBundle(config(),{fetcher:async()=>response(source,{contentType:'application/javascript;charset=utf-8'})});
});
test('256 KiB exact boundary is accepted; declared or streamed overflow is rejected',async()=>{
 const bytes=Buffer.alloc(MAX_BUNDLE_BYTES,32);assert.equal((await downloadBundle(config(bytes),{fetcher:async()=>response(bytes,{length:MAX_BUNDLE_BYTES})})).length,MAX_BUNDLE_BYTES);
 await assert.rejects(downloadBundle(config(),{fetcher:async()=>response(source,{length:MAX_BUNDLE_BYTES+1})}));
 const larger=Buffer.alloc(MAX_BUNDLE_BYTES+1,32);await assert.rejects(downloadBundle(config(larger),{fetcher:async()=>response(larger,{length:1})}));
 await assert.rejects(downloadBundle(config(),{fetcher:async()=>response(source,{length:'invalid'})}));
});
test('empty content and modified module SHA fail before execution',async()=>{
 await assert.rejects(downloadBundle(config(Buffer.alloc(0)),{fetcher:async()=>response(Buffer.alloc(0))}));
 await assert.rejects(downloadBundle(config(),{fetcher:async()=>response(Buffer.from(source.toString()+' '))}));
});
test('upstream error text is replaced by a fixed safe error',async()=>{
 await assert.rejects(downloadBundle(config(),{fetcher:async()=>{throw Error(token+' '+endpoint+' RAW_SOURCE');}}),e=>e.message==='download_failed');
});
test('public execution accepts only navigation cap and validated run IDs',()=>{
 assert.equal(navigationLimit([]),300);assert.equal(navigationLimit(['--max-navigations','1']),1);
 for(const args of [['--max-navigations','0'],['--max-navigations','301'],['--max-navigations','1.5'],['--name','private'],['--url',endpoint]])assert.throws(()=>navigationLimit(args));
 assert.equal(safeRunId({GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2'}),'github-123-2');assert.match(safeRunId({}),/^local-[0-9]+$/);assert.throws(()=>safeRunId({GITHUB_RUN_ID:token}));
});
test('child environment includes only operational allowlist and no Secrets or NODE_OPTIONS',()=>{
 assert.deepEqual(cleanEnvironment({PATH:'/bin',HOME:'/synthetic',COLLECTOR_BOOTSTRAP_URL:endpoint,COLLECTOR_TOKEN:token,COLLECTOR_BUNDLE_SHA256:digest(source),NODE_OPTIONS:'--inspect',GITHUB_TOKEN:'synthetic'}),{PATH:'/bin',HOME:'/synthetic'});
});
test('safe summary emits only fixed statuses, bounded integer counts and booleans',()=>{
 const r=safeSummary({status:token,accepted:token,navigations:2,held:-1,noOffers:1.5,raw:source.toString(),url:endpoint,token,coverage:{fresh:1,capacityInsufficient:false,source:token},budgetReserved:true,timeBudgetExhausted:'true'});
 assert.deepEqual(r,{status:'failed',navigations:2,budgetReserved:true,coverage:{fresh:1,capacityInsufficient:false}});
 const raw=JSON.stringify(r);for(const privateValue of [token,endpoint,source.toString()])assert.ok(!raw.includes(privateValue));
});
test('bundle executes over IPC with private file permissions and no configuration environment',async()=>withTemp(async tempParent=>{
 const fixture=Buffer.from(`import {stat} from 'node:fs/promises';export async function execute({token,maxNavigations,runId}){if(token!==${JSON.stringify(token)}||maxNavigations!==9||runId!=='github-12-3')throw Error('bad_arguments');for(const key of ['COLLECTOR_BOOTSTRAP_URL','COLLECTOR_TOKEN','COLLECTOR_BUNDLE_SHA256'])if(process.env[key]!==undefined)throw Error('environment_leak');const file=await stat(new URL(import.meta.url));const dir=await stat(new URL('.',import.meta.url));if((file.mode&511)!==384||(dir.mode&511)!==448)throw Error('bad_permissions');return {summary:{status:'completed',navigations:9},exitCode:0};}`);
 const r=await executeBundle(fixture,{token,maxNavigations:9,runId:'github-12-3',tempParent});assert.deepEqual(r,{summary:{status:'completed',navigations:9},exitCode:0});assert.deepEqual(await readdir(tempParent),[]);
}));
test('module console, raw stdout/stderr and child inherited output never reach public output',()=>{
 const fixture=`import fs from 'node:fs';import {spawn,spawnSync} from 'node:child_process';console.log('PRIVATE_IMPORT');export async function execute({token}){console.log(token);console.error(token);fs.writeSync(1,token);fs.writeSync(2,token);spawnSync(process.execPath,['-e','console.log("PRIVATE_CHILD")'],{stdio:'inherit'});return {summary:{status:'completed',navigations:1,token,source:'PRIVATE_SOURCE',url:${JSON.stringify(endpoint)}},exitCode:0};}`;
 const moduleURL=new URL('../lib/execute.mjs',import.meta.url).href;
 const caller=`import {executeBundle} from ${JSON.stringify(moduleURL)};const r=await executeBundle(Buffer.from(${JSON.stringify(fixture)}),{token:${JSON.stringify(token)}});console.log(JSON.stringify(r));`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',caller],{encoding:'utf8'});assert.equal(r.status,0);assert.equal(r.stderr,'');assert.deepEqual(JSON.parse(r.stdout),{summary:{status:'completed',navigations:1},exitCode:0});
});
test('import errors and thrown private errors remove temp files and expose fixed failure only',async()=>withTemp(async tempParent=>{
 for(const fixture of ['not valid JavaScript !!',`throw Error(${JSON.stringify(token+' '+endpoint)});`,`export async function execute(){throw Error(${JSON.stringify(token)});}`,'export const value=1;'])await assert.rejects(executeBundle(Buffer.from(fixture),{token,tempParent}),e=>e.message==='execution_failed');
 assert.deepEqual(await readdir(tempParent),[]);
}));
test('execution timeout kills child and removes its private directory',async()=>withTemp(async tempParent=>{
 await assert.rejects(executeBundle(Buffer.from('export async function execute(){setInterval(()=>{},1000);await new Promise(()=>{});}'),{token,tempParent,timeoutMs:100}),e=>e.message==='execution_failed');assert.deepEqual(await readdir(tempParent),[]);
}));
test('nonzero or invalid bundle status and exitCode cannot become successful',async()=>withTemp(async tempParent=>{
 for(const value of [{summary:{status:'partial_failure'},exitCode:1},{summary:{status:token},exitCode:0},{summary:{status:'completed'},exitCode:'0'}]){const r=await executeBundle(Buffer.from('export async function execute(){return '+JSON.stringify(value)+';}'),{token,tempParent});assert.equal(r.exitCode,1);}assert.deepEqual(await readdir(tempParent),[]);
}));
test('invalid navigation cap or run ID never writes a bundle',async()=>withTemp(async tempParent=>{
 await assert.rejects(executeBundle(source,{token,maxNavigations:0,tempParent}));await assert.rejects(executeBundle(source,{token,runId:token,tempParent}));assert.deepEqual(await readdir(tempParent),[]);
}));
test('missing Secrets fail with a fixed message and empty stdout',()=>{
 const r=spawnSync(process.execPath,['runner.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{PATH:process.env.PATH},encoding:'utf8'});assert.equal(r.status,1);assert.equal(r.stderr.trim(),'runner_failed');assert.equal(r.stdout,'');
});
test('workflow has only navigation input and execution-only Secrets without uploads or PR/push triggers',async()=>{
 const y=await readFile(new URL('../.github/workflows/collect.yml',import.meta.url),'utf8');assert.match(y,/timeout-minutes: 120/);assert.match(y,/persist-credentials: false/);assert.match(y,/vars.COLLECTION_ENABLED == 'true'/);assert.match(y,/github.repository == 'dnwhdnwh\/browser-collection-runner'/);assert.match(y,/17 0,6,12,18 \* \* \*/);assert.match(y,/node-version: '22'/);assert.match(y,/cancel-in-progress: false/);assert.ok(!/upload-artifact|actions\/cache|pull_request|push:|\n      name:/.test(y));
 const [before,execute]=y.split('      - name: Execute verified private bundle');assert.ok(!before.includes('secrets.'));for(const key of ['COLLECTOR_BOOTSTRAP_URL','COLLECTOR_TOKEN','COLLECTOR_BUNDLE_SHA256'])assert.equal((execute.match(new RegExp('secrets\\.'+key,'g'))||[]).length,1);
});

test('handled termination signal stops execution and removes private files',async()=>withTemp(async tempParent=>{
 const ready=path.join(tempParent,'ready');
 const fixture=`import fs from 'node:fs';export async function execute(){fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);await new Promise(()=>{});}`;
 const moduleURL=new URL('../lib/execute.mjs',import.meta.url).href;
 const caller=`import {executeBundle} from ${JSON.stringify(moduleURL)};executeBundle(Buffer.from(${JSON.stringify(fixture)}),{token:${JSON.stringify(token)},tempParent:${JSON.stringify(tempParent)}}).catch(()=>{console.log('safe_failure');process.exitCode=1;});`;
 const child=spawn(process.execPath,['--input-type=module','-e',caller],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try{
  let readyFound=false;for(let i=0;i<200;i++){try{await readFile(ready);readyFound=true;break;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(readyFound,true);child.kill('SIGTERM');const result=await exited;assert.equal(result.code,1);assert.equal(stdout.trim(),'safe_failure');assert.equal(stderr,'');assert.deepEqual(await readdir(tempParent),['ready']);
 }finally{child.kill('SIGTERM');}
}));
