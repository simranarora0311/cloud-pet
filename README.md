# Cloud

A pet for Claude Code that floats above your apps, shows what Claude is doing, and tells you when it is done or needs you.

- Floats on every desktop and over full-screen apps. Drag it anywhere, click it to open Claude, right-click it to mute or hide it.
- Keeps a finished session marked done until you click it or switch to Claude.
- Sits in a small strip above the prompt too.
- Sends a macOS notification when Claude finishes, asks you a question, or needs your permission.

## Install

At the prompt of a terminal session:

```
/plugin install cloud-pet --marketplace simranarora0311/cloud-pet
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install cloud-pet --marketplace simranarora0311/cloud-pet
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `simranarora0311/cloud-pet`, then Add plugin.

Cloud follows sessions started after it is installed, so open a new session to wake it.

Needs macOS and the Xcode command line tools (`xcode-select --install`): the floating pet is built with `swiftc` the first time a session starts.

## Use

`/pet` shows or hides Cloud. `/pet mute` and `/pet unmute` turn notifications off and on. `/pet name <name>` renames it.
