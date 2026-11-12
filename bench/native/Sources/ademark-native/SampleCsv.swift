import Foundation

/// Appends sample rows to the CSV as each tick produces them and flushes every tick, so a sampler
/// that runs for a whole track never holds the file in memory.
final class SampleCsv {
    private let path: String
    private let handle: FileHandle

    init(path: String, header: String) throws {
        self.path = path
        do {
            let url = URL(fileURLWithPath: path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: url.path) {
                _ = FileManager.default.createFile(atPath: url.path, contents: nil)
            }
            guard let handle = FileHandle(forWritingAtPath: url.path) else {
                throw NativeError.io("cannot open \(path) for writing")
            }
            self.handle = handle
            try handle.truncate(atOffset: 0)
            try handle.write(contentsOf: Data((header + "\n").utf8))
            try handle.synchronize()
        } catch let error as NativeError {
            throw error
        } catch {
            throw NativeError.io("cannot write \(path): \(error.localizedDescription)")
        }
    }

    func append(_ rows: [String]) throws {
        guard !rows.isEmpty else { return }
        do {
            try handle.write(contentsOf: Data((rows.joined(separator: "\n") + "\n").utf8))
            try handle.synchronize()
        } catch {
            throw NativeError.io("cannot write \(path): \(error.localizedDescription)")
        }
    }

    func close() {
        try? handle.close()
    }
}
