import Foundation
import CoreGraphics
import Vision

enum Ocr {
    static func configure(_ request: VNRecognizeTextRequest) {
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]
    }

    static func lines(in image: CGImage, region: CGRect? = nil) -> [String] {
        let request = VNRecognizeTextRequest()
        configure(request)
        if let region {
            request.regionOfInterest = region
        }
        let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return []
        }
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    }

    static func lines(in pixelBuffer: CVPixelBuffer, region: CGRect?) -> [String] {
        let request = VNRecognizeTextRequest()
        configure(request)
        if let region {
            request.regionOfInterest = region
        }
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return []
        }
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    }

    static func linesInImageFile(_ path: String, region: CGRect?) throws -> [String] {
        let data = try requireFile(path)
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw NativeError.badArguments("not a readable image: \(path)")
        }
        return lines(in: image, region: region)
    }
}
