#!/usr/bin/env bash
# Assemble the GitHub Pages site into ./_site from docs/site plus the shared design assets.
# Used locally (Git Bash) and by .github/workflows/pages.yml. No network access.
set -euo pipefail
cd "$(dirname "$0")/.."

out=_site
rm -rf "$out"
mkdir -p "$out/assets"
cp docs/site/index.html "$out/index.html"
cp web/src/styles/tokens.css web/src/styles/base.css "$out/assets/"
cp web/public/favicon.svg "$out/assets/favicon.svg"

# Screenshots: prefer the real app screenshots, fall back to the design mockup shots.
pick() { # <dest-name> <preferred> <fallback>
  if [ -f "$2" ]; then cp "$2" "$out/assets/$1"; elif [ -f "$3" ]; then cp "$3" "$out/assets/$1"; else echo "missing screenshot for $1" >&2; fi
}
pick shot-patient-desktop.png    docs/assets/screenshots/patient-chat-1280-light.png        docs/design/shots/1280-light-patient-desktop.jpg
pick shot-refill.png             docs/assets/screenshots/patient-refill-too-early-1280-light.png docs/design/shots/1280-light-refill-outcomes.jpg
pick shot-emergency-mobile.png   docs/assets/screenshots/patient-redflag-390-light.png      docs/design/shots/390-light-emergency.jpg
pick shot-clinician.png          docs/assets/screenshots/clinician-list-390-light.png       docs/design/shots/390-light-clinician-list.jpg

# Latest eval summary, if one exists (the page hides the section otherwise).
if [ -f data/eval/results/summary.json ]; then cp data/eval/results/summary.json "$out/eval-summary.json"; fi
touch "$out/.nojekyll"
echo "built $out: $(find "$out" -type f | wc -l) files"
