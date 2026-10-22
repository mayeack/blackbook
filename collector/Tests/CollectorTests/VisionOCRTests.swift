import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
#if canImport(CollectorCore)
@testable import CollectorCore
#endif

// Synthetic screenshots only: an invented name and a fictional 555-01xx number, drawn with CoreText.

/// One Vision service for the whole test process: the first recognition loads the model, later ones reuse it.
let sharedOCR = VisionOCRService()

/// Stands in for Vision where a test is about request handling, not recognition.
final class FakeRecognizer: TextRecognizer {
    var result = OCRResult(width: 4, height: 3, lines: [])
    private(set) var calls: [(bytes: Int, maxLines: Int)] = []

    func recognize(imageData: Data, maxLines: Int) throws -> OCRResult {
        calls.append((imageData.count, maxLines))
        return result
    }
}

enum SyntheticImages {
    static func png(_ image: CGImage) throws -> Data {
        let out = NSMutableData()
        let dest = try #require(CGImageDestinationCreateWithData(out as CFMutableData, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, image, nil)
        #expect(CGImageDestinationFinalize(dest))
        return out as Data
    }

    static func jpeg(_ image: CGImage, orientation: Int) throws -> Data {
        let out = NSMutableData()
        let dest = try #require(CGImageDestinationCreateWithData(out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, image, [kCGImagePropertyOrientation: orientation] as CFDictionary)
        #expect(CGImageDestinationFinalize(dest))
        return out as Data
    }

    static let width = 900
    static let height = 600
    /// A contact-card-like screenshot: a big name near the top, a phone number below it.
    static let contactLines = [
        TextImageRenderer.Line(text: "Ada Example", fontSize: 64, x: 80, top: 120),
        TextImageRenderer.Line(text: "+1 212 555 0142", fontSize: 48, x: 80, top: 330),
    ]

    static func contactScreenshot() throws -> Data {
        try png(try #require(TextImageRenderer.image(width: width, height: height, lines: contactLines)))
    }
}

private func ocrBody(_ data: Data, maxLines: Any? = nil) -> Data {
    var fields: [String: Any] = ["data_base64": data.base64EncodedString()]
    if let maxLines { fields["max_lines"] = maxLines }
    return try! JSONSerialization.data(withJSONObject: fields)
}

private func lines(_ r: LoopbackResponse) -> [[String: Any]] {
    APIHarness.json(r)["lines"] as? [[String: Any]] ?? []
}

private func number(_ line: [String: Any], _ key: String) -> Double {
    (line[key] as? NSNumber)?.doubleValue ?? -1
}

@Suite("vision OCR route", .serialized)
struct VisionOCRRouteTests {
    @Test func readsASyntheticScreenshotTopToBottomWithTopLeftCoordinates() throws {
        let heavy = CPUHeavyTests.acquire()
        defer { heavy.release() }
        let h = try APIHarness()
        let r = h.request("POST", "/v1/vision/ocr", body: ocrBody(try SyntheticImages.contactScreenshot()))
        #expect(r.status == 200)
        let body = APIHarness.json(r)
        #expect(body["api"] as? String == "v1")
        #expect(body["generated_at"] as? String == "2026-10-01T12:00:00.000Z")
        #expect(body["width"] as? Int == SyntheticImages.width)
        #expect(body["height"] as? Int == SyntheticImages.height)

        let found = lines(r)
        try #require(found.count == 2, "lines: \(found.count)")
        #expect(found[0]["text"] as? String == "Ada Example")
        #expect((found[1]["text"] as? String)?.filter(\.isNumber) == "12125550142")
        for line in found {
            for key in ["confidence", "x", "y", "w", "h"] {
                #expect((0...1).contains(number(line, key)), "\(key) in 0–1")
            }
            #expect(number(line, "confidence") > 0.3)
            #expect(number(line, "x") + number(line, "w") <= 1.0001)
            #expect(number(line, "y") + number(line, "h") <= 1.0001)
        }
        // Drawn at x = 80 px of 900, glyph tops ~120 and ~330 px of 600 (origin top-left, not Vision's bottom-left).
        let name = found[0], phone = found[1]
        #expect(abs(number(name, "x") - 80.0 / 900) < 0.03)
        #expect(abs(number(phone, "x") - 80.0 / 900) < 0.03)
        #expect(abs(number(name, "y") - 120.0 / 600) < 0.06)
        #expect(abs(number(phone, "y") - 330.0 / 600) < 0.06)
        #expect(number(name, "y") + number(name, "h") < number(phone, "y"), "the name sits above the phone")
        #expect(number(name, "h") > 0.05 && number(name, "h") < 0.2)
        #expect(number(name, "w") > 0.25)
    }

    @Test func maxLinesKeepsTheTopLines() throws {
        let heavy = CPUHeavyTests.acquire()
        defer { heavy.release() }
        let h = try APIHarness()
        let r = h.request("POST", "/v1/vision/ocr", body: ocrBody(try SyntheticImages.contactScreenshot(), maxLines: 1))
        #expect(r.status == 200)
        #expect(lines(r).compactMap { $0["text"] as? String } == ["Ada Example"])
    }

    @Test func blankImageHasNoLines() throws {
        let heavy = CPUHeavyTests.acquire()
        defer { heavy.release() }
        let h = try APIHarness()
        let blank = try SyntheticImages.png(try #require(TextImageRenderer.image(width: 300, height: 200, lines: [])))
        let r = h.request("POST", "/v1/vision/ocr", body: ocrBody(blank))
        #expect(r.status == 200)
        #expect(APIHarness.json(r)["lines"] as? [Any] != nil)
        #expect(lines(r).isEmpty)
        #expect(APIHarness.json(r)["width"] as? Int == 300)
    }

    @Test func undecodableBytesAre422ImageUnreadable() throws {
        let heavy = CPUHeavyTests.acquire()
        defer { heavy.release() }
        let h = try APIHarness()
        for bytes in [Data("not an image at all".utf8), Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00])] {
            let r = h.request("POST", "/v1/vision/ocr", body: ocrBody(bytes))
            #expect(r.status == 422)
            #expect(APIHarness.errorCode(r) == "image_unreadable")
        }
        #expect(throws: APIError.imageUnreadable) { try sharedOCR.recognize(imageData: Data(), maxLines: 10) }
    }

    @Test func validatesTheRequestBeforeRecognizing() throws {
        let fake = FakeRecognizer()
        let h = try APIHarness(ocr: fake)
        func post(_ json: String, headers: [String: String] = [:]) -> LoopbackResponse {
            h.request("POST", "/v1/vision/ocr", headers: headers, body: Data(json.utf8))
        }
        let get = h.request("/v1/vision/ocr")
        #expect(get.status == 405)
        #expect(get.headers.contains { $0 == ("Allow", "POST") })
        #expect(post("{}").status == 400)
        #expect(post("{\"data_base64\":\"\"}").status == 400)
        #expect(post("{\"data_base64\":42}").status == 400)
        #expect(post("{\"data_base64\":\"@@@@\"}").status == 400)
        #expect(post("{\"data_base64\":\"QUJD\"}", headers: ["Content-Type": "text/plain"]).status == 400)
        for bad in ["0", "401", "\"3\"", "2.5", "true"] {
            #expect(post("{\"data_base64\":\"QUJD\",\"max_lines\":\(bad)}").status == 400, "max_lines \(bad)")
        }
        let huge = post("{\"data_base64\":\"" + String(repeating: "A", count: VisionOCRService.maxBase64Chars + 4) + "\"}")
        #expect(huge.status == 413)
        #expect(APIHarness.errorCode(huge) == "payload_too_large")
        #expect(fake.calls.isEmpty)

        fake.result = OCRResult(width: 4, height: 3, lines: [OCRLine(text: "Ada", confidence: 0.9, x: 0.1, y: 0.2, w: 0.3, h: 0.1)])
        let ok = post("{\"data_base64\":\"QUJD\",\"max_lines\":7}")
        #expect(ok.status == 200)
        #expect(fake.calls.count == 1)
        #expect(fake.calls.first?.bytes == 3)
        #expect(fake.calls.first?.maxLines == 7)
        #expect(post("{\"data_base64\":\"QUJD\",\"max_lines\":null}").status == 200)
        #expect(fake.calls.last?.maxLines == VisionOCRService.maxLines)
        #expect(lines(ok).first?["text"] as? String == "Ada")
    }
}

@Suite("vision OCR pieces")
struct VisionOCRUnitTests {
    @Test func visionBoxesFlipToATopLeftOriginAndClip() {
        let line = OCRLine(text: "x", confidence: 0.87654, visionBox: CGRect(x: 0.1, y: 0.7, width: 0.5, height: 0.1))
        #expect(line == OCRLine(text: "x", confidence: 0.877, x: 0.1, y: 0.2, w: 0.5, h: 0.1))
        let spill = OCRLine(text: "y", confidence: 1.2, visionBox: CGRect(x: -0.05, y: 0.95, width: 0.3, height: 0.1))
        #expect(spill.x == 0)
        #expect(spill.y == 0)
        #expect(spill.w == 0.25)
        #expect(spill.h == 0.05)
        #expect(spill.confidence == 1)
        #expect(line.json == .object([("text", .string("x")), ("confidence", .double(0.877)), ("x", .double(0.1)), ("y", .double(0.2)),
                                      ("w", .double(0.5)), ("h", .double(0.1))]))
    }

    @Test func readingOrderIsRowsThenLeftToRight() {
        func l(_ t: String, _ x: Double, _ y: Double, h: Double = 0.04) -> OCRLine {
            OCRLine(text: t, confidence: 1, x: x, y: y, w: 0.2, h: h)
        }
        // "Mobile" and its value share a row despite a 1 px baseline jitter; the title is above both.
        let shuffled = [l("value", 0.5, 0.401), l("Footer", 0.1, 0.9), l("Mobile", 0.1, 0.405), l("Title", 0.3, 0.1, h: 0.08),
                        l("next", 0.1, 0.46)]
        #expect(OCRLayout.readingOrder(shuffled).map(\.text) == ["Title", "Mobile", "value", "next", "Footer"])
        #expect(OCRLayout.readingOrder([]).isEmpty)
    }

    @Test func base64AcceptsMissingPaddingAndURLSafe() {
        #expect(Base64Payload.decode("QUJD") == Data("ABC".utf8))
        #expect(Base64Payload.decode("QUI") == Data("AB".utf8))
        #expect(Base64Payload.decode("QQ") == Data("A".utf8))
        let bytes = Data([0xFB, 0xFF, 0xBF])
        #expect(Base64Payload.decode(bytes.base64EncodedString()) == bytes)
        let urlSafe = bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        #expect(Base64Payload.decode(urlSafe) == bytes)
        #expect(Base64Payload.decode("Q") == nil)
        #expect(Base64Payload.decode("QU!D") == nil)
    }

    @Test func decodeAppliesOrientationAndCapsArea() throws {
        let image = try #require(TextImageRenderer.image(width: 200, height: 100, lines: []))
        let rotated = try SyntheticImages.jpeg(image, orientation: 6) // 90° clockwise: displayed 100 × 200
        let upright = try #require(ImageTranscoder.uprightImage(data: rotated, maxEdge: 8192, maxPixels: 40_000_000))
        #expect(upright.width == 100)
        #expect(upright.height == 200)
        let capped = try #require(ImageTranscoder.uprightImage(data: try SyntheticImages.png(image), maxEdge: 8192, maxPixels: 5_000))
        #expect(capped.width * capped.height <= 5_000)
        #expect(capped.width == 100)
        let edged = try #require(ImageTranscoder.uprightImage(data: try SyntheticImages.png(image), maxEdge: 50, maxPixels: 40_000_000))
        #expect(edged.width == 50)
        #expect(ImageTranscoder.uprightImage(data: Data("nope".utf8), maxEdge: 100, maxPixels: 100) == nil)
        // A header declaring more than the ceiling is refused before decoding (200 × 100 = 20,000 px).
        let png = try SyntheticImages.png(image)
        #expect(ImageTranscoder.uprightImage(data: png, maxEdge: 8192, maxPixels: 5_000, maxDeclaredPixels: 19_999) == nil)
        #expect(ImageTranscoder.uprightImage(data: png, maxEdge: 8192, maxPixels: 5_000, maxDeclaredPixels: 20_000) != nil)
        #expect(VisionOCRService.maxDeclaredPixels > VisionOCRService.maxPixels)
    }

    @Test func warmUpRecognizesWithoutThrowing() {
        let heavy = CPUHeavyTests.acquire()
        defer { heavy.release() }
        sharedOCR.warmUp()
    }
}
