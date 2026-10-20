import {fork} from 'node:child_process';
import {mkdtemp,chmod,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const workerPath=fileURLToPath(new URL('../worker.mjs',import.meta.url));
export function safeSummary(value){
 const result={status:['completed','attention_required','partial_failure'].includes(value?.status)?value.status:'failed'};
 for(const key of ['publishedRevision','selectedTargets','attemptedTargets','navigations','dailyReservedNavigations','accepted','held','noOffers','remainingEligibleTargets','checkpointCount'])if(Number.isSafeInteger(value?.[key])&&value[key]>=0)result[key]=value[key];
 if(value?.retryDelaySeconds===0||value?.retryDelaySeconds===600)result.retryDelaySeconds=value.retryDelaySeconds;
 for(const key of ['budgetReserved','timeBudgetExhausted','sourceBackoffActive','needsCatchUp'])if(typeof value?.[key]==='boolean')result[key]=value[key];
 if(value?.coverage&&typeof value.coverage==='object'){
  result.coverage={};
  for(const key of ['targetCount','fresh','stale','missingOrUnknown','checkedWithin14Days','neverAttempted','estimatedSweepPages','estimatedSweepDays','dueSoon','overdue','remainingPages','remainingCapacity14Days','remainingDailyCapacity','pagesPerRun','scheduledRunsPerDay','backoffPastDeadline'])if(Number.isSafeInteger(value.coverage[key])&&value.coverage[key]>=0)result.coverage[key]=value.coverage[key];
  for(const key of ['capacityInsufficient','deadlineMissRisk','allTargetsChecked','allPricesFresh'])if(typeof value.coverage[key]==='boolean')result.coverage[key]=value.coverage[key];
 }
 return result;
}
export function cleanEnvironment(env=process.env){
 const result={};
 for(const key of ['PATH','HOME','TMPDIR','TEMP','TMP','SystemRoot','SYSTEMROOT','USERPROFILE','LOCALAPPDATA','LANG','LC_ALL','DISPLAY','XDG_RUNTIME_DIR'])if(env[key])result[key]=env[key];
 return result;
}
export async function executeBundle(bytes,{token,maxNavigations=900,runId='local-'+Date.now(),timeoutMs=110*60*1000,tempParent=tmpdir()}={}){
 if(!Number.isInteger(maxNavigations)||maxNavigations<1||maxNavigations>900||!/^(?:github-[0-9]+-[0-9]+|local-[0-9]+)$/.test(runId))throw Error('execution_failed');
 const directory=await mkdtemp(path.join(tempParent,'private-runner-'));
 try{
  await chmod(directory,0o700);
  const bundlePath=path.join(directory,'bundle.mjs');
  await writeFile(bundlePath,bytes,{mode:0o600,flag:'wx'});
  return await new Promise((resolve,reject)=>{
   const child=fork(workerPath,[],{cwd:directory,env:cleanEnvironment(),stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});
   let received=null,failed=false;
   const fail=()=>{failed=true;child.kill('SIGKILL');};
   const timer=setTimeout(fail,timeoutMs);
   const interrupt=()=>fail();
   process.once('SIGTERM',interrupt);process.once('SIGINT',interrupt);
   child.once('error',()=>{clearTimeout(timer);process.removeListener('SIGTERM',interrupt);process.removeListener('SIGINT',interrupt);reject(Error('execution_failed'));});
   child.on('message',message=>{
    if(received!==null||message?.type!=='result'||typeof message?.ok!=='boolean'){fail();return;}
    received=message;
   });
   child.once('exit',(code,signal)=>{
    clearTimeout(timer);process.removeListener('SIGTERM',interrupt);process.removeListener('SIGINT',interrupt);
    if(failed||signal||code!==0||!received?.ok){reject(Error('execution_failed'));return;}
    const summary=safeSummary(received.value?.summary);
    const exitCode=received.value?.exitCode===0&&summary.status!=='failed'?0:1;
    resolve({summary,exitCode});
   });
   child.send({bundlePath,token,maxNavigations,runId},error=>{if(error)fail();});
  });
 }finally{await rm(directory,{recursive:true,force:true});}
}
