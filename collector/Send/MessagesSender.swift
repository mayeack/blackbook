import Foundation

/// Outcome of handing one message to Messages.app.
enum AppleScriptOutcome: Equatable {
    case ok
    case error(number: Int, message: String)

    /// errAEEventNotPermitted: the user denied Automation → Messages for this app.
    static let automationDeniedNumber = -1743
}

/// Runs the send handler. Injected so tests never touch the real Messages app.
protocol AppleScriptRunning: AnyObject {
    func send(handle: String, text: String) -> AppleScriptOutcome
}

/// Sends through Messages.app with NSAppleScript. Arguments are passed argv-style as an
/// Apple event parameter list to a compiled handler, never spliced into script source, so
/// message text cannot inject AppleScript. The service is always the iMessage account;
/// it is never derived from the chat GUID (Tahoe's `any;` prefix is not a service).
final class NSAppleScriptRunner: AppleScriptRunning {
    static let source = """
        on yb_send(theHandle, theText)
            tell application "Messages"
                send theText to participant theHandle of (first account whose service type = iMessage)
            end tell
        end yb_send
        """

    private var compiled: NSAppleScript?

    func send(handle: String, text: String) -> AppleScriptOutcome {
        // NSAppleScript is main-thread only.
        if Thread.isMainThread { return run(handle: handle, text: text) }
        var outcome = AppleScriptOutcome.error(number: -1, message: "not run")
        DispatchQueue.main.sync { outcome = self.run(handle: handle, text: text) }
        return outcome
    }

    private func run(handle: String, text: String) -> AppleScriptOutcome {
        if compiled == nil {
            guard let script = NSAppleScript(source: Self.source) else {
                return .error(number: -2, message: "script init failed")
            }
            var compileError: NSDictionary?
            guard script.compileAndReturnError(&compileError) else {
                return Self.outcome(from: compileError)
            }
            compiled = script
        }
        guard let script = compiled else { return .error(number: -2, message: "script unavailable") }

        let args = NSAppleEventDescriptor.list()
        args.insert(NSAppleEventDescriptor(string: handle), at: 1)
        args.insert(NSAppleEventDescriptor(string: text), at: 2)
        let event = NSAppleEventDescriptor(
            eventClass: Self.fourCC("ascr"),   // kASAppleScriptSuite
            eventID: Self.fourCC("psbr"),      // kASSubroutineEvent
            targetDescriptor: nil,
            returnID: AEReturnID(kAutoGenerateReturnID),
            transactionID: AETransactionID(kAnyTransactionID))
        event.setParam(NSAppleEventDescriptor(string: "yb_send"), forKeyword: Self.fourCC("snam"))  // keyASSubroutineName
        event.setParam(args, forKeyword: AEKeyword(keyDirectObject))

        var runError: NSDictionary?
        _ = script.executeAppleEvent(event, error: &runError)
        if let runError { return Self.outcome(from: runError) }
        return .ok
    }

    private static func fourCC(_ code: String) -> UInt32 {
        code.utf8.reduce(0) { ($0 << 8) | UInt32($1) }
    }

    private static func outcome(from info: NSDictionary?) -> AppleScriptOutcome {
        let number = (info?[NSAppleScript.errorNumber] as? NSNumber)?.intValue ?? -1
        let message = (info?[NSAppleScript.errorBriefMessage] as? String) ?? "AppleScript error"
        return .error(number: number, message: message)
    }
}

/// Thin seam over the runner: the one place the collector asks Messages to send.
final class MessagesSender {
    private let runner: AppleScriptRunning

    init(runner: AppleScriptRunning) {
        self.runner = runner
    }

    func send(to handle: String, text: String) -> AppleScriptOutcome {
        runner.send(handle: handle, text: text)
    }
}
