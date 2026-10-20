import SwiftUI
import AVFoundation
struct ScannerView: UIViewControllerRepresentable {
 let onCode: (String)->Void
 func makeUIViewController(context:Context) -> ScannerController { ScannerController(onCode:onCode) }
 func updateUIViewController(_ controller:ScannerController,context:Context) {}
}
final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
 private let session=AVCaptureSession()
 private let queue=DispatchQueue(label:"live-receiver.camera")
 private let onCode:(String)->Void
 private var delivered=false
 private var closing=false
 init(onCode:@escaping(String)->Void) { self.onCode=onCode; super.init(nibName:nil,bundle:nil) }
 required init?(coder:NSCoder) { fatalError("unsupported") }
 override func viewDidLoad() {
  super.viewDidLoad(); view.backgroundColor = .black
  AVCaptureDevice.requestAccess(for:.video) { allowed in
   DispatchQueue.main.async { if allowed { self.configure() } else { self.message("请在系统设置中允许相机，或关闭此页粘贴链接。") } }
  }
 }
 private func message(_ text:String) { let label=UILabel(frame:view.bounds.insetBy(dx:25,dy:50)); label.text=text; label.numberOfLines=0; label.textColor = .white; label.autoresizingMask=[.flexibleWidth,.flexibleHeight]; view.addSubview(label) }
 private func configure() {
  guard !closing else { return }
  guard let camera=AVCaptureDevice.default(for:.video), let input=try? AVCaptureDeviceInput(device:camera), session.canAddInput(input) else { message("相机不可用，请关闭此页粘贴链接。"); return }
  session.addInput(input)
  let output=AVCaptureMetadataOutput()
  guard session.canAddOutput(output) else { return }; session.addOutput(output)
  output.setMetadataObjectsDelegate(self,queue:.main); output.metadataObjectTypes=[.qr]
  let layer=AVCaptureVideoPreviewLayer(session:session); layer.videoGravity = .resizeAspectFill; layer.frame=view.bounds; view.layer.addSublayer(layer)
  queue.async { self.session.startRunning() }
 }
 override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); view.layer.sublayers?.compactMap { $0 as? AVCaptureVideoPreviewLayer }.forEach { $0.frame=view.bounds } }
 override func viewDidDisappear(_ animated:Bool) { super.viewDidDisappear(animated); closing=true; queue.async { self.session.stopRunning() } }
 func metadataOutput(_ output:AVCaptureMetadataOutput,didOutput objects:[AVMetadataObject],from connection:AVCaptureConnection) {
  guard !delivered,let code=objects.first as? AVMetadataMachineReadableCodeObject, let value=code.stringValue else { return }
  delivered=true; queue.async { self.session.stopRunning() }; onCode(value)
 }
}
