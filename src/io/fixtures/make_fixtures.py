"""Generates the compressed DICOM fixtures in this folder. Synthetic data only.

How they were made (2026-11, Python 3.13):
    pip install pydicom==3.0.2 numpy pylibjpeg pylibjpeg-openjpeg pyjpegls python-gdcm
    python make_fixtures.py

Every file is one 3-frame, 40 x 36 (columns x rows), signed 16-bit image whose frame f, pixel p holds
(p * 37 + f * 101) % 4000 - 1000, with RescaleIntercept 0 so the values come back as stored.
The encoders are third-party (pydicom RLE, CharLS, OpenJPEG, GDCM), so the TypeScript
decoders are checked against independent implementations.
  rle.dcm            RLE Lossless, basic offset table, one fragment per frame
  jpegls.dcm         JPEG-LS Lossless, basic offset table, two fragments per frame
  j2k.dcm            JPEG 2000 Lossless, empty offset table, one fragment per frame
  jpeglossless.dcm   JPEG Lossless SV1 (1.2.840.10008.1.2.4.70), written by GDCM
  jpegbaseline.dcm   JPEG Baseline 8-bit (lossy), unsigned 8-bit gradient
                     3 * column + 2 * row + 10 * f, written by GDCM
"""
import os
import sys

import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.encaps import encapsulate
from pydicom.uid import (JPEG2000Lossless, JPEGLSLossless, RLELossless, ExplicitVRLittleEndian,
                         JPEGLosslessSV1, JPEGBaseline8Bit, CTImageStorage)

ROWS, COLS, FRAMES = 36, 40, 3
HERE = os.path.dirname(os.path.abspath(__file__))


def pixels16():
    p = np.arange(ROWS * COLS)
    return np.stack([((p * 37 + f * 101) % 4000 - 1000).reshape(ROWS, COLS) for f in range(FRAMES)]).astype('<i2')


def pixels8():
    y, x = np.mgrid[0:ROWS, 0:COLS]
    return np.stack([x * 3 + y * 2 + f * 10 for f in range(FRAMES)]).astype('u1')


def base(arr, signed):
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = CTImageStorage
    ds.file_meta.MediaStorageSOPInstanceUID = '1.2.3.4.5'
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = '1.2.3.4.5'
    ds.Modality = 'CT'
    ds.SeriesDescription = 'Phantom'
    ds.SpacingBetweenSlices = '2.5'
    ds.SeriesInstanceUID = '1.2.3.4'
    ds.ImagePositionPatient = [-10, -20, 5]
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.NumberOfFrames = FRAMES
    ds.Rows, ds.Columns = ROWS, COLS
    ds.PixelSpacing = [0.75, 0.5]
    bits = arr.dtype.itemsize * 8
    ds.BitsAllocated = ds.BitsStored = bits
    ds.HighBit = bits - 1
    ds.PixelRepresentation = 1 if signed else 0
    ds.RescaleIntercept = '0'
    ds.RescaleSlope = '1'
    ds.PixelData = arr.tobytes()
    ds['PixelData'].VR = 'OW' if bits == 16 else 'OB'
    return ds


def save(ds, name):
    path = os.path.join(HERE, name)
    ds.save_as(path, enforce_file_format=True)
    print(name, os.path.getsize(path))


def split(frame, parts):
    """Cuts one encoded frame into `parts` fragments of even length."""
    cut = (len(frame) // parts) & ~1
    return [frame[:cut], frame[cut:]] if parts == 2 else [frame]


def reencapsulate(ds, name, parts, bot):
    from pydicom.encaps import generate_frames
    frames = list(generate_frames(ds.PixelData, number_of_frames=FRAMES))
    if parts == 1:
        ds.PixelData = encapsulate(frames, has_bot=bot)
    else:
        # Hand-built: a basic offset table followed by two fragments per frame.
        import struct
        items, offsets, pos = [], [], 0
        for fr in frames:
            offsets.append(pos)
            for frag in split(fr, parts):
                frag = frag + b'\0' * (len(frag) % 2)
                items.append(struct.pack('<HHI', 0xFFFE, 0xE000, len(frag)) + frag)
                pos += 8 + len(frag)
        table = struct.pack('<%dI' % len(offsets), *offsets) if bot else b''
        ds.PixelData = (struct.pack('<HHI', 0xFFFE, 0xE000, len(table)) + table + b''.join(items)
                        + struct.pack('<HHI', 0xFFFE, 0xE0DD, 0))
    ds['PixelData'].is_undefined_length = True
    save(ds, name)


def with_gdcm(src, name, uid):
    import gdcm
    tmp = os.path.join(HERE, '_tmp.dcm')
    src.save_as(tmp, enforce_file_format=True)
    reader = gdcm.ImageReader()
    reader.SetFileName(tmp)
    assert reader.Read()
    change = gdcm.ImageChangeTransferSyntax()
    change.SetTransferSyntax(gdcm.TransferSyntax(gdcm.TransferSyntax.GetTSType(uid)))
    change.SetInput(reader.GetImage())
    assert change.Change()
    writer = gdcm.ImageWriter()
    writer.SetFileName(os.path.join(HERE, name))
    writer.SetFile(reader.GetFile())
    writer.SetImage(change.GetOutput())
    assert writer.Write()
    os.remove(tmp)
    print(name, os.path.getsize(os.path.join(HERE, name)))


ds = base(pixels16(), True)
ds.compress(RLELossless)
reencapsulate(ds, 'rle.dcm', 1, True)

ds = base(pixels16(), True)
ds.compress(JPEGLSLossless)
reencapsulate(ds, 'jpegls.dcm', 2, True)

ds = base(pixels16(), True)
ds.compress(JPEG2000Lossless)
reencapsulate(ds, 'j2k.dcm', 1, False)

with_gdcm(base(pixels16(), True), 'jpeglossless.dcm', str(JPEGLosslessSV1))
with_gdcm(base(pixels8(), False), 'jpegbaseline.dcm', str(JPEGBaseline8Bit))
