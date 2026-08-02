{
  config,
  lib,
  pkgs,
  ...
}:
let
  flake = builtins.getFlake (toString ../.);
  dockerImage = flake.packages.${pkgs.stdenv.hostPlatform.system}.docker;
in
{
  config.project.name = "electron";

  config.services.electron = {
    build.image = lib.mkForce dockerImage;

    service = {
      env_file = [ "./.env" ];
      environment = {
        OPENAI_BASE_URL = "\${OPENAI_BASE_URL:-https://api.openai.com/v1}";
        OPENAI_MODEL = "\${OPENAI_MODEL:-gpt-4o-mini}";
        PORT = "\${ELECTRON_PORT:-8080}";
      };
      ports = [ "\${ELECTRON_PORT:-8080}:8080" ];
      restart = "unless-stopped";
    };
  };
}
