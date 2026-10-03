import type { ClubSpec, Delivery } from './club.ts';
import { vec3, type Vec3 } from './vec3.ts';

/** Shoulder hub to hands, m. */
export const ARM_LENGTH = 0.62;

const ADDRESS = 0.6;
const BACKSWING = 0.85;
const FOLLOW_THROUGH = 0.7;
const HINGE_AT_TOP = 1.45;

export interface SwingPose {
  /** Centre of the swing arc, roughly between the shoulders. */
  readonly hub: Vec3;
  readonly hands: Vec3;
  readonly head: Vec3;
  /** Unit vector from hands to club head. */
  readonly shaft: Vec3;
  /** Unit vector the clubface points along. */
  readonly face: Vec3;
  /** How far round the swing is, rad: 0 at impact, negative going back. */
  readonly turn: number;
}

const smooth = (x: number) => {
  const s = Math.min(1, Math.max(0, x));
  return s * s * (3 - 2 * s);
};

/**
 * A two-lever swing (arms plus wrist hinge) on a tilted plane, built so that at impact the club head is at
 * the ball, moving at the delivery's club speed along its path and attack angle. Time 0 is impact.
 */
export class Swing {
  readonly start: number;
  /** When the club starts back, after the golfer settles at address, s. */
  readonly backswingStart: number;
  readonly end: number;
  readonly downswing: number;
  private readonly radius: number;
  private readonly clubLength: number;
  private readonly impactAngle: number;
  private readonly topAngle: number;
  private readonly finishAngle: number;
  private readonly angularSpeed: number;
  private readonly hubPoint: Vec3;
  private readonly up: Vec3;
  private readonly along: Vec3;
  private readonly delivery: Delivery;
  private readonly hingeTop: number;

  constructor(delivery: Delivery, spec: ClubSpec, ball: Vec3 = vec3(0, 0, 0)) {
    this.delivery = delivery;
    this.clubLength = spec.length;
    this.radius = ARM_LENGTH + spec.length;
    const incline = spec.plane;

    // Hitting down means meeting the ball before the bottom of the arc.
    const s = Math.sin(delivery.attackAngle) / Math.sin(incline);
    this.impactAngle = Math.asin(Math.max(-0.9, Math.min(0.9, s)));

    // Meeting the ball off the bottom of a tilted arc swings the strike direction; turn the plane to cancel it (D-plane).
    const yaw = delivery.clubPath + Math.atan(Math.tan(this.impactAngle) * Math.cos(incline));
    // Plane axes: `along` points down the swing direction, `up` climbs the plane toward the golfer.
    this.along = vec3(Math.cos(yaw), 0, Math.sin(yaw));
    const towardGolfer = vec3(Math.sin(yaw), 0, -Math.cos(yaw));
    this.up = vec3(towardGolfer.x * Math.cos(incline), Math.sin(incline), towardGolfer.z * Math.cos(incline));
    const r = this.radial(this.impactAngle);
    this.hubPoint = vec3(ball.x - this.radius * r.x, ball.y - this.radius * r.y, ball.z - this.radius * r.z);

    // A putting stroke is a pendulum whose length grows with pace, with no wrist hinge.
    const putter = spec.head === 'putter';
    const backswing = putter
      ? Math.min(0.9, Math.max(0.12, 0.08 + 0.1 * delivery.clubSpeed))
      : spec.head === 'driver' ? 4.1 : spec.head === 'wood' ? 3.9 : 3.5 - (spec.loft - 0.38) * 1.2;
    this.hingeTop = putter ? 0 : HINGE_AT_TOP;
    this.topAngle = this.impactAngle - backswing;
    this.finishAngle = this.impactAngle + (putter ? 1.2 * backswing : 4.2);
    this.angularSpeed = delivery.clubSpeed / this.radius;
    // A smooth acceleration averages two thirds of its peak speed.
    this.downswing = (1.5 * backswing) / this.angularSpeed;
    this.start = -(ADDRESS + BACKSWING + this.downswing);
    this.backswingStart = this.start + ADDRESS;
    this.end = FOLLOW_THROUGH + 0.8;
  }

  poseAt(t: number): SwingPose {
    const arm = this.armAngle(t);
    const hinge = this.hinge(t);
    const r = this.radial(arm);
    const tangent = this.tangent(arm);
    const hands = vec3(
      this.hubPoint.x + ARM_LENGTH * r.x,
      this.hubPoint.y + ARM_LENGTH * r.y,
      this.hubPoint.z + ARM_LENGTH * r.z,
    );
    // The club lags behind the hands by the hinge angle, within the plane.
    const c = Math.cos(hinge);
    const s = Math.sin(hinge);
    const shaft = vec3(c * r.x - s * tangent.x, c * r.y - s * tangent.y, c * r.z - s * tangent.z);
    const head = vec3(hands.x + this.clubLength * shaft.x, hands.y + this.clubLength * shaft.y, hands.z + this.clubLength * shaft.z);
    return { hub: this.hubPoint, hands, head, shaft, face: this.faceAt(arm), turn: arm - this.impactAngle };
  }

  /** Club head velocity at time t, m/s (finite difference). */
  headVelocity(t: number): Vec3 {
    const h = 1e-5;
    const a = this.poseAt(t - h).head;
    const b = this.poseAt(t + h).head;
    return vec3((b.x - a.x) / (2 * h), (b.y - a.y) / (2 * h), (b.z - a.z) / (2 * h));
  }

  private radial(angle: number): Vec3 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return vec3(-c * this.up.x + s * this.along.x, -c * this.up.y + s * this.along.y, -c * this.up.z + s * this.along.z);
  }

  private tangent(angle: number): Vec3 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return vec3(s * this.up.x + c * this.along.x, s * this.up.y + c * this.along.y, s * this.up.z + c * this.along.z);
  }

  private armAngle(t: number): number {
    const down = this.downswing;
    if (t <= -(down + BACKSWING)) return this.impactAngle;
    if (t <= -down) {
      const x = (t + down + BACKSWING) / BACKSWING;
      return this.impactAngle + (this.topAngle - this.impactAngle) * smooth(x);
    }
    if (t <= 0) {
      // Cubic from rest at the top to full angular speed at impact.
      const x = (t + down) / down;
      const delta = this.impactAngle - this.topAngle;
      const slope = (this.angularSpeed * down) / delta;
      return this.topAngle + delta * ((-2 * x ** 3 + 3 * x ** 2) + slope * (x ** 3 - x ** 2));
    }
    const x = Math.min(1, t / FOLLOW_THROUGH);
    const delta = this.finishAngle - this.impactAngle;
    const slope = (this.angularSpeed * FOLLOW_THROUGH) / delta;
    return this.impactAngle + delta * (slope * (x - 2 * x ** 2 + x ** 3) + (-2 * x ** 3 + 3 * x ** 2));
  }

  private hinge(t: number): number {
    const down = this.downswing;
    if (t <= -down) return this.hingeTop * smooth((t + down + BACKSWING) / BACKSWING);
    if (t <= 0) return this.hingeTop * (1 - smooth((t + down) / down / 0.55 - 0.8));
    return this.hingeTop === 0 ? 0 : -1.1 * smooth(t / FOLLOW_THROUGH);
  }

  private faceAt(arm: number): Vec3 {
    const d = this.delivery;
    // The face opens going back and closes coming through, square to its delivered angle at impact.
    const heading = d.faceAngle + 0.9 * (arm - this.impactAngle);
    const loft = d.dynamicLoft;
    return vec3(Math.cos(heading) * Math.cos(loft), Math.sin(loft), Math.sin(heading) * Math.cos(loft));
  }
}
