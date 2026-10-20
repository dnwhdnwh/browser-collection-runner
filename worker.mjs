import {pathToFileURL} from 'node:url';
process.once('message',async message=>{
 try{
  const bundle=await import(pathToFileURL(message.bundlePath).href);
  if(typeof bundle.execute!=='function')throw Error('execution_failed');
  const value=await bundle.execute({token:message.token,maxNavigations:message.maxNavigations,runId:message.runId});
  process.send({type:'result',ok:true,value},()=>process.exit(0));
 }catch{
  process.send({type:'result',ok:false},()=>process.exit(1));
 }
});
