import Foundation

enum TriggerOutcome {
    /// A skipped trigger means the measured app was never frontmost when a post was due, so the run
    /// measured the wrong thing (for example the old thread's composer). The run must fail loudly
    /// instead of reporting a plausible number.
    static func error(skipped: Int, pid: Int32?) -> NativeError? {
        guard skipped > 0 else { return nil }
        let plural = skipped == 1 ? "trigger" : "triggers"
        let who = pid.map { "pid \($0) was" } ?? "the app was"
        return .runtime(code: "trigger_skipped",
                        message: "\(skipped) \(plural) skipped: \(who) not frontmost")
    }
}
