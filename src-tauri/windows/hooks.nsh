; Extra steps for the Windows installer (NSIS).
;
; A compressed NIfTI file ends in .gz. Claiming .gz would take every archive
; away from the user's archive tool, so the app is only added to the "Open with"
; list of .gz files. "WAnnotator.NIfTI" is the file class the installer creates
; for .nii (the `name` in tauri.windows.conf.json); keep the two in step.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\.gz\OpenWithProgids" "WAnnotator.NIfTI" ""
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue SHCTX "Software\Classes\.gz\OpenWithProgids" "WAnnotator.NIfTI"
!macroend
