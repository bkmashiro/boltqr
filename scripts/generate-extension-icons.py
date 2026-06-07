from pathlib import Path
import zlib, struct


REPO_ROOT = Path(__file__).resolve().parents[1]


def _crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', _crc32(tag + data))


def _write_png(size: int, out_path: Path) -> None:
    width = height = size
    bg = (30, 41, 59)  # slate-800
    accent = (250, 204, 21)  # amber-400
    white = (255, 255, 255)

    pixels = bytearray(width * height * 4)
    for y in range(height):
        for x in range(width):
            idx = (y * width + x) * 4
            pixels[idx : idx + 4] = [*bg, 255]

    border = max(1, size // 16)
    for y in range(height):
        for x in range(width):
            if x < border or y < border or x >= width - border or y >= height - border:
                idx = (y * width + x) * 4
                pixels[idx : idx + 4] = [*accent, 255]

    pad = max(2, size // 9)
    inner_x0, inner_y0 = pad, pad
    inner_x1, inner_y1 = width - pad - 1, height - pad - 1
    for y in range(inner_y0, inner_y1 + 1):
        for x in range(inner_x0, inner_x1 + 1):
            idx = (y * width + x) * 4
            # Slight tint to mimic a QR-like code block
            t = 0.06 * (x - inner_x0) / max(1, inner_x1 - inner_x0)
            color = (220, 225, 241)
            pixels[idx : idx + 4] = [*color, 255]

    finder_size = max(4, size // 6)
    positions = [
        (inner_x0 + 1, inner_y0 + 1),
        (inner_x1 - finder_size + 1, inner_y0 + 1),
        (inner_x0 + 1, inner_y1 - finder_size + 1),
    ]

    def fill_rect(x0: int, y0: int, bw: int, bh: int, rgba) -> None:
        for yy in range(y0, y0 + bh):
            for xx in range(x0, x0 + bw):
                if 0 <= xx < width and 0 <= yy < height:
                    idx = (yy * width + xx) * 4
                    pixels[idx : idx + 4] = [*rgba, 255]

    for fx, fy in positions:
        fill_rect(fx, fy, finder_size, finder_size, (0, 0, 0))
        ring = max(1, finder_size // 4)
        fill_rect(fx + ring, fy + ring, finder_size - 2 * ring, finder_size - 2 * ring, white)
        core = max(1, finder_size // 6)
        fill_rect(fx + finder_size // 2 - core // 2, fy + finder_size // 2 - core // 2, core, core, (0, 0, 0))

    # Add a centered lightning bolt. Coordinates are normalized from the SVG source.
    bolt = [
        (0.50 * width, 0.22 * height),
        (0.63 * width, 0.44 * height),
        (0.54 * width, 0.44 * height),
        (0.57 * width, 0.70 * height),
        (0.43 * width, 0.49 * height),
        (0.55 * width, 0.49 * height),
    ]

    def point_in_poly(px: float, py: float, poly) -> bool:
        inside = False
        j = len(poly) - 1
        for i in range(len(poly)):
            xi, yi = poly[i]
            xj, yj = poly[j]
            if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / max(1e-6, yj - yi) + xi):
                inside = not inside
            j = i
        return inside

    for y in range(height):
        for x in range(width):
            if point_in_poly(x + 0.5, y + 0.5, bolt):
                idx = (y * width + x) * 4
                pixels[idx : idx + 4] = [*accent, 255]

    raw_rows = bytearray()
    row_size = width * 4
    for y in range(height):
        start = y * row_size
        end = start + row_size
        raw_rows.append(0)
        raw_rows.extend(pixels[start:end])

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw_rows), level=9)

    with open(out_path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(_png_chunk(b'IHDR', ihdr))
        f.write(_png_chunk(b'IDAT', idat))
        f.write(_png_chunk(b'IEND', b''))


def main() -> None:
    out_dir = REPO_ROOT / 'extension' / 'assets' / 'icons'
    out_dir.mkdir(parents=True, exist_ok=True)
    for s in (16, 32, 48, 128):
        path = out_dir / f'icon-{s}.png'
        _write_png(s, path)
        print(f'generated {path}')


if __name__ == '__main__':
    main()
