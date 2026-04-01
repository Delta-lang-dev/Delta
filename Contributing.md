# Contributing to Delta (Δ)

Thank you for your interest in contributing to Delta! This guide will help you get started.

## Before You Start

- Check the [open issues](../../issues) to see if your idea or bug is already being tracked
- For significant changes, open an issue first to discuss the approach before writing code
- For small fixes (typos, docs), feel free to open a PR directly

## Setting Up Locally

1. Fork the repo and clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/delta.git
   cd delta
Install dependencies:
npm install
Build the compiler:
npm run build
Run the tests:
npm test
Branch Naming
Type
Format
Example
New feature
feat/short-description
feat/rust-adapter
Bug fix
fix/short-description
fix/guard-runtime-crash
Documentation
docs/short-description
docs/patch-construct
Refactor
refactor/short-description
refactor/lexer-tokens
Always branch from main.
Submitting a Pull Request
Push your branch to your fork
Open a PR against Delta-Lang-Dev/delta:main
Fill out the PR template completely
A maintainer will review within a few days
One approval is required before merging
Code Style
TypeScript strict mode is enforced — no any unless absolutely necessary
Run npm run lint before submitting and fix all warnings
Keep functions small and focused
Add JSDoc comments to exported functions
Reporting Bugs
Use the Bug Report issue template. Include:
The exact .delta code that triggers the bug
The target language you're transforming to
The full error message or unexpected output
Your OS and Delta version (delta --version)
Questions?
Open a Discussion — not an issue — for general questions.
