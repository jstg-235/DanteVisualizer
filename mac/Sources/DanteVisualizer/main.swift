import AppKit
import WebKit

// Dante Visualizer: a Mac window around the diagram. The engine (Engine.swift) runs the
// local diagram server and the metering helper. This file is the window, menus and
// the bits of WebKit glue a browser normally provides (file open/save dialogs).

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    let engine = Engine()
    var window: NSWindow!
    var web: WKWebView!
    var meteringItem: NSMenuItem!
    var quitting = false

    private var meteringPref: Bool {
        get { UserDefaults.standard.object(forKey: "metering") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "metering") }
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenus()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()        // keeps saved layouts between launches
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 880),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Dante Visualizer"
        window.contentView = web
        window.minSize = NSSize(width: 640, height: 420)
        window.center()
        window.setFrameAutosaveName("MainWindow")
        window.makeKeyAndOrderFront(nil)

        showStatus("Starting…", detail: "Looking for Dante devices.")
        engine.onState = { [weak self] state in self?.engineChanged(state) }
        engine.start(metering: meteringPref)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    /// Quit waits for the metering helper to send "stop metering" to every device.
    func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return .terminateNow }
        quitting = true
        showStatus("Stopping…", detail: "Telling devices to stop sending levels.")
        engine.stop { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    // MARK: engine state

    private func engineChanged(_ state: Engine.State) {
        switch state {
        case .idle, .starting:
            showStatus("Starting…", detail: "Looking for Dante devices.")
        case .settingUp(let msg):
            showStatus("Setting up (first launch only)", detail: msg)
        case .running:
            web.load(URLRequest(url: engine.url))
            meteringItem.state = engine.meteringOn ? .on : .off
        case .failed(let msg):
            showStatus("Something went wrong", detail: msg + "\n\nLogs: " + engine.logsDir.path, error: true)
        }
    }

    private func showStatus(_ title: String, detail: String, error: Bool = false) {
        let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let html = """
        <!doctype html><meta charset="utf-8"><style>
        :root{color-scheme:light dark}
        body{font:15px -apple-system,system-ui;display:grid;place-content:center;height:100vh;margin:0;text-align:center;
             background:Canvas;color:CanvasText;padding:24px}
        h1{font-size:20px;margin:0 0 8px}p{color:GrayText;white-space:pre-wrap;max-width:560px;margin:0 auto}
        .e h1{color:#dc2626}
        .spin{width:22px;height:22px;border:3px solid GrayText;border-top-color:transparent;border-radius:50%;
              margin:0 auto 16px;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(1turn)}}
        </style><body class="\(error ? "e" : "")">\(error ? "" : "<div class=spin></div>")<h1>\(esc(title))</h1><p>\(esc(detail))</p>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    // MARK: menus

    private func buildMenus() {
        let main = NSMenu()
        func menu(_ title: String, _ items: [NSMenuItem]) {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            item.submenu = m
            main.addItem(item)
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }

        menu("Dante Visualizer", [
            item("About Dante Visualizer", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Show Logs in Finder", #selector(showLogs)),
            .separator(),
            item("Hide Dante Visualizer", #selector(NSApplication.hide(_:)), "h"),
            item("Quit Dante Visualizer", #selector(NSApplication.terminate(_:)), "q"),
        ])
        menu("File", [
            item("Open Preset or Setup…", #selector(openFile), "o"),
            item("Save Setup…", #selector(saveSetup), "s"),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        menu("Edit", [
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        menu("View", [
            item("Network View", #selector(viewNetwork), "1"),
            item("Signal Flow View", #selector(viewFlow), "2"),
            .separator(),
            item("Expand or Collapse All Channels", #selector(toggleAll), "e"),
            item("Auto Layout", #selector(autoLayout), "l"),
            item("Zoom to Fit", #selector(fit), "0"),
            .separator(),
            item("Reload", #selector(reload), "r"),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        meteringItem = item("Live Signal Levels", #selector(toggleMetering), "m", [.command, .shift])
        meteringItem.state = meteringPref ? .on : .off
        menu("Signal", [meteringItem])
        let windowMenu = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        windowMenu.submenu = NSMenu(title: "Window")
        windowMenu.submenu!.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        main.addItem(windowMenu)
        NSApp.windowsMenu = windowMenu.submenu
        NSApp.mainMenu = main
    }

    /// Menu commands press the matching button in the page, so the page stays the one source of behaviour.
    private func click(_ id: String) {
        web.evaluateJavaScript("document.getElementById('\(id)')?.click()")
    }
    @objc func openFile() { click("file") }
    @objc func saveSetup() { click("btn-save") }
    @objc func viewNetwork() { click("mode-network") }
    @objc func viewFlow() { click("mode-flow") }
    @objc func toggleAll() { click("btn-expand") }
    @objc func autoLayout() { click("btn-layout") }
    @objc func fit() { click("btn-fit") }
    @objc func reload() {
        if case .running = engine.state { web.load(URLRequest(url: engine.url)) }
    }
    @objc func showLogs() { NSWorkspace.shared.activateFileViewerSelecting([engine.logsDir]) }
    @objc func toggleMetering() {
        meteringPref = !engine.meteringOn
        engine.setMetering(meteringPref)
        meteringItem.state = meteringPref ? .on : .off
    }

    // MARK: WebKit glue

    // <input type=file> → open panel
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.message = "Open a Dante Controller preset (.xml) or a saved setup (.json)"
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    // "Save setup" makes a download from a blob: link → save panel
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload || action.request.url?.scheme == "blob" {
            decisionHandler(.download)
        } else if let url = action.request.url, action.navigationType == .linkActivated,
                  url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)        // outside links open in the browser
            decisionHandler(.cancel)
        } else {
            decisionHandler(.allow)
        }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.message = "Save this setup (layout, opened channels, view and network)"
        panel.beginSheetModal(for: window) { r in
            guard r == .OK, let url = panel.url else { return completionHandler(nil) }
            try? FileManager.default.removeItem(at: url)   // the panel already confirmed replacing
            completionHandler(url)
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
