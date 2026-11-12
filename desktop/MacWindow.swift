import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let targetURL: URL

    init(url: URL) {
        self.targetURL = url
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let screenRect = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        let width = min(1320, screenRect.width * 0.9)
        let height = min(820, screenRect.height * 0.88)
        let originX = screenRect.origin.x + (screenRect.width - width) / 2
        let originY = screenRect.origin.y + (screenRect.height - height) / 2

        window = NSWindow(
            contentRect: NSRect(x: originX, y: originY, width: width, height: height),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "StudioStream Mixer — OBS & TikTok Live Studio Console"
        window.backgroundColor = NSColor(calibratedRed: 0.098, green: 0.110, blue: 0.133, alpha: 1.0)
        window.minSize = NSSize(width: 820, height: 520)
        window.delegate = self

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        window.contentView?.addSubview(webView)
        webView.load(URLRequest(url: targetURL))

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

let urlString = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "http://127.0.0.1:8780"
guard let url = URL(string: urlString) else {
    fputs("Invalid URL: \(urlString)\n", stderr)
    exit(1)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate(url: url)
app.delegate = delegate
app.run()
