import { describe, expect, it } from 'vitest';

import { EMPTY_FREIGHT, FREIGHT, PASSENGER, SHUTTLE } from '../src/rail/demoMap';
import { Network } from '../src/rail/network';
import { Sim, Train } from '../src/rail/sim';
import type { Car, CarType } from '../src/rail/vehicles';
import { carMass, VEHICLES } from '../src/rail/vehicles';

const consist = (...types: CarType[]): Car[] => types.map((type) => ({ type, flip: false }));

function straight() {
  const net = new Network();
  const a = net.addNode(-9000, 10, 0, 1, 0);
  const b = net.addNode(9000, 10, 0, 1, 0);
  return { net, seg: net.addSegment(a.id, 1, b.id, -1) };
}

function run(cars: Car[], seconds: number) {
  const { net, seg } = straight();
  const sim = new Sim(net);
  const t = new Train(1, 'T', cars);
  t.ai = false;
  sim.trains.push(t);
  sim.place(t, seg.id, 2000, 1);
  t.throttle = 1;
  for (let i = 0; i < seconds * 30; i++) sim.update(1 / 30);
  return t;
}

function secondsToReach(cars: Car[], speed: number) {
  const { net, seg } = straight();
  const sim = new Sim(net);
  const t = new Train(1, 'T', cars);
  t.ai = false;
  sim.trains.push(t);
  sim.place(t, seg.id, 2000, 1);
  t.throttle = 1;
  let time = 0;
  while (t.speed < speed && time < 600) {
    sim.update(1 / 30);
    time += 1 / 30;
  }
  return time;
}

describe('vehicle table', () => {
  it.each(Object.keys(VEHICLES) as CarType[])('%s has usable values', (type) => {
    const v = VEHICLES[type];
    expect(v.length).toBeGreaterThan(0);
    expect(v.mass.empty).toBeGreaterThan(0);
    expect(v.mass.loaded).toBeGreaterThanOrEqual(v.mass.empty);
    expect(v.topSpeed).toBeGreaterThan(0);
  });

  it('makes wagons lighter when empty, and treats an unset load as loaded', () => {
    expect(carMass({ type: 'wagon_tank', flip: false, loaded: false })).toBeLessThan(
      carMass({ type: 'wagon_tank', flip: false, loaded: true }),
    );
    expect(carMass({ type: 'wagon_tank', flip: false })).toBe(VEHICLES.wagon_tank.mass.loaded);
  });

  it('builds trains with the expected locomotive at the front', () => {
    expect(PASSENGER()[0].type).toBe('loco_diesel');
    expect(SHUTTLE()[0].type).toBe('loco_light');
    expect(FREIGHT()[0].type).toBe('loco_freight');
  });

  it('keeps the load when a train changes ends', () => {
    const { net, seg } = straight();
    const sim = new Sim(net);
    const t = new Train(1, 'T', EMPTY_FREIGHT());
    sim.trains.push(t);
    sim.place(t, seg.id, 2000, 1);
    const mass = t.mass;
    sim.reverse(t);
    expect(t.mass).toBe(mass);
  });
});

describe('how vehicles feel on a straight', () => {
  it('gives each locomotive its own acceleration under a heavy load', () => {
    const load = Array<CarType>(8).fill('wagon_tank');
    const [diesel, freight, light] = (['loco_diesel', 'loco_freight', 'loco_light'] as const).map((l) =>
      secondsToReach(consist(l, ...load), 12),
    );
    expect(freight).toBeLessThan(diesel - 2);
    expect(diesel).toBeLessThan(light - 2);
  });

  it('lets the light locomotive reach a higher speed than the freight one when running alone', () => {
    expect(run(consist('loco_light'), 120).speed).toBeGreaterThan(run(consist('loco_freight'), 120).speed);
  });

  it('never lets a train power past its slowest vehicle', () => {
    const t = run(consist('loco_light', 'wagon_box'), 300);
    expect(t.topSpeed).toBe(VEHICLES.wagon_box.topSpeed);
    expect(t.speed).toBeLessThan(VEHICLES.wagon_box.topSpeed + 0.5);
  });

  it('accelerates an empty train faster than a loaded one', () => {
    expect(secondsToReach(EMPTY_FREIGHT(), 15)).toBeLessThan(secondsToReach(FREIGHT(), 15));
  });

  it('keeps the autopilot under the top speed of its train', () => {
    const { net, seg } = straight();
    const far = net.split(seg.id, 16000);
    net.stations.push({ id: net.id(), name: 'End', nodeId: far.id, platformSide: 1, length: 140 });
    const sim = new Sim(net);
    const t = new Train(1, 'T', FREIGHT());
    sim.trains.push(t);
    sim.place(t, seg.id, 2000, 1);
    sim.plan(t, false);
    let fastest = 0;
    for (let i = 0; i < 200 * 30; i++) {
      sim.update(1 / 30);
      fastest = Math.max(fastest, t.speed);
    }
    expect(fastest).toBeGreaterThan(VEHICLES.wagon_box.topSpeed * 0.9);
    expect(fastest).toBeLessThan(VEHICLES.wagon_box.topSpeed + 0.5);
  });
});
