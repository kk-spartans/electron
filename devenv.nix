{ pkgs, inputs, ... }:

let
  originalBun = pkgs.bun;
  pkgs' = pkgs.extend inputs.nix-packages.overlays.bun-baseline;
  bun' = pkgs.runCommand "bun-${originalBun.version}" {
    version = originalBun.version;
  } ''
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

  enterShell = ''
    bun run devops/copy-rdkit.ts
  '';

  tasks = {
    "electron:check".exec = "bun run devops/check.ts";
    "electron:dev".exec = "bun run dev";
  };
}
