#!/bin/zsh -f
# ademark-machine: the root part of `ademark machine`.
# Installed by bench/ops/install-machine.zsh to /usr/local/libexec/ademark-machine and reachable through one
# sudoers rule. It runs as root with a fixed PATH, accepts only the subcommands below, and never runs a tool from a
# user-writable folder.
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

readonly STATE_DIR=/var/db/ademark-machine
readonly STATE_FILE=$STATE_DIR/before.env
readonly BLOCK_FILE=$STATE_DIR/block.conf
readonly PF_TOKEN_FILE=$STATE_DIR/pf.token
# The main ruleset only evaluates anchors under com.apple/, so a top-level ademark anchor would never run.
readonly ANCHOR=com.apple/ademark
readonly UPDATE_PLIST=/Library/Preferences/com.apple.SoftwareUpdate
typeset -ar POWER_KEYS=(powernap sleep displaysleep disksleep)
typeset -ar UPDATE_KEYS=(AutomaticDownload AutomaticallyInstallMacOSUpdates AutomaticCheckEnabled ConfigDataInstall CriticalUpdateInstall)

# >>> argument validation: bench/test/ops-machine.test.ts extracts this block >>>
is_ipv4() {
  local addr=$1
  [[ $addr =~ '^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$' ]]
}

is_ipv6() {
  local addr=$1
  [[ $addr == *:* ]] || return 1
  [[ $addr =~ '^[0-9A-Fa-f:.]+$' ]] || return 1
  local -a sides parts
  local double=0 groups=0 side part side_index=0 part_index
  if [[ $addr == *::* ]]; then
    double=1
    [[ ${addr#*::} != *::* ]] || return 1
    sides=("${addr%%::*}" "${addr#*::}")
  else
    sides=("$addr")
  fi
  for side in "${sides[@]}"; do
    side_index=$((side_index + 1))
    if [[ -z $side ]]; then
      continue
    fi
    parts=("${(@s.:.)side}")
    for (( part_index = 1; part_index <= ${#parts}; part_index++ )); do
      part=${parts[part_index]}
      if [[ -z $part ]]; then
        return 1
      fi
      if [[ $part == *.* ]]; then
        # An embedded IPv4 address is only valid as the last group of the whole address.
        if (( side_index != ${#sides} || part_index != ${#parts} )); then
          return 1
        fi
        is_ipv4 "$part" || return 1
        groups=$((groups + 2))
      else
        [[ $part =~ '^[0-9A-Fa-f]{1,4}$' ]] || return 1
        groups=$((groups + 1))
      fi
    done
  done
  if (( double )); then
    (( groups <= 7 ))
  else
    (( groups == 8 ))
  fi
}

validate_machine_args() {
  local -a args
  args=("$@")
  local count=${#args}
  if (( count < 1 )); then
    print -u2 "ademark-machine: missing subcommand"
    return 2
  fi
  local subcommand=${args[1]}
  local i value
  case $subcommand in
    on|off|status|purge|pf-clear)
      if (( count != 1 )); then
        print -u2 "ademark-machine: $subcommand takes no arguments"
        return 2
      fi
      ;;
    footprint)
      if (( count < 2 || count > 65 )); then
        print -u2 "ademark-machine: footprint takes 1 to 64 pids"
        return 2
      fi
      for (( i = 2; i <= count; i++ )); do
        value=${args[i]}
        if [[ ! $value =~ '^[0-9]{1,7}$' ]]; then
          print -u2 "ademark-machine: invalid pid: $value"
          return 2
        fi
      done
      ;;
    pf-block)
      if (( count < 2 || count > 33 )); then
        print -u2 "ademark-machine: pf-block takes 1 to 32 addresses"
        return 2
      fi
      for (( i = 2; i <= count; i++ )); do
        value=${args[i]}
        if ! is_ipv4 "$value" && ! is_ipv6 "$value"; then
          print -u2 "ademark-machine: invalid address: $value"
          return 2
        fi
      done
      ;;
    *)
      print -u2 "ademark-machine: unknown subcommand: $subcommand"
      return 2
      ;;
  esac
  return 0
}
# <<< argument validation <<<

warn() {
  print -u2 "ademark-machine: $*"
}

trim() {
  local text=$1
  while [[ $text == [[:space:]]* ]]; do
    text=${text#?}
  done
  while [[ $text == *[[:space:]] ]]; do
    text=${text%?}
  done
  print -r -- "$text"
}

ensure_state_dir() {
  if [[ ! -d $STATE_DIR ]]; then
    /bin/mkdir -p "$STATE_DIR"
  fi
  if [[ -L $STATE_DIR || ! -d $STATE_DIR ]]; then
    warn "$STATE_DIR is not a real directory"
    exit 1
  fi
  local owner
  owner=$(/usr/bin/stat -f '%Su:%Sg' "$STATE_DIR")
  if [[ $owner != root:wheel ]]; then
    warn "$STATE_DIR is owned by $owner, not root:wheel"
    exit 1
  fi
  /bin/chmod 700 "$STATE_DIR"
}

spotlight_lines() {
  local output line indexing current="" index=0
  local -a lines
  lines=()
  output=$(/usr/bin/mdutil -a -s 2>/dev/null || true)
  while IFS= read -r line; do
    if [[ -z $line ]]; then
      continue
    fi
    if [[ $line != [[:space:]]* && $line == *: ]]; then
      current=${line%:}
      continue
    fi
    if [[ -n $current ]]; then
      indexing=$(trim "$line")
      if [[ $indexing == *"Indexing enabled"* ]]; then
        lines+=("spotlight.${index}.volume=${current}" "spotlight.${index}.enabled=1")
        index=$((index + 1))
      elif [[ $indexing == *disabled* ]]; then
        lines+=("spotlight.${index}.volume=${current}" "spotlight.${index}.enabled=0")
        index=$((index + 1))
      fi
    fi
  done <<< "$output"
  print "spotlight.count=${index}"
  if (( ${#lines} > 0 )); then
    printf '%s\n' "${lines[@]}"
  fi
}

power_value() {
  local key=$1 output line value=absent in_current=0
  output=$(/usr/bin/pmset -g 2>/dev/null || true)
  while IFS= read -r line; do
    if [[ $line == "Currently in use:"* ]]; then
      in_current=1
      continue
    fi
    if (( in_current )) && [[ $line =~ '^[[:space:]]+([A-Za-z]+)[[:space:]]+([0-9]+)' ]]; then
      if [[ ${match[1]} == $key ]]; then
        value=${match[2]}
      fi
    fi
  done <<< "$output"
  print -r -- "$value"
}

update_schedule() {
  local output
  # macOS 27.0.1: this query run as root removes AutomaticCheckEnabled from the plist, so it runs as the caller.
  output=$(/usr/bin/sudo -n -u "${SUDO_USER:-nobody}" /usr/sbin/softwareupdate --schedule 2>/dev/null || true)
  if [[ $output == *"turned on"* ]]; then
    print on
  elif [[ $output == *"turned off"* ]]; then
    print off
  else
    print unknown
  fi
}

defaults_value() {
  local key=$1
  if /usr/bin/defaults read "$UPDATE_PLIST" "$key" >/dev/null 2>&1; then
    /usr/bin/defaults read "$UPDATE_PLIST" "$key" 2>/dev/null | /usr/bin/tr -d '\n'
  else
    print absent
  fi
}

time_machine_state() {
  local tm_output output value
  tm_output=$(/usr/bin/tmutil status 2>/dev/null || true)
  if [[ $tm_output =~ 'AutoBackup = ([01])' ]]; then
    if [[ ${match[1]} == 1 ]]; then
      print on
    else
      print off
    fi
    return
  fi
  if /usr/bin/defaults read /Library/Preferences/com.apple.TimeMachine AutoBackup >/dev/null 2>&1; then
    value=$(/usr/bin/defaults read /Library/Preferences/com.apple.TimeMachine AutoBackup 2>/dev/null)
    if [[ $value == 1 ]]; then
      print on
    else
      print off
    fi
    return
  fi
  output=$(/usr/bin/tmutil destinationinfo 2>&1 || true)
  if [[ $output == *"No destinations configured"* ]]; then
    print off
  elif [[ $output == *"Name"* ]]; then
    print on
  else
    print unknown
  fi
}

pf_anchor_state() {
  local output count
  if ! output=$(/sbin/pfctl -a "$ANCHOR" -sr 2>/dev/null); then
    print unknown
    return
  fi
  if [[ -z $output ]]; then
    print empty
    return
  fi
  count=$(print -r -- "$output" | /usr/bin/grep -c . || true)
  if [[ $count -eq 0 ]]; then
    print empty
  else
    print "$count rules"
  fi
}

save_before_env() {
  ensure_state_dir
  local tmp key
  tmp=$(/usr/bin/mktemp "$STATE_DIR/before.XXXXXXXX")
  /bin/chmod 600 "$tmp"
  {
    print "saved_at=$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')"
    spotlight_lines
    for key in "${POWER_KEYS[@]}"; do
      print "${key}=$(power_value "$key")"
    done
    print "updates.schedule=$(update_schedule)"
    for key in "${UPDATE_KEYS[@]}"; do
      print "updates.${key}=$(defaults_value "$key")"
    done
    print "timemachine.autobackup=$(time_machine_state)"
  } > "$tmp"
  /bin/mv -f "$tmp" "$STATE_FILE"
}

cmd_on() {
  local failed=0 key
  if [[ ! -e $STATE_FILE ]]; then
    save_before_env
    print "ademark-machine: saved the current state to $STATE_FILE"
  else
    print "ademark-machine: keeping $STATE_FILE"
  fi

  if ! /usr/bin/mdutil -a -i off >/dev/null 2>&1; then
    warn "mdutil -a -i off failed"
    failed=1
  fi
  if ! /usr/bin/pmset -a powernap 0 sleep 0 displaysleep 0 disksleep 0; then
    warn "pmset failed"
    failed=1
  fi
  if ! /usr/sbin/softwareupdate --schedule off; then
    warn "softwareupdate --schedule off failed"
    failed=1
  fi
  for key in "${UPDATE_KEYS[@]}"; do
    if ! /usr/bin/defaults write "$UPDATE_PLIST" "$key" -bool false; then
      warn "defaults write $key failed"
      failed=1
    fi
  done
  # tmutil needs Full Disk Access for the calling terminal; with Time Machine already off there is nothing to change.
  if [[ $(time_machine_state) != off ]] && ! /usr/bin/tmutil disable; then
    warn "tmutil disable failed"
    failed=1
  fi

  if (( failed )); then
    warn "machine on is incomplete"
    return 1
  fi
  print "ademark-machine: on"
}

cmd_off() {
  if [[ ! -e $STATE_FILE ]]; then
    print "nothing to restore"
    return 0
  fi
  ensure_state_dir
  typeset -A before
  local line key value failed=0 index=0 volume enabled schedule time_machine flag
  local -a power
  power=()
  while IFS= read -r line; do
    if [[ -z $line ]]; then
      continue
    fi
    key=${line%%=*}
    value=${line#*=}
    before[$key]=$value
  done < "$STATE_FILE"

  while true; do
    volume=${before[spotlight.${index}.volume]:-}
    if [[ -z $volume ]]; then
      break
    fi
    enabled=${before[spotlight.${index}.enabled]:-0}
    if [[ $enabled == 1 ]]; then
      if ! /usr/bin/mdutil -i on "$volume" >/dev/null 2>&1; then
        warn "mdutil -i on $volume failed"
        failed=1
      fi
    else
      if ! /usr/bin/mdutil -i off "$volume" >/dev/null 2>&1; then
        warn "mdutil -i off $volume failed"
        failed=1
      fi
    fi
    index=$((index + 1))
  done

  for key in "${POWER_KEYS[@]}"; do
    value=${before[$key]:-absent}
    if [[ $value == absent || -z $value ]]; then
      continue
    fi
    power+=("$key" "$value")
  done
  if (( ${#power} > 0 )); then
    if ! /usr/bin/pmset -a "${power[@]}"; then
      warn "pmset restore failed"
      failed=1
    fi
  fi

  schedule=${before[updates.schedule]:-}
  if [[ $schedule == on || $schedule == off ]]; then
    if ! /usr/sbin/softwareupdate --schedule "$schedule"; then
      warn "softwareupdate --schedule $schedule failed"
      failed=1
    fi
  fi

  for key in "${UPDATE_KEYS[@]}"; do
    value=${before[updates.${key}]:-}
    if [[ -z $value ]]; then
      continue
    fi
    if [[ $value == absent ]]; then
      /usr/bin/defaults delete "$UPDATE_PLIST" "$key" >/dev/null 2>&1 || true
    elif [[ $value == 1 || $value == 0 || $value == true || $value == false ]]; then
      flag=false
      if [[ $value == 1 || $value == true ]]; then
        flag=true
      fi
      if ! /usr/bin/defaults write "$UPDATE_PLIST" "$key" -bool "$flag"; then
        warn "defaults write $key failed"
        failed=1
      fi
    else
      if ! /usr/bin/defaults write "$UPDATE_PLIST" "$key" -string "$value"; then
        warn "defaults write $key failed"
        failed=1
      fi
    fi
  done

  time_machine=${before[timemachine.autobackup]:-}
  if [[ $time_machine == on ]]; then
    if ! /usr/bin/tmutil enable; then
      warn "tmutil enable failed"
      failed=1
    fi
  elif [[ $time_machine == off && $(time_machine_state) != off ]]; then
    if ! /usr/bin/tmutil disable; then
      warn "tmutil disable failed"
      failed=1
    fi
  fi

  if (( failed )); then
    warn "restore is incomplete; kept $STATE_FILE"
    return 1
  fi
  /bin/rm -f "$STATE_FILE"
  print "ademark-machine: restored and removed $STATE_FILE"
}

cmd_status() {
  local present=absent output line indexing current="" key
  if [[ -e $STATE_FILE ]]; then
    present=present
  fi
  print "before.env=$present"

  output=$(/usr/bin/mdutil -a -s 2>/dev/null || true)
  while IFS= read -r line; do
    if [[ -z $line ]]; then
      continue
    fi
    if [[ $line != [[:space:]]* && $line == *: ]]; then
      current=${line%:}
      continue
    fi
    if [[ -n $current ]]; then
      indexing=$(trim "$line")
      if [[ $indexing == *"Indexing enabled"* ]]; then
        print "spotlight.${current}=on"
      elif [[ $indexing == *disabled* ]]; then
        print "spotlight.${current}=off"
      fi
    fi
  done <<< "$output"

  for key in "${POWER_KEYS[@]}"; do
    print "power.${key}=$(power_value "$key")"
  done
  print "updates.schedule=$(update_schedule)"
  for key in "${UPDATE_KEYS[@]}"; do
    print "updates.${key}=$(defaults_value "$key")"
  done
  print "timemachine.autobackup=$(time_machine_state)"
  print "pf.ademark=$(pf_anchor_state)"
}

cmd_footprint() {
  ensure_state_dir
  local tmp pid
  local -a args
  tmp=$(/usr/bin/mktemp "$STATE_DIR/footprint.XXXXXXXX")
  /bin/chmod 600 "$tmp"
  args=(-j "$tmp" --unmapped)
  for pid in "$@"; do
    args+=(-p "$pid")
  done
  if ! /usr/bin/footprint "${args[@]}" >/dev/null 2>&1; then
    warn "footprint failed"
    /bin/rm -f "$tmp"
    return 1
  fi
  /bin/cat "$tmp"
  /bin/rm -f "$tmp"
}

cmd_pf_block() {
  ensure_state_dir
  local addr tmp enable_output token token_tmp line
  local -a v4 v6
  v4=()
  v6=()
  for addr in "$@"; do
    if is_ipv4 "$addr"; then
      v4+=("$addr")
    else
      v6+=("$addr")
    fi
  done
  if (( ${#v4} == 0 && ${#v6} == 0 )); then
    warn "no address to block"
    return 1
  fi
  tmp=$(/usr/bin/mktemp "$STATE_DIR/block.XXXXXXXX")
  /bin/chmod 600 "$tmp"
  {
    print "# ademark pf anchor rules, rendered by ademark-machine."
    if (( ${#v4} > 0 )); then
      print "table <ademark_v4> persist { ${(j:, :)v4} }"
    fi
    if (( ${#v6} > 0 )); then
      print "table <ademark_v6> persist { ${(j:, :)v6} }"
    fi
    print ""
    if (( ${#v4} > 0 )); then
      print "block drop quick from any to <ademark_v4>"
    fi
    if (( ${#v6} > 0 )); then
      print "block drop quick from any to <ademark_v6>"
    fi
  } > "$tmp"
  /bin/mv -f "$tmp" "$BLOCK_FILE"
  if ! /sbin/pfctl -a "$ANCHOR" -f "$BLOCK_FILE"; then
    warn "pfctl could not load the anchor"
    return 1
  fi
  if ! enable_output=$(/sbin/pfctl -E 2>&1); then
    warn "pfctl -E failed; pf was already enabled or could not be enabled"
  else
    token=""
    while IFS= read -r line; do
      line=$(trim "$line")
      if [[ $line =~ '^Token[[:space:]]*:[[:space:]]*([0-9]{1,20})$' ]]; then
        token=${match[1]}
        break
      fi
    done <<< "$enable_output"
    if [[ -n $token ]]; then
      token_tmp=$(/usr/bin/mktemp "$STATE_DIR/pf-token.XXXXXXXX")
      /bin/chmod 600 "$token_tmp"
      print -r -- "$token" > "$token_tmp"
      /bin/mv -f "$token_tmp" "$PF_TOKEN_FILE"
    else
      warn "pfctl -E printed no token; the pf reference will not be released"
    fi
  fi
  print "ademark-machine: blocked ${#v4} IPv4 and ${#v6} IPv6 address(es)"
}

cmd_pf_clear() {
  local token
  if ! /sbin/pfctl -a "$ANCHOR" -F all; then
    warn "pfctl could not flush the anchor"
    return 1
  fi
  /bin/rm -f "$BLOCK_FILE"
  if [[ -e $PF_TOKEN_FILE ]]; then
    token=$(/bin/cat "$PF_TOKEN_FILE" 2>/dev/null || true)
    if [[ $token =~ '^[0-9]{1,20}$' ]]; then
      if ! /sbin/pfctl -X "$token"; then
        warn "pfctl could not release the pf reference"
        return 1
      fi
    else
      warn "ignoring an invalid token in $PF_TOKEN_FILE"
    fi
    /bin/rm -f "$PF_TOKEN_FILE"
  fi
  print "ademark-machine: cleared the $ANCHOR anchor"
}

if (( EUID != 0 )); then
  warn "must run as root"
  exit 1
fi

if ! validate_machine_args "$@"; then
  exit 2
fi

subcommand=$1
shift

case $subcommand in
  on) cmd_on ;;
  off) cmd_off ;;
  status) cmd_status ;;
  purge) /usr/sbin/purge ;;
  footprint) cmd_footprint "$@" ;;
  pf-block) cmd_pf_block "$@" ;;
  pf-clear) cmd_pf_clear ;;
esac
