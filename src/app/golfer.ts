import * as THREE from 'three';
import type { ClubSpec } from '../physics/club.ts';
import type { Swing, SwingPose } from '../physics/swing.ts';
import { buildClubHead } from './clubhead.ts';
import motionData from './data/mocap-swing.json';

const COLOURS = { shirt: '#24375a', trousers: '#c8b386', skin: '#dcae88', cap: '#f5f3ec', shoe: '#f5f3ec', shaft: '#c9ccd1', head: '#2b2f34' };
const UP = new THREE.Vector3(0, 1, 0);

/** Finds the middle joint of a two-segment limb reaching from root to target, bending toward pole. */
function twoBoneJoint(root: THREE.Vector3, target: THREE.Vector3, upper: number, lower: number, pole: THREE.Vector3): THREE.Vector3 {
  const toTarget = target.clone().sub(root);
  const d = Math.min(toTarget.length(), (upper + lower) * 0.999);
  const dir = toTarget.normalize();
  const a = (upper * upper - lower * lower + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, upper * upper - a * a));
  const bend = pole.clone().sub(root);
  bend.addScaledVector(dir, -bend.dot(dir));
  if (bend.lengthSq() < 1e-9) bend.set(0, -1, 0);
  return root.clone().addScaledVector(dir, a).addScaledVector(bend.normalize(), h);
}

class Limb {
  readonly mesh: THREE.Mesh;
  constructor(radius: number, material: THREE.Material) {
    this.mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.85, 1, 10), material);
  }
  between(a: THREE.Vector3, b: THREE.Vector3): void {
    const dir = b.clone().sub(a);
    const length = dir.length();
    this.mesh.position.copy(a).addScaledVector(dir, 0.5);
    this.mesh.quaternion.setFromUnitVectors(UP, dir.divideScalar(length || 1));
    this.mesh.scale.set(1, length, 1);
  }
}

/** A right-handed golfer posed from the swing model: the hands and club come straight from the kinematics. */
export class Golfer {
  readonly group = new THREE.Group();
  private readonly materials = {
    shirt: new THREE.MeshLambertMaterial({ color: COLOURS.shirt }),
    trousers: new THREE.MeshLambertMaterial({ color: COLOURS.trousers }),
    skin: new THREE.MeshLambertMaterial({ color: COLOURS.skin }),
    cap: new THREE.MeshLambertMaterial({ color: COLOURS.cap }),
    shaft: new THREE.MeshStandardMaterial({ color: COLOURS.shaft, metalness: 0.8, roughness: 0.3 }),
    head: new THREE.MeshStandardMaterial({ color: COLOURS.head, metalness: 0.6, roughness: 0.35 }),
  };
  private readonly torso = new Limb(0.15, this.materials.shirt);
  private readonly limbs: Record<string, Limb>;
  private readonly joints: THREE.Mesh[] = [];
  private readonly head: THREE.Group;
  private readonly club = new Limb(0.0065, this.materials.shaft);
  private readonly grip = new Limb(0.012, new THREE.MeshLambertMaterial({ color: '#1b1b1b' }));
  private clubHead: THREE.Group = new THREE.Group();
  /** Distance from the hosel to the middle of the face, along the toe, m. */
  private faceCentre = 0.04;
  private readonly feet: THREE.Mesh[];
  private motion: Motion | null = MOTION;
  /** Putts keep the captured address posture: the shoulders rock, the body stays still. */
  private putting = false;
  private extra: { torsoTop: Limb; neck: Limb } | null = null;

  constructor() {
    const m = this.materials;
    this.limbs = {
      leadUpperArm: new Limb(0.045, m.shirt), leadForearm: new Limb(0.038, m.skin),
      trailUpperArm: new Limb(0.045, m.shirt), trailForearm: new Limb(0.038, m.skin),
      leadThigh: new Limb(0.075, m.trousers), leadShin: new Limb(0.055, m.trousers),
      trailThigh: new Limb(0.075, m.trousers), trailShin: new Limb(0.055, m.trousers),
      shoulders: new Limb(0.06, m.shirt), hips: new Limb(0.11, m.trousers),
    };
    for (const limb of [this.torso, ...Object.values(this.limbs), this.club, this.grip]) this.group.add(limb.mesh);
    for (let i = 0; i < 8; i++) {
      const joint = new THREE.Mesh(new THREE.SphereGeometry(i < 4 ? 0.05 : 0.07, 10, 8), i < 2 ? m.skin : i < 4 ? m.shirt : m.trousers);
      this.joints.push(joint);
      this.group.add(joint);
    }
    this.head = new THREE.Group();
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), m.skin);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.115, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), m.cap);
    const peak = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.012, 16, 1, false, 0, Math.PI), m.cap);
    cap.position.y = 0.015;
    peak.position.set(0, 0.03, 0.06);
    this.head.add(skull, cap, peak);
    this.group.add(this.head);
    this.feet = [0, 1].map(() => {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.28), new THREE.MeshLambertMaterial({ color: COLOURS.shoe }));
      this.group.add(foot);
      return foot;
    });
    this.group.add(this.clubHead);
    this.extra = { torsoTop: new Limb(0.13, m.shirt), neck: new Limb(0.045, m.skin) };
    this.group.add(this.extra.torsoTop.mesh, this.extra.neck.mesh);
  }

  setClub(spec: ClubSpec): void {
    this.group.remove(this.clubHead);
    this.clubHead.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.putting = spec.head === 'putter';
    // Less forgiving putters are blades; forgiving ones mallets.
    this.clubHead = buildClubHead(spec, (spec.forgiveness ?? 0.6) > 1 ? 'blade' : 'mallet');
    this.faceCentre = spec.head === 'driver' ? 0.067 : spec.head === 'wood' ? 0.055 : spec.head === 'putter' ? 0.06 : 0.04;
    this.group.add(this.clubHead);
  }

  /** Uses the motion-capture body (true) or the simple two-lever mannequin (false). */
  useMotionCapture(on: boolean): void {
    this.motion = on ? MOTION : null;
  }

  update(pose: SwingPose, t?: number, swing?: Swing): void {
    if (this.motion && t !== undefined && swing) {
      this.updateCaptured(pose, t, swing, this.motion);
      return;
    }
    this.extra!.torsoTop.mesh.visible = false;
    this.extra!.neck.mesh.visible = false;
    const v = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);
    const hub = v(pose.hub);
    const hands = v(pose.hands);
    const head = v(pose.head);
    const shaft = v(pose.shaft);

    // Horizontal unit vectors: toward the golfer from the ball, and toward the target.
    const golferSide = new THREE.Vector3(hub.x, 0, hub.z).normalize();
    const target = new THREE.Vector3(-golferSide.z, 0, golferSide.x);
    const reach = Math.hypot(hub.x, hub.z);
    const turn = Math.max(-2.2, Math.min(2.3, pose.turn));

    const footCentre = golferSide.clone().multiplyScalar(reach + 0.22);
    const leadFoot = footCentre.clone().addScaledVector(target, 0.27);
    const trailFoot = footCentre.clone().addScaledVector(target, -0.27);
    const pelvis = footCentre.clone().addScaledVector(golferSide, 0.1).setY(0.93);
    const hipAxis = target.clone().applyAxisAngle(UP, -0.4 * turn);
    const leadHip = pelvis.clone().addScaledVector(hipAxis, 0.12);
    const trailHip = pelvis.clone().addScaledVector(hipAxis, -0.12);

    const spine = hub.clone().sub(pelvis).normalize();
    const shoulderAxis = target.clone().applyAxisAngle(spine, -Math.max(-1.7, Math.min(1.6, 0.6 * turn)));
    const leadShoulder = hub.clone().addScaledVector(shoulderAxis, 0.19);
    const trailShoulder = hub.clone().addScaledVector(shoulderAxis, -0.19);

    this.torso.between(pelvis, hub);
    this.limbs.shoulders.between(leadShoulder, trailShoulder);
    this.limbs.hips.between(leadHip, trailHip);

    const leadHand = hands.clone().addScaledVector(shaft, -0.03);
    const trailHand = hands.clone().addScaledVector(shaft, 0.06);
    const elbowPole = (shoulder: THREE.Vector3) => shoulder.clone().add(new THREE.Vector3(0, -0.6, 0)).addScaledVector(golferSide, 0.5);
    const leadElbow = twoBoneJoint(leadShoulder, leadHand, 0.31, 0.3, elbowPole(leadShoulder));
    const trailElbow = twoBoneJoint(trailShoulder, trailHand, 0.31, 0.3, elbowPole(trailShoulder));
    this.limbs.leadUpperArm.between(leadShoulder, leadElbow);
    this.limbs.leadForearm.between(leadElbow, leadHand);
    this.limbs.trailUpperArm.between(trailShoulder, trailElbow);
    this.limbs.trailForearm.between(trailElbow, trailHand);

    const kneePole = (hip: THREE.Vector3) => hip.clone().addScaledVector(golferSide, -0.8).add(new THREE.Vector3(0, -0.3, 0));
    const leadAnkle = leadFoot.clone().setY(0.08);
    const trailAnkle = trailFoot.clone().setY(0.08);
    const leadKnee = twoBoneJoint(leadHip, leadAnkle, 0.45, 0.44, kneePole(leadHip));
    const trailKnee = twoBoneJoint(trailHip, trailAnkle, 0.45, 0.44, kneePole(trailHip));
    this.limbs.leadThigh.between(leadHip, leadKnee);
    this.limbs.leadShin.between(leadKnee, leadAnkle);
    this.limbs.trailThigh.between(trailHip, trailKnee);
    this.limbs.trailShin.between(trailKnee, trailAnkle);

    [leadHand, trailHand, leadElbow, trailElbow, leadKnee, trailKnee, leadShoulder, trailShoulder].forEach((p, i) =>
      this.joints[i].position.copy(p),
    );
    this.head.position.copy(hub).addScaledVector(spine, 0.27).addScaledVector(golferSide, -0.06);
    this.head.lookAt(new THREE.Vector3(0, 0, 0));
    for (const [foot, at] of [[this.feet[0], leadFoot], [this.feet[1], trailFoot]] as const) {
      foot.position.copy(at).setY(0.035);
      foot.lookAt(at.clone().addScaledVector(golferSide, -1).setY(0.035));
    }

    const butt = hands.clone().addScaledVector(shaft, -0.08);
    this.grip.between(butt, hands.clone().addScaledVector(shaft, 0.2));
    this.club.between(butt, head);

    // Club head: shaft runs up from it, the face points along the delivered face direction.
    const up = shaft.clone().negate();
    const face = v(pose.face);
    face.addScaledVector(up, -face.dot(up)).normalize();
    const toe = new THREE.Vector3().crossVectors(up, face).normalize();
    this.placeHead(head, up, toe, face);
  }

  private placeHead(head: THREE.Vector3, up: THREE.Vector3, toe: THREE.Vector3, face: THREE.Vector3): void {
    this.clubHead.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(toe, up, face.clone().negate()));
    // The swing model's head point is the middle of the face; the model's origin is the hosel.
    this.clubHead.position.copy(head).addScaledVector(toe, -this.faceCentre);
  }

  /**
   * The captured golfer: hips, legs, spine, shoulders and head from the recording, retimed so its top of backswing,
   * impact and finish line up with this swing's. The hands stay exactly where the swing physics puts them, and the
   * arms reach them from the captured shoulders (two-bone IK, elbows bending as captured).
   */
  private updateCaptured(pose: SwingPose, t: number, swing: Swing, motion: Motion): void {
    const v = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);
    const fit = motion.fitTo(swing);
    const frame = this.putting ? motion.addressFrame : motion.frameAt(t, swing);
    const J = (name: string) => motion.joint(frame, name, fit);
    const hands = v(pose.hands);
    const head = v(pose.head);
    const shaft = v(pose.shaft);

    const hips = J('Hips');
    const leadHip = J('LeftUpLeg');
    const trailHip = J('RightUpLeg');
    const chest = J('Spine1');
    const neck = J('Neck1');
    const skull = J('Head');
    const leadShoulder = J('LeftArm');
    const trailShoulder = J('RightArm');
    const hubPoint = leadShoulder.clone().add(trailShoulder).multiplyScalar(0.5);
    this.torso.between(hips, chest);
    this.extra!.torsoTop.mesh.visible = true;
    this.extra!.neck.mesh.visible = true;
    this.extra!.torsoTop.between(chest, hubPoint);
    this.extra!.neck.between(hubPoint, neck);
    this.limbs.shoulders.between(leadShoulder, trailShoulder);
    this.limbs.hips.between(leadHip, trailHip);

    const leadHand = hands.clone().addScaledVector(shaft, -0.03);
    const trailHand = hands.clone().addScaledVector(shaft, 0.06);
    const upper = motion.upperArm * fit.scale;
    const lower = motion.forearm * fit.scale;
    const leadElbow = twoBoneJoint(leadShoulder, leadHand, upper, lower, J('LeftForeArm'));
    const trailElbow = twoBoneJoint(trailShoulder, trailHand, upper, lower, J('RightForeArm'));
    this.limbs.leadUpperArm.between(leadShoulder, leadElbow);
    this.limbs.leadForearm.between(leadElbow, leadHand);
    this.limbs.trailUpperArm.between(trailShoulder, trailElbow);
    this.limbs.trailForearm.between(trailElbow, trailHand);

    const leadKnee = J('LeftLeg');
    const trailKnee = J('RightLeg');
    const leadAnkle = J('LeftFoot');
    const trailAnkle = J('RightFoot');
    this.limbs.leadThigh.between(leadHip, leadKnee);
    this.limbs.leadShin.between(leadKnee, leadAnkle);
    this.limbs.trailThigh.between(trailHip, trailKnee);
    this.limbs.trailShin.between(trailKnee, trailAnkle);
    [leadHand, trailHand, leadElbow, trailElbow, leadKnee, trailKnee, leadShoulder, trailShoulder].forEach((p, i) => this.joints[i].position.copy(p));

    this.head.position.copy(skull);
    // Look at the ball until just after impact, then follow it out.
    this.head.lookAt(t < 0.15 ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(30, 2, 0));
    for (const [foot, ankle, toeName] of [[this.feet[0], leadAnkle, 'LeftToeBase'], [this.feet[1], trailAnkle, 'RightToeBase']] as const) {
      const toeJoint = J(toeName);
      foot.position.copy(ankle).lerp(toeJoint, 0.5).setY(Math.max(0.035, (ankle.y + toeJoint.y) / 2 - 0.03));
      foot.lookAt(toeJoint.clone().setY(foot.position.y));
    }

    const butt = hands.clone().addScaledVector(shaft, -0.08);
    this.grip.between(butt, hands.clone().addScaledVector(shaft, 0.2));
    this.club.between(butt, head);
    const up = shaft.clone().negate();
    const face = v(pose.face);
    face.addScaledVector(up, -face.dot(up)).normalize();
    const toe = new THREE.Vector3().crossVectors(up, face).normalize();
    this.placeHead(head, up, toe, face);
  }
}

interface MotionFile {
  readonly fps: number;
  readonly joints: readonly string[];
  readonly frames: readonly (readonly number[])[];
  readonly phases: { readonly address: number; readonly top: number; readonly impact: number; readonly finish: number };
}

/** A recorded swing (CMU motion capture, subject 64), aligned so the target is +x and the golfer stands at -z. */
class Motion {
  readonly upperArm: number;
  readonly forearm: number;
  private readonly data: MotionFile;
  private readonly index: Map<string, number>;
  private fitFor: Swing | null = null;
  get addressFrame(): number {
    return this.data.phases.address;
  }
  private fit = { scale: 1, dx: 0, dz: 0 };

  constructor(data: MotionFile) {
    this.data = data;
    this.index = new Map(data.joints.map((n, i) => [n, i]));
    const at = (f: number, n: string) => this.raw(f, n);
    const a = Math.round(data.phases.address);
    this.upperArm = at(a, 'LeftArm').distanceTo(at(a, 'LeftForeArm'));
    this.forearm = at(a, 'LeftForeArm').distanceTo(at(a, 'LeftHand'));
  }

  private raw(f: number, name: string): THREE.Vector3 {
    const frames = this.data.frames;
    const i0 = Math.max(0, Math.min(frames.length - 1, Math.floor(f)));
    const i1 = Math.min(frames.length - 1, i0 + 1);
    const k = Math.max(0, Math.min(1, f - i0));
    const j = 3 * this.index.get(name)!;
    const a = frames[i0];
    const b = frames[i1];
    return new THREE.Vector3(a[j] + (b[j] - a[j]) * k, a[j + 1] + (b[j + 1] - a[j + 1]) * k, a[j + 2] + (b[j + 2] - a[j + 2]) * k);
  }

  private hands(f: number): THREE.Vector3 {
    return this.raw(f, 'LeftHand').add(this.raw(f, 'RightHand')).multiplyScalar(0.5);
  }

  /** Scale and shift that put the captured hands where this swing's hands are at impact. */
  fitTo(swing: Swing): { scale: number; dx: number; dz: number } {
    if (this.fitFor === swing) return this.fit;
    const hands = swing.poseAt(0).hands;
    const captured = this.hands(this.data.phases.impact);
    const scale = hands.y / captured.y;
    this.fit = { scale, dx: hands.x - captured.x * scale, dz: hands.z - captured.z * scale };
    this.fitFor = swing;
    return this.fit;
  }

  /** The recording's frame for swing time t: address, top, impact and finish line up piece by piece. */
  frameAt(t: number, swing: Swing): number {
    const p = this.data.phases;
    const keys: [number, number][] = [
      [swing.start, Math.max(0, p.address - 0.6 * this.data.fps)],
      [swing.backswingStart, p.address],
      [-swing.downswing, p.top],
      [0, p.impact],
      [swing.end, p.finish],
    ];
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        const [t0, f0] = keys[i - 1];
        const [t1, f1] = keys[i];
        return f0 + ((f1 - f0) * (t - t0)) / (t1 - t0 || 1);
      }
    }
    return p.finish;
  }

  joint(frame: number, name: string, fit: { scale: number; dx: number; dz: number }): THREE.Vector3 {
    const p = this.raw(frame, name);
    return new THREE.Vector3(p.x * fit.scale + fit.dx, p.y * fit.scale, p.z * fit.scale + fit.dz);
  }
}

const MOTION = new Motion(motionData as unknown as MotionFile);
