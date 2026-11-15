# Security

Report a vulnerability privately: open the repository's **Security** tab and choose **Report a vulnerability**.
Do not open a public issue for it.

The reports that matter most here:

- The root helper that `bench/ops/install-machine.zsh` installs (`/usr/local/libexec/ademark-machine`, allowed
  without a password for the `ademark` user). It must accept only its fixed subcommands.
- The network capture (`bench/capture`), which records the requests an ADE sends. Anything that could store or leak a
  tester's credentials, cookies or account data.
- Anything in this repository or in `data/` that exposes personal data.

A fix ships as a new commit and a line in [CHANGELOG.md](CHANGELOG.md).
