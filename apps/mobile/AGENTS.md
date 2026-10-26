This is the Expo / React Native app of the coord monorepo. The repo-wide rules in the root [AGENTS.md](../../AGENTS.md) apply here too. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed: do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json` (currently SDK 58).
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt, an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Run checks through Nx from the repo root, so the shared ESLint config, caching and boundary rules apply:

```bash
pnpm exec nx run-many -t lint typecheck test build -p @coord/mobile   # definition of done for this app
pnpm mobile                                                         # expo start
```

From `apps/mobile`:

```bash
pnpm exec expo install <package>       # ALWAYS use instead of pnpm add: resolves SDK-compatible versions
pnpm exec expo install <package> -- -D # dev dependency
pnpm exec expo-doctor                  # diagnose dependency and config issues
pnpm exec expo install --fix           # fix incompatible package versions
```

Don't run `expo lint`. Linting uses the root `eslint.config.mjs`, and `expo lint` would add a second config.

- **Tests:** `jest-expo` and React Native Testing Library, in `*.test.tsx` files next to the code. In RNTL 14, `render` is async, so `await render(...)`.
- **Build:** `build` runs `expo export` for iOS and Android. CI uses it to prove Metro can bundle the workspace packages.

## Navigation & Routing

The app is still a single `App.tsx`. When screens are added (Phase 4), adopt **Expo Router**:

- install it with `expo install`;
- put routes in `src/app/`, where every file is a screen and `_layout.tsx` files define navigators;
- keep non-route code outside `src/app/`.

Docs: https://docs.expo.dev/router/introduction.md

Data comes from `@coord/app-state` hooks inside `<ClientProvider>`, with a relay Transport (Phase 4). Don't import `@coord/ui-web`: it is React DOM, and lint blocks it.

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`), and to ship over-the-air updates (`eas update`). No local Xcode or Android Studio is required. Run EAS CLI as `pnpm dlx eas-cli@latest <command>`. Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand; configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `pnpm exec expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
