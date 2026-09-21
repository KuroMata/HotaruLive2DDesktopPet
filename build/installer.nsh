; 自定义 NSIS 安装脚本片段（被 package.json 的 build.nsis.include 引用）
; 作用：把安装向导的【默认安装目录】设为 D:\HotaruDesktopPet\
;       用户仍可在向导里自由选择其它路径（allowToChangeInstallationDirectory: true）
;
; 原理（双向保险）：
;   1) 写入 HKLM/HKCU 下 ${INSTALL_REGISTRY_KEY} 的 InstallLocation ——
;      electron-builder 生成的 installer 在 .onInit 里会用 MULTIUSER 读取该值作为 $INSTDIR 初值。
;   2) 同时直接 StrCpy $INSTDIR —— 在目录选择页弹出前就把默认值钉死，
;      即使 MULTIUSER 没有采用注册表值也能保证默认目录正确。
;
; 注意：本安装包为每用户安装（perMachine 未开启），写入 HKLM 需管理员权限、
;       失败会被 NSIS 静默忽略；HKCU 写入即可生效，无需担心。

!macro preInit
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\HotaruDesktopPet"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\HotaruDesktopPet"
  StrCpy $INSTDIR "D:\HotaruDesktopPet"
!macroend
