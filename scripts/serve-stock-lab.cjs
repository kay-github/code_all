const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const handler = require('../api/stock');
const root = path.resolve(__dirname,'..');
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8'};
const server = http.createServer(async(req,res) => {
  const url = new URL(req.url,'http://localhost');
  if(url.pathname==='/api/stock'){req.query=Object.fromEntries(url.searchParams);return handler(req,res);}
  let file;
  try { const pathname=decodeURIComponent(url.pathname); if(pathname!=='/'&&!pathname.startsWith('/tools/stock-rebound-lab/'))throw new Error('路径不存在');
    file=path.resolve(root,'.'+pathname+(pathname.endsWith('/')?'index.html':'')); if(!file.startsWith(root+path.sep))throw new Error('无效路径');
    res.setHeader('Content-Type',types[path.extname(file)]||'text/plain; charset=utf-8');res.setHeader('Cache-Control','no-cache');res.end(await fs.readFile(file));
  } catch {res.statusCode=404;res.end('Not found');}
});
server.listen(Number(process.env.PORT)||8765,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+(server.address().port)+'/tools/stock-rebound-lab/'));
