# dsh-pet-remielle · Remielle Desktop Pet

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[中文](README.md) | **English**

A desktop pet plugin for the DeepSeek Harness Web GUI featuring Remielle (蕾米埃尔), a character from *Zenless Zone Zero*. Sticker assets are from the official ZZZ activity sticker pack.

## Effects

A transparent floating pet that switches animated stickers based on the DSH work state (GIF previews below are the actual stickers used):

| State | Sticker | Trigger |
|---|---|---|
| Working_01 | <img src="assets/01.gif" width="120" alt="01 working"> | Streaming an answer |
| Working_02 | <img src="assets/02.gif" width="120" alt="02 working"> | Calling a tool |
| Satisfied | <img src="assets/03.gif" width="120" alt="03 satisfied"> | Within 6s of finishing a turn |
| Thinking | <img src="assets/04.gif" width="120" alt="04 thinking"> | Think block / not yet output |
| Waiting | <img src="assets/05.gif" width="120" alt="05 waiting"> | Question/approval prompt · 2min idle |
| Idle | <img src="assets/06.gif" width="120" alt="06 idle"> | Regular idle |

The pet floats at the bottom-right of the page (draggable), transparent with no card. Left-click plays a random action; the context menu adjusts scale/opacity, locks & resets position, hides↔wakes, pauses animation, and opens the settings panel.

The settings panel uses a dsh-style two-column layout with four sections (Appearance, Behavior, Update, Feedback); all settings persist automatically across restarts. The pet checks the GitHub repo for new versions: a "New version" bubble appears above its head, and the settings button becomes "Update" for one-click incremental updates (whether to update is always your choice).

## Install

```sh
dsh plugin --profile web add github:Gin-7/dsh-pet-remielle
```

Takes effect on load and restores on uninstall (plugin row id `ui-pet-remielle`).

## Development & Build

```sh
pnpm install
pnpm build          # regenerate embedded assets + tsdown build to lib/
```

- `scripts/generate-art.mjs` inlines `assets/*.gif` into `src/client/art.generated.ts` (data URIs).
- `build/` is the tsdown client build preset.
- Built artifacts in `lib/` are committed; no build needed to install.

## Copyright & License

- **Plugin source code**: released under the [MIT License](LICENSE).
- **Assets**: from the ZZZ "初代虚狩，回归" activity pack; copyright belongs to the rights holders (miHoYo/HoYoverse). This plugin is for personal learning and entertainment only — **commercial use and redistribution of the assets themselves are prohibited**. Attribution and source chain: see `NOTICE`.
