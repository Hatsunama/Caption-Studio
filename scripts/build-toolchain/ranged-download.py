"""Bounded HTTPS transport only. Node verifies complete pinned hashes and GPG afterwards."""
import argparse, concurrent.futures, json, os, time, urllib.error, urllib.parse, urllib.request
CHUNK=8*1024*1024
class SecureRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self, req, fp, code, msg, headers, newurl):
  if urllib.parse.urlparse(newurl).scheme!='https': raise ValueError('Non-HTTPS redirect rejected')
  return super().redirect_request(req,fp,code,msg,headers,newurl)
def validate_response(status,headers,start,end,total):
 if headers.get('Content-Encoding','identity').lower()!='identity': raise ValueError('Encoded range rejected')
 if status==206:
  if headers.get('Content-Range')!=f'bytes {start}-{end}/{total}':raise ValueError('Range identity mismatch')
 elif not(status==200 and start==0 and end==total-1):raise ValueError('Server did not honor bounded range')
def download(url,destination,total):
 if urllib.parse.urlparse(url).scheme!='https' or total<1:raise ValueError('Invalid transport input')
 deadline=time.monotonic()+480
 def fetch(start):
  end=min(total-1,start+CHUNK-1)
  for attempt in range(3):
   try:
    if time.monotonic()>deadline:raise TimeoutError('Transport deadline')
    request=urllib.request.Request(url,headers={'User-Agent':'Caption-Studio-build-verification','Accept':'application/octet-stream','Accept-Encoding':'identity','Cache-Control':'no-cache','Range':f'bytes={start}-{end}'})
    with urllib.request.build_opener(SecureRedirect()).open(request,timeout=45) as response:
     validate_response(response.status,response.headers,start,end,total)
     data=response.read(end-start+2)
     if len(data)!=end-start+1:raise ValueError('Truncated or oversized range')
     return data
   except (TimeoutError,urllib.error.URLError) as error:
    if isinstance(error,urllib.error.HTTPError) and error.code not in [408,429,500,502,503,504]:raise
    if attempt==2:raise
    time.sleep(attempt+1)
 # At most two 8MiB responses retained, ordered writes, no unbounded future queue.
 with open(destination,'xb') as out, concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  positions=iter(range(0,total,CHUNK));pending=[]
  for _ in range(2):
   start=next(positions,None)
   if start is not None:pending.append((start,pool.submit(fetch,start)))
  written=0;ranges=0
  while pending:
   start,future=pending.pop(0);data=future.result();out.write(data);out.flush();written+=len(data);ranges+=1
   if ranges%8==0 or written==total:print(json.dumps({'transportBytes':written,'totalBytes':total,'ranges':ranges}),flush=True)
   del data, future
   start=next(positions,None)
   if start is not None:pending.append((start,pool.submit(fetch,start)))
  if written!=total:raise ValueError('Incomplete archive')
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('url');p.add_argument('destination');p.add_argument('bytes',type=int);a=p.parse_args()
 try:download(a.url,a.destination,a.bytes)
 except Exception as e:print('Transport failed: '+type(e).__name__);raise SystemExit(1)