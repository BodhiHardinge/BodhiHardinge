import { describe, expect, it } from 'vitest';
import { clubFor } from './club.ts';
import { contactFor, lieGeometry } from './contact.ts';
import { strike } from './impact.ts';
import { deliveryFor, planeOf, stockSetup } from './setup.ts';
import { degrees, mph } from './units.ts';

const player = { driverSpeed: mph(105), putterSpeed: 4 };
const seven = clubFor('7 Iron');
const sevenSetup = stockSetup(seven);
const sevenDelivery = deliveryFor(sevenSetup, player);
const at = (shift: number, lie = 'Fairway', depth = 0) =>
  contactFor(sevenDelivery, seven, planeOf(sevenSetup), lieGeometry(lie), false, { lowPointShift: shift, depth, toe: 0 });

describe('club meets ground', () => {
  it('a well-timed iron is struck pure, then takes a divot after the ball', () => {
    const r = at(0);
    expect(r.kind).toBe('Pure');
    expect(r.contact.speedFactor).toBeCloseTo(1, 2);
    expect(r.divot).not.toBeNull();
    expect(r.divot!.from).toBeGreaterThan(-0.01);
    expect(r.divot!.to - r.divot!.from).toBeGreaterThan(0.08);
    expect(r.divot!.depth).toBeLessThan(0.012);
  });

  it('bottoming out early hits it fat; late hits it thin; much later tops it', () => {
    expect(['Fat', 'Duff']).toContain(at(-0.12).kind);
    expect(at(-0.12).contact.speedFactor).toBeLessThan(0.85);
    expect(at(0.1).kind).toBe('Thin');
    expect(at(0.3).kind).toBe('Topped');
  });

  it('rough cuts spin (a flyer) and slows the club more for woods than irons', () => {
    expect(at(0, 'Rough').contact.spinFactor).toBeLessThan(0.7);
    const wood = clubFor('3 Wood');
    const woodSetup = stockSetup(wood);
    const woodContact = contactFor(deliveryFor(woodSetup, player), wood, planeOf(woodSetup), lieGeometry('Rough'), false);
    expect(woodContact.contact.speedFactor).toBeLessThan(at(0, 'Rough').contact.speedFactor);
  });

  it('a driver off the deck ploughs turf before the ball unless it is picked clean', () => {
    const driver = clubFor('Driver');
    const setup = stockSetup(driver);
    const d = deliveryFor(setup, player);
    const teed = contactFor(d, driver, planeOf(setup), lieGeometry('Tee'), true);
    const deck = contactFor(d, driver, planeOf(setup), lieGeometry('Fairway'), false);
    expect(teed.kind).toBe('Pure');
    expect(deck.contact.speedFactor).toBeLessThan(0.9);
    const picked = contactFor(d, driver, planeOf(setup), lieGeometry('Fairway'), false, { lowPointShift: 0, depth: -0.008, toe: 0 });
    expect(picked.contact.speedFactor).toBeGreaterThan(0.97);
    expect(picked.contact.height).toBeLessThan(-0.005);
  });

  it('in sand, entering behind the ball splashes it out soft; picking it clean flies it full', () => {
    const sw = clubFor('Sand Wedge');
    const setup = { ...stockSetup(sw), face: degrees(10) };
    const d = deliveryFor(setup, player);
    const splash = contactFor(d, sw, planeOf(setup), lieGeometry('Sand'), false, { lowPointShift: -0.05, depth: 0.02, toe: 0 });
    expect(splash.kind).toBe('Splash');
    const clean = contactFor(d, sw, planeOf(setup), lieGeometry('Sand'), false);
    const out = strike(d, sw, splash.contact);
    const full = strike(d, sw, clean.contact);
    expect(out.ballSpeed).toBeLessThan(full.ballSpeed * 0.6);
    expect(out.spinRate).toBeLessThan(full.spinRate * 0.5);
  });

  it('more bounce digs less in sand', () => {
    const sw = clubFor('Sand Wedge');
    const pw = clubFor('Pitching Wedge');
    const dig = (c: typeof sw) => {
      const s = stockSetup(c);
      return contactFor(deliveryFor(s, player), c, planeOf(s), lieGeometry('Sand'), false, { lowPointShift: -0.05, depth: 0.03, toe: 0 }).lowPointHeight;
    };
    expect(dig(sw)).toBeGreaterThan(dig(pw));
  });
});
