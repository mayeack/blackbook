import Foundation

/// Extracts the plain text from a chat.db `attributedBody` blob (an `NSArchiver` typedstream
/// of an NSAttributedString) without unarchiving it. `NSUnarchiver` is deprecated and raises
/// Objective-C exceptions on malformed input that Swift cannot catch, so we read bytes:
///
///   header  04 0B "streamtyped" (little-endian) | "typedstream" (big-endian)
///   ...     "NSString" <class info> 2B('+') <length> <UTF-8 bytes>
///   length  0x00-0x7F literal; 0x81 + int16; 0x82 + int32 (archive byte order)
///
/// IMsgCore (openclaw/imsg) has an equivalent parser, but it is internal to that package.
enum TypedStreamDecoder {
    private static let nsString = Array("NSString".utf8)
    private static let nsMutableString = Array("NSMutableString".utf8)
    /// Bytes searched after the class name for the '+' type tag (class version + flags).
    private static let tagWindow = 24

    static func decodeText(_ data: Data) -> String? {
        let bytes = [UInt8](data)
        guard bytes.count > 2 else { return nil }
        let littleEndian = byteOrderIsLittleEndian(bytes)

        for marker in [nsString, nsMutableString] {
            guard let at = firstIndex(of: marker, in: bytes, from: 0) else { continue }
            let start = at + marker.count
            let end = min(bytes.count, start + tagWindow)
            var i = start
            while i < end {
                if bytes[i] == 0x2B, let s = readString(bytes, lengthAt: i + 1, littleEndian: littleEndian) {
                    return s
                }
                i += 1
            }
        }
        // Fallback: the first `01 2B` pair after the header introduces the body string.
        var i = 13
        while i + 1 < bytes.count {
            if bytes[i] == 0x01, bytes[i + 1] == 0x2B {
                return readString(bytes, lengthAt: i + 2, littleEndian: littleEndian)
            }
            i += 1
        }
        return nil
    }

    private static func byteOrderIsLittleEndian(_ bytes: [UInt8]) -> Bool {
        guard bytes.count >= 13 else { return true }
        return !bytes[2..<13].elementsEqual("typedstream".utf8)
    }

    private static func readString(_ bytes: [UInt8], lengthAt index: Int, littleEndian: Bool) -> String? {
        guard index < bytes.count else { return nil }
        let head = bytes[index]
        var bodyStart = index + 1
        var length = 0
        switch head {
        case 0x00...0x7F:
            length = Int(head)
        case 0x81, 0x82:
            let width = head == 0x81 ? 2 : 4
            guard bodyStart + width <= bytes.count else { return nil }
            for k in 0..<width {
                let shift = (littleEndian ? k : width - 1 - k) * 8
                length |= Int(bytes[bodyStart + k]) << shift
            }
            bodyStart += width
        default:
            return nil
        }
        guard length >= 0, bodyStart + length <= bytes.count else { return nil }
        let slice = bytes[bodyStart..<(bodyStart + length)]
        return String(bytes: slice, encoding: .utf8) ?? String(decoding: slice, as: UTF8.self)
    }

    private static func firstIndex(of needle: [UInt8], in hay: [UInt8], from: Int) -> Int? {
        guard needle.count <= hay.count else { return nil }
        var i = from
        let last = hay.count - needle.count
        while i <= last {
            if hay[i] == needle[0] {
                var j = 1
                while j < needle.count, hay[i + j] == needle[j] { j += 1 }
                if j == needle.count { return i }
            }
            i += 1
        }
        return nil
    }
}

enum TextSource: String {
    case text
    case attributedBody
    case none
}

/// Message body resolution: `text` when it has content, else the decoded `attributedBody`.
enum MessageText {
    /// Removes U+FFFC attachment placeholders and surrounding whitespace.
    static func clean(_ raw: String) -> String {
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: raw.unicodeScalars.lazy.filter { $0 != "\u{FFFC}" })
        return String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func resolve(text: String?, attributedBody: Data?) -> (text: String?, source: TextSource) {
        if let text {
            let cleaned = clean(text)
            if !cleaned.isEmpty { return (cleaned, .text) }
        }
        if let attributedBody, !attributedBody.isEmpty, let decoded = TypedStreamDecoder.decodeText(attributedBody) {
            let cleaned = clean(decoded)
            if !cleaned.isEmpty { return (cleaned, .attributedBody) }
        }
        return (nil, .none)
    }
}
