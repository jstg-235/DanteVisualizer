import Foundation

/// Runs the Python side of the app: the diagram server (which also refreshes the
/// network snapshot) and the metering helper. Everything is read-only towards the
/// devices except the metering start/stop requests the helper sends.
///
/// Layout:
///   <App>.app/Contents/Resources/engine/   web/, server/, probe/, requirements.txt (read-only)
///   ~/Library/Application Support/Dante Visualizer/
///       venv/        Python environment with netaudio, made on first launch
///       data/        live_snapshot.json, levels.json
///       logs/        server.log, meter.log, setup.log
final class Engine {
    enum State: Equatable { case idle, settingUp(String), starting, running, failed(String) }

    let engineDir: URL
    let supportDir: URL
    var dataDir: URL { supportDir.appendingPathComponent("data") }
    var logsDir: URL { supportDir.appendingPathComponent("logs") }
    var venvDir: URL { supportDir.appendingPathComponent("venv") }
    var venvPython: URL { venvDir.appendingPathComponent("bin/python3") }

    private(set) var port: Int = 0
    private var server: Process?
    private var meter: Process?
    var onState: ((State) -> Void)?
    private(set) var state: State = .idle { didSet { let s = state; DispatchQueue.main.async { self.onState?(s) } } }

    init() {
        let res = Bundle.main.resourceURL ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        // Inside the .app bundle the engine sits in Resources/engine. When run from the
        // repo with `swift run`, fall back to the repository root (two levels up from mac/).
        let bundled = res.appendingPathComponent("engine")
        if FileManager.default.fileExists(atPath: bundled.appendingPathComponent("server/serve.py").path) {
            engineDir = bundled
        } else {
            engineDir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).deletingLastPathComponent()
        }
        supportDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Dante Visualizer")
    }

    var url: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    // MARK: start / stop

    func start(metering: Bool) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                for d in [self.dataDir, self.logsDir] {
                    try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
                }
                try self.ensurePythonEnvironment()
                self.state = .starting
                // A steady port keeps the page's saved layouts (stored per address) between launches.
                self.port = Engine.freePort(preferred: Array(8770...8779))
                try self.startServer()
                if metering { try self.startMeter() }
                self.waitForServer()
            } catch {
                self.state = .failed(error.localizedDescription)
            }
        }
    }

    /// Stops the helper first with SIGINT so it sends "stop metering" to every device,
    /// then the server. Calls `done` on the main queue when both have exited (max ~4 s).
    func stop(done: @escaping () -> Void) {
        DispatchQueue.global().async {
            self.stopMeterSync()
            if let s = self.server, s.isRunning {
                s.terminate()
                Engine.wait(for: s, seconds: 2)
                if s.isRunning { kill(s.processIdentifier, SIGKILL) }
            }
            self.server = nil
            DispatchQueue.main.async(execute: done)
        }
    }

    var meteringOn: Bool { meter?.isRunning ?? false }

    func setMetering(_ on: Bool) {
        DispatchQueue.global().async {
            if on, !self.meteringOn { try? self.startMeter() }
            if !on { self.stopMeterSync() }
        }
    }

    private func stopMeterSync() {
        guard let m = meter, m.isRunning else { meter = nil; return }
        m.interrupt()                       // SIGINT: the helper sends metering stop, then exits
        Engine.wait(for: m, seconds: 3)
        if m.isRunning { m.terminate(); Engine.wait(for: m, seconds: 1) }
        meter = nil
    }

    // MARK: processes

    private var environment: [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["DV_PYTHON"] = venvPython.path
        env["DV_DATA"] = dataDir.path
        env["DV_ENGINE"] = engineDir.path
        env["PYTHONUNBUFFERED"] = "1"
        // Apps launched from Finder get a minimal PATH.
        env["PATH"] = [venvDir.appendingPathComponent("bin").path, "/usr/local/bin", "/opt/homebrew/bin",
                       "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
        return env
    }

    private func launch(_ exe: URL, _ args: [String], log name: String) throws -> Process {
        let p = Process()
        p.executableURL = exe
        p.arguments = args
        p.currentDirectoryURL = engineDir
        p.environment = environment
        let logURL = logsDir.appendingPathComponent(name)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let handle = try FileHandle(forWritingTo: logURL)
        p.standardOutput = handle
        p.standardError = handle
        try p.run()
        return p
    }

    private func startServer() throws {
        let probe = engineDir.appendingPathComponent("probe")
        server = try launch(venvPython, [
            engineDir.appendingPathComponent("server/serve.py").path,
            "--snapshot", dataDir.appendingPathComponent("live_snapshot.json").path,
            "--refresh-cmd", "\"\(probe.appendingPathComponent("refresh_snapshot.sh").path)\"",
            "--refresh", "10",
            "--levels", dataDir.appendingPathComponent("levels.json").path,
            "--port", String(port),
        ], log: "server.log")
        server?.terminationHandler = { [weak self] p in
            guard let self, self.state == .running || self.state == .starting else { return }
            self.state = .failed("The diagram server stopped (exit \(p.terminationStatus)). See logs/server.log.")
        }
    }

    private func startMeter() throws {
        let script = engineDir.appendingPathComponent("probe/run_meter_daemon.sh")
        meter = try launch(URL(fileURLWithPath: "/bin/zsh"), [script.path], log: "meter.log")
    }

    private func waitForServer() {
        for _ in 0..<100 {
            if let s = server, !s.isRunning { return }
            var req = URLRequest(url: url.appendingPathComponent("index.html"))
            req.timeoutInterval = 0.5
            let sem = DispatchSemaphore(value: 0)
            var ok = false
            URLSession.shared.dataTask(with: req) { _, resp, _ in
                ok = (resp as? HTTPURLResponse)?.statusCode == 200
                sem.signal()
            }.resume()
            sem.wait()
            if ok { state = .running; return }
            Thread.sleep(forTimeInterval: 0.2)
        }
        state = .failed("The diagram server didn't start. See logs/server.log.")
    }

    // MARK: Python environment

    /// Makes ~/Library/Application Support/Dante Visualizer/venv with the packages in
    /// engine/requirements.txt, the first time only (or when requirements change).
    private func ensurePythonEnvironment() throws {
        let req = engineDir.appendingPathComponent("requirements.txt")
        let reqText = (try? String(contentsOf: req, encoding: .utf8)) ?? ""
        let stamp = venvDir.appendingPathComponent(".requirements")
        if FileManager.default.fileExists(atPath: venvPython.path),
           (try? String(contentsOf: stamp, encoding: .utf8)) == reqText { return }

        guard let python = Engine.findPython() else {
            throw EngineError("Python 3.10 or newer is needed. Install it from python.org and open the app again.")
        }
        let log = logsDir.appendingPathComponent("setup.log")
        state = .settingUp("Creating the Python environment…")
        if !FileManager.default.fileExists(atPath: venvPython.path) {
            try run(python, ["-m", "venv", venvDir.path], log: log)
        }
        state = .settingUp("Installing netaudio and its dependencies (needs internet, about a minute)…")
        try run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-r", req.path], log: log)
        try reqText.write(to: stamp, atomically: true, encoding: .utf8)
    }

    private func run(_ exe: URL, _ args: [String], log: URL) throws {
        let p = Process()
        p.executableURL = exe
        p.arguments = args
        p.environment = environment
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
        let h = try FileHandle(forWritingTo: log)
        h.seekToEndOfFile()
        p.standardOutput = h
        p.standardError = h
        try p.run()
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            throw EngineError("Setup failed (\(exe.lastPathComponent) exit \(p.terminationStatus)). See logs/setup.log.")
        }
    }

    static func findPython() -> URL? {
        let candidates = [
            "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
            "/usr/local/bin/python3", "/opt/homebrew/bin/python3", "/usr/bin/python3",
        ]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            // netaudio needs a recent Python; Apple's /usr/bin/python3 is 3.9.
            let p = Process()
            p.executableURL = URL(fileURLWithPath: c)
            p.arguments = ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            if (try? p.run()) != nil {
                p.waitUntilExit()
                if p.terminationStatus == 0 { return URL(fileURLWithPath: c) }
            }
        }
        return nil
    }

    // MARK: helpers

    static func wait(for p: Process, seconds: Double) {
        let deadline = Date().addingTimeInterval(seconds)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
    }

    /// The first free port of `preferred` on 127.0.0.1, otherwise one the system picks.
    static func freePort(preferred: [Int]) -> Int {
        func bind(_ port: Int) -> Int? {
            let fd = socket(AF_INET, SOCK_STREAM, 0)
            guard fd >= 0 else { return nil }
            defer { close(fd) }
            // Match the server (Python sets SO_REUSEADDR), so a port in TIME_WAIT from a
            // previous launch still counts as free.
            var one: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
            var addr = sockaddr_in()
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = in_port_t(UInt16(port).bigEndian)
            addr.sin_addr.s_addr = inet_addr("127.0.0.1")
            let ok = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
                }
            }
            guard ok else { return nil }
            var out = sockaddr_in()
            var len = socklen_t(MemoryLayout<sockaddr_in>.size)
            _ = withUnsafeMutablePointer(to: &out) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
            }
            return Int(UInt16(bigEndian: out.sin_port))
        }
        for p in preferred { if let got = bind(p) { return got } }
        return bind(0) ?? preferred[0]
    }
}

struct EngineError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}
