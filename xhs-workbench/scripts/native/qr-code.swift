import Foundation
import CoreImage
import ImageIO
let args=CommandLine.arguments
guard args.count==2,args[1].utf8.count<3000,let filter=CIFilter(name:"CIQRCodeGenerator") else {exit(1)}
filter.setValue(Data(args[1].utf8),forKey:"inputMessage");filter.setValue("M",forKey:"inputCorrectionLevel")
guard let qr=filter.outputImage else {exit(1)}
let enlarged=qr.transformed(by:CGAffineTransform(scaleX:8,y:8)),border:CGFloat=32
let canvas=enlarged.extent.insetBy(dx:-border,dy:-border)
let white=CIImage(color:CIColor(red:1,green:1,blue:1)).cropped(to:canvas)
let context=CIContext();guard let cg=context.createCGImage(enlarged.composited(over:white),from:canvas) else {exit(1)}
let data=NSMutableData();guard let dest=CGImageDestinationCreateWithData(data,"public.png" as CFString,1,nil) else {exit(1)}
CGImageDestinationAddImage(dest,cg,nil);guard CGImageDestinationFinalize(dest) else {exit(1)}
FileHandle.standardOutput.write(data as Data)
