import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {takeSecrets,downloadBundle} from './lib/bootstrap.mjs';
import {executeBundle} from './lib/execute.mjs';
export function navigationLimit(args){
 if(args.length===0)return 900;
 if(args.length!==2||args[0]!=='--max-navigations'||!/^\d+$/.test(args[1]))throw Error('configuration_invalid');
 const limit=Number(args[1]);if(!Number.isInteger(limit)||limit<1||limit>900)throw Error('configuration_invalid');return limit;
}
export function writeCatchUpOutput(summary,outputPath=process.env.GITHUB_OUTPUT){
 if(outputPath)fs.appendFileSync(outputPath,'needs_catch_up='+(summary?.needsCatchUp===true?'true':'false')+'\nretry_delay_seconds='+(summary?.retryDelaySeconds===600?'600':'0')+'\n');
}
export function safeRunId(env=process.env){
 if(env.GITHUB_RUN_ID!==undefined){const value='github-'+env.GITHUB_RUN_ID+'-'+(env.GITHUB_RUN_ATTEMPT||'1');if(!/^github-[0-9]+-[0-9]+$/.test(value))throw Error('configuration_invalid');return value;}
 return 'local-'+Date.now();
}
export async function main(args=process.argv.slice(2)){
 const config=takeSecrets();
 const maxNavigations=navigationLimit(args);
 const runId=safeRunId();
 const bytes=await downloadBundle(config);
 const result=await executeBundle(bytes,{token:config.token,maxNavigations,runId});
 writeCatchUpOutput(result.summary);
 const output=JSON.stringify(result.summary)+'\n';
 process.stdout.write(output);
 if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'```json\n'+output+'```\n');
 process.exitCode=result.exitCode;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('runner_failed');process.exitCode=1;});
