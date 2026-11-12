import Foundation

/// Runs an async framework call and blocks the calling thread until it finishes.
/// The work runs detached, so it never depends on the main queue being pumped.
func runBlocking<T>(timeoutNs: UInt64, _ work: @escaping () async throws -> T) throws -> T {
    let semaphore = DispatchSemaphore(value: 0)
    let box = ResultBox<T>()
    Task.detached(priority: .userInitiated) {
        do {
            box.value = .success(try await work())
        } catch {
            box.value = .failure(error)
        }
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + .nanoseconds(Int(min(timeoutNs, UInt64(Int.max))))) == .success else {
        throw NativeError.runtime(code: "capture_timeout", message: "a framework call did not return in time")
    }
    switch box.value {
    case .success(let value):
        return value
    case .failure(let error):
        throw error
    case nil:
        throw NativeError.runtime(code: "capture_failed", message: "a framework call returned no result")
    }
}

private final class ResultBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Result<T, Error>?

    var value: Result<T, Error>? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
        set {
            lock.lock()
            stored = newValue
            lock.unlock()
        }
    }
}
