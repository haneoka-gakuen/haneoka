"""Bound image allocation before entering the OpenCV kernel."""
import argparse, json, warnings
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS = 8_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)
if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--image', required=True); p.add_argument('--mime', required=True); a = p.parse_args()
    with Image.open(a.image) as image:
        expected = {'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WEBP'}
        if image.format != expected.get(a.mime) or getattr(image, 'n_frames', 1) != 1:
            raise ValueError('image_format')
        w, h = image.size
        if not 128 <= min(w, h) or max(w, h) > 4096 or w*h > 8_000_000:
            raise ValueError('image_dimensions')
        if image.getexif().get(274, 1) in (5, 6, 7, 8): w, h = h, w
    # PNG getexif() can consume its decoder state; verify with a fresh reader.
    with Image.open(a.image) as image:
        image.verify()
    print(json.dumps({'width':w,'height':h}))
