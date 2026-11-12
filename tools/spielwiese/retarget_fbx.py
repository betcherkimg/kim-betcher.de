# Bewegungen aus FBX-Dateien (gleiches 24-Knochen-Skelett, z. B. Olaf mit Mixamo-Bewegung) auf Kim übertragen.
# Aufruf: python -I retarget_fbx.py <Kim-Blend> <Ausgabe.blend> Name=Datei.fbx[:Schritt] ...
import bpy, math, sys
from mathutils import Quaternion, Vector
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:]
SRC, OUT, jobs = args[0], args[1], args[2:]
WHO="Kim"
DIRCHILD={'Hips':'Spine02','Spine02':'Spine01','Spine01':'Spine','Spine':'neck','neck':'Head','Head':'head_end',
 'LeftShoulder':'LeftArm','LeftArm':'LeftForeArm','LeftForeArm':'LeftHand','RightShoulder':'RightArm','RightArm':'RightForeArm','RightForeArm':'RightHand',
 'LeftUpLeg':'LeftLeg','LeftLeg':'LeftFoot','LeftFoot':'LeftToeBase','RightUpLeg':'RightLeg','RightLeg':'RightFoot','RightFoot':'RightToeBase'}
INHERIT={'LeftHand':'LeftForeArm','RightHand':'RightForeArm','LeftToeBase':'LeftFoot','RightToeBase':'RightFoot'}
bpy.ops.wm.open_mainfile(filepath=SRC)
kim=bpy.data.objects['Armature']
if kim.animation_data:
    for t in list(kim.animation_data.nla_tracks): kim.animation_data.nla_tracks.remove(t)
    kim.animation_data.action=None
else: kim.animation_data_create()
for a in list(bpy.data.actions): bpy.data.actions.remove(a)
KB=kim.data.bones
RK={b.name: b.matrix_local.to_quaternion() for b in KB}
order=[]
def walk(b):
    order.append(b.name)
    for c in b.children: walk(c)
for b in KB:
    if b.parent is None: walk(b)
for pb in kim.pose.bones: pb.rotation_mode='QUATERNION'
scene=bpy.context.scene
def restdir(bones,b):
    c=DIRCHILD.get(b)
    return (bones[c].head_local-bones[b].head_local).normalized() if c else None
def key_pose(Q, f, hips_loc, prev):
    for b in order:
        if b not in Q: continue
        pb=kim.pose.bones[b]; par=KB[b].parent
        if par is None:
            basis=RK[b].inverted() @ Q[b]
            pb.location=hips_loc; pb.keyframe_insert('location', frame=f, group=b)
        else:
            p=par.name
            basis=RK[p].inverted() @ RK[b]
            basis=RK[b].inverted() @ RK[p] @ Q[p].inverted() @ Q[b]
        basis.normalize()
        if b in prev and prev[b].dot(basis)<0: basis.negate()
        prev[b]=basis.copy()
        pb.rotation_quaternion=basis
        pb.keyframe_insert('rotation_quaternion', frame=f, group=b)
FEET=('LeftToeBase','RightToeBase','LeftFoot','RightFoot')
bpy.context.view_layer.update()
FLOOR=min(KB[n].head_local.z for n in ('LeftToeBase','RightToeBase'))
for job in jobs:
    name, rest = job.split('=',1)
    path, step = (rest.rsplit(':',1)+['1'])[:2] if rest.count(':') and rest.rsplit(':',1)[1].isdigit() else (rest,'1')
    step=int(step)
    before=set(bpy.data.objects); acts=set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=path)
    new=[o for o in bpy.data.objects if o not in before]
    ar=[o for o in new if o.type=='ARMATURE'][0]
    act=[a for a in bpy.data.actions if a not in acts and 'mixamo' in a.name][0]
    ar.animation_data.action=act
    try: ar.animation_data.action_slot=act.slots[0]
    except Exception: pass
    for t in list(ar.animation_data.nla_tracks): ar.animation_data.nla_tracks.remove(t)
    AB=ar.data.bones
    # Quelle in Weltachsen rechnen: das FBX-Skelett steht gedreht und in Zentimetern im Raum
    bpy.context.view_layer.update()
    MW=ar.matrix_world.copy(); MR=MW.to_quaternion()
    RA={b.name: MR @ b.matrix_local.to_quaternion() for b in AB}
    def srcdir(b):
        c=DIRCHILD.get(b)
        return (MW @ AB[c].head_local - MW @ AB[b].head_local).normalized() if c and c in AB and b in AB else None
    C={}
    for b in RK:
        dk=restdir(KB,b); da=srcdir(b)
        C[b]=dk.rotation_difference(da) if dk is not None and da is not None else Quaternion()
    for b,src in INHERIT.items(): C[b]=C[src]
    hips_rest=MW @ AB['Hips'].head_local
    ratio=KB['Hips'].head_local.z/hips_rest.z
    for pb in ar.pose.bones: pb.rotation_mode='QUATERNION'
    f0,f1=int(act.frame_range[0]), int(act.frame_range[1])
    out=bpy.data.actions.new(f"{WHO}_{name}"); out.use_fake_user=True
    kim.animation_data.action=out
    prev={}; k=0
    start=None
    for f in range(f0,f1+1,step):
        scene.frame_set(f)
        Q={}
        for b in order:
            if b in ('head_end','headfront') or b not in AB: continue
            qa=MR @ ar.pose.bones[b].matrix.to_quaternion()
            Q[b]=(qa @ RA[b].inverted()) @ C[b] @ RK[b]
        # Auf der Stelle, und die Hüfthöhe aus den Füßen bestimmen: der tiefere Fuß steht auf dem Boden.
        # (Die Verschiebung aus der FBX ist in anderen Einheiten als das Skelett und deshalb unbrauchbar.)
        key_pose(Q, k, Vector((0,0,0)), prev)
        bpy.context.view_layer.update()
        low=min(kim.pose.bones[n].head.z for n in FEET)
        pb=kim.pose.bones['Hips']
        pb.location=RK['Hips'].inverted() @ Vector((0,0,FLOOR-low))
        pb.keyframe_insert('location', frame=k, group='Hips')
        k+=1
    print('retargeted', out.name, 'frames', k, 'quelle', f0, f1, 'ratio', round(ratio,4))
    for o in new: bpy.data.objects.remove(o)
    bpy.data.actions.remove(act)
    for a in [a for a in bpy.data.actions if a.name.startswith('Armature|')]: bpy.data.actions.remove(a)
for a in [a for a in bpy.data.actions if not a.name.startswith(WHO+'_')]: bpy.data.actions.remove(a)
first=sorted(a.name for a in bpy.data.actions if a.name.startswith(WHO+'_'))[0]
kim.animation_data.action=bpy.data.actions[first]
for o in list(bpy.data.objects):
    if o is not kim: bpy.data.objects.remove(o)
bpy.ops.wm.save_as_mainfile(filepath=OUT)
bpy.ops.export_scene.gltf(filepath=OUT.replace('.blend','_raw.glb'), export_format='GLB', export_animations=True, export_animation_mode='ACTIONS',
    export_yup=True, export_apply=False, export_skins=True, export_def_bones=False, export_force_sampling=True, export_optimize_animation_size=True, use_visible=False)
print('DONE', sorted(a.name for a in bpy.data.actions))
