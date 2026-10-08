#!/usr/bin/env python3
"""Build auditable native and reference-assisted textless stamp artwork.

Catalog production applies multilingual donor fusion and caption masks to every
native Sprite. Empty removal masks preserve the original bytes; missing detail
receives explicit local repair scopes. Discord references provide auxiliary evidence. One source-sized image
is stored per immutable recipe; browser exports preserve its effective limits.
Legacy reference-assisted candidates remain available for audit and reuse.
"""
from __future__ import annotations

import argparse
import hashlib
import csv
import gzip
import json
import os
import re
import shutil
import subprocess
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, __version__ as PILLOW_VERSION
try:
    import cv2
    cv2.setNumThreads(2)
    cv2.setRNGSeed(0)
except ImportError:
    cv2=None

SCHEMA = "haneoka-textless-stamps-v1"
_TOOLCHAIN = None
_DETECTOR_MODEL=os.environ.get('TEXTLESS_DETECTOR_MODEL')
_DETECTOR_NET=None
_DETECTION_CACHE={}


def toolchain_fingerprint() -> dict:
    global _TOOLCHAIN
    if _TOOLCHAIN is None:
        model = Path(os.environ.get("TESSDATA_PREFIX", "/usr/share/tessdata"))/"chi_sim.traineddata"
        version = "unavailable"
        if not _DETECTOR_MODEL and shutil.which("tesseract"):
            version = subprocess.run(["tesseract","--version"],capture_output=True,text=True,
                                     timeout=5,check=False).stdout.splitlines()[0]
        _TOOLCHAIN = {"pillow":PILLOW_VERSION,"numpy":np.__version__,"tesseract":version,
                      "ocrModelSha256":digest(model) if not _DETECTOR_MODEL and model.is_file() else None,
                      "opencv":cv2.__version__ if cv2 is not None else None,
                      "textDetectorSha256":digest(Path(_DETECTOR_MODEL)) if _DETECTOR_MODEL else None}
    return _TOOLCHAIN


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def rgba(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGBA")).copy()


def resize(a: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    # Pillow's RGBA resize filters premultiplied channels internally.
    return np.asarray(Image.fromarray(a).resize(size, Image.Resampling.LANCZOS))


def dilate(mask: np.ndarray, radius: int) -> np.ndarray:
    if cv2 is not None:
        return cv2.dilate(mask.astype(np.uint8),np.ones((radius*2+1,radius*2+1),np.uint8),
                          borderType=cv2.BORDER_CONSTANT,borderValue=0)>0
    p = np.pad(mask, radius, constant_values=False)
    h, w = mask.shape
    return np.logical_or.reduce([p[y:y+h, x:x+w]
                                 for y in range(2*radius+1)
                                 for x in range(2*radius+1)])


def mean3(a: np.ndarray) -> np.ndarray:
    p = np.pad(a, ((1, 1), (1, 1), (0, 0)), mode="edge")
    h, w = a.shape[:2]
    return sum(p[y:y+h, x:x+w] for y in range(3) for x in range(3)) / 9


def premultiplied(a: np.ndarray) -> np.ndarray:
    f = a.astype(np.float32) / 255
    return np.dstack((f[..., :3]*f[..., 3:4], f[..., 3]))


def warp_image(image: Image.Image, scale: float, dx: float, dy: float, size: int) -> np.ndarray:
    w, h = image.size
    # Parameters use coordinates on the native canvas; rendering can be smaller.
    q = w / size
    coeff = (q / scale, 0, w/2-(w/2+dx)/scale,
             0, q / scale, h/2-(h/2+dy)/scale)
    return np.asarray(image.transform(
        (size, size), Image.Transform.AFFINE, coeff,
        Image.Resampling.BILINEAR).convert("RGBA"))


def warp(a: np.ndarray, scale: float, dx: float, dy: float, size: int) -> np.ndarray:
    return warp_image(Image.fromarray(a), scale, dx, dy, size)


def reference_canvas(a: np.ndarray, size: int) -> np.ndarray:
    ys, xs = np.where(a[..., 3] > 0)
    if not len(xs):
        raise ValueError("reference is empty")
    crop = a[ys.min():ys.max()+1, xs.min():xs.max()+1]
    ratio = size * 0.86 / max(crop.shape[:2])
    image = resize(crop, (round(crop.shape[1]*ratio), round(crop.shape[0]*ratio)))
    out = np.zeros((size, size, 4), np.uint8)
    y, x = (size-image.shape[0])//2, (size-image.shape[1])//2
    out[y:y+image.shape[0], x:x+image.shape[1]] = image
    return out


def artwork_anchor(a: np.ndarray) -> tuple[int,int,int,int] | None:
    rgb=a[...,:3].astype(np.int32);r,g,b=rgb[...,0],rgb[...,1],rgb[...,2]
    skin=(a[...,3]>220)&(r>215)&(g>195)&(b>175)&(r-b>=8)&(r-b<50)&(g-b>=3)
    parts=components(skin)
    return parts[0][2] if parts and parts[0][0]>=200 else None


def feature_register(a: np.ndarray,target: np.ndarray) -> tuple[np.ndarray,dict] | None:
    if cv2 is None:return None
    sift=cv2.SIFT_create(nfeatures=1500,contrastThreshold=.025,edgeThreshold=8)
    features=[]
    for image in [a,target]:
        seeds,_=structural_caption_seeds(image)
        alpha=image[...,3:4].astype(np.float32)/255
        gray=cv2.cvtColor((image[...,:3]*alpha+127*(1-alpha)).astype(np.uint8),cv2.COLOR_RGB2GRAY)
        mask=((image[...,3]>128)&~dilate(seeds,6)).astype(np.uint8)*255
        features.append(sift.detectAndCompute(gray,mask))
    (ka,da),(kb,db)=features
    if da is None or db is None or min(len(ka),len(kb))<8:return None
    matcher=cv2.BFMatcher(cv2.NORM_L2)
    forward=matcher.knnMatch(da,db,k=2);backward=matcher.knnMatch(db,da,k=2)
    reverse={m.queryIdx:m.trainIdx for pair in backward if len(pair)==2
             for m,n in [pair] if m.distance<.72*n.distance}
    good=[m for pair in forward if len(pair)==2 for m,n in [pair]
          if m.distance<.72*n.distance and reverse.get(m.trainIdx)==m.queryIdx]
    if len(good)<8:return None
    src=np.float32([ka[m.queryIdx].pt for m in good]);dst=np.float32([kb[m.trainIdx].pt for m in good])
    cv2.setRNGSeed(0)
    matrix,inliers=cv2.estimateAffinePartial2D(src,dst,method=cv2.RANSAC,
                                             ransacReprojThreshold=1.25,maxIters=3000,confidence=.999)
    if matrix is None or int(inliers.sum())<8:return None
    src=src[inliers.ravel()>0];dst=dst[inliers.ravel()>0];size=a.shape[1]
    if cv2.contourArea(cv2.convexHull(src))<500:return None
    angle=abs(np.degrees(np.arctan2(matrix[1,0],matrix[0,0])))
    if angle>.5:return None
    centered=src-size/2;goal=dst-size/2
    design=np.zeros((len(src)*2,3),np.float64);design[::2,0]=centered[:,0]
    design[1::2,0]=centered[:,1];design[::2,1]=1;design[1::2,2]=1
    scale,dx,dy=np.linalg.lstsq(design,goal.ravel(),rcond=None)[0]
    if not .7<scale<1.4:return None
    if abs(scale-1)<.004:
        snapped=src+np.array([round(dx),round(dy)])
        if np.sqrt(((snapped-dst)**2).sum(axis=1)).mean()<.6:scale=1.;dx=float(round(dx));dy=float(round(dy))
    reprojection=np.sqrt(((centered*scale+np.array([dx,dy])-goal)**2).sum(axis=1))
    if float(np.median(reprojection))>.7:return None
    return warp(a,float(scale),float(dx),float(dy),size),{
        'scale':float(scale),'dx':float(dx),'dy':float(dy),'accepted':True,
        'method':'sift-ransac-similarity-v1','featureMatches':len(good),
        'inliers':len(src),'medianReprojectionError':float(np.median(reprojection)),
        'integerTranslation':bool(scale==1 and dx==round(dx) and dy==round(dy))}


def register(a: np.ndarray, target: np.ndarray, target_support: np.ndarray | None = None,
             initial_guess: tuple[float,float,float] | None = None) -> tuple[np.ndarray, dict]:
    if target_support is not None:
        feature_result=feature_register(a,target)
        if feature_result is not None:return feature_result
    size = a.shape[1]
    # Pillow premultiplies the full source before every RGBA affine transform.
    # Cache that identical conversion once across all bounded search candidates.
    native_image = Image.fromarray(a).convert("RGBa")
    # Robust colour fit inside a known clean silhouette prevents captions from
    # winning on occupancy alone. Alpha loss penalizes accidental empty matches.
    def loss_function(n: int):
        ref = premultiplied(resize(target, (n, n)))
        valid = ref[..., 3] > 0.8
        if target_support is not None:
            valid &= np.asarray(Image.fromarray(target_support).resize((n,n),Image.Resampling.NEAREST))
        def score(scale, dx, dy):
            candidate = premultiplied(warp_image(native_image, scale, dx, dy, n))
            error = np.abs(candidate-ref)[valid]
            rgb_error = error[:, :3].mean(axis=1)
            k = max(1, round(len(rgb_error)*0.65))
            trimmed = np.partition(rgb_error, k-1)[:k].mean()
            # Bounded full-region error distinguishes scale changes that the
            # trimmed interior alone would accept on broad colour regions.
            bounded = np.minimum(rgb_error, 0.20).mean()
            return float(trimmed + 0.6*bounded + 0.4*error[:, 3].mean())
        return score
    scored = []
    score = loss_function(64)
    scales=np.linspace(0.8,1.2,17) if initial_guess is None else np.linspace(initial_guess[0]-.025,initial_guess[0]+.025,11)
    dys=range(-64,65,4) if initial_guess is None else range(round(initial_guess[2])-6,round(initial_guess[2])+7,2)
    dxs=range(-64,65,4) if initial_guess is None else range(round(initial_guess[1])-6,round(initial_guess[1])+7,2)
    for s in scales:
        for dy in dys:
            for dx in dxs:
                scored.append((score(s, dx, dy), float(s), float(dx), float(dy)))
    scored.sort()
    # Refine distinct coarse hypotheses; captions can bias one coarse winner.
    hypotheses = []
    for item in scored:
        if all(abs(item[1]-other[1]) > 0.015 or
               abs(item[2]-other[2])+abs(item[3]-other[3]) > 12
               for other in hypotheses):
            hypotheses.append(item)
        if len(hypotheses) == 3:
            break
    score = loss_function(128)
    refined = []
    for best in hypotheses:
        for s in np.linspace(best[1]-0.02, best[1]+0.02, 9):
            for dy in np.arange(best[3]-6, best[3]+6.1, 2):
                for dx in np.arange(best[2]-6, best[2]+6.1, 2):
                    refined.append((score(s, dx, dy), float(s), float(dx), float(dy)))
    refined.sort()
    best = refined[0]
    score = loss_function(256)
    final = []
    for s in (best[1]-0.0025, best[1], best[1]+0.0025):
        for dy in (best[3]-1, best[3], best[3]+1):
            for dx in (best[2]-1, best[2], best[2]+1):
                final.append((score(s, dx, dy), s, dx, dy))
    final.sort()
    best = final[0]
    aligned = warp(a, *best[1:], size)
    return aligned, {"scale": best[1], "dx": best[2], "dy": best[3],
                     "trimmed_premultiplied_error": best[0],
                     "runner_up_margin": final[1][0]-best[0],
                     "accepted": best[0] < 0.07,
                     "method":"skin-and-native-art-support-v1" if target_support is not None else "full-image-v1"}


def discover(indir: Path) -> dict[str, dict[str, Path]]:
    groups: dict[str, dict[str, Path]] = {}
    for path in sorted(indir.rglob("*.png")):
        match = re.fullmatch(r"(stamp_(?:illust|text)_[^()]+)(?:\(([^()]+)\))?", path.stem)
        if match:
            groups.setdefault(match[1], {})[match[2] or "ja"] = path
    return groups


def catalog_inventory(catalog: Path, build: Path, assets: Path, server: str = 'intl', *, stamp_ids: set[str] | None = None) -> dict:
    """Read existing per-bundle metadata and Sprite headers; never re-extract assets."""
    entities = {}
    for path in sorted(catalog.glob("*.json")) if catalog.is_dir() else [catalog]:
        entities.update(json.loads(path.read_text()))
    if stamp_ids is not None:
        entities = {key: value for key, value in entities.items() if key in stamp_ids}
    metadata_dir = build/"metadata/bundles"
    if shutil.which("rg"):
        result = subprocess.run(["rg", "-l", "-F", "Assets/AddressableResources/Stamp/",
                                 str(metadata_dir)], capture_output=True, text=True, check=False)
        if result.returncode not in (0, 1):
            raise ValueError("stamp bundle metadata discovery failed")
        paths = [Path(p) for p in result.stdout.splitlines()]
    else:
        paths = sorted(metadata_dir.glob("*.json"))
    outputs = {}
    for path in paths:
        meta = json.loads(path.read_text())
        for src in meta.get("sources", []):
            if not src.get("basePath", src.get("sourcePath", "")).startswith(
                    "Assets/AddressableResources/Stamp/"):
                continue
            textures = [o for o in src["outputs"] if o["role"] == "source" and o["type"] == "Texture2D"]
            sprites = [o for o in src["outputs"] if o["type"] == "Sprite"]
            for texture in textures:
                file = build/texture["path"]
                if not file.is_file() or file.stat().st_size != texture["bytes"]:
                    continue
                if not sprites:
                    raise ValueError(f"no Sprite metadata for {file}")
                sprite = sprites[0]
                with gzip.open(build/meta["objectArchive"]["path"], "rt") as stream:
                    data = next(json.loads(line)["data"] for line in stream
                                if (item := json.loads(line)).get("type") == "Sprite"
                                and str(item["pathId"]) == str(sprite["objectId"]))
                with Image.open(file) as image:
                    texture_size = list(image.size)
                with Image.open(build/sprite["path"]) as image:
                    sprite_size = list(image.size)
                relative = texture["path"].removeprefix("assets/")
                row = {"path": str((assets/relative).resolve()), "sha256": texture["sha256"],
                       "textureSize": texture_size, "spritePath": str((build/sprite["path"]).resolve()),
                       "spriteSha256": sprite["sha256"], "effectiveOriginalSize": sprite_size,
                       "spriteRect": data["m_Rect"], "atlasSpriteRect": data["m_RD"]["textureRect"],
                       "downscaleMultiplier": data["m_RD"]["downscaleMultiplier"],
                       "serializedFile": sprite["serializedFile"], "spriteObjectId": sprite["objectId"],
                       "bundleSha256": meta["bundle"]["sha256"]}
                if relative in outputs and outputs[relative]["sha256"] != row["sha256"]:
                    raise ValueError(f"ambiguous selected stamp source: {relative}")
                outputs[relative] = row
    groups = discover(assets/"Assets/AddressableResources/Stamp")
    records = []
    for stamp_id, entry in sorted(entities.items(), key=lambda v: int(v[0])):
        relative = entry["image"].removeprefix(f"/assets/{server}/")
        resource = Path(relative).stem
        variants = []
        for language, path in groups[resource].items():
            key = path.relative_to(assets).as_posix()
            if key not in outputs:
                raise ValueError(f"missing actual Sprite geometry: {key}")
            variants.append({"language": language, **outputs[key]})
        records.append({"stampId": stamp_id, "id": resource,
                        "category": "text-only" if "/Stamp/text/" in relative else "artwork",
                        "variants": variants})
    return {"schema": "haneoka-stamp-production-inventory-v2", "server": server,
            "buildRoot":str(build.resolve()),"assetsRoot":str(assets.resolve()),
            "records": records, "sourceIdentityPolicy": "reuse selected bundle output hashes",
            "summary": {"catalogItems": len(records), "languageImages": sum(len(r["variants"]) for r in records),
                        "artworkItems": sum(r["category"] == "artwork" for r in records),
                        "textOnlyItems": sum(r["category"] == "text-only" for r in records)}}


def sprite_canvas(source: dict) -> np.ndarray:
    """Place the actual exported Sprite in its original texture pixel coordinates."""
    w, h = source["textureSize"]
    image = rgba(Path(source["spritePath"]))
    rect = source["atlasSpriteRect"]
    x, y = round(rect["x"]), round(h-rect["y"]-rect["height"])
    out = np.zeros((h, w, 4), np.uint8)
    out[y:y+image.shape[0], x:x+image.shape[1]] = image
    return out


def components(mask: np.ndarray) -> list[tuple[int, list, tuple[int, int, int, int]]]:
    if cv2 is not None:
        count,labels,stats,_=cv2.connectedComponentsWithStatsWithAlgorithm(
            mask.astype(np.uint8),4,cv2.CV_32S,cv2.CCL_WU)
        parts=[]
        for i in range(1,count):
            x,y,w,h,area=(int(v) for v in stats[i]);ys,xs=np.where(labels==i)
            parts.append((area,list(zip(ys,xs)),(x,y,x+w,y+h)))
        return sorted(parts,key=lambda p:p[0],reverse=True)
    remaining = mask.copy()
    result = []
    for y, x in zip(*np.where(mask)):
        if not remaining[y, x]:
            continue
        queue = deque([(int(y), int(x))]);remaining[y, x] = False;points = []
        while queue:
            yy, xx = queue.popleft();points.append((yy, xx))
            for ny, nx in [(yy-1, xx), (yy+1, xx), (yy, xx-1), (yy, xx+1)]:
                if 0 <= ny < mask.shape[0] and 0 <= nx < mask.shape[1] and remaining[ny, nx]:
                    remaining[ny, nx] = False;queue.append((ny, nx))
        ys, xs = zip(*points)
        result.append((len(points), points, (min(xs), min(ys), max(xs)+1, max(ys)+1)))
    return sorted(result, key=lambda v: v[0], reverse=True)


def caption_ocr(a: np.ndarray, work: Path) -> tuple[np.ndarray, list]:
    mask = np.zeros(a.shape[:2], bool);boxes = []
    if _DETECTOR_MODEL:return mask,boxes
    if not shutil.which("tesseract"):
        return mask, boxes
    # OCR is auxiliary. Multilingual spatial disagreement supplies the other
    # mask evidence; a missing OCR script never prevents producing a candidate.
    image = Image.new("RGBA", (a.shape[1], a.shape[0]), "white")
    image.alpha_composite(Image.fromarray(a));path = work/"ocr.png";image.convert("RGB").save(path)
    try:
        result = subprocess.run(["tesseract", str(path), "stdout", "-l", "chi_sim", "--psm", "11", "tsv"],
                                capture_output=True, text=True, timeout=15, check=False)
    except subprocess.TimeoutExpired:
        return mask, boxes
    if result.returncode:
        return mask, boxes
    for row in csv.DictReader(result.stdout.splitlines(), delimiter="\t"):
        text = row.get("text", "").strip()
        if not text or float(row["conf"]) < 45 or not any(c.isalnum() for c in text):
            continue
        letter_count=sum(c.isalnum() for c in text)
        if letter_count < 2 and float(row['conf']) < 85:
            continue
        x, y, w, h = (int(row[k]) for k in ["left", "top", "width", "height"])
        if min(w, h) < 7:
            continue
        if len(text) == 1 and w*h > a.shape[0]*a.shape[1]*0.08:
            continue
        boxes.append({"bbox": [x, y, w, h], "confidence": float(row["conf"]), "text": text})
        mask[max(0,y-3):min(a.shape[0],y+h+3), max(0,x-3):min(a.shape[1],x+w+3)] = True
    return mask, boxes


def structural_caption_seeds(image: np.ndarray) -> tuple[np.ndarray,list]:
    """Find repeated flat glyph fills with white outlines, without reading text."""
    if _DETECTOR_MODEL and cv2 is not None:return learned_caption_seeds(image)
    rgb=image[...,:3].astype(np.int32);hi=rgb.max(axis=2);lo=rgb.min(axis=2)
    opaque=image[...,3]>180
    ink=opaque & (hi>65) & ((hi-lo)>hi*.12) & (lo<220)
    keys=rgb[...,0]//32*64+rgb[...,1]//32*8+rgb[...,2]//32
    white=opaque & (lo>230) & ((hi-lo)<12)
    dark=opaque & (hi<140)
    seeds=np.zeros(image.shape[:2],bool);evidence=[]
    colours,counts=np.unique(keys[ink],return_counts=True)
    for colour,count in zip(colours,counts):
        if count<300:continue
        selected=ink & (keys==colour);glyphs=[];complex_count=0
        for area,points,box in components(selected):
            x0,y0,x1,y1=box;w=x1-x0;h=y1-y0
            if area<40 or min(w,h)<4 or max(w,h)>image.shape[0]*.45:continue
            pad=5;left=max(0,x0-pad);top=max(0,y0-pad);right=min(image.shape[1],x1+pad);bottom=min(image.shape[0],y1+pad)
            local=np.zeros((bottom-top,right-left),bool)
            for y,x in points:local[y-top,x-left]=True
            ring=dilate(local,4)&~dilate(local,1)
            wr=int((ring&white[top:bottom,left:right]).sum());dr=int((ring&dark[top:bottom,left:right]).sum())
            if wr<12 or wr/max(1,wr+dr)<.68:continue
            # Convex decorative polygons remain distinct from stroke glyphs.
            pts=sorted(set((x,y) for y,x in points))
            def cross(o,a,b):return (a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0])
            lower=[];upper=[]
            for q in pts:
                while len(lower)>=2 and cross(lower[-2],lower[-1],q)<=0:lower.pop()
                lower.append(q)
            for q in reversed(pts):
                while len(upper)>=2 and cross(upper[-2],upper[-1],q)<=0:upper.pop()
                upper.append(q)
            hull=lower[:-1]+upper[:-1]
            hull_area=abs(sum(a[0]*b[1]-a[1]*b[0] for a,b in zip(hull,hull[1:]+hull[:1])))/2 if len(hull)>2 else area
            concave=area/max(1,hull_area)<.78
            complex_count+=int(concave);glyphs.append((area,points))
        if complex_count>=3 and (len(glyphs)>=5 or sum(g[0] for g in glyphs)>=1000):
            for _,points in glyphs:
                for y,x in points:seeds[y,x]=True
            evidence.append({'rgbBin32':int(colour),'glyphComponents':len(glyphs),
                             'concaveGlyphComponents':complex_count,'pixels':sum(g[0] for g in glyphs)})
    return seeds,evidence


def learned_caption_seeds(image: np.ndarray) -> tuple[np.ndarray,list]:
    global _DETECTOR_NET
    key=hashlib.sha256(image.tobytes()).hexdigest()
    if key in _DETECTION_CACHE:return _DETECTION_CACHE[key]
    if _DETECTOR_NET is None:_DETECTOR_NET=cv2.dnn.readNet(_DETECTOR_MODEL)
    rgb=image[...,:3].astype(np.int32);hi=rgb.max(axis=2);lo=rgb.min(axis=2)
    contour=(image[...,3]>180)&(hi<120)&((hi-lo)<np.maximum(1,hi)*.3)
    art=np.zeros(image.shape[:2],np.uint8)
    parts=components(contour)
    if parts and parts[0][0]>=200:
        points=np.int32([(x,y) for y,x in parts[0][1]])
        cv2.fillConvexPoly(art,cv2.convexHull(points),1)
    art_is_solid=bool(art.any()) and float((image[...,3][art>0]>8).mean())>=.65
    combined=np.zeros(image.shape[:2],bool);evidence=[]
    for background in [255,96]:
        alpha=image[...,3:4].astype(np.float32)/255
        bgr=(image[...,:3]*alpha+background*(1-alpha)).astype(np.uint8)[...,::-1].copy()
        edge=max(bgr.shape[:2]);canvas=np.full((edge,edge,3),background,np.uint8)
        canvas[:bgr.shape[0],:bgr.shape[1]]=bgr
        blob=cv2.dnn.blobFromImage(canvas,1.,(512,512))
        blob=(blob-np.array([123.675,116.28,103.53],np.float32)[None,:,None,None])
        blob*=np.array([1/255/.229,1/255/.224,1/255/.225],np.float32)[None,:,None,None]
        _DETECTOR_NET.setInput(blob);prob=np.squeeze(_DETECTOR_NET.forward())
        prob=cv2.resize(prob,(edge,edge))[:image.shape[0],:image.shape[1]]
        count,labels,stats,_=cv2.connectedComponentsWithStats((prob>.3).astype(np.uint8),8)
        for i in range(1,count):
            x,y,w,h,area=(int(v) for v in stats[i]);region=labels==i
            confidence=float(prob[region].mean());outside=float((art[region]==0).mean())
            if area<80 or confidence<.65:continue
            if art_is_solid and outside<.10 and not (max(w/h,h/w)>=2.5 and area>=400):continue
            ys,xs=np.where(region);points=np.int32(np.column_stack((xs,ys)))
            hull=np.zeros(image.shape[:2],np.uint8);cv2.fillConvexPoly(hull,cv2.convexHull(points),1)
            combined|=hull>0
            evidence.append({'bbox':[x,y,w,h],'confidence':confidence,'background':background,
                             'outsideIllustrationContour':outside,'method':'ppocrv3-db-text-region'})
    # The detector can omit the first isolated glyph of a vertical phrase.
    # Extend only a detected text style to matching, white-outlined concave
    # glyph components outside the illustration; solid ornaments stay intact.
    semantic=combined.copy()
    opaque=image[...,3]>180
    coloured=opaque&(lo<220)
    colour_key=rgb[...,0]//32*64+rgb[...,1]//32*8+rgb[...,2]//32
    white=(image[...,3]>8)&(lo>220)&(hi-lo<25)
    keys,counts=np.unique(colour_key[combined&coloured],return_counts=True)
    ink=np.zeros(image.shape[:2],bool)
    for colour,count in zip(keys,counts):
        if count<120 or count<counts.max()*.25:continue
        for area,points,box in components(coloured&(colour_key==colour)):
            if area<40:continue
            ys,xs=zip(*points);ys=np.asarray(ys);xs=np.asarray(xs)
            in_region=bool(semantic[ys,xs].any())
            extent=max(box[2]-box[0],box[3]-box[1])
            aspect=extent/max(1,min(box[2]-box[0],box[3]-box[1]))
            if extent>max(image.shape[:2])*.45 and not (
                    aspect>=4 and float((art[ys,xs]==0).mean())>.25):continue
            if (float((art[ys,xs]==0).mean())<.15
                    and not bool(dilate(semantic,40)[ys,xs].any())):continue
            local=np.zeros(image.shape[:2],np.uint8);local[ys,xs]=1
            ring=dilate(local>0,4)&~(local>0)
            if float(white[ring].mean())<.15:continue
            hull=cv2.convexHull(np.int32(np.column_stack((xs,ys))))
            small_punctuation=(area<=180 or max(box[2]-box[0],box[3]-box[1])
                               /max(1,min(box[2]-box[0],box[3]-box[1]))>=2.5)
            near_phrase=bool(dilate(semantic,40)[ys,xs].any())
            if not in_region and area/max(1,cv2.contourArea(hull))>.88 and not (
                    small_punctuation and near_phrase):continue
            ink[ys,xs]=True
    # Text-region rectangles locate a phrase; only its actual ink and connected
    # white stroke are removed. Native fingers, hair and clothes in the gaps
    # between letters retain their original bytes.
    if ink.any():combined=ink|(white&dilate(ink,8))
    else:combined=semantic&white if (semantic&white).any() else semantic
    result=(combined,evidence);_DETECTION_CACHE[key]=result
    return result


def native_artwork_support(image: np.ndarray, caption_seeds: np.ndarray) -> bool:
    """Require a coherent neutral dark illustration contour outside glyphs."""
    rgb=image[...,:3].astype(np.int32);hi=rgb.max(axis=2);lo=rgb.min(axis=2)
    dark=(image[...,3]>180)&(hi<120)&((hi-lo)<np.maximum(1,hi)*.30)
    dark &= ~dilate(caption_seeds,7)
    return any(area>=200 and max(box[2]-box[0],box[3]-box[1])>=70
               for area,_,box in components(dark))


def select_native_base(variants: list[dict]) -> tuple[dict,dict]:
    """Select actual illustration resolution and occlusion, without language rank."""
    ranked=[];metrics={}
    for source in variants:
        a=sprite_canvas(source);face=artwork_anchor(a);seeds,_=structural_caption_seeds(a)
        rgb=a[...,:3].astype(np.int32);hi=rgb.max(axis=2);lo=rgb.min(axis=2)
        contour=(a[...,3]>180)&(hi<120)&((hi-lo)<np.maximum(1,hi)*.3)
        ys,xs=np.where(contour)
        support=np.zeros(a.shape[:2],bool)
        if len(xs):support[ys.min():ys.max()+1,xs.min():xs.max()+1]=True
        overlap=int((dilate(seeds,8)&support).sum())
        resolution=(face[2]-face[0])*(face[3]-face[1]) if face else int(contour.sum())
        metrics[source['language']]={'illustrationResolution':resolution,'captionOverlap':overlap}
        ranked.append((resolution,-overlap,source['spriteSha256'],source))
    maximum=max(r[0] for r in ranked)
    close=[r for r in ranked if r[0]>=maximum*.95]
    return max(close,key=lambda r:(r[1],r[0],r[2]))[3],metrics


def fuse_native_family(record: dict, work: Path, cached: dict | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
    sources = record["variants"]
    primary = next((i for i,s in enumerate(sources)
                    if s["language"] == record.get("primaryLanguage", "ja")), 0)
    order = [primary]+[i for i in range(len(sources)) if i != primary]
    sources = [sources[i] for i in order]
    raw = [sprite_canvas(s) for s in sources]
    size=max(max(a.shape[:2]) for a in raw)
    raw=[np.pad(a,((0,size-a.shape[0]),(0,size-a.shape[1]),(0,0))) for a in raw]
    base=raw[0]
    structures=[structural_caption_seeds(a) for a in raw]
    art_support=[native_artwork_support(a,seeds) for a,(seeds,_) in zip(raw,structures)]
    if not any(art_support) and any(seeds.any() for seeds,_ in structures):
        # The image evidence contains lettering but no coherent illustration.
        # No catalog category, resource path or ID determines this outcome.
        w,h=sources[0]['effectiveOriginalSize'];image=np.zeros((h,w,4),np.uint8)
        info={'primaryLanguage':sources[0]['language'],'sources':sources,
              'hasArtwork':False,'emptyAfterTextRemoval':True,'quality':'empty-after-text-removal',
              'captionDetected':True,'identityTransform':False,
              'captionMaskStrategy':'white-outline glyph topology and native illustration contours',
              'structuralCaptionEvidence':dict(zip((s['language'] for s in sources),(e for _,e in structures))),
              'nativeArtworkSupport':dict(zip((s['language'] for s in sources),art_support)),
              'registration':{},'ocrEvidence':{},'captionColourEvidence':{},
              'cropRect':{'x':round(sources[0]['atlasSpriteRect']['x']),
                          'y':round(sources[0]['textureSize'][1]-sources[0]['atlasSpriteRect']['y']-sources[0]['atlasSpriteRect']['height']),
                          'width':w,'height':h},'restoredEnclosedPrimaryPixels':0,
              'nativeDonorPixels':0,'nativeDonorCounts':{s['language']:0 for s in sources},
              'captionRemovedPixels':int((base[...,3]>8).sum()),'unresolvedNativeDetailPixels':0,
              'unresolvedNativeDetailPercent':0,'approximateFlatFillPixels':0,
              'manualRepairScopes':[],'approximateFlatFillScopes':[],
              'repairScopeCoordinateSpace':'primary-native-texture-pixels','provenanceLegend':{'0':'transparent'}}
        return image,np.zeros((h,w),np.uint8),np.zeros((h,w),bool),info
    aligned, masks, registrations, ocr, caption_risks = [], [], [], [], []
    for i, image in enumerate(raw):
        language = sources[i]["language"]
        if cached:
            boxes = [b for b in cached["ocrEvidence"][language]
                     if not (sum(c.isalnum() for c in b['text']) < 2 and b['confidence'] < 85)
                     and not (len(b["text"]) == 1 and b["bbox"][2]*b["bbox"][3] > size*size*0.08)]
            text_mask = np.zeros(image.shape[:2],bool)
            for box in boxes:
                x,y,w,h = box["bbox"]
                text_mask[max(0,y-3):min(size,y+h+3),max(0,x-3):min(size,x+w+3)] = True
        else:
            text_mask, boxes = caption_ocr(image, work)
        if i == 0:
            fitted = image;reg = {"scale": 1.0, "dx": 0.0, "dy": 0.0, "accepted": True}
        elif cached and cached['registration'][language].get('method') in (
                ('sift-ransac-similarity-v1',) if _DETECTOR_MODEL else
                ('sift-ransac-similarity-v1','skin-and-native-art-support-v1')):
            reg = cached["registration"][language]
            fitted = warp(image,reg["scale"],reg["dx"],reg["dy"],size)
        else:
            if record.get('requireCalibrationCache') and cached is None:
                raise ValueError('matching native calibration cache required')
            source_face=artwork_anchor(image);target_face=artwork_anchor(base);guess=None
            if source_face and target_face:
                sx0,sy0,sx1,sy1=source_face;tx0,ty0,tx1,ty1=target_face
                scale=((tx1-tx0)/max(1,sx1-sx0)+(ty1-ty0)/max(1,sy1-sy0))/2
                if .7<scale<1.4:
                    guess=(scale,(tx0+tx1)/2-size/2-scale*((sx0+sx1)/2-size/2),
                           (ty0+ty1)/2-size/2-scale*((sy0+sy1)/2-size/2))
            fitted, reg = register(image,base,~dilate(structures[0][0],10),guess)
        mask_rgba = mask_image(text_mask)
        warped_mask = warp(mask_rgba, reg["scale"], reg["dx"], reg["dy"], size)[...,3] > 0
        risk=np.zeros((size,size),bool)
        for box in boxes:
            x,y,w,h=box['bbox'];margin=max(5,round(min(w,h)*0.4))
            if len(box['text'])<2 and not (
                    box['confidence']>=85 and h>=40 or
                    box['confidence']>=70 and w>=3*h):
                continue
            if w>=h:risk[max(0,y-margin):min(size,y+h+margin),:] = True
            else:risk[:,max(0,x-margin):min(size,x+w+margin)] = True
        risk=warp(mask_image(risk),reg['scale'],reg['dx'],reg['dy'],size)[...,3]>0
        aligned.append(fitted);masks.append(warped_mask);registrations.append(reg);ocr.append(boxes)
        caption_risks.append(risk)
    aligned = np.stack(aligned);masks = np.stack(masks)
    caption_risks=np.stack(caption_risks)
    pixels = np.stack([premultiplied(a) for a in aligned])
    # Every language contributes one vote. Registration errors remain diagnostic;
    # local pixel agreement and caption masks determine usable donor regions.
    accepted = np.ones(len(registrations),bool)
    agreement = np.zeros((len(raw), size, size), np.uint8)
    for i in range(len(raw)):
        for j in range(len(raw)):
            agreement[i] += ((np.abs(pixels[i]-pixels[j]).max(axis=2) < 0.075)
                             & accepted[j] & (aligned[j,...,3] > 8))
    minimum = max(2, int(np.ceil(int(accepted.sum())*0.6))) if accepted.sum() > 1 else 1
    common = (agreement.max(axis=0) >= minimum) & (aligned[...,3].max(axis=0) > 8)
    # Ignore low-confidence OCR inside a stable portrait. This protects eyes,
    # jewellery and linework from the recognizer's incidental character guesses.
    stable_parts = components(common)
    portrait = np.zeros((size,size),bool)
    if stable_parts:
        for yy,xx in stable_parts[0][1]:portrait[yy,xx] = True
    core = np.asarray(Image.fromarray(portrait.astype(np.uint8)*255).filter(ImageFilter.MinFilter(5))) > 0
    protection_conflicts = int((masks[0] & core).sum())
    masks &= ~(core[None,...] & (agreement >= minimum))
    colour_evidence = [];fill_seeds = [];token_colours = set()
    # A caption's flat fill changes spatially between languages even when some
    # coincident strokes have a majority vote. Expand those colour seeds to the
    # whole glyph and its outline; a flat, stable portrait colour is retained.
    for i, image in enumerate(aligned):
        rgb = image[...,:3].astype(np.int32)
        value = rgb.max(axis=2);low = rgb.min(axis=2)
        saturated = (value > 153) & ((value-low) > value*0.38) & (image[...,3] > 240)
        key = ((rgb[...,0]//16)*256+(rgb[...,1]//16)*16+rgb[...,2]//16)
        unstable = agreement[i] < minimum
        neutral = (image[...,3] > 240) & ((value-low) < np.maximum(1,value)*0.38)
        neutral = np.asarray(Image.fromarray(neutral.astype(np.uint8)*255).filter(ImageFilter.MinFilter(7))) > 0
        neutral_parts = components(neutral)
        outside_neutral = np.ones((size,size),bool)
        if neutral_parts:
            x0,y0,x1,y1=neutral_parts[0][2]
            outside_neutral[max(0,y0-4):min(size,y1+4),max(0,x0-4):min(size,x1+4)] = False
        colours = []
        raw_seed=structures[i][0];reg=registrations[i]
        fill=warp(mask_image(raw_seed),reg['scale'],reg['dx'],reg['dy'],size)[...,3]>0
        if not _DETECTOR_MODEL:fill &= ~core
        learned_caption_bins = {}
        for box in ocr[i]:
            # Multi-letter OCR tokens supply caption colour even for muted
            # grey-blue lettering. Single-character picture guesses do not.
            if len(box["text"]) < 2 and not (
                    not box["text"].isascii() and box["confidence"] >= 85
                    and box["bbox"][3] >= 40):
                continue
            x,y,w,h=box["bbox"]
            raw_rgb=raw[i][y:y+h,x:x+w,:3].astype(np.int32)
            raw_alpha=raw[i][y:y+h,x:x+w,3]
            hi=raw_rgb.max(axis=2);lo=raw_rgb.min(axis=2)
            eligible=(raw_alpha>240)&(hi>90)&((hi-lo)>hi*0.12)
            if eligible.any():
                bins=raw_rgb[...,0]//16*256+raw_rgb[...,1]//16*16+raw_rgb[...,2]//16
                keys,counts=np.unique(bins[eligible],return_counts=True)
                colour=int(keys[np.argmax(counts)])
                line=np.zeros((size,size),bool)
                if w>=h:
                    margin=max(5,round(h*0.35));line[max(0,y-margin):min(size,y+h+margin),:] = True
                else:
                    margin=max(5,round(w*0.35));line[:,max(0,x-margin):min(size,x+w+margin)] = True
                reg=registrations[i]
                fitted_line=warp(mask_image(line),reg['scale'],reg['dx'],reg['dy'],size)[...,3]>0
                learned_caption_bins[colour]=learned_caption_bins.get(colour,np.zeros_like(line))|fitted_line
        for colour,region in learned_caption_bins.items():
            token_colours.add(colour)
            selected=(key==colour)&(image[...,3]>240)&region&~core
            fill |= selected
            colours.append({"rgbBin":colour,"pixels":int(selected.sum()),
                            "evidence":"caption token colour, including muted lettering"})
        for colour in np.unique(key[saturated]):
            selected = saturated & (key == colour)
            count = int(selected.sum());changed = int((selected & unstable).sum())
            core_fraction = float((selected & core).sum())/max(1,count)
            # Some official variants keep the same caption in every language.
            # Repeated bright glyph components outside the neutral portrait
            # provide a same-language mask even without temporal disagreement.
            outside_fraction = float((selected & outside_neutral).sum())/max(1,count)
            glyph_parts = components(selected) if count >= 3000 and outside_fraction > 0.65 else []
            shared_caption = len([part for part in glyph_parts if part[0] >= 80]) >= 3
            isolated_boxes = []
            if not shared_caption and count >= 2000:
                colour_parts = components(selected)
                if len([part for part in colour_parts if part[0] >= 50]) >= 3:
                    isolated = np.full_like(image,255);isolated[selected,:3] = 0
                    _, isolated_boxes = caption_ocr(isolated,work)
                    shared_caption = bool(isolated_boxes)
            if shared_caption:
                fill |= selected & outside_neutral & ~core
                for box in isolated_boxes:
                    x,y,w,h=box["bbox"]
                    masks[i,max(0,y-5):min(size,y+h+5),max(0,x-5):min(size,x+w+5)] = True
                colours.append({"rgbBin":int(colour),"pixels":count,"disagreementPixels":changed,
                                "evidence":"same-language glyph topology or colour-isolated OCR",
                                "isolatedOcr":isolated_boxes})
                continue
            if count >= 300 and changed >= 200 and changed/max(1,count) > 0.18:
                if core_fraction > 0.85 and changed/count < 0.5:
                    continue
                fill |= selected & ~core
                colours.append({"rgbBin":int(colour),"pixels":count,"disagreementPixels":changed})
        glyph = dilate(fill,2 if _DETECTOR_MODEL else 10)
        masks[i] |= glyph
        fill_seeds.append(fill)
        colour_evidence.append(colours)
    caption_detected = bool((masks & (aligned[...,3] > 8)
                             & accepted[:,None,None]).any())
    if not caption_detected:
        # An empty removal mask is the identity transform for every input.
        # Preserve the actual Sprite frame, padding and native RGBA bytes.
        image = rgba(Path(sources[0]['spritePath']))
        rect=sources[0]['atlasSpriteRect'];x=round(rect['x'])
        y=round(sources[0]['textureSize'][1]-rect['y']-rect['height'])
        provenance=np.where(image[...,3]>0,1,0).astype(np.uint8)
        info={'primaryLanguage':sources[0]['language'],'sources':sources,
              'registration':dict(zip((s['language'] for s in sources),registrations)),
              'ocrEvidence':dict(zip((s['language'] for s in sources),ocr)),
              'captionColourEvidence':dict(zip((s['language'] for s in sources),colour_evidence)),
              'captionMaskStrategy':'native-family spatial consensus plus auxiliary local OCR',
              'captionDetected':False,'identityTransform':True,
              'captionProtectionConflictPixels':protection_conflicts,
              'restoredEnclosedPrimaryPixels':0,'locallySupportedReplacementPixels':0,
              'restoredCleanPairPixels':0,'removedCleanPairBackgroundPixels':0,
              'removedDetachedCaptionBorderPixels':0,
              'cropRect':{'x':x,'y':y,'width':image.shape[1],'height':image.shape[0]},
              'nativeDonorPixels':int((provenance>0).sum()),
              'nativeDonorCounts':{s['language']:int((provenance>0).sum()) if i==0 else 0
                                   for i,s in enumerate(sources)},
              'captionRemovedPixels':0,'approximateFlatFillPixels':0,
              'unresolvedNativeDetailPixels':0,'unresolvedNativeDetailPercent':0,
              'manualRepairScopes':[],'approximateFlatFillScopes':[],
              'repairScopeCoordinateSpace':'primary-native-texture-pixels',
              'provenanceLegend':{'0':'transparent','254':'approximate flat fill',
                                  **{str(i+1):s['language'] for i,s in enumerate(sources)}}}
        return image,provenance,np.zeros(image.shape[:2],bool),info
    clean_foreground=(~masks&(aligned[...,3]>8)).sum(axis=0)
    clean_common=common&(clean_foreground>=min(2,len(raw)))
    parts = components(clean_common)
    if not parts:
        parts = components(base[...,3] > 8)
    anchor = np.zeros((size,size), bool)
    if parts:
        _, _, box = parts[0];x0,y0,x1,y1 = box;pad = max(8, round(max(x1-x0,y1-y0)*0.15))
        for area, points, bb in parts:
            if area >= max(12, parts[0][0]*0.008) and bb[0]<x1+pad and bb[2]>x0-pad and bb[1]<y1+pad and bb[3]>y0-pad:
                for yy,xx in points:anchor[yy,xx] = True
    shape = dilate(anchor, 3) & (aligned[...,3].max(axis=0) > 8)
    # Fill small discontinuities in the connected body support, then retain only
    # pixels supported by original Sprite opacity. No character is synthesized.
    closed = np.asarray(Image.fromarray(shape.astype(np.uint8)*255).filter(
        ImageFilter.MaxFilter(7)).filter(ImageFilter.MinFilter(7))) > 0
    shape |= closed & (aligned[...,3].max(axis=0) > 8)
    for source_index in range(len(raw)):
        primary_parts = components((aligned[source_index,...,3] > 8) & ~masks[source_index])
        if not primary_parts:continue
        # The original connected portrait remains authoritative for outer hair,
        # hands and costume contours as well as enclosed facial detail. Consensus
        # decides replacement donors; it must not amputate unmasked native art.
        _,_,body_box=primary_parts[0]
        px0,py0,px1,py1=body_box;pad=max(12,round(max(px1-px0,py1-py0)*0.3))
        for area,points,box in primary_parts:
            if (area >= 32 and box[0]<px1+pad and box[2]>px0-pad
                    and box[1]<py1+pad and box[3]>py0-pad):
                for yy,xx in points:shape[yy,xx] = True
    # Disagreement is evidence about donor confidence, not transparency. Eyes,
    # jewellery and strokes can disagree after registration while remaining
    # opaque original artwork. Restore enclosed original opacity before donors
    # are selected; preserve genuine transparent gaps from the primary Sprite.
    restored_internal = np.zeros_like(shape)
    for area, points, box in components(~shape):
        if box[0] == 0 or box[1] == 0 or box[2] == size or box[3] == size:
            continue
        for yy,xx in points:
            if ((aligned[:,yy,xx,3]>8)&~masks[:,yy,xx]).any():
                shape[yy,xx] = True;restored_internal[yy,xx] = True
    valid = (~masks & accepted[:,None,None] & (aligned[...,3] > 8)
             & ((agreement >= 2) | (common[None,...] & (agreement >= minimum))))
    valid |= shape[None,...] & ~masks & (aligned[...,3]>8)
    # Two locally agreeing clean donors can reveal artwork hidden by the
    # primary caption. Do not require the stricter whole-family silhouette vote
    # in those regions; admit clean donor components connected to the portrait.
    replacement_pixels = 0
    for area,points,box in components(valid.any(axis=0)):
        overlap = sum(bool(shape[yy,xx]) for yy,xx in points)
        if overlap >= min(100,max(1,area//10)):
            for yy,xx in points:
                if not shape[yy,xx]:replacement_pixels += 1
                shape[yy,xx] = True
    # A locally clean alternative outranks a donor's caption line even when a
    # recognizer missed individual letters. Outside caption-risk regions retain
    # the primary native bytes, avoiding fragmented source switching.
    ranks={value:i for i,value in enumerate(sorted(s['spriteSha256'] for s in sources))}
    tie=np.array([ranks[s['spriteSha256']] for s in sources],np.float32)*.00001
    score=np.where(valid,agreement.astype(np.float32)-caption_risks*100
                   +aligned[...,3]/255*.01+tie[:,None,None],-1000)
    donor=np.argmax(score,axis=0)
    # Language evidence remains equal. Once the cleanest native base is chosen,
    # its unobscured pixels need no resampling or donor switching.
    base_valid=valid[0]&~masks[0]
    donor[base_valid]=0
    protected_art=(valid&~caption_risks&(agreement>=minimum)).any(axis=0)
    protected_art |= base_valid
    known = valid.any(axis=0) & shape
    output = np.zeros_like(base);provenance = np.zeros((size,size), np.uint8)
    for i in range(len(raw)):
        selected = known & (donor == i);output[selected] = aligned[i][selected];provenance[selected] = i+1
    # Clean donors also provide authoritative transparent pixels. Ignoring
    # those votes leaves primary caption fragments outside the real costume.
    # Compare the full premultiplied RGBA value, including empty background,
    # and require two independently unmasked, caption-free language sources.
    clean = ~masks & ~caption_risks & accepted[:,None,None]
    clean_support = np.zeros_like(agreement)
    for i in range(len(raw)):
        for j in range(len(raw)):
            clean_support[i] += (clean[i] & clean[j]
                                 & (np.abs(pixels[i]-pixels[j]).max(axis=2) < 0.075))
    clean_donor = np.argmax(clean_support.astype(np.float32)+tie[:,None,None],axis=0)
    clean_pair = clean_support.max(axis=0) >= 2
    restored_clean = 0;removed_clean_background = 0
    for i in range(len(raw)):
        selected = clean_pair & (clean_donor == i) & ~protected_art
        opaque = selected & (aligned[i,...,3] > 8)
        restored_clean += int((opaque & ~known).sum())
        output[opaque] = aligned[i][opaque];provenance[opaque] = i+1
        known[opaque] = True;shape[opaque] = True
        empty = selected & (aligned[i,...,3] <= 8)
        removed_clean_background += int((empty & (output[...,3] > 8)).sum())
        output[empty] = 0;provenance[empty] = 0
        known[empty] = False;shape[empty] = False
    # A caption expansion can cover nearby empty background or an antialiased
    # outline without either being lettering. Empty native alpha remains a
    # valid negative silhouette vote even inside an expanded caption box.
    empty_pair = ((aligned[...,3] <= 8) & accepted[:,None,None]).sum(axis=0) >= 2
    empty_pair &= ~protected_art
    removed_clean_background += int((empty_pair & (output[...,3] > 8)).sum())
    output[empty_pair] = 0;provenance[empty_pair] = 0
    known[empty_pair] = False;shape[empty_pair] = False
    unanimous_edge = (shape & ~known & (accepted.sum() >= 3)
                      & (agreement.max(axis=0) >= int(accepted.sum())))
    consensus_donor=np.argmax(agreement.astype(np.float32)+tie[:,None,None],axis=0)
    for i in range(len(raw)):
        selected=unanimous_edge&(consensus_donor==i)
        output[selected]=aligned[i][selected];provenance[selected]=i+1
    known[unanimous_edge] = True
    restored_clean += int(unanimous_edge.sum())
    # Expanded glyph borders must not veto matching native costume strokes.
    # Where the current pixel is a recognized caption colour (or unresolved),
    # recover two matching non-glyph donors inside the existing portrait only.
    # A slightly wider premultiplied tolerance admits native antialiased edges.
    non_glyph = ~np.stack(fill_seeds) & accepted[:,None,None] & (aligned[...,3] > 8)
    for colour in token_colours:
        channels=np.array([colour//256,(colour//16)%16,colour%16])
        lettering=(np.abs(aligned[...,:3].astype(np.int32)//16-channels).max(axis=3) <= 1)
        non_glyph &= ~(lettering & caption_risks.any(axis=0))
    edge_support = np.zeros_like(agreement)
    for i in range(len(raw)):
        for j in range(len(raw)):
            edge_support[i] += (non_glyph[i] & non_glyph[j]
                                & (np.abs(pixels[i]-pixels[j]).max(axis=2) < 0.12))
    out_rgb=output[...,:3].astype(np.int32)
    out_key=out_rgb[...,0]//16*256+out_rgb[...,1]//16*16+out_rgb[...,2]//16
    caption_residue = np.zeros((size,size),bool)
    for colour in token_colours:
        channels=np.array([colour//256,(colour//16)%16,colour%16])
        caption_residue |= (np.abs(out_rgb//16-channels).max(axis=2) <= 1)
    caption_residue &= caption_risks.any(axis=0)
    recover = shape & (~known | caption_residue&~base_valid) & (edge_support.max(axis=0) >= 2)
    edge_donor = np.argmax(edge_support.astype(np.float32)-caption_risks*0.1
                          +tie[:,None,None],axis=0)
    for i in range(len(raw)):
        selected = recover & (edge_donor == i)
        restored_clean += int(selected.sum())
        output[selected] = aligned[i][selected];provenance[selected] = i+1
        known[selected] = True
    # White caption borders can survive after their coloured fill is cleared.
    # Remove only detached, predominantly white components near detected glyphs;
    # preserve the connected portrait and coloured decorative elements.
    visible_parts = components(output[...,3] > 8)
    near_caption = dilate(np.any(masks,axis=0),5)
    removed_border_pixels = 0
    for area, points, box in visible_parts[1:]:
        yy,xx = zip(*points);yy=np.asarray(yy);xx=np.asarray(xx)
        white = (output[yy,xx,:3].min(axis=1) > 220).mean()
        near = near_caption[yy,xx].mean()
        if white > 0.6 and near > 0.15:
            output[yy,xx]=0;provenance[yy,xx]=0;known[yy,xx]=False;shape[yy,xx]=False
            removed_border_pixels += area
    missing = shape & ~known
    reference_covered=0
    reference=record.get('cleanReference')
    if reference:
        clean=reference_canvas(rgba(Path(reference['path'])),size)
        source_face=artwork_anchor(clean);target_face=artwork_anchor(base);guess=None
        if source_face and target_face:
            sx0,sy0,sx1,sy1=source_face;tx0,ty0,tx1,ty1=target_face
            scale=((tx1-tx0)/max(1,sx1-sx0)+(ty1-ty0)/max(1,sy1-sy0))/2
            guess=(scale,(tx0+tx1)/2-size/2-scale*((sx0+sx1)/2-size/2),
                   (ty0+ty1)/2-size/2-scale*((sy0+sy1)/2-size/2))
        if cached and cached.get('cleanReferenceSha256')==reference['sha256']:
            reference_reg=cached['cleanReferenceRegistration']
            clean=warp(clean,reference_reg['scale'],reference_reg['dx'],reference_reg['dy'],size)
        else:
            clean,reference_reg=register(clean,base,~dilate(structures[0][0],10),guess)
        ref_shape=clean[...,3]>8
        # Preserve the equally weighted native reconstruction. The reference
        # supplies its outer silhouette and only genuinely obscured local gaps.
        envelope=dilate(ref_shape,2)
        output[~envelope]=0;provenance[~envelope]=0;known[~envelope]=False
        ref_pixels=premultiplied(clean);local_mean=mean3(ref_pixels)
        flat=(np.abs(local_mean-ref_pixels).max(axis=2)<.025)&ref_shape
        ref_rgb=clean[...,:3].astype(np.int32)
        coloured=(ref_rgb.max(axis=2)-ref_rgb.min(axis=2)>ref_rgb.max(axis=2)*.12)
        white_letter=(output[...,:3].min(axis=2)>225)&(ref_rgb.min(axis=2)<220)
        colour_difference=np.abs(premultiplied(output)-ref_pixels).max(axis=2)>.18
        residual=known&flat&coloured&white_letter&colour_difference
        # Attached remnants have the caption's palette while the clean reference
        # shows hair or clothing. Correct those local pixels, retaining native
        # image detail elsewhere.
        palette_match=np.zeros((size,size),bool)
        out_q=output[...,:3].astype(np.int32)//32
        for image,mask in zip(aligned,masks):
            rgb=image[...,:3].astype(np.int32);hi=rgb.max(axis=2);lo=rgb.min(axis=2)
            text=mask&(image[...,3]>180)&(hi-lo>np.maximum(1,hi)*.15)
            key=rgb[...,0]//32*64+rgb[...,1]//32*8+rgb[...,2]//32
            values,counts=np.unique(key[text],return_counts=True)
            if not len(values):continue
            colour=int(values[np.argmax(counts)]);q=np.array([colour//64,(colour//8)%8,colour%8])
            palette_match|=(np.abs(out_q-q).max(axis=2)<=1)
        residual|=known&ref_shape&palette_match&colour_difference&dilate(masks.any(axis=0),16)
        uncovered=ref_shape&~known
        repair=uncovered|residual
        output[repair]=clean[repair];provenance[repair]=255
        reference_covered=int(repair.sum());known=known&~repair;shape=ref_shape
        border_zone=dilate(masks.any(axis=0),12)
        trim=border_zone&(output[...,3]>clean[...,3])
        output[trim,3]=clean[trim,3];provenance[trim]=np.where(clean[trim,3]>0,255,0)
        known[trim]=False;reference_covered+=int((trim&ref_shape&~repair).sum())
        missing=repair
    else:
        # A surviving caption border has an exposed white edge without nearby
        # illustration ink. Preserve white interiors and outlined ornaments.
        visible=output[...,3]>8;rgb=output[...,:3]
        pigment=visible&(rgb.min(axis=2)<210)
        interior=np.asarray(Image.fromarray(visible.astype(np.uint8)*255).filter(ImageFilter.MinFilter(5)))>0
        fringe=visible&(rgb.min(axis=2)>220)&~interior&~dilate(pigment,4)
        neutral=visible&(rgb.max(axis=2)<120)&(
            rgb.max(axis=2).astype(np.int32)-rgb.min(axis=2)<rgb.max(axis=2)*.3)
        outline_parts=components(neutral);body_hull=np.zeros((size,size),np.uint8)
        if outline_parts and outline_parts[0][0]>=200:
            pts=np.int32([(x,y) for y,x in outline_parts[0][1]])
            cv2.fillConvexPoly(body_hull,cv2.convexHull(pts),1)
            fringe|=visible&(rgb.min(axis=2)>220)&(body_hull==0)&dilate(masks.any(axis=0),20)
        output[fringe]=0;provenance[fringe]=0;known[fringe]=False;shape[fringe]=False
        for area,points,_ in components(output[...,3]>8):
            if area<=16:
                for y,x in points:output[y,x]=0;provenance[y,x]=0;known[y,x]=False;shape[y,x]=False
        missing=shape&~known
    # Remove small disconnected residues in an established caption's palette.
    # Stable ornaments and nearby native contour antialiasing remain supported.
    font_bins=[]
    for image,mask in zip(aligned,masks):
        rgb=image[...,:3].astype(np.int32);hi=rgb.max(axis=2);lo=rgb.min(axis=2)
        selected=mask&(image[...,3]>180)&(hi-lo>np.maximum(1,hi)*.15)
        keys=rgb[...,0]//32*64+rgb[...,1]//32*8+rgb[...,2]//32
        values,counts=np.unique(keys[selected],return_counts=True)
        if len(values):font_bins.append(int(values[np.argmax(counts)]))
    visible_parts=components(output[...,3]>8)
    main=np.zeros((size,size),bool)
    if visible_parts:
        for y,x in visible_parts[0][1]:main[y,x]=True
    near_main=dilate(main,3);near_text=dilate(masks.any(axis=0),30)
    for area,points,box in visible_parts[1:]:
        if area>256:continue
        ys,xs=zip(*points);ys=np.asarray(ys);xs=np.asarray(xs)
        if near_main[ys,xs].any() or near_text[ys,xs].mean()<.1:continue
        q=output[ys,xs,:3].astype(np.int32)//32;matched=np.zeros(len(points),bool)
        for colour in font_bins:
            palette=np.array([colour//64,(colour//8)%8,colour%8])
            matched|=(np.abs(q-palette).max(axis=1)<=1)
        if matched.mean()>.5:
            output[ys,xs]=0;provenance[ys,xs]=0;known[ys,xs]=False;shape[ys,xs]=False
    missing=shape&~known
    enclosed=np.zeros((size,size),bool)
    for area,points,box in components(~(output[...,3]>8)):
        if box[0]==0 or box[1]==0 or box[2]==size or box[3]==size or area>4000:continue
        ys,xs=zip(*points);ys=np.asarray(ys);xs=np.asarray(xs)
        supported=(aligned[:,ys,xs,3]>180).all(axis=0)&masks[:,ys,xs].any(axis=0)
        enclosed[ys[supported],xs[supported]]=True
    shape|=enclosed;missing=shape&~known
    reconstructed=np.zeros_like(missing)
    if not reference and cv2 is not None:
        # Repair only small outer-contour occlusions. Interior facial features
        # stay protected; all source languages must confirm original opacity.
        contour_rgb=output[...,:3].astype(np.int32)
        hi=contour_rgb.max(axis=2);lo=contour_rgb.min(axis=2)
        ink=(output[...,3]>180)&(hi<120)&(hi-lo<np.maximum(1,hi)*.3)
        parts=components(ink);hull_mask=np.zeros((size,size),np.uint8)
        if parts and parts[0][0]>=200:
            pts=np.int32([(x,y) for y,x in parts[0][1]])
            cv2.fillConvexPoly(hull_mask,cv2.convexHull(pts),1)
        edge_distance=cv2.distanceTransform(hull_mask,cv2.DIST_L2,5)
        candidate=(hull_mask>0)&(edge_distance<20)&~known
        occupied=(output[...,3]>8).astype(np.uint8)
        radius=max(8,round(size*.035))
        rounded=cv2.morphologyEx(occupied,cv2.MORPH_CLOSE,
                                 cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(radius*2+1,radius*2+1)))
        candidate|=(rounded>0)&~known
        opacity_support=(aligned[...,3]>180).sum(axis=0)>=max(1,int(np.ceil(len(raw)*.5)))
        candidate&=opacity_support&masks.any(axis=0)
        face=artwork_anchor(base)
        if face:
            rgb=base[...,:3].astype(np.int32);r,g,b=rgb[...,0],rgb[...,1],rgb[...,2]
            skin=(base[...,3]>220)&(r>215)&(g>195)&(b>175)&(r-b>=8)&(r-b<50)&(g-b>=3)
            skin_parts=components(skin);face_mask=np.zeros((size,size),np.uint8)
            if skin_parts:
                pts=np.int32([(x,y) for y,x in skin_parts[0][1]])
                cv2.fillConvexPoly(face_mask,cv2.convexHull(pts),1)
                candidate&=~dilate(face_mask>0,8)
        accepted_repair=np.zeros((size,size),np.uint8)
        for area,points,_ in components(candidate):
            if area>1500:continue
            for y,x in points:accepted_repair[y,x]=255
        if accepted_repair.any():
            visible=output[...,3]>180
            _,nearest=cv2.distanceTransformWithLabels((~visible).astype(np.uint8),cv2.DIST_L2,5,
                                                       labelType=cv2.DIST_LABEL_PIXEL)
            colours=np.zeros((int(nearest.max())+1,3),np.uint8)
            colours[nearest[visible]]=output[visible,:3]
            extended=colours[nearest]
            repaired_rgb=cv2.inpaint(extended,accepted_repair,3,cv2.INPAINT_NS)
            repaired_alpha=cv2.inpaint(output[...,3],accepted_repair,3,cv2.INPAINT_NS)
            selected=(accepted_repair>0)&(repaired_alpha>8)
            output[selected,:3]=repaired_rgb[selected];output[selected,3]=repaired_alpha[selected]
            provenance[selected]=254;shape[selected]=True;reconstructed[selected]=True
    # Only tiny, uniformly coloured gaps can receive an explicit approximate
    # flat fill. Larger gaps or gaps crossing a stroke remain scoped for repair.
    inferred = reconstructed.copy()
    missing&=~reconstructed
    for area, points, box in components(missing):
        if reference or area>25 and not all(enclosed[y,x] for y,x in points):
            continue
        local = np.zeros_like(missing)
        for yy,xx in points:local[yy,xx] = True
        ring = dilate(local, 1) & known
        values = output[ring]
        if len(values) >= 4 and values[:,:3].std(axis=0).max() < 5 and values[:,3].min() > 240:
            output[local] = np.median(values, axis=0).astype(np.uint8);provenance[local] = 254;inferred |= local
    occupied = output[...,3] > 0
    ys,xs = np.where(occupied)
    crop = [int(xs.min()),int(ys.min()),int(xs.max()+1),int(ys.max()+1)] if len(xs) else [0,0,1,1]
    # Reconstruction stays in the selected native Sprite frame. An auxiliary
    # contour must not trigger a resize of every original pixel.
    native_rect=sources[0]['atlasSpriteRect'];native_x=round(native_rect['x'])
    native_y=round(sources[0]['textureSize'][1]-native_rect['y']-native_rect['height'])
    native_w,native_h=sources[0]['effectiveOriginalSize']
    crop=[max(crop[0],native_x),max(crop[1],native_y),
          min(crop[2],native_x+native_w),min(crop[3],native_y+native_h)]
    x0,y0,x1,y1 = crop
    pending=missing&~inferred if not reference else np.zeros_like(missing)
    scopes = [{"bbox": [box[0],box[1],box[2]-box[0],box[3]-box[1]], "pixels": area,
               "reason": "native donor unavailable or caption/registration ambiguity; needs local manual or generative repair"}
              for area, points, box in components(pending)]
    caption_removed = (base[...,3] > 8) & ~shape
    info = {"primaryLanguage": sources[0]["language"], "sources": sources,
            "registration": dict(zip((s["language"] for s in sources), registrations)),
            "ocrEvidence": dict(zip((s["language"] for s in sources), ocr)),
            "captionColourEvidence":dict(zip((s["language"] for s in sources),colour_evidence)),
            "captionMaskStrategy": "native-family spatial consensus plus auxiliary local OCR",
            "captionDetected":caption_detected,"identityTransform":False,
            "languageWeights":{s['language']:1 for s in sources},
            "structuralCaptionEvidence":dict(zip((s['language'] for s in sources),(e for _,e in structures))),
            "nativeArtworkSupport":dict(zip((s['language'] for s in sources),art_support)),
            "captionProtectionConflictPixels":protection_conflicts,
            "restoredEnclosedPrimaryPixels":int(restored_internal.sum()),
            "locallySupportedReplacementPixels":replacement_pixels,
            "restoredCleanPairPixels":restored_clean,
            "removedCleanPairBackgroundPixels":removed_clean_background,
            "removedDetachedCaptionBorderPixels":removed_border_pixels,
            "cropRect": {"x":x0,"y":y0,"width":x1-x0,"height":y1-y0},
            "nativeDonorPixels": int(known.sum()), "approximateFlatFillPixels": int(inferred.sum()),
            "nativeDonorCounts":{s["language"]:int((provenance==i+1).sum()) for i,s in enumerate(sources)},
            "captionRemovedPixels":int(caption_removed.sum()),
            "unresolvedNativeDetailPixels": int(pending.sum()),
            "referenceCoveredNativeDetailPixels":reference_covered,
            "unresolvedNativeDetailPercent":round(100*int(pending.sum())/max(1,int(shape.sum())),4),
            "approximateFlatFillScopes":[{"bbox":[box[0],box[1],box[2]-box[0],box[3]-box[1]],"pixels":area}
                                         for area,points,box in components(inferred)],
            "manualRepairScopes": scopes,
            "repairScopeCoordinateSpace":"primary-native-texture-pixels",
            "provenanceLegend": {"0":"transparent or unresolved", "254":"approximate flat fill",
                                 **{str(i+1):s["language"] for i,s in enumerate(sources)}}}
    if reference:
        info.update(cleanReferenceSha256=reference['sha256'],cleanReferenceRegistration=reference_reg,
                    cleanReferenceSize=list(Image.open(reference['path']).size))
        info['provenanceLegend']['255']='clean reference reconstruction; reference resolution applies'
    return output[y0:y1,x0:x1], provenance[y0:y1,x0:x1], pending[y0:y1,x0:x1], info


def build_catalog_record(record: dict, outdir: Path, language: str | None = None,
                         require_calibration_cache: bool = False) -> dict:
    variants = record["variants"]
    if language:
        primary = next(s for s in variants if s["language"] == language)
        variants = [primary]+[s for s in variants if s != primary]
    else:
        primary,base_metrics=select_native_base(variants)
        variants=[primary]+[s for s in variants if s!=primary]
    immutable_inputs = {"language":primary["language"],"category":record["category"],
                        "sources":sorted([{k:s[k] for k in ["language","sha256","spriteSha256","atlasSpriteRect"]}
                                          for s in variants],key=lambda s:s["language"])}
    if record.get('cleanReference'):
        immutable_inputs['cleanReferenceSha256']=record['cleanReference']['sha256']
    algorithm = {"producerSha256":digest(Path(__file__)),"toolchain":toolchain_fingerprint()}
    revision = hashlib.sha256(json.dumps(algorithm,sort_keys=True).encode()).hexdigest()[:12]
    recipe = {"stampId":record["stampId"],"algorithmVersion":"native-mask-fusion-v2-"+revision,
              **algorithm,**immutable_inputs}
    source_hash = hashlib.sha256(json.dumps(immutable_inputs,sort_keys=True).encode()).hexdigest()
    folder = outdir/"objects"/str(record["stampId"])/primary["language"]/recipe["algorithmVersion"]/source_hash
    folder.mkdir(parents=True,exist_ok=True);qa = outdir/"quality"/str(record["stampId"])/source_hash;qa.mkdir(parents=True,exist_ok=True)
    manifest_path = outdir/"records"/(str(record["stampId"])+"."+primary["language"]+".json")
    manifest_path.parent.mkdir(exist_ok=True)
    cached = None
    if manifest_path.is_file():
        previous = json.loads(manifest_path.read_text())
        old_sources = {s["language"]:s["spriteSha256"] for s in previous.get("sources",[])}
        new_sources = {s["language"]:s["spriteSha256"] for s in variants}
        if (old_sources == new_sources and previous.get("primaryLanguage") == primary["language"]
                and all(s['language'] in previous.get('ocrEvidence',{})
                        and s['language'] in previous.get('registration',{}) for s in variants)):
            cached = previous
    image,provenance,missing,info = fuse_native_family(
        {**record,"variants":variants,"primaryLanguage":primary["language"],
         'requireCalibrationCache':require_calibration_cache},qa,cached)
    info.setdefault('quality','review-required');info.setdefault('hasArtwork',True)
    info.setdefault('emptyAfterTextRemoval',False)
    processing_size = [image.shape[1],image.shape[0]]
    fit = min(1,primary["effectiveOriginalSize"][0]/image.shape[1],
              primary["effectiveOriginalSize"][1]/image.shape[0])
    if fit < 1:
        dimensions = (max(1,int(image.shape[1]*fit)),max(1,int(image.shape[0]*fit)))
        image = resize(image,dimensions)
        provenance = np.asarray(Image.fromarray(provenance).resize(dimensions,Image.Resampling.NEAREST))
        missing = np.asarray(Image.fromarray(missing).resize(dimensions,Image.Resampling.NEAREST))
    crop = info.get("cropRect",{"x":0,"y":0})
    for scope in info.get("manualRepairScopes",[])+info.get("approximateFlatFillScopes",[]):
        x,y,w,h=scope["bbox"]
        left=max(0,int((x-crop["x"])*fit));top=max(0,int((y-crop["y"])*fit))
        right=min(image.shape[1],int(np.ceil((x+w-crop["x"])*fit)))
        bottom=min(image.shape[0],int(np.ceil((y+h-crop["y"])*fit)))
        scope["imageBBox"]=[left,top,max(0,right-left),max(0,bottom-top)]
    image_path = folder/"image.png"
    if image_path.exists():
        if not np.array_equal(rgba(image_path),image):
            raise ValueError("immutable recipe produced different pixels; update its algorithm version")
    else:
        if np.array_equal(image,rgba(Path(primary['spritePath']))):
            shutil.copyfile(primary['spritePath'],image_path)
        else:
            save(image_path,image)
    save(qa/"provenance.png",provenance);save(qa/"unresolved.png",mask_image(missing))
    contact(qa/"contact.png",[("PRIMARY ORIGINAL",sprite_canvas(primary)),("CANDIDATE",image),
                             ("UNRESOLVED",mask_image(missing))])
    result = {"id":record["id"],"stampId":record["stampId"],"language":primary["language"],
              "category":"artwork" if info['hasArtwork'] else "text-only",
              "sourceCategory":record['category'],
              "algorithmVersion":recipe["algorithmVersion"],"sourceHash":source_hash,
              "recipe":recipe,"sources":variants,"primaryLanguage":primary["language"],
              "publishable":False,"sourceType":"reconstructed","effectiveOriginalSize":primary["effectiveOriginalSize"],
              "processingSize":processing_size,"processingToSourceScale":fit,
              "countMetricCoordinateSpace":"primary-native-texture-pixels",
              "effectiveSourceSize":[image.shape[1],image.shape[0]],"spriteRect":primary["spriteRect"],
              "atlasSpriteRect":primary["atlasSpriteRect"],"sourceTextureSize":primary["textureSize"],
              "exportPolicy":{"allowUpscale":False,"maxWidth":image.shape[1],"maxHeight":image.shape[0],"preserveAspectRatio":True},
              "artifacts":{"sourceImage":{"path":str(image_path.resolve()),"sha256":digest(image_path)},
                           "exportCandidate":{"path":str(image_path.resolve()),"sha256":digest(image_path)}},
              "qualityArtifacts":{"contact":str((qa/"contact.png").resolve()),"provenance":str((qa/"provenance.png").resolve()),
                                  "unresolvedDetailMask":str((qa/"unresolved.png").resolve())},
              "limitations":["Native registered donor pixels and explicitly marked approximate fills are distinguished.",
                           "Fine detail hidden in every donor requires local repair within the supplied mask."],**info}
    result['languageWeights']={s['language']:1 for s in variants}
    if not language:result['baseSelectionMetrics']=base_metrics
    manifest_path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n")
    return result


def save(path: Path, a: np.ndarray):
    Image.fromarray(a).save(path)


def contact(path: Path, cells: list[tuple[str, np.ndarray]]):
    width, bar = 256, 28
    sheet = Image.new("RGB", (width*4, (width+bar)*((len(cells)+3)//4)), "#262626")
    draw = ImageDraw.Draw(sheet)
    for i, (name, a) in enumerate(cells):
        x, y = (i%4)*width, (i//4)*(width+bar)
        draw.text((x+6, y+6), name, fill="white")
        bg = Image.new("RGBA", (width, width), "#bbbbbb")
        d = ImageDraw.Draw(bg)
        for yy in range(0, width, 16):
            for xx in range(0, width, 16):
                if (xx//16+yy//16)%2:
                    d.rectangle((xx, yy, xx+15, yy+15), fill="#eeeeee")
        bg.alpha_composite(Image.fromarray(resize(a, (width, width))))
        sheet.paste(bg.convert("RGB"), (x, y+bar))
    sheet.save(path)


def mask_image(mask: np.ndarray, colour=(255, 100, 0)) -> np.ndarray:
    out = np.zeros((*mask.shape, 4), np.uint8)
    out[mask] = (*colour, 255)
    return out


def build(stamp: str, files: dict[str, Path], reference: dict | None,
          outdir: Path, export_size: int) -> dict:
    source = [{"language": lang, "path": str(path.resolve()), "sha256": digest(path)}
              for lang, path in files.items()]
    record = {"id": stamp, "sources": source, "publishable": False,
              "sourceType": "unreliable",
              "quality": "needs-reference", "artifacts": {}}
    if reference and reference.get("kind") == "native-sprite":
        # An explicit reviewed Sprite mapping preserves the original rendered
        # silhouette. Texture padding must never be inferred to be artwork.
        sprite = Path(reference["path"])
        if digest(sprite) != reference["sha256"]:
            raise ValueError(f"{stamp}: native Sprite identity changed")
        image = rgba(sprite)
        outdir.mkdir(parents=True, exist_ok=True)
        original = outdir/f"{stamp}.native-sprite.png"
        shutil.copyfile(sprite, original)
        record.update({"sourceType": "native", "quality": "native-textless",
                       "reference": reference,
                       "nativeSize": [image.shape[1], image.shape[0]],
                       "canvasSize": [image.shape[1],image.shape[0]],
                       "exportSize": [image.shape[1],image.shape[0]],
                       "effectiveSourceSize": [image.shape[1],image.shape[0]],
                       "exportPolicy":{"allowUpscale":False,"maxWidth":image.shape[1],"maxHeight":image.shape[0]},
                       "unresolvedNativeDetailPercent": 0,
                       "limitations": ["Native Sprite silhouette and background colours are preserved.",
                                       "Export upscaling adds pixels, not original linework information."],
                       "artifacts": {key: {"path": str(path.resolve()), "sha256": digest(path)}
                                     for key, path in {"nativeOriginal": original,
                                                       "sourceImage": original,
                                                       "exportCandidate": original}.items()}})
        (outdir/f"{stamp}.json").write_text(json.dumps(record, indent=2, ensure_ascii=False)+"\n")
        return record
    if len(files) < 3:
        record["quality"] = "insufficient-native-variants"
        record["reason"] = "At least three native variants are required for donor fusion."
        return record
    if reference is None:
        record["reason"] = "Shared text and hidden linework require a verified clean reference."
        return record
    refpath = Path(reference["path"])
    clean = rgba(refpath)
    record["reference"] = {**reference, "sha256": digest(refpath),
                           "nativeSize": [clean.shape[1], clean.shape[0]]}
    raws = [rgba(path) for path in files.values()]
    shapes = {a.shape for a in raws}
    if len(shapes) != 1 or raws[0].shape[0] != raws[0].shape[1]:
        raise ValueError(f"{stamp}: native canvases must have identical square dimensions")
    size = raws[0].shape[1]
    target = reference_canvas(clean, size)
    arr, regs = [], []
    for a in raws:
        aligned, reg = register(a, target)
        arr.append(aligned); regs.append(reg)
    arr = np.stack(arr)
    ref = premultiplied(target)
    smooth_ref = mean3(mean3(ref))
    error, clean_masks = [], []
    for aligned, reg in zip(arr, regs):
        pixels = premultiplied(aligned)
        lowfreq = mean3(mean3(pixels))
        diff = np.abs(lowfreq-smooth_ref).max(axis=2)
        highdiff = np.abs(pixels-ref).max(axis=2)
        bad = (diff > 0.085) | (highdiff > 0.3)
        bad = dilate(bad, 2)
        clean_masks.append(~bad & reg["accepted"])
        error.append(diff)
    clean_masks, error = np.stack(clean_masks), np.stack(error)
    # Reference support is required even when all five languages agree: that
    # agreement can be the same caption outline. RGB is copied from one donor.
    score = np.where(clean_masks, error, np.inf)
    donor = np.argmin(score, axis=0)
    valid = np.isfinite(np.min(score, axis=0)) & (target[..., 3] > 8)
    native = np.zeros_like(target)
    for i in range(len(arr)):
        selected = valid & (donor == i)
        native[selected] = arr[i][selected]
    # Keep the clean silhouette exactly: native caption alpha must not extend it.
    native[..., 3] = np.minimum(native[..., 3], target[..., 3])
    missing = (target[..., 3] > 8) & ~valid
    hybrid = target.copy()
    hybrid[valid] = native[valid]
    hybrid[..., 3] = target[..., 3]
    provenance = np.zeros((size, size), np.uint8)
    provenance[target[..., 3] > 0] = 255  # low-resolution reference donor
    provenance[valid] = donor[valid]+1
    outdir.mkdir(parents=True, exist_ok=True)
    paths = {
        "nativePartial": outdir/f"{stamp}.native-partial.png",
        "hybridCandidate": outdir/f"{stamp}.hybrid-candidate.png",
        "exportCandidate": outdir/f"{stamp}.hybrid-candidate.png",
        "unresolvedDetailMask": outdir/f"{stamp}.unresolved-detail.png",
        "provenance": outdir/f"{stamp}.provenance.png",
        "contact": outdir/f"{stamp}.contact.png",
    }
    save(paths["nativePartial"], native)
    save(paths["hybridCandidate"], hybrid)
    save(paths["unresolvedDetailMask"], mask_image(missing))
    save(paths["provenance"], provenance)
    cells = [(lang, a) for lang, a in zip(files, arr)]
    cells.extend([("REFERENCE 128px source", target), ("NATIVE partial", native),
                  ("UNRESOLVED native detail", mask_image(missing)),
                  ("HYBRID candidate", hybrid)])
    contact(paths["contact"], cells)
    occupied = target[..., 3] > 8
    lowfreq_diff = np.abs(mean3(mean3(premultiplied(hybrid)))-smooth_ref)
    record.update({
        "quality": "review-required", "sourceType": "reconstructed", "canvasSize": [size, size],
        "exportSize": [size, size],
        "registration": dict(zip(files, regs)),
        "nativeDonorPixels": int(valid.sum()),
        "unresolvedNativeDetailPixels": int(missing.sum()),
        "unresolvedNativeDetailPercent": round(100*float(missing.sum())/max(1,int(occupied.sum())),4),
        "silhouetteIoU": float(((hybrid[..., 3] > 8) & occupied).sum()
                               / max(1, ((hybrid[..., 3] > 8) | occupied).sum())),
        "hybridLowFrequencyMAE": float(lowfreq_diff[occupied].mean()),
        "nativeDonorCounts": {lang: int((valid & (donor == i)).sum())
                              for i, lang in enumerate(files)},
        "provenanceLegend": {"0": "transparent background", "255": "low-resolution reference",
                             **{str(i+1): lang for i, lang in enumerate(files)}},
        "artifacts": {k: {"path": str(p.resolve()), "sha256": digest(p)} for k,p in paths.items()},
        "limitations": ["Reference-covered detail retains reference resolution.",
                        "Donor classification is heuristic; human review checks readable residue and seams.",
                        "Export upscaling adds pixels, not original linework information."],
    })
    (outdir/f"{stamp}.json").write_text(json.dumps(record, indent=2, ensure_ascii=False)+"\n")
    return record


def main() -> int:
    global _DETECTOR_MODEL,_TOOLCHAIN
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--input", type=Path)
    p.add_argument('--server',choices=['intl','intl-cbt'],help='International source release; Japanese releases are not reconstructed.')
    p.add_argument('--text-detector-model',type=Path,help='CPU PP-OCRv3 DB region detector ONNX; no text recognition.')
    p.add_argument('--text-detector-sha256',help='Required immutable model identity in CI.')
    p.add_argument("--references", type=Path)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--stamp", action="append")
    p.add_argument("--export-size", type=int, help="Deprecated: download dimensions belong to the browser.")
    p.add_argument("--catalog", type=Path, help="Released stamp entity shards or one catalog JSON.")
    p.add_argument("--build-root", type=Path, help="Existing single build; metadata and Sprite headers only.")
    p.add_argument("--assets-root", type=Path, help="Existing release assets root.")
    p.add_argument("--catalog-index", type=Path, help="Previously saved complete production inventory.")
    p.add_argument("--inventory-only", action="store_true")
    p.add_argument("--language", help="Primary source language; preserves arbitrary input language keys.")
    p.add_argument("--legacy-reference", action="store_true", help="Audit reproduction of the previous reference pipeline.")
    p.add_argument("--require-calibration-cache", action="store_true",
                   help="Reject artwork needing new native geometric calibration; auxiliary colour OCR remains bounded.")
    p.add_argument("--reuse-existing", action="store_true",
                   help="Reuse matching completed records in the same output directory.")
    args = p.parse_args()
    if args.text_detector_model:
        if cv2 is None:p.error('install scripts/build/requirements-textless-stamps.txt')
        if not args.text_detector_model.is_file():p.error('text detector model not found')
        if args.text_detector_sha256 and digest(args.text_detector_model)!=args.text_detector_sha256:
            p.error('text detector model hash mismatch')
        _DETECTOR_MODEL=str(args.text_detector_model.resolve());_TOOLCHAIN=None
    if args.export_size is not None:
        p.error("store one effective source image; generate download sizes in the browser")
    if args.catalog_index or args.catalog:
        if not args.inventory_only and (cv2 is None or not _DETECTOR_MODEL
                or not Path(_DETECTOR_MODEL).is_file()):
            p.error('catalog production requires OpenCV and the pinned CPU text-region detector')
        if args.catalog_index:
            inventory = json.loads(args.catalog_index.read_text())
        else:
            if not args.build_root or not args.assets_root:
                p.error("catalog inventory requires --build-root and --assets-root")
            inventory = catalog_inventory(args.catalog,args.build_root,args.assets_root,args.server or 'intl')
        if inventory.get('server') not in ('intl','intl-cbt'):
            p.error('stamp reconstruction sources must be intl or intl-cbt')
        if args.server and args.server!=inventory['server']:p.error('source server does not match catalog inventory')
        for root in [inventory.get("buildRoot"),inventory.get("assetsRoot")]:
            if root and args.output.resolve().is_relative_to(Path(root).resolve()):
                p.error("production output must be outside the preserved source/build directories")
        args.output.mkdir(parents=True,exist_ok=True)
        if args.inventory_only:
            (args.output/"inventory.json").write_text(json.dumps(inventory,ensure_ascii=False,indent=2)+"\n")
            print(json.dumps(inventory["summary"]));return 0
        selected = [r for r in inventory["records"] if not args.stamp
                    or r["id"] in args.stamp or r["stampId"] in args.stamp]
        if args.references:
            refs=json.loads(args.references.read_text())
            selected=[{**r,'cleanReference':{**refs[r['id']],
                       'sha256':digest(Path(refs[r['id']]['path']))}}
                      if refs.get(r['id']) else r for r in selected]
        if args.stamp and len(selected) != len(set(args.stamp)):
            p.error("unknown or duplicate catalog stamp selection")
        records = []
        existing_records={}
        existing_manifest=args.output/'manifest.json'
        if args.stamp and existing_manifest.is_file():
            old=json.loads(existing_manifest.read_text())
            if old.get('server')==inventory['server'] and old.get('sourceIdentity')==inventory.get('sourceIdentity'):
                existing_records={r['stampId']:r for r in old.get('records',[])}
        for row in selected:
            record = build_catalog_record(row,args.output,args.language,args.require_calibration_cache);records.append(record)
            existing_records[record['stampId']]=record
            print(json.dumps({k:record[k] for k in ["id","stampId","category","quality","effectiveSourceSize"]}),flush=True)
            temporary=args.output/"manifest.json.tmp"
            temporary.write_text(json.dumps({"schema":SCHEMA,"server":inventory["server"],
                                             "sourceIdentity":inventory.get("sourceIdentity"),
                                             "records":sorted(existing_records.values(),key=lambda r:int(r['stampId']))},ensure_ascii=False,indent=2)+"\n")
            temporary.replace(args.output/"manifest.json")
        return 0
    if not args.legacy_reference:
        p.error("provide --catalog-index or --catalog for complete native/multilingual production")
    if not args.input or not args.references:
        p.error("legacy audit requires --input and --references")
    args.export_size = 512
    if not args.input.is_dir():
        p.error("input directory does not exist")
    if args.output.resolve().is_relative_to(args.input.resolve()):
        p.error("output must be outside the source asset directory")
    groups = discover(args.input)
    refs = json.loads(args.references.read_text())
    stamps = args.stamp or sorted(groups)
    for stamp in stamps:
        if stamp not in groups:
            p.error(f"unknown stamp: {stamp}")
    args.output.mkdir(parents=True, exist_ok=True)
    records = []
    def write_manifest():
        manifest = {"schema": SCHEMA, "server": "intl",
                    "pipeline": "reference-constrained-native-donors",
                    "input": str(args.input.resolve()), "inputGroupCount": len(groups),
                    "referenceMapSha256": digest(args.references), "records": records}
        temporary = args.output/"manifest.json.tmp"
        temporary.write_text(json.dumps(manifest, indent=2, ensure_ascii=False)+"\n")
        temporary.replace(args.output/"manifest.json")
    for stamp in stamps:
        print(f"Building {stamp}", flush=True)
        existing = args.output/f"{stamp}.json"
        record = None
        if args.reuse_existing and existing.is_file():
            cached = json.loads(existing.read_text())
            ref = refs.get(stamp)
            source_match = cached["sources"] == [
                {"language": lang, "path": str(path.resolve()), "sha256": digest(path)}
                for lang, path in groups[stamp].items()]
            ref_match = ref and cached.get("reference", {}).get("sha256") == digest(Path(ref["path"]))
            if (source_match and ref_match and cached.get("exportSize") == [args.export_size]*2
                    and all(Path(asset["path"]).is_file() for asset in cached["artifacts"].values())):
                record = cached
                record.setdefault("sourceType", "native" if ref.get("kind") == "native-sprite" else "reconstructed")
                print(f"Reusing completed {stamp}", flush=True)
        if record is None:
            record = build(stamp, groups[stamp], refs.get(stamp), args.output, args.export_size)
        records.append(record)
        write_manifest()
        print(json.dumps({k:record[k] for k in ["id", "quality", "publishable"]}
                         | {"unresolvedNativeDetailPercent": record.get("unresolvedNativeDetailPercent")}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
