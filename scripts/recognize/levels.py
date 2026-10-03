"""Native glyph level reader; templates/ranges supplied by the pinned reference index."""
import cv2
import numpy as np

def similarity(patch,reference):
 h,w=patch.shape;target=cv2.resize(reference,(w*4,h*4),interpolation=cv2.INTER_AREA);a=cv2.resize(patch,(w*4,h*4),interpolation=cv2.INTER_LINEAR).astype(np.float32)
 a-=a.mean();target-=target.mean();return float((a*target).sum()/(np.linalg.norm(a)*np.linalg.norm(target)+1e-8))

def components(roi,threshold):
 rgb=roi.astype(np.int32);white=(rgb.min(axis=2)>threshold)&(rgb.max(axis=2)-rgb.min(axis=2)<65);shadow=(rgb[...,2]>rgb[...,0]+15)&(rgb[...,2]>rgb[...,1]+15)&(rgb[...,0]<180)&(rgb[...,1]<180);white &= cv2.dilate(shadow.astype(np.uint8),np.ones((7,7),np.uint8))>0;count,labels,stats,_=cv2.connectedComponentsWithStats(white.astype(np.uint8),8);out=[]
 for i in range(1,count):
  x,y,w,h,area=[int(v) for v in stats[i]]
  if area<3:continue
  out.append({'x':x,'y':y,'w':w,'h':h,'area':area,'mask':(labels[y:y+h,x:x+w]==i).astype(np.float32)})
 return sorted(out,key=lambda c:c['x'])

def read_one(image,font,allowed,threshold=200):
 H,W=image.shape[:2];y0=round(H*.64);roi=image[y0:H,:round(W*.68)];cs=components(roi,threshold);anchors=[]
 for l in cs:
  if l['x']>W*.18 or not 5<=l['h']<=H*.23 or not .2<l['w']/l['h']<1.0:continue
  sl=similarity(l['mask'],font['L'])
  if sl<.55:continue
  vs=[v for v in cs if v['x']>=l['x']+l['w'] and v['x']<l['x']+l['w']+l['h']*.95 and .42<v['h']/l['h']<.86 and abs((v['y']+v['h'])-(l['y']+l['h']))<=2]
  for v in vs:
   sv=similarity(v['mask'],font['v'])
   if sv>.40:anchors.append((sl+sv,l,v,sl,sv))
 if not anchors:return {'value':None,'reason':'Lv-prefix-not-found','threshold':threshold}
 _,l,v,sl,sv=max(anchors,key=lambda t:t[0]);bottom=l['y']+l['h'];digits=[]
 for c in cs:
  if c['x']<v['x']+v['w']+1 or c['h']<l['h']*.8 or c['h']>l['h']*1.5 or abs(c['y']+c['h']-bottom)>2 or c['w']>c['h']*1.1:continue
  if c['y']==0 or c['x']+c['w']>=roi.shape[1] or c['y']+c['h']>=roi.shape[0]:
   return {'value':None,'reason':'digit-component-touches-roi-boundary','prefix':[sl,sv],'threshold':threshold}
  if digits and c['x']-digits[-1]['bbox'][0]-digits[-1]['bbox'][2]>l['h']*.75:break
  if not digits and c['x']-(v['x']+v['w'])>l['h']*1.35:continue
  ranked=sorted([(character,similarity(c['mask'],ref)) for character,ref in font.items() if character.isdigit()],key=lambda r:r[1],reverse=True)
  digits.append({'character':ranked[0][0],'score':ranked[0][1],'margin':ranked[0][1]-ranked[1][1],'second':ranked[1][0],'bbox':[c['x'],y0+c['y'],c['w'],c['h']]})
  if len(digits)>=3:break
 if not digits:return {'value':None,'reason':'no-complete-digit-components','prefix':[sl,sv],'threshold':threshold}
 text=''.join(c['character'] for c in digits);value=int(text);good=min(d['score'] for d in digits)>.63 and min(d['margin'] for d in digits)>.035 and value in allowed
 return {'value':value if good else None,'candidate':value,'reason':'accepted' if good else 'reject-digit-evidence-or-range','text':text,'prefix':[sl,sv],'digits':digits,'threshold':threshold,'quality':min(d['score'] for d in digits)+min(d['margin'] for d in digits)}

def read_level(image,font,allowed):
 variants=[read_one(image,font,allowed,t) for t in [190,200,210]]
 strong=[r for r in variants if r['value'] is not None]
 weak=[r for r in variants if r.get('candidate') in allowed and r.get('digits')
       and min(d['score'] for d in r['digits'])>.45 and min(d['margin'] for d in r['digits'])>.02]
 counts={r['candidate']:sum(v['candidate']==r['candidate'] for v in weak) for r in weak}
 valid=[r for r in strong if counts.get(r['value'],0)>=2]
 if not valid or len(counts)>1:
  best=max(variants,key=lambda r:r.get('quality',-1))
  return {'value':None,'reason':'threshold-variants-disagree-or-no-strong-supported-read','variants':variants,'best':best}
 best=max(valid,key=lambda r:r['quality'])
 return {**best,'variants':variants,'thresholdAgreement':counts[best['value']]}
