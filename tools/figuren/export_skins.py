# Skins aus Kim_Skins_v1.blend als eigenes GLB (nur die Skin-Teile, am selben Skelett) und die Krempen-Ebene des Huts
import bpy, sys, json
from mathutils import Vector
src, out = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.open_mainfile(filepath=src)
arm = bpy.data.objects['Armature']
parts = [o for c in bpy.data.collections if c.name.startswith('Skin_') for o in c.objects if o.type == 'MESH']
for c in bpy.data.collections: c.hide_viewport = False; c.hide_render = False
for o in bpy.data.objects: o.hide_set(False); o.hide_viewport = False; o.hide_render = False
bpy.context.view_layer.update()
# Krempen-Ebene: Grenze der Gruppe Hut_weg in den Frisuren (Welt, Ruhepose)
lows, highs = [], []
for o in bpy.data.objects:
    g = o.vertex_groups.get('Hut_weg') if o.type == 'MESH' else None
    if not g: continue
    mw = o.matrix_world
    for v in o.data.vertices:
        w = 0.0
        for e in v.groups:
            if e.group == g.index: w = e.weight
        p = mw @ v.co
        (highs if w > 0.5 else lows).append(p)
import numpy as np
H = np.array([list(p) for p in highs]); L = np.array([list(p) for p in lows])
print('INFO hut_weg', len(H), 'z min', H[:,2].min().round(4), 'nicht', len(L), 'z max', L[:,2].max().round(4))
# Ebene durch die untersten Punkte der Gruppe: z = a*x + b*y + c (Hut kann geneigt sitzen)
band = H[H[:,2] < np.percentile(H[:,2], 6)]
A = np.c_[band[:,0], band[:,1], np.ones(len(band))]
coef, *_ = np.linalg.lstsq(A, band[:,2], rcond=None)
res = band[:,2] - A @ coef
print('INFO plane z = %.4f*x + %.4f*y + %.4f, Streuung %.4f' % (coef[0], coef[1], coef[2], res.std()))
above = (L[:,2] > L[:,0]*coef[0] + L[:,1]*coef[1] + coef[2] + 0.002).mean(); below = (H[:,2] < H[:,0]*coef[0] + H[:,1]*coef[1] + coef[2] - 0.002).mean()
print('INFO falsch zugeordnet: nicht-Gruppe über der Ebene %.4f, Gruppe unter der Ebene %.4f' % (above, below))
head = arm.matrix_world @ arm.data.bones['Head'].head_local
print('INFO head', [round(v,4) for v in head], 'Welt-Maße Hut', [ [round(v,3) for v in (bpy.data.objects['Zimmerer_Hut'].matrix_world @ Vector(c))] for c in (bpy.data.objects['Zimmerer_Hut'].bound_box[0], bpy.data.objects['Zimmerer_Hut'].bound_box[6]) ])
# Export: nur Skelett und Skin-Teile
bpy.ops.object.select_all(action='DESELECT')
for o in parts + [arm]: o.select_set(True)
bpy.context.view_layer.objects.active = arm
if arm.animation_data: arm.animation_data.action = None
arm.data.pose_position = 'REST'
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_animations=False, export_skins=True, export_apply=False, export_yup=True, export_materials='EXPORT', export_normals=True, export_tangents=False)
print('INFO parts', [o.name for o in parts])
