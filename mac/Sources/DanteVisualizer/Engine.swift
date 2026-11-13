import Foundation

/// Runs the Python side of the app: the netaudio daemon, the diagram server, and (only
/// when the daemon can't run) the snapshot refresh and metering helper.
///
/// With the daemon (the normal case) the server follows its live event stream, so routes,
/// devices and levels update the moment they change, and the page can ask a device to
/// blink its identify LED. The metering helper then only listens, for devices whose levels
/// the daemon doesn't pass on. Without the daemon, the server re-reads a snapshot every 10 s
/// and the helper does all the metering, as before.
///
/// Towards the devices this sends only metering start/stop (as Dante Controller does)
/// and identify, when someone presses Identify.
///
/// Layout:
///   <App>.app/Contents/Resources/engine/   web/, server/, probe/, requirements.txt (read-only)
///   ~/Library/Application Support/Dante Visualizer/
///       venv/        Python environment with netaudio, made on first launch
///       data/        live_snapshot.json, levels.json
///       logs/        server.log, daemon.log, meter.log, setup.log
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
    private var daemon: Process?          // nil when there's no daemon or it was already running
    private(set) var usingDaemon = false
    private var daemonMetering = false
    static let daemonPort = 4780
    /// Dante Controller holds the standard metering port (8752), and the daemon won't start
    /// without its own. 8762 is the metering helper's.
    static let daemonMeteringPort = "8772"
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
                // No Dante network yet still counts as daemon mode: the daemon is started
                // (pinned to the port) as soon as one appears, and the server connects by itself.
                let found = self.startDaemon(announce: true)
                self.usingDaemon = found != .failed
                self.daemonMetering = self.usingDaemon && metering
                try self.startServer()
                if metering { try self.startMeter() }
                if found == .noNetwork { self.watchForDaemon() }
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
                s.terminate()                   // SIGTERM: with the daemon, the server releases metering first
                Engine.wait(for: s, seconds: 4)
                if s.isRunning { kill(s.processIdentifier, SIGKILL) }
            }
            self.server = nil
            if let d = self.daemon, d.isRunning {
                d.interrupt()
                Engine.wait(for: d, seconds: 3)
                if d.isRunning { d.terminate() }
            }
            self.daemon = nil
            DispatchQueue.main.async(execute: done)
        }
    }

    var meteringOn: Bool { usingDaemon ? daemonMetering : (meter?.isRunning ?? false) }

    func setMetering(_ on: Bool) {
        if usingDaemon {
            daemonMetering = on
            var req = URLRequest(url: url.appendingPathComponent("api/metering"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["on": on])
            URLSession.shared.dataTask(with: req).resume()
        }
        DispatchQueue.global().async {
            if on, !(self.meter?.isRunning ?? false) { try? self.startMeter() }   // the helper itself (meteringOn means the daemon in daemon mode)
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

    private func launch(_ exe: URL, _ args: [String], log name: String,
                        extraEnv: [String: String] = [:]) throws -> Process {
        let p = Process()
        p.executableURL = exe
        p.arguments = args
        p.currentDirectoryURL = engineDir
        p.environment = environment.merging(extraEnv) { _, new in new }
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
        var args = [
            engineDir.appendingPathComponent("server/serve.py").path,
            // The snapshot and its refresh stay as the fallback whenever the daemon is unreachable.
            "--snapshot", dataDir.appendingPathComponent("live_snapshot.json").path,
            "--refresh-cmd", "\"\(probe.appendingPathComponent("refresh_snapshot.sh").path)\"",
            "--refresh", "10",
            "--port", String(port),
        ]
        args += ["--levels", dataDir.appendingPathComponent("levels.json").path]
        if usingDaemon {
            args += ["--daemon", "http://127.0.0.1:\(Engine.daemonPort)"]
            if daemonMetering { args.append("--metering") }
        }
        server = try launch(venvPython, args, log: "server.log")
        server?.terminationHandler = { [weak self] p in
            guard let self, self.state == .running || self.state == .starting else { return }
            self.state = .failed("The diagram server stopped (exit \(p.terminationStatus)). See logs/server.log.")
        }
    }

    /// Uses a netaudio daemon that's already running, or starts one (`netaudio daemon run`)
    /// on the Dante interface. Returns false if neither works within a few seconds; the app
    /// then runs the way it did before the daemon (snapshot refresh and metering helper).
    enum DaemonStart { case running, noNetwork, failed }

    private func startDaemon(announce: Bool) -> DaemonStart {
        if Engine.daemonAnswers() { return .running }
        // Always pin it to the Dante port: unpinned it trips over other link-local ports
        // ("join monitoring group … Address already in use"). No port yet: try again later.
        guard let iface = danteInterface() else { return .noNetwork }
        if announce { state = .settingUp("Starting the netaudio daemon…") }
        let exe = venvDir.appendingPathComponent("bin/netaudio")
        guard let d = try? launch(exe, ["--interface", iface, "daemon", "run"], log: "daemon.log",
                                  extraEnv: ["NETAUDIO_METERING_PORT": Engine.daemonMeteringPort]) else { return .failed }
        for _ in 0..<40 {
            if !d.isRunning { break }
            if Engine.daemonAnswers() { daemon = d; return .running }
            Thread.sleep(forTimeInterval: 0.25)
        }
        if d.isRunning { d.terminate() }
        return .failed
    }

    /// The app started without a Dante network: look for one every 5 s and start the daemon
    /// on it. If the daemon then can't run, fall back to the helper doing all the metering.
    private var watchingDaemon = false
    private func watchForDaemon() {
        guard !watchingDaemon else { return }
        watchingDaemon = true
        DispatchQueue.global(qos: .utility).async {
            defer { self.watchingDaemon = false }
            while self.usingDaemon, self.server?.isRunning == true {
                Thread.sleep(forTimeInterval: 5)
                guard self.server?.isRunning == true else { return }
                switch self.startDaemon(announce: false) {
                case .running: return          // the server's feed connects and re-sends metering requests
                case .noNetwork: continue
                case .failed:
                    self.usingDaemon = false
                    if self.meter?.isRunning == true { self.stopMeterSync(); try? self.startMeter() }
                    return
                }
            }
        }
    }

    private func danteInterface() -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = [engineDir.appendingPathComponent("probe/dante_iface.sh").path]
        p.environment = environment
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        p.waitUntilExit()
        let name = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return p.terminationStatus == 0 && !name.isEmpty ? name : nil
    }

    static func daemonAnswers() -> Bool {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(daemonPort)/devices")!)
        req.timeoutInterval = 0.5
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            ok = (resp as? HTTPURLResponse)?.statusCode == 200
            sem.signal()
        }.resume()
        sem.wait()
        return ok
    }

    /// Without the daemon the helper does all the metering. With it, the helper only listens
    /// (--dry-run, sends nothing) for devices that announce signal presence in their
    /// heartbeats, which the daemon doesn't pass on (e.g. Fourier, Universal Audio).
    private func startMeter() throws {
        let script = engineDir.appendingPathComponent("probe/run_meter_daemon.sh")
        meter = try launch(URL(fileURLWithPath: "/bin/zsh"), [script.path] + (usingDaemon ? ["--dry-run"] : []),
                           log: "meter.log")
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
