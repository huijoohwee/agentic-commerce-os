import {open,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {parseArgs} from 'node:util';
import {startListingHost} from './host.mjs';

async function main(){
  const {values}=parseArgs({options:{config:{type:'string'}},strict:true,allowPositionals:false});
  const path=values.config;
  if(!path||!isAbsolute(path)||await realpath(path)!==path)throw Error('configuration_path_invalid');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let config;
  try{
    const stat=await file.stat();
    if(!stat.isFile()||stat.size>16384||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||stat.nlink!==1)
      throw Error('configuration_file_invalid');
    const bytes=await file.readFile(),after=await file.stat();
    if(bytes.length!==stat.size||stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs)throw Error('configuration_changed');
    config=JSON.parse(bytes);
  }finally{await file.close();}
  if(!config||typeof config!=='object'||Array.isArray(config)
    ||Object.keys(config).some(key=>!['directory','sessionSecret','model','port','sourceRevision','assetDirectory','stripeTestKey'].includes(key)))
    throw Error('configuration_fields_invalid');
  const host=await startListingHost(config);
  console.log(JSON.stringify({origin:host.origin,availability:host.availability,sourceRevision:config.sourceRevision??'local-unreleased'}));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void host.close().catch(()=>{process.exitCode=1;});});
}
main().catch(()=>{console.error('Listing host unavailable. Verify its private configuration, installed runtime and pinned local model.');process.exitCode=1;});
