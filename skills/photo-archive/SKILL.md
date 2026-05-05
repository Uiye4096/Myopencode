---
name: photo-archive
description: Archive Olympus camera photos from memory card (DCIM) to the user's master photo library. The user always transfers from a mounted SD card to their fixed destination base. Use when user has new camera photos and wants to archive them by date. Triggers: "归档照片", "从内存卡挪照片", "photo archive".
---

## Destination

The user has a fixed photo library root:
```
/Volumes/Spring Limited Strawberry Tart Event/Photo/RAW/{YY}/
```

where `{YY}` is the two-digit year (e.g., `26` for 2026). Subdirectories under this are named `YYMMDD` (e.g., `260315`), possibly with descriptions (e.g., `260313 春天和情书`).

## Workflow

1. **Auto-detect source** — scan `/Volumes/` for DCIM folders (e.g., `*/DCIM/100OLYMP`). If a single match is found, use it directly; if multiple, pick the one containing Olympus `.ORF` files. Only ask user if nothing is found.
2. **Detect year** — read mtime from one sample photo in source, extract `%y` to determine target year directory.
3. **Determine target** — `dst = <base>/RAW/{YY}/`. Create the year directory if it doesn't exist.
4. **Group by date** — scan all files in source, group by `%y%m%d` key. JPG+ORF pairs stay together (identical mtimes).
5. **Create + move** — create `{YYMMDD}` subfolders under target, `shutil.move` all files in.
6. **Verify** — confirm source is empty, print per-date file counts.

> 提示：先确认内存卡已插入并挂载到 `/Volumes/`。

## Key details

- **Date source**: `os.path.getmtime()` + `datetime.fromtimestamp()` — on macOS, this matches the camera's original capture date and auto-converts to local timezone.
- **Naming**: `%y%m%d` format, pure date only. User may add descriptions later.
- **Move only** — files are moved (not copied); source card is emptied after.
- **No external deps** — only macOS built-in Python3 is needed.

## Script template

```python
import os, datetime, shutil, glob
from collections import defaultdict

BASE = "/Volumes/Spring Limited Strawberry Tart Event/Photo/RAW"

# Auto-detect source: find DCIM folders under /Volumes/
candidates = glob.glob("/Volumes/*/DCIM/*")
src = None
for c in sorted(candidates):
    if os.path.isdir(c) and any(f.lower().endswith('.orf') for f in os.listdir(c)):
        src = c
        break
if not src:
    raise FileNotFoundError("No DCIM folder with ORF files found under /Volumes/. Is the SD card mounted?")

print(f"Source: {src}")

# Detect year from first JPG
for fname in sorted(os.listdir(src)):
    if fname.lower().endswith('.jpg'):
        dt = datetime.datetime.fromtimestamp(os.path.getmtime(os.path.join(src, fname)))
        year = dt.strftime("%y")
        break

DST = os.path.join(BASE, year)
os.makedirs(DST, exist_ok=True)

# Group by date
groups = defaultdict(list)
for fname in os.listdir(src):
    fpath = os.path.join(src, fname)
    if not os.path.isfile(fpath):
        continue
    dt = datetime.datetime.fromtimestamp(os.path.getmtime(fpath))
    date_key = dt.strftime("%y%m%d")
    groups[date_key].append(fname)

# Move
for date_key, files in sorted(groups.items()):
    dst_dir = os.path.join(DST, date_key)
    os.makedirs(dst_dir, exist_ok=True)
    for f in files:
        shutil.move(os.path.join(src, f), os.path.join(dst_dir, f))

print(f"Done: {sum(len(v) for v in groups.values())} files -> {DST}")
for dk in sorted(groups.keys()):
    print(f"  {dk}: {len(groups[dk])} files")
```
