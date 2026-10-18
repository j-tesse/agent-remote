# agent-remote

A harness-agnostic web remote for AI coding agents.

`agent-remote` is a single webpage for managing your local AI agent sessions —
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) and
[pi](https://github.com/getpi/pi) and [Aider](https://aider.chat) today, and any other CLI-based harness you
care to plug in tomorrow. Start, watch, steer, and switch between sessions from
one browser tab instead of juggling terminals.

> **Status:** early development. Interfaces and scope are still moving.

## Why

Agent harnesses are powerful but live in the terminal — one session per pane,
no shared view, easy to lose track of what's running. `agent-remote` puts them
behind a common web UI so you can run several at once, see them at a glance, and
jump in when one needs you.

The design goal is to stay **harness-agnostic**: every harness is reached
through a small adapter, so the UI, session management, and convenience features
work the same regardless of which agent is underneath.

## How it works

```
Browser (React UI + xterm.js)
        │  HTTP + WebSocket  (one port)
        ▼
Node backend  ──spawns & supervises──▶  agent CLI processes in a PTY
        │                                 (claude code, pi, …)
        └── harness adapters ────────────▶  one per harness
```

- The **Node backend** spawns each agent as a local subprocess in a PTY,
  supervises its lifecycle, and streams its terminal I/O to the browser.
- The **React frontend** renders each session in an xterm.js terminal and sends
  your keystrokes back.
- A **harness adapter** maps each agent's CLI invocation onto a common
  interface, which is what keeps the rest of the system harness-agnostic.
- Everything — UI, API, and WebSocket — is served from a **single port**, so the
  app is easy to run behind a tunnel or reverse proxy.

## Features

- **Multi-session management** — launch, view, and switch between concurrent
  Claude Code and pi sessions from one page.
- **Live streaming** — agent output streamed to the browser in real time, with
  the ability to send input back.
- **Pluggable harnesses** — add a new agent by writing an adapter, not by
  changing the UI.

### LLM-powered convenience features

Optional features that use an LLM to make a wall of sessions easier to manage.

Available today:

- **AI-assistant mode** — point it at any OpenAI-compatible endpoint (a local
  model works fine) and it can answer an agent's permission prompts and
  multiple-choice questions on your behalf, following your instructions. It's
  best-effort and fail-safe: if the endpoint is unreachable, sessions fall back
  to the normal manual prompts.

Planned:

- **Session summaries** — a short, always-current description of what each
  session is doing and where it stands.
- **Natural-language routing** — describe a task in plain language and have it
  routed to the right agent or session.
- **Notifications & triage** — surface the sessions that need your attention and
  summarize why.

## Getting started

```bash
npm install
./config-gen.sh      # generates config.json (gitignored)
npm run add-user     # creates a login and enables it in config.json
npm run dev          # single-port dev server with hot reload
```

Then open the printed local URL (default <http://localhost:4000>) in your
browser. The app is login-gated — sign in with the account from `npm run add-user`
and launch a session from the sidebar. Web registration is closed by default
(`"registration": "open"` in `config.json` re-enables it); login attempts are
rate-limited per IP and per username.

For a production run:

```bash
npm run build        # builds the frontend into dist/web
npm start            # serves UI + API + WebSocket on one port
```

**Requirements:** Node.js, plus the agent CLIs you want to drive
(e.g. `claude` and `pi`) installed and available on your `PATH`. All
configuration lives in `config.json` — see `config.example.json` for the shape.
Aider runs through a small Python bridge under aider's own interpreter (found
via the `aider` launcher's shebang), always in the `diff-fenced`
SEARCH/REPLACE edit format; your `~/.aider.conf.yml` still applies, and
`harnesses.aider.args` adds CLI flags (e.g. `--model`).

## Contributing

This is an open-source project and contributions are welcome. The most useful
way to extend it is by adding a **harness adapter** for a new agent. Issues and
pull requests are appreciated — please open an issue to discuss larger changes
first.

## License

[MIT](./LICENSE) © Jöran Tesse
