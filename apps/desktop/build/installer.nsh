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
