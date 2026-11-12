#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package="$root"
product="$root/.build/release/ademark-native"
target="$root/bin/ademark-native"

# 2026-11-09: the launcher pulls new code at each start, and `bin/` is not in git. A helper older than its sources would
# get options it does not know (the echo's absent region), and every A3 row would be invalid. The stamp holds the hash
# of the sources the binary was built from, and `--if-stale` builds only when they differ.
stamp="$root/bin/sources.sha256"
sources_hash() {
    (cd "$root" && find Sources Package.swift -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d" " -f1)
}

if [ "${1:-}" = "--if-stale" ] && [ -x "$target" ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$(sources_hash)" ]; then
    echo "native helper is up to date"
    exit 0
fi

swift build -c release --package-path "$package"

if [ ! -x "$product" ]; then
    echo "build produced no product at $product" >&2
    exit 1
fi

mkdir -p "$root/bin"
cp -f "$product" "$target"
codesign -s - -f "$target" >/dev/null 2>&1 || codesign -s - -f --deep "$target"

sources_hash > "$stamp"

echo "built $target"
