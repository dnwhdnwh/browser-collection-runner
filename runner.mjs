import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {takeSecrets,downloadBundle} from './lib/bootstrap.mjs';
import {executeBundle} from './lib/execute.mjs';
export const collectionScopes=Object.freeze(['default','scope_1','scope_2','scope_4','scope_5']);
export function runnerOptions(args){
 const options={maxNavigations:900,collectionScope:'default'},seen=new Set();
 for(let index=0;index<args.length;index+=2){
  const key=args[index],value=args[index+1];
  if(seen.has(key)||value===undefined)throw Error('configuration_invalid');seen.add(key);
  if(key==='--max-navigations'&&/^\d+$/.test(value))options.maxNavigations=Number(value);
  else if(key==='--collection-scope'&&collectionScopes.includes(value))options.collectionScope=value;
  else throw Error('configuration_invalid');
 }
 if(!Number.isInteger(options.maxNavigations)||options.maxNavigations<1||options.maxNavigations>900)throw Error('configuration_invalid');
 return options;
}
export const navigationLimit=args=>runnerOptions(args).maxNavigations;
export function writeCatchUpOutput(summary,outputPath=process.env.GITHUB_OUTPUT){
 if(outputPath)fs.appendFileSync(outputPath,'needs_catch_up='+(summary?.needsCatchUp===true?'true':'false')+'\nretry_delay_seconds='+(summary?.retryDelaySeconds===600?'600':'0')+'\n');
}
export function safeRunId(env=process.env){
 if(env.GITHUB_RUN_ID!==undefined){const value='github-'+env.GITHUB_RUN_ID+'-'+(env.GITHUB_RUN_ATTEMPT||'1');if(!/^github-[0-9]+-[0-9]+$/.test(value))throw Error('configuration_invalid');return value;}
 return 'local-'+Date.now();
}
export async function main(args=process.argv.slice(2)){
 const config=takeSecrets();
 const {maxNavigations,collectionScope}=runnerOptions(args);
 const runId=safeRunId();
 const bytes=await downloadBundle(config);
 const result=await executeBundle(bytes,{token:config.token,maxNavigations,collectionScope,runId});
 writeCatchUpOutput(result.summary);
 const output=JSON.stringify(result.summary)+'\n';
 process.stdout.write(output);
 if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'```json\n'+output+'```\n');
 process.exitCode=result.exitCode;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('runner_failed');process.exitCode=1;});
