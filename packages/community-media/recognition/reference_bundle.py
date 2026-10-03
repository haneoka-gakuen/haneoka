"""Validate a trusted reference ZIP before atomic installation; never accept user paths."""
import argparse, hashlib, json, re, stat, zipfile
from pathlib import Path, PurePosixPath
from PIL import Image
Image.MAX_IMAGE_PIXELS = 1024 * 1024
MAX_BYTES = 128 * 1024 * 1024

def validate_archive(archive, directory, reference_id):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(archive) as bundle:
        infos = bundle.infolist()
        if len(infos) > 4096 or sum(i.file_size for i in infos) > MAX_BYTES:
            raise ValueError('reference_budget')
        names = set()
        for entry in infos:
            path = PurePosixPath(entry.filename)
            if (entry.is_dir() or entry.filename in names or '\\' in entry.filename or
                path.is_absolute() or any(p in ('..', '.') for p in path.parts) or
                str(path) != entry.filename or len(entry.filename) > 240 or
                stat.S_ISLNK(entry.external_attr >> 16) or entry.flag_bits & 1 or
                entry.file_size < 1 or entry.file_size > 2 * 1024 * 1024):
                raise ValueError('reference_path')
            names.add(entry.filename)
        if 'index.json' not in names or bundle.getinfo('index.json').file_size > 4 * 1024 * 1024:
            raise ValueError('reference_manifest')
        manifest = json.loads(bundle.read('index.json'))
        if manifest.get('schema') != 'haneoka-card-recognition-index-v1':
            raise ValueError('reference_schema')
        context = manifest.get('identity', {})
        for key in ('server', 'releaseId', 'sourceId'):
            value = context.get(key)
            if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,159}', value):
                raise ValueError('reference_identity')
        cards = manifest.get('references')
        reader = manifest.get('levelReader')
        if not isinstance(cards, list) or not 1 <= len(cards) <= 2048:
            raise ValueError('reference_card_budget')
        expected = {'index.json'}
        entities = set()
        for row in cards:
            if row.get('kind') not in ('members', 'snapshots') or type(row.get('cardId')) is not int or not 1 <= row['cardId'] <= 2147483647:
                raise ValueError('reference_card_identity')
            variant = row.get('variant', 'thumbnail')
            if not isinstance(variant, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', variant):
                raise ValueError('reference_variant')
            identity = (row['kind'], row['cardId'], variant, row.get('sha256'))
            if identity in entities: raise ValueError('reference_duplicate')
            entities.add(identity)
        if reader is not None:
            if not isinstance(reader, dict) or not re.fullmatch('[0-9a-f]{64}', str(reader.get('atlasSha256', ''))):
                raise ValueError('reference_glyph_identity')
            glyphs = reader.get('glyphs', {})
            if not isinstance(glyphs, dict) or not set('0123456789Lv') <= glyphs.keys() or len(glyphs) > 13:
                raise ValueError('reference_glyph_incomplete')
            for character, rows in glyphs.items():
                if character not in '0123456789Lv.' or len(character) != 1 or not isinstance(rows, list) or not 1 <= len(rows) <= 128:
                    raise ValueError('reference_glyph')
                if not all(isinstance(r,str) and 1<=len(r)<=128 and set(r)<=set('01') for r in rows) or len(set(map(len,rows))) != 1:
                    raise ValueError('reference_glyph')
            for kind in ('members', 'snapshots'):
                levels = reader.get('allowedLevels', {}).get(kind, [])
                if not isinstance(levels,list) or not 1<=len(levels)<=1000 or any(type(v) is not int or not 1<=v<=999 for v in levels):
                    raise ValueError('reference_levels')
        for row in cards:
            name, sha = row.get('path'), row.get('sha256')
            if name not in names or name == 'index.json' or not isinstance(sha, str) or not re.fullmatch('[0-9a-f]{64}', sha):
                raise ValueError('reference_file')
            expected.add(name)
            data = bundle.read(name)
            if hashlib.sha256(data).hexdigest() != sha: raise ValueError('reference_checksum')
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            with Image.open(target) as image:
                if image.format not in ('PNG', 'JPEG', 'WEBP') or getattr(image, 'n_frames', 1) != 1 or max(image.size) > 1024:
                    raise ValueError('reference_image')
                image.verify()
        if expected != names: raise ValueError('reference_unlisted_file')
        (directory / 'index.json').write_text(json.dumps(manifest, ensure_ascii=False))
        installed = {'referenceId':reference_id,'bytes':sum(i.file_size for i in infos),'context':context}
        (directory / '.installed.json').write_text(json.dumps(installed))
        return installed

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--reference-id', required=True)
    args = parser.parse_args()
    print(json.dumps(validate_archive(args.archive, args.directory, args.reference_id)))
