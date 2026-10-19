import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
#if canImport(CollectorCore)
@testable import CollectorCore
#endif

/// Writes a synthetic PNG (a flat colour) where the fixture's attachment row points.
private func writePNG(_ url: URL, width: Int, height: Int) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let ctx = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                     space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    ctx.setFillColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1)
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try #require(ctx.makeImage())
    let dest = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(dest, image, nil)
    #expect(CGImageDestinationFinalize(dest))
}

/// The fixture stores `~/Library/Messages/Attachments/xx/<guid>-att<i>`; the harness root stands in for that directory.
private func fileFor(_ h: APIHarness, guid: String, index: Int = 0) -> URL {
    h.attachmentsRoot.appendingPathComponent("xx/\(guid)-att\(index)")
}

@Suite("attachment images")
struct AttachmentTests {
    @Test func readerFindsTheNthAttachmentAndItsChats() throws {
        let w = try SyntheticWorld()
        let loc = try #require(try w.reader.attachment(messageGUID: "G-ATT", index: 1))
        #expect(loc.mime == "image/png")
        #expect(loc.isSticker)
        #expect(loc.chatIdentifiers == ["+15555550101"])
        #expect(loc.filename == "~/Library/Messages/Attachments/xx/G-ATT-att1")
        #expect(try w.reader.attachment(messageGUID: "G-ATT", index: 2) == nil)
        #expect(try w.reader.attachment(messageGUID: "G-NOPE", index: 0) == nil)
    }

    @Test func selfThreadScreenshotComesBackAsADownscaledJPEG() throws {
        let h = try APIHarness()
        try h.world.fx.message(MessageSpec(guid: "G-SELFIMG", text: "yb this person", handle: h.world.me, fromMe: true,
                                           chat: h.world.selfChat, attachments: [AttachmentSpec(mime: "image/png", uti: "public.png")]))
        try writePNG(fileFor(h, guid: "G-SELFIMG"), width: 1179, height: 2556)

        let r = h.request("/v1/imessage/attachment?message_guid=G-SELFIMG&index=0&max_edge=1000")
        #expect(r.status == 200)
        let body = APIHarness.json(r)
        #expect(body["mime"] as? String == "image/jpeg")
        #expect(body["height"] as? Int == 1000)
        #expect((460...462).contains(body["width"] as? Int ?? 0))
        let b64 = try #require(body["data_base64"] as? String)
        let data = try #require(Data(base64Encoded: b64))
        #expect(data.starts(with: [0xFF, 0xD8]), "JPEG magic")
        #expect(body["bytes"] as? Int == data.count)

        // Default edge, never upscaled.
        try h.world.fx.message(MessageSpec(guid: "G-SMALL", handle: h.world.me, fromMe: true, chat: h.world.selfChat,
                                           attachments: [AttachmentSpec(mime: nil, uti: "public.png")]))
        try writePNG(fileFor(h, guid: "G-SMALL"), width: 300, height: 200)
        let small = APIHarness.json(h.request("/v1/imessage/attachment?message_guid=G-SMALL"))
        #expect(small["width"] as? Int == 300)
        #expect(small["height"] as? Int == 200)
    }

    @Test func refusesEverythingOutsideTheNoteToSelfThread() throws {
        let h = try APIHarness()
        // A DM photo (file present): not the owner's own thread.
        try writePNG(fileFor(h, guid: "G-ATT"), width: 64, height: 64)
        let dm = h.request("/v1/imessage/attachment?message_guid=G-ATT&index=0")
        #expect(dm.status == 403)
        #expect(APIHarness.errorCode(dm) == "attachment_not_allowed")

        // Self thread, but a sticker / a non-image / an undecodable file / a missing file / a path outside the root.
        try h.world.fx.message(MessageSpec(guid: "G-SELFMIX", handle: h.world.me, fromMe: true, chat: h.world.selfChat, attachments: [
            AttachmentSpec(mime: "image/png", uti: "public.png", sticker: true),
            AttachmentSpec(mime: "application/pdf", uti: "com.adobe.pdf", name: "doc.pdf"),
            AttachmentSpec(mime: "image/jpeg"),
            AttachmentSpec(mime: "image/jpeg"),
        ]))
        try writePNG(fileFor(h, guid: "G-SELFMIX", index: 0), width: 64, height: 64)
        try FileManager.default.createDirectory(at: fileFor(h, guid: "G-SELFMIX").deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not an image".utf8).write(to: fileFor(h, guid: "G-SELFMIX", index: 2))
        let codes = (0..<4).map { APIHarness.errorCode(h.request("/v1/imessage/attachment?message_guid=G-SELFMIX&index=\($0)")) }
        #expect(codes == ["attachment_not_allowed", "attachment_not_allowed", "attachment_unreadable", "attachment_not_found"])

        let service = AttachmentService(reader: h.world.reader,
                                        allowlist: RecipientAllowlist(compiledHandles: [], ownAddresses: { [] }), root: h.attachmentsRoot)
        #expect(service.fileURL("/etc/passwd") == nil)
        #expect(service.fileURL("~/Library/Messages/Attachments/../../secret") == nil)
        #expect(service.fileURL("~/Library/Messages/Attachments/ab/cd/x.png")?.path == h.attachmentsRoot.appendingPathComponent("ab/cd/x.png").path)

        // With no compiled self handles every image is refused, like every send.
        let noHandles = try APIHarness(compiledHandles: GeneratedSelfHandles.handles)
        try noHandles.world.fx.message(MessageSpec(guid: "G-SELFIMG", handle: noHandles.world.me, fromMe: true, chat: noHandles.world.selfChat,
                                                   attachments: [AttachmentSpec(mime: "image/png")]))
        try writePNG(fileFor(noHandles, guid: "G-SELFIMG"), width: 64, height: 64)
        #expect(APIHarness.errorCode(noHandles.request("/v1/imessage/attachment?message_guid=G-SELFIMG")) == "attachment_not_allowed")
    }

    @Test func validatesParameters() throws {
        let h = try APIHarness()
        #expect(h.request("/v1/imessage/attachment").status == 400)
        #expect(h.request("/v1/imessage/attachment?message_guid=G-ATT&index=10").status == 400)
        #expect(h.request("/v1/imessage/attachment?message_guid=G-ATT&max_edge=99999").status == 400)
        #expect(h.request("/v1/imessage/attachment?message_guid=G-NOPE").status == 404)
        #expect(h.request("POST", "/v1/imessage/attachment?message_guid=G-ATT").status == 405)
    }
}
