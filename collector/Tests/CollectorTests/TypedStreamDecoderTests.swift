import Foundation
import Testing
#if canImport(CollectorCore)
@testable import CollectorCore
#endif

@Suite("attributedBody decoding")
struct TypedStreamDecoderTests {
    @Test("NSArchiver blobs round-trip at every length encoding", arguments: [
        "hi",
        "Dinner at Maple & Rye on Friday?",
        String(repeating: "a", count: 127),                       // largest 1-byte literal length
        String(repeating: "b", count: 128),                       // 0x81 + int16
        String(repeating: "c", count: 40_000),                    // still int16 range
        String(repeating: "d", count: 70_000),                    // 0x82 + int32
        "Émojis 🎉 and accents ñ — multi-byte UTF-8 ✓",
        "line one\nline two",
    ])
    func roundTrip(_ text: String) {
        let blob = AttributedBody.blob(text)
        #expect(blob.starts(with: [0x04, 0x0B]))
        #expect(TypedStreamDecoder.decodeText(blob) == text)
    }

    @Test func attributesDoNotLeakIntoText() {
        let blob = AttributedBody.blob("see https://example.com/x", link: true)
        #expect(TypedStreamDecoder.decodeText(blob) == "see https://example.com/x")
    }

    @Test func objectReplacementIsStrippedForAttachmentOnlyBodies() {
        let blob = AttributedBody.blob("\u{FFFC}")
        #expect(TypedStreamDecoder.decodeText(blob) == "\u{FFFC}")
        let resolved = MessageText.resolve(text: nil, attributedBody: blob)
        #expect(resolved.text == nil)
        #expect(resolved.source == .none)

        let mixed = MessageText.resolve(text: nil, attributedBody: AttributedBody.blob("\u{FFFC}look at this"))
        #expect(mixed.text == "look at this")
        #expect(mixed.source == .attributedBody)
    }

    @Test func textColumnWinsWhenNonEmpty() {
        let r = MessageText.resolve(text: "from text", attributedBody: AttributedBody.blob("from body"))
        #expect(r.text == "from text")
        #expect(r.source == .text)
        let blank = MessageText.resolve(text: "  \u{FFFC} ", attributedBody: AttributedBody.blob("from body"))
        #expect(blank.text == "from body")
        #expect(blank.source == .attributedBody)
    }

    /// Typed once: the inline `[0x04, 0x0B] + Array(…) + …` literals timed out the type checker.
    static let streamString: [UInt8] = [0x04, 0x0B] + Array("streamtyped".utf8) + Array("NSString".utf8)

    @Test("malformed input never crashes and yields nil", arguments: [
        Data(),
        Data([0x04, 0x0B]),
        Data("streamtyped".utf8),
        Data(streamString + [0x01, 0x94, 0x84, 0x01, 0x2B, 0x81, 0xFF]),
        Data(streamString + [0x01, 0x2B, 0x7F, 0x41]),
        Data(streamString + [0x01, 0x2B, 0x85]),
    ] as [Data])
    func malformed(_ data: Data) {
        #expect(TypedStreamDecoder.decodeText(data) == nil)
    }

    @Test func truncatedRealBlobIsRejected() {
        let blob = AttributedBody.blob(String(repeating: "x", count: 300))
        #expect(TypedStreamDecoder.decodeText(blob.prefix(60)) == nil)
    }

    @Test func handCraftedLittleEndianLengths() {
        let header: [UInt8] = [0x04, 0x0B] + Array("streamtyped".utf8) + [0x81, 0xE8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84]
        let prefix: [UInt8] = header + Array("NSString".utf8) + [0x01, 0x94, 0x84, 0x01, 0x2B]
        let short = Data(prefix + [0x03] + Array("abc".utf8))
        #expect(TypedStreamDecoder.decodeText(short) == "abc")
        let body = [UInt8](repeating: 0x7A, count: 300)
        let medium = Data(prefix + [0x81, 0x2C, 0x01] + body)
        #expect(TypedStreamDecoder.decodeText(medium) == String(repeating: "z", count: 300))
    }
}
