{
  description = "sence - a thin fence wrapper that suggests policy refinements";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.stdenvNoCC.mkDerivation {
            pname = "sence";
            version = "0.1.0";

            src = self;

            nativeBuildInputs = [ pkgs.makeWrapper ];

            dontBuild = true;
            dontConfigure = true;

            # fence(1) and codex(1) are not in nixpkgs; they are expected on
            # the user's PATH at runtime. tmux is suffixed so --interactive
            # works out-of-box, while still letting the user's own tmux win.
            installPhase = ''
              runHook preInstall

              libDir=$out/lib/sence
              mkdir -p "$libDir"
              cp -r bin src package.json LICENSE "$libDir/"

              makeWrapper ${pkgs.nodejs_20}/bin/node $out/bin/sence \
                --add-flags "$libDir/bin/sence" \
                --suffix PATH : ${pkgs.lib.makeBinPath [ pkgs.tmux ]}

              runHook postInstall
            '';

            meta = {
              description = "A thin fence wrapper - suggests policy refinements.";
              homepage = "https://github.com/toqoz/sence";
              license = pkgs.lib.licenses.mit;
              platforms = pkgs.lib.platforms.unix;
              mainProgram = "sence";
            };
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_20
              pkgs.tmux
            ];
          };
        }
      );
    };
}
