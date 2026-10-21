import CoreGraphics
import CoreText
import Foundation
import os
import Vision

private let log = Logger(subsystem: "com.blackbookdevelopment.server", category: "VisionOCR")

/// One recognized line: the top candidate's text and confidence, and its box normalized to 0–1 with the origin at
/// the TOP-left (Vision reports a bottom-left origin). Values are rounded so the wire stays short and stable.
struct OCRLine: Equatable {
    let text: String
    let confidence: Double
    let x: Double
    let y: Double
    let w: Double
    let h: Double

    init(text: String, confidence: Double, x: Double, y: Double, w: Double, h: Double) {
        self.text = text
        self.confidence = Self.rounded(Self.unit(confidence), 3)
        self.x = Self.rounded(Self.unit(x), 4)
        self.y = Self.rounded(Self.unit(y), 4)
        self.w = Self.rounded(Self.unit(w), 4)
        self.h = Self.rounded(Self.unit(h), 4)
    }

    /// From a Vision observation box (normalized, bottom-left origin), clipped to the image.
    init(text: String, confidence: Float, visionBox box: CGRect) {
        let left = Self.unit(Double(box.minX)), right = Self.unit(Double(box.maxX))
        let top = Self.unit(1 - Double(box.maxY)), bottom = Self.unit(1 - Double(box.minY))
        self.init(text: text, confidence: Double(confidence), x: left, y: top, w: max(0, right - left), h: max(0, bottom - top))
    }

    var bottom: Double { y + h }

    var json: JSON {
        .object([("text", .string(text)), ("confidence", .double(confidence)), ("x", .double(x)), ("y", .double(y)),
                 ("w", .double(w)), ("h", .double(h))])
    }

    private static func unit(_ v: Double) -> Double { v.isFinite ? min(1, max(0, v)) : 0 }
    private static func rounded(_ v: Double, _ places: Double) -> Double {
        let scale = pow(10, places)
        return (v * scale).rounded() / scale
    }
}

/// `POST /v1/vision/ocr` result: the decoded (upright) image size and its lines in reading order.
struct OCRResult: Equatable {
    let width: Int
    let height: Int
    let lines: [OCRLine]

    var fields: [(String, JSON)] {
        [("width", .num(width)), ("height", .num(height)), ("lines", .array(lines.map(\.json)))]
    }
}

/// Text recognition over image bytes; `VisionOCRService` in production, a fake where a test needs one.
protocol TextRecognizer: AnyObject {
    func recognize(imageData: Data, maxLines: Int) throws -> OCRResult
}

enum OCRLayout {
    /// Top to bottom, then left to right. Lines that overlap vertically by at least half the shorter one's height
    /// share a row (a label and its value side by side), so a few pixels of baseline jitter can't reorder them.
    static func readingOrder(_ lines: [OCRLine]) -> [OCRLine] {
        let byTop = lines.sorted { ($0.y, $0.x, $0.text) < ($1.y, $1.x, $1.text) }
        var rows: [[OCRLine]] = []
        for line in byTop {
            if let anchor = rows.last?.first {
                let overlap = min(anchor.bottom, line.bottom) - max(anchor.y, line.y)
                if overlap > 0, overlap >= 0.5 * min(anchor.h, line.h) {
                    rows[rows.count - 1].append(line)
                    continue
                }
            }
            rows.append([line])
        }
        return rows.flatMap { $0.sorted { ($0.x, $0.y, $0.text) < ($1.x, $1.y, $1.text) } }
    }
}

/// On-device text recognition with Apple Vision (`VNRecognizeTextRequest`, accurate level, language correction on,
/// automatic language detection) for the contact-screenshot pipeline (docs/design/tickets-met-at.md §3). The image
/// arrives in the request body and stays in memory: nothing is written to disk and no recognized text is logged.
/// Recognitions run one at a time (each one saturates the Neural Engine); the first one in a process loads the model
/// (~28 s cold), so the runtime warms Vision up once at launch on a background queue.
final class VisionOCRService: TextRecognizer {
    /// The OcrRequest contract (packages/shared collector v1): data_base64 ≤ 6 MiB of characters, max_lines 1–400.
    static let maxBase64Chars = 6 << 20
    static let maxLines = 400
    /// Decode caps: a long edge of 8192 px and ~40 MP, far above a phone screenshot; a header declaring more than
    /// 100 MP is refused as unreadable without decoding.
    static let maxEdge = 8192
    static let maxPixels = 40_000_000
    static let maxDeclaredPixels = 100_000_000

    private let lock = NSLock()

    func recognize(imageData: Data, maxLines: Int) throws -> OCRResult {
        try autoreleasepool {
            guard let image = ImageTranscoder.uprightImage(data: imageData, maxEdge: Self.maxEdge, maxPixels: Self.maxPixels,
                                                           maxDeclaredPixels: Self.maxDeclaredPixels) else {
                throw APIError.imageUnreadable
            }
            let lines = try serialized { try Self.lines(in: image) }
            return OCRResult(width: image.width, height: image.height,
                             lines: Array(OCRLayout.readingOrder(lines).prefix(max(0, maxLines))))
        }
    }

    /// Runs one recognition over a small rendered image so the model is loaded before the first real request (which
    /// waits on the same lock instead of loading it a second time). Logs only the outcome and the duration.
    func warmUp() {
        let started = Date()
        guard let image = TextImageRenderer.image(width: 360, height: 96, lines: [
            TextImageRenderer.Line(text: "Warm up 0123", fontSize: 32, x: 16, top: 24),
        ]) else { return }
        let ok = autoreleasepool { (try? serialized { try Self.lines(in: image) }) != nil }
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        log.info("vision warm-up \(ok ? "ok" : "failed", privacy: .public) in \(ms, privacy: .public)ms")
    }

    private func serialized<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    private static func lines(in image: CGImage) throws -> [OCRLine] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.automaticallyDetectsLanguage = true
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            log.error("vision text request failed: \(String(describing: type(of: error)), privacy: .public)")
            throw APIError.internalError("text recognition failed")
        }
        return (request.results ?? []).compactMap { observation in
            guard let top = observation.topCandidates(1).first else { return nil }
            let text = top.string.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return OCRLine(text: text, confidence: top.confidence, visionBox: observation.boundingBox)
        }
    }
}

enum Base64Payload {
    /// Standard base64; missing padding and the URL-safe alphabet are tolerated. Nil for anything else.
    static func decode(_ text: String) -> Data? {
        var s = text
        if s.contains("-") || s.contains("_") {
            s = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        }
        switch s.utf8.count % 4 {
        case 1: return nil
        case 2: s += "=="
        case 3: s += "="
        default: break
        }
        return Data(base64Encoded: s)
    }
}

/// Black-on-white text drawn with CoreText: the warm-up image above, and the synthetic screenshots the tests read.
/// `x` and `top` are pixels from the image's top-left corner.
enum TextImageRenderer {
    struct Line {
        let text: String
        let fontSize: CGFloat
        let x: CGFloat
        let top: CGFloat
    }

    static func image(width: Int, height: Int, lines: [Line]) -> CGImage? {
        guard width > 0, height > 0,
              let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        for line in lines {
            let font = CTFontCreateWithName("Helvetica" as CFString, line.fontSize, nil)
            let text = NSAttributedString(string: line.text, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1),
            ])
            ctx.textPosition = CGPoint(x: line.x, y: CGFloat(height) - line.top - CTFontGetAscent(font))
            CTLineDraw(CTLineCreateWithAttributedString(text), ctx)
        }
        return ctx.makeImage()
    }
}
