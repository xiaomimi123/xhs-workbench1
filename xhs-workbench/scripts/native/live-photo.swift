import Foundation
import AVFoundation
import ImageIO
import CoreImage
import Photos
import AppKit

func fail(_ text: String) -> Never { FileHandle.standardError.write(Data((text+"\n").utf8)); exit(1) }
func require(_ condition: Bool, _ message: String) { if !condition { fail(message) } }
let args = CommandLine.arguments
require(args.count == 3, "Usage: live-photo SOURCE.png OUTPUT_DIR")
let sourceURL = URL(fileURLWithPath: args[1]), dir = URL(fileURLWithPath: args[2], isDirectory: true)
let photoURL = dir.appendingPathComponent("photo.jpg"), movieURL = dir.appendingPathComponent("paired.mov"), previewURL = dir.appendingPathComponent("preview.mp4")
for url in [photoURL,movieURL,previewURL] { require(!FileManager.default.fileExists(atPath:url.path), "输出已存在，拒绝覆盖") }
guard let imageSource = CGImageSourceCreateWithURL(sourceURL as CFURL,nil), let cg = CGImageSourceCreateImageAtIndex(imageSource,0,nil) else { fail("无法读取来源PNG") }
let width = 1080, height = Int((Double(cg.height)/Double(cg.width)*1080/2).rounded())*2
require(height >= 512 && height <= 1920, "当前实况支持横竖比合理的图片")
let bounds = CGRect(x:0,y:0,width:width,height:height), context = CIContext(options:[.cacheIntermediates:false]), colorSpace = CGColorSpace(name:CGColorSpace.sRGB)!
let base = CIImage(cgImage:cg).transformed(by:CGAffineTransform(scaleX:CGFloat(width)/CGFloat(cg.width),y:CGFloat(height)/CGFloat(cg.height)))
func frame(_ time: Double) -> CIImage {
    let scale = 1.0 + 0.018 * (1-cos(2 * Double.pi * time/3))/2
    return base.transformed(by:CGAffineTransform(translationX:-CGFloat(width)/2,y:-CGFloat(height)/2)).transformed(by:CGAffineTransform(scaleX:scale,y:scale)).transformed(by:CGAffineTransform(translationX:CGFloat(width)/2,y:CGFloat(height)/2)).cropped(to:bounds)
}
let identifier = UUID().uuidString
// The key photo is the same middle frame used by the still-image-time track.
guard let keyImage = context.createCGImage(frame(1.5),from:bounds,format:.RGBA8,colorSpace:colorSpace), let destination = CGImageDestinationCreateWithURL(photoURL as CFURL,"public.jpeg" as CFString,1,nil) else { fail("无法创建配对照片") }
let properties: [CFString:Any] = [kCGImagePropertyMakerAppleDictionary:["17":identifier],kCGImageDestinationLossyCompressionQuality:0.96,kCGImagePropertyOrientation:1]
CGImageDestinationAddImage(destination,keyImage,properties as CFDictionary)
require(CGImageDestinationFinalize(destination),"JPEG写入失败")
let writer: AVAssetWriter
do { writer = try AVAssetWriter(outputURL:movieURL,fileType:.mov) } catch { fail(error.localizedDescription) }
let video = AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:width,AVVideoHeightKey:height,AVVideoCompressionPropertiesKey:[AVVideoAverageBitRateKey:8_000_000,AVVideoMaxKeyFrameIntervalKey:30],AVVideoColorPropertiesKey:[AVVideoColorPrimariesKey:AVVideoColorPrimaries_ITU_R_709_2,AVVideoTransferFunctionKey:AVVideoTransferFunction_ITU_R_709_2,AVVideoYCbCrMatrixKey:AVVideoYCbCrMatrix_ITU_R_709_2]])
video.expectsMediaDataInRealTime=false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:video,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferWidthKey as String:width,kCVPixelBufferHeightKey as String:height,kCVPixelBufferIOSurfacePropertiesKey as String:[:]])
require(writer.canAdd(video),"不支持视频编码");writer.add(video)
let identifierItem=AVMutableMetadataItem();identifierItem.keySpace = .quickTimeMetadata;identifierItem.key="com.apple.quicktime.content.identifier" as NSString;identifierItem.value=identifier as NSString;identifierItem.dataType=kCMMetadataBaseDataType_UTF8 as String;writer.metadata=[identifierItem]
var description: CMFormatDescription?
let specification: [String:Any] = [kCMMetadataFormatDescriptionMetadataSpecificationKey_Identifier as String:"mdta/com.apple.quicktime.still-image-time",kCMMetadataFormatDescriptionMetadataSpecificationKey_DataType as String:kCMMetadataBaseDataType_SInt8 as String]
let status = CMMetadataFormatDescriptionCreateWithMetadataSpecifications(allocator:kCFAllocatorDefault,metadataType:kCMMetadataFormatType_Boxed,metadataSpecifications:[specification] as CFArray,formatDescriptionOut:&description)
require(status == noErr,"无法创建实况时间轨")
let metadataInput=AVAssetWriterInput(mediaType:.metadata,outputSettings:nil,sourceFormatHint:description)
let metadataAdaptor=AVAssetWriterInputMetadataAdaptor(assetWriterInput:metadataInput)
require(writer.canAdd(metadataInput),"无法添加实况时间轨");writer.add(metadataInput)
require(writer.startWriting(),writer.error?.localizedDescription ?? "视频写入启动失败");writer.startSession(atSourceTime:.zero)
let still=AVMutableMetadataItem();still.keySpace = .quickTimeMetadata;still.key="com.apple.quicktime.still-image-time" as NSString;still.value=NSNumber(value:Int8(0));still.dataType=kCMMetadataBaseDataType_SInt8 as String
require(metadataAdaptor.append(AVTimedMetadataGroup(items:[still],timeRange:CMTimeRange(start:CMTime(value:45,timescale:30),duration:CMTime(value:1,timescale:30)))),"实况时间写入失败")
metadataInput.markAsFinished()
for i in 0..<90 {
    let deadline=Date().addingTimeInterval(20)
    while !video.isReadyForMoreMediaData && writer.status == .writing && Date()<deadline { Thread.sleep(forTimeInterval:0.005) }
    require(video.isReadyForMoreMediaData,"视频编码超时或失败")
    autoreleasepool {
        var buffer: CVPixelBuffer?
        guard let pool=adaptor.pixelBufferPool, CVPixelBufferPoolCreatePixelBuffer(nil,pool,&buffer)==kCVReturnSuccess, let buffer else { fail("像素缓存创建失败") }
        context.render(frame(Double(i)/30),to:buffer,bounds:bounds,colorSpace:colorSpace)
        require(adaptor.append(buffer,withPresentationTime:CMTime(value:Int64(i),timescale:30)),"视频帧写入失败")
    }
}
video.markAsFinished();writer.endSession(atSourceTime:CMTime(value:3,timescale:1))
let done=DispatchSemaphore(value:0);writer.finishWriting {done.signal()};require(done.wait(timeout:.now()+30) == .success,"视频完成超时");require(writer.status == .completed,writer.error?.localizedDescription ?? "视频编码未完成")
// Read the resulting resources back; don't equate a successful write with validity.
let asset=AVURLAsset(url:movieURL)
let storedIdentifier=asset.metadata.first(where:{$0.key as? String == "com.apple.quicktime.content.identifier"})?.stringValue
let storedSource=CGImageSourceCreateWithURL(photoURL as CFURL,nil)!
let props=CGImageSourceCopyPropertiesAtIndex(storedSource,0,nil) as? [String:Any]
let photoIdentifier=(props?[kCGImagePropertyMakerAppleDictionary as String] as? [String:Any])?["17"] as? String
require(storedIdentifier == identifier && photoIdentifier == identifier,"照片视频配对标识不一致")
guard let metadataTrack=asset.tracks(withMediaType:.metadata).first else {fail("缺少实况时间轨")}
let reader=try! AVAssetReader(asset:asset), metadataOutput=AVAssetReaderTrackOutput(track:metadataTrack,outputSettings:nil)
reader.add(metadataOutput);let metadataReader=AVAssetReaderOutputMetadataAdaptor(assetReaderTrackOutput:metadataOutput);require(reader.startReading(),"无法读取实况时间轨")
var stillTime: Double = -1
while let group=metadataReader.nextTimedMetadataGroup() {if group.items.contains(where:{$0.key as? String == "com.apple.quicktime.still-image-time"}) {stillTime=group.timeRange.start.seconds}}
require(abs(stillTime-1.5)<0.001,"实况关键帧时间不符")
let generator=AVAssetImageGenerator(asset:asset);generator.requestedTimeToleranceBefore = .zero;generator.requestedTimeToleranceAfter = .zero
func thumb(_ time:Double) -> Data {let image=try! generator.copyCGImage(at:CMTime(seconds:time,preferredTimescale:30),actualTime:nil);let small=CIImage(cgImage:image).transformed(by:CGAffineTransform(scaleX:64/CGFloat(width),y:64/CGFloat(height)));var bytes=[UInt8](repeating:0,count:64*64*4);context.render(small,toBitmap:&bytes,rowBytes:64*4,bounds:CGRect(x:0,y:0,width:64,height:64),format:.RGBA8,colorSpace:colorSpace);return Data(bytes)}
require(thumb(0) != thumb(1.5),"视频没有可检测的运动")
guard let exporter=AVAssetExportSession(asset:asset,presetName:AVAssetExportPresetHighestQuality) else {fail("无法创建预览")}
exporter.outputURL=previewURL;exporter.outputFileType = .mp4;exporter.shouldOptimizeForNetworkUse=true
let exported=DispatchSemaphore(value:0);exporter.exportAsynchronously {exported.signal()};require(exported.wait(timeout:.now()+30) == .success && exporter.status == .completed,"MP4预览导出失败")
var finished=false,recognized=false,photoError=""
PHLivePhoto.request(withResourceFileURLs:[photoURL,movieURL],placeholderImage:nil,targetSize:CGSize(width:360,height:480),contentMode:.aspectFit){ livePhoto,info in
    if (info[PHLivePhotoInfoIsDegradedKey] as? Bool) == true {return}
    recognized=livePhoto != nil;photoError=(info[PHLivePhotoInfoErrorKey] as? NSError)?.localizedDescription ?? "";finished=true
}
let deadline=Date().addingTimeInterval(30)
while !finished && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.02))}
require(recognized,"Apple PHLivePhoto识别失败："+photoError)
let report:[String:Any]=["identifier":identifier,"duration":asset.duration.seconds,"width":width,"height":height,"pairedIdentifier":true,"stillImageTime":stillTime,"appleRecognized":recognized,"motionVerified":true,"renderer":"Apple CoreImage + AVFoundation","audio":false]
let json=try! JSONSerialization.data(withJSONObject:report,options:[.prettyPrinted,.sortedKeys]);try! json.write(to:dir.appendingPathComponent("validation.json"));print(String(data:json,encoding:.utf8)!)
