const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const handler=require('../api/volume'),root=path.resolve(__dirname,'..');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8'};
http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/volume'){req.query=Object.fromEntries(url.searchParams);return handler(req,res);}
  try{
    const p=decodeURIComponent(url.pathname);if(p!=='/'&&!p.startsWith('/tools/volume-lab/'))throw Error();
    const file=path.resolve(root,'.'+p+(p.endsWith('/')?'index.html':''));if(!file.startsWith(root+path.sep))throw Error();
    res.setHeader('Content-Type',types[path.extname(file)]||'text/plain; charset=utf-8');res.setHeader('Cache-Control','no-cache');res.end(await fs.readFile(file));
  }catch{res.statusCode=404;res.end('Not found');}
}).listen(Number(process.env.PORT)||8766,'127.0.0.1',function(){console.log('Local: http://127.0.0.1:'+this.address().port+'/tools/volume-lab/');});
