import Foundation

/// Routes SIGINT and SIGTERM to a lock-protected flag on a private queue, so a long-running
/// command can finish its current unit of work, print a result and exit 0. The sources live as
/// long as this object, and the command's loop reads `isRequested`, so the object stays alive
/// until the loop ends.
final class SignalStop {
    private let lock = NSLock()
    private var requested = false
    private var sources: [DispatchSourceSignal] = []

    init() {
        let queue = DispatchQueue(label: "ademark.native.signals")
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            source.setEventHandler { [weak self] in self?.request() }
            source.resume()
            sources.append(source)
        }
    }

    private func request() {
        lock.lock()
        requested = true
        lock.unlock()
    }

    var isRequested: Bool {
        lock.lock()
        defer { lock.unlock() }
        return requested
    }
}
