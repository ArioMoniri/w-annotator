"""Generates highdicom_seg.dcm: a BINARY DICOM SEG written by highdicom, to check that
readDicomSeg reads what other software writes. Synthetic data only.

    pip install highdicom==0.29.0 pydicom==3.0.2 numpy
    python make_seg_fixture.py

Source: a made-up CT of 6 slices, 5 columns x 3 rows, PixelSpacing 0.9\\0.7, slices 2.5 mm apart
along +z from (-12.3, 45.6, -78.9). The mask has segment 1 "Liver" and segment 2 "Tumour":
    slice 1: (i=0,j=0)=1 (1,0)=1 (4,2)=2      slice 2: (2,1)=2 (0,2)=1      slice 4: (0,1)=1
Slices 0, 3 and 5 are empty and highdicom leaves their frames out.
"""
import os

import highdicom as hd
import numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.sr.codedict import codes
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian

HERE = os.path.dirname(os.path.abspath(__file__))
COLS, ROWS, SLICES = 5, 3, 6

images = []
for k in range(SLICES):
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta.MediaStorageSOPClassUID = CTImageStorage
    ds.file_meta.MediaStorageSOPInstanceUID = f'1.2.3.4.{k}'
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = f'1.2.3.4.{k}'
    ds.StudyInstanceUID = '1.2.3.1'
    ds.SeriesInstanceUID = '1.2.3.2'
    ds.FrameOfReferenceUID = '1.2.3.3'
    ds.Modality = 'CT'
    ds.PatientName = 'Phantom^Test'
    ds.PatientID = 'PH-1'
    ds.PatientBirthDate = ''
    ds.PatientSex = 'O'
    ds.StudyDate = '20250102'
    ds.StudyTime = '101112'
    ds.AccessionNumber = ''
    ds.ReferringPhysicianName = ''
    ds.StudyID = '1'
    ds.SeriesNumber = 1
    ds.InstanceNumber = k + 1
    ds.ImagePositionPatient = [-12.3, 45.6, -78.9 + 2.5 * k]
    ds.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    ds.PixelSpacing = [0.9, 0.7]
    ds.SliceThickness = 2.5
    ds.Rows, ds.Columns = ROWS, COLS
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.BitsAllocated = ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.PixelData = np.zeros((ROWS, COLS), dtype='<u2').tobytes()
    images.append(ds)

mask = np.zeros((SLICES, ROWS, COLS), dtype=np.uint8)
mask[1, 0, 0] = 1
mask[1, 0, 1] = 1
mask[1, 2, 4] = 2
mask[2, 1, 2] = 2
mask[2, 2, 0] = 1
mask[4, 1, 0] = 1

descriptions = [
    hd.seg.SegmentDescription(
        segment_number=n,
        segment_label=label,
        segmented_property_category=codes.SCT.Tissue,
        segmented_property_type=codes.SCT.Tissue,
        algorithm_type=hd.seg.SegmentAlgorithmTypeValues.MANUAL,
        display_color=hd.color.CIELabColor.from_rgb(*rgb) if hasattr(hd.color.CIELabColor, 'from_rgb') else None,
    )
    for n, label, rgb in [(1, 'Liver', (220, 20, 60)), (2, 'Tumour', (30, 144, 255))]
]
seg = hd.seg.Segmentation(
    source_images=images,
    pixel_array=mask,
    segmentation_type=hd.seg.SegmentationTypeValues.BINARY,
    segment_descriptions=descriptions,
    series_instance_uid='1.2.3.5',
    series_number=2,
    sop_instance_uid='1.2.3.6',
    instance_number=1,
    manufacturer='Test',
    manufacturer_model_name='Test',
    software_versions='1',
    device_serial_number='1',
    series_description='Made by highdicom',
)
path = os.path.join(HERE, 'highdicom_seg.dcm')
seg.save_as(path)
print(os.path.getsize(path), 'bytes,', seg.NumberOfFrames, 'frames')
