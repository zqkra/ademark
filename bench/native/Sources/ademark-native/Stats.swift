import Foundation

enum Stats {
    static func median(_ values: [Int64]) -> Int64 {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let middle = sorted.count / 2
        if sorted.count % 2 == 1 { return sorted[middle] }
        return (sorted[middle - 1] + sorted[middle]) / 2
    }

    static func percentileDouble(_ values: [Double], _ fraction: Double) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let clamped = min(max(fraction, 0), 1)
        let rank = Int((clamped * Double(sorted.count)).rounded(.up))
        let index = min(max(rank - 1, 0), sorted.count - 1)
        return sorted[index]
    }

    /// Nearest-rank percentile: the smallest value at or above the requested rank.
    static func percentile(_ values: [Int64], _ fraction: Double) -> Int64 {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let clamped = min(max(fraction, 0), 1)
        let rank = Int((clamped * Double(sorted.count)).rounded(.up))
        let index = min(max(rank - 1, 0), sorted.count - 1)
        return sorted[index]
    }
}
