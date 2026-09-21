# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

This project is pinned to **SDK 57** because it is tested on Expo Go for SDK 57. Do not upgrade the
SDK without the Expo Go app being upgraded first. iOS only ships the latest Expo Go, so when the
app updates itself, this project has to follow.

Upgraded from SDK 54 on 2026-09-21. Things that changed in 55-57 and now apply here:

- The Legacy Architecture is gone; the New Architecture is mandatory.
- Android is edge-to-edge always. `App.tsx` still derives its Android top inset from
  `RNStatusBar.currentHeight`, which has not been checked on an edge-to-edge device.
- `expo-status-bar` no longer takes `backgroundColor` and friends (this project only uses
  `style` and `hidden`, so nothing to do).
- `@expo/vector-icons` is deprecated in favour of `@react-native-vector-icons/*`. It was unused
  here and has been removed.

# git に入っていない音源

`assets/start.mp3`（はじめるボタンの音）は **リポジトリに含まれていません**。
くらげ工匠 (http://www.kurage-kosho.info/) の「ボタン081」で、商用利用無料・
クレジット不要・加工自由ですが、**素材の再配布が禁止**されています。このリポジトリは
公開されているため、コミットすると再配布にあたります。

clone しただけでは音が鳴らず、Metro の `require` も解決できません。上記サイトの
「システム音・電子音 → ボタン音」から ボタン081 を落とし、`assets/start.mp3` という
名前で置いてください。

EAS Build には `.easignore` 経由で渡しています。`.easignore` があると EAS CLI は
`.gitignore` を読まなくなるので、**`.gitignore` に何か足したら `.easignore` にも
同じ行を足す**こと。片方だけ直すと、無視したいものがビルドに紛れ込みます。
