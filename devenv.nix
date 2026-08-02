{ pkgs, inputs, ... }:

let
  originalBun = pkgs.bun;
  pkgs' = pkgs.extend inputs.nix-packages.overlays.bun-baseline;
  bun' =
    pkgs.runCommand "bun-${originalBun.version}"
      {
        version = originalBun.version;
      }
      ''
        mkdir -p $out/bin
        cat > $out/bin/bun << 'WRAPPER'
        #!/bin/sh
        if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
          exec ${originalBun}/bin/bun "$@"
        else
          exec ${pkgs'.bun}/bin/bun "$@"
        fi
        WRAPPER
        chmod +x $out/bin/bun
      '';
in

{
  packages = with pkgs; [
    bun'
    gitleaks
    nixfmt
    docker
    arion
    docker-compose
    jq
  ];

  languages = {
    javascript = {
      enable = true;
      bun = {
        enable = true;
        install.enable = true;
        package = bun';
      };
    };
    typescript.enable = true;
  };

  git-hooks.hooks.check = {
    enable = true;
    name = "check";
    entry = "devenv tasks run electron:check";
    pass_filenames = false;
    language = "system";
  };

  tasks = {
    "electron:check".exec = "bun run devops/scripts/check.ts";
    "electron:dev".exec = "bun run dev";
    "electron:release".exec = "bun run release";
    "electron:compose".exec =
      "arion -f devops/nix/arion-compose.nix -p devops/nix/arion-pkgs.nix cat | jq '{ services: (.services | walk(if type == \"object\" then with_entries(select(.value != {} and .value != [])) else . end)) }' > devops/nix/docker-compose.yml";
    "electron:up".exec = "arion -f devops/nix/arion-compose.nix -p devops/nix/arion-pkgs.nix up";
  };
}
