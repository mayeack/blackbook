// Dev-only: runs the collector loopback API (127.0.0.1:4321) from a SwiftPM build, so the Node
// pipeline can be exercised end to end without Xcode or installing the app. Set YB_DATA_DIR to a
// scratch directory so the token and snapshots stay out of the production data dir. Sends are
// refused here: SwiftPM builds compile the empty fallback self-handle list.
//
//   YB_DATA_DIR=/tmp/yb-dev swift run yb-collector-dev
@testable import CollectorCore
import Foundation

CollectorRuntime.shared.start()
print("yb-collector-dev: serving 127.0.0.1:\(CollectorRuntime.port); token in $YB_DATA_DIR/collector.token")
dispatchMain()
