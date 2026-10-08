// Prints the text recognized in an image, one line per line of text (macOS Vision). Built by ocr.js on first use.
import Foundation
import Vision

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
try VNImageRequestHandler(url: url).perform([request])
for item in request.results ?? [] {
  if let text = item.topCandidates(1).first?.string { print(text) }
}
