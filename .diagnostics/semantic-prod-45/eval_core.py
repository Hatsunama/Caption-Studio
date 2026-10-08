"""Review-gated 48-case harness core. No model IO on import or preflight."""
import copy,ctypes,dataclasses,hashlib,inspect,json,os,re,subprocess,sys,time
from importlib.metadata import version
from pathlib import Path
from jsonschema import Draft7Validator
ROOT=Path(__file__).resolve().parent
SCHEMA=json.loads((ROOT/'GENERIC_SCHEMA.json').read_text())
SDK='0.17.1'
PLAIN_WORDING='Return only the translated sentence, not context, JSON, markdown, HTML or explanations.'
MODELS={
 'Q':{'repo':'litert-community/Qwen2.5-1.5B-Instruct','revision':'19edb84c69a0212f29a6ef17ba0d6f278b6a1614','file':'Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.litertlm','bytes':1597931520,'sha256':'faa60663b333290c1496c499828b21d3e3254a788cacd8cce917ce0f761a2dc9'},
 'H':{'repo':'Hatsunama/caption-studio-natural-v2-qlora','revision':'16c4210537ed0ee4421fc165a12a7332006bbf25','file':'quality-round/20261004/candidate-cache4096/model.litertlm','bytes':1815668080,'sha256':'853685c01074b8fb94024e81d1fdb487239cecbefaf5b02053c03376bd5db221'}}
def sha(b):return hashlib.sha256(b).hexdigest()
def encoded(v):return json.dumps(v,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def save(path,value):
 path=Path(path);tmp=path.with_name(path.name+'.partial')
 with tmp.open('wb') as f:f.write(json.dumps(value,ensure_ascii=False,indent=2).encode());f.flush();os.fsync(f.fileno())
 os.replace(tmp,path)
def load(path):return json.loads(Path(path).read_text())
def budget(captions,retry=False):
 n=64+sum(len(c['text'].encode('utf-8'))*3+24 for c in captions)
 if retry:n+=max(32,n//4)
 return min(1024,max(128,n))
def escaped_json(v,compact=True):
 kwargs={'ensure_ascii':False}
 if compact:kwargs['separators']=(',',':')
 return json.dumps(v,**kwargs).replace('\u2028','\\u2028').replace('\u2029','\\u2029').replace('<','\\u003c').replace('>','\\u003e')
def escaped_cost(ch):
 if ord(ch)<32 or ch in '<>':return 6
 if ch in '"\\':return 2
 return len(ch.encode('utf-8'))
def bounded_context(text,tail):
 selected=text[-128:] if tail else text[:128];result=[];cost=0
 for ch in reversed(selected) if tail else selected:
  cost+=escaped_cost(ch)
  if cost>192:break
  result.append(ch)
 return ''.join(reversed(result) if tail else result)
def baseline_message(case):
 q=case['request'];payload={k:copy.deepcopy(q[k]) for k in ('task','promptContract','sourceLanguage','targetLanguage','contextBefore','contextAfter','captions')}
 payload['sourceNeighbors']={k:bounded_context(q['sourceNeighbors'][k],k=='before') for k in ('before','after')}
 return escaped_json(payload)
def profile_message(case):
 from hy_prompt_profiles import quoted_context_task
 q=copy.deepcopy(case['request']);captions=q['captions'];neighbors=q['sourceNeighbors']
 for k in ('before','after'):
  if bounded_context(neighbors[k],k=='before')!=neighbors[k]:raise ValueError('profile cannot honor complete neighbor context')
 single=copy.deepcopy(q);single['captions']=captions[:1]
 source=q['sourceLanguage'].rsplit(' (',1)[0];target=q['targetLanguage'].rsplit(' (',1)[0]
 legacy=quoted_context_task({'request':single},source,target)['messages'][0]['content']
 ids=[c['id'] for c in captions]
 wording=('Return only a JSON array with exactly '+str(len(ids))+' object'+('' if len(ids)==1 else 's')+
  ', each containing exactly string fields id and text. Copy these requested IDs in exactly this order: '+
  escaped_json(ids)+'. Put only the translation of the matching requested source cue in text; do not output context, markdown, HTML or explanations.')
 if legacy.count(PLAIN_WORDING)!=1:raise ValueError('pinned profile instruction changed')
 message=legacy.replace(PLAIN_WORDING,wording)
 if any(neighbors.values()):
  split='\nTranslate the following source text from '
  if message.count(split)!=1:raise ValueError('profile instruction separator')
  message=message.replace(split,'\n[Read-only Source Neighbors Before]\n'+escaped_json(neighbors['before'],False)+'\n[Read-only Source Neighbors After]\n'+escaped_json(neighbors['after'],False)+split,1)
 if len(captions)>1:
  message=message.replace('Translate the following source text from ','Translate the following source cues from ',1)
  message=message.replace('Translate only the final Source Text block.','Translate only the final Requested Source Cues block.',1)
  marker='\n[Source Text]\n';head,sep,old=message.rpartition(marker)
  if not sep or json.loads(old)!=captions[0]['text']:raise ValueError('profile source boundary')
  message=head+'\n[Requested Source Cues]\n'+escaped_json(captions,False)
 return {'role':'user','content':message}
def for_ids(ids):
 if not ids or len(set(ids))!=len(ids) or any(not re.fullmatch(r'[A-Za-z0-9._:-]{1,64}',x) for x in ids):raise ValueError('invalid IDs')
 item=copy.deepcopy(SCHEMA['items']);item['properties']['id']['enum']=list(ids)
 return {'type':'array','minItems':len(ids),'maxItems':len(ids),'items':item}
TARGET_LABELS=load(ROOT/'TARGET_WHITELIST.json')
def validate_target(case):
 q=case['request'];tag=next((k for k,v in TARGET_LABELS.items() if q['targetLanguage']==v),None)
 if tag is None or tag=='en' or q['sourceLanguage']!=TARGET_LABELS['en'] or case.get('target_tag',tag)!=tag:
  raise ValueError('unsupported evaluation source/target pair')
 return tag
def make_trial(case,condition,system):
 if condition not in ('QJ','HJ'):raise ValueError('no alternate provider/profile')
 q=case['request'];validate_target(case);ids=[c['id'] for c in q['captions']]
 if not ids or len(set(ids))!=len(ids) or any(not re.fullmatch(r'[A-Za-z0-9._:-]{1,64}',i) for i in ids):raise ValueError('IDs')
 st=copy.deepcopy(case['generation_settings'])
 if st['schema']!=for_ids(ids) or st['max_output_tokens']!=budget(q['captions']):raise ValueError('schema/budget mismatch')
 return {'trial_id':condition+'_'+case['case_id'],'case_id':case['case_id'],'condition':condition,'model_key':'Q' if condition=='QJ' else 'H','request':copy.deepcopy(q),'settings':st,'system_message':system if condition=='QJ' else None,'message':baseline_message(case) if condition=='QJ' else profile_message(case),'profile':'app-pinned-user-json' if condition=='QJ' else 'quoted_context_v8_json_batch_v1_review_required'}
def conversation_kwargs(t):
 from litert_lm.interfaces import SamplerConfig,ThinkingConfig,ConstrainedDecodingConfig,LiteRtLmConstraintProviderType
 st=t['settings']
 return {'system_message':t['system_message'],'sampler_config':SamplerConfig(**st['sampler']),'thinking_config':ThinkingConfig(**st['thinking']),'automatic_tool_calling':False,'constrained_decoding_config':ConstrainedDecodingConfig(enable=True,provider=LiteRtLmConstraintProviderType.LL_GUIDANCE),'max_output_tokens':st['max_output_tokens']}
def send_kwargs(t):
 from litert_lm.interfaces import ResponseFormat
 return {'response_format':ResponseFormat.json(t['settings']['schema'])}
def no_duplicate_keys(pairs):
 out={}
 for k,v in pairs:
  if k in out:raise ValueError('duplicate JSON field '+k)
  out[k]=v
 return out
def review(t,response):
 result={'schema_valid':False,'requested_ids_valid':False,'envelope_valid':False,'flags':[],'raw_text':None,'parsed':None,'semantic_quality_certified':False}
 if not isinstance(response,dict) or set(response)!= {'role','content'} or response['role']!='assistant':result['flags'].append('SDK envelope role/fields')
 parts=response.get('content') if isinstance(response,dict) else None
 if not isinstance(parts,list) or not parts or any(not isinstance(p,dict) or set(p)!= {'type','text'} or p.get('type')!='text' or not isinstance(p.get('text'),str) for p in parts):
  result['flags'].append('SDK content');return result
 result['envelope_valid']=not result['flags'];text=''.join(p['text'] for p in parts);result['raw_text']=text
 try:
  parsed=json.loads(text,object_pairs_hook=no_duplicate_keys);result['parsed']=parsed
  errors=list(Draft7Validator(t['settings']['schema']).iter_errors(parsed));result['schema_valid']=not errors
  result['flags']+=['schema:'+e.message for e in errors]
  if result['schema_valid']:
   ids=[c['id'] for c in t['request']['captions']]
   result['requested_ids_valid']=[c['id'] for c in parsed]==ids
   if not result['requested_ids_valid']:result['flags'].append('requested ID count/order')
   if any(not c['text'].strip() for c in parsed):result['flags'].append('blank translation')
 except (ValueError,TypeError) as e:result['flags'].append(type(e).__name__+':'+str(e))
 return result
def closed(obj,kind):
 attr='_engine_ptr' if kind=='engine' else '_ptr'
 if not hasattr(obj,attr):raise RuntimeError('missing SDK pointer contract')
 was=bool(getattr(obj,attr));start=time.monotonic();obj.close()
 if getattr(obj,attr) is not None:raise RuntimeError('uncleared SDK pointer')
 return {'close_returned':True,'pointer_was_live':was,'pointer_cleared':True,'seconds':time.monotonic()-start}
def capture_and_close(c,t,folder):
 folder=Path(folder);began=time.monotonic()
 try:
  response=c.send_message(t['message'],**send_kwargs(t))
  raw={'trial':t,'raw_sdk_response':response,'code_revision':os.environ.get('RUN_CODE_REVISION'),'sdk':SDK,'trial_sha256':sha(encoded(t)),'envelope_sha256':sha(encoded(response)),'generation_seconds':time.monotonic()-began}
  path=folder/(t['trial_id']+'.raw.json');save(path,raw)
  print('RAW_SDK_ENVELOPE '+json.dumps(raw,ensure_ascii=False),flush=True)
  row={'trial_id':t['trial_id'],'raw_sha256':sha(path.read_bytes()),'generation_seconds':raw['generation_seconds'],'cap':t['settings']['max_output_tokens'],'finish_reason':'unknown'}
  row.update(review(t,response))
  try:
   row['benchmark']=dataclasses.asdict(c.get_benchmark_info());row['decode_tokens']=row['benchmark']['last_decode_token_count'];row['cap_hit']=row['decode_tokens']>=row['cap']
  except Exception as e:row['benchmark_unavailable']=type(e).__name__
  save(folder/(t['trial_id']+'.stats.json'),row);return row
 finally:save(folder/(t['trial_id']+'.close.json'),closed(c,'conversation'))
def check_linkage(stdout,stderr,returncode,vulkan_loaded,sdk_loaded):
 diagnostics={'stdout':stdout,'stderr':stderr,'returncode':returncode,'vulkan_loaded':bool(vulkan_loaded),'sdk_loaded':bool(sdk_loaded),'direct_vulkan_entry':'libvulkan.so.1' in stdout}
 if not vulkan_loaded or not sdk_loaded:raise RuntimeError('native loader failure')
 if returncode:raise RuntimeError('ldd failure')
 if 'not found' in (stdout+'\n'+stderr).lower():raise RuntimeError('unresolved dependency')
 return diagnostics
def native_preflight(trials):
 from litert_lm.engine import Engine
 from litert_lm.conversation import Conversation
 from litert_lm.interfaces import Backend
 from litert_lm._ffi import _get_lib
 if version('litert-lm-api')!=SDK:raise RuntimeError('SDK version')
 vulkan=ctypes.CDLL('libvulkan.so.1');lib=_get_lib();path=Path(lib._name).resolve()
 symbols=['litert_lm_engine_create','litert_lm_engine_delete','litert_lm_conversation_create','litert_lm_conversation_delete','litert_lm_conversation_send_message','litert_lm_conversation_get_benchmark_info']
 if not all(hasattr(lib,k) for k in symbols):raise RuntimeError('missing native symbols')
 p=subprocess.run(['ldd',str(path)],capture_output=True,text=True,timeout=15)
 print('ACTUAL_LDD '+json.dumps({'stdout':p.stdout,'stderr':p.stderr,'returncode':p.returncode}),flush=True)
 linkage=check_linkage(p.stdout,p.stderr,p.returncode,vulkan._handle,lib._handle)
 inspect.signature(Engine).bind('/tmp/never-downloaded.litertlm',backend=Backend.CPU(thread_count=4),max_num_tokens=4096,cache_dir='/tmp/never-created',enable_benchmark=True)
 for t in trials:
  inspect.signature(Engine.create_conversation).bind(None,**conversation_kwargs(t))
  inspect.signature(Conversation.send_message).bind(None,t['message'],**send_kwargs(t))
 maps={line.split()[-1] for line in Path('/proc/self/maps').read_text().splitlines() if 'libvulkan.so' in line and line.split()[-1].startswith('/')}
 if not maps:raise RuntimeError('Vulkan absent from loaded mappings')
 return {'sdk':SDK,'ldd':linkage,'symbols':symbols,'native_library_sha256':{str(p):sha(p.read_bytes()) for p in [path]+[Path(x) for x in sorted(maps)]},'engine_signature':str(inspect.signature(Engine)),'conversation_signature':str(inspect.signature(Engine.create_conversation)),'send_signature':str(inspect.signature(Conversation.send_message)),'cpu_signature':str(inspect.signature(Backend.CPU)),'engine_close_source':inspect.getsource(Engine.close),'conversation_close_source':inspect.getsource(Conversation.close),'model_downloads':0,'engines_created':0,'inference_calls':0}
def model_spec(key,spec=None):
 if key not in MODELS or spec is not None and spec!=MODELS[key]:raise ValueError('model switch forbidden')
 return copy.deepcopy(MODELS[key])
def require_approval(case_hash):
 if os.environ.get('APPROVED_EXECUTION_PLAN_SHA256')!=sha((ROOT/'EXECUTION_PLAN.json').read_bytes()) or os.environ.get('RUN_MODE')!='inference' or os.environ.get('PARENT_REVIEW_APPROVED')!='yes' or os.environ.get('ALLOW_MODEL_DOWNLOADS')!='yes' or os.environ.get('APPROVED_CODE_REVISION')!=os.environ.get('RUN_CODE_REVISION') or not os.environ.get('RUN_CODE_REVISION') or os.environ.get('APPROVED_CASES_SHA256')!=case_hash:
  raise RuntimeError('parent review and exact code/case approval required before model IO')
