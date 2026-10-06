#!/usr/bin/env bash
#
# Rebuild lib/ from upstream DeepSeek Harness.
#
# The plugin is a patch over the upstream ACP package, not a fork: this clones
# deepseek-ai/deepseek-harness at the tag named by package.json's
# `chubbyclaw.dshRuntimeVersion`, applies patches/, builds with the upstream
# toolchain, and copies the bundle back here.
#
#   scripts/build.sh            # build and copy lib/ + lib/types/
#   scripts/build.sh --test     # also run the upstream ACP test suite
#
# Requires: git, node, pnpm.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$root/package.json').chubbyclaw.dshRuntimeVersion")"
tag="${DSH_UPSTREAM_TAG:-dsh-v$version}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "==> cloning deepseek-ai/deepseek-harness at $tag"
git clone --depth 1 --branch "$tag" https://github.com/deepseek-ai/deepseek-harness.git "$work/dsh"

cd "$work/dsh"
for patch in "$root"/patches/*.patch; do
  echo "==> applying $(basename "$patch")"
  git apply "$patch"
done

echo "==> installing"
pnpm install

echo "==> building with the upstream toolchain"
node ./node_modules/typescript/bin/tsc -b tsconfig.host.json
./node_modules/.bin/tsdown --config-loader native --env.DSH_BUILD_FACE host

if [ "${1:-}" = "--test" ]; then
  echo "==> building the native system addon the ACP tests need"
  pnpm run build:native-system
  echo "==> running the upstream ACP test suite"
  ./node_modules/.bin/vitest run packages/acp/acp
fi

echo "==> copying the bundle into $root/lib"
mkdir -p "$root/lib"
cp packages/acp/acp/lib/index.js "$root/lib/index.js"
rm -rf "$root/lib/types"
cp -R packages/acp/acp/lib/types "$root/lib/types"
# The package ships declarations only; the intermediate JS is not published.
find "$root/lib/types" -type f ! -name '*.d.ts' ! -name '*.d.ts.map' -delete

echo "==> done ($(du -h "$root/lib/index.js" | cut -f1) bundle)"
