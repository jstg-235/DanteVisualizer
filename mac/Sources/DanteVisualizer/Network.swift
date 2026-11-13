import Foundation

/// A network port that could carry Dante: up, running, with an IPv4 address.
struct NetInterface: Equatable {
    let name: String        // BSD name, e.g. en11
    let ipv4: String
    let port: String?       // macOS hardware port name, e.g. "USB 10/100/1G/2.5G LAN"

    var menuTitle: String {
        [name, port, ipv4].compactMap { $0 }.joined(separator: "  ·  ")
    }

    /// Every candidate port, Ethernet-style ports first, loopback and tunnels left out.
    static func all() -> [NetInterface] {
        let ports = hardwarePorts()
        var out: [NetInterface] = []
        var ifap: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifap) == 0, let first = ifap else { return [] }
        defer { freeifaddrs(ifap) }
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let ifa = p.pointee
            guard let addr = ifa.ifa_addr, addr.pointee.sa_family == sa_family_t(AF_INET) else { continue }
            let flags = Int32(truncatingIfNeeded: ifa.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_RUNNING != 0, flags & IFF_LOOPBACK == 0 else { continue }
            let name = String(cString: ifa.ifa_name)
            if ["utun", "awdl", "llw", "bridge", "gif", "stf", "anpi", "ap"].contains(where: { name.hasPrefix($0) }) { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0
            else { continue }
            let ip = String(cString: host)
            if out.contains(where: { $0.name == name }) { continue }
            out.append(NetInterface(name: name, ipv4: ip, port: ports[name]))
        }
        // Wi-Fi last: Dante is almost always on a wired port.
        return out.sorted { a, b in
            let wa = a.port?.contains("Wi-Fi") == true, wb = b.port?.contains("Wi-Fi") == true
            return wa == wb ? a.name.localizedStandardCompare(b.name) == .orderedAscending : !wa
        }
    }

    /// BSD name → hardware port name, from `networksetup -listallhardwareports`.
    static func hardwarePorts() -> [String: String] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/networksetup")
        p.arguments = ["-listallhardwareports"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return [:] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        var map: [String: String] = [:]
        var port: String?
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
            if line.hasPrefix("Hardware Port: ") { port = String(line.dropFirst("Hardware Port: ".count)) }
            if line.hasPrefix("Device: "), let port { map[String(line.dropFirst("Device: ".count))] = port }
        }
        return map
    }
}
