{
  description = "Robocode Showdown — dev environment for authoring and battling Tank Royale bots";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.temurin-jre-bin-21
          ];

          shellHook = ''
            echo "Robocode Showdown dev shell — node $(node --version), java $(java -version 2>&1 | head -1)"
          '';
        };
      });
}
