import bpy, sys, os, json
from mathutils import Vector
src, out, tex = sys.argv[-3], sys.argv[-2], sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
if src.lower().endswith('.fbx'): bpy.ops.import_scene.fbx(filepath=src)
else: bpy.ops.import_scene.gltf(filepath=src)
for o in [o for o in bpy.data.objects if o.type=='MESH' and any(m and m.name.startswith('STUDIO') for m in o.data.materials)]: bpy.data.objects.remove(o)
meshes=[o for o in bpy.data.objects if o.type=='MESH']
if tex!='-':
    img=bpy.data.images.load(tex)
    for m in bpy.data.materials:
        m.use_nodes=True; nt=m.node_tree
        b=[n for n in nt.nodes if n.type=='BSDF_PRINCIPLED']
        if not b: continue
        if not b[0].inputs['Base Color'].links:
            t=nt.nodes.new('ShaderNodeTexImage'); t.image=img; nt.links.new(t.outputs['Color'], b[0].inputs['Base Color'])
bpy.context.view_layer.update()
mn=Vector((1e9,)*3); mx=Vector((-1e9,)*3)
for o in meshes:
    for c in o.bound_box:
        w=o.matrix_world@Vector(c)
        for i in range(3): mn[i]=min(mn[i],w[i]); mx[i]=max(mx[i],w[i])
info={'size':[round(mx[i]-mn[i],2) for i in range(3)],'min':[round(v,2) for v in mn],'tris':sum(len(o.data.polygons) for o in meshes),'meshes':len(meshes),
 'actions':[(a.name, round(a.frame_range[1]-a.frame_range[0])) for a in bpy.data.actions],'mats':[(m.name, bool(m.node_tree and [n for n in m.node_tree.nodes if n.type=='TEX_IMAGE'])) for m in bpy.data.materials],
 'arm':[o.name for o in bpy.data.objects if o.type=='ARMATURE']}
print('INFO', os.path.basename(src), json.dumps(info))
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_animations=True, export_animation_mode='ACTIONS', export_yup=True, export_apply=False, export_skins=True, export_force_sampling=True, export_optimize_animation_size=True, use_visible=False, export_cameras=False, export_lights=False)
