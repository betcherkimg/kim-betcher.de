# Filzstift für Kims Wutausbrüche: ein kleines 3D-Modell, das er in der Hand hält.
# Die Spitze liegt im Ursprung, der Stift zeigt entlang +Y (in der GLB) und ist genau 1 lang; figur.js skaliert ihn.
# Materialien: "Farbe" (Spitze und Kappe, wird zur Laufzeit auf die Strichfarbe gesetzt), "Schaft", "Ring".
# Aufruf: python -I stift.py <Ausgabe.glb>
import bpy, bmesh, math, sys
OUT = sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)

def material(name, color, rough):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = rough
    return mat

MATS = {
    "Farbe": material("Farbe", (0.52, 0.04, 0.03), 0.45),
    "Schaft": material("Schaft", (0.9, 0.87, 0.8), 0.35),
    "Ring": material("Ring", (0.02, 0.03, 0.05), 0.5),
}
# Profil von der Spitze zum Ende: (Höhe, Radius, Material des Abschnitts darüber)
PROFILE = [
    (0.000, 0.004, "Farbe"),   # Spitze
    (0.020, 0.016, "Farbe"),
    (0.105, 0.026, "Ring"),    # Filz endet, Kragen
    (0.120, 0.044, "Ring"),
    (0.165, 0.050, "Schaft"),
    (0.180, 0.056, "Schaft"),  # Schaft
    (0.800, 0.056, "Farbe"),
    (0.812, 0.060, "Farbe"),   # Kappe am Ende, etwas dicker
    (0.975, 0.060, "Farbe"),
    (1.000, 0.046, None),
]
SEGMENTS = 20
mesh = bpy.data.meshes.new("Stift")
bm = bmesh.new()
rings = []
for height, radius, _ in PROFILE:
    rings.append([bm.verts.new((radius * math.cos(2 * math.pi * i / SEGMENTS), radius * math.sin(2 * math.pi * i / SEGMENTS), height)) for i in range(SEGMENTS)])
names = list(MATS)
for level in range(len(PROFILE) - 1):
    index = names.index(PROFILE[level][2])
    for i in range(SEGMENTS):
        face = bm.faces.new((rings[level][i], rings[level][(i + 1) % SEGMENTS], rings[level + 1][(i + 1) % SEGMENTS], rings[level + 1][i]))
        face.material_index = index
        face.smooth = True
bottom = bm.faces.new(list(reversed(rings[0]))); bottom.material_index = names.index("Farbe")
top = bm.faces.new(rings[-1]); top.material_index = names.index("Farbe")
bm.normal_update()
bm.to_mesh(mesh)
bm.free()
for name in names: mesh.materials.append(MATS[name])
pen = bpy.data.objects.new("Stift", mesh)
bpy.context.scene.collection.objects.link(pen)
# Kanten zwischen den Abschnitten bleiben sichtbar, die Rundung ist glatt
try:
    mesh.set_sharp_from_angle(angle=math.radians(40))
except Exception:
    pass
bpy.ops.object.select_all(action="DESELECT")
pen.select_set(True)
bpy.context.view_layer.objects.active = pen
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_yup=True, export_apply=True, export_animations=False)
print("INFO Stift", len(mesh.vertices), "Punkte,", len(mesh.polygons), "Flächen ->", OUT)
