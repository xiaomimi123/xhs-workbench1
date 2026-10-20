import SwiftUI
import PhotosUI
@main struct LiveReceiverApp: App {
 @StateObject private var model = ReceiverModel()
 var body: some Scene { WindowGroup { ReceiverView(model:model).onOpenURL { url in Task { await model.receive(url.absoluteString) } } } }
}
struct ReceiverView: View {
 @ObservedObject var model: ReceiverModel
 @State private var scanner=false
 @FocusState private var linkFocused: Bool
 var body: some View {
  NavigationStack {
   ScrollView {
    VStack(spacing:20) {
     Image(systemName:"livephoto").font(.system(size:48)).foregroundStyle(.blue)
     Text("从工作台接收 Live Photo").font(.title2.bold())
     Text("照片和视频仅在当前局域网传输。保存为一张 Live Photo，不会发布内容。").foregroundStyle(.secondary)
     TextField("粘贴接收链接",text:$model.link).focused($linkFocused).textFieldStyle(.roundedBorder).textInputAutocapitalization(.never).autocorrectionDisabled()
     HStack {
      Button("扫码") { scanner=true }.buttonStyle(.bordered)
      PasteButton(payloadType:String.self) { strings in if let text=strings.first { model.link=text } }
      Button("接收") { linkFocused=false; Task { await model.receive(model.link) } }.buttonStyle(.borderedProminent)
     }.disabled(model.busy)
     if model.busy { ProgressView() }
     if let photo=model.livePhoto { LivePreview(photo:photo).frame(height:360).clipShape(RoundedRectangle(cornerRadius:16)) }
     Text(model.status).frame(maxWidth:.infinity,alignment:.leading).accessibilityIdentifier("receiver-status")
     if model.livePhoto != nil && !model.saved {
      Button("保存到相册") { Task { await model.save() } }.buttonStyle(.borderedProminent).disabled(model.busy)
     }
     if model.receiptPending { Button("重试保存回执") { Task { await model.retryReceipt() } }.disabled(model.busy) }
    }.padding()
   }.navigationTitle(model.title).navigationBarTitleDisplayMode(.inline)
   .onChange(of:model.busy) { _, busy in if busy { linkFocused=false } }
   .sheet(isPresented:$scanner) { ScannerView { value in scanner=false; model.link=value; Task { await model.receive(value) } } }
  }
 }
}
struct LivePreview: UIViewRepresentable {
 let photo: PHLivePhoto
 func makeUIView(context:Context) -> PHLivePhotoView { let v=PHLivePhotoView(); v.contentMode = .scaleAspectFit; return v }
 func updateUIView(_ view:PHLivePhotoView,context:Context) { view.livePhoto=photo }
}
