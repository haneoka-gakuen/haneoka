"""Shared post-processing for transparent model-preview PNGs.

Both Cubism and Spine render a complete static model on a transparent canvas.
Leaving their fixed renderer viewport around that model makes every output a
square and forces catalogue tiles to show a tiny full-body figure.  Crop only
the transparent margin so the resulting asset retains the model's natural
portrait/landscape aspect ratio; the web client can then use a predictable
square cover crop (top for portraits, centre for landscapes).
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

from PIL import Image, UnidentifiedImageError


ALPHA_CROP_SCHEMA = "alpha-bounds-v1"
_PADDING_RATIO = 0.025
_MIN_PADDING_PIXELS = 2


@dataclass(frozen=True)
class TransparentPngCrop:
    """A normalized preview image plus its public dimensions."""

    png: bytes
    width: int
    height: int
    visible_pixel_count: int


def crop_transparent_png(payload: bytes) -> TransparentPngCrop:
    """Crop transparent canvas margins from a PNG without inventing pixels.

    The bounds are alpha-based rather than colour-based, so white outfits and
    nearly transparent antialiasing remain intact.  A small proportional
    margin keeps hair, hands, and soft edge pixels from touching a catalogue
    tile's boundary.  Empty renders are rejected instead of being recorded as
    successful model previews.
    """

    try:
        with Image.open(BytesIO(payload)) as source:
            if source.format != "PNG":
                raise ValueError("model preview renderer did not return a PNG")
            source.load()
            image = source.convert("RGBA")
    except (OSError, UnidentifiedImageError) as error:
        raise ValueError("model preview renderer returned an unreadable PNG") from error

    width, height = image.size
    if width <= 0 or height <= 0:
        raise ValueError("model preview renderer returned an empty image")
    alpha = image.getchannel("A")
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("model preview renderer returned no visible pixels")

    left, top, right, bottom = bounds
    padding = max(_MIN_PADDING_PIXELS, round(max(right - left, bottom - top) * _PADDING_RATIO))
    crop_box = (
        max(0, left - padding),
        max(0, top - padding),
        min(width, right + padding),
        min(height, bottom + padding),
    )
    cropped = image.crop(crop_box)
    output = BytesIO()
    cropped.save(output, format="PNG", optimize=True)
    visible_pixel_count = sum(1 for value in alpha.get_flattened_data() if value)
    return TransparentPngCrop(
        png=output.getvalue(),
        width=cropped.width,
        height=cropped.height,
        visible_pixel_count=visible_pixel_count,
    )
