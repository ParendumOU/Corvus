# Release builder: produces Windows (.exe NSIS + portable) and Linux (AppImage, deb) packages.
# macOS packages require a macOS host (codesign/notarization) and are built in CI on a mac runner.
FROM electronuserland/builder:wine
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /project
ENV CI=true ELECTRON_CACHE=/root/.cache/electron ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder
