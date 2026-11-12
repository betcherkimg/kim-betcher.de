import bpy, json
import os
# Ordner: FIGUREN_QUELLE = Blender-Dateien (Kim_/Maksim_Kleidung_v1.blend, Arian_Animated.blend), FIGUREN_ARBEIT = Zwischenstände
QUELLE=os.environ.get("FIGUREN_QUELLE", "Fahrlehrer")
WORK=os.environ.get("FIGUREN_ARBEIT", os.getcwd())
import sys
WHO=sys.argv[-1]
SRC=f"{WORK}/{WHO.lower()}_retarget.blend"
ANIM=f"{QUELLE}/Arian_Animated.blend"
OUT=f"{WORK}/{WHO.lower()}_raw.glb"
WANT=["Idle","Walk","Run","Wave","Talk","Jump"]
bpy.ops.wm.open_mainfile(filepath=SRC)
arm=bpy.data.objects['Armature']
kim_hips=arm.data.bones['Hips'].head_local.z

idle=bpy.data.actions[f'{WHO}_Idle']
if not arm.animation_data: arm.animation_data_create()
arm.animation_data.action=idle
arm.animation_data.action_slot=idle.slots[0]

# Hauttextur säubern: Bartkanten weich statt fleckig, Haut-Maske ohne Einzelpunkte
import numpy as np
def pixels(img):
    w,h=img.size; buf=np.empty(w*h*4,np.float32); img.pixels.foreach_get(buf); return buf.reshape(h,w,4)
def boxsum(m,r):
    c=np.pad(m,r,mode='edge').cumsum(0).cumsum(1); c=np.pad(c,((1,0),(1,0))); k=2*r+1
    return c[k:,k:]-c[:-k,k:]-c[k:,:-k]+c[:-k,:-k]
def half(x):
    h,w,c=x.shape; return x.reshape(h//2,2,w//2,2,c).mean((1,3))
skin_img=[n for n in bpy.data.materials['Haut'].node_tree.nodes if n.type=='TEX_IMAGE'][0].image
base_img=[n for n in bpy.data.materials['Material_0'].node_tree.nodes if n.type=='TEX_IMAGE'][0].image
H=pixels(skin_img); O=pixels(base_img)[...,:3]
f=H.shape[0]//O.shape[0]
O=np.repeat(np.repeat(O,f,0),f,1) if f>1 else O
a=(H[...,3]>0.5).astype(np.float32)
a=(boxsum(a,2)>=13).astype(np.float32)
L=0.2126*O[...,0]+0.7152*O[...,1]+0.0722*O[...,2]
sk=(a>0)&(L>0.6)
medO=np.median(O[sk],axis=0); medW=np.median(H[...,:3][sk],axis=0)
chroma=lambda x: x/np.maximum(x.sum(-1,keepdims=True),1e-4)
dist=np.abs(chroma(O)-chroma(medO[None,None,:])).sum(-1)
extra=(boxsum(a,12*f//2)>0)&(a==0)&(dist<0.06)&(L>0.5)
W=np.where(extra[...,None], np.clip(O/medO*medW,0,1), H[...,:3])
a=np.where(extra,1.0,a)
# Schmaler Rand um die Haut (nicht dunkel) wird Haut, damit beim Filtern keine hellen Kanten entstehen
r=2*f
cnt=boxsum(a,r)
band=(cnt>0)&(a==0)&(L>0.42)
Wn=np.stack([boxsum(W[...,i]*a,r) for i in range(3)],-1)/np.maximum(cnt,1)[...,None]
W=np.where(band[...,None], Wn, W)
a=np.where(band,1.0,a)
b=np.clip((0.66-L)/(0.28),0,1)*a
b=np.where(band,0.0,b)
rgb=np.where(a[...,None]>0, W*(1-b[...,None])+O*b[...,None], O)
# Alpha nie ganz 0: WebP verwirft sonst die Farben unter transparenten Pixeln (daher der fleckige Bart)
out=np.concatenate([rgb,np.maximum(a*(1-b),3/255)[...,None]],-1)
while out.shape[0]>2048: out=half(out)
def replace_image(mat_name, data, name):
    img=bpy.data.images.new(name, data.shape[1], data.shape[0], alpha=True)
    img.alpha_mode='CHANNEL_PACKED'
    img.pixels.foreach_set(np.clip(data,0,1).astype(np.float32).ravel())
    img.update(); img.pack()
    for n in bpy.data.materials[mat_name].node_tree.nodes:
        if n.type=='TEX_IMAGE': n.image=img
    return img
replace_image('Haut', out, 'Haut_Sauber')
cloth_img=[n for n in bpy.data.materials['Oberteil'].node_tree.nodes if n.type=='TEX_IMAGE'][0].image
C=pixels(cloth_img)
while C.shape[0]>2048: C=half(C)
C[...,3]=np.maximum(C[...,3],3/255)
cloth_new=bpy.data.images.new('Kleidung_2048', C.shape[1], C.shape[0], alpha=True)
cloth_new.alpha_mode='CHANNEL_PACKED'
cloth_new.pixels.foreach_set(np.clip(C,0,1).astype(np.float32).ravel()); cloth_new.update(); cloth_new.pack()
for m in ('Oberteil','Hose','Schuhe'):
    for n in bpy.data.materials[m].node_tree.nodes:
        if n.type=='TEX_IMAGE' and n.image==cloth_img: n.image=cloth_new

# Farbmaterialien: Textur direkt als Grundfarbe, Alpha bleibt als Maske in der Datei
orig={}
for m in ('Haut','Oberteil','Hose','Schuhe'):
    mat=bpy.data.materials[m]; nt=mat.node_tree
    tex=[n for n in nt.nodes if n.type=='TEX_IMAGE'][0]
    rgb=[n for n in nt.nodes if n.type=='RGB'][0]
    bsdf=[n for n in nt.nodes if n.type=='BSDF_PRINCIPLED'][0]
    orig[m]=list(rgb.outputs[0].default_value)[:3]
    for n in [n for n in nt.nodes if n.type in ('RGB','MIX')]: nt.nodes.remove(n)
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    mat['farbe_linear']=orig[m]
# Haar: Graustufen-Attribut als Vertexfarbe, Farbe kommt im Browser dazu
mat=bpy.data.materials['Haar']; nt=mat.node_tree
bsdf=[n for n in nt.nodes if n.type=='BSDF_PRINCIPLED'][0]
for n in [n for n in nt.nodes if n.type in ('ATTRIBUTE','OBJECT_INFO','MIX')]: nt.nodes.remove(n)
ca=nt.nodes.new('ShaderNodeVertexColor'); ca.layer_name='Grau'
nt.links.new(ca.outputs['Color'], bsdf.inputs['Base Color'])
mat['farbe_linear']=list(bpy.data.objects[f'Frisur_{WHO}_Kurz'].color)[:3]

for o in list(bpy.data.objects):
    if o.type in ('CAMERA','LIGHT'): bpy.data.objects.remove(o)
for o in bpy.data.objects:
    o.hide_set(False); o.hide_render=False; o.hide_viewport=False
for c in bpy.data.collections: c.hide_render=False; c.hide_viewport=False
bpy.context.view_layer.update()
meta={'haut':orig['Haut'],'oberteil':orig['Oberteil'],'hose':orig['Hose'],'schuhe':orig['Schuhe'],'haar':list(mat['farbe_linear']),
      'hautfarben':json.loads(bpy.data.texts['Hautfarben.json'].as_string()),'kleidungsfarben':json.loads(bpy.data.texts['Kleidungsfarben.json'].as_string()),
      'frisuren':sorted(o.name for o in bpy.data.objects if o.name.startswith('Frisur_'))}
json.dump(meta, open(OUT.replace('.glb','.json'),'w'), ensure_ascii=False, indent=1)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_animations=True, export_animation_mode='ACTIONS',
    export_extras=True, export_yup=True, export_apply=False, export_skins=True, export_def_bones=False,
    export_force_sampling=True, export_optimize_animation_size=True, use_visible=False, export_vertex_color='MATERIAL',
    export_image_format='AUTO', export_cameras=False, export_lights=False)
print('DONE')
