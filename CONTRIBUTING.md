# Contributing to Peek

Use Node.js 22.12 or newer (CI uses Node.js 22), then run:

```sh
npm ci
npm test
npm run build
npm run dev
```

Keep changes small and include the problem, resulting behavior, and checks performed in your pull request. Tests must use synthetic articles and mocked API responses. Do not include API keys, real recordings, screenshots, transcripts, or private Obsidian vaults in commits or bug reports.

Peek uses Electron 30, plain TypeScript, and CSS. Keep API credentials and network requests in the main process. Keep native platform details in `src/main/platform.ts`. Audio, transcripts, and conversation state must remain in memory. See `HONESTY.md` before changing capture, routing, or privacy claims.

## macOS packages

Build on the matching architecture where possible:

```sh
# Apple Silicon Mac
npm run package:mac:arm64

# Intel Mac
npm run package:mac:x64
```

Artifacts appear in `release/`. Koffi uses architecture-specific optional packages. The packaging hook includes the requested architecture's addon in app resources; if it is missing locally, the hook downloads the exact package pinned in `package-lock.json`, verifies its SHA-512 integrity and Mach-O architecture, and includes only the native addon. It does not change dependencies or run downloaded install scripts. Cross-builds therefore need network access when that addon is missing and still require testing on the target hardware. CI uses native Apple Silicon and Intel runners and checks that the packaged native module loads. That check does not test microphone permissions, global shortcuts, screen capture, or screen-share exclusion.

Packages are unsigned and not notarized. Expect macOS Gatekeeper warnings. The manual **Prepare unsigned release artifacts** workflow creates downloadable workflow artifacts and checksums; it does not publish a GitHub Release. No signing credentials or LLM API keys are needed in CI.

When reporting a bug, include the macOS version, CPU architecture, Peek version, input device, reproduction steps, and a redacted error message. Distinguish a successful package build from testing the app on that hardware. Windows platform code is present, but Windows release packaging and hardware verification are separate work.
