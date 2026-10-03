import * as THREE from 'three';
import type { ClubSpec } from '../physics/club.ts';

/**
 * Placeholder club heads, roughly to scale, built in the head's own frame: x toward the toe, y up the shaft,
 * z away from the face (the face looks along -z). The sole sits at y = 0 and the hosel at the origin.
 */
export function buildClubHead(spec: ClubSpec, putterStyle: 'blade' | 'mallet' = 'mallet'): THREE.Group {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: '#c6cacf', metalness: 0.85, roughness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: '#202327', metalness: 0.5, roughness: 0.35 });
  const face = new THREE.MeshStandardMaterial({ color: '#9aa0a6', metalness: 0.9, roughness: 0.45 });
  const hosel = (height: number, radius = 0.0065) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.3, height, 12).translate(0, height / 2, 0), steel);
    return m;
  };

  if (spec.head === 'driver' || spec.head === 'wood') {
    const big = spec.head === 'driver';
    const w = big ? 0.118 : 0.095;
    const h = big ? 0.06 : 0.038;
    const d = big ? 0.112 : 0.085;
    // A rounded crown over a flatter sole, face at the front.
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 20), dark);
    shell.scale.set(w, h, d);
    shell.position.set(w * 0.5 + 0.008, h * 0.5, d * 0.5);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(w * 0.78, h * 0.8, 0.004), face);
    plate.position.set(w * 0.5 + 0.008, h * 0.5, 0.012);
    group.add(shell, plate, hosel(big ? 0.05 : 0.04));
    return group;
  }

  if (spec.head === 'putter') {
    if (putterStyle === 'blade') {
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.024, 0.026), steel);
      head.position.set(0.06, 0.012, 0.013);
      // Plumber's-neck hosel: up, across, up.
      const neck1 = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.02, 0.008), steel);
      neck1.position.set(0.03, 0.034, 0.008);
      const neck2 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.008, 0.008), steel);
      neck2.position.set(0.015, 0.044, 0.008);
      const neck3 = hosel(0.03, 0.005);
      neck3.position.set(0, 0.044, 0.008);
      group.add(head, neck1, neck2, neck3);
    } else {
      // Mallet: a half disc behind a flat face, with a white sight line.
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.022, 32, 1, false, -Math.PI / 2, Math.PI), dark);
      body.position.set(0.06, 0.011, 0.002);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.022, 0.006), steel);
      plate.position.set(0.06, 0.011, 0.003);
      const line = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.001, 0.045), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
      line.position.set(0.06, 0.0225, 0.025);
      const neck = hosel(0.03, 0.005);
      neck.position.set(0.035, 0.022, 0.01);
      group.add(body, plate, line, neck);
    }
    return group;
  }

  // Irons and wedges: a face outline extruded back, lofted back from the shaft, with grooves.
  const loft = spec.loft;
  const length = 0.074;
  const heelHeight = 0.036;
  const toeHeight = 0.05 + Math.max(0, (spec.loft - 0.5) * 0.02);
  const outline = new THREE.Shape();
  outline.moveTo(0.006, 0);
  outline.lineTo(length - 0.01, 0);
  outline.quadraticCurveTo(length + 0.004, 0.004, length, toeHeight * 0.6);
  outline.quadraticCurveTo(length - 0.004, toeHeight, length - 0.022, toeHeight);
  outline.lineTo(0.012, heelHeight);
  outline.lineTo(0.004, heelHeight * 0.75);
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
  head.rotation.x = loft;
  group.add(head, hosel(0.065));
  return group;
}
