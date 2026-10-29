import {pathToFileURL} from 'node:url';
process.once('message',async message=>{
 try{
  const bundle=await import(pathToFileURL(message.bundlePath).href);
  if(typeof bundle.execute!=='function')throw Error('execution_failed');
  if(message.collectionScope!=='default'&&(!Array.isArray(bundle.collectionScopes)||!bundle.collectionScopes.includes(message.collectionScope)))throw Error('execution_failed');
  const value=await bundle.execute({token:message.token,maxNavigations:message.maxNavigations,collectionScope:message.collectionScope,runId:message.runId});
  process.send({type:'result',ok:true,value},()=>process.exit(0));
 }catch{
  process.send({type:'result',ok:false},()=>process.exit(1));
 }
});
