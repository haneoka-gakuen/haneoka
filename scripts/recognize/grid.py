"""Local executable grid proposal prototype; no screenshot IDs, fixed rows or column counts."""
from pathlib import Path
import cv2,numpy as np
from PIL import Image,ImageOps
cv2.setNumThreads(2)
def iou(a,b):
 x=max(a[0],b[0]);y=max(a[1],b[1]);r=min(a[0]+a[2],b[0]+b[2]);d=min(a[1]+a[3],b[1]+b[3]);v=max(0,r-x)*max(0,d-y);return v/(a[2]*a[3]+b[2]*b[3]-v+1e-8)
def grid(image):
 H,W=image.shape[:2];edge=cv2.Canny(cv2.cvtColor(image,cv2.COLOR_RGB2GRAY),50,120);closed=cv2.morphologyEx(edge,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8));contours,_=cv2.findContours(closed,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE);candidates=[]
 for contour in contours:
  x,y,w,h=cv2.boundingRect(contour)
  if min(w,h)<32 or w>W*.4 or h>H*.7:continue
  ratio=w/h;kind='members' if .68<ratio<.85 else 'snapshots' if 1.65<ratio<1.95 else None
  if kind and cv2.contourArea(contour)/(w*h)>.82:candidates.append({'kind':kind,'bbox':[x,y,w,h]})
 kept=[]
 for box in sorted(candidates,key=lambda b:b['bbox'][2]*b['bbox'][3],reverse=True):
  if not any(iou(box['bbox'],b['bbox'])>.7 for b in kept):kept.append(box)
 if not kept:return {'boxes':[],'status':'no-reliable-grid; user ROI adjustment required'}
 groups=[]
 for box in kept:
  matching=next((g for g in groups if g[0]['kind']==box['kind'] and abs(g[0]['bbox'][2]-box['bbox'][2])<box['bbox'][2]*.15 and abs(g[0]['bbox'][3]-box['bbox'][3])<box['bbox'][3]*.15),None)
  if matching is None:groups.append([box])
  else:matching.append(box)
 dominant=max(groups,key=len);kind=dominant[0]['kind'];boxes=dominant
 if kind=='members' and len(dominant)>=3:
  width=int(np.median([b['bbox'][2] for b in dominant]));height=int(np.median([b['bbox'][3] for b in dominant]));xs=sorted(set(b['bbox'][0] for b in dominant));ys=sorted(set(b['bbox'][1] for b in dominant));diffs=[b-a for a,b in zip(xs,xs[1:]) if b-a>=width*.9]
  if diffs:
   local_steps=[v for v in diffs if v<width*1.5]
   if not local_steps:return {'boxes':boxes,'status':'sparse-grid; coordinate confirmation required','kind':kind,'contourSeeds':len(dominant)}
   pitch_x=int(np.median(local_steps));x0=min(xs);y0=int(np.median(ys));xmax=max(xs);right=xmax+width
   profile=edge[:,x0:right].sum(axis=1)/255;smoothed=np.convolve(profile,np.ones(5)/5,mode='same')
   options=[]
   for pitch_y in range(round(height*1.02),round(height*1.35)+1):
    starts=list(range(y0,H-height+1,pitch_y));ends=[min(H-1,y+height-1) for y in starts];score=sum(smoothed[y] for y in ends)
    options.append((score,pitch_y,starts))
   _,pitch_y,starts=max(options)
   if len(starts)>1:
    boxes=[{'kind':kind,'bbox':[x,y,width,height],'proposal':'edge-seeded regular grid with measured pitch'} for y in starts for x in range(x0,xmax+round(width*.2)+1,pitch_x)]
 return {'boxes':sorted(boxes,key=lambda b:(round(b['bbox'][1]/max(1,b['bbox'][3]*.4)),b['bbox'][0])),'status':'proposals-only; verify card identity and reject unknowns','kind':kind,'contourSeeds':len(dominant)}
