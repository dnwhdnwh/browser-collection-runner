import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cleanEnvironment} from './lib/execute.mjs';
export const smokeSession='runner-preflight';
export function smokeArgs(args){return ['--yes','--package','@playwright/cli@0.1.22','playwright-cli','-s='+smokeSession,'--json',...args];}
export function defaultCommand(args){
 return spawnSync(process.platform==='win32'?'npx.cmd':'npx',smokeArgs(args),{env:cleanEnvironment(),encoding:'utf8',maxBuffer:1024*1024,timeout:args[0]==='close'?10000:25000,windowsHide:true});
}
function diagnostic(operation,result,reason){
 return new Error(['browser_smoke_failed: '+operation,reason,result.error?.message,result.stdout,result.stderr].filter(Boolean).join('\n'));
}
export async function browserSmoke({command=defaultCommand}={}){
 let failure;
 const perform=async args=>{
  const result=await command(args);
  if(result.error||result.status!==0)throw diagnostic(args[0],result,'command failed');
  let parsed;try{parsed=JSON.parse(result.stdout);}catch{throw diagnostic(args[0],result,'invalid command JSON');}
  if(!parsed||parsed.isError||parsed.error)throw diagnostic(args[0],result,'browser command error');
  return {parsed,result};
 };
 try{
  await perform(['open','about:blank','--browser','chrome']);
  const {parsed,result}=await perform(['run-code','async page => await page.evaluate(() => ({url: document.URL}))']);
  let value=parsed.result;
  if(typeof value==='string')try{value=JSON.parse(value);}catch{throw diagnostic('run-code',result,'invalid document result');}
  if(value?.url!=='about:blank')throw diagnostic('run-code',result,'document URL mismatch');
 }catch(error){failure=error;}finally{
  try{await perform(['close']);}catch(error){failure||=error;}
 }
 if(failure)throw failure;
}
export async function main(){
 try{await browserSmoke();console.log('browser_smoke_completed');}catch(error){console.error(error.message);process.exitCode=1;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
