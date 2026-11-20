#!/usr/bin/env python3
"""Fetches one small real case for e2e/real-data.spec.ts and writes cases.json.

    pip install remotezip
    python3 e2e/fetch-real-case.py <folder>
    W_REALDATA_DIR=<folder> pnpm e2e e2e/real-data.spec.ts

The case is one chest CT from LUNA16 with its lung mask (https://zenodo.org/records/3723295,
Creative Commons Attribution 4.0). Only that scan is downloaded, with HTTP range requests on
the Zenodo archives: about 31 MB instead of 7 GB. The mask comes as .mhd + .zraw and is
rewritten here as NIfTI on the same grid, because the spec checks saved masks as NIfTI.

The data is public and de-identified. It is never added to the repository.
"""
import gzip
import json
import os
import struct
import sys
import time
import zlib

from remotezip import RemoteZip

RECORD = "https://zenodo.org/api/records/3723295/files/{}/content"
SERIES = "1.3.6.1.4.1.14519.5.2.1.6279.6001.105756658031515062000744821260"
IMAGE_ZIP, IMAGE_DIR = "subset0.zip", "subset0"
MASK_ZIP, MASK_DIR = "seg-lungs-LUNA16.zip", "seg-lungs-LUNA16"


def fetch(archive, members, out_dir):
    """Extracts the members whose names end with one of `members`, trying a few times."""
    os.makedirs(out_dir, exist_ok=True)
    for attempt in range(1, 5):
        try:
            with RemoteZip(RECORD.format(archive), timeout=120) as remote:
                names = [n for n in remote.namelist() if n.endswith(tuple(members))]
                if len(names) != len(members):
                    raise SystemExit(f"{archive}: expected {members}, found {names}")
                for name in names:
                    target = os.path.join(out_dir, os.path.basename(name))
                    with remote.open(name) as src, open(target, "wb") as dst:
                        while chunk := src.read(1 << 20):
                            dst.write(chunk)
            return
        except SystemExit:
            raise
        except Exception as err:  # network trouble: wait and try again
            print(f"{archive}: attempt {attempt} failed: {err}", file=sys.stderr)
            if attempt == 4:
                raise
            time.sleep(15 * attempt)


def read_mhd(path):
    fields = {}
    with open(path, encoding="latin-1") as fh:
        for line in fh:
            key, _, value = line.partition("=")
            fields[key.strip()] = value.strip()
    return fields


def mask_to_nifti(mhd_path, out_path):
    """Rewrites a uint8 .mhd + .zraw label volume as .nii.gz with the same geometry."""
    f = read_mhd(mhd_path)
    plain = f["ElementType"] == "MET_SHORT" and f.get("BinaryDataByteOrderMSB", "False") == "False"
    if not plain or f.get("TransformMatrix", "1 0 0 0 1 0 0 0 1") != "1 0 0 0 1 0 0 0 1":
        raise SystemExit(f"Unexpected mask header: {f}")
    dims = [int(v) for v in f["DimSize"].split()]
    spacing = [float(v) for v in f["ElementSpacing"].split()]
    offset = [float(v) for v in f["Offset"].split()]
    with open(os.path.join(os.path.dirname(mhd_path), f["ElementDataFile"]), "rb") as fh:
        raw = zlib.decompress(fh.read())
    if len(raw) != 2 * dims[0] * dims[1] * dims[2]:
        raise SystemExit("The mask data does not match its header")
    # Little-endian int16 labels; they are small (lungs 3 and 4, airways 5), so the low byte is the label.
    if any(raw[1::2]):
        raise SystemExit("The mask has labels above 255")
    voxels = raw[0::2]

    header = bytearray(352)
    struct.pack_into("<i", header, 0, 348)
    struct.pack_into("<8h", header, 40, 3, dims[0], dims[1], dims[2], 1, 1, 1, 1)
    struct.pack_into("<hh", header, 70, 2, 8)  # uint8
    struct.pack_into("<8f", header, 76, 1, spacing[0], spacing[1], spacing[2], 1, 1, 1, 1)
    struct.pack_into("<f", header, 108, 352)
    struct.pack_into("<f", header, 112, 1)
    struct.pack_into("<h", header, 254, 1)  # sform_code
    # MetaImage is LPS, NIfTI is RAS: negate x and y.
    struct.pack_into("<4f", header, 280, -spacing[0], 0, 0, -offset[0])
    struct.pack_into("<4f", header, 296, 0, -spacing[1], 0, -offset[1])
    struct.pack_into("<4f", header, 312, 0, 0, spacing[2], offset[2])
    header[344:348] = b"n+1\0"
    with gzip.open(out_path, "wb", compresslevel=6) as fh:
        fh.write(bytes(header) + voxels)


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    root = sys.argv[1]
    image_dir = os.path.join(root, "luna16", IMAGE_DIR)
    mask_dir = os.path.join(root, "luna16", MASK_DIR)
    fetch(IMAGE_ZIP, [f"{SERIES}.mhd", f"{SERIES}.raw"], image_dir)
    fetch(MASK_ZIP, [f"{SERIES}.mhd", f"{SERIES}.zraw"], mask_dir)
    os.makedirs(os.path.join(root, "derived"), exist_ok=True)
    mask_to_nifti(os.path.join(mask_dir, f"{SERIES}.mhd"), os.path.join(root, "derived", "luna16_lungs.nii.gz"))
    cases = [
        {
            "name": "luna16-ct-lungs",
            "image": [f"luna16/{IMAGE_DIR}/{SERIES}.mhd", f"luna16/{IMAGE_DIR}/{SERIES}.raw"],
            "mask": ["derived/luna16_lungs.nii.gz"],
        }
    ]
    with open(os.path.join(root, "cases.json"), "w", encoding="utf-8") as fh:
        json.dump(cases, fh, indent=2)
    print(f"Wrote {os.path.join(root, 'cases.json')}")


if __name__ == "__main__":
    main()
