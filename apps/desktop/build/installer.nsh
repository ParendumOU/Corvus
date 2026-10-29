; Installing over an existing Corvus keeps its shortcuts and taskbar pins. electron-builder keeps
; them only for the in-app update (--updated) when the installer lets the person choose the folder:
; running a newer Corvus-Setup by hand would otherwise unpin Corvus and make new shortcuts. Inserted
; after the folder page is defined, so that page stays; the shortcuts are still made anew when the
; person picks another folder (electron-builder keeps them only if Corvus.exe is already there).
!macro customHeader
  !ifdef allowToChangeInstallationDirectory
    !undef allowToChangeInstallationDirectory
  !endif
!macroend

; Uninstall: take Corvus out of Default apps (the entries it writes for the current user when the
; person makes it the default browser, see src/shared/default-browser.ts). An update also runs the
; old uninstaller, so the entries stay then: the new version keeps using them.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Corvus"
    DeleteRegKey HKCU "Software\Classes\CorvusURL"
    DeleteRegKey HKCU "Software\Classes\CorvusHTML"
    DeleteRegKey HKCU "Software\Classes\CorvusPDF"
    DeleteRegValue HKCU "Software\RegisteredApplications" "Corvus"
  ${endIf}
!macroend
