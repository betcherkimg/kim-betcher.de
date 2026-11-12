#!/bin/bash
# Figur neu bauen: tools/figuren/build.sh <Kim|Maksim> [armdeg legdeg footdeg fbend]
# Braucht: Python mit dem Modul bpy (Blender als Python-Modul) in $BPY_PYTHON,
# gltf-transform (npm: @gltf-transform/cli) und die Blender-Quellen in $FIGUREN_QUELLE.
# Ergebnis: <name>.glb im Arbeitsordner; danach nach 1293e128973/assets/figuren/ kopieren
# und FIGURE_VERSION in character.js hochzählen.
set -e
HIER="$(cd "$(dirname "$0")" && pwd)"
export FIGUREN_ARBEIT="${FIGUREN_ARBEIT:-$PWD}"
PY="${BPY_PYTHON:-python3}"
W=$1; w=$(echo "$1" | tr A-Z a-z); shift
cd "$FIGUREN_ARBEIT"
"$PY" "$HIER/retarget5.py" "$W" "$@"
"$PY" "$HIER/export_who.py" "$W"
G="${GLTF_TRANSFORM:-npx gltf-transform}"
$G dedup "${w}_raw.glb" "${w}1.glb"
$G resize "${w}1.glb" "${w}2.glb" --width 2048 --height 2048
$G webp "${w}2.glb" "${w}3.glb" --quality 86
$G meshopt "${w}3.glb" "${w}.glb"
ls -la "${w}.glb"
