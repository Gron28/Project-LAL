# Quickstart

> 👏 Welcome to LAL!

This quickstart guide will have you using AI-powered coding assistance in just a few minutes. By the end, you'll understand how to use LAL for common development tasks.

## Before you begin

Make sure you have:

- A **terminal** or command prompt open
- A code project to work with
- Access to the Local AI Lab tailnet
- The LAL pairing token printed on `main-pc`

## Step 1: Install LAL

To install LAL, use one of the following methods:

### Quick Install (Recommended)

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
> It's recommended to restart your terminal after installation to ensure environment variables take effect.

## Step 2: Set up authentication

When you start an interactive session with the `lal` command, the managed Local AI Lab provider is already configured:

```bash
# You'll be prompted to set up authentication on first use
lal
```

```bash
# Or run /auth anytime to change authentication method
/auth
```

The first-run menu lets you connect a model provider. Choose one of:

- **Alibaba ModelStudio** — the recommended setup. Opens a sub-menu:
  - **Coding Plan**: for individual developers, with an included weekly quota and diverse model options. See the [Coding Plan guide](https://bailian.console.aliyun.com/cn-beijing/?tab=coding-plan#/efm/coding-plan-index) ([intl](https://modelstudio.console.alibabacloud.com/?tab=coding-plan#/efm/coding-plan-index)) for setup instructions.
  - **Token Plan**: usage-based billing with a dedicated endpoint, aimed at teams and companies.
  - **Standard API Key**: connect with an existing API key from Alibaba Cloud ModelStudio ([Beijing](https://bailian.console.aliyun.com/) / [intl](https://modelstudio.console.alibabacloud.com/)). See the API setup guide ([Beijing](https://bailian.console.aliyun.com/cn-beijing/?tab=doc#/doc/?type=model&url=3023091) / [intl](https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=doc#/doc/?type=model&url=2974721)) for details.
- **Third-party Providers** — choose a built-in provider (DeepSeek, MiniMax, Z.AI, ModelScope, OpenRouter, Requesty, and more) and connect with an API key.
- **Custom Provider** — manually connect a local server, proxy, or unsupported provider.

> ⚠️ **Note**: Qwen OAuth was discontinued on April 15, 2026. If you were previously using Qwen OAuth, please switch to one of the methods above.

> [!note]
>
> When you first authenticate LAL with your Qwen account, a workspace called ".qwen" is automatically created for you. This workspace provides centralized cost tracking and management for all LAL usage in your organization.

> [!tip]
>
> To configure authentication, start LAL and run `/auth`. Use `/doctor` to check your current configuration at any time. See the [Authentication](./configuration/auth) page for details.

## Step 3: Start your first session

Open your terminal in any project directory and start LAL:

```bash
# optional
cd /path/to/your/project
# start qwen
qwen
```

You'll see the LAL welcome screen with your session information, recent conversations, and latest updates. Type `/help` for available commands.

## Chat with LAL

### Ask your first question

LAL will analyze your files and provide a summary. You can also ask more specific questions:

```
explain the folder structure
```

You can also ask LAL about its own capabilities:

```
what can LAL do?
```

> [!note]
>
> LAL reads your files as needed - you don't have to manually add context. LAL also has access to its own documentation and can answer questions about its features and capabilities.

### Make your first code change

Now let's make LAL do some actual coding. Try a simple task:

```
add a hello world function to the main file
```

LAL will:

1. Find the appropriate file
2. Show you the proposed changes
3. Ask for your approval
4. Make the edit

> [!note]
>
> LAL always asks for permission before modifying files. You can approve individual changes or enable "Accept all" mode for a session.

### Use Git with LAL

LAL makes Git operations conversational:

```
what files have I changed?
```

```
commit my changes with a descriptive message
```

You can also prompt for more complex Git operations:

```
create a new branch called feature/quickstart
```

```
show me the last 5 commits
```

```
help me resolve merge conflicts
```

### Fix a bug or add a feature

LAL is proficient at debugging and feature implementation.

Describe what you want in natural language:

```
add input validation to the user registration form
```

Or fix existing issues:

```
there's a bug where users can submit empty forms - fix it
```

LAL will:

- Locate the relevant code
- Understand the context
- Implement a solution
- Run tests if available

### Test out other common workflows

There are a number of ways to work with LAL:

**Refactor code**

```
refactor the authentication module to use async/await instead of callbacks
```

**Write tests**

```
write unit tests for the calculator functions
```

**Update documentation**

```
update the README with installation instructions
```

**Code review**

```
review my changes and suggest improvements
```

> [!tip]
>
> **Remember**: LAL is your AI pair programmer. Talk to it like you would a helpful colleague - describe what you want to achieve, and it will help you get there.

## Essential commands

Here are the most important commands for daily use:

| Command               | What it does                                     | Example                       |
| --------------------- | ------------------------------------------------ | ----------------------------- |
| `qwen`                | start LAL                                        | `qwen`                        |
| `/auth`               | Change authentication method (in session)        | `/auth`                       |
| `/doctor`             | Check current authentication and environment     | `/doctor`                     |
| `/help`               | Display help information for available commands  | `/help` or `/?`               |
| `/compress`           | Replace chat history with summary to save Tokens | `/compress`                   |
| `/clear`              | Clear terminal screen content                    | `/clear` (shortcut: `Ctrl+L`) |
| `/theme`              | Change LAL visual theme                          | `/theme`                      |
| `/language`           | View or change language settings                 | `/language`                   |
| → `ui [language]`     | Set UI interface language                        | `/language ui zh-CN`          |
| → `output [language]` | Set LLM output language                          | `/language output Chinese`    |
| `/quit`               | Exit LAL immediately                             | `/quit` or `/exit`            |

See the [CLI reference](./features/commands) for a complete list of commands.

## Pro tips for beginners

**Be specific with your requests**

- Instead of: "fix the bug"
- Try: "fix the login bug where users see a blank screen after entering wrong credentials"

**Use step-by-step instructions**

- Break complex tasks into steps:

```
1. create a new database table for user profiles
2. create an API endpoint to get and update user profiles
3. build a webpage that allows users to see and edit their information
```

**Let LAL explore first**

- Before making changes, let LAL understand your code:

```
analyze the database schema
```

```
build a dashboard showing products that are most frequently returned by our UK customers
```

**Save time with shortcuts**

- Press `?` to see all available keyboard shortcuts
- Use Tab for command completion
- Press ↑ for command history
- Type `/` to see all slash commands

## Getting help

- **In LAL**: Type `/help` or ask "how do I..."
- **Documentation**: You're here! Browse other guides
- **Community**: Join our [GitHub Discussion](https://github.com/QwenLM/qwen-code/discussions) for tips and support
