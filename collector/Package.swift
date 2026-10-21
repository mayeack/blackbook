// swift-tools-version: 5.10
//
// Dev-only SwiftPM manifest: compiles the collector sources and runs their tests with just the
// Command Line Tools (`swift build`, `swift test` from this directory). The shipping app is
// built by Xcode from project.yml, which compiles these same sources into the BlackbookServer
// target (and the tests into BlackbookServerTests).
//
//   swift test                                   # unit tests (synthetic data only)
//   swift run yb-collector-verify                # aggregate check against the real chat.db (counts only)
//   YB_DATA_DIR=<scratch> swift run yb-collector-dev   # serve the loopback API for local end-to-end runs
import PackageDescription

let package = Package(
    name: "YeackbotCollector",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "yb-collector-verify", targets: ["CollectorVerify"]),
        .executable(name: "yb-collector-dev", targets: ["CollectorDev"]),
    ],
    targets: [
        .target(
            name: "CollectorCore",
            path: ".",
            exclude: ["Tests", "Tools", "Generated/SelfHandles.example.swift", "run-tests.sh"],
            // The fallback (empty) self-handle list; SelfHandles.generated.swift is app-only.
            sources: ["API", "App", "Calls", "Contacts", "Core", "Generated/SelfHandlesFallback.swift", "Health", "HTTP",
                      "IMessage", "Send", "WhatsApp"]
        ),
        .executableTarget(
            name: "CollectorVerify",
            dependencies: ["CollectorCore"],
            path: "Tools/verify"
        ),
        .executableTarget(
            name: "CollectorDev",
            dependencies: ["CollectorCore"],
            path: "Tools/dev"
        ),
        .testTarget(
            name: "CollectorTests",
            dependencies: ["CollectorCore"],
            path: "Tests/CollectorTests"
        ),
    ]
)
