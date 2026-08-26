# OS1 app icon sources

The approved full-bleed artwork lives in the native iOS asset catalog:

`packages/clients/ios/OS1/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png`

That opaque 1024px image is the single artwork master. iOS applies its own
continuous icon mask. The native macOS target carries padded transparent
renditions in `AppIconMac.appiconset`.

The Electron shell needs three representations of the same artwork:

- `packages/clients/mac/build/AppIcon.icon` and `Assets.car` for macOS 26+
- `packages/clients/mac/build/icon.icns` for earlier macOS releases and packaging
- `packages/clients/mac/build/icon-512.png` for Electron's development Dock override

On a Mac with Xcode 26+, rebuild all Electron icon artifacts with:

```sh
sh packages/clients/mac/scripts/compile-icon.sh
```

The script first runs `generate.ts`, which copies the native master into the
Icon Composer document without adding another glass treatment. It then
compiles `Assets.car` and packs the already-padded native macOS renditions into
the legacy `.icns` and Dock PNG. Generated scratch artifacts under this
directory are ignored; the Electron build artifacts are committed because CI
does not compile Icon Composer documents.
