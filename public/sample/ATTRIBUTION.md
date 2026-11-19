# Sample data

`chest_ct.nii.gz` and `lungs.nii.gz` are the sample the welcome tour opens: one chest CT and its lung mask from a public research dataset.

## Source

- **LUNA16** (Lung Nodule Analysis 2016), <https://luna16.grand-challenge.org/Data/>, downloaded from <https://doi.org/10.5281/zenodo.3723295> ("LUNA16 Part 1/2", B. van Ginneken and C. Jacobs, Radboud UMC). Licence: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) (CC BY 4.0).
- LUNA16 is a subset of **LIDC-IDRI**, <https://www.cancerimagingarchive.net/collection/lidc-idri/>. Licence: [Creative Commons Attribution 3.0 Unported](https://creativecommons.org/licenses/by/3.0/) (CC BY 3.0).

The image is one scan from `subset0.zip`. The mask is that scan's file from `seg-lungs-LUNA16.zip`. LUNA16 computed these lung masks with an automatic algorithm (van Rikxoort et al., 2009) and says they "are not intended to be used as the reference standard for any segmentation study". Here they are only something to look at and edit.

## Changes made

The files are not the originals. They were **cropped and downsampled** by `scripts/make-sample.mjs`:

- cropped in-plane to the body, leaving out the scanner table; every slice is kept;
- downsampled in-plane by 2, from 0.76 mm to 1.52 mm: the image by the mean of each 2 × 2 block, the mask by the most common label in it; slice spacing (2.5 mm) is unchanged;
- mask labels renumbered from 3, 4, 5 to 1, 2, 3 and named Left lung, Right lung and Airways;
- converted from MetaImage to NIfTI and given neutral file names. The files carry no series identifier.

Result: 256 × 176 × 121 voxels, 1.52 × 1.52 × 2.5 mm, int16 image and uint8 mask.

## Citations

Data citation required by The Cancer Imaging Archive:

> Armato III, S. G., McLennan, G., Bidaut, L., McNitt-Gray, M. F., Meyer, C. R., Reeves, A. P., Zhao, B., Aberle, D. R., Henschke, C. I., Hoffman, E. A., Kazerooni, E. A., MacMahon, H., Van Beek, E. J. R., Yankelevitz, D., Biancardi, A. M., Bland, P. H., Brown, M. S., Engelmann, R. M., Laderach, G. E., Max, D., Pais, R. C., Qing, D. P. Y., Roberts, R. Y., Smith, A. R., Starkey, A., Batra, P., Caligiuri, P., Farooqi, A., Gladish, G. W., Jude, C. M., Munden, R. F., Petkovska, I., Quint, L. E., Schwartz, L. H., Sundaram, B., Dodd, L. E., Fenimore, C., Gur, D., Petrick, N., Freymann, J., Kirby, J., Hughes, B., Casteele, A. V., Gupte, S., Sallam, M., Heath, M. D., Kuhn, M. H., Dharaiya, E., Burns, R., Fryd, D. S., Salganicoff, M., Anand, V., Shreter, U., Vastagh, S., Croft, B. Y., Clarke, L. P. (2015). Data From LIDC-IDRI [Data set]. The Cancer Imaging Archive. <https://doi.org/10.7937/K9/TCIA.2015.LO9QL9SX>

Publications:

> Armato SG 3rd, McLennan G, Bidaut L, et al. The Lung Image Database Consortium (LIDC) and Image Database Resource Initiative (IDRI): A completed reference database of lung nodules on CT scans. Medical Physics, 38: 915–931, 2011. <https://doi.org/10.1118/1.3528204>

> Setio AAA, Traverso A, de Bel T, et al. Validation, comparison, and combined analysis of automatic pulmonary nodule detection algorithms in computed tomography images: the LUNA16 challenge. Medical Image Analysis, 42: 1–13, 2017. <https://doi.org/10.1016/j.media.2017.06.015>

> van Rikxoort EM, de Hoop B, Viergever MA, Prokop M, van Ginneken B. Automatic lung segmentation from thoracic computed tomography scans using a hybrid approach with error detection. Medical Physics, 36(7): 2934–2947, 2009.

Acknowledgement asked for by LIDC-IDRI:

> The authors acknowledge the National Cancer Institute and the Foundation for the National Institutes of Health, and their critical role in the creation of the free publicly available LIDC/IDRI Database used in this study.

## Licence of these files

The two files are shared under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), with the attribution above. That licence covers these files only, not the app.
