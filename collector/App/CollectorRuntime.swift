import Foundation
import os

private let log = Logger(subsystem: "com.blackbookdevelopment.server", category: "Collector")

/// Locations under the collector's data directory (shared with Node, mode 0700).
struct CollectorPaths {
    let dataDir: URL

    var tokenFile: URL { dataDir.appendingPathComponent("collector.token") }
    var sendLedger: URL { dataDir.appendingPathComponent("send-ledger.json") }
    var whatsappSnapshots: URL { dataDir.appendingPathComponent("snapshots/whatsapp", isDirectory: true) }

    /// `$YB_DATA_DIR` if set, else `~/Library/Application Support/Yeackbot`.
    static func production() -> CollectorPaths {
        if let override = ProcessInfo.processInfo.environment["YB_DATA_DIR"], !override.isEmpty {
            return CollectorPaths(dataDir: URL(fileURLWithPath: override, isDirectory: true))
        }
        return CollectorPaths(dataDir: URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/Yeackbot", isDirectory: true))
    }
}

/// Reloads `collector.token` when the file changes, recreating it if deleted.
final class TokenCache {
    private let url: URL
    private let lock = NSLock()
    private var cached: CollectorToken?
    private var cachedMtime: Date?

    init(url: URL) {
        self.url = url
    }

    func current() -> CollectorToken? {
        lock.lock(); defer { lock.unlock() }
        let mtime = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
        if let cached, mtime != nil, mtime == cachedMtime { return cached }
        guard let token = try? CollectorToken.loadOrCreate(at: url) else { return nil }
        cached = token
        cachedMtime = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
        return token
    }
}

/// Wires the collector services and runs the loopback API on 127.0.0.1:4321.
/// Started once from BlackbookServerApp; independent of the legacy 8765 sync server.
final class CollectorRuntime {
    static let port: UInt16 = 4321
    static let shared = CollectorRuntime()

    private let queue = DispatchQueue(label: "com.blackbookdevelopment.server.collector.runtime")
    private var server: LoopbackHTTPServer?
    private var api: CollectorAPI?
    private var restartDelay: TimeInterval = 1
    private let statusLock = NSLock()
    private var _status = "Starting"

    /// Short human-readable state for the menu bar.
    var status: String {
        statusLock.lock(); defer { statusLock.unlock() }
        return _status
    }

    private func setStatus(_ s: String) {
        statusLock.lock(); _status = s; statusLock.unlock()
    }

    func start() {
        queue.async { self.startOnQueue() }
    }

    private func startOnQueue() {
        guard server == nil else { return }
        let paths = CollectorPaths.production()
        let tokens = TokenCache(url: paths.tokenFile)
        do {
            try SecureFiles.ensurePrivateDirectory(paths.dataDir)
            guard tokens.current() != nil else { throw SecureFiles.Failure(description: "token unavailable") }
        } catch {
            setStatus("Data directory unavailable")
            log.error("collector data dir/token setup failed")
            scheduleRestart()
            return
        }

        let reader = MessageReader(db: ChatDB())
        let clock = SystemClock()
        let whatsapp = WhatsAppSnapshotter(sourceDir: WhatsAppSnapshotter.defaultSourceDir, destRoot: paths.whatsappSnapshots)
        let allowlist = RecipientAllowlist(compiledHandles: GeneratedSelfHandles.handles,
                                           ownAddresses: { try reader.ownAccountAddresses() })
        let send = SendService(allowlist: allowlist, ledger: SendLedger(fileURL: paths.sendLedger),
                               sender: MessagesSender(runner: NSAppleScriptRunner()), rows: reader, clock: clock)
        let attachments = AttachmentService(reader: reader, allowlist: allowlist)
        let health = HealthReporter(reader: reader, whatsapp: whatsapp, probe: LiveSystemProbe(), startedAt: Date())
        let api = CollectorAPI(port: Self.port, dependencies: .init(
            token: { tokens.current() }, reader: reader, contacts: SystemContactsSource(),
            whatsapp: whatsapp, send: send, attachments: attachments, health: health, now: Date.init))
        let server = LoopbackHTTPServer(port: Self.port, handler: { api.handle($0) })
        server.onStateChange = { [weak self] state in
            guard let self else { return }
            switch state {
            case let .ready(port):
                self.queue.async { self.restartDelay = 1 }
                self.setStatus("Listening on 127.0.0.1:\(port)")
                log.info("collector listening on 127.0.0.1:\(port, privacy: .public)")
            case .failed:
                self.setStatus("Listener failed; retrying")
                self.queue.async {
                    self.server?.stop()
                    self.server = nil
                    self.scheduleRestart()
                }
            default:
                break
            }
        }
        do {
            try server.start()
            self.server = server
            self.api = api
            log.info("collector compiled self handles: \(GeneratedSelfHandles.handles.count, privacy: .public)")
        } catch {
            setStatus("Listener failed; retrying")
            scheduleRestart()
        }
    }

    private func scheduleRestart() {
        let delay = restartDelay
        restartDelay = min(restartDelay * 2, 30)
        queue.asyncAfter(deadline: .now() + delay) { self.startOnQueue() }
    }
}
