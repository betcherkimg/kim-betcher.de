import bpy, math, sys
import os
# Ordner: FIGUREN_QUELLE = Blender-Dateien (Kim_/Maksim_Kleidung_v1.blend, Arian_Animated.blend), FIGUREN_ARBEIT = Zwischenstände
QUELLE=os.environ.get("FIGUREN_QUELLE", "Fahrlehrer")
WORK=os.environ.get("FIGUREN_ARBEIT", os.getcwd())
from mathutils import Quaternion, Vector, Matrix
# Aufruf: python -I retarget5.py <Kim|Maksim> [armdeg legdeg footdeg fbend]
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:]
WHO=args[0]
ARM_ALPHA=float(args[1]) if len(args)>1 else 9.0      # Abstand Oberarm zur Senkrechten (Grad)
LEG_IN=float(args[2]) if len(args)>2 else 6.0         # Beine so weit nach innen drehen (Grad)
FOOT_IN=float(args[3]) if len(args)>3 else 12.0       # Fußspitzen so weit nach innen drehen (Grad)
FORE_BEND=float(args[4]) if len(args)>4 else 14.0     # Ellbogen leicht gebeugt (Grad)
SRC=f"{QUELLE}/{WHO}_Kleidung_v1.blend"
ANIM=f"{QUELLE}/Arian_Animated.blend"
OUT=f"{WORK}/{WHO.lower()}_retarget.blend"
WANT=["Walk","Run","Wave","Talk","Jump"]
DIRCHILD={'Hips':'Spine02','Spine02':'Spine01','Spine01':'Spine','Spine':'neck','neck':'Head','Head':'head_end',
 'LeftShoulder':'LeftArm','LeftArm':'LeftForeArm','LeftForeArm':'LeftHand','RightShoulder':'RightArm','RightArm':'RightForeArm','RightForeArm':'RightHand',
 'LeftUpLeg':'LeftLeg','LeftLeg':'LeftFoot','LeftFoot':'LeftToeBase','RightUpLeg':'RightLeg','RightLeg':'RightFoot','RightFoot':'RightToeBase'}
INHERIT={'LeftHand':'LeftForeArm','RightHand':'RightForeArm','LeftToeBase':'LeftFoot','RightToeBase':'RightFoot'}
bpy.ops.wm.open_mainfile(filepath=SRC)
kim=bpy.data.objects['Armature']
with bpy.data.libraries.load(ANIM, link=False) as (src, dst):
    dst.objects=['Armature']
    dst.actions=[f"Arian_{n}" for n in WANT]
ar=dst.objects[0]; bpy.context.scene.collection.objects.link(ar); ar.name='ArianRig'
if ar.animation_data:
    for t in list(ar.animation_data.nla_tracks): ar.animation_data.nla_tracks.remove(t)
else: ar.animation_data_create()
if kim.animation_data:
    for t in list(kim.animation_data.nla_tracks): kim.animation_data.nla_tracks.remove(t)
    kim.animation_data.action=None
else: kim.animation_data_create()
for a in [a for a in bpy.data.actions if a.name.startswith('Armature|')]: bpy.data.actions.remove(a)

KB=kim.data.bones; AB=ar.data.bones
RK={b.name: b.matrix_local.to_quaternion() for b in KB}
RA={b.name: b.matrix_local.to_quaternion() for b in AB}
def restdir(bones,b):
    c=DIRCHILD.get(b)
    return (bones[c].head_local-bones[b].head_local).normalized() if c else None
C={}
for b in RK:
    dk=restdir(KB,b); da=restdir(AB,b)
    C[b]=dk.rotation_difference(da) if dk is not None else Quaternion()
for b,src in INHERIT.items(): C[b]=C[src]
ratio=KB['Hips'].head_local.z/AB['Hips'].head_local.z
order=[]
def walk_bones(b):
    order.append(b.name)
    for c in b.children: walk_bones(c)
for b in KB:
    if b.parent is None: walk_bones(b)
desc={b.name: [c.name for c in b.children_recursive] for b in KB}
for pb in kim.pose.bones: pb.rotation_mode='QUATERNION'
for pb in ar.pose.bones: pb.rotation_mode='QUATERNION'
scene=bpy.context.scene
FPS=scene.render.fps

def smooth(a,b,x):
    t=max(0.0,min(1.0,(x-a)/(b-a))); return t*t*(3-2*t)

def key_pose(Q, f, hips_loc=None, prev=None):
    """Weltrotationen Q[b] (Armaturraum) als lokale Schlüssel setzen."""
    for b in order:
        if b not in Q: continue
        pb=kim.pose.bones[b]; par=KB[b].parent
        if par is None:
            basis=RK[b].inverted() @ Q[b]
            loc=hips_loc if hips_loc is not None else Vector((0,0,0))
            pb.location=loc; pb.keyframe_insert('location', frame=f, group=b)
        else:
            p=par.name
            basis=RK[b].inverted() @ RK[p] @ Q[p].inverted() @ Q[b]
        basis.normalize()
        if prev is not None:
            if b in prev and prev[b].dot(basis)<0: basis.negate()
            prev[b]=basis.copy()
        pb.rotation_quaternion=basis
        pb.keyframe_insert('rotation_quaternion', frame=f, group=b)

def relax_arms(Q, amount):
    """Hängende Oberarme näher an den Körper holen (nur wenn sie nach unten zeigen)."""
    for side in ('Left','Right'):
        b=side+'Arm'; dk=restdir(KB,b)
        d=(Q[b] @ RK[b].inverted()) @ dk
        w=smooth(0.35,0.8,-d.z)
        if w<=0: continue
        r=math.hypot(d.x,d.z); alpha=math.atan2(abs(d.x),-d.z)
        target_alpha=max(math.radians(ARM_ALPHA), alpha-math.radians(amount)*w)
        if target_alpha>=alpha: continue
        sx=1 if d.x>=0 else -1
        d2=Vector((sx*math.sin(target_alpha)*r, d.y, -math.cos(target_alpha)*r)).normalized()
        R=d.rotation_difference(d2)
        for c in [b]+desc[b]:
            if c in Q: Q[c]=R @ Q[c]

# 1) Bewegungen von Arian übertragen, Arme entspannter
for n in WANT:
    a=bpy.data.actions[f"Arian_{n}"]
    ar.animation_data.action=a; ar.animation_data.action_slot=a.slots[0]
    f0,f1=int(a.frame_range[0]), int(a.frame_range[1])
    new=bpy.data.actions.new(f"{WHO}_{n}"); new.use_fake_user=True
    kim.animation_data.action=new
    prev={}
    for f in range(f0,f1+1):
        scene.frame_set(f)
        Q={}
        for b in order:
            if b in ('head_end','headfront'): continue
            qa=ar.pose.bones[b].matrix.to_quaternion()
            Q[b]=(qa @ RA[b].inverted()) @ C[b] @ RK[b]
        relax_arms(Q, 18.0)
        ha=ar.pose.bones['Hips'].matrix.translation
        desired=KB['Hips'].head_local + (ha - AB['Hips'].head_local)*ratio
        loc=RK['Hips'].inverted() @ (desired - KB['Hips'].head_local)
        key_pose(Q, f, hips_loc=loc, prev=prev)
    print('retargeted', new.name, f0, f1)

# 2) Eigene Ruhepose: aufrecht, Arme hängen locker, Füße hüftbreit, leichtes Atmen
def rot(axis, deg): return Quaternion(Vector(axis), math.radians(deg))
LOOP=5*FPS
new=bpy.data.actions.new(f"{WHO}_Idle"); new.use_fake_user=True
kim.animation_data.action=new
prev={}
dir_rest={b: restdir(KB,b) for b in ('LeftArm','RightArm','LeftForeArm','RightForeArm')}
for f in range(0, LOOP+1):
    t=f/LOOP; s=lambda k=1, ph=0.0: math.sin(2*math.pi*(k*t)+ph)
    R={}
    # Wirbelsäule: Atmen (Brust hebt sich), minimales Wiegen
    R['Spine02']=rot((1,0,0), 0.5*s(1,0.0)) @ rot((0,1,0), 0.6*s(1,1.3))
    R['Spine01']=rot((1,0,0), -0.9*s(1,0.4))
    R['Spine']=rot((1,0,0), -0.6*s(1,0.6)) @ rot((0,1,0), -0.4*s(1,1.6))
    R['neck']=rot((1,0,0), 0.5*s(1,2.0))
    R['Head']=rot((0,0,1), 3.0*s(1,0.9)) @ rot((1,0,0), 1.2*s(2,0.3))
    # Absolute Weltdeltas entlang der Kette
    D={}
    for b in order:
        par=KB[b].parent
        Dp=D[par.name] if par else Quaternion()
        D[b]=Dp @ R.get(b, Quaternion())
    # Arme: Richtungen im Ruhe-Körperraum vorgeben
    for side, sx in (('Left',1),('Right',-1)):
        arm=side+'Arm'; fore=side+'ForeArm'; sh=side+'Shoulder'
        a=math.radians(ARM_ALPHA + 0.8*s(1,0.2 if sx>0 else 0.5))
        fwd=math.radians(3.0 + 1.0*s(1,0.7 if sx>0 else 1.1))
        t_arm=Vector((sx*math.sin(a), -math.sin(fwd), -math.cos(a))).normalized()
        R_arm=dir_rest[arm].rotation_difference(t_arm)
        bend=math.radians(FORE_BEND + 1.5*s(1,1.2 if sx>0 else 1.6))
        ai=math.radians(ARM_ALPHA-3.0)
        t_fore=Vector((sx*math.sin(ai)*math.cos(bend), -math.sin(bend), -math.cos(ai)*math.cos(bend))).normalized()
        R_bend=(R_arm @ dir_rest[fore]).rotation_difference(t_fore)
        D[arm]=D[sh] @ R_arm
        D[fore]=D[sh] @ R_bend @ R_arm
        D[side+'Hand']=D[fore] @ rot((0,1,0), -sx*3.0)
    # Beine: etwas schmaler, Füße flach und weniger ausgedreht
    for side, sx in (('Left',1),('Right',-1)):
        up=side+'UpLeg'
        R_leg=rot((0,1,0), sx*LEG_IN)
        D[up]=D['Hips'] @ R_leg
        D[side+'Leg']=D[up]
        D[side+'Foot']=D['Hips'] @ rot((0,0,1), -sx*FOOT_IN)
        D[side+'ToeBase']=D[side+'Foot']
    Q={b: D[b] @ RK[b] for b in order if b not in ('head_end','headfront')}
    # Füße bleiben am Boden: Hüfte um den Höhenverlust der schmaleren Beine absenken
    leg_len=(KB['LeftFoot'].head_local-KB['LeftUpLeg'].head_local).length
    drop=leg_len*(1-math.cos(math.radians(LEG_IN)))
    hips_loc=RK['Hips'].inverted() @ Vector((0,0,-drop))
    key_pose(Q, f, hips_loc=hips_loc, prev=prev)
print('built', new.name, 0, LOOP)

kim.animation_data.action=bpy.data.actions[f'{WHO}_Idle']
bpy.data.objects.remove(ar)
for n in WANT: bpy.data.actions.remove(bpy.data.actions[f"Arian_{n}"])
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print('SAVED')
