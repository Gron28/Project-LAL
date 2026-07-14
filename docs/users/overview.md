# LAL overview

> LAL is Local AI Lab's terminal agent. It runs tools in your current project and
> streams model inference from `main-pc` over your Tailscale network.

## Get started in 30 seconds

### Install LAL:

The installer pairs this computer with `main-pc`, installs the managed runtime,
and preserves project chats under `~/.lal` across updates.

**Linux / macOS**

```sh
curl -fsSL https://main-pc.tail3ba909.ts.net/lal/install.sh | bash
```

**Windows**

```powershell
irm https://main-pc.tail3ba909.ts.net/lal/install.ps1 | iex
```

> [!note]
>
> Restart your terminal if `lal` is not immediately available on PATH.

### Start using LAL:

```bash
cd your-project
lal
```

On first launch you'll be prompted to connect a model provider. The menu offers **Alibaba ModelStudio** (Coding Plan, Token Plan, or Standard API Key), **Third-party Providers** (built-in providers such as DeepSeek, MiniMax, Z.AI, and OpenRouter, connected with an API key), and **Custom Provider** (a local server, proxy, or unsupported provider). For the [Alibaba Cloud Coding Plan](https://bailian.console.aliyun.com/cn-beijing/?tab=coding-plan#/efm/coding-plan-index) ([intl](https://modelstudio.console.alibabacloud.com/?tab=coding-plan#/efm/coding-plan-index)), choose **Alibaba ModelStudio → Coding Plan**; to use a ModelStudio API key, choose **Alibaba ModelStudio → Standard API Key** and follow the API setup guide ([Beijing](https://bailian.console.aliyun.com/cn-beijing/?tab=doc#/doc/?type=model&url=3023091) / [intl](https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=doc#/doc/?type=model&url=2974721)). Then let's start with understanding your codebase. Try one of these commands:

```
what does this project do?
```

![](https://cloud.video.taobao.com/vod/j7-QtQScn8UEAaEdiv619fSkk5p-t17orpDbSqKVL5A.mp4)

You'll be prompted to log in on first use. That's it! [Continue with Quickstart (5 mins) →](./quickstart)

> [!tip]
>
> See [troubleshooting](./support/troubleshooting) if you hit issues.

> [!note]
>
> **New VS Code Extension (Beta)**: Prefer a graphical interface? Our new **VS Code extension** provides an easy-to-use native IDE experience without requiring terminal familiarity. Simply install from the marketplace and start coding with LAL directly in your sidebar. Download and install the [LAL Companion](https://marketplace.visualstudio.com/items?itemName=qwenlm.qwen-code-vscode-ide-companion) now.

## What LAL does for you

- **Build features from descriptions**: Tell LAL what you want to build in plain language. It will make a plan, write the code, and ensure it works.
- **Debug and fix issues**: Describe a bug or paste an error message. LAL will analyze your codebase, identify the problem, and implement a fix.
- **Navigate any codebase**: Ask anything about your team's codebase, and get a thoughtful answer back. LAL maintains awareness of your entire project structure, can find up-to-date information from the web, and with [MCP](./features/mcp) can pull from external datasources like Google Drive, Figma, and Slack.
- **Automate tedious tasks**: Fix fiddly lint issues, resolve merge conflicts, and write release notes. Do all this in a single command from your developer machines, or automatically in CI.
- **[Followup suggestions](./features/followup-suggestions)**: LAL predicts what you want to type next and shows it as ghost text. Press Tab to accept, or just keep typing to dismiss.

## Why developers love LAL

- **Works in your terminal**: Not another chat window. Not another IDE. LAL meets you where you already work, with the tools you already love.
- **Takes action**: LAL can directly edit files, run commands, and create commits. Need more? [MCP](./features/mcp) lets LAL read your design docs in Google Drive, update your tickets in Jira, or use _your_ custom developer tooling.
- **Unix philosophy**: LAL is composable and scriptable. `tail -f app.log | qwen -p "Slack me if you see any anomalies appear in this log stream"` _works_. Your CI can run `qwen -p "If there are new text strings, translate them into French and raise a PR for @lang-fr-team to review"`.
