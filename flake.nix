{
  description = "Electron - reaction explorer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nix-packages = {
      url = "github:kk-spartans/nix-packages";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nix-packages,
      ...
    }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems f;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          bun' = (pkgs.extend nix-packages.overlays.bun-baseline).bun;
        in
        {
          reactions = pkgs.callPackage ./devops/reactions.nix { bun = bun'; };
          default = pkgs.callPackage ./devops/package.nix {
            bun = bun';
            reactions = self.packages.${system}.reactions;
          };
          docker = pkgs.callPackage ./devops/docker.nix {
            app = self.packages.${system}.default;
          };
        }
      );

      legacyPackages = forAllSystems (system: nixpkgs.legacyPackages.${system});

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/electron-server";
        };
      });
    };
}
