import Foundation
import CoreGraphics

/// Pure calibration checks: no Accessibility read, no screen capture, no posted event.
enum SelfTestCalibration {
    static func run(_ report: inout SelfTestReport) {
        testMenuCombos(&report)
        testVirtualKeys(&report)
        testLocator(&report)
        testTruncation(&report)
        testPointConversion(&report)
        testPixelDiff(&report)
        testProbeFrameSelection(&report)
    }

    private static func testMenuCombos(_ report: inout SelfTestReport) {
        report.check("a menu item with no modifier bits is cmd") {
            MenuCombo.combo(char: "n", virtualKey: nil, modifiers: 0) == "cmd+n"
        }
        report.check("mask bit 0 adds shift") {
            MenuCombo.combo(char: "n", virtualKey: nil, modifiers: 1) == "shift+cmd+n"
        }
        report.check("mask bit 1 adds option") {
            MenuCombo.combo(char: "n", virtualKey: nil, modifiers: 2) == "alt+cmd+n"
        }
        report.check("mask bit 2 adds control") {
            MenuCombo.combo(char: "n", virtualKey: nil, modifiers: 4) == "ctrl+cmd+n"
        }
        report.check("mask bit 3 turns cmd off") {
            MenuCombo.combo(char: "n", virtualKey: nil, modifiers: 8) == "n"
        }
        report.check("other bits survive the no-command bit") {
            MenuCombo.combo(char: "n", virtualKey: nil, modifiers: 8 | 1) == "shift+n"
        }
        report.check("modifiers come out as ctrl+alt+shift+cmd") {
            MenuCombo.combo(char: "n", virtualKey: nil, modifiers: 7) == "ctrl+alt+shift+cmd+n"
        }
        report.check("the ordered combo parses back to every modifier") {
            guard let combo = try? KeyCombo.parse("ctrl+alt+shift+cmd+n") else { return false }
            let flags: CGEventFlags = [.maskCommand, .maskShift, .maskAlternate, .maskControl]
            return combo.eventFlags == flags && combo.virtualKeyCode == 0x2D
        }
        report.check("every modifier mask produces a parsable combo") {
            [0, 1, 2, 3, 4, 5, 7, 8, 9, 15].allSatisfy { mask in
                guard let text = MenuCombo.combo(char: "k", virtualKey: nil, modifiers: mask) else { return false }
                return (try? KeyCombo.parse(text)) != nil
            }
        }
        report.check("a menu item without a key equivalent has no combo") {
            MenuCombo.combo(char: "", virtualKey: nil, modifiers: 0) == nil
                && MenuCombo.combo(char: nil, virtualKey: nil, modifiers: nil) == nil
        }
    }

    private static func testVirtualKeys(_ report: inout SelfTestReport) {
        report.check("enter has a KeyCombo name") {
            MenuCombo.keyName(char: nil, virtualKey: 0x24) == "enter"
        }
        report.check("arrow keys have KeyCombo names") {
            MenuCombo.keyName(char: nil, virtualKey: 0x7B) == "left"
                && MenuCombo.keyName(char: nil, virtualKey: 0x7D) == "down"
        }
        report.check("a virtual key with no KeyCombo name has no combo") {
            MenuCombo.keyName(char: nil, virtualKey: 0x60) == nil
                && MenuCombo.combo(char: nil, virtualKey: 0x60, modifiers: 0) == nil
        }
        report.check("an uppercase menu character becomes its key") {
            MenuCombo.combo(char: "N", virtualKey: nil, modifiers: 1) == "shift+cmd+n"
        }
        report.check("the virtual key is used when the character is empty") {
            MenuCombo.combo(char: "", virtualKey: 0x24, modifiers: 0) == "cmd+enter"
        }
    }

    private static func testLocator(_ report: inout SelfTestReport) {
        let nodes = AxLocatorMatch.depthFirst(sampleTree())
        report.check("the walk is depth-first pre-order") {
            nodes.map(\.role) == ["AXWindow", "AXButton", "AXGroup", "AXButton", "AXTextField", "AXButton"]
        }
        report.check("role and title match one node") {
            let match = AxLocatorMatch.pick(AxLocator(role: "AXButton", title: "Send", titleContains: nil,
                                                     identifier: nil, description: nil, index: 0), in: nodes)
            return match.matches == 1 && match.node?.identifier == "send"
        }
        report.check("titleContains matches two and index picks the second") {
            let match = AxLocatorMatch.pick(AxLocator(role: "AXButton", title: nil, titleContains: "Send",
                                                     identifier: nil, description: nil, index: 1), in: nodes)
            return match.matches == 2 && match.node?.identifier == "send-again"
        }
        report.check("identifier and description match too") {
            let byIdentifier = AxLocatorMatch.pick(AxLocator(role: "AXTextField", title: nil, titleContains: nil,
                                                            identifier: "composer", description: "Message", index: 0), in: nodes)
            let byDescription = AxLocatorMatch.pick(AxLocator(role: "AXButton", title: nil, titleContains: nil,
                                                             identifier: nil, description: "Send it", index: 0), in: nodes)
            return byIdentifier.matches == 1 && byDescription.matches == 1
        }
        report.check("a role mismatch matches nothing") {
            let match = AxLocatorMatch.pick(AxLocator(role: "AXTextField", title: "Send", titleContains: nil,
                                                     identifier: nil, description: nil, index: 0), in: nodes)
            return match.matches == 0 && match.node == nil
        }
        report.check("an index past the matches is no match") {
            let match = AxLocatorMatch.pick(AxLocator(role: "AXButton", title: nil, titleContains: "Send",
                                                     identifier: nil, description: nil, index: 2), in: nodes)
            return match.matches == 2 && match.node == nil
        }
        report.check("title must equal, not start with") {
            AxLocatorMatch.pick(AxLocator(role: "AXButton", title: "Send", titleContains: nil, identifier: nil,
                                          description: nil, index: 0), in: nodes).matches == 1
        }
        report.check("locator JSON needs a role") {
            do { _ = try AxLocator.parse(data: Data("{}".utf8)); return false } catch { return true }
        }
        report.check("locator JSON reads fields and defaults the index") {
            guard let locator = try? AxLocator.parse(data: Data("{\"role\":\"AXButton\",\"titleContains\":\"Sen\"}".utf8)) else {
                return false
            }
            return locator.index == 0 && locator.titleContains == "Sen" && locator.title == nil
                && locator.identifier == nil && locator.description == nil
        }
        report.check("locator JSON rejects a negative index") {
            do {
                _ = try AxLocator.parse(data: Data("{\"role\":\"AXButton\",\"index\":-1}".utf8))
                return false
            } catch {
                return true
            }
        }
        report.check("locator JSON rejects a numeric title") {
            do {
                _ = try AxLocator.parse(data: Data("{\"role\":\"AXButton\",\"title\":3}".utf8))
                return false
            } catch {
                return true
            }
        }
    }

    private static func testTruncation(_ report: inout SelfTestReport) {
        report.check("a 200 character string is kept") {
            CalibrationAX.truncate(String(repeating: "a", count: 200)) == String(repeating: "a", count: 200)
        }
        report.check("a 201 character string is 199 and an ellipsis") {
            CalibrationAX.truncate(String(repeating: "a", count: 201)) == String(repeating: "a", count: 199) + "…"
        }
        report.check("a short string is unchanged") {
            CalibrationAX.truncate("short") == "short"
        }
    }

    private static func testPointConversion(_ report: inout SelfTestReport) {
        report.check("an AX frame becomes a window point") {
            CalibrationAX.relativeFrame(CGRect(x: 140, y: 90, width: 30, height: 20),
                                        window: CGRect(x: 100, y: 60, width: 800, height: 600))
                == CGRect(x: 40, y: 30, width: 30, height: 20)
        }
        report.check("a window point becomes a screen point") {
            WindowSpace(scale: 1, pixelWidth: 800, pixelHeight: 600)
                .screenPoint(windowOrigin: CGPoint(x: 100, y: 60), spec: PointSpec(x: 10, y: 25))
                == CGPoint(x: 110, y: 85)
        }
    }

    private static func testPixelDiff(_ report: inout SelfTestReport) {
        let reference = frame(width: 40, height: 20, blocks: [])
        let whole = CGRect(x: 0, y: 0, width: 40, height: 20)
        report.check("the box covers the changed block") {
            let current = frame(width: 40, height: 20, blocks: [(CGRect(x: 10, y: 5, width: 4, height: 3), 255)])
            return PixelDiff.changedRect(reference: reference, current: current, region: whole)
                == CGRect(x: 10, y: 5, width: 4, height: 3)
        }
        report.check("a change of 24 stays below the threshold") {
            let current = frame(width: 40, height: 20, blocks: [(CGRect(x: 10, y: 5, width: 4, height: 3), 24)])
            return PixelDiff.changedRect(reference: reference, current: current, region: whole) == nil
        }
        report.check("a change of 25 counts") {
            let current = frame(width: 40, height: 20, blocks: [(CGRect(x: 10, y: 5, width: 4, height: 3), 25)])
            return PixelDiff.changedRect(reference: reference, current: current, region: whole) != nil
        }
        report.check("a change outside the search region is ignored") {
            let current = frame(width: 40, height: 20, blocks: [(CGRect(x: 20, y: 15, width: 4, height: 3), 255)])
            return PixelDiff.changedRect(reference: reference, current: current,
                                         region: CGRect(x: 0, y: 0, width: 10, height: 10)) == nil
        }
        report.check("identical frames have no box") {
            PixelDiff.changedRect(reference: reference, current: reference, region: whole) == nil
        }
        report.check("one box holds both changed blocks") {
            let current = frame(width: 40, height: 20, blocks: [
                (CGRect(x: 2, y: 2, width: 2, height: 2), 255),
                (CGRect(x: 12, y: 8, width: 2, height: 2), 255),
            ])
            return PixelDiff.changedRect(reference: reference, current: current, region: whole)
                == CGRect(x: 2, y: 2, width: 12, height: 8)
        }
        report.check("frames of different sizes cannot be compared") {
            let other = frame(width: 20, height: 20, blocks: [])
            return PixelDiff.changedRect(reference: reference, current: other, region: whole) == nil
        }
    }

    private static func testProbeFrameSelection(_ report: inout SelfTestReport) {
        let lastKey: UInt64 = 1_000_000_000
        let settle: UInt64 = 300_000_000
        report.check("a frame 40 ms after the last key is used at the settle mark") {
            ProbeFrameSelector.newestAfterKey(frames: [lastKey + 40_000_000], lastKeyNs: lastKey,
                                              nowNs: lastKey + settle) == lastKey + 40_000_000
        }
        report.check("the newest frame after the last key is chosen") {
            ProbeFrameSelector.newestAfterKey(frames: [lastKey + 40_000_000, lastKey + 180_000_000],
                                              lastKeyNs: lastKey,
                                              nowNs: lastKey + settle) == lastKey + 180_000_000
        }
        report.check("no frame after the last key is no frame") {
            ProbeFrameSelector.newestAfterKey(frames: [lastKey - 20_000_000, lastKey - 1],
                                              lastKeyNs: lastKey,
                                              nowNs: lastKey + settle) == nil
        }
        report.check("no frame is chosen before the settle mark") {
            ProbeFrameSelector.newestAfterKey(frames: [lastKey + 40_000_000], lastKeyNs: lastKey,
                                              nowNs: lastKey + settle - 1) == nil
        }
    }

    private static func sampleTree() -> AxNode {
        AxNode(role: "AXWindow", title: "Main", children: [
            AxNode(role: "AXButton", title: "Send", description: "Send it", identifier: "send"),
            AxNode(role: "AXGroup", children: [
                AxNode(role: "AXButton", title: "Send again", identifier: "send-again"),
                AxNode(role: "AXTextField", title: "Composer", description: "Message", identifier: "composer"),
            ]),
            AxNode(role: "AXButton", title: "Attach", identifier: "attach"),
        ])
    }

    private static func frame(width: Int, height: Int, blocks: [(CGRect, UInt8)]) -> PixelFrame {
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        for (rect, value) in blocks {
            for y in Int(rect.minY)..<Int(rect.maxY) {
                for x in Int(rect.minX)..<Int(rect.maxX) {
                    let offset = (y * width + x) * 4
                    for channel in 0..<3 { bytes[offset + channel] = value }
                }
            }
        }
        return PixelFrame(width: width, height: height, bytes: bytes)
    }
}
