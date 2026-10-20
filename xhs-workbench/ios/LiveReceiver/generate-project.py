"""Generate the dependency-free Xcode project; run only when source membership changes."""
from pathlib import Path
import hashlib, plistlib
root=Path(__file__).parent
project=root/'LiveReceiver.xcodeproj'
(project/'xcshareddata/xcschemes').mkdir(parents=True,exist_ok=True)
def uid(s): return hashlib.sha256(s.encode()).hexdigest()[:24].upper()
files=['App/LiveReceiverApp.swift','App/ReceiverModel.swift','App/Scanner.swift','Sources/ReceiverCore/Protocol.swift']
objects=[]
def obj(key,value): objects.append(f'{uid(key)} = {{ {value} }};')
for f in files:
 obj(f,'isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "'+f+'"; sourceTree = "<group>";')
 obj('build'+f,f'isa = PBXBuildFile; fileRef = {uid(f)};')
obj('product','isa = PBXFileReference; explicitFileType = wrapper.application; path = LiveReceiver.app; sourceTree = BUILT_PRODUCTS_DIR;')
obj('rootgroup','isa = PBXGroup; children = ('+','.join(uid(f) for f in files)+','+uid('products')+'); sourceTree = "<group>";')
obj('products',f'isa = PBXGroup; children = ({uid("product")}); name = Products; sourceTree = "<group>";')
obj('sources','isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ('+','.join(uid('build'+f) for f in files)+'); runOnlyForDeploymentPostprocessing = 0;')
obj('frameworks','isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;')
obj('resources','isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;')
for level in ['project','target']:
 for config in ['Debug','Release']:
  settings=''
  if level=='project': settings='SDKROOT = iphoneos; IPHONEOS_DEPLOYMENT_TARGET = 17.0; CLANG_ENABLE_MODULES = YES;'
  else: settings='PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_BUNDLE_IDENTIFIER = com.xhsworkbench.LiveReceiver; INFOPLIST_FILE = App/Info.plist; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2"; CODE_SIGN_STYLE = Automatic; GENERATE_INFOPLIST_FILE = NO; SWIFT_OPTIMIZATION_LEVEL = '+('"-Onone"' if config=='Debug' else '"-O"')+';'
  obj(level+config,f'isa = XCBuildConfiguration; name = {config}; buildSettings = {{ {settings} }};')
 obj(level+'configs',f'isa = XCConfigurationList; buildConfigurations = ({uid(level+"Debug")},{uid(level+"Release")}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
obj('target',f'isa = PBXNativeTarget; buildConfigurationList = {uid("targetconfigs")}; buildPhases = ({uid("sources")},{uid("frameworks")},{uid("resources")}); buildRules = (); dependencies = (); name = LiveReceiver; productName = LiveReceiver; productReference = {uid("product")}; productType = "com.apple.product-type.application";')
uiFile='UITests/ReceiverUITests.swift'
obj('uifile','isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = "'+uiFile+'"; sourceTree = SOURCE_ROOT;')
obj('uibuild',f'isa = PBXBuildFile; fileRef = {uid("uifile")};')
obj('uisources',f'isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = ({uid("uibuild")}); runOnlyForDeploymentPostprocessing = 0;')
obj('uiproduct','isa = PBXFileReference; explicitFileType = wrapper.cfbundle; path = LiveReceiverUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
obj('uiproxy',f'isa = PBXContainerItemProxy; containerPortal = {uid("project")}; proxyType = 1; remoteGlobalIDString = {uid("target")}; remoteInfo = LiveReceiver;')
obj('uidep',f'isa = PBXTargetDependency; target = {uid("target")}; targetProxy = {uid("uiproxy")};')
for config in ['Debug','Release']:
 obj('ui'+config,f'isa = XCBuildConfiguration; name = {config}; buildSettings = {{ PRODUCT_NAME = "$(TARGET_NAME)"; PRODUCT_BUNDLE_IDENTIFIER = com.xhsworkbench.LiveReceiver.UITests; GENERATE_INFOPLIST_FILE = YES; SWIFT_VERSION = 5.0; TARGETED_DEVICE_FAMILY = "1,2"; TEST_TARGET_NAME = LiveReceiver; CODE_SIGN_STYLE = Automatic; }};')
obj('uiconfigs',f'isa = XCConfigurationList; buildConfigurations = ({uid("uiDebug")},{uid("uiRelease")}); defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;')
obj('uitarget',f'isa = PBXNativeTarget; buildConfigurationList = {uid("uiconfigs")}; buildPhases = ({uid("uisources")}); buildRules = (); dependencies = ({uid("uidep")}); name = LiveReceiverUITests; productName = LiveReceiverUITests; productReference = {uid("uiproduct")}; productType = "com.apple.product-type.bundle.ui-testing";')
obj('project',f'isa = PBXProject; attributes = {{ LastUpgradeCheck = 2700; }}; buildConfigurationList = {uid("projectconfigs")}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; knownRegions = (en, Base); mainGroup = {uid("rootgroup")}; productRefGroup = {uid("products")}; projectDirPath = ""; projectRoot = ""; targets = ({uid("target")},{uid("uitarget")});')
(project/'project.pbxproj').write_text('// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {\n'+'\n'.join(objects)+'\n}; rootObject = '+uid('project')+'; }\n')
(project/'xcshareddata/xcschemes/LiveReceiver.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{uid('target')}" BuildableName="LiveReceiver.app" BlueprintName="LiveReceiver" ReferencedContainer="container:LiveReceiver.xcodeproj"/></BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{uid('uitarget')}" BuildableName="LiveReceiverUITests.xctest" BlueprintName="LiveReceiverUITests" ReferencedContainer="container:LiveReceiver.xcodeproj"/></TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{uid('target')}" BuildableName="LiveReceiver.app" BlueprintName="LiveReceiver" ReferencedContainer="container:LiveReceiver.xcodeproj"/></BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES"/><AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''')
info={'CFBundleDisplayName':'Live 接收','CFBundleIdentifier':'$(PRODUCT_BUNDLE_IDENTIFIER)','CFBundleName':'$(PRODUCT_NAME)','CFBundleExecutable':'$(EXECUTABLE_NAME)','CFBundlePackageType':'APPL','CFBundleShortVersionString':'1.0','CFBundleVersion':'1','LSRequiresIPhoneOS':True,'UILaunchScreen':{},'UISupportedInterfaceOrientations':['UIInterfaceOrientationPortrait','UIInterfaceOrientationLandscapeLeft','UIInterfaceOrientationLandscapeRight'],'CFBundleURLTypes':[{'CFBundleURLName':'com.xhsworkbench.receive','CFBundleURLSchemes':['xhslive']}],'NSCameraUsageDescription':'扫描工作台的局域网 Live Photo 接收二维码。','NSLocalNetworkUsageDescription':'从同一 Wi-Fi 上的工作台下载并校验 Live Photo 文件，发送保存回执。','NSPhotoLibraryAddUsageDescription':'仅在点击保存后，将照片和配对视频添加为一张 Live Photo。','NSAppTransportSecurity':{'NSAllowsArbitraryLoads':True,'NSAllowsLocalNetworking':True}}
(root/'App/Info.plist').write_bytes(plistlib.dumps(info))
