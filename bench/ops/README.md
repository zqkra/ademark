# bench/ops: machine, account and doctor

These commands replace the ~20 macOS settings the pilot changed by hand, and check the machine before a night.
`bench/ops/machine.zsh` is the only part that runs as root.

## Install once

The root part is one root-owned script plus one sudoers rule. The owner runs this once, and again after every
change to `bench/ops/machine.zsh`:

```sh
sudo zsh bench/ops/install-machine.zsh
```

It checks that `/usr/local` and every parent are root-owned and not group- or world-writable, creates
`/usr/local/libexec`, copies `machine.zsh` to `/usr/local/libexec/ademark-machine` (root:wheel 0755) and writes
`/etc/sudoers.d/ademark-machine` (root:wheel 0440) with exactly:

```text
ademark ALL=(root) NOPASSWD: /usr/local/libexec/ademark-machine
```

It validates the sudoers file with `visudo -cf` before moving it into place. Running it twice gives the same result.

WARNING: anyone who can edit `/usr/local/libexec/ademark-machine` can run code as root through that rule. Re-run the
installer after every change to `machine.zsh`; never point the rule at the repository copy.

## `ademark machine on|off|status [--apply]`

`on` saves the current system state once to `/var/db/ademark-machine/before.env` and applies the night settings:
Spotlight indexing off, Power Nap, sleep, display sleep and disk sleep off, automatic update checks off, the five
SoftwareUpdate keys false, and Time Machine automatic backups off. Running `on` twice keeps the first `before.env`.

`off` restores every recorded value exactly (an `absent` update key is deleted again, a volume that was off stays
off) and deletes `before.env`. Without `before.env` it prints `nothing to restore` and exits 0.

`status` prints one `key=value` line per setting, the current value, whether `before.env` exists, and the state of the
`com.apple/ademark` pf anchor.

On top of the root part, as the user:

- the main display goes to 60 Hz with `displayplacer`; `~/.ademark/machine-user.json` keeps the full current mode
  string so `off` restores it. Without `displayplacer`, `on` prints the manual System Settings step.
- `mediaanalysisd` and `photoanalysisd` owned by this user are paused with `SIGSTOP` and resumed with `SIGCONT` on
  `off`; their pids are saved in the same file.
- `launchctl setenv T3CODE_TELEMETRY_ENABLED false` on `on`, `unsetenv` on `off`.

Every state-changing action is a dry run unless `--apply`, and `--apply` only works as the `ademark` user. Dry runs
print each command and change nothing.

The root script accepts only `on`, `off`, `status`, `purge`, `footprint <pid>...` (1 to 64 pids),
`pf-block <ip>...` (1 to 32 IPv4 or IPv6 literals) and `pf-clear`; every other argument list exits 2. `footprint`
writes its JSON to a root-owned temp file under `/var/db/ademark-machine/`, prints it and deletes it. pf rules are
rendered by the script into `/var/db/ademark-machine/block.conf` and loaded into the `com.apple/ademark` anchor only.
`pf-block` saves the `pfctl -E` reference token in `/var/db/ademark-machine/pf.token` (root-owned, mode 600);
`pf-clear` flushes the anchor's rules and tables and releases that reference before deleting the token.

## `ademark account check|setup [--apply]`

`check` reports `ok`, `missing`, `differs` or `skip` for every setting that lives only in the `ademark` account:
the Ghostty config from RUNBOOK.md 4.10, `env.DISABLE_AUTOUPDATER` in `~/.claude/settings.json`, the top-level Codex
`check_for_update_on_startup = false`, the `~/arena` trust entry, the Adobe launch agents and Finder extension, and
the mitmproxy CA in the login keychain.

`setup --apply` fixes every item except the mitmproxy CA; trusting that certificate asks for the password, so the
command prints the `security add-trusted-cert` line for the owner to run. A second `setup --apply` changes nothing.

## `ademark doctor [--json]`

Runs about 25 checks before a night and prints a table (`ok`, `FAIL`, `warn`, name, detail, fix). It exits 1 when a
blocking check fails. `--json` prints the same results as JSON.

When the current user is not `ademark`, every check that would call `sudo` or change anything reports
`skip (not the ademark user)` and runs nothing. Otherwise doctor only reads: it never changes a setting.

Checks, in order: running as `ademark`; no agent-session variables; root script and sudoers rule; machine state on;
display at 60 Hz; `ademark-native` built and permitted; Ghostty memory under 400 MB; no other GUI apps; account items;
`claude`/`codex` versions against `pins/versions.json`; Claude and Codex logins; adapter installs and SHA-256; adapter
logins; calibration gates (warn); mitmdump and the Mitmproxy Redirector extension; leftover harness variables in launchd;
replay port 8787; swap, thermal and quiet-CPU gates; 8 GB free; `snapshots/clean`; a clean harness tree at a commit; AC
power with Low Power Mode off; Do Not Disturb on (warn); an empty `ademark` pf anchor; adapter seeds (warn).

`calibration gates` (warn) lists every installed ADE whose gate record is `missing`, `failed` or `stale`, with the
status, and says `these ADEs will be skipped tonight`; the fix is `bun bench/cli.ts calibrate gate --ade <id>`. It never
blocks: the night skips those ADEs and measures the rest.

## Undo everything

```sh
bun bench/cli.ts machine off --apply
rm -f ~/.ademark/machine-user.json
sudo rm -f /etc/sudoers.d/ademark-machine /usr/local/libexec/ademark-machine
```

`machine off` puts back every system setting recorded by `on` and resumes the paused analyzers. The sudoers removal
takes effect at once; the rule is only needed while measuring.
