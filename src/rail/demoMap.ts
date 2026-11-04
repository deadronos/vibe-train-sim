// The starter layout: an oval main line over the river with a passing loop, a branch to a terminus and block signals.
import { Heightfield, riverCenter, WATER_LEVEL } from '../world/heightfield';
import { Network, RailNode, Side, Station } from './network';
import { Car, CarType, Sim, Train } from './sim';

const consist = (...types: CarType[]): Car[] => types.map((type) => ({ type, flip: false }));

export const PASSENGER = () => {
  const cars = consist('loco_diesel', 'coach', 'coach', 'coach', 'loco_diesel');
  cars[cars.length - 1].flip = true; // Rear locomotive faces outward: a push-pull set
  return cars;
};
export const SHUTTLE = () => consist('loco_diesel', 'coach', 'coach');
export const FREIGHT = () => consist('loco_diesel', 'wagon_box', 'wagon_tank', 'wagon_box', 'wagon_tank', 'wagon_box');

export function buildDemoNetwork(hf: Heightfield): { net: Network; stations: Record<string, Station> } {
  const net = new Network();
  const A = 820;
  const B = 520;
  const COUNT = 12;
  const nearRiver = (x: number, z: number) => Math.abs(z - riverCenter(x)) < 150;
  const railHeight = (x: number, z: number) => {
    const g = hf.baseAt(x, z);
    const y = Math.max(g + 0.7, WATER_LEVEL + 10);
    return nearRiver(x, z) ? Math.max(y, 13) : Math.min(y, 42);
  };
  const ring: RailNode[] = [];
  for (let i = 0; i < COUNT; i++) {
    const th = (i / COUNT) * Math.PI * 2;
    const x = A * Math.cos(th);
    const z = B * Math.sin(th);
    ring.push(net.addNode(x, railHeight(x, z), z, -A * Math.sin(th), B * Math.cos(th)));
  }
  // Smooth rail heights around the ring so grades stay gentle.
  for (let pass = 0; pass < 4; pass++) {
    const ys = ring.map((n) => n.y);
    ring.forEach((n, i) => {
      if (nearRiver(n.x, n.z)) return;
      n.y = (ys[(i + COUNT - 1) % COUNT] + 2 * ys[i] + ys[(i + 1) % COUNT]) / 4;
    });
  }
  const mainSegs: number[] = [];
  for (let i = 0; i < COUNT; i++) {
    mainSegs.push(net.addSegment(ring[i].id, 1, ring[(i + 1) % COUNT].id, -1).id);
  }
  const signal = (n: RailNode, ...sides: Side[]) => {
    for (const s of sides) n.signals[s] = { hold: false };
  };

  // Passing loop between ring nodes 3 and 4 (north-west side), with a platform on the main line.
  const n3 = ring[3];
  const n4 = ring[4];
  const midMain = net.split(mainSegs[3], net.geom.get(mainSegs[3])!.length / 2);
  const outward = Math.sign(midMain.x * -midMain.dz + midMain.z * midMain.dx) || 1;
  const ox = -midMain.dz * outward;
  const oz = midMain.dx * outward;
  const loopMid = net.addNode(midMain.x + ox * 9, midMain.y, midMain.z + oz * 9, midMain.dx, midMain.dz);
  net.addSegment(n3.id, 1, loopMid.id, -1);
  net.addSegment(loopMid.id, 1, n4.id, -1);
  signal(n3, 1);
  signal(n4, -1);

  // Second loop on the opposite side, between ring nodes 9 and 10.
  const n9 = ring[9];
  const n10 = ring[10];
  const midB = net.split(mainSegs[9], net.geom.get(mainSegs[9])!.length / 2);
  const outB = Math.sign(midB.x * -midB.dz + midB.z * midB.dx) || 1;
  const bx = -midB.dz * outB;
  const bz = midB.dx * outB;
  const loopB = net.addNode(midB.x + bx * 9, midB.y, midB.z + bz * 9, midB.dx, midB.dz);
  net.addSegment(n9.id, 1, loopB.id, -1);
  net.addSegment(loopB.id, 1, n10.id, -1);
  signal(n9, 1);
  signal(n10, -1);

  // Exit signals protect the single line from the loops.
  signal(n4, 1);
  signal(n3, -1);
  signal(n10, 1);
  signal(n9, -1);

  // Branch to a terminus, leaving ring node 7 outward.
  const n7 = ring[7];
  const branch1X = n7.x + n7.dx * 230 + (n7.x > 0 ? 1 : -1) * 70;
  const branch1Z = n7.z + n7.dz * 230 + (n7.z > 0 ? 1 : -1) * 150;
  const b1 = net.addNode(branch1X, n7.y, branch1Z, n7.dx * 0.8 + 0.1, n7.dz * 0.8 + (n7.z > 0 ? 0.6 : -0.6));
  net.addSegment(n7.id, 1, b1.id, -1);
  const terminusDirX = b1.dx;
  const terminusDirZ = b1.dz;
  const b2 = net.addNode(b1.x + terminusDirX * 170, n7.y, b1.z + terminusDirZ * 170, terminusDirX, terminusDirZ);
  net.addSegment(b1.id, 1, b2.id, -1);
  const b3 = net.addNode(b2.x + terminusDirX * 170, n7.y, b2.z + terminusDirZ * 170, terminusDirX, terminusDirZ);
  net.addSegment(b2.id, 1, b3.id, -1);
  // The branch signal stands back from the main line, so the shuttle can turn around without fouling it.
  const branchFirst = net.attached(n7.id, 1).find((id) => net.segs.get(id)!.b === b1.id)!;
  const branchSignal = net.split(branchFirst, 110);
  signal(n7, 1);
  signal(branchSignal, -1);

  const addStation = (name: string, node: RailNode, platformSide: Side, length = 140): Station => {
    const st: Station = { id: net.id(), name, nodeId: node.id, platformSide, length };
    net.stations.push(st);
    return st;
  };
  const stations = {
    larchmere: addStation('Larchmere', midMain, (-outward) as Side),
    wrenfield: addStation('Wrenfield', midB, (-outB) as Side),
    pinegate: addStation('Pinegate', b2, 1, 130),
    stonebeck: addStation('Stonebeck Junction', b1, -1, 120),
  };
  return { net, stations };
}

export function populateDemoTrains(sim: Sim, stations: Record<string, Station>) {
  const net = sim.net;
  const spawn = (t: Train, stationName: Station, schedule: number[]) => {
    const node = net.nodes.get(stationName.nodeId)!;
    const seg = net.attached(node.id, 1)[0] ?? net.attached(node.id, -1)[0];
    const s = net.segs.get(seg)!;
    t.schedule = schedule;
    sim.trains.push(t);
    sim.place(t, seg, s.a === node.id ? 2 : net.geom.get(seg)!.length - 2, s.a === node.id ? 1 : -1);
    sim.plan(t, false);
  };
  const lar = stations.larchmere.id;
  const wren = stations.wrenfield.id;
  const pine = stations.pinegate.id;
  spawn(new Train(1, 'Express 101', PASSENGER()), stations.larchmere, [wren, lar]);
  spawn(new Train(2, 'Freight 302', FREIGHT()), stations.wrenfield, [lar, wren]);
  spawn(new Train(3, 'Branch 205', SHUTTLE()), stations.pinegate, [stations.stonebeck.id, pine]);
}
