#!/bin/zsh -f
# Installs the root part of `ademark machine`: one root-owned script and one sudoers rule.
# Run once by the owner: sudo zsh bench/ops/install-machine.zsh
set -euo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

readonly SOURCE=${0:A:h}/machine.zsh
readonly TARGET=/usr/local/libexec/ademark-machine
readonly SUDOERS=/etc/sudoers.d/ademark-machine
readonly RULE='ademark ALL=(root) NOPASSWD: /usr/local/libexec/ademark-machine'

warn() {
  print -u2 "install-machine: $*"
}

fail() {
  warn "$*"
  exit 1
}

if (( EUID != 0 )); then
  fail "run it with: sudo zsh bench/ops/install-machine.zsh"
fi

if [[ ! -f $SOURCE ]]; then
  fail "missing $SOURCE"
fi

# /usr/local is where the sudoers rule points. A group- or world-writable folder on that path would let anyone
# replace the script and take root through the rule.
check_root_owned() {
  local path=$1 owner perms
  if [[ ! -e $path ]]; then
    fail "$path does not exist"
  fi
  if [[ -L $path ]]; then
    fail "$path is a symlink; the rule needs a real root-owned folder"
  fi
  owner=$(/usr/bin/stat -f '%Su:%Sg' "$path")
  perms=$(/usr/bin/stat -f '%Sp' "$path")
  if [[ $owner != root:wheel ]]; then
    fail "$path is owned by $owner, not root:wheel"
  fi
  if [[ ${perms[6]} == w || ${perms[9]} == w ]]; then
    fail "$path is group- or world-writable ($perms)"
  fi
}

local_path=/usr/local
while true; do
  check_root_owned "$local_path"
  if [[ $local_path == / ]]; then
    break
  fi
  local_path=${local_path:h}
done

if [[ ! -d /usr/local/libexec ]]; then
  /bin/mkdir -p /usr/local/libexec
  /usr/sbin/chown root:wheel /usr/local/libexec
  /bin/chmod 0755 /usr/local/libexec
  print "install-machine: created /usr/local/libexec"
else
  check_root_owned /usr/local/libexec
fi

target_tmp=/usr/local/libexec/.ademark-machine.tmp.$$
sudoers_tmp=/etc/sudoers.d/.ademark-machine.tmp.$$
trap '/bin/rm -f "$target_tmp" "$sudoers_tmp"' EXIT

/bin/cp "$SOURCE" "$target_tmp"
/usr/sbin/chown root:wheel "$target_tmp"
/bin/chmod 0755 "$target_tmp"
if [[ -f $TARGET ]] && /usr/bin/cmp -s "$target_tmp" "$TARGET"; then
  print "install-machine: $TARGET unchanged"
  /bin/rm -f "$target_tmp"
else
  /bin/mv -f "$target_tmp" "$TARGET"
  print "install-machine: installed $TARGET (root:wheel 0755)"
fi

umask 077
print -r -- "$RULE" > "$sudoers_tmp"
/usr/sbin/chown root:wheel "$sudoers_tmp"
/bin/chmod 0440 "$sudoers_tmp"
# A broken sudoers file locks sudo for everyone, so validate the file before it is moved into place.
/usr/sbin/visudo -cf "$sudoers_tmp" >/dev/null
if [[ -f $SUDOERS ]] && /usr/bin/cmp -s "$sudoers_tmp" "$SUDOERS"; then
  print "install-machine: $SUDOERS unchanged"
  /bin/rm -f "$sudoers_tmp"
else
  /bin/mv -f "$sudoers_tmp" "$SUDOERS"
  /usr/sbin/chown root:wheel "$SUDOERS"
  /bin/chmod 0440 "$SUDOERS"
  print "install-machine: wrote $SUDOERS (root:wheel 0440)"
fi

print "install-machine: done. Re-run this installer after every change to machine.zsh."
print "install-machine: WARNING: anyone who can edit $TARGET can run code as root."
