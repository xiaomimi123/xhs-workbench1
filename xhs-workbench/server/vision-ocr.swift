import Foundation
import Vision
import ImageIO

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1]), options: [:])
do {
    try handler.perform([request])
    let lines: [[String: Any]] = (request.results ?? []).compactMap { item in
        guard let candidate = item.topCandidates(1).first else { return nil }
        let box = item.boundingBox
        return ["text": candidate.string, "confidence": candidate.confidence,
                "x": box.minX, "y": 1 - box.maxY, "width": box.width, "height": box.height]
    }
    let result: [String: Any] = ["engine": "apple-vision", "text": lines.map { $0["text"] as! String }.joined(separator: "\n"), "lines": lines]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
} catch {
    FileHandle.standardError.write(Data(error.localizedDescription.utf8))
    exit(1)
}
