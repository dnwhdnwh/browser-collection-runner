import {createHash,timingSafeEqual} from 'node:crypto';
export const MAX_BUNDLE_BYTES=256*1024;
const secretKeys=['COLLECTOR_BOOTSTRAP_URL','COLLECTOR_TOKEN','COLLECTOR_BUNDLE_SHA256'];
export function takeSecrets(env=process.env){
 const [endpoint,token,sha256]=secretKeys.map(key=>env[key]);
 for(const key of secretKeys)delete env[key];
 return validateSecrets({endpoint,token,sha256});
}
export function validateSecrets({endpoint,token,sha256}){
 let url;try{url=new URL(endpoint);}catch{throw Error('configuration_invalid');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||typeof token!=='string'||token.length<32||/[\r\n]/.test(token)||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))throw Error('configuration_invalid');
 return {endpoint:url.href,token,sha256};
}
export async function downloadBundle(config,{fetcher=fetch}={}){
 const {endpoint,token,sha256}=validateSecrets(config);
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
 try{
  const response=await fetcher(endpoint,{method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/javascript'},redirect:'error',signal:controller.signal});
  if(!response.ok||response.redirected||response.url!==endpoint)throw Error('download_failed');
  const mime=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if(mime!=='application/javascript')throw Error('download_failed');
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BUNDLE_BYTES))throw Error('download_failed');
  if(!response.body)throw Error('download_failed');
  const reader=response.body.getReader(),chunks=[];let total=0;
  try{
   while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_BUNDLE_BYTES){await reader.cancel();throw Error('download_failed');}chunks.push(Buffer.from(value));}
  }finally{reader.releaseLock();}
  if(total===0)throw Error('download_failed');
  const bytes=Buffer.concat(chunks,total),actual=createHash('sha256').update(bytes).digest(),expected=Buffer.from(sha256,'hex');
  if(!timingSafeEqual(actual,expected))throw Error('download_failed');
  return bytes;
 }catch{throw Error('download_failed');}finally{clearTimeout(timer);}
}
