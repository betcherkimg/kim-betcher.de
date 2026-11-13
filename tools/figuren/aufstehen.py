# Aufstehen: Mixamo "Getting Up" (Bauchlage, auf Olafs Skelett) auf Kim übertragen und als Kim_GetUp zu den übrigen Bewegungen legen.
# Kim liegt nach Kim_FallBackward auf dem Rücken, Kopf nach hinten. Die Quelle beginnt auf dem Bauch, Kopf nach vorn:
# Sie wird deshalb um 180 Grad gedreht eingesetzt (Kopf zeigt wie beim Liegen nach hinten) und dreht sich beim Hochkommen nach vorn.
# Aufruf: python -I getup.py <kim_retarget.blend> <Ausgabe.blend> <Getting Up.fbx>
import bpy, math, sys
from mathutils import Quaternion, Vector, Matrix
SRC, OUT, FBX = sys.argv[-3], sys.argv[-2], sys.argv[-1]
F_START, F_END, STEP = 40, 312, 3          # Quelle: 60 Bilder je Sekunde
TURN_FROM, TURN_TO = 205, 300              # in diesen Bildern dreht er sich nach vorn
FPS_OUT = 24
SPEED = 2.0                                 # schneller als die Quelle
DIRCHILD={'Hips':'Spine02','Spine02':'Spine01','Spine01':'Spine','Spine':'neck','neck':'Head','Head':'head_end',
 'LeftShoulder':'LeftArm','LeftArm':'LeftForeArm','LeftForeArm':'LeftHand','RightShoulder':'RightArm','RightArm':'RightForeArm','RightForeArm':'RightHand',
 'LeftUpLeg':'LeftLeg','LeftLeg':'LeftFoot','LeftFoot':'LeftToeBase','RightUpLeg':'RightLeg','RightLeg':'RightFoot','RightFoot':'RightToeBase'}
INHERIT={'LeftHand':'LeftForeArm','RightHand':'RightForeArm','LeftToeBase':'LeftFoot','RightToeBase':'RightFoot'}
# Abstand der Gelenke vom Boden, wenn der Körperteil aufliegt
RADIUS={'Hips':0.10,'Spine02':0.10,'Spine01':0.11,'Spine':0.11,'neck':0.10,'Head':0.13,'head_end':0.02,'headfront':0.03,
 'LeftArm':0.05,'RightArm':0.05,'LeftForeArm':0.04,'RightForeArm':0.04,'LeftHand':0.03,'RightHand':0.03,
 'LeftUpLeg':0.08,'RightUpLeg':0.08,'LeftLeg':0.05,'RightLeg':0.05}
bpy.ops.wm.open_mainfile(filepath=SRC)
kim=bpy.data.objects['Armature']
old=bpy.data.actions.get('Kim_GetUp')
if old: bpy.data.actions.remove(old)
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
FPS_BLEND=scene.render.fps; FPS_BASE=scene.render.fps_base
kim.animation_data.action=None
for pb in kim.pose.bones: pb.location=(0,0,0); pb.rotation_quaternion=(1,0,0,0)
bpy.context.view_layer.update()
KM=kim.matrix_world.copy(); UNIT=1/KM.to_scale().z; TO_ARM=KM.to_3x3().inverted()
print('INFO Kim Welt', [round(v,3) for v in KM.to_euler()], 'Einheit', UNIT)
for n in list(RADIUS): RADIUS[n]*=UNIT
FLOOR=min(KB[n].head_local.z for n in ('LeftToeBase','RightToeBase'))
for n in ('LeftFoot','RightFoot','LeftToeBase','RightToeBase'): RADIUS[n]=KB[n].head_local.z-FLOOR
HIPS_H=KB['Hips'].head_local.z-FLOOR
def restdir(bones,b):
    c=DIRCHILD.get(b)
    return (bones[c].head_local-bones[b].head_local).normalized() if c else None
before=set(bpy.data.objects); acts=set(bpy.data.actions)
bpy.ops.import_scene.fbx(filepath=FBX)
new=[o for o in bpy.data.objects if o not in before]
ar=[o for o in new if o.type=='ARMATURE'][0]
act=[a for a in bpy.data.actions if a not in acts and 'mixamo' in a.name][0]
ar.animation_data.action=act
try: ar.animation_data.action_slot=act.slots[0]
except Exception: pass
for t in list(ar.animation_data.nla_tracks): ar.animation_data.nla_tracks.remove(t)
AB=ar.data.bones
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
for pb in ar.pose.bones: pb.rotation_mode='QUATERNION'
def hips_src(): return MW @ ar.pose.bones['Hips'].head
scene.frame_set(F_END); end=hips_src().copy()
ratio=HIPS_H/(end.z*UNIT)
smooth=lambda t: t*t*(3-2*t)
frames=list(range(F_START,F_END+1,STEP))
out=bpy.data.actions.new('Kim_GetUp'); out.use_fake_user=True
kim.animation_data.action=out
prev={}; rows=[]
hips=kim.pose.bones['Hips']
for k,f in enumerate(frames):
    scene.frame_set(f)
    turn=math.pi*(1-smooth(min(1,max(0,(f-TURN_FROM)/(TURN_TO-TURN_FROM)))))
    R=Quaternion((0,0,1), turn)
    Q={}
    for b in order:
        if b in ('head_end','headfront') or b not in AB: continue
        qa=MR @ ar.pose.bones[b].matrix.to_quaternion()
        Q[b]=(qa @ RA[b].inverted()) @ C[b] @ RK[b]
    for b in Q: Q[b]=R @ Q[b]   # alle Knochen in Weltachsen drehen; die Lage untereinander bleibt
    d=(hips_src()-end)*ratio; d.z=0
    d=TO_ARM @ (R @ d)   # in Armature-Einheiten
    d=Vector((d.x, d.y, 0))
    for b in order:
        if b not in Q: continue
        pb=kim.pose.bones[b]; par=KB[b].parent
        basis=RK[b].inverted() @ Q[b] if par is None else RK[b].inverted() @ RK[par.name] @ Q[par.name].inverted() @ Q[b]
        basis.normalize()
        if b in prev and prev[b].dot(basis)<0: basis.negate()
        prev[b]=basis.copy()
        pb.rotation_quaternion=basis
        pb.keyframe_insert('rotation_quaternion', frame=k, group=b)
    # Höhe: Der tiefste Körperteil liegt auf dem Boden
    hips.location=RK['Hips'].inverted() @ d
    bpy.context.view_layer.update()
    lifts=sorted(((RADIUS[n]-(kim.pose.bones[n].head.z-FLOOR), n) for n in RADIUS if n in kim.pose.bones), reverse=True)
    lift=lifts[0][0]
    if k%9==0: print('INFO Bild', f, 'liegt auf', [(n, round(v/UNIT,2)) for v,n in lifts[:4]], 'Hüfte über Boden', round((HIPS_H+lift)/UNIT,2))
    rows.append((k, d.copy(), lift))
# Höhe glätten, damit wechselnde Auflagepunkte nicht ruckeln
for i,(k,d,lift) in enumerate(rows):
    near=[rows[j][2] for j in range(max(0,i-2), min(len(rows),i+3))]
    z=sum(near)/len(near)
    hips.location=RK['Hips'].inverted() @ Vector((d.x, d.y, z))
    hips.keyframe_insert('location', frame=k, group='Hips')
# Tempo: Bildnummern so stauchen, dass die Bewegung SPEED-mal so schnell läuft
scale=(STEP/60*FPS_OUT)/SPEED
for fc in out.fcurves if hasattr(out,'fcurves') else []:
    for kp in fc.keyframe_points: kp.co.x*=scale; kp.handle_left.x*=scale; kp.handle_right.x*=scale
try:
    for layer in out.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for fc in bag.fcurves:
                    for kp in fc.keyframe_points: kp.co.x*=scale; kp.handle_left.x*=scale; kp.handle_right.x*=scale
                    fc.update()
except Exception as e: print('INFO layers', e)
print('INFO Kim_GetUp', 'Bilder', len(frames), 'Dauer s', round(out.frame_range[1]/FPS_OUT,2), 'ratio', round(ratio,3), 'Start hinter den Füßen (m)', [round(v/UNIT,3) for v in rows[0][1]], 'Hub Start/Ende (m)', round(rows[0][2]/UNIT,3), round(rows[-1][2]/UNIT,3), 'Hüfthöhe (m)', round(HIPS_H/UNIT,3))
for o in new: bpy.data.objects.remove(o)
for a in list(bpy.data.actions):
    if not a.name.startswith('Kim_'): bpy.data.actions.remove(a)
kim.animation_data.action=bpy.data.actions['Kim_Dance']
try: kim.animation_data.action_slot=bpy.data.actions['Kim_Dance'].slots[0]
except Exception: pass
scene.render.fps=FPS_BLEND; scene.render.fps_base=FPS_BASE   # der FBX-Import stellt die Szene auf 60 Bilder je Sekunde
scene.frame_set(0)
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print('INFO DONE', sorted((a.name, round(a.frame_range[1])) for a in bpy.data.actions))
