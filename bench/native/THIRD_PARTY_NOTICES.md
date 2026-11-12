# Third-party notices

## Orca computer-use helper

The calibration commands read the Accessibility tree with Swift ported from Orca's macOS helper.

- Project: Orca, `native/computer-use-macos/`
- Repository: https://github.com/stablyai/orca
- Copyright (c) 2026 Lovecast Inc.

Ported files, each marked with a one-line header:

- `Sources/ademark-native/CalibrationAX.swift`
- `Sources/ademark-native/CalibrationTree.swift`
- `Sources/ademark-native/CalibrationLocator.swift`
- `Sources/ademark-native/CalibrationMenuCombo.swift`
- `Sources/ademark-native/CommandsAxTree.swift`
- `Sources/ademark-native/CommandsMenuShortcuts.swift`
- `Sources/ademark-native/CommandsAxPress.swift`

Ported parts: reading `AXRole`, `AXSubrole`, `AXTitle`, `AXValue`, `AXDescription`, `AXIdentifier`, `AXPosition`,
`AXSize`, `AXEnabled`, `AXFocused`, `AXChildren` and `AXUIElementCopyActionNames`; turning on
`AXManualAccessibility` for Electron and Chromium apps; the focused-or-first-usable window lookup; the depth- and
node-limited tree walk; `AXUIElementPerformAction`; and the `AXMenuItemCmd*` key-equivalent reader.

## MIT License

```
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
