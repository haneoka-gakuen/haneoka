"""Manual current TGW typed projection using existing compiler and delta publisher."""
from __future__ import annotations
import argparse,copy,hashlib,json,os,re,subprocess,sys,tempfile
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo
from urllib.request import Request,urlopen
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from build.catalog_storage import _compile_resource
from core.config import load_server_config
from core.manifests import write_json,stable_json
from core.storage import cas_key,fnv1a32_shard
from publish.band_descriptions import publish
from publish.r2 import R2Store,IMMUTABLE_CACHE,_validate_release_manifest_for_gc
from verify.release import release_entries,write_release_identity_files
from extract.master import _decode_master_table
from py3rijndael import RijndaelCbc,Pkcs7Padding

def digest(raw):return hashlib.sha256(raw).hexdigest()

class BoundedReadStore(R2Store):
 """Prepare exposes bounded R2 reads and rejects every remote write."""
 def __init__(self,config):
  super().__init__(config,concurrency=4);self.total=0;self.reads=[]
 def read(self,key,cap):
  head=self.head(key)
  if not head or not 0<head.get('ContentLength',0)<=cap:raise ValueError('selected R2 metadata exceeds cap or is absent')
  raw=self.get_bytes(key)
  if raw is None or len(raw)!=head['ContentLength'] or len(raw)>cap:raise ValueError('selected R2 body differs from bounded metadata')
  self.total+=len(raw)
  if self.total>96*1024*1024:raise ValueError('selected read budget exceeded')
  self.reads.append({'key':key,'bytes':len(raw),'sha256':digest(raw)})
  return raw,head.get('ETag')
 def put_json(self,*args,**kwargs):raise ValueError('prepare cannot write R2')
 def upload_path(self,*args,**kwargs):raise ValueError('prepare cannot write R2')
 def upload_cas(self,*args,**kwargs):raise ValueError('prepare cannot write R2')

LOCALE_FIELDS = ('_japanese', '_english', '_traditionalChinese', '_simplifiedChinese', '_korean')
def _localized(row: dict[str, Any] | None, fallback: str='') -> list[str]:
    row = row or {}
    identifier = str(row.get('_id') or '')
    values = [str(row.get(field) or '') for field in LOCALE_FIELDS]
    for index, value in enumerate(values):
        if index == 0:
            continue
        is_music_placeholder = identifier.startswith(('Music_Tilte_', 'Music_Ruby_Tilte_', 'Music_Phonetic_Tilte_')) and re.fullmatch('Music_Tilte_\\d+', value)
        if value and (value == identifier or is_music_placeholder):
            values[index] = ''
    return values if any(values) else [str(fallback), '', '', '', '']

def prepare(store,config,expected,staging):
 server=config.id
 if expected.get("server")!=server:raise ValueError("expected server differs")
 pointer_key=f'servers/{server}/current.json';raw,etag=store.read(pointer_key,4096);pointer=json.loads(raw)
 if not isinstance(etag,str) or etag.startswith('W/') or any(pointer.get(k)!=expected[k] for k in ['server','releaseId','sourceId']):raise ValueError('fresh current identity/ETag differs from explicit expected input')
 if len(raw)!=expected['pointerRawBytes'] or digest(raw)!=expected['pointerRawSHA256']:raise ValueError('S3 raw pointer differs from reviewed API bytes')
 base_key=f'servers/{server}/releases/{pointer["releaseId"]}/release.json'
 if pointer['releaseManifest']!=base_key:raise ValueError('parent manifest key differs')
 base=json.loads(store.read(base_key,64*1024*1024)[0]);records=_validate_release_manifest_for_gc(base,base_key,server,pointer['releaseId'])
 if base['sourceId']!=pointer['sourceId']:raise ValueError('parent source differs')
 entries={e['path']:e for e in records}
 def selected(path,cap=2*1024*1024):
  e=entries[path]
  if not 0<e['bytes']<=cap:raise ValueError('selected descriptor exceeds budget: '+path)
  raw=store.read(cas_key(e['sha256']),cap)[0]
  if len(raw)!=e['bytes'] or digest(raw)!=e['sha256']:raise ValueError('selected CAS bytes differ: '+path)
  return raw
 catalog=json.loads(selected('api/v1/catalog/manifest.json'));desc=catalog['resources']['tgw-card']
 if catalog['server']!=server or catalog['sourceId']!=pointer['sourceId']:raise ValueError('catalog identity differs')
 if desc['index']!='api/v1/catalog/tgw-card/index.json' or desc['entities']['prefix']!='api/v1/catalog/tgw-card/entities/' or desc['entities']['algorithm']!='fnv1a32-mod-256':raise ValueError('unsupported TGW descriptor')
 index=json.loads(selected(desc['index']));ids=set(index['entries']);entities={};before_partitions={}
 for shard in desc['entities']['shards']:
  path=desc['entities']['prefix']+shard+'.json';part=json.loads(selected(path));before_partitions[path]=part
  for key,value in part.items():
   if key in entities or fnv1a32_shard(key)!=shard:raise ValueError('TGW entity partition identity differs')
   entities[key]=value
 if ids!=set(entities) or desc['count']!=len(ids) or len(ids)!=21:raise ValueError('fresh rank coverage differs from reviewed 21-rank scope')
 crypto=config.master_crypto;salt,iv=bytes.fromhex(crypto['salt']),bytes.fromhex(crypto['iv']);cipher=RijndaelCbc(bytes.fromhex(crypto['key']),iv,Pkcs7Padding(32),block_size=32)
 tables={}
 for name,cap in [('MasterVipRankBonus',2*1024*1024),('MasterText',16*1024*1024)]:
  body=selected(f'game-client/master/{name}.bin',cap);tables[name]=_decode_master_table(body,name,salt,iv,cipher)['_allData']
 texts={str(r.get('_id')):r for r in tables['MasterText']};native={k:[] for k in ids}
 for row in tables['MasterVipRankBonus']:
  rank=str(int(row.get('_vipRank') or 0))
  if rank not in native:raise ValueError('native bonus row outside reviewed rank coverage')
  native[rank].append(row)
 updated=copy.deepcopy(entities);mapping=[]
 for key in sorted(ids,key=int):
  old=entities[key];new=updated[key];rows=native[key]
  if str(old['id'])!=key or old['rank']!=int(key) or len(old['benefits'])!=len(rows):raise ValueError('rank/native benefit count mismatch')
  mapped=[]
  for ordinal,(benefit,row) in enumerate(zip(old['benefits'],rows,strict=True)):
   kind=int(row.get('_vipBonusType') or 0);value=int(row.get('_value') or 0);name=_localized(texts.get(f'ui_vip_bonus_type_{kind}'))
   if benefit.get('value')!=value or benefit.get('name')!=name:raise ValueError('original native value/name/order mismatch')
   if 'vipBonusType' in benefit and benefit['vipBonusType']!=kind:raise ValueError('existing native kind conflicts')
   new['benefits'][ordinal]['vipBonusType']=kind
   mapped.append({'ordinal':ordinal,'nativeKind':kind,'nativeValue':value,'nameSHA256':digest(stable_json(name).encode()),'valueMatch':True,'nameMatch':True,'orderMatch':True})
  stripped=copy.deepcopy(new)
  for j,v in enumerate(stripped['benefits']):
   if 'vipBonusType' not in old['benefits'][j]:v.pop('vipBonusType')
  if stripped!=old:raise ValueError('non-kind entity field changed')
  mapping.append({'rankId':key,'benefitCount':len(rows),'nativeMatches':mapped,'allOtherFieldsEqual':True})
 document=copy.deepcopy(index);document['entries']=updated
 compiled,count=_compile_resource('tgw-card',document,staging/'api/v1/catalog')
 if compiled!=desc or count!=21 or json.loads((staging/desc['index']).read_text())!=index:raise ValueError('compact index/descriptor changed')
 allowed=set();changed=[]
 for path,before in before_partitions.items():
  after=json.loads((staging/path).read_text())
  if after!=before:allowed.add(path)
 # Preserve unchanged payload bytes exactly, including differently formatted prior serialization.
 for path in list(staging.rglob('*.json')):
  if path.relative_to(staging).as_posix() not in allowed:path.unlink()
 legacy='api/tgw-card.json'
 if legacy in entries:
  archived=json.loads(selected(legacy));original=copy.deepcopy(archived)
  if archived!=dict(index,entries=entities):raise ValueError('legacy TGW differs from current full document')
  archived['entries']=copy.deepcopy(updated)
  if archived!=original:write_json(staging/legacy,archived);allowed.add(legacy)
 changed=release_entries(staging)
 if {r['path'] for r in changed}!=allowed:raise ValueError('changed payload escaped exact allowlist')
 reused=[r for r in records if r['path'] not in allowed];composed=sorted(reused+changed,key=lambda r:r['path'])
 if {r['path']:r for r in composed if r['path'] not in allowed}!={r['path']:r for r in reused}:raise ValueError('unselected descriptor changed')
 manifest=write_release_identity_files(staging,server,pointer['sourceId'],composed)
 # A fresh read at the end, outside the cached read store, detects parent drift.
 end,etag_end=store.read(pointer_key,4096)
 if json.loads(end)!=pointer or etag_end!=etag:raise ValueError('current changed while preparing')
 prepared={'pointer':pointer,'pointerETag':etag,'manifest':manifest,'changedEntries':changed,'sourceId':pointer['sourceId'],'reusedEntryCount':len(reused),'noOp':not changed,'pointerRawSHA256':digest(raw),'pointerRawBytes':len(raw),'entities':updated,'index':index}
 receipt={'schema':'t29-current-tgw-prepared-v1','atTaipei':datetime.now(ZoneInfo('Asia/Taipei')).isoformat(),'producerPin':os.environ['PRODUCER_PIN'],'server':server,'baseReleaseId':pointer['releaseId'],'sourceId':pointer['sourceId'],'newReleaseId':manifest['releaseId'],'pointerETag':etag,'originalMasterEntries':{n:entries[f'game-client/master/{n}.bin'] for n in tables},'rankCount':21,'benefitCount':sum(x['benefitCount'] for x in mapping),'rankMapping':mapping,'changedEntries':changed,'changedPathCount':len(changed),'changedBytes':sum(x['bytes'] for x in changed),'reusedEntryCount':len(reused),'allUnselectedDescriptorsEqual':True,'compactIndexDescriptorExactReuse':True,'pointerUnchangedThroughPreparation':True,'readBytes':store.total,'reads':store.reads,'remoteWrites':0,'noOp':not changed,'pointerRawSHA256':prepared['pointerRawSHA256'],'pointerRawBytes':prepared['pointerRawBytes']}
 receipt['operatorSHA256']=digest(Path(__file__).read_bytes())
 receipt['S3PointerETag']=etag
 receipt['apiPointerETag']=expected.get('apiPointerETag')
 receipt['existingS3CredentialsAvailable']=True
 receipt['sameAPIAndS3RawPointerBytes']=True
 receipt['candidateGuardSHA256']=digest(stable_json({k:receipt[k] for k in ['producerPin','operatorSHA256','server','baseReleaseId','sourceId','newReleaseId','S3PointerETag','pointerRawSHA256','pointerRawBytes','changedEntries']}).encode())
 return prepared,receipt

class CreateOnlyCASClient:
 """Keep the existing R2 upload implementation; add a CAS create precondition."""
 def __init__(self,client):self._client=client
 def __getattr__(self,name):return getattr(self._client,name)
 def put_object(self,**kwargs):
  if kwargs.get('Key','').startswith('cas/v1/sha256/'):
   kwargs['IfNoneMatch']='*'
  return self._client.put_object(**kwargs)

class FrozenWriter(R2Store):
 def __init__(self,*args,**kwargs):
  super().__init__(*args,**kwargs)
  self.client=CreateOnlyCASClient(self.client)
 def upload_cas(self,file,sha,media):
  if digest(file.read_bytes())!=sha:raise ValueError('frozen payload digest differs')
  key=cas_key(sha)
  if self.head(key) is not None:
   raw=self.get_bytes(key)
   if raw is None or len(raw)!=file.stat().st_size or digest(raw)!=sha:raise ValueError('immutable CAS collision')
   return
  try:super().upload_cas(file,sha,media)
  except Exception as error:
   response=getattr(error,'response',{})
   if response.get('ResponseMetadata',{}).get('HTTPStatusCode')!=412:raise
   raw=self.get_bytes(key)
   if raw is None or len(raw)!=file.stat().st_size or digest(raw)!=sha:raise ValueError('concurrent immutable CAS collision') from None
 def put_json(self,key,value,cache_control,*,expected_etag=None,if_absent=False):
  if cache_control==IMMUTABLE_CACHE:
   if self.head(key) is not None:
    if self.get_json(key)!=value:raise ValueError('immutable release metadata collision')
    return
   if_absent=True
  elif not key.endswith('/current.json') or expected_etag is None:raise ValueError('undeclared mutable write')
  return super().put_json(key,value,cache_control,expected_etag=expected_etag,if_absent=if_absent)

def s3_pointer_guard(store,server,prepared):
 key=f'servers/{server}/current.json'
 head=store.head(key)
 if not head or not 0<head.get('ContentLength',0)<=4096:raise ValueError('S3 current metadata unavailable or exceeds cap')
 etag=head.get('ETag')
 if not isinstance(etag,str) or not etag or etag.startswith('W/'):raise ValueError('S3 pointer strong ETag unavailable')
 raw=store.get_bytes(key)
 if raw is None or len(raw)!=prepared['pointerRawBytes'] or digest(raw)!=prepared['pointerRawSHA256'] or json.loads(raw)!=prepared['pointer']:raise ValueError('S3 raw current differs from API frozen input; reprepare required')
 after=store.head(key)
 if not after or after.get('ETag')!=etag or after.get('ContentLength')!=len(raw):raise ValueError('S3 current changed while binding transport')
 return {'server':server,'baseReleaseId':prepared['pointer']['releaseId'],'sourceId':prepared['sourceId'],'pointerRawSHA256':digest(raw),'pointerRawBytes':len(raw),'preparePointerETag':prepared['pointerETag'],'S3PointerETag':etag,'sameRawBytesAndFullPointer':True,'S3DoubleHEADStable':True,'ETagStrippedOrSynthesized':False,'remoteWrites':0}

def publish_reviewed(config,prepared,receipt,approval,staging,output):
 if approval.get('schema')!='haneoka-current-tgw-approval-v1':raise ValueError('reviewed approval schema missing')
 fields={'producerPin':'producerPin','operatorSHA256':'operatorSHA256','server':'server','baseReleaseId':'baseReleaseId','sourceId':'sourceId','candidateReleaseId':'newReleaseId','S3PointerETag':'S3PointerETag','pointerRawSHA256':'pointerRawSHA256','candidateGuardSHA256':'candidateGuardSHA256'}
 if any(approval.get(k)!=receipt[v] for k,v in fields.items()):raise ValueError('Root-reviewed candidate/identity/strong-ETag freeze differs')
 store=FrozenWriter(config,concurrency=4)
 actual=s3_pointer_guard(store,config.id,prepared)
 if actual['S3PointerETag']!=approval['S3PointerETag']:raise ValueError('reviewed strong S3 ETag changed')
 if prepared['noOp']:return {**receipt,'published':False,'promoted':False}
 write_json(output/'publication-receipt.json',{**receipt,'published':None,'promoted':None,'promotionPutReturned':False,'promotionStatus':'write-attempted-outcome-pending','remoteWrites':None})
 pointer=publish(store,config,prepared,staging)
 # Preserve the successful conditional PUT fact before any remote readback.
 write_json(output/'publication-receipt.json',{**receipt,'published':True,'promoted':None,'promotionPutReturned':True,'promotionStatus':'put-returned-readback-pending','publicReadbackConfirmed':False,'remoteWrites':True})
 if store.get_json(f'servers/{config.id}/current.json')!=pointer:raise ValueError('promoted pointer differs')
 identity=store.get_json(f"servers/{config.id}/releases/{pointer['releaseId']}/release-identity.json")
 if identity.get('releaseId')!=pointer['releaseId'] or identity.get('sourceId')!=pointer['sourceId'] or identity.get('server')!=config.id:raise ValueError('promoted immutable identity differs')
 return {**receipt,'published':True,'promoted':True,'promotionPutReturned':True,'promotionStatus':'S3-readback-confirmed','publicReadbackConfirmed':False,'remoteWrites':True}

def verify_public(config,prepared):
 proofs=[]
 expected={'':prepared['index'],**{f'/{key}':value for key,value in prepared['entities'].items()}}
 for suffix,value in expected.items():
  url=f'https://haneoka.org/api/v1/servers/{config.id}/tgw-card{suffix}'
  with urlopen(Request(url,headers={'User-Agent':'Mozilla/5.0','Accept':'application/json'}),timeout=30) as response:
   if response.status!=200 or response.headers.get('X-Haneoka-Release-Id')!=prepared['manifest']['releaseId'] or response.headers.get('X-Haneoka-Source-Id')!=prepared['sourceId']:raise ValueError('current TGW public identity differs from promoted candidate')
   body=response.read(2*1024*1024+1)
   if len(body)>2*1024*1024 or json.loads(body)!=value:raise ValueError('current TGW public record differs from exact projected native entity')
  proofs.append({'path':'tgw-card'+suffix,'HTTP':200,'bytes':len(body),'sha256':digest(body)})
 return {'server':config.id,'releaseId':prepared['manifest']['releaseId'],'sourceId':prepared['sourceId'],'rankCount':21,'allExactProjectedEntitiesMatch':True,'proofs':proofs}

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
 server=os.environ.get('RESOURCE_SERVER');mode=os.environ.get('TGW_MODE')
 if server not in {'jp','intl'} or mode not in {'preflight','publish-reviewed'}:raise ValueError('TGW manual mode requires one production server')
 pin=os.environ.get('PRODUCER_PIN','')
 if not re.fullmatch('[0-9a-f]{40}',pin) or subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()!=pin:raise ValueError('captured producer checkout differs')
 packed=os.environ.get('TGW_INPUT_JSON','')
 if len(packed.encode())>16384:raise ValueError('TGW input exceeds bounded JSON cap')
 expected=json.loads(packed)
 if expected.get('schema')!='haneoka-current-tgw-input-v1' or expected.get('server')!=server or not re.fullmatch('[0-9a-f]{64}',expected.get('pointerRawSHA256','')) or type(expected.get('pointerRawBytes')) is not int or not 0<expected['pointerRawBytes']<=4096:raise ValueError('reviewed API identity/raw-pointer input missing')
 config=load_server_config(server);store=BoundedReadStore(config)
 if store.client._request_signer._credentials is None:
  write_json(args.output/'credential-availability.json',{'existingS3CredentialsAvailable':False,'remoteWrites':0});raise ValueError('existing hosted S3 credentials unavailable')
 with tempfile.TemporaryDirectory(prefix='current-tgw-projection-') as folder:
  staging=Path(folder);prepared,receipt=prepare(store,config,expected,staging)
  write_json(args.output/'prepare-receipt.json',receipt)
  if mode=='publish-reviewed':
   packed_approval=os.environ.get('TGW_APPROVAL_JSON','')
   if len(packed_approval.encode())>16384:raise ValueError('TGW approval exceeds bounded JSON cap')
   receipt=publish_reviewed(config,prepared,receipt,json.loads(packed_approval),staging,args.output)
   write_json(args.output/'publication-receipt.json',receipt)
   write_json(args.output/'public-readback.json',verify_public(config,prepared))
   receipt.update(publicReadbackConfirmed=True,promotionStatus='confirmed' if receipt.get('promotionPutReturned') else 'no-op')
   write_json(args.output/'publication-receipt.json',receipt)
 print(stable_json({k:receipt[k] for k in ['producerPin','server','baseReleaseId','sourceId','newReleaseId','S3PointerETag','pointerRawSHA256','candidateGuardSHA256','rankCount','benefitCount','changedPathCount','changedBytes','remoteWrites']}))

if __name__=='__main__':main()
