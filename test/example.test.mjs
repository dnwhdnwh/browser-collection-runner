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
import {navigationLimit,safeRunId,writeCatchUpOutput} from '../runner.mjs';
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
 assert.equal(navigationLimit([]),900);assert.equal(navigationLimit(['--max-navigations','1']),1);
 for(const args of [['--max-navigations','0'],['--max-navigations','901'],['--max-navigations','1.5'],['--name','private'],['--url',endpoint]])assert.throws(()=>navigationLimit(args));
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
 const y=await readFile(new URL('../.github/workflows/collect.yml',import.meta.url),'utf8');assert.match(y,/timeout-minutes: 120/);assert.match(y,/persist-credentials: false/);assert.match(y,/vars.COLLECTION_ENABLED == 'true'/);assert.match(y,/github.repository == 'dnwhdnwh\/browser-collection-runner'/);assert.ok(y.includes("- cron: '17 */2 * * *'"));assert.match(y,/node-version: '22'/);assert.match(y,/cancel-in-progress: false/);assert.ok(!/upload-artifact|actions\/cache|pull_request|push:|\n      name:/.test(y));
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

test('maintenance isolates write permission, monthly schedule and GitHub token from collection',async()=>{
 const collect=await readFile(new URL('../.github/workflows/collect.yml',import.meta.url),'utf8');
 const maintenance=await readFile(new URL('../.github/workflows/maintenance.yml',import.meta.url),'utf8');
 assert.match(collect,/permissions:\n  contents: read/);assert.ok(!collect.includes('contents: write'));
 assert.match(maintenance,/permissions: \{\}/);assert.match(maintenance,/permissions:\n      contents: write/);assert.match(maintenance,/29 1 1 \* \*/);assert.match(maintenance,/timeout-minutes: 3/);assert.match(maintenance,/github.repository == 'dnwhdnwh\/browser-collection-runner' && vars.COLLECTION_ENABLED == 'true'/);
 assert.match(maintenance,/group: browser-collection-maintenance/);assert.match(maintenance,/cancel-in-progress: false/);assert.match(maintenance,/GH_TOKEN: \$\{\{ github.token \}\}/);
 assert.ok(!/uses:|secrets\.|COLLECTOR_|upload-artifact|actions\/cache|pull_request|push:|inputs:/.test(maintenance));
});
async function invokeMaintenance(fetcher,{token='synthetic-github-token'}={}){
 const workflow=await readFile(new URL('../.github/workflows/maintenance.yml',import.meta.url),'utf8');
 const script=workflow.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/)[1].split('\n').map(line=>line.slice(10)).join('\n');
 const processState={env:token===null?{}:{GH_TOKEN:token}},stdout=[],stderr=[],calls=[];
 const execute=new Function('fetch','process','console','AbortSignal','Buffer','return '+script);
 await execute(async(url,options)=>{assert.equal(processState.env.GH_TOKEN,undefined);calls.push({url,options});return fetcher(url,options);},processState,{log:value=>stdout.push(value),error:value=>stderr.push(value)},AbortSignal,Buffer);
 return {stdout,stderr,calls,exitCode:processState.exitCode||0};
}
test('first monthly record creates only public timestamp and schema on fixed main path',async()=>{
 const result=await invokeMaintenance(async(url,options)=>options.method==='PUT'?{status:201}:{status:404});assert.equal(result.exitCode,0);assert.deepEqual(result.stdout,['maintenance_completed']);assert.deepEqual(result.stderr,[]);assert.equal(result.calls.length,2);
 const [read,write]=result.calls;assert.equal(read.url,'https://api.github.com/repos/dnwhdnwh/browser-collection-runner/contents/.github/maintenance.json?ref=main');assert.equal(write.url,'https://api.github.com/repos/dnwhdnwh/browser-collection-runner/contents/.github/maintenance.json');assert.equal(read.options.redirect,'error');assert.equal(write.options.redirect,'error');
 const body=JSON.parse(write.options.body),content=JSON.parse(Buffer.from(body.content,'base64').toString('utf8'));assert.equal(body.branch,'main');assert.equal(body.sha,undefined);assert.deepEqual(Object.keys(content).sort(),['maintainedAt','schemaVersion']);assert.equal(content.schemaVersion,1);assert.equal(new Date(content.maintainedAt).toISOString(),content.maintainedAt);assert.ok(!JSON.stringify(content).includes('synthetic-github-token'));
});
test('existing monthly record updates using its content SHA without copying old data',async()=>{
 const sha='a'.repeat(40);const result=await invokeMaintenance(async(url,options)=>options.method==='PUT'?{status:200}:{status:200,json:async()=>({type:'file',path:'.github/maintenance.json',sha,content:'synthetic-old-private-data'})});assert.equal(result.exitCode,0);const body=JSON.parse(result.calls[1].options.body);assert.equal(body.sha,sha);assert.ok(!Buffer.from(body.content,'base64').toString('utf8').includes('synthetic-old-private-data'));
});
test('all non-404 read failures, update failures and malformed existing records fail safely',async()=>{
 for(const status of [401,403,429,500]){const result=await invokeMaintenance(async()=>({status}));assert.equal(result.exitCode,1);assert.equal(result.calls.length,1);assert.deepEqual(result.stdout,[]);assert.deepEqual(result.stderr,['maintenance_failed']);}
 for(const status of [400,401,403,404,409,429,500]){const result=await invokeMaintenance(async(url,options)=>({status:options.method==='PUT'?status:404}));assert.equal(result.exitCode,1);assert.deepEqual(result.stderr,['maintenance_failed']);}
 for(const data of [{type:'dir',path:'.github/maintenance.json',sha:'a'.repeat(40)},{type:'file',path:'wrong',sha:'a'.repeat(40)},{type:'file',path:'.github/maintenance.json',sha:'wrong'}]){const result=await invokeMaintenance(async()=>({status:200,json:async()=>data}));assert.equal(result.exitCode,1);assert.equal(result.calls.length,1);}
 const raw=await invokeMaintenance(async()=>{throw Error('synthetic-sensitive-error');});assert.deepEqual(raw.stderr,['maintenance_failed']);assert.deepEqual(raw.stdout,[]);
 const missing=await invokeMaintenance(()=>assert.fail('API called without GitHub token'),{token:null});assert.equal(missing.exitCode,1);assert.equal(missing.calls.length,0);
});

test('browser preflight uses only pinned CLI, fixed session and about:blank before Secrets',async()=>{
 const {smokeArgs,browserSmoke}=await import('../browser-smoke.mjs');const calls=[];
 await browserSmoke({command:async args=>{calls.push(args);return {status:0,stdout:JSON.stringify(args[0]==='run-code'?{result:{url:'about:blank'}}:{})};}});
 assert.deepEqual(calls.map(args=>args[0]),['open','run-code','close']);assert.deepEqual(calls[0],['open','about:blank','--browser','chrome']);assert.ok(calls[1][1].includes('document.URL'));assert.deepEqual(smokeArgs(['close']),['--yes','--package','@playwright/cli@0.1.22','playwright-cli','-s=runner-preflight','--json','close']);
 const y=await readFile(new URL('../.github/workflows/collect.yml',import.meta.url),'utf8');const [before,execute]=y.split('      - name: Execute verified private bundle');assert.match(before,/node browser-smoke.mjs/);assert.ok(!before.includes('secrets.'));assert.ok(execute.includes('secrets.COLLECTOR_TOKEN'));
});
test('browser preflight closes after open failure and retains first command diagnostics',async()=>{
 const {browserSmoke}=await import('../browser-smoke.mjs');const calls=[];
 await assert.rejects(browserSmoke({command:async args=>{calls.push(args[0]);return args[0]==='open'?{status:1,stdout:'synthetic-open-output',stderr:'synthetic-first-browser-error'}:{status:1,stdout:'synthetic-close-failure'};}}),error=>error.message.includes('synthetic-first-browser-error')&&error.message.includes('synthetic-open-output')&&!error.message.includes('synthetic-close-failure'));
 assert.deepEqual(calls,['open','close']);
});
test('browser preflight closes after evaluation or parsing failure and reports close-only errors',async()=>{
 const {browserSmoke}=await import('../browser-smoke.mjs');
 for(const mode of ['evaluation','parse','mismatch','close']){
  const calls=[];await assert.rejects(browserSmoke({command:async args=>{calls.push(args[0]);if(args[0]==='run-code'){if(mode==='evaluation')return {status:1,stderr:'synthetic-evaluation-error'};if(mode==='parse')return {status:0,stdout:'not-json'};return {status:0,stdout:JSON.stringify({result:{url:mode==='mismatch'?'invalid':'about:blank'}})};}if(args[0]==='close'&&mode==='close')return {status:1,stderr:'synthetic-close-error'};return {status:0,stdout:'{}'};}}));assert.deepEqual(calls,['open','run-code','close']);
 }
});
test('browser preflight supports JSON-encoded document results and spawn failures',async()=>{
 const {browserSmoke}=await import('../browser-smoke.mjs');await browserSmoke({command:async args=>({status:0,stdout:JSON.stringify(args[0]==='run-code'?{result:JSON.stringify({url:'about:blank'})}:{})})});
 const calls=[];await assert.rejects(browserSmoke({command:async args=>{calls.push(args[0]);return args[0]==='open'?{status:null,error:Error('synthetic-spawn-error')}:{status:0,stdout:'{}'};}}),/synthetic-spawn-error/);assert.deepEqual(calls,['open','close']);
});

test('navigation requests and isolated bundle defaults allow up to 900 only',async()=>withTemp(async tempParent=>{
 assert.equal(navigationLimit(['--max-navigations','900']),900);assert.throws(()=>navigationLimit(['--max-navigations','901']));
 const fixture=Buffer.from("export async function execute({maxNavigations}){return {summary:{status:'completed',navigations:maxNavigations},exitCode:0};}");
 const result=await executeBundle(fixture,{token,tempParent});assert.equal(result.summary.navigations,900);
 await assert.rejects(executeBundle(fixture,{token,tempParent,maxNavigations:901}));assert.deepEqual(await readdir(tempParent),[]);
}));
test('coverage progress, deadline and recovery fields use strict public numeric and boolean types',()=>{
 const counts=['dueSoon','overdue','remainingPages','remainingCapacity14Days','remainingDailyCapacity','pagesPerRun','scheduledRunsPerDay','backoffPastDeadline'];
 const flags=['deadlineMissRisk','allTargetsChecked','allPricesFresh'];
 const summary=safeSummary({status:'completed',remainingEligibleTargets:7,checkpointCount:2,sourceBackoffActive:false,needsCatchUp:true,coverage:{...Object.fromEntries(counts.map((k,i)=>[k,i])),...Object.fromEntries(flags.map(k=>[k,true]))}});
 for(const [i,key] of counts.entries())assert.equal(summary.coverage[key],i);for(const key of flags)assert.equal(summary.coverage[key],true);assert.equal(summary.remainingEligibleTargets,7);assert.equal(summary.checkpointCount,2);assert.equal(summary.sourceBackoffActive,false);assert.equal(summary.needsCatchUp,true);
 for(const invalid of [token,-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN,{},[]]){const r=safeSummary({status:'completed',remainingEligibleTargets:invalid,checkpointCount:invalid,sourceBackoffActive:invalid,needsCatchUp:invalid,coverage:{...Object.fromEntries(counts.map(k=>[k,invalid])),...Object.fromEntries(flags.map(k=>[k,invalid]))}});assert.deepEqual(r,{status:'completed',coverage:{}});}
});
test('GITHUB_OUTPUT contains only fixed boolean and retry-delay lines without raw bundle data',async()=>withTemp(async parent=>{
 const output=path.join(parent,'output');for(const needsCatchUp of [true,false,undefined,'true','true\nunsafe=value',1,{},[]])writeCatchUpOutput({needsCatchUp,raw:token},output);
 const body=await readFile(output,'utf8');assert.equal(body,'needs_catch_up=true\nretry_delay_seconds=0\n'+('needs_catch_up=false\nretry_delay_seconds=0\n').repeat(7));assert.ok(!body.includes(token));
}));
test('IPC execution preserves only true boolean recovery signals and removes unapproved data',async()=>withTemp(async tempParent=>{
 for(const needsCatchUp of [true,'true',{value:true}]){const value={summary:{status:'completed',needsCatchUp,sourceBackoffActive:false,remainingEligibleTargets:3,raw:token},exitCode:0};const r=await executeBundle(Buffer.from('export async function execute(){return '+JSON.stringify(value)+';}'),{token,tempParent});assert.equal(r.summary.needsCatchUp,needsCatchUp===true?true:undefined);assert.equal(r.summary.raw,undefined);assert.equal(r.summary.sourceBackoffActive,false);}
}));
test('follow-up dispatch is gated by successful collect and isolated from collection credentials',async()=>{
 const y=await readFile(new URL('../.github/workflows/collect.yml',import.meta.url),'utf8'),[collect,follow]=y.split('  follow_up:\n');
 assert.match(collect,/collect:\n    permissions:\n      contents: read/);assert.match(collect,/needs_catch_up: \$\{\{ steps.run.outputs.needs_catch_up \}\}/);assert.match(collect,/name: Execute verified private bundle\n        id: run/);assert.ok(!collect.includes('actions: write'));assert.ok(y.includes("- cron: '17 */2 * * *'"));assert.match(collect,/default: 900/);
 assert.match(follow,/needs: collect/);assert.match(follow,/needs.collect.result == 'success'/);assert.match(follow,/needs.collect.outputs.needs_catch_up == 'true'/);assert.match(follow,/github.repository == 'dnwhdnwh\/browser-collection-runner'/);assert.match(follow,/vars.COLLECTION_ENABLED == 'true'/);assert.match(follow,/permissions:\n      actions: write/);assert.match(follow,/timeout-minutes: 15/);assert.match(follow,/GH_TOKEN: \$\{\{ github.token \}\}/);assert.match(follow,/AbortSignal.timeout\(15000\)/);assert.ok(!/secrets\.|COLLECTOR_|uses:|contents:|inputs\.name|upload-artifact|cache|pull_request|push:/.test(follow));
});
async function invokeFollowUp(fetcher,{token='synthetic-follow-up-token',retryDelay='0'}={}){
 const workflow=await readFile(new URL('../.github/workflows/collect.yml',import.meta.url),'utf8'),follow=workflow.split('  follow_up:\n')[1];
 const script=follow.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/)[1].split('\n').map(line=>line.slice(10)).join('\n');
 const state={env:{RETRY_DELAY_SECONDS:retryDelay,...(token===null?{}:{GH_TOKEN:token})}},stdout=[],stderr=[],calls=[],delays=[],events=[];
 const execute=new Function('fetch','process','console','AbortSignal','setTimeout','return '+script);
 await execute(async(url,options)=>{assert.equal(state.env.GH_TOKEN,undefined);assert.equal(state.env.RETRY_DELAY_SECONDS,undefined);events.push('fetch');calls.push({url,options});return fetcher(url,options);},state,{log:v=>stdout.push(v),error:v=>stderr.push(v)},AbortSignal,(resolve,ms)=>{assert.equal(state.env.GH_TOKEN,undefined);assert.equal(state.env.RETRY_DELAY_SECONDS,undefined);events.push('delay');delays.push(ms);resolve();});
 return {stdout,stderr,calls,delays,events,exitCode:state.exitCode||0};
}
test('follow-up sends one fixed main dispatch with cap 900 and ignores response payload',async()=>{
 for(const status of [200,204]){const r=await invokeFollowUp(async()=>({status,json:()=>assert.fail('response payload must remain unread')}));assert.equal(r.exitCode,0);assert.deepEqual(r.stdout,['follow_up_requested']);assert.deepEqual(r.stderr,[]);assert.equal(r.calls.length,1);const {url,options}=r.calls[0];assert.equal(url,'https://api.github.com/repos/dnwhdnwh/browser-collection-runner/actions/workflows/collect.yml/dispatches');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),{ref:'main',inputs:{max_navigations:'900'}});}
});
test('follow-up never retries API errors and exposes only fixed failure messages',async()=>{
 for(const status of [202,302,401,403,404,409,429,500]){const r=await invokeFollowUp(async()=>({status}));assert.equal(r.exitCode,1);assert.equal(r.calls.length,1);assert.deepEqual(r.stderr,['follow_up_failed']);assert.deepEqual(r.stdout,[]);}
 const r=await invokeFollowUp(async()=>{throw Error(token);});assert.equal(r.exitCode,1);assert.deepEqual(r.stderr,['follow_up_failed']);assert.deepEqual(r.stdout,[]);
 const missing=await invokeFollowUp(()=>assert.fail('API called without builtin token'),{token:null});assert.equal(missing.exitCode,1);assert.equal(missing.calls.length,0);
});

test('retry delay permits only numeric zero or 600 seconds in public summaries',()=>{
 for(const retryDelaySeconds of [0,600])assert.equal(safeSummary({status:'partial_failure',retryDelaySeconds}).retryDelaySeconds,retryDelaySeconds);
 for(const retryDelaySeconds of [1,599,601,-1,'0','600',true,null,{},[],NaN])assert.equal(safeSummary({status:'partial_failure',retryDelaySeconds}).retryDelaySeconds,undefined);
});
test('GitHub retry output uses only fixed 0 or 600 with no raw value interpolation',async()=>withTemp(async parent=>{
 const output=path.join(parent,'output');for(const retryDelaySeconds of [600,0,'600','600\nunsafe=value',601,{},undefined])writeCatchUpOutput({needsCatchUp:true,retryDelaySeconds},output);
 const lines=(await readFile(output,'utf8')).trim().split('\n');assert.equal(lines.length,14);assert.equal(lines[1],'retry_delay_seconds=600');for(let i=0;i<7;i++){assert.equal(lines[i*2],'needs_catch_up=true');assert.equal(lines[i*2+1],i===0?'retry_delay_seconds=600':'retry_delay_seconds=0');}
}));
test('successful recovery scheduling preserves partial failure and delayed follow-up without masking real failures',async()=>withTemp(async tempParent=>{
 const recovery={summary:{status:'partial_failure',needsCatchUp:true,retryDelaySeconds:600},exitCode:0};
 const result=await executeBundle(Buffer.from('export async function execute(){return '+JSON.stringify(recovery)+';}'),{token,tempParent});assert.deepEqual(result,recovery);
 const failure={summary:{status:'partial_failure',needsCatchUp:false,retryDelaySeconds:0},exitCode:1};
 const failed=await executeBundle(Buffer.from('export async function execute(){return '+JSON.stringify(failure)+';}'),{token,tempParent});assert.deepEqual(failed,failure);
}));
test('follow-up waits exactly ten minutes only for the validated 600 setting after clearing token environment',async()=>{
 const delayed=await invokeFollowUp(async()=>({status:204}),{retryDelay:'600'});assert.equal(delayed.exitCode,0);assert.deepEqual(delayed.delays,[600000]);assert.deepEqual(delayed.events,['delay','fetch']);
 const immediate=await invokeFollowUp(async()=>({status:204}),{retryDelay:'0'});assert.equal(immediate.exitCode,0);assert.deepEqual(immediate.delays,[]);assert.deepEqual(immediate.events,['fetch']);
 for(const retryDelay of ['',null,'0600','600.0','601','600\nunsafe=value',600]){const invalid=await invokeFollowUp(()=>assert.fail('invalid retry input dispatched'),{retryDelay});assert.equal(invalid.exitCode,1);assert.equal(invalid.calls.length,0);assert.deepEqual(invalid.delays,[]);assert.deepEqual(invalid.stderr,['follow_up_failed']);}
});
test('delayed follow-up output and timeout are wired without adding other job permissions',async()=>{
 const y=await readFile(new URL('../.github/workflows/collect.yml',import.meta.url),'utf8');assert.match(y,/retry_delay_seconds: \$\{\{ steps.run.outputs.retry_delay_seconds \}\}/);const follow=y.split('  follow_up:\n')[1];assert.match(follow,/RETRY_DELAY_SECONDS: \$\{\{ needs.collect.outputs.retry_delay_seconds \}\}/);assert.match(follow,/timeout-minutes: 15/);assert.match(follow,/\['0','600'\]\.includes\(delay\)/);assert.match(follow,/setTimeout\(resolve,600000\)/);assert.match(follow,/needs.collect.result == 'success'/);assert.match(follow,/actions: write/);assert.ok(!/contents:|secrets\.|COLLECTOR_/.test(follow));
});

test('failure diagnostics allow only the fixed phase and kind codes',()=>{
 for(const failurePhase of ['bootstrap','reservation','checkpoint','final','browser','none'])assert.deepEqual(safeSummary({status:'partial_failure',failurePhase}),{status:'partial_failure',failurePhase});
 for(const failureKind of ['none','network_error','request_timeout','resource_exceeded','service_unavailable','rate_limited','revision_conflict','validation_rejected','authentication_failed','payload_too_large','response_invalid','endpoint_invalid','browser_collection_failed','publication_not_confirmed','unexpected_failure'])assert.deepEqual(safeSummary({status:'partial_failure',failureKind}),{status:'partial_failure',failureKind});
 for(const invalid of [undefined,null,0,true,{},[],['none'],'NONE','network_error\nunsafe=value',token,endpoint,source.toString()])assert.deepEqual(safeSummary({status:'partial_failure',failurePhase:invalid,failureKind:invalid}),{status:'partial_failure'});
});
test('failure HTTP status accepts only zero or safe integers from 100 through 599',()=>{
 for(const failureHttpStatus of [0,100,200,400,599])assert.deepEqual(safeSummary({failureHttpStatus}),{status:'failed',failureHttpStatus});
 for(const failureHttpStatus of [undefined,null,-1,1,99,600,100.5,Number.MAX_SAFE_INTEGER+1,Infinity,NaN,'0','200',true,{},[],token])assert.deepEqual(safeSummary({failureHttpStatus}),{status:'failed'});
});
test('save recovery counts require nonnegative safe integers with no type coercion',()=>{
 for(const count of [0,1,Number.MAX_SAFE_INTEGER])assert.deepEqual(safeSummary({saveRetryCount:count,recoveredPublicationCount:count}),{status:'failed',saveRetryCount:count,recoveredPublicationCount:count});
 for(const count of [undefined,null,-1,1.5,Number.MAX_SAFE_INTEGER+1,Infinity,NaN,'0','1',true,{},[],token])assert.deepEqual(safeSummary({saveRetryCount:count,recoveredPublicationCount:count}),{status:'failed'});
});
test('IPC diagnostics expose no private domain, target, raw error or response body',async()=>withTemp(async tempParent=>{
 const privateValues=[endpoint,token,'synthetic-private-target','synthetic-raw-response'];
 const value={summary:{status:'partial_failure',failurePhase:'checkpoint',failureKind:'request_timeout',failureHttpStatus:0,saveRetryCount:2,recoveredPublicationCount:1,needsCatchUp:true,retryDelaySeconds:600,url:endpoint,target:privateValues[2],rawError:privateValues.join(' '),responseBody:privateValues[3]},exitCode:0};
 const result=await executeBundle(Buffer.from('export async function execute(){return '+JSON.stringify(value)+';}'),{token,tempParent});
 assert.deepEqual(result,{summary:{status:'partial_failure',saveRetryCount:2,recoveredPublicationCount:1,failurePhase:'checkpoint',failureKind:'request_timeout',failureHttpStatus:0,retryDelaySeconds:600,needsCatchUp:true},exitCode:0});
 const serialized=JSON.stringify(result);for(const privateValue of privateValues)assert.ok(!serialized.includes(privateValue));
 const output=path.join(tempParent,'output');writeCatchUpOutput(result.summary,output);assert.equal(await readFile(output,'utf8'),'needs_catch_up=true\nretry_delay_seconds=600\n');
 const poisoned={...value,summary:{...value.summary,failurePhase:privateValues.join(' '),failureKind:privateValues.join(' '),failureHttpStatus:token,saveRetryCount:token,recoveredPublicationCount:token}};
 const rejected=await executeBundle(Buffer.from('export async function execute(){return '+JSON.stringify(poisoned)+';}'),{token,tempParent});assert.deepEqual(rejected,{summary:{status:'partial_failure',retryDelaySeconds:600,needsCatchUp:true},exitCode:0});
}));
test('diagnostics cannot override failure exits or boolean recovery gates',async()=>withTemp(async tempParent=>{
 const value={summary:{status:'partial_failure',failurePhase:'final',failureKind:'revision_conflict',failureHttpStatus:409,saveRetryCount:0,recoveredPublicationCount:0,needsCatchUp:'true',retryDelaySeconds:'600'},exitCode:1};
 const result=await executeBundle(Buffer.from('export async function execute(){return '+JSON.stringify(value)+';}'),{token,tempParent});assert.equal(result.exitCode,1);assert.equal(result.summary.needsCatchUp,undefined);assert.equal(result.summary.retryDelaySeconds,undefined);assert.equal(result.summary.failureKind,'revision_conflict');
}));

test('read strategy diagnostics expose only fixed modes and nonnegative integer counts',()=>{
 for(const readMode of ['selected','full','readiness'])assert.deepEqual(safeSummary({status:'completed',readMode,rawSnapshotTargets:10,planningTargets:923}),{status:'completed',rawSnapshotTargets:10,planningTargets:923,readMode});
 for(const invalid of [token,endpoint,'selected\nunsafe=value',undefined,null,-1,1.5,NaN,{},[],true,'10'])assert.deepEqual(safeSummary({readMode:invalid,rawSnapshotTargets:invalid,planningTargets:invalid}),{status:'failed'});
});
