import Foundation
import Network
import os

private let log = Logger(subsystem: "com.blackbookdevelopment.server", category: "LoopbackHTTP")

/// Minimal HTTP/1.1 server bound to 127.0.0.1 only (extracted from BackupServer's console
/// listener). One request per connection; the handler runs off the I/O queue so a slow route
/// (send verification polls for up to ~8 s) never blocks other connections.
final class LoopbackHTTPServer: @unchecked Sendable {
    typealias Handler = (LoopbackRequest) -> LoopbackResponse

    enum State: Equatable {
        case idle, ready(UInt16), failed(String), cancelled
    }

    let requestedPort: UInt16
    let limits: HTTPLimits
    private let handler: Handler
    private let ioQueue = DispatchQueue(label: "com.blackbookdevelopment.server.loopback.io")
    private let workQueue = DispatchQueue(label: "com.blackbookdevelopment.server.loopback.work",
                                          attributes: .concurrent)
    private var listener: NWListener?
    private var activeConnections = 0
    private let stateLock = NSLock()
    private var _state: State = .idle
    var onStateChange: ((State) -> Void)?

    var state: State {
        stateLock.lock(); defer { stateLock.unlock() }
        return _state
    }

    init(port: UInt16, limits: HTTPLimits = HTTPLimits(), handler: @escaping Handler) {
        self.requestedPort = port
        self.limits = limits
        self.handler = handler
    }

    /// NW parameters that bind the listener to the loopback interface only.
    static func loopbackParameters(port: UInt16) -> NWParameters {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host("127.0.0.1"),
                                                           port: NWEndpoint.Port(rawValue: port) ?? .any)
        return params
    }

    static func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case let .hostPort(host, _) = endpoint else { return false }
        switch host {
        case let .ipv4(addr): return addr.isLoopback
        case let .ipv6(addr): return addr.isLoopback
        case let .name(name, _): return name == "localhost" || name == "127.0.0.1" || name == "::1"
        @unknown default: return false
        }
    }

    func start() throws {
        let listener = try NWListener(using: Self.loopbackParameters(port: requestedPort))
        self.listener = listener
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.setState(.ready(listener.port?.rawValue ?? self.requestedPort))
            case let .failed(error):
                log.error("listener failed: \(error.localizedDescription, privacy: .public)")
                self.setState(.failed(error.localizedDescription))
            case .cancelled:
                self.setState(.cancelled)
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        listener.start(queue: ioQueue)
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func setState(_ s: State) {
        stateLock.lock()
        _state = s
        stateLock.unlock()
        onStateChange?(s)
    }

    // MARK: Connections (all on ioQueue)

    private func accept(_ conn: NWConnection) {
        guard Self.isLoopback(conn.endpoint), activeConnections < limits.maxConcurrentConnections else {
            conn.cancel()
            return
        }
        activeConnections += 1
        let ctx = ConnectionContext(conn: conn)
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled:
                self?.finish(ctx)
            default:
                break
            }
        }
        conn.start(queue: ioQueue)
        armIdleTimer(ctx)
        receive(ctx)
    }

    private final class ConnectionContext {
        let conn: NWConnection
        var buffer = Data()
        var timer: DispatchSourceTimer?
        var finished = false
        var responding = false
        let acceptedAt = Date()
        init(conn: NWConnection) { self.conn = conn }
    }

    private func armIdleTimer(_ ctx: ConnectionContext) {
        ctx.timer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: ioQueue)
        timer.schedule(deadline: .now() + limits.idleTimeout)
        timer.setEventHandler { [weak self, weak ctx] in
            guard let self, let ctx, !ctx.responding else { return }
            self.respond(ctx, APIErrorBody.response(status: 408, code: "timeout", message: "idle timeout"))
        }
        timer.resume()
        ctx.timer = timer
    }

    private func receive(_ ctx: ConnectionContext) {
        ctx.conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self, !ctx.finished, !ctx.responding else { return }
            if let data, !data.isEmpty {
                ctx.buffer.append(data)
                self.armIdleTimer(ctx)
            }
            // Bound trickling clients too: the whole request must arrive within 2× the idle timeout.
            if Date().timeIntervalSince(ctx.acceptedAt) > 2 * self.limits.idleTimeout {
                self.respond(ctx, APIErrorBody.response(status: 408, code: "timeout", message: "request took too long"))
                return
            }
            switch HTTPRequestParser.parse(ctx.buffer, limits: self.limits) {
            case .needMore:
                if error != nil || isComplete {
                    ctx.conn.cancel()
                } else {
                    self.receive(ctx)
                }
            case let .failure(status, code, message):
                self.respond(ctx, APIErrorBody.response(status: status, code: code, message: message))
            case let .complete(request):
                ctx.responding = true
                ctx.timer?.cancel()
                self.workQueue.async {
                    let response = self.handler(request)
                    self.ioQueue.async { self.respond(ctx, response) }
                }
            }
        }
    }

    private func respond(_ ctx: ConnectionContext, _ response: LoopbackResponse) {
        guard !ctx.finished else { return }
        ctx.responding = true
        ctx.timer?.cancel()
        ctx.conn.send(content: response.encoded(), completion: .contentProcessed { _ in
            ctx.conn.cancel()
        })
    }

    private func finish(_ ctx: ConnectionContext) {
        guard !ctx.finished else { return }
        ctx.finished = true
        ctx.timer?.cancel()
        ctx.timer = nil
        ctx.conn.stateUpdateHandler = nil
        activeConnections -= 1
    }
}
