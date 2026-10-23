import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Where one chat.db attachment lives, and which chats its message is in.
struct AttachmentLocation: Equatable {
    let filename: String?
    let mime: String?
    let uti: String?
    let bytes: Int64
    let isSticker: Bool
    let chatIdentifiers: [String]

    var isImage: Bool {
        if let mime, mime.lowercased().hasPrefix("image/") { return true }
        if let uti, let type = UTType(uti) { return type.conforms(to: .image) }
        return false
    }
}

/// A downscaled JPEG of an image attachment (what the command pipeline shows the model).
struct AttachmentImage {
    let data: Data
    let width: Int
    let height: Int

    var fields: [(String, JSON)] {
        [
            ("mime", .string("image/jpeg")),
            ("width", .num(width)),
            ("height", .num(height)),
            ("bytes", .num(data.count)),
            ("data_base64", .string(data.base64EncodedString())),
        ]
    }
}

/// ImageIO decode (PNG, JPEG, HEIC, WebP, …) → orientation-corrected image whose long edge is at most `maxEdge`
/// (never upscaled), as a JPEG (attachments) or a CGImage (Vision OCR). Nil when the bytes aren't a decodable image.
enum ImageTranscoder {
    static let defaultMaxEdge = 1568

    static func jpeg(contentsOf url: URL, maxEdge: Int, quality: Double = 0.8) -> AttachmentImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = upright(source, maxEdge: maxEdge) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return AttachmentImage(data: out as Data, width: image.width, height: image.height)
    }

    /// In-memory bytes → upright CGImage, decoded at most `maxEdge` on the long side and, when the original has more
    /// than `maxPixels` pixels, scaled down to about that area. An image whose header declares more than
    /// `maxDeclaredPixels` is refused before any decode (a decompression bomb: ImageIO may decode a PNG in full
    /// before scaling it). Nothing touches disk.
    static func uprightImage(data: Data, maxEdge: Int, maxPixels: Int, maxDeclaredPixels: Int = 100_000_000) -> CGImage? {
        guard !data.isEmpty,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) > 0 else { return nil }
        var edge = maxEdge
        if let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
           let h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue, w > 0, h > 0 {
            guard w * h <= Double(maxDeclaredPixels) else { return nil }
            let long = max(w, h)
            let fit = w * h > Double(maxPixels) ? long * (Double(maxPixels) / (w * h)).squareRoot() : long
            edge = max(1, min(maxEdge, Int(fit.rounded(.down))))
        }
        return upright(source, maxEdge: edge)
    }

    /// The first frame, orientation applied, long edge ≤ `maxEdge` (ImageIO never upscales a thumbnail).
    private static func upright(_ source: CGImageSource, maxEdge: Int) -> CGImage? {
        guard CGImageSourceGetCount(source) > 0 else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}

/// `GET /v1/imessage/attachment` (architecture.md §1a): one image attachment of a message in the owner's
/// note-to-self thread, downscaled to JPEG, so a self-thread command can carry a screenshot to the intent step.
/// Fails closed: only messages in a chat whose identifier is one of the owner's own handles (the send allowlist:
/// compiled self handles that chat.db also shows as this Mac's addresses), only images (no stickers), only files
/// under Messages' attachments directory. Node never gets a path or raw file bytes.
final class AttachmentService {
    static let chatDBPrefix = "~/Library/Messages/Attachments/"
    /// Larger originals are refused before decoding.
    static let maxSourceBytes: Int64 = 50 << 20

    private let reader: MessageReader
    private let allowlist: RecipientAllowlist
    private let root: URL

    init(reader: MessageReader, allowlist: RecipientAllowlist,
         root: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Messages/Attachments", isDirectory: true)) {
        self.reader = reader
        self.allowlist = allowlist
        self.root = root.standardizedFileURL
    }

    func image(messageGUID: String, index: Int, maxEdge: Int) throws -> AttachmentImage {
        guard let loc = try reader.attachment(messageGUID: messageGUID, index: index) else { throw APIError.attachmentNotFound }
        guard loc.chatIdentifiers.contains(where: allowlist.allows) else { throw APIError.attachmentNotAllowed("not in the note-to-self thread") }
        guard loc.isImage, !loc.isSticker else { throw APIError.attachmentNotAllowed("not an image") }
        guard loc.bytes <= Self.maxSourceBytes else { throw APIError.attachmentNotAllowed("too large") }
        guard let filename = loc.filename, let url = fileURL(filename) else { throw APIError.attachmentNotFound }
        guard FileManager.default.isReadableFile(atPath: url.path) else { throw APIError.attachmentNotFound }
        guard let image = ImageTranscoder.jpeg(contentsOf: url, maxEdge: maxEdge) else { throw APIError.attachmentUnreadable }
        return image
    }

    /// chat.db's `~/Library/Messages/Attachments/…` (or the same path spelled out) under `root`; nil otherwise.
    func fileURL(_ filename: String) -> URL? {
        let rel: Substring
        if filename.hasPrefix(Self.chatDBPrefix) {
            rel = filename.dropFirst(Self.chatDBPrefix.count)
        } else if filename.hasPrefix(root.path + "/") {
            rel = filename.dropFirst(root.path.count + 1)
        } else {
            return nil
        }
        let parts = rel.split(separator: "/")
        guard !parts.isEmpty, !parts.contains(where: { $0 == ".." || $0 == "." }) else { return nil }
        return root.appendingPathComponent(String(rel))
    }
}
