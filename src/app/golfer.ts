import * as THREE from 'three';
import type { ClubSpec } from '../physics/club.ts';
import type { SwingPose } from '../physics/swing.ts';

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
  private clubHead: THREE.Mesh;
  private readonly feet: THREE.Mesh[];

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
    this.clubHead = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m.head);
    this.group.add(this.clubHead);
  }

  setClub(spec: ClubSpec): void {
    const size = spec.head === 'driver' ? [0.115, 0.06, 0.11] : spec.head === 'wood' ? [0.1, 0.04, 0.08] : spec.head === 'putter' ? [0.1, 0.025, 0.03] : [0.075, 0.05, 0.018];
    this.clubHead.geometry.dispose();
    this.clubHead.geometry = new THREE.BoxGeometry(size[0], size[1], size[2]).translate(size[0] * 0.35, size[1] * 0.4, -size[2] * 0.45);
  }

  update(pose: SwingPose): void {
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
    this.clubHead.position.copy(head);
    this.clubHead.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(toe, up, face.negate()));
  }
}
