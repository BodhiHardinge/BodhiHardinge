import * as THREE from 'three';
import type { ClubSpec } from '../physics/club.ts';

/** A club head model and the points the golfer model needs to hold it properly. */
export interface ClubHeadModel {
  readonly group: THREE.Group;
  /** Lie angle: between the shaft and the ground when the sole sits flat, rad. */
  readonly lie: number;
  /** Middle of the face (the sweet spot) in the head's frame. */
  readonly faceCentre: THREE.Vector3;
  /** Where the shaft enters the hosel, in the head's frame. */
  readonly hoselTop: THREE.Vector3;
}

/** Typical lie angles: flatter for long clubs, more upright for wedges and the putter. */
export function lieAngle(spec: ClubSpec): number {
  const loft = (spec.loft * 180) / Math.PI;
  const deg = spec.head === 'putter' ? 70 : spec.head === 'driver' ? 58 : spec.head === 'wood' ? (loft > 19 ? 60 : 59) : Math.min(64, 60 + (loft - 20) * 0.12);
  return (deg * Math.PI) / 180;
}

/**
 * Placeholder club heads, roughly to scale, built in the head's own frame: x toward the toe, y straight up from a
 * level sole, z away from the face (the face looks along -z). The hosel rises from the heel at the lie angle.
 */
export function buildClubHead(spec: ClubSpec, putterStyle: 'blade' | 'mallet' = 'mallet'): ClubHeadModel {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: '#c6cacf', metalness: 0.85, roughness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: '#202327', metalness: 0.5, roughness: 0.35 });
  const face = new THREE.MeshStandardMaterial({ color: '#9aa0a6', metalness: 0.9, roughness: 0.45 });
  const lie = lieAngle(spec);
  const shaftDir = new THREE.Vector3(-Math.cos(lie), Math.sin(lie), 0);
  const hosel = (base: THREE.Vector3, length: number, radius = 0.0065) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.35, length, 14).translate(0, length / 2, 0), steel);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), shaftDir);
    m.position.copy(base);
    group.add(m);
    return base.clone().addScaledVector(shaftDir, length);
  };

  if (spec.head === 'driver' || spec.head === 'wood') {
    const big = spec.head === 'driver';
    const w = big ? 0.118 : 0.095;
    const h = big ? 0.058 : 0.036;
    const d = big ? 0.112 : 0.082;
    // A rounded crown over a flatter sole, face at the front, heel at x = 0.
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.5, 40, 24), dark);
    shell.scale.set(w, h, d);
    shell.position.set(w * 0.5 + 0.006, h * 0.5, d * 0.5);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(w * 0.78, h * 0.78, 0.004), face);
    plate.position.set(w * 0.5 + 0.006, h * 0.5, 0.01);
    // A crown alignment mark.
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.001, 0.02), new THREE.MeshBasicMaterial({ color: '#d9d9d9' }));
    mark.position.set(w * 0.5 + 0.006, h + 0.0005, 0.03);
    group.add(shell, plate, mark);
    const top = hosel(new THREE.Vector3(0.006, h * 0.55, 0.016), big ? 0.045 : 0.035);
    return { group, lie, faceCentre: new THREE.Vector3(w * 0.5 + 0.006, h * 0.48, 0.008), hoselTop: top };
  }

  if (spec.head === 'putter') {
    if (putterStyle === 'blade') {
      // Anser-style blade: a long thin head with a plumber's-neck hosel.
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.022, 0.024), steel);
      head.position.set(0.06, 0.011, 0.012);
      const cavity = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.012, 0.012), dark);
      cavity.position.set(0.06, 0.017, 0.018);
      const neck1 = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.02, 0.008), steel);
      neck1.position.set(0.026, 0.032, 0.006);
      const neck2 = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.008, 0.008), steel);
      neck2.position.set(0.013, 0.042, 0.006);
      group.add(head, cavity, neck1, neck2);
      const top = hosel(new THREE.Vector3(0.0, 0.042, 0.006), 0.03, 0.0055);
      return { group, lie, faceCentre: new THREE.Vector3(0.06, 0.011, 0), hoselTop: top };
    }
    // Mallet: a deep half-moon body behind a flat face, with a white sight line and a centre-shafted neck.
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.024, 40, 1, false, -Math.PI / 2, Math.PI), dark);
    body.position.set(0.055, 0.012, 0.004);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.104, 0.024, 0.008), steel);
    plate.position.set(0.055, 0.012, 0.004);
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.001, 0.046), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    line.position.set(0.055, 0.0245, 0.028);
    group.add(body, plate, line);
    const top = hosel(new THREE.Vector3(0.03, 0.024, 0.012), 0.03, 0.0055);
    return { group, lie, faceCentre: new THREE.Vector3(0.055, 0.012, 0), hoselTop: top };
  }

  // Irons and wedges: a face outline extruded back, lofted back from the leading edge, with grooves.
  const length = 0.074;
  const heelHeight = 0.036;
  const toeHeight = 0.05 + Math.max(0, (spec.loft - 0.5) * 0.02);
  const outline = new THREE.Shape();
  outline.moveTo(0.008, 0);
  outline.lineTo(length - 0.01, 0);
  outline.quadraticCurveTo(length + 0.004, 0.004, length, toeHeight * 0.6);
  outline.quadraticCurveTo(length - 0.004, toeHeight, length - 0.022, toeHeight);
  outline.lineTo(0.014, heelHeight);
  outline.lineTo(0.006, heelHeight * 0.7);
  outline.closePath();
  const thickness = 0.022 + (spec.forgiveness !== undefined && spec.forgiveness < 0.8 ? 0.012 : 0);
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(outline, { depth: thickness, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.0015, bevelSegments: 2 }), steel);
  const grooves = new THREE.Group();
  for (let y = 0.006; y < heelHeight * 0.95; y += 0.0036) {
    const g = new THREE.Mesh(new THREE.BoxGeometry(length * 0.62, 0.0009, 0.0005), dark);
    g.position.set(length * 0.52, y, -0.0022);
    grooves.add(g);
  }
  const head = new THREE.Group();
  head.add(body, grooves);
  // Loft: tip the face back about the leading edge.
  head.rotation.x = spec.loft;
  group.add(head);
  const top = hosel(new THREE.Vector3(0.004, 0.012, 0.012), 0.06);
  const sweet = new THREE.Vector3(length * 0.48, 0.018 * Math.cos(spec.loft), 0.018 * Math.sin(spec.loft));
  return { group, lie, faceCentre: sweet, hoselTop: top };
}
