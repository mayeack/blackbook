import SwiftUI

@main
struct BlackbookServerApp: App {
    @State private var model = ServerStatusModel()

    var body: some Scene {
        MenuBarExtra("Blackbook Server", systemImage: "server.rack") {
            ServerMenuView(model: model)
        }
        .menuBarExtraStyle(.window)
    }
}
