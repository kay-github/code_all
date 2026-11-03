const {cachedVolume}=require('../lib/volumeService');
const {rateLimit}=require('../lib/stockMarket');
module.exports=async function handler(req,res){
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='GET'){res.statusCode=405;res.setHeader('Allow','GET');return res.end(JSON.stringify({error:'仅支持 GET 读取'}));}
  if(!rateLimit(String(req.headers?.['x-forwarded-for']||req.socket?.remoteAddress||'').split(',')[0])){res.statusCode=429;res.setHeader('Retry-After','60');return res.end(JSON.stringify({error:'请求过于频繁，请稍后重试'}));}
  const q=req.query||Object.fromEntries(new URL(req.url,'http://localhost').searchParams);
  try{
    const result=await cachedVolume(q.action||'detail',{symbol:q.symbol,q:q.q,force:q.force==='1'});
    res.setHeader('Cache-Control',result.stale||q.force==='1'?'no-store':`public, s-maxage=${q.action==='history'?60:q.action==='search'||q.action==='catalog'?3600:20}`);
    res.statusCode=200;res.end(JSON.stringify(result));
  }catch(e){res.statusCode=e.status||502;res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({error:e.status?e.message:'量能数据暂不可用，请稍后重试'}));}
};
module.exports.config={maxDuration:30};
