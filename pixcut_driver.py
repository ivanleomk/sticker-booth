#!/usr/bin/env python3
"""Direct Liene PixCut S1 (DHP700) print-and-cut driver using Sticker Foundry's validated pixcut stack."""

import argparse
import asyncio
import importlib.abc
import importlib.machinery
import json
import marshal
import signal
import struct
import sys
import threading
import time
import zlib
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFont

STICKER_FOUNDRY_BIN = "/Users/ileo/Applications/Sticker Foundry.app/Contents/MacOS/Sticker Foundry"
DEFAULT_BLE_ADDR = "9038DC73-4D80-E4C9-E45B-9D87EAF72ADC"
DEFAULT_SHEET_BG_PATH = Path(__file__).resolve().with_name("yc-sheet-bg.png")
VEXO_MARK_PATH = Path(__file__).resolve().with_name("vexo-mark.png")
PRINTER_MAC_CACHE_PATH = Path(__file__).resolve().parent / "output" / "printer-mac.json"

_rfcomm_failed_this_process = False
_rfcomm_ever_connected = False


def _install_pixcut_pyz_loader() -> None:
    if any(isinstance(f, _PixcutPyzFinder) for f in sys.meta_path):
        return
    with open(STICKER_FOUNDRY_BIN, "rb") as f:
        data = f.read()
    pos = data.rfind(b"MEI\x0c\x0b\x0a\x0b\x0e")
    if pos == -1:
        raise RuntimeError(f"PyInstaller cookie not found in {STICKER_FOUNDRY_BIN}")
    _, pkg_len, toc_off, toc_len, _, _ = struct.unpack("!8siiii64s", data[pos : pos + 88])
    pkg_start = pos + 88 - pkg_len
    toc_pos = pkg_start + toc_off
    toc_end = toc_pos + toc_len
    pyz = b""
    pyz_toc: dict[str, tuple[int, int, int]] = {}
    while toc_pos < toc_end:
        elen, dpos, dlen, _ulen, _cflag, typcd = struct.unpack(
            "!iiiiBB", data[toc_pos : toc_pos + 18]
        )
        if typcd == ord("z"):
            pyz = data[pkg_start + dpos : pkg_start + dpos + dlen]
            (off,) = struct.unpack("!i", pyz[8:12])
            pyz_toc = dict(marshal.loads(pyz[off:]))
            break
        toc_pos += elen
    if not pyz_toc:
        raise RuntimeError(f"PYZ archive not found in {STICKER_FOUNDRY_BIN}")
    sys.meta_path.insert(0, _PixcutPyzFinder(pyz, pyz_toc))


class _PixcutPyzFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def __init__(self, pyz: bytes, pyz_toc: dict[str, tuple[int, int, int]]):
        self._pyz = pyz
        self._toc = pyz_toc

    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        if fullname.startswith("pixcut") and fullname in self._toc:
            ispkg, _, _ = self._toc[fullname]
            return importlib.machinery.ModuleSpec(fullname, self, is_package=bool(ispkg))
        return None

    def create_module(self, spec: Any) -> Any:
        return None

    def exec_module(self, module: Any) -> None:
        ispkg, mpos, mlen = self._toc[module.__name__]
        if ispkg:
            module.__path__ = [module.__name__]
        co = marshal.loads(zlib.decompress(self._pyz[mpos : mpos + mlen]))
        exec(co, module.__dict__)


_install_pixcut_pyz_loader()

import pixcut.artwork as artwork  # noqa: E402
import pixcut.client as client  # noqa: E402
import pixcut.geometry as geometry  # noqa: E402
import pixcut.render as render  # noqa: E402
import pixcut.rfcomm as rfcomm  # noqa: E402
import pixcut.states as states  # noqa: E402

# Fix Python 3.14 asyncio.wait_for cancellation interaction in PixCut._call:
# When wait_for times out (e.g. unanswered get-job-info), fut is cancelled (fut.done() == True).
# Returning False here ensures _call raises PixCutError("<method> timed out"), which PixCut.wait
# catches and ignores cleanly so it keeps polling get_props and catches PixCutAlert (e.g. 5306).
client.PixCut._salvage_incomplete = lambda self: False


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _load_cached_mac() -> tuple[str, str] | None:
    try:
        data = json.loads(PRINTER_MAC_CACHE_PATH.read_text(encoding="utf-8"))
        mac = str(data.get("mac") or "").strip()
        name = str(data.get("name") or "Liene PixCut S1").strip()
        if mac:
            return mac, name
    except Exception:
        pass
    return None


def _save_cached_mac(mac: str, name: str) -> None:
    try:
        PRINTER_MAC_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        PRINTER_MAC_CACHE_PATH.write_text(
            json.dumps(
                {
                    "mac": mac,
                    "name": name or "Liene PixCut S1",
                    "updatedAt": datetime.now(timezone.utc).isoformat(),
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception as exc:
        _log(f"Warning: failed to cache printer MAC: {exc}")


async def _disconnect_silently(pc: client.PixCut | None) -> None:
    if pc is None:
        return
    try:
        await asyncio.wait_for(pc.disconnect(), timeout=3.0)
    except Exception:
        pass


async def open_pixcut(
    transport: str = "auto", allow_rfcomm_discovery: bool = True
) -> tuple[client.PixCut, str, str, str]:
    global _rfcomm_failed_this_process, _rfcomm_ever_connected

    if transport in ("auto", "rfcomm") and (
        transport == "rfcomm" or not _rfcomm_failed_this_process
    ):
        mac = ""
        name = "Liene PixCut S1"
        try:
            paired = rfcomm.paired_printers()
        except Exception:
            paired = []
        if paired:
            mac, name = paired[0]
            _save_cached_mac(mac, name or "Liene PixCut S1")
        else:
            cached = _load_cached_mac()
            if cached:
                mac, name = cached
            elif allow_rfcomm_discovery:
                try:
                    _log("Discovering Classic Bluetooth MAC for RFCOMM...")
                    addrs = await client.discover_addresses(timeout=4.0)
                    if addrs:
                        first = addrs[0]
                        if isinstance(first, (tuple, list)):
                            mac = str(first[0])
                            name = str(first[1] or "Liene PixCut S1")
                        else:
                            mac = str(getattr(first, "address", "") or first)
                            name = str(getattr(first, "name", None) or "Liene PixCut S1")
                        if mac:
                            _save_cached_mac(mac, name)
                except Exception as disc_exc:
                    _log(f"Classic MAC discovery skipped ({disc_exc})")

        if mac:
            pc: client.PixCut | None = None
            try:
                pc = client.PixCut(mac, transport="rfcomm")
                await asyncio.wait_for(pc.connect(), timeout=12.0)
                _rfcomm_ever_connected = True
                _save_cached_mac(mac, name or "Liene PixCut S1")
                return pc, name or "Liene PixCut S1", mac, "rfcomm"
            except Exception as exc:
                await _disconnect_silently(pc)
                if transport == "rfcomm":
                    raise
                _log(f"RFCOMM connect failed ({exc}), falling back to BLE")
                if not _rfcomm_ever_connected:
                    _rfcomm_failed_this_process = True
        elif transport == "rfcomm":
            raise RuntimeError("No paired or discovered PixCut MAC found for RFCOMM transport.")

    pc_ble: client.PixCut | None = None
    try:
        pc_ble = client.PixCut(DEFAULT_BLE_ADDR, transport="ble")
        await asyncio.wait_for(pc_ble.connect(), timeout=12.0)
        return pc_ble, "Liene PixCut S1-29DC", DEFAULT_BLE_ADDR, "ble"
    except Exception as direct_exc:
        await _disconnect_silently(pc_ble)
        _log(f"Direct BLE UUID connect failed ({direct_exc}), scanning via BLE...")
        devs = await client.discover(timeout=5.0)
        if not devs:
            raise RuntimeError(
                "Liene PixCut S1 not found via BLE. Make sure it is powered on."
            ) from direct_exc
        dev = devs[0]
        pc_scan = client.PixCut(dev, transport="ble")
        try:
            await asyncio.wait_for(pc_scan.connect(), timeout=12.0)
        except Exception:
            await _disconnect_silently(pc_scan)
            raise
        name = getattr(dev, "name", None) or "Liene PixCut S1"
        addr = getattr(dev, "address", None) or str(dev)
        return pc_scan, name, addr, "ble"


async def recover_printer(pc: client.PixCut) -> tuple[dict[str, Any], list[int]]:
    jobs = await pc.job_id_list()
    for jid in jobs:
        _log(f"Cancelling latched job #{jid}...")
        await pc.cancel_job(jid)
        await asyncio.sleep(0.4)
    st = await pc.state()
    if str(st.get("printer-state")) == "60":
        _log("Printer in fault state 60; sending resume-printer...")
        await pc.resume_printer()
        await asyncio.sleep(0.8)
        st = await pc.state()
    return st, jobs


def _border_flood_fill(mask: np.ndarray) -> np.ndarray:
    h, w = mask.shape
    visited = np.zeros((h, w), dtype=bool)
    if h == 0 or w == 0:
        return visited
    q: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if mask[y, x] and not visited[y, x]:
                visited[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if mask[y, x] and not visited[y, x]:
                visited[y, x] = True
                q.append((y, x))
    while q:
        cy, cx = q.popleft()
        if cy > 0 and mask[cy - 1, cx] and not visited[cy - 1, cx]:
            visited[cy - 1, cx] = True
            q.append((cy - 1, cx))
        if cy + 1 < h and mask[cy + 1, cx] and not visited[cy + 1, cx]:
            visited[cy + 1, cx] = True
            q.append((cy + 1, cx))
        if cx > 0 and mask[cy, cx - 1] and not visited[cy, cx - 1]:
            visited[cy, cx - 1] = True
            q.append((cy, cx - 1))
        if cx + 1 < w and mask[cy, cx + 1] and not visited[cy, cx + 1]:
            visited[cy, cx + 1] = True
            q.append((cy, cx + 1))
    return visited


def _fill_interior_holes(mask: np.ndarray) -> np.ndarray:
    return ~_border_flood_fill(~mask)


def _strip_outer_white_bg(rgba: Image.Image) -> Image.Image:
    arr = np.array(rgba, dtype=np.uint8, copy=True)
    h, w, _ = arr.shape
    if h == 0 or w == 0:
        return rgba

    r = arr[:, :, 0].astype(np.int16)
    g = arr[:, :, 1].astype(np.int16)
    b = arr[:, :, 2].astype(np.int16)
    a = arr[:, :, 3].astype(np.int16)
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)

    # Match transparent pixels, pure white ground, or pale neutral-grey drop-shadows
    bg_like = (a < 20) | (mn >= 242) | ((mn >= 214) & ((mx - mn) <= 15))
    border = np.concatenate(
        [bg_like[0, :], bg_like[-1, :], bg_like[:, 0], bg_like[:, -1]], axis=0
    )
    if float(np.mean(border)) < 0.65:
        return rgba

    arr[_border_flood_fill(bg_like), 3] = 0
    return Image.fromarray(arr, "RGBA")


def _load_label_font(size: int = 30) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    candidates = [
        ("/System/Library/Fonts/HelveticaNeue.ttc", 1),
        ("/System/Library/Fonts/HelveticaNeue.ttc", 0),
        ("/System/Library/Fonts/SFNSRounded.ttf", 0),
        ("/System/Library/Fonts/Menlo.ttc", 0),
    ]
    for font_path, idx in candidates:
        try:
            return ImageFont.truetype(font_path, size, index=idx)
        except OSError:
            continue
    return ImageFont.load_default()


def _draw_gemini_sparkle(
    draw: ImageDraw.ImageDraw,
    cx: float,
    cy: float,
    r: float,
    primary: tuple[int, int, int] = (66, 133, 244),
    accent: tuple[int, int, int] = (155, 114, 203),
) -> None:
    inner = r * 0.28
    points = [
        (cx, cy - r),
        (cx + inner, cy - inner),
        (cx + r, cy),
        (cx + inner, cy + inner),
        (cx, cy + r),
        (cx - inner, cy + inner),
        (cx - r, cy),
        (cx - inner, cy - inner),
    ]
    draw.polygon(points, fill=primary)

    r2 = max(4.0, r * 0.36)
    i2 = r2 * 0.30
    sx, sy = cx + r * 0.78, cy - r * 0.72
    small_points = [
        (sx, sy - r2),
        (sx + i2, sy - i2),
        (sx + r2, sy),
        (sx + i2, sy + i2),
        (sx, sy + r2),
        (sx - i2, sy + i2),
        (sx - r2, sy),
        (sx - i2, sy - i2),
    ]
    draw.polygon(small_points, fill=accent)


def _draw_branding_pill(
    sheet_img: Image.Image,
    draw: ImageDraw.ImageDraw,
    cx: int,
    cy: int,
    sheet_w: int,
    sheet_h: int,
    text: str,
    font_size: int,
) -> None:
    font = _load_label_font(font_size)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    icon_r = max(10, int(round(font_size * 0.48)))
    icon_gap = 14
    vexo_img = None
    vexo_w = 0
    if VEXO_MARK_PATH.exists():
        vexo_raw = Image.open(VEXO_MARK_PATH).convert("RGBA")
        vexo_h = max(20, int(round(font_size * 0.95)))
        vexo_w = max(16, int(round(vexo_raw.width * (vexo_h / vexo_raw.height))))
        vexo_img = vexo_raw.resize((vexo_w, vexo_h), Image.Resampling.LANCZOS)

    left_w = (vexo_w + icon_gap) if vexo_img is not None else 0
    right_w = icon_gap + icon_r * 2
    total_w = left_w + tw + right_w

    pad_x, pad_y = 26, 11
    x0 = max(24, int(round(cx - total_w / 2 - pad_x)))
    y0 = max(8, int(round(cy - th / 2 - pad_y)))
    x1 = min(sheet_w - 24, int(round(cx + total_w / 2 + pad_x)))
    y1 = min(sheet_h - 8, int(round(cy + th / 2 + pad_y)))

    draw.rounded_rectangle(
        (x0, y0, x1, y1),
        radius=24,
        fill=(255, 255, 255),
        outline=(198, 210, 246),
        width=3,
    )
    start_x = (x0 + x1) / 2 - total_w / 2
    mid_y = (y0 + y1) / 2
    if vexo_img is not None:
        vx = int(round(start_x))
        vy = int(round(mid_y - vexo_img.height / 2))
        sheet_img.paste(vexo_img.convert("RGB"), (vx, vy), vexo_img.getchannel("A"))
    tx = start_x + left_w - bbox[0]
    ty = mid_y - th / 2 - bbox[1]
    draw.text((tx, ty), text, fill=(24, 32, 48), font=font)
    sparkle_cx = start_x + left_w + tw + icon_gap + icon_r
    _draw_gemini_sparkle(draw, sparkle_cx, mid_y, icon_r)


def _draw_sheet_branding(sheet: Image.Image, include_top: bool = True) -> Image.Image:
    out = sheet.copy()
    draw = ImageDraw.Draw(out)
    if include_top:
        _draw_branding_pill(
            out,
            draw,
            out.width // 2,
            74,
            out.width,
            out.height,
            "VexoHacks  ×  Google DeepMind · Gemini",
            25,
        )
    _draw_branding_pill(
        out,
        draw,
        out.width // 2,
        out.height - 48,
        out.width,
        out.height,
        "VexoHacks · AI Wearables  ×  YC  ×  Google DeepMind",
        22,
    )
    return out


def _draw_pill(
    draw: ImageDraw.ImageDraw,
    cx: int,
    cy: int,
    sheet_w: int,
    sheet_h: int,
    text: str,
    font_size: int,
) -> None:
    font = _load_label_font(font_size)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    pad_x, pad_y = 30, 13
    x0 = max(24, int(round(cx - tw / 2 - pad_x)))
    y0 = max(0, int(round(cy - th / 2 - pad_y)))
    x1 = min(sheet_w - 24, int(round(cx + tw / 2 + pad_x)))
    y1 = min(sheet_h - 10, int(round(cy + th / 2 + pad_y)))

    draw.rounded_rectangle(
        (x0, y0, x1, y1),
        radius=26,
        fill=(255, 255, 255),
        outline=(255, 102, 0),
        width=4,
    )
    tx = (x0 + x1) / 2 - tw / 2 - bbox[0]
    ty = (y0 + y1) / 2 - th / 2 - bbox[1]
    draw.text((tx, ty), text, fill=(17, 17, 17), font=font)


def _draw_sheet_footer_label(
    sheet: Image.Image, label: str, include_top: bool = True
) -> Image.Image:
    text = " ".join(label.strip().split())[:48]
    if not text:
        return sheet

    out = sheet.copy()
    draw = ImageDraw.Draw(out)
    if include_top:
        _draw_pill(draw, out.width // 2, 278, out.width, out.height, text, 34)
    _draw_pill(draw, out.width // 2, out.height - 114, out.width, out.height, text, 36)
    return out


def prepare_sheet_and_plt(
    png_path: str,
    out_plt_path: str | None = None,
    label: str | None = None,
    quality: int = 70,
) -> tuple[bytes, bytes, int, str | None]:
    with Image.open(png_path) as im:
        rgba = artwork.to_rgba(im)
    rgba = _strip_outer_white_bg(rgba)

    SW, SH = geometry.SHEET_W_PX, geometry.SHEET_H_PX
    has_bg = DEFAULT_SHEET_BG_PATH.exists()
    if has_bg:
        sheet = render.blank_sheet(str(DEFAULT_SHEET_BG_PATH))
        pad_top = 352
    else:
        sheet = render.blank_sheet("white")
        pad_top = 88
    pad_bot = 172
    pad_x = 58
    usable_w = SW - 2 * pad_x
    usable_h = SH - pad_top - pad_bot
    cut_halo_px = 16
    print_halo_px = 22

    mask = geometry.alpha_mask(rgba)
    min_area = max(900, int(rgba.width * rgba.height * 0.004))
    blobs = geometry.label_blobs(mask, min_area=min_area)

    canvas = Image.new("RGBA", (SW, SH), (0, 0, 0, 0))
    if 1 <= len(blobs) <= 12:
        items: list[tuple[float, float, Image.Image]] = []
        for bm in blobs:
            ys, xs = np.where(bm)
            x0, y0, x1, y1 = (
                int(xs.min()),
                int(ys.min()),
                int(xs.max()) + 1,
                int(ys.max()) + 1,
            )
            filled = _fill_interior_holes(bm[y0:y1, x0:x1])
            crop_arr = np.array(rgba.crop((x0, y0, x1, y1)), dtype=np.uint8, copy=True)
            crop_arr[~filled, 3] = 0
            inner_gap = filled & (crop_arr[:, :, 3] < 255)
            if np.any(inner_gap):
                crop_arr[inner_gap] = [255, 255, 255, 255]
            items.append(
                ((y0 + y1) / 2.0, (x0 + x1) / 2.0, Image.fromarray(crop_arr, "RGBA"))
            )

        items.sort(key=lambda t: t[0])
        cols = 2 if len(items) >= 4 else 1
        rows = (len(items) + cols - 1) // cols
        ordered: list[Image.Image] = []
        for r_idx in range(rows):
            row_slice = sorted(
                items[r_idx * cols : (r_idx + 1) * cols], key=lambda t: t[1]
            )
            ordered.extend(it[2] for it in row_slice)

        gutter_x = 96 if cols > 1 else 0
        gutter_y = 76 if rows > 1 else 0
        cell_w = (usable_w - (cols - 1) * gutter_x) // cols
        cell_h = (usable_h - (rows - 1) * gutter_y) // rows
        max_w = max(1, cell_w - 2 * print_halo_px)
        max_h = max(1, cell_h - 2 * print_halo_px)

        for idx, st in enumerate(ordered):
            rr, cc = divmod(idx, cols)
            sc = min(max_w / st.width, max_h / st.height)
            nw = max(1, int(round(st.width * sc)))
            nh = max(1, int(round(st.height * sc)))
            resized = st.resize((nw, nh), Image.Resampling.LANCZOS)
            cx = pad_x + cc * (cell_w + gutter_x) + (cell_w - nw) // 2
            cy = pad_top + rr * (cell_h + gutter_y) + (cell_h - nh) // 2
            canvas.alpha_composite(resized, (cx, cy))
    else:
        bbox = rgba.getbbox()
        cropped = rgba.crop(bbox) if bbox else rgba
        max_w = max(1, usable_w - 2 * print_halo_px)
        max_h = max(1, usable_h - 2 * print_halo_px)
        sc = min(max_w / cropped.width, max_h / cropped.height)
        nw = max(1, int(round(cropped.width * sc)))
        nh = max(1, int(round(cropped.height * sc)))
        resized = cropped.resize((nw, nh), Image.Resampling.LANCZOS)
        cx = pad_x + (usable_w - nw) // 2
        cy = pad_top + (usable_h - nh) // 2
        canvas.alpha_composite(resized, (cx, cy))

    art_mask = np.array(canvas)[:, :, 3] >= 128
    print_mask = _fill_interior_holes(geometry.dilate(art_mask, print_halo_px))
    cut_mask = _fill_interior_holes(geometry.dilate(art_mask, cut_halo_px))

    sheet_arr = np.array(sheet, dtype=np.uint8, copy=True)
    sheet_arr[print_mask] = [255, 255, 255]
    sheet = Image.fromarray(sheet_arr, "RGB")
    sheet.paste(canvas.convert("RGB"), (0, 0), canvas.split()[3])
    sheet = _draw_sheet_branding(sheet, include_top=has_bg)
    if label:
        sheet = _draw_sheet_footer_label(sheet, label, include_top=has_bg)
    jpeg_bytes = render.to_jpeg(sheet, quality=quality)

    cut_arr = np.zeros((SH, SW, 4), dtype=np.uint8)
    cut_arr[cut_mask] = [255, 255, 255, 255]
    cut_rgba = Image.fromarray(cut_arr, "RGBA")

    contours = geometry.contours_for(
        cut_rgba,
        origin_px=(0, 0),
        bleed_mm=0.0,
        tol_px=2.0,
        cut_holes=False,
        min_piece_mm2=25.0,
    )
    plt_bytes = geometry.build_plt(contours)
    plt_bytes = geometry.plt_with_overcut(
        plt_bytes, geometry.OVERCUT_DEFAULT_MM, geometry.OVERCUT_MAX_DEGREES
    )
    if isinstance(plt_bytes, str):
        plt_bytes = plt_bytes.encode("ascii")

    if out_plt_path:
        with open(out_plt_path, "wb") as f:
            f.write(plt_bytes)

    return jpeg_bytes, plt_bytes, len(contours), None


async def cmd_status(transport: str) -> None:
    pc, name, addr, active_transport = await open_pixcut(transport)
    try:
        props = await pc.get_props(
            "printer-state",
            "printer-sub-state",
            "printer-state-alerts",
            "serial-number",
            "model",
            "media-size",
        )
        jobs = await pc.job_id_list()
        flt = states.faults(props)
        print(
            json.dumps(
                {
                    "connected": True,
                    "name": name,
                    "address": addr,
                    "transport": active_transport,
                    "state": props.get("printer-state"),
                    "subState": props.get("printer-sub-state"),
                    "model": props.get("model") or "DHP700",
                    "serial": props.get("serial-number"),
                    "mediaSize": props.get("media-size"),
                    "alerts": props.get("printer-state-alerts", ""),
                    "faults": flt,
                    "latchedJobs": jobs,
                },
                default=str,
            )
        )
    finally:
        await pc.disconnect()


async def cmd_clear_fault(transport: str) -> None:
    pc, _, _, _ = await open_pixcut(transport)
    try:
        st, cancelled = await recover_printer(pc)
        remaining = await pc.job_id_list()
        print(
            json.dumps(
                {
                    "ok": True,
                    "cancelledJobs": cancelled,
                    "state": st.get("printer-state"),
                    "subState": st.get("printer-sub-state"),
                    "alerts": st.get("printer-state-alerts", "::0"),
                    "remainingJobs": remaining,
                },
                default=str,
            )
        )
    finally:
        await pc.disconnect()


async def cmd_print_and_cut(
    png_path: str, plt_path: str | None, copies: int, transport: str, label: str = ""
) -> None:
    jpeg_bytes, plt_bytes, count, gap_note = prepare_sheet_and_plt(
        png_path, plt_path, label=label or None
    )
    _log(
        f"Prepared sheet: {count} contour(s), {len(jpeg_bytes)} B JPEG, {len(plt_bytes)} B PLT"
        + (f" ({gap_note})" if gap_note else "")
    )

    pc, _name, _addr, active_transport = await open_pixcut(transport)
    try:
        st, cancelled = await recover_printer(pc)
        if cancelled:
            _log(f"Cleared latched jobs before print: {cancelled}")
        blk = states.blocking(states.faults(st))
        if blk:
            msgs = "; ".join(f"{f.get('code')}: {f.get('message')}" for f in blk)
            raise RuntimeError(f"Printer fault blocks printing: {msgs}")

        last_pct = -10

        def on_upload(sent: int, total: int) -> None:
            nonlocal last_pct
            if total <= 0:
                return
            pct = (sent * 100) // total
            bucket = (pct // 10) * 10
            if bucket >= last_pct + 10 or sent == total:
                last_pct = bucket
                _log(f"Upload [{active_transport}]: {pct}% ({sent}/{total} frames)")

        job_id = await pc.submit(
            jpeg_bytes,
            plt_bytes,
            copies=copies,
            on_upload=on_upload,
        )
        _log(f"Submitted job #{job_id}; waiting for print & cut...")

        last_key: tuple[Any, Any, Any, Any] | None = None

        def on_progress(info: dict[str, Any] | None) -> None:
            nonlocal last_key
            if not info:
                return
            key = (
                info.get("job-state"),
                info.get("job-sub-state"),
                info.get("printing-page-number"),
                info.get("cutting-progress"),
            )
            if key != last_key:
                last_key = key
                _log(
                    f"Progress job #{job_id}: state={key[0]} sub={key[1]} page={key[2]} cut={key[3]}"
                )

        try:
            outcome = await pc.wait(job_id, timeout=300.0, on_progress=on_progress)
        except client.PixCutAlert as exc:
            _log(f"Printer alert during job #{job_id}: {exc}; cancelling latched job")
            try:
                await pc.cancel_job(job_id)
            except Exception as cancel_exc:
                _log(f"Warning: cancel_job({job_id}) failed: {cancel_exc}")
            raise

        print(
            json.dumps(
                {
                    "ok": True,
                    "jobId": job_id,
                    "contours": count,
                    "jpegBytes": len(jpeg_bytes),
                    "pltBytes": len(plt_bytes),
                    "outcome": outcome,
                },
                default=str,
            )
        )
    finally:
        await pc.disconnect()


async def cmd_daemon(transport: str) -> None:
    loop = asyncio.get_running_loop()
    cmd_queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    stop_event = asyncio.Event()
    op_lock = asyncio.Lock()

    pc: client.PixCut | None = None
    conn_name = "Liene PixCut S1"
    conn_addr = ""
    active_transport = ""
    auto_off_disabled = False
    busy_printing = False
    last_status: dict[str, Any] = {
        "connected": False,
        "keepaliveMode": "daemon",
    }

    def _emit(payload: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(payload, default=str) + "\n")
        sys.stdout.flush()

    async def disconnect_pc() -> None:
        nonlocal pc, auto_off_disabled
        if pc is not None:
            await _disconnect_silently(pc)
            pc = None
            auto_off_disabled = False

    async def ensure_connected(
        force_reconnect: bool = False,
    ) -> tuple[client.PixCut, str, str, str]:
        nonlocal pc, conn_name, conn_addr, active_transport, auto_off_disabled
        if (
            pc is not None
            and not force_reconnect
            and getattr(pc, "is_connected", True)
            and not getattr(pc, "link_lost_reason", None)
        ):
            return pc, conn_name, conn_addr, active_transport

        await disconnect_pc()
        pc, conn_name, conn_addr, active_transport = await open_pixcut(transport)
        try:
            auto_off_val = await asyncio.wait_for(pc.set_auto_off_interval(0), timeout=5.0)
            auto_off_disabled = auto_off_val == 0
            _log(
                f"Daemon connected [{active_transport}] {conn_name} ({conn_addr}); "
                f"auto_off={auto_off_val}"
            )
        except Exception as exc:
            auto_off_disabled = False
            _log(
                f"Daemon connected [{active_transport}]; set_auto_off_interval(0) warning: {exc}"
            )
        return pc, conn_name, conn_addr, active_transport

    async def read_full_status(allow_retry: bool = True) -> dict[str, Any]:
        nonlocal last_status
        reused = pc is not None
        try:
            cur_pc, name, addr, tr = await ensure_connected()
            props = await asyncio.wait_for(
                cur_pc.get_props(
                    "printer-state",
                    "printer-sub-state",
                    "printer-state-alerts",
                    "serial-number",
                    "model",
                    "media-size",
                ),
                timeout=6.0,
            )
            jobs = await asyncio.wait_for(cur_pc.job_id_list(), timeout=5.0)
            flt = states.faults(props)
            last_status = {
                "connected": True,
                "name": name,
                "address": addr,
                "transport": tr,
                "state": props.get("printer-state"),
                "subState": props.get("printer-sub-state"),
                "model": props.get("model") or "DHP700",
                "serial": props.get("serial-number"),
                "mediaSize": props.get("media-size"),
                "alerts": props.get("printer-state-alerts", ""),
                "faults": flt,
                "latchedJobs": jobs,
                "busy": busy_printing,
                "autoOffDisabled": auto_off_disabled,
                "keepaliveMode": "daemon",
                "updatedAt": time.time(),
            }
            return dict(last_status)
        except Exception as exc:
            await disconnect_pc()
            if allow_retry and reused:
                return await read_full_status(allow_retry=False)
            last_status = {
                "connected": False,
                "error": str(exc),
                "busy": busy_printing,
                "keepaliveMode": "daemon",
                "updatedAt": time.time(),
            }
            return dict(last_status)

    async def prepare_job_bytes(req: dict[str, Any]) -> tuple[bytes, bytes, int]:
        jpeg_path = req.get("jpeg")
        plt_path = req.get("plt")
        png_path = req.get("png")
        label = str(req.get("label") or "")
        contours = int(req.get("contours") or 0)
        if (
            jpeg_path
            and plt_path
            and Path(jpeg_path).is_file()
            and Path(plt_path).is_file()
        ):
            return Path(jpeg_path).read_bytes(), Path(plt_path).read_bytes(), contours or 6
        if not png_path:
            raise RuntimeError("Missing png path and pre-rendered jpeg/plt files")
        jpeg_bytes, plt_bytes, count, _ = await asyncio.to_thread(
            prepare_sheet_and_plt,
            str(png_path),
            str(plt_path) if plt_path else None,
            label or None,
        )
        if jpeg_path:
            Path(jpeg_path).write_bytes(jpeg_bytes)
        return jpeg_bytes, plt_bytes, count

    async def handle_clear_fault() -> dict[str, Any]:
        nonlocal last_status
        async with op_lock:
            cur_pc, name, addr, tr = await ensure_connected()
            st, cancelled = await recover_printer(cur_pc)
            remaining = await asyncio.wait_for(cur_pc.job_id_list(), timeout=5.0)
            last_status = {
                **last_status,
                "connected": True,
                "name": name,
                "address": addr,
                "transport": tr,
                "state": st.get("printer-state"),
                "subState": st.get("printer-sub-state"),
                "alerts": st.get("printer-state-alerts", "::0"),
                "faults": states.faults(st),
                "latchedJobs": remaining,
                "autoOffDisabled": auto_off_disabled,
                "keepaliveMode": "daemon",
                "updatedAt": time.time(),
            }
            _emit({"event": "status", **last_status})
            return {
                "ok": True,
                "cancelledJobs": cancelled,
                "state": st.get("printer-state"),
                "subState": st.get("printer-sub-state"),
                "alerts": st.get("printer-state-alerts", "::0"),
                "remainingJobs": remaining,
            }

    async def handle_print(req: dict[str, Any]) -> dict[str, Any]:
        nonlocal busy_printing, last_status
        queue_id = req.get("queueId")
        copies = int(req.get("copies") or 1)
        jpeg_bytes, plt_bytes, count = await prepare_job_bytes(req)

        async with op_lock:
            busy_printing = True
            last_status = {**last_status, "busy": True}
            _emit({"event": "status", **last_status})
            cur_pc: client.PixCut | None = None
            try:
                for attempt in range(4):
                    cur_pc, _name, _addr, tr = await ensure_connected()
                    _emit(
                        {
                            "event": "progress",
                            "queueId": queue_id,
                            "phase": "connect",
                            "pct": 0,
                            "text": f"Connected via {'RFCOMM (110 KB/s)' if tr == 'rfcomm' else 'BLE'}",
                            "transport": tr,
                        }
                    )
                    st, cancelled = await recover_printer(cur_pc)
                    if cancelled:
                        _log(f"Cleared latched jobs before print: {cancelled}; waiting for printer to settle...")
                        await asyncio.sleep(2.0)
                        st = await cur_pc.state()
                    for _ in range(6):
                        latched = await cur_pc.job_id_list()
                        st_code = str(st.get("printer-state", ""))
                        if not latched and st_code in ("20", ""):
                            break
                        await asyncio.sleep(1.0)
                        st = await cur_pc.state()
                    blk = states.blocking(states.faults(st))
                    if blk:
                        msgs = "; ".join(
                            f"{f.get('code')}: {f.get('message')}" for f in blk
                        )
                        raise RuntimeError(f"Printer fault blocks printing: {msgs}")

                    last_pct = -10
                    t_upload = time.monotonic()

                    def on_upload(sent: int, total: int) -> None:
                        nonlocal last_pct
                        if total <= 0:
                            return
                        pct = (sent * 100) // total
                        bucket = (pct // 10) * 10
                        if bucket >= last_pct + 10 or sent == total:
                            last_pct = bucket
                            _log(
                                f"Upload [{tr}]: {pct}% ({sent}/{total} frames)"
                            )
                            _emit(
                                {
                                    "event": "progress",
                                    "queueId": queue_id,
                                    "phase": "upload",
                                    "pct": pct,
                                    "text": f"Uploading via {'RFCOMM' if tr == 'rfcomm' else 'BLE'}… {pct}%",
                                    "transport": tr,
                                }
                            )

                    try:
                        job_id = await cur_pc.submit(
                            jpeg_bytes,
                            plt_bytes,
                            copies=copies,
                            on_upload=on_upload,
                        )
                    except client.UploadInterrupted as exc:
                        is_retryable = getattr(exc, "retryable", False) or "8006" in str(exc)
                        if is_retryable and attempt < 3:
                            backoff = 1.5 * (attempt + 1)
                            _log(
                                f"Retryable UploadInterrupted ({exc}); reconnecting and retrying in {backoff:.1f}s (attempt {attempt + 2}/4)..."
                            )
                            _emit(
                                {
                                    "event": "progress",
                                    "queueId": queue_id,
                                    "phase": "retry",
                                    "pct": 0,
                                    "text": f"Printer busy (8006), retrying in {backoff:.1f}s…",
                                    "transport": tr,
                                }
                            )
                            await disconnect_pc()
                            await asyncio.sleep(backoff)
                            continue
                        raise

                    _log(
                        f"Submitted job #{job_id} over {tr} in {time.monotonic() - t_upload:.2f}s; waiting for print & cut..."
                    )
                    _emit(
                        {
                            "event": "progress",
                            "queueId": queue_id,
                            "jobId": job_id,
                            "phase": "print",
                            "pct": None,
                            "text": f"Uploaded in {time.monotonic() - t_upload:.1f}s — printing…",
                            "transport": tr,
                        }
                    )

                    last_key: tuple[Any, Any, Any, Any] | None = None
                    saw_feed_or_cut = False

                    def on_progress(info: dict[str, Any] | None) -> None:
                        nonlocal last_key, saw_feed_or_cut
                        if not info:
                            return
                        key = (
                            info.get("job-state"),
                            info.get("job-sub-state"),
                            info.get("printing-page-number"),
                            info.get("cutting-progress"),
                        )
                        try:
                            if int(key[2] or 0) >= 1 or int(key[3] or 0) >= 1:
                                saw_feed_or_cut = True
                        except Exception:
                            pass
                        if key != last_key:
                            last_key = key
                            _log(
                                f"Progress job #{job_id}: state={key[0]} sub={key[1]} page={key[2]} cut={key[3]}"
                            )
                            try:
                                cut_val = int(key[3] or 0)
                            except Exception:
                                cut_val = 0
                            if cut_val > 0:
                                phase = "cut"
                                text = f"Kiss-cutting stickers ({cut_val}%)…"
                                pct_val: int | None = cut_val
                            elif key[2]:
                                phase = "print"
                                text = f"Printing sheet (page {key[2]})…"
                                pct_val = None
                            else:
                                phase = "print"
                                text = f"Printing on PixCut S1 (state {key[0]})…"
                                pct_val = None
                            _emit(
                                {
                                    "event": "progress",
                                    "queueId": queue_id,
                                    "jobId": job_id,
                                    "phase": phase,
                                    "pct": pct_val,
                                    "text": text,
                                    "transport": tr,
                                }
                            )

                    wait_task = asyncio.create_task(
                        cur_pc.wait(
                            job_id, poll=1.0, timeout=150.0, on_progress=on_progress
                        )
                    )

                    async def _stall_watchdog() -> None:
                        await asyncio.sleep(45.0)
                        if not saw_feed_or_cut and not wait_task.done():
                            wait_task.cancel()

                    wd_task = asyncio.create_task(_stall_watchdog())
                    try:
                        outcome = await wait_task
                    except asyncio.CancelledError:
                        _log(
                            f"PrinterStall: job #{job_id} did not feed paper within 45s; cancelling latched job"
                        )
                        try:
                            await asyncio.wait_for(cur_pc.cancel_job(job_id), timeout=5.0)
                        except Exception as cancel_exc:
                            _log(
                                f"Warning: cancel_job({job_id}) failed: {cancel_exc}"
                            )
                        raise RuntimeError(
                            f"PrinterStall: PixCut S1 did not feed paper after 45s (job #{job_id}). Check paper tray/ribbon and power-cycle the printer."
                        )
                    except (client.PixCutAlert, TimeoutError) as exc:
                        _log(
                            f"Printer alert during job #{job_id}: {exc}; cancelling latched job"
                        )
                        try:
                            await asyncio.wait_for(cur_pc.cancel_job(job_id), timeout=5.0)
                        except Exception as cancel_exc:
                            _log(
                                f"Warning: cancel_job({job_id}) failed: {cancel_exc}"
                            )
                        raise
                    finally:
                        wd_task.cancel()

                    return {
                        "ok": True,
                        "jobId": job_id,
                        "contours": count,
                        "jpegBytes": len(jpeg_bytes),
                        "pltBytes": len(plt_bytes),
                        "transport": tr,
                        "outcome": outcome,
                    }
                raise RuntimeError("Print failed after retryable upload attempt")
            except Exception as exc:
                if (
                    cur_pc is None
                    or not getattr(cur_pc, "is_connected", True)
                    or isinstance(exc, (client.PixCutDisconnected, asyncio.TimeoutError))
                ):
                    await disconnect_pc()
                raise
            finally:
                busy_printing = False
                last_status = {
                    **last_status,
                    "busy": False,
                    "updatedAt": time.time(),
                }
                _emit({"event": "status", **last_status})

    async def keepalive_loop() -> None:
        nonlocal last_status
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=28.0)
                break
            except asyncio.TimeoutError:
                pass
            if op_lock.locked() or busy_printing:
                continue
            async with op_lock:
                if busy_printing:
                    continue
                try:
                    if (
                        pc is None
                        or not getattr(pc, "is_connected", True)
                        or getattr(pc, "link_lost_reason", None)
                    ):
                        st = await read_full_status(allow_retry=False)
                        _emit({"event": "status", **st})
                    else:
                        st_props = await asyncio.wait_for(pc.state(), timeout=5.0)
                        last_status = {
                            **last_status,
                            "connected": True,
                            "name": conn_name,
                            "address": conn_addr,
                            "transport": active_transport,
                            "state": st_props.get("printer-state"),
                            "subState": st_props.get("printer-sub-state"),
                            "alerts": st_props.get("printer-state-alerts", ""),
                            "faults": states.faults(st_props),
                            "busy": busy_printing,
                            "autoOffDisabled": auto_off_disabled,
                            "keepaliveMode": "daemon",
                            "updatedAt": time.time(),
                        }
                        _emit({"event": "status", **last_status})
                except Exception as exc:
                    _log(f"Keepalive tick failed ({exc}); resetting connection")
                    await disconnect_pc()
                    last_status = {
                        "connected": False,
                        "error": str(exc),
                        "busy": False,
                        "keepaliveMode": "daemon",
                        "updatedAt": time.time(),
                    }
                    _emit({"event": "status", **last_status})

    def stdin_reader() -> None:
        try:
            for line in sys.stdin:
                text = line.strip()
                if not text:
                    continue
                try:
                    req = json.loads(text)
                except Exception as exc:
                    _log(f"Ignoring invalid JSON command ({exc}): {text[:120]}")
                    continue
                loop.call_soon_threadsafe(cmd_queue.put_nowait, req)
        finally:
            loop.call_soon_threadsafe(cmd_queue.put_nowait, None)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass

    reader_thread = threading.Thread(target=stdin_reader, daemon=True)
    reader_thread.start()

    # Best-effort initial connect (never crashes daemon if printer is powered off)
    async with op_lock:
        init_status = await read_full_status(allow_retry=False)
    _emit({"event": "ready", **init_status})
    _emit({"event": "status", **init_status})

    keepalive_task = asyncio.create_task(keepalive_loop())
    try:
        while not stop_event.is_set():
            get_task = asyncio.create_task(cmd_queue.get())
            stop_task = asyncio.create_task(stop_event.wait())
            done, pending = await asyncio.wait(
                {get_task, stop_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for p_task in pending:
                p_task.cancel()
            if stop_task in done or stop_event.is_set():
                break
            req = get_task.result()
            if req is None:
                break

            req_id = req.get("id")
            cmd = str(req.get("cmd") or "")
            try:
                if cmd == "shutdown":
                    _emit({"id": req_id, "ok": True})
                    break
                elif cmd == "ping":
                    _emit({"id": req_id, "ok": True, "status": last_status})
                elif cmd == "status":
                    async with op_lock:
                        st = await read_full_status(allow_retry=True)
                    _emit({"event": "status", **st})
                    _emit({"id": req_id, "ok": True, **st})
                elif cmd == "clear-fault":
                    res = await handle_clear_fault()
                    _emit({"id": req_id, **res})
                elif cmd == "print":
                    res = await handle_print(req)
                    _emit({"id": req_id, **res})
                else:
                    _emit({"id": req_id, "ok": False, "error": f"Unknown cmd: {cmd}"})
            except Exception as exc:
                _emit({"id": req_id, "ok": False, "error": str(exc)})
    finally:
        stop_event.set()
        keepalive_task.cancel()
        try:
            await keepalive_task
        except asyncio.CancelledError:
            pass
        await disconnect_pc()
        _log("PixCut daemon exited cleanly")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--transport",
        choices=["auto", "ble", "rfcomm"],
        default="auto",
        help="Transport preference",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("clear-fault")
    sub.add_parser("resume")
    sub.add_parser("daemon")
    p = sub.add_parser("print-and-cut")
    p.add_argument("--png", required=True)
    p.add_argument("--plt", required=False, default=None)
    p.add_argument("--copies", type=int, default=1)
    p.add_argument("--label", default="")
    p.add_argument("--transport", choices=["auto", "ble", "rfcomm"], default=argparse.SUPPRESS)
    pv = sub.add_parser("preview")
    pv.add_argument("--png", required=True)
    pv.add_argument("--out", required=True)
    pv.add_argument("--label", default="")
    pr = sub.add_parser("prepare")
    pr.add_argument("--png", required=True)
    pr.add_argument("--out-jpeg", required=True)
    pr.add_argument("--out-plt", required=True)
    pr.add_argument("--label", default="")
    pr.add_argument("--quality", type=int, default=70)

    args = parser.parse_args()
    transport = getattr(args, "transport", "auto")
    try:
        if args.cmd == "status":
            asyncio.run(cmd_status(transport))
        elif args.cmd in ("clear-fault", "resume"):
            asyncio.run(cmd_clear_fault(transport))
        elif args.cmd == "daemon":
            asyncio.run(cmd_daemon(transport))
        elif args.cmd == "print-and-cut":
            asyncio.run(
                cmd_print_and_cut(
                    args.png, args.plt, args.copies, transport, label=args.label
                )
            )
        elif args.cmd == "preview":
            jpeg_bytes, plt_bytes, count, _ = prepare_sheet_and_plt(
                args.png, None, label=args.label or None
            )
            with open(args.out, "wb") as f:
                f.write(jpeg_bytes)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "contours": count,
                        "jpegBytes": len(jpeg_bytes),
                        "pltBytes": len(plt_bytes),
                        "out": args.out,
                    }
                )
            )
        elif args.cmd == "prepare":
            jpeg_bytes, plt_bytes, count, note = prepare_sheet_and_plt(
                args.png, None, label=args.label or None, quality=args.quality
            )
            Path(args.out_jpeg).parent.mkdir(parents=True, exist_ok=True)
            Path(args.out_plt).parent.mkdir(parents=True, exist_ok=True)
            with open(args.out_jpeg, "wb") as f:
                f.write(jpeg_bytes)
            with open(args.out_plt, "wb") as f:
                f.write(plt_bytes)
            print(
                json.dumps(
                    {
                        "ok": True,
                        "contours": count,
                        "jpegBytes": len(jpeg_bytes),
                        "pltBytes": len(plt_bytes),
                        "outJpeg": args.out_jpeg,
                        "outPlt": args.out_plt,
                        "note": note,
                    }
                )
            )
    except Exception as exc:
        if isinstance(exc, client.PixCutAlert) and getattr(exc, "alerts", None):
            details = "; ".join(
                f"{a.get('code')}: {a.get('message')}" for a in exc.alerts if isinstance(a, dict)
            )
            msg = f"PixCutAlert: {details or str(exc)}"
        else:
            msg = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
        print(json.dumps({"ok": False, "error": msg}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
