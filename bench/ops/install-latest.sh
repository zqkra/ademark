#!/bin/bash
# bench/ops/install-latest.sh - update every ADEMark field app to its latest public build.
#
# Review before running. One app per function, resolved at runtime:
#   - GitHub-hosted apps: asset URL comes from `gh release view --json assets`
#     for the pinned tag (never a guessed URL).
#   - Vendor URLs are used only where the direct installer link was verified.
#
# Safety order per app: disk check -> resolve asset -> download -> mount/copy
# the .app out -> codesign + spctl (notarized Developer ID required) -> quit
# the running app -> ditto into /Applications -> archive installer on the
# SpaceFS mount (skipped when not mounted) -> delete the local download.
#
# Flags: --only <app-key>   run a single app (repeatable)
#        --dry-run          print the plan; no downloads, no changes
#
# App keys: t3code synara bb paseo traycer orca emdash zeron diri superset
#           cloudroom capy claude super-engineering
# ChatGPT/Codex is skipped: v2 measures Claude only. MonoCode stays at the
# installed 0.16.0 and is intentionally absent.

set -euo pipefail

MIN_FREE_KB=$((5 * 1024 * 1024))    # abort under 5 GB free on / (doctor needs 15 at night time; a restart frees swap)
APPS_DIR="/Applications"
DRY_RUN=0
ONLY=()

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --only)    ONLY+=("$2"); shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown flag: $1" >&2; usage 1 ;;
  esac
done

log()  { printf '%s\n' "$*"; }
plan() { if [ "$DRY_RUN" -eq 1 ]; then log "  [dry-run] $*"; else log "  $*"; fi; }

check_disk() {
  local avail
  avail=$(df -k / | awk 'NR==2 {print $4}')
  if [ "$avail" -lt "$MIN_FREE_KB" ]; then
    log "ABORT: only $((avail / 1024 / 1024)) GB free on / (need 5 GB)."
    exit 1
  fi
  log "disk: $((avail / 1024 / 1024)) GB free on /"
}

spacefs_root() {
  # SpaceFS mount point changes; read it live. Empty output = not mounted.
  mount | grep -i spacefs | awk '{print $3}' | head -1
}

# gh_asset_url <owner/repo> <tag> <name-regex>
# Prints the release asset URL whose file name matches the regex.
gh_asset_url() {
  local repo="$1" tag="$2" pattern="$3" name
  name=$(gh release view "$tag" --repo "$repo" --json assets \
    -q ".assets[].name" | grep -E "$pattern" | head -1 || true)
  if [ -z "$name" ]; then
    log "  !! no asset matching /$pattern/ in $repo@$tag"
    return 1
  fi
  echo "https://github.com/$repo/releases/download/$tag/$name"
}

download() { # <url> <dest>
  if [ "$DRY_RUN" -eq 1 ]; then plan "curl -fL -o $2 $1"; return 0; fi
  curl -fL --retry 3 -o "$2" "$1"
}

# extract_app <installer> <workdir> -> echoes path of the .app inside
# Handles .dmg (hdiutil) and .zip (ditto).
extract_app() {
  local file="$1" work="$2" app
  case "$file" in
    *.dmg)
      local mnt
      mnt=$(mktemp -d /tmp/ademark-mnt.XXXXXX)
      hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$file" >/dev/null
      app=$(find "$mnt" -maxdepth 2 -name "*.app" -type d | head -1)
      if [ -n "$app" ]; then mkdir -p "$work/out" && ditto "$app" "$work/out/$(basename "$app")"; fi
      hdiutil detach "$mnt" >/dev/null 2>&1 || true
      rm -rf "$mnt"
      ;;
    *.zip)
      mkdir -p "$work/zip"
      ditto -x -k "$file" "$work/zip"
      app=$(find "$work/zip" -maxdepth 2 -name "*.app" -type d | head -1)
      if [ -n "$app" ]; then mkdir -p "$work/out" && ditto "$app" "$work/out/$(basename "$app")"; fi
      ;;
    *) log "  !! unsupported installer type: $file"; return 1 ;;
  esac
  [ -n "${app:-}" ] || { log "  !! no .app found in $file"; return 1; }
  echo "$work/out/$(basename "$app")"
}

verify_app() { # <path-to-.app> : codesign + notarization must pass
  codesign --verify --deep --strict "$1"
  local spctl_out
  spctl_out=$(spctl -a -vv -t exec "$1" 2>&1)
  printf '%s\n' "$spctl_out" | sed 's/^/  spctl: /'
  printf '%s' "$spctl_out" | grep -q "accepted" || { log "  !! spctl did not accept $1"; return 1; }
  printf '%s' "$spctl_out" | grep -qi "notarized" || { log "  !! not notarized: $1"; return 1; }
}

app_version() { # <path-to-.app> -> CFBundleShortVersionString
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
    "$1/Contents/Info.plist" 2>/dev/null || echo "?"
}

quit_app() { # <app-name-without-.app>
  if pgrep -x "$1" >/dev/null 2>&1 || pgrep -f "$1.app/Contents/MacOS" >/dev/null 2>&1; then
    plan "osascript -e 'tell application \"$1\" to quit'"
    [ "$DRY_RUN" -eq 1 ] && return 0
    osascript -e "tell application \"$1\" to quit" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
      pgrep -f "$1.app/Contents/MacOS" >/dev/null 2>&1 || return 0
      sleep 1
    done
    log "  !! $1 still running after 30 s; aborting this app"
    return 1
  fi
}

archive_installer() { # <app-key> <version> <installer-path>
  local sf
  sf=$(spacefs_root)
  if [ -z "$sf" ]; then
    log "  spacefs: not mounted; installer kept at $3 then deleted"
    return 0
  fi
  local dest="$sf/Projects/ADEMark/installers/$1/$2"
  plan "mkdir -p '$dest' && cp '$3' '$dest/'"
  [ "$DRY_RUN" -eq 1 ] && return 0
  if ! { mkdir -p "$dest" && cp "$3" "$dest/"; } 2>/dev/null; then
    log "  spacefs: copy failed (mount full or offline); the installer stays on its public release page"
  fi
  return 0
}

# install_github <key> <repo> <tag> <asset-regex> <target-app-name> [expect-name-note]
install_github() {
  local key="$1" repo="$2" tag="$3" pattern="$4" target="$5" note="${6:-}"
  log "== $key: $repo@$tag -> $target"
  local url work inst app old new
  if [ "$DRY_RUN" -eq 1 ]; then
    plan "gh release view $tag --repo $repo --json assets (match /$pattern/)"
    plan "download asset, extract .app, codesign+spctl verify"
    plan "quit '$target', ditto to $APPS_DIR/$target, archive installer, print old -> new"
    [ -n "$note" ] && plan "note: $note"
    return 0
  fi
  local want_version="${tag##*v}"
  if [ "$(app_version "$APPS_DIR/$target")" = "$want_version" ]; then
    log "  $key: already $want_version, skipped"
    return 0
  fi
  check_disk
  url=$(gh_asset_url "$repo" "$tag" "$pattern") || return 1
  log "  url: $url"
  work=$(mktemp -d /tmp/ademark-inst.XXXXXX)
  local ext=".bin"
  case "$url" in
    *.dmg) ext=".dmg" ;;
    *.zip) ext=".zip" ;;
  esac
  inst="$work/installer$ext"
  download "$url" "$inst"
  app=$(extract_app "$inst" "$work")
  log "  extracted: $(basename "$app") as bundle $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null || echo '?')"
  verify_app "$app"
  new=$(app_version "$app")
  old=$(app_version "$APPS_DIR/$target" 2>/dev/null || echo "not installed")
  if [ "$(basename "$app")" != "$target" ]; then
    log "  !! the installer holds $(basename "$app"), not $target; stopping this app so the profile can be updated first"
    rm -rf "$work"
    return 1
  fi
  quit_app "${target%.app}"
  # Replace the bundle whole: ditto into an existing .app merges and can leave stale files that break the signature.
  # A bundle owned by root or by the ademark user needs sudo to replace; ours does not.
  local as=""
  if [ -e "$APPS_DIR/$target" ] && [ "$(stat -f %u "$APPS_DIR/$target")" != "$(id -u)" ]; then as="sudo -n"; fi
  local backup=""
  if [ -d "$APPS_DIR/$target" ]; then
    backup="$APPS_DIR/.previous-$target"
    $as rm -rf "$backup"
    $as mv "$APPS_DIR/$target" "$backup"
  fi
  if ! $as ditto "$app" "$APPS_DIR/$target" || ! codesign --verify --deep --strict "$APPS_DIR/$target"; then
    log "  !! install of $target failed; restoring the previous bundle"
    $as rm -rf "${APPS_DIR:?}/$target"
    if [ -n "$backup" ]; then $as mv "$backup" "$APPS_DIR/$target"; fi
    return 1
  fi
  if [ -n "$backup" ]; then $as rm -rf "$backup"; fi
  log "  $key: $old -> $new"
  archive_installer "$key" "$new" "$inst"
  rm -rf "$work"
  if [ -n "$note" ]; then log "  note: $note"; fi
}

install_todo() { # <key> <reason>
  log "== $1: TODO - $2"
}

want() { # <key> -> 0 if this app was selected (or no --only given)
  [ ${#ONLY[@]} -eq 0 ] && return 0
  local k
  for k in "${ONLY[@]}"; do [ "$k" = "$1" ] && return 0; done
  return 1
}

main() {
  log "install-latest $(date '+%Y-%m-%d %H:%M')  dry-run=$DRY_RUN"
  [ "$DRY_RUN" -eq 0 ] && check_disk

  if want t3code; then
    install_github t3code pingdotgg/t3code v0.1.11 \
      'T3-Code-.*-arm64\.dmg$' 'T3 Code (Beta).app'
  fi
  if want synara; then
    install_github synara Emanuele-web04/synara v1.6.4 \
      'Synara-.*-arm64\.dmg$' 'Synara.app'
  fi
  if want bb; then
    install_github bb get-bb/bb desktop-v0.50.1 \
      'bb-.*-arm64\.dmg$' 'bb.app'
  fi
  if want paseo; then
    install_github paseo getpaseo/paseo v0.16.2 \
      'Paseo-.*-arm64\.dmg$' 'Paseo.app'
  fi
  if want traycer; then
    install_github traycer traycerai/traycer desktop-v1.5.4 \
      'traycer-desktop-macos-arm64\.dmg$' 'Traycer.app'
  fi
  if want orca; then
    install_github orca stablyai/orca v1.4.268 \
      'Orca-.*-arm64-mac\.zip$' 'Orca.app' \
      'release ships a zip, not a dmg; extracted .app is ditto-copied the same way'
  fi
  if want emdash; then
    install_github emdash generalaction/emdash v1.2.13 \
      'emdash-arm64\.dmg$' 'Emdash.app'
  fi
  if want zeron; then
    install_github zeron zeronsh/zeron v0.3.14 \
      'zeron-.*-macos-arm64\.dmg$' 'Zeron.app' \
      'v0.3.14 is newer than the v0.3.13 in the brief; latest public tag used'
  fi
  if want diri; then
    install_github diri cristicretu/diri v0.11.6 \
      'diri-.*-universal\.dmg$' 'diri.app'
  fi
  if want superset; then
    # Paradev 2.x renamed the product. Prefer the Superset-named zip so the
    # installed bundle stays Superset.app; fall back to the Paradev dmg and
    # warn loudly, because a Paradev.app install changes profile paths
    # (app path, bundle id, possibly ~/.paradev vs ~/.superset data dir).
    install_github superset paradevai/paradev desktop-v2.0.11 \
      'Superset-.*-arm64.*\.zip$|Paradev-.*-arm64\.dmg$' 'Superset.app' \
      'if the extracted bundle is Paradev.app, profiles need: app.path -> /Applications/Paradev.app, app.bundleId, and a check whether the data dir moved from ~/.superset to ~/.paradev (2.0.8 still used ~/.superset)'
  fi
  if want cloudroom; then
    install_github cloudroom davidondrej/cloudroom gui-v160 \
      'Cloudroom-v160-arm64\.dmg$' 'Cloudroom.app'
  fi
  if want capy; then
    install_todo capy 'capy.ai/download is JS-rendered; no direct installer URL verified. Find the real asset link on https://capy.ai/download (installed 0.9.2 already matches the v2 target)'
  fi
  if want claude; then
    install_todo claude 'claude.com/download is JS-rendered; candidate API dmg endpoint returned 403. Get the dmg link from https://claude.com/download in a browser'
  fi
  if want super-engineering; then
    install_todo super-engineering 'super.engineering/download is JS-rendered and no public repo with releases was found; get the installer link from https://super.engineering/download/'
  fi

  log "done."
}

main "$@"
