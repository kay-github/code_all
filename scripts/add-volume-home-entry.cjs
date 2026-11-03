// One-time, conditional addition to the existing private homepage config.
// Credentials are loaded from an ignored env file, never printed or embedded.
const fs=require('node:fs/promises');
async function main(){
  const [envFile,backupFile]=process.argv.slice(2);if(!envFile||!backupFile)throw Error('Provide env file and absolute backup path');
  process.loadEnvFile(envFile);
  const store=require('../lib/gridStore'),{validateConfig,CONFIG_KEY}=require('../lib/siteService');
  const entry=require('../assets/site-defaults').items.find(x=>x.id==='volume');
  const row=await store.read(CONFIG_KEY);
  if(!row){console.log('No stored override; built-in defaults provide the new entry.');return;}
  await fs.writeFile(backupFile,JSON.stringify(row.value,null,2),{flag:'wx'});
  if(row.value.items.some(x=>x.id===entry.id||x.url===entry.url)){console.log('Volume entry already present; preserved existing configuration.');return;}
  const config=validateConfig({...row.value,items:[...row.value.items,entry]});
  const next={...config,version:row.value.version+1,updatedAt:new Date().toISOString()};
  await store.write(CONFIG_KEY,next,row.etag);
  const checked=await store.read(CONFIG_KEY);
  if(!checked.value.items.some(x=>x.id===entry.id))throw Error('Entry verification failed');
  console.log(JSON.stringify({added:'volume',previousItems:row.value.items.length,currentItems:checked.value.items.length,version:checked.value.version}));
}
main().catch(error=>{console.error(error.code==='conflict'?'Homepage changed concurrently; reread before retrying.':error.name+': configuration update failed');process.exitCode=1;});
