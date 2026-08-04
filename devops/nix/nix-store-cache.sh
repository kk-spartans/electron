#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 export <outfile> [flake-target]" >&2
  echo "       $0 import <archive>" >&2
  exit 1
}

cmd="${1:-}"
case "$cmd" in
  export)
    out="${2:?missing outfile}"
    target="${3:-.#docker}"
    store_dir=$(nix eval --raw --expr 'builtins.storeDir' 2>/dev/null || echo /nix/store)
    docker_out=$(nix path-info "$target")
    default_out=$(nix path-info .#default)
    reactions_out=$(nix path-info .#reactions)
    paths="$docker_out $default_out $reactions_out"
    bun_deps_drv=$(nix-store -qR "$(nix eval --raw "$target.drvPath")" | grep -E -m1 'electron-bun-deps(-[0-9][^/]*)?\.drv$' || true)
    if [ -n "$bun_deps_drv" ]; then
      paths="$paths $(nix-store -q --outputs "$bun_deps_drv")"
    fi
    nix-store --export $(nix-store -qR $paths | sort -u) | gzip -6 > "$out"
    echo "exported $(wc -c < "$out") bytes to $out" >&2
    ;;
  import)
    archive="${2:?missing archive}"
    gunzip -c "$archive" | sudo env "PATH=$PATH" nix-store --import
    ;;
  *)
    usage
    ;;
esac
